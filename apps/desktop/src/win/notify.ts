/**
 * Desktop notifications for the three things `GlobalSettings.notifications`
 * promises (Phase 6, SPEC R19/R30) — and nothing else.
 *
 * Before this, `notifications` was a stored preference with no consumer:
 * `SettingsService.applyPlatform` called `applyNotifications` and `main.ts`
 * logged a line. This is the consumer. It taps the *same* `broadcast` every
 * IPC event already goes through, so there is no second event path to keep in
 * sync and nothing new reaches a model's context (R26 — a toast is a main
 * process side effect, not a message).
 *
 * The mapping from event to switch, and why each one:
 *
 *   | switch | fires on | reasoning |
 *   |---|---|---|
 *   | `onFinish` | `chat.turnStatus` → `done` | the turn you walked away from is finished |
 *   | `onNeedsInput` | `permission.request`, `question.request`, `elicitation.request` | R32's three cards all block the turn until answered |
 *   | `onRunnerDisconnect` | `chat.turnStatus` → `error`, `app.status` level `error` | the backend died or refused; a silently dead turn is the worst failure mode this app has |
 *
 * Two rules that keep it from being noise:
 *
 *  - **Focused means silent.** A notification for something the user is
 *    watching happen is spam. `isFocused()` is the whole gate — there is no
 *    per-session "is this the visible one" test, because a focused window with
 *    another session open is still a window whose sidebar just changed.
 *  - **Once per turn per kind.** A turn that errors emits its status more than
 *    once (the runner closes an orphaned turn, and a chain stop re-broadcasts),
 *    and three permission requests inside one turn are one interruption, not
 *    three. Keys are `<kind>:<turnId>`, kept in a bounded ring so a long
 *    session cannot grow this map without limit.
 *
 * Electron-free: `Notification`, focus and the store all arrive as functions,
 * so `apps/desktop/test/notify.test.ts` drives the real logic with fakes.
 */
import type { EventChannel, EventPayload, GlobalNotifications } from "@capygen/shared";

/** What `new Notification({...}).show()` looks like from here. */
export interface NotificationRequest {
  title: string;
  body: string;
  /** Called when the user clicks the toast — reveals the window. */
  onClick?: () => void;
}

export interface NotifierDeps {
  /** The live `GlobalSettings.notifications` — read per event, never cached,
   *  so turning them off takes effect on the very next one. */
  settings: () => GlobalNotifications;
  /** True when any capygen window has OS focus. */
  isFocused: () => boolean;
  /** Show one notification. Absent/throwing is survivable (see `emit`). */
  show: (request: NotificationRequest) => void;
  /** Bring a window forward when a toast is clicked. */
  reveal?: () => void;
  /** A session's title, for the toast body. Missing → a generic line. */
  sessionTitle?: (sessionId: string) => string | null;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/** How many recent `<kind>:<turnId>` keys are remembered. */
export const NOTIFY_DEDUPE_LIMIT = 200;

export interface Notifier {
  /** Feed it every broadcast; it ignores the ones it does not care about. */
  handle<E extends EventChannel>(event: E, payload: EventPayload<E>): void;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const seen = new Set<string>();

  function once(key: string): boolean {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > NOTIFY_DEDUPE_LIMIT) {
      // Sets iterate in insertion order, so the first entry is the oldest.
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  }

  function emit(kind: keyof Omit<GlobalNotifications, "enabled">, key: string, title: string, body: string): void {
    const settings = deps.settings();
    if (!settings.enabled || !settings[kind]) return;
    // Watching it happen is its own notification.
    if (deps.isFocused()) return;
    if (!once(`${kind}:${key}`)) return;
    try {
      deps.show({
        title,
        body,
        ...(deps.reveal ? { onClick: deps.reveal } : {}),
      });
      deps.log?.info(`[notify] ${kind}: ${title}`);
    } catch (err) {
      // A failed toast must never take a turn down with it.
      deps.log?.warn(`[notify] ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function where(sessionId: string): string {
    const title = deps.sessionTitle?.(sessionId)?.trim();
    return title && title.length > 0 ? title : "a session";
  }

  return {
    handle(event, payload) {
      switch (event) {
        case "chat.turnStatus": {
          const p = payload as EventPayload<"chat.turnStatus">;
          if (p.status === "done") {
            emit("onFinish", p.turnId, "Turn finished", `${where(p.sessionId)} is done.`);
          } else if (p.status === "error") {
            emit(
              "onRunnerDisconnect",
              p.turnId,
              "Agent stopped",
              p.error?.trim() || `${where(p.sessionId)} ended with an error.`,
            );
          }
          return;
        }
        case "permission.request": {
          const p = payload as EventPayload<"permission.request">;
          emit("onNeedsInput", p.turnId, "Permission needed", `${where(p.sessionId)} is waiting for you.`);
          return;
        }
        case "question.request": {
          const p = payload as EventPayload<"question.request">;
          emit("onNeedsInput", p.turnId, "Question for you", `${where(p.sessionId)} asked something.`);
          return;
        }
        case "elicitation.request": {
          const p = payload as EventPayload<"elicitation.request">;
          emit("onNeedsInput", p.turnId, "Input needed", `${where(p.sessionId)} is waiting for you.`);
          return;
        }
        case "app.status": {
          const p = payload as EventPayload<"app.status">;
          if (p.level !== "error") return;
          // No turn to key on — the kind plus the message is the identity, so
          // the same failure repeating does not toast twice.
          emit("onRunnerDisconnect", `${p.kind}:${p.message}`, "capygen", p.message);
          return;
        }
        default:
          return;
      }
    },
  };
}

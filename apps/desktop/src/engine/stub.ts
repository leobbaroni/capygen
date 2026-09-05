/**
 * Placeholder engine for Phase 2 task A1.
 *
 * It echoes `echo: <text>` as one text block after 300 ms so the whole IPC path
 * — send → turn row → block rows → `chat.block` / `chat.turnStatus` events →
 * transcript — is exercised and testable before the real Claude harness lands
 * (Phase 2, task A2+). It implements the same tiny surface the real harness will
 * expose (`send`, `interrupt`), so swapping it out is a one-line change in
 * `createIpcContext`.
 *
 * Nothing here calls a model or spawns a process.
 */
export interface EngineSendArgs {
  sessionId: string;
  turnId: string;
  text: string;
}

export interface EngineHooks {
  /** Called once with the reply text; the caller turns it into a block. */
  onText: (args: { sessionId: string; turnId: string; text: string }) => void;
  onDone: (args: { sessionId: string; turnId: string }) => void;
  onError: (args: { sessionId: string; turnId: string; message: string }) => void;
}

export interface Engine {
  send(args: EngineSendArgs): void;
  /** Cancel the in-flight turn for a session, if any. Returns true if one was. */
  interrupt(sessionId: string): boolean;
  dispose(): void;
}

export const ECHO_DELAY_MS = 300;

export function createStubEngine(hooks: EngineHooks, delayMs = ECHO_DELAY_MS): Engine {
  const inFlight = new Map<string, { timer: NodeJS.Timeout; turnId: string }>();

  return {
    send({ sessionId, turnId, text }) {
      // One turn at a time per session: a second send supersedes the first.
      const existing = inFlight.get(sessionId);
      if (existing) clearTimeout(existing.timer);

      const timer = setTimeout(() => {
        inFlight.delete(sessionId);
        try {
          hooks.onText({ sessionId, turnId, text: `echo: ${text}` });
          hooks.onDone({ sessionId, turnId });
        } catch (err) {
          hooks.onError({
            sessionId,
            turnId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }, delayMs);
      timer.unref?.();
      inFlight.set(sessionId, { timer, turnId });
    },

    interrupt(sessionId) {
      const existing = inFlight.get(sessionId);
      if (!existing) return false;
      clearTimeout(existing.timer);
      inFlight.delete(sessionId);
      return true;
    },

    dispose() {
      for (const { timer } of inFlight.values()) clearTimeout(timer);
      inFlight.clear();
    },
  };
}

/**
 * The renderer's single store. Holds what the shell needs (projects,
 * sessions, the open session's turns and blocks, settings) and subscribes to
 * the main-process event stream once.
 *
 * Invariants later phases depend on:
 *   - blocks are keyed by id and *upserted*, because a streaming block is sent
 *     repeatedly as it grows (SPEC R23–R26: persist and render incrementally,
 *     never rebuild the turn);
 *   - nothing here talks to SQLite or a backend; every read and write is an IPC
 *     call, so the agent's context never sees the UI's chatter (R26).
 *
 * Task B2 additions: answering permission/question blocks, archiving
 * sessions, a local send queue for messages typed while a turn is streaming,
 * and the raw timestamps `hooks/useMascotState.ts` turns into a mascot state.
 *
 * Task B4 additions: answering elicitation blocks, the session's raw
 * `usage_events` (the header meter and each turn's byModel tooltip both read
 * this rather than two separate fetches), and the `harness.list` catalogue
 * the composer's backend/model picker and Settings ▸ Harnesses both need.
 */
import { create } from "zustand";
import {
  DEFAULT_SETTINGS,
  type Agent,
  type AgentDraft,
  type Block,
  type HarnessInfo,
  type PermissionBlock,
  type Project,
  type QuestionBlock,
  type Session,
  type Settings,
  type SlashCommand,
  type TurnStatus,
  type Turn,
  type UsageEvent,
} from "@capygen/shared";
import { hasBridge, ipc } from "@/lib/ipc";

export interface AppState {
  ready: boolean;
  bridgeAvailable: boolean;
  error: string | null;

  settings: Settings;
  projects: Project[];
  sessions: Session[];
  commands: SlashCommand[];
  /** Backend/model availability (`harness.list`) — the composer's picker and
   *  Settings ▸ Harnesses both read this instead of invoking separately. */
  harnesses: HarnessInfo[];

  /** The session the chat page is showing. */
  activeSessionId: string | null;
  agents: Agent[];
  turns: Turn[];
  /** Block id → block. Upserted; ordering comes from `orderedBlocks`. */
  blocks: Record<string, Block>;
  /** Turn id → live status, so the composer can disable while streaming. */
  turnStatus: Record<string, TurnStatus>;
  /** Raw `usage_events` for the open session (R23) — summed for the header
   *  meter, grouped by `turnId` for each turn's byModel breakdown tooltip. */
  usageEvents: UsageEvent[];

  /** Messages typed while a turn was streaming; drained in order as it frees up. */
  queuedMessages: string[];
  /** Mic button pressed (composer dictation UI — real speech-to-text is Phase 10). */
  listening: boolean;
  /** `Date.now()` of the most recent IPC event or user action, any session. */
  lastActivityAt: number;
  /** `Date.now()` the open session's last turn finished, or null. Feeds the
   *  mascot's transient "success" state. */
  lastDoneAt: number | null;
  /** Sessions list includes archived rows when true (Sidebar's toggle). */
  showArchived: boolean;
  /**
   * Request ids whose card the user answered after nothing was listening any
   * more (the turn ended, or the answer belongs to a previous launch). The
   * card says so instead of pretending the decision reached an agent.
   */
  staleRequests: string[];

  init(): Promise<void>;
  pickProject(): Promise<Project | null>;
  /** `leadAgent` seeds the session's lead agent's backend/model — the
   *  composer's harness picker (SPEC item 5) passes what the user chose on
   *  the New Session landing; omitted, `sessions.create` falls back to
   *  Settings ▸ General's default backend/model. */
  startSession(
    projectId: string,
    title?: string,
    leadAgent?: Pick<AgentDraft, "backend" | "model" | "name">,
  ): Promise<Session>;
  openSession(sessionId: string): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setSettings(patch: Partial<Settings>): Promise<void>;
  answerPermission(
    requestId: string,
    decision: "allow" | "allow_always" | "deny",
    opts?: { updatedInput?: unknown; message?: string; scope?: "once" | "session" | "always" },
  ): Promise<void>;
  answerQuestion(requestId: string, answers: Record<string, string>): Promise<void>;
  /** `null` answers means the user cancelled/declined the elicitation. */
  answerElicitation(
    turnId: string,
    blockId: string,
    answers: Record<string, unknown> | null,
  ): Promise<void>;
  archiveSession(sessionId: string, archived: boolean): Promise<void>;
  setShowArchived(show: boolean): Promise<void>;
  setListening(listening: boolean): void;
}

/** Blocks of one turn, in render order. */
export function blocksOfTurn(state: AppState, turnId: string): Block[] {
  return Object.values(state.blocks)
    .filter((b) => b.turnId === turnId)
    .sort((a, b) => a.index - b.index || a.createdAt - b.createdAt);
}

/** True while any turn in the open session is still streaming. */
export function isBusy(state: AppState): boolean {
  return state.turns.some((t) => (state.turnStatus[t.id] ?? t.status) === "streaming");
}

/**
 * This turn's own `usage_events` rows — a turn's `UsageLine` groups these by
 * model for its breakdown tooltip (R23).
 *
 * Not safe to use directly as a zustand selector (`useAppStore((s) =>
 * usageEventsForTurn(s, id))`): `.filter()` returns a new array every call,
 * which `useSyncExternalStore` reads as "the store changed" on every render
 * and loops forever. Select `s.usageEvents` (a stable reference) and call
 * this inside a `useMemo` instead — see `UsageLine.tsx`.
 */
export function usageEventsForTurn(state: AppState, turnId: string): UsageEvent[] {
  return state.usageEvents.filter((e) => e.turnId === turnId);
}

/**
 * The oldest unanswered permission/question block in the open session, or
 * null. There is at most one live request at a time in practice (the
 * backend blocks on the answer before continuing), so "oldest" only matters
 * for picking a stable one while more than one is technically unresolved.
 */
export function pendingInteractionBlock(
  state: AppState,
): PermissionBlock | QuestionBlock | null {
  let found: PermissionBlock | QuestionBlock | null = null;
  for (const block of Object.values(state.blocks)) {
    if (block.kind === "permission" && block.decision === null) {
      if (!found || block.createdAt < found.createdAt) found = block;
    } else if (block.kind === "question" && block.answers === null) {
      if (!found || block.createdAt < found.createdAt) found = block;
    }
  }
  return found;
}

/**
 * While the open session is `running`: whether the live agent turn has
 * produced anything renderable yet. No blocks yet, or only a `thinking`
 * block so far, reads as "thinking"; anything else (text, a tool call, …)
 * reads as "working". Meaningless (but harmless) when nothing is running.
 */
export function activeTurnPhase(state: AppState): "thinking" | "working" {
  const live = [...state.turns].reverse().find((t) => t.role === "agent" && t.status === "streaming");
  if (!live) return "working";
  const blocks = blocksOfTurn(state, live.id);
  if (blocks.length === 0) return "thinking";
  return blocks.every((b) => b.kind === "thinking") ? "thinking" : "working";
}

export const useAppStore = create<AppState>()((set, get) => {
  let subscribed = false;

  function touchActivity(): void {
    set({ lastActivityAt: Date.now() });
  }

  /** Wire the main → renderer events exactly once. */
  function subscribe(): void {
    if (subscribed) return;
    subscribed = true;
    const client = ipc();

    client.on("chat.block", (block) => {
      if (block.sessionId !== get().activeSessionId) return;
      set((s) => ({ blocks: { ...s.blocks, [block.id]: block } }));
      touchActivity();
    });

    client.on("chat.turnStatus", ({ sessionId, turnId, status }) => {
      touchActivity();
      if (sessionId !== get().activeSessionId) return;
      set((s) => ({
        turnStatus: { ...s.turnStatus, [turnId]: status },
        turns: s.turns.map((t) => (t.id === turnId ? { ...t, status } : t)),
        lastDoneAt: status === "done" ? Date.now() : s.lastDoneAt,
      }));
      // A turn the store has not seen yet (the agent turn `chat.send` opened)
      // arrives as a status first; pull the row so it renders in order.
      if (!get().turns.some((t) => t.id === turnId)) void refreshTurns(sessionId);
      // The turn that was streaming freed up: dispatch the next queued
      // message, if the user typed ahead while this one was running.
      if (status === "done" || status === "error" || status === "interrupted") {
        drainQueue(sessionId);
        // A finished turn is exactly when new usage_events rows land — the
        // meter has nothing to catch them otherwise (there is no push event
        // for usage the way there is for blocks/turn status).
        void refreshUsage(sessionId);
        void refreshCommands(sessionId);
      }
    });

    client.on("session.updated", (session) => {
      set((s) => ({
        sessions: s.sessions.some((x) => x.id === session.id)
          ? s.sessions.map((x) => (x.id === session.id ? session : x))
          : [session, ...s.sessions],
      }));
    });

    client.on("app.status", ({ level, message }) => {
      if (level === "error") set({ error: message });
    });
  }

  async function refreshTurns(sessionId: string): Promise<void> {
    const { turns, blocks } = await ipc().invoke("turns.list", { sessionId });
    if (get().activeSessionId !== sessionId) return;
    set((s) => ({
      turns,
      blocks: { ...Object.fromEntries(blocks.map((b) => [b.id, b])), ...pickLive(s.blocks, sessionId) },
    }));
  }

  async function refreshUsage(sessionId: string): Promise<void> {
    const { events } = await ipc().invoke("turns.usage", { sessionId });
    if (get().activeSessionId !== sessionId) return;
    set({ usageEvents: events });
  }

  /**
   * Re-read the slash menu (R14).
   *
   * A backend only reports its own commands once it is running — Claude's
   * arrive with `system/init` on the first turn, Codex's with `skills/list`
   * after `thread/start` — so the list fetched when the session was opened is
   * built-ins only. Refetching when a turn ends is what turns `/` from seven
   * built-ins into the user's real skills and plugin commands.
   */
  async function refreshCommands(sessionId: string): Promise<void> {
    const commands = await ipc().invoke("chat.listCommands", { sessionId });
    if (get().activeSessionId !== sessionId) return;
    set({ commands });
  }

  /** Keep any block that arrived by event and is newer than the fetched row. */
  function pickLive(current: Record<string, Block>, sessionId: string): Record<string, Block> {
    const live: Record<string, Block> = {};
    for (const [id, block] of Object.entries(current)) {
      if (block.sessionId === sessionId) live[id] = block;
    }
    return live;
  }

  /** Actually call `chat.send` — the part `send()` defers while busy. */
  async function dispatchNow(sessionId: string, text: string): Promise<void> {
    await ipc().invoke("chat.send", { sessionId, text, agentId: null });
    await refreshTurns(sessionId);
  }

  /**
   * Record whether an answer actually reached a backend. `ok: false` means
   * nothing was waiting on it any more, so the card has to say so rather than
   * flip to "Allowed"/"Submitted" (the main process leaves the row undecided
   * in that case).
   */
  function markStale(requestId: string, delivered: boolean): void {
    if (delivered) return;
    set((s) =>
      s.staleRequests.includes(requestId)
        ? s
        : { staleRequests: [...s.staleRequests, requestId] },
    );
  }

  /** Pop and send the next queued message, if the session is free and one is waiting. */
  function drainQueue(sessionId: string): void {
    if (get().activeSessionId !== sessionId) return;
    if (isBusy(get())) return;
    const [next, ...rest] = get().queuedMessages;
    if (next === undefined) return;
    set({ queuedMessages: rest });
    // Nobody is awaiting this one — a failure has to land somewhere visible,
    // and the message goes back in the queue rather than disappearing.
    void dispatchNow(sessionId, next).catch((err: unknown) => {
      set((s) => ({
        queuedMessages: [next, ...s.queuedMessages],
        error: err instanceof Error ? err.message : String(err),
      }));
    });
  }

  return {
    ready: false,
    bridgeAvailable: hasBridge(),
    error: null,
    settings: DEFAULT_SETTINGS,
    projects: [],
    sessions: [],
    commands: [],
    harnesses: [],
    activeSessionId: null,
    agents: [],
    turns: [],
    blocks: {},
    turnStatus: {},
    usageEvents: [],
    queuedMessages: [],
    listening: false,
    lastActivityAt: Date.now(),
    lastDoneAt: null,
    showArchived: false,
    staleRequests: [],

    async init() {
      if (!hasBridge()) {
        set({
          ready: true,
          bridgeAvailable: false,
          error: "Running outside the capygen shell: the main process bridge is missing.",
        });
        return;
      }
      subscribe();
      const client = ipc();
      const [settings, projects, sessions, commands] = await Promise.all([
        client.invoke("settings.get", {}),
        client.invoke("projects.list", {}),
        client.invoke("sessions.list", {}),
        client.invoke("chat.listCommands", {}),
      ]);
      set({ ready: true, settings, projects, sessions, commands, error: null });
      // Deliberately **not** awaited above (G1: composer usable within 3 s).
      // `harness.list` probes the machine — it spawns a short-lived `codex
      // app-server` to ask `account/read` — so blocking the landing on it
      // would put a process spawn between launch and the first keystroke. The
      // picker renders with whatever it has and fills in when the answer
      // lands; a failure leaves the list empty rather than blanking the app.
      void client
        .invoke("harness.list", {})
        .then((harnesses) => set({ harnesses }))
        .catch(() => undefined);
    },

    async pickProject() {
      const project = await ipc().invoke("projects.pick", {});
      if (project) {
        set((s) => ({
          projects: s.projects.some((p) => p.id === project.id)
            ? s.projects.map((p) => (p.id === project.id ? project : p))
            : [project, ...s.projects],
        }));
      }
      return project;
    },

    async startSession(projectId, title = "", leadAgent) {
      const { session, agents } = await ipc().invoke("sessions.create", {
        projectId,
        mode: "solo",
        title,
        agents: leadAgent
          ? [{ name: leadAgent.name, backend: leadAgent.backend, model: leadAgent.model, role: "lead" }]
          : [],
      });
      set((s) => ({
        sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
        activeSessionId: session.id,
        agents,
        turns: [],
        blocks: {},
        turnStatus: {},
        usageEvents: [],
        queuedMessages: [],
        lastDoneAt: null,
        staleRequests: [],
      }));
      return session;
    },

    async openSession(sessionId) {
      if (get().activeSessionId === sessionId && get().turns.length > 0) return;
      set({
        activeSessionId: sessionId,
        turns: [],
        blocks: {},
        turnStatus: {},
        usageEvents: [],
        queuedMessages: [],
        lastDoneAt: null,
        staleRequests: [],
      });
      const [loaded, commands] = await Promise.all([
        ipc().invoke("sessions.get", { sessionId }),
        ipc().invoke("chat.listCommands", { sessionId }),
      ]);
      if (get().activeSessionId !== sessionId) return;
      set({ commands });
      if (!loaded) return;
      set({
        agents: loaded.agents,
        turns: loaded.turns,
        blocks: Object.fromEntries(loaded.blocks.map((b) => [b.id, b])),
        turnStatus: Object.fromEntries(loaded.turns.map((t) => [t.id, t.status])),
      });
      void refreshUsage(sessionId);
    },

    async send(text) {
      const sessionId = get().activeSessionId;
      const trimmed = text.trim();
      if (!sessionId || trimmed === "") return;
      touchActivity();
      // A turn is already streaming: queue rather than racing chat.send —
      // the stub (and the real harnesses later) run one turn at a time per
      // session, so a second send now would just supersede the first.
      if (isBusy(get())) {
        set((s) => ({ queuedMessages: [...s.queuedMessages, trimmed] }));
        return;
      }
      await dispatchNow(sessionId, trimmed);
    },

    async interrupt() {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      await ipc().invoke("chat.interrupt", { sessionId });
    },

    async setSettings(patch) {
      const settings = await ipc().invoke("settings.set", patch);
      set({ settings });
    },

    async answerPermission(requestId, decision, opts) {
      touchActivity();
      const { ok } = await ipc().invoke("permission.answer", {
        requestId,
        decision,
        scope: opts?.scope ?? "once",
        ...(opts?.updatedInput !== undefined ? { updatedInput: opts.updatedInput } : {}),
        ...(opts?.message !== undefined ? { message: opts.message } : {}),
      });
      markStale(requestId, ok);
    },

    async answerQuestion(requestId, answers) {
      touchActivity();
      const { ok } = await ipc().invoke("question.answer", { requestId, answers });
      markStale(requestId, ok);
    },

    async answerElicitation(turnId, blockId, answers) {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      touchActivity();
      // Keyed by `blockId`, not `requestId` (`elicitation.answer`'s own
      // shape) — `staleRequests` just needs *an* id the card can check
      // against, and reusing it here gives elicitation the same "no longer
      // waiting" state permission/question cards get instead of pretending
      // an undelivered answer was accepted.
      const { ok } = await ipc().invoke("elicitation.answer", { sessionId, turnId, blockId, answers });
      markStale(blockId, ok);
    },

    async archiveSession(sessionId, archived) {
      const session = await ipc().invoke("sessions.archive", { sessionId, archived });
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === session.id ? session : x)),
      }));
    },

    async setShowArchived(show) {
      set({ showArchived: show });
      const sessions = await ipc().invoke("sessions.list", { includeArchived: show });
      set({ sessions });
    },

    setListening(listening) {
      touchActivity();
      set({ listening });
    },
  };
});

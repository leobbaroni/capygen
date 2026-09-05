/**
 * The renderer's single store. Deliberately thin for task A1: it holds what the
 * shell needs (projects, sessions, the open session's turns and blocks,
 * settings) and subscribes to the main-process event stream once.
 *
 * Two invariants that later phases depend on:
 *   - blocks are keyed by id and *upserted*, because a streaming block is sent
 *     repeatedly as it grows (SPEC R23–R26: persist and render incrementally,
 *     never rebuild the turn);
 *   - nothing here talks to SQLite or a backend; every read and write is an IPC
 *     call, so the agent's context never sees the UI's chatter (R26).
 */
import { create } from "zustand";
import {
  DEFAULT_SETTINGS,
  type Agent,
  type Block,
  type Project,
  type Session,
  type Settings,
  type SlashCommand,
  type TurnStatus,
  type Turn,
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

  /** The session the chat page is showing. */
  activeSessionId: string | null;
  agents: Agent[];
  turns: Turn[];
  /** Block id → block. Upserted; ordering comes from `orderedBlocks`. */
  blocks: Record<string, Block>;
  /** Turn id → live status, so the composer can disable while streaming. */
  turnStatus: Record<string, TurnStatus>;

  init(): Promise<void>;
  pickProject(): Promise<Project | null>;
  startSession(projectId: string, title?: string): Promise<Session>;
  openSession(sessionId: string): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setSettings(patch: Partial<Settings>): Promise<void>;
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

export const useAppStore = create<AppState>()((set, get) => {
  let subscribed = false;

  /** Wire the main → renderer events exactly once. */
  function subscribe(): void {
    if (subscribed) return;
    subscribed = true;
    const client = ipc();

    client.on("chat.block", (block) => {
      if (block.sessionId !== get().activeSessionId) return;
      set((s) => ({ blocks: { ...s.blocks, [block.id]: block } }));
    });

    client.on("chat.turnStatus", ({ sessionId, turnId, status }) => {
      if (sessionId !== get().activeSessionId) return;
      set((s) => ({
        turnStatus: { ...s.turnStatus, [turnId]: status },
        turns: s.turns.map((t) => (t.id === turnId ? { ...t, status } : t)),
      }));
      // A turn the store has not seen yet (the agent turn `chat.send` opened)
      // arrives as a status first; pull the row so it renders in order.
      if (!get().turns.some((t) => t.id === turnId)) void refreshTurns(sessionId);
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

  /** Keep any block that arrived by event and is newer than the fetched row. */
  function pickLive(current: Record<string, Block>, sessionId: string): Record<string, Block> {
    const live: Record<string, Block> = {};
    for (const [id, block] of Object.entries(current)) {
      if (block.sessionId === sessionId) live[id] = block;
    }
    return live;
  }

  return {
    ready: false,
    bridgeAvailable: hasBridge(),
    error: null,
    settings: DEFAULT_SETTINGS,
    projects: [],
    sessions: [],
    commands: [],
    activeSessionId: null,
    agents: [],
    turns: [],
    blocks: {},
    turnStatus: {},

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

    async startSession(projectId, title = "") {
      const { session, agents } = await ipc().invoke("sessions.create", {
        projectId,
        mode: "solo",
        title,
        agents: [],
      });
      set((s) => ({
        sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
        activeSessionId: session.id,
        agents,
        turns: [],
        blocks: {},
        turnStatus: {},
      }));
      return session;
    },

    async openSession(sessionId) {
      if (get().activeSessionId === sessionId && get().turns.length > 0) return;
      set({ activeSessionId: sessionId, turns: [], blocks: {}, turnStatus: {} });
      const loaded = await ipc().invoke("sessions.get", { sessionId });
      if (!loaded || get().activeSessionId !== sessionId) return;
      set({
        agents: loaded.agents,
        turns: loaded.turns,
        blocks: Object.fromEntries(loaded.blocks.map((b) => [b.id, b])),
        turnStatus: Object.fromEntries(loaded.turns.map((t) => [t.id, t.status])),
      });
    },

    async send(text) {
      const sessionId = get().activeSessionId;
      if (!sessionId || text.trim() === "") return;
      await ipc().invoke("chat.send", { sessionId, text, agentId: null });
      await refreshTurns(sessionId);
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
  };
});

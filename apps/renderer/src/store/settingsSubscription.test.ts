/**
 * [7-P1] The renderer's view of runtime configuration.
 *
 * `settings.changed` carries the canonical object, which has no flat-only
 * fields, and a mixed write moves both halves — so the store re-reads
 * `settings.get` rather than deriving from the payload. The event is broadcast
 * only after the whole transaction has committed, so that read cannot observe
 * a half-applied write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_SETTINGS } from "@capygen/shared";
import { useAppStore } from "./appStore";

const invoke = vi.fn();
const listeners = new Map<string, ((payload: unknown) => void)[]>();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({
    invoke,
    on: (channel: string, fn: (payload: unknown) => void) => {
      const list = listeners.get(channel) ?? [];
      list.push(fn);
      listeners.set(channel, list);
      return () => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((f) => f !== fn));
      };
    },
  }),
  hasBridge: () => true,
}));

function fire(channel: string, payload: unknown): void {
  for (const fn of listeners.get(channel) ?? []) fn(payload);
}

beforeEach(() => {
  // `subscribe()` guards itself against a second run, so the listeners it
  // registered on the first `init()` are the ones every case fires into.
  invoke.mockReset();
  useAppStore.setState({
    settings: DEFAULT_SETTINGS,
    pendingAgentRestarts: [],
    projects: [],
    sessions: [],
    ready: false,
  });
  invoke.mockImplementation((channel: string) => {
    if (channel === "settings.get") return Promise.resolve(DEFAULT_SETTINGS);
    if (channel === "projects.list" || channel === "sessions.list") return Promise.resolve([]);
    if (channel === "chat.listCommands") return Promise.resolve([]);
    if (channel === "harness.list") return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

describe("settings.changed", () => {
  it("re-reads the compatibility view rather than trusting the payload", async () => {
    await useAppStore.getState().init();
    // A mixed write: the canonical half is in the event, the flat-only half is
    // only visible through `settings.get`.
    invoke.mockImplementation((channel: string) =>
      channel === "settings.get"
        ? Promise.resolve({ ...DEFAULT_SETTINGS, theme: "dark", hopCap: 9 })
        : Promise.resolve([]),
    );

    fire("settings.changed", {
      settings: { ...DEFAULT_GLOBAL_SETTINGS, appearance: { ...DEFAULT_GLOBAL_SETTINGS.appearance, theme: "dark" } },
    });

    await vi.waitFor(() => {
      expect(useAppStore.getState().settings.theme).toBe("dark");
      expect(useAppStore.getState().settings.hopCap).toBe(9);
    });
  });

  it("leaves the current view alone when the re-read fails", async () => {
    await useAppStore.getState().init();
    invoke.mockImplementation((channel: string) =>
      channel === "settings.get" ? Promise.reject(new Error("read-only")) : Promise.resolve([]),
    );
    fire("settings.changed", { settings: DEFAULT_GLOBAL_SETTINGS });
    await new Promise((r) => setTimeout(r, 20));
    expect(useAppStore.getState().settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("agent.runtime", () => {
  it("tracks which agents are waiting to restart", async () => {
    await useAppStore.getState().init();
    fire("agent.runtime", { agentId: "agt_1", restartPending: true });
    expect(useAppStore.getState().pendingAgentRestarts).toEqual(["agt_1"]);

    // Idempotent: a repeat must not double the badge.
    fire("agent.runtime", { agentId: "agt_1", restartPending: true });
    expect(useAppStore.getState().pendingAgentRestarts).toEqual(["agt_1"]);

    fire("agent.runtime", { agentId: "agt_2", restartPending: true });
    fire("agent.runtime", { agentId: "agt_1", restartPending: false });
    expect(useAppStore.getState().pendingAgentRestarts).toEqual(["agt_2"]);
  });
});

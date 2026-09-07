/**
 * Phase 7-P0: the selected project is **this window's** state.
 *
 * Recency is allowed to seed it once, on `init`, as the landing page's opening
 * guess. After that only an explicit selection moves it — picking a folder,
 * opening a session, or `selectProject`. Nothing re-derives it from
 * `projects.list`'s order, which is `updated_at DESC` and therefore changes
 * under this window whenever *another* window writes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Session } from "@capygen/shared";
import { useAppStore } from "./appStore";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

function project(id: string): Project {
  return { id, name: id, path: `C:/tmp/${id}`, layout: null, devServers: null, createdAt: 0, updatedAt: 0 };
}

/** `projects.list` is ordered `updated_at DESC`, so B is "most recent" here. */
const LISTED = [project("p-b"), project("p-a")];

beforeEach(() => {
  invoke.mockReset();
  useAppStore.setState({ selectedProjectId: null, projects: [], sessions: [], ready: false });
  invoke.mockImplementation((channel: string) => {
    if (channel === "projects.list") return Promise.resolve(LISTED);
    if (channel === "settings.get") return Promise.resolve(useAppStore.getState().settings);
    if (channel === "harness.list") return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

describe("selectedProjectId", () => {
  it("is seeded from recency exactly once, on init", async () => {
    await useAppStore.getState().init();
    expect(useAppStore.getState().selectedProjectId).toBe("p-b");

    // The user moves this window to A, then something re-inits (a reconnect,
    // a second `init` from a remount). Recency must not drag it back to B.
    useAppStore.getState().selectProject("p-a");
    await useAppStore.getState().init();
    expect(useAppStore.getState().selectedProjectId).toBe("p-a");
  });

  it("follows the folder the user picks", async () => {
    await useAppStore.getState().init();
    invoke.mockImplementation((channel: string) => {
      if (channel === "projects.pick") return Promise.resolve(project("p-c"));
      return Promise.resolve([]);
    });
    await useAppStore.getState().pickProject();
    expect(useAppStore.getState().selectedProjectId).toBe("p-c");
  });

  it("follows the session that is opened, so settings scope to the agent's project", async () => {
    await useAppStore.getState().init();
    const session: Session = {
      id: "ses_1",
      projectId: "p-a",
      title: "t",
      mode: "solo",
      status: "idle",
      archived: false,
      leadAgentId: null,
      settings: { hopCap: 8, parallelAgents: false },
      createdAt: 0,
      updatedAt: 0,
    };
    invoke.mockImplementation((channel: string) => {
      if (channel === "sessions.get") {
        return Promise.resolve({
          session,
          agents: [],
          turns: [],
          blocks: [],
          usageEvents: [],
          chainPending: null,
        });
      }
      return Promise.resolve([]);
    });
    await useAppStore.getState().openSession("ses_1");
    expect(useAppStore.getState().selectedProjectId).toBe("p-a");
    expect(useAppStore.getState().sessions).toContainEqual(session);
  });

  it("survives navigation — it is store state, not page state", async () => {
    await useAppStore.getState().init();
    useAppStore.getState().selectProject("p-a");
    // Nothing about rendering another page touches it; the store is the whole
    // lifetime of the window.
    expect(useAppStore.getState().selectedProjectId).toBe("p-a");
    useAppStore.setState({ activeSessionId: null });
    expect(useAppStore.getState().selectedProjectId).toBe("p-a");
  });
});

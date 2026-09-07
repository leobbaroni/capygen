/**
 * The workspace channels as `main.ts` actually calls them — args parsed in,
 * result parsed out through the shared contract — so a service whose return
 * shape drifts from `@capygen/shared` fails here rather than at runtime in
 * front of a pane.
 *
 * Also pins the two wiring facts that are easy to lose: every workspace
 * channel in the contract is answered by `createWorkspaceIpc` (nothing falls
 * back to a stub), and a `TodoWrite` block broadcast by the engine reaches the
 * Tasks derivation through `handlers.ts`'s broadcast tap.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INVOKE_CHANNEL_NAMES,
  newId,
  parseInvokeArgs,
  parseInvokeResult,
  type Block,
  type InvokeChannel,
  type Task,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { WORKSPACE_CHANNELS, createWorkspaceIpc } from "../src/ipc/workspace.js";
import { createStubEngine } from "../src/engine/stub.js";
import { FIXTURES_DIR, makeHarness, type Harness } from "./workspaceHarness.js";

let h: Harness;
let ipc: IpcContext;

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-wsipc-" });
  ipc = createIpcContext({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    makeEngine: createStubEngine,
    pickDirectory: async () => null,
    appInfo: () => ({
      name: "capygen",
      version: "0.1.0",
      electron: "44.2.0",
      chrome: "1",
      node: "24.20.0",
      platform: "win32",
      userDataDir: h.dir,
      logFile: path.join(h.dir, "log.txt"),
      dbFile: h.store.db.file,
    }),
    workspace: { fs: { ripgrepPath: () => null } },
  });
});

afterEach(async () => {
  await ipc.dispose();
  h.close();
});

describe("contract coverage", () => {
  it("every workspace channel in the shared contract is answered here", () => {
    const declared = INVOKE_CHANNEL_NAMES.filter((name) =>
      /^(layout|fs|git|worktrees|terminal|servers|tasks|browser)\./.test(name),
    );
    expect([...WORKSPACE_CHANNELS].sort()).toEqual([...declared].sort());
  });

  it("and every one of them has a handler on the context", () => {
    for (const channel of WORKSPACE_CHANNELS) {
      expect(typeof ipc.handlers[channel]).toBe("function");
    }
  });
});

describe("round trips through the contract", () => {
  it("validates the source repository before opening the native worktree picker", async () => {
    const pickDestination = vi.fn(async () => path.join(h.dir, "never-picked"));
    const workspace = createWorkspaceIpc({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      worktrees: { pickDestination },
      fs: { ripgrepPath: () => null },
    });
    try {
      await expect(workspace.handlers["worktrees.create"]({
        sourceProjectId: h.projectId,
        branch: { mode: "new", name: "feature/x", base: "HEAD" },
      })).rejects.toMatchObject({ code: "not-repository" });
      expect(pickDestination).not.toHaveBeenCalled();
    } finally {
      await workspace.dispose();
    }
  });

  it("layout.set then layout.get", async () => {
    expect(await call("layout.get", { projectId: h.projectId })).toBeNull();
    const layout = { grid: { root: { type: "branch" } }, panels: {} };
    const saved = (await call("layout.set", {
      projectId: h.projectId,
      layoutJson: layout,
    })) as { projectId: string; layoutJson: unknown };
    expect(saved.projectId).toBe(h.projectId);
    expect((await call("layout.get", { projectId: h.projectId }) as typeof saved).layoutJson).toEqual(
      layout,
    );
  });

  it("fs.write → fs.list → fs.read", async () => {
    await call("fs.write", { projectId: h.projectId, path: "a/b.txt", content: "hi" });
    const listed = (await call("fs.list", { projectId: h.projectId, dir: "a" })) as {
      entries: { path: string }[];
    };
    expect(listed.entries.map((e) => e.path)).toEqual(["a/b.txt"]);
    const read = (await call("fs.read", { projectId: h.projectId, path: "a/b.txt" })) as {
      content: string;
    };
    expect(read.content).toBe("hi");
  });

  it("fs.watch / fs.unwatch are idempotent through the contract", async () => {
    expect(await call("fs.watch", { projectId: h.projectId })).toEqual({ ok: true });
    expect(await call("fs.watch", { projectId: h.projectId })).toEqual({ ok: true });
    expect(await call("fs.unwatch", { projectId: h.projectId })).toEqual({ ok: true });
    expect(await call("fs.unwatch", { projectId: h.projectId })).toEqual({ ok: true });
  });

  it("git.status answers null for a folder that is not a repo", async () => {
    expect(await call("git.status", { projectId: h.projectId })).toBeNull();
    expect(await call("git.diff", { projectId: h.projectId })).toEqual([]);
  });

  it("servers.saveCustom → servers.list → servers.remove", async () => {
    const saved = (await call("servers.saveCustom", {
      projectId: h.projectId,
      server: { name: "manual", command: "node", args: ["x.js"], cwd: h.root, port: 1234 },
    })) as { id: string; source: string };
    expect(saved.source).toBe("custom");

    const listed = (await call("servers.list", { projectId: h.projectId })) as {
      server: { id: string };
      run: unknown;
    }[];
    expect(listed.map((r) => r.server.id)).toEqual([saved.id]);
    expect(listed[0]?.run).toBeNull();

    expect(await call("servers.remove", { serverId: saved.id })).toEqual({ ok: true });
    expect(await call("servers.list", { projectId: h.projectId })).toEqual([]);
  });

  it("servers.detect reads a fixture project's launch.json", async () => {
    const fixture = h.store.projects.upsertByPath({
      path: path.join(FIXTURES_DIR, "launchjson"),
    });
    const detected = (await call("servers.detect", { projectId: fixture.id })) as {
      server: { name: string; source: string };
    }[];
    expect(detected.map((r) => r.server.name)).toEqual(["web", "docs"]);
    expect(detected.every((r) => r.server.source === "launch.json")).toBe(true);
  });

  it("servers.logs for something that was never started is empty, not an error", async () => {
    expect(await call("servers.logs", { serverId: "srv_nothing" })).toEqual({ lines: [] });
  });

  it("terminal.list is empty until something is created", async () => {
    expect(await call("terminal.list", { projectId: h.projectId })).toEqual([]);
  });

  it("browser.* refuses loudly when no WebContentsView host is wired", async () => {
    await expect(
      call("browser.attach", {
        viewId: "p",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).rejects.toThrow(/no WebContentsView host/);
  });
});

describe("the broadcast tap feeds the Tasks pane", () => {
  /**
   * The tap lives on the broadcast `createIpcContext` hands the *engine*, so
   * the only honest way to exercise it is to be the engine: this factory keeps
   * the broadcast it was given and the test pushes a `chat.block` through it,
   * exactly as `persist.emitBlock` does.
   */
  function contextWithCapturedBroadcast(): {
    context: IpcContext;
    emit: (block: Block) => void;
  } {
    let captured: ((channel: string, payload: unknown) => void) | null = null;
    const context = createIpcContext({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      makeEngine: (engineDeps) => {
        captured = engineDeps.broadcast as unknown as typeof captured;
        return createStubEngine(engineDeps);
      },
      pickDirectory: async () => null,
      appInfo: () => ({
        name: "capygen",
        version: "0.1.0",
        electron: "44.2.0",
        chrome: "1",
        node: "24.20.0",
        platform: "win32",
        userDataDir: h.dir,
        logFile: path.join(h.dir, "log.txt"),
        dbFile: h.store.db.file,
      }),
    });
    return {
      context,
      emit: (block) => {
        h.store.blocks.upsert(block);
        captured?.("chat.block", block);
      },
    };
  }

  function todoBlock(sessionId: string, turnId: string, title: string): Block {
    const ts = Date.now();
    return {
      id: newId("block"),
      turnId,
      sessionId,
      kind: "tool_call",
      index: 0,
      name: "TodoWrite",
      input: { todos: [{ content: title, status: "pending" }] },
      status: "success",
      createdAt: ts,
      updatedAt: ts,
    };
  }

  it("a TodoWrite block the engine broadcasts becomes task rows", async () => {
    const { context, emit } = contextWithCapturedBroadcast();
    const created = h.store.sessions.create({
      projectId: h.projectId,
      mode: "solo",
      agents: [{ name: "capy", backend: "claude", model: "opus", role: "lead", config: null }],
    });
    const turn = h.store.turns.create({
      sessionId: created.session.id,
      agentId: created.agents[0]!.id,
      role: "agent",
      status: "streaming",
    });

    emit(todoBlock(created.session.id, turn.id, "Ship it"));

    const tasks = h.store.tasks.listBySession(created.session.id);
    expect(tasks.map((t) => t.title)).toEqual(["Ship it"]);
    // The payload still reached the renderer untouched.
    expect(h.eventsOn("chat.block")).toHaveLength(1);

    const updated = (await (async () => {
      const handler = context.handlers["tasks.update"] as (a: unknown) => Promise<Task> | Task;
      return handler(
        parseInvokeArgs("tasks.update", { id: tasks[0]!.id, patch: { status: "completed" } }),
      );
    })()) as Task;
    expect(updated.status).toBe("completed");
    await context.dispose();
  });

  it("an ordinary block costs the tap nothing", async () => {
    const { context, emit } = contextWithCapturedBroadcast();
    const created = h.store.sessions.create({
      projectId: h.projectId,
      mode: "solo",
      agents: [{ name: "capy", backend: "claude", model: "opus", role: "lead", config: null }],
    });
    const turn = h.store.turns.create({
      sessionId: created.session.id,
      agentId: created.agents[0]!.id,
      role: "agent",
      status: "streaming",
    });
    const spy = vi.spyOn(h.store.tasks, "upsert");
    const ts = Date.now();

    emit({
      id: newId("block"),
      turnId: turn.id,
      sessionId: created.session.id,
      kind: "text",
      index: 0,
      text: "just talking",
      createdAt: ts,
      updatedAt: ts,
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await context.dispose();
  });
});

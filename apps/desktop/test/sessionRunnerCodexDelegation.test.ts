/**
 * The Codex half of SPEC R12's cross-backend delegation, end to end through the
 * shipping wiring: a real `CodexHarness` over a fake app-server transport, the
 * real `SessionRunner`, and a real SQLite store. No model, no network, no real
 * config home.
 *
 * ADR-0004 recorded that a Codex lead could not be handed `delegate_task`
 * because app-server took MCP servers only from `config.toml`. The pinned
 * 0.153.4 binary does have a client-hosted tool path (`dynamicTools` +
 * `item/tool/call`, proven in `packages/engine/scripts/probe-codex-dynamic-tools.ts`),
 * and this is the wiring that uses it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { AsyncQueue, CodexHarness, type EngineEvent, type Harness, type HarnessAgent } from "@capygen/engine";
import { parseInvokeArgs, parseInvokeResult, type InvokeChannel, type HarnessInfo } from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { backendSessionToolsKey, createSessionRunner, type HarnessExtras } from "../src/engine/SessionRunner.js";
import { createFakeAppServer, settle, type FakeAppServer } from "../../../packages/engine/test/codexFakeAppServer.js";

const THREAD_ID = "thread_codex_1";
const CODEX_TURN = "codex_turn_1";

let root: string;
let store: CapygenStore;
let ipc: IpcContext;
let servers: FakeAppServer[];
let codexExtras: HarnessExtras[];
let builtChildren: HarnessAgent[];
let startedChildren: HarnessAgent[];
let childHarness: StubChild | null;
let threadStarts: Record<string, unknown>[];

/** The delegated `api` child: never resolves on its own, so cancellation is
 *  observable, and records what it was told to be. */
class StubChild implements Harness {
  readonly backend = "api" as const;
  interrupts = 0;
  disposes = 0;
  private out: AsyncQueue<EngineEvent> | null = null;
  async start(_session: unknown, agent: HarnessAgent): Promise<void> {
    startedChildren.push(agent);
  }
  send(): AsyncIterable<EngineEvent> {
    this.out = new AsyncQueue<EngineEvent>();
    return this.out;
  }
  async interrupt(): Promise<boolean> {
    this.interrupts += 1;
    return true;
  }
  async dispose(): Promise<void> {
    this.disposes += 1;
    this.out?.close();
  }
  listCommands(): [] {
    return [];
  }
  capabilities() {
    return {
      streamingDeltas: true,
      permissions: true,
      questions: true,
      subagents: false,
      resume: false,
      interrupt: true,
      slashCommands: false,
    };
  }
  answerPermission(): boolean {
    return true;
  }
  answerQuestion(): boolean {
    return true;
  }
  backendSessionId(): string | null {
    return null;
  }
  /** Finish the delegated turn with some text. */
  finish(text: string): void {
    this.out?.push({ type: "block", key: "msg:0", patch: { kind: "text", text } });
    this.out?.push({ type: "turn", status: "done" });
    this.out?.close();
  }
}

async function call<C extends InvokeChannel>(channel: C, raw: unknown) {
  const handler = ipc.handlers[channel] as (args: unknown) => unknown;
  return parseInvokeResult(channel, await handler(parseInvokeArgs(channel, raw)));
}

const CATALOGUE: HarnessInfo[] = [
  {
    backend: "codex",
    label: "Codex",
    available: true,
    defaultModel: "gpt-5.6-luna",
    models: [{ id: "gpt-5.6-luna", label: "Luna" }],
    providers: [],
  },
  {
    backend: "api",
    label: "API",
    available: true,
    defaultModel: "gpt-5",
    providers: ["openai"],
    models: [{ id: "gpt-5", label: "GPT" }],
  },
];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-codex-delegate-"));
  for (const name of ["project", "claude", "codex"]) fs.mkdirSync(path.join(root, name));
  store = openStore(path.join(root, "test.db"), {
    migrationsDir: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
  });
  servers = [];
  codexExtras = [];
  builtChildren = [];
  startedChildren = [];
  childHarness = null;
  threadStarts = [];
  ipc = makeIpc();
});

function makeIpc(): IpcContext {
  return createIpcContext({
    store,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    broadcast: () => {},
    env: {},
    integrations: {
      home: root,
      env: { CLAUDE_CONFIG_DIR: path.join(root, "claude"), CODEX_HOME: path.join(root, "codex") },
    },
    catalogue: () => CATALOGUE,
    pickDirectory: async () => path.join(root, "project"),
    appInfo: () => ({
      name: "capygen",
      version: "0",
      electron: "44",
      chrome: "1",
      node: "24",
      platform: "win32",
      userDataDir: root,
      dbFile: store.db.file,
      logFile: path.join(root, "test.log"),
    }),
    makeEngine: (deps) =>
      createSessionRunner({
        ...deps,
        makeHarness: (agent, wiring) => {
          if (agent.backend !== "codex") {
            builtChildren.push(agent);
            childHarness = new StubChild();
            return childHarness;
          }
          codexExtras.push(wiring);
          const server = createFakeAppServer({
            handlers: {
              initialize: () => ({}),
              "thread/start": (params) => {
                threadStarts.push(params as Record<string, unknown>);
                return { thread: { id: THREAD_ID } };
              },
              "thread/resume": (params) => {
                threadStarts.push(params as Record<string, unknown>);
                return { thread: { id: THREAD_ID } };
              },
              "skills/list": () => ({ data: [] }),
              "turn/start": () => ({ turn: { id: CODEX_TURN, status: "inProgress" } }),
            },
          });
          servers.push(server);
          return new CodexHarness({
            transport: server.transport,
            ...(wiring.dynamicTools ? { dynamicTools: wiring.dynamicTools } : {}),
            ...(wiring.storeDynamicToolOutput
              ? { storeDynamicToolOutput: wiring.storeDynamicToolOutput }
              : {}),
          });
        },
      }),
  });
}

/** What an app restart looks like to the runner: the engine is disposed and
 *  rebuilt against the same database, so nothing survives but stored state. */
async function restart(): Promise<void> {
  await ipc.dispose();
  servers.length = 0;
  threadStarts.length = 0;
  codexExtras.length = 0;
  childHarness = null;
  ipc = makeIpc();
}

afterEach(async () => {
  await ipc.dispose();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A Codex lead session, optionally routed to the `api` backend. */
async function makeSession(options: { route?: boolean; permissionMode?: string } = {}) {
  await call("settings.patch", {
    patch: {
      backends: {
        codex: {
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        },
      },
    },
  });
  const project = await call("projects.pick", {});
  const made = await call("sessions.create", {
    projectId: project!.id,
    agents: [{ name: "lead", backend: "codex", model: "gpt-5.6-luna", role: "lead" }],
  });
  const agentId = made.agents[0]!.id;
  if (options.route !== false) {
    await call("agents.update", {
      agentId,
      patch: { subagentRouting: { backend: "api", model: "gpt-5" } },
    });
  }
  return { sessionId: made.session.id, agentId };
}

/** Drive one Codex turn far enough that a dynamic tool call can arrive. */
async function openTurn(sessionId: string) {
  void call("chat.send", { sessionId, text: "do the thing" });
  await vi.waitFor(() => expect(servers.length).toBeGreaterThan(0));
  const server = servers.at(-1)!;
  await server.waitForRequest("turn/start");
  await settle();
  return server;
}

function dynamicCall(overrides: Record<string, unknown> = {}) {
  return {
    threadId: THREAD_ID,
    turnId: CODEX_TURN,
    callId: "call_1",
    namespace: null,
    tool: "delegate_task",
    arguments: { description: "child work", prompt: "do it" },
    ...overrides,
  };
}

function itemFrame(status: string, extra: Record<string, unknown> = {}) {
  return {
    threadId: THREAD_ID,
    turnId: CODEX_TURN,
    item: {
      type: "dynamicToolCall",
      id: "call_1",
      namespace: null,
      tool: "delegate_task",
      arguments: { description: "child work", prompt: "do it" },
      status,
      contentItems: null,
      success: null,
      durationMs: null,
      ...extra,
    },
  };
}

describe("a Codex lead is given delegate_task as a dynamic tool", () => {
  it("declares it on thread/start and routes a call to a real child", async () => {
    const { sessionId } = await makeSession({ permissionMode: "bypassPermissions" });
    const server = await openTurn(sessionId);

    const start = threadStarts.at(-1)!;
    expect(start.dynamicTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "function", name: "delegate_task" })]),
    );

    server.notify("item/started", itemFrame("inProgress"));
    await settle();
    const answer = server.ask("item/tool/call", dynamicCall());
    await vi.waitFor(() => expect(childHarness).not.toBeNull());
    childHarness!.finish("the child answered");
    const response = (await answer) as { contentItems: { text?: string }[]; success: boolean };
    expect(response.success).toBe(true);
    expect(response.contentItems.map((c) => c.text).join("")).toContain("the child answered");
    // The child ran on the routed backend, resolved independently of the parent.
    expect(startedChildren).toHaveLength(1);
    expect(startedChildren[0]!.backend).toBe("api");
  });

  it("declares it for an agent with no routing rule at all", async () => {
    // The tool used to exist only for an agent whose user had configured a
    // cross-backend rule — settings that no longer have a UI. Without a rule
    // the default target is the agent's own backend and model, which is a real
    // sub-agent, so the tool is declared like any other.
    const { sessionId } = await makeSession({ route: false });
    await openTurn(sessionId);
    expect(threadStarts.at(-1)!.dynamicTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "function", name: "delegate_task" })]),
    );
    expect(codexExtras.at(-1)?.dynamicTools?.map((tool) => tool.name)).toContain("delegate_task");
  });

  it("runs a call that names a backend, with no routing rule behind it", async () => {
    const { sessionId } = await makeSession({ route: false, permissionMode: "bypassPermissions" });
    const server = await openTurn(sessionId);
    server.notify("item/started", itemFrame("inProgress"));
    await settle();
    const answer = server.ask(
      "item/tool/call",
      dynamicCall({
        arguments: { description: "child work", prompt: "do it", backend: "api", model: "gpt-5" },
      }),
    );
    await vi.waitFor(() => expect(childHarness).not.toBeNull());
    childHarness!.finish("the api child answered");
    const response = (await answer) as { contentItems: { text?: string }[]; success: boolean };
    expect(response.success).toBe(true);
    // No stored routing rule was involved: the call named the target itself.
    expect(startedChildren[0]!.backend).toBe("api");
    expect(startedChildren[0]!.model).toBe("gpt-5");
  });

  it("does not infer a host bypass from Codex's own approvalPolicy=never", async () => {
    // `approvalPolicy: "never"` and `danger-full-access` govern the tools Codex
    // runs in its own sandbox. `delegate_task` runs inside capygen, so the app's
    // explicit permission mode governs it — and its default is to ask.
    const { sessionId } = await makeSession();
    const server = await openTurn(sessionId);
    server.notify("item/started", itemFrame("inProgress"));
    await settle();
    const answer = server.ask("item/tool/call", dynamicCall());
    await settle();
    // No child yet: a permission card is waiting for the user.
    expect(childHarness).toBeNull();
    const pending = store.blocks
      .listBySession(sessionId)
      .find((block) => block.kind === "permission");
    expect(pending).toBeDefined();
    void answer;
  });

  it("refuses the call outright in plan mode", async () => {
    const { sessionId } = await makeSession({ permissionMode: "plan" });
    const server = await openTurn(sessionId);
    server.notify("item/started", itemFrame("inProgress"));
    await settle();
    const response = (await server.ask("item/tool/call", dynamicCall())) as {
      contentItems: { text?: string }[];
      success: boolean;
    };
    expect(response.success).toBe(false);
    expect(response.contentItems.map((c) => c.text).join("")).toMatch(/denied_by_mode/);
    expect(childHarness).toBeNull();
  });
});

describe("a delegated child's full answer is stored, not stuffed into the block", () => {
  it("writes tool_outputs against the real block id and stamps outputRef", async () => {
    const { sessionId } = await makeSession({ permissionMode: "bypassPermissions" });
    const server = await openTurn(sessionId);
    server.notify("item/started", itemFrame("inProgress"));
    await settle();
    const answer = server.ask("item/tool/call", dynamicCall());
    await vi.waitFor(() => expect(childHarness).not.toBeNull());
    const huge = "🙂".repeat(40_000); // 160 000 bytes
    childHarness!.finish(huge);
    const response = (await answer) as { contentItems: { text?: string }[] };
    const replied = response.contentItems.map((c) => c.text).join("");
    expect(Buffer.byteLength(replied, "utf8")).toBeLessThanOrEqual(64 * 1024);

    server.notify(
      "item/completed",
      itemFrame("completed", {
        contentItems: [{ type: "inputText", text: "stub" }],
        success: true,
      }),
    );
    await settle();

    const block = store.blocks
      .listBySession(sessionId)
      .find((b) => b.kind === "tool_call" && b.name === "delegate_task");
    expect(block).toBeDefined();
    const ref = (block as { outputRef?: string }).outputRef;
    expect(ref).toBeTruthy();
    // Retrievable, and pointing back at this very block — no orphan row.
    const stored = store.toolOutputs.get(ref!);
    expect(stored).not.toBeNull();
    expect(stored!.blockId).toBe(block!.id);
    expect(stored!.content).toContain(huge.slice(0, 200));
    // The megabytes are in tool_outputs, not in the block payload.
    expect(JSON.stringify(block)).not.toContain(huge.slice(0, 200));
  });
});

describe("cancellation reaches the delegated child", () => {
  it("stops a child whose own backend ignores the interrupt", async () => {
    const { sessionId } = await makeSession({ permissionMode: "bypassPermissions" });
    const server = await openTurn(sessionId);
    server.notify("item/started", itemFrame("inProgress"));
    await settle();
    const answer = server.ask("item/tool/call", dynamicCall());
    await vi.waitFor(() => expect(childHarness).not.toBeNull());
    // The child never finishes; the user presses Stop.
    await call("chat.interrupt", { sessionId });
    const response = (await answer) as { success: boolean };
    expect(response.success).toBe(false);
    expect(childHarness!.interrupts).toBeGreaterThan(0);
    // The child ignores the interrupt, so only the runner's own grace timer
    // tears it down — that is the guarantee against detached billing.
    await vi.waitFor(() => expect(childHarness!.disposes).toBeGreaterThan(0), { timeout: 6000 });
  });
});

describe("the declared tool set survives a restart, or forces a fresh thread", () => {
  it("resumes the same thread when the declaration signature is unchanged", async () => {
    const { sessionId } = await makeSession();
    const server = await openTurn(sessionId);
    server.notify("session", { threadId: THREAD_ID });
    server.notify("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: CODEX_TURN, status: "completed", items: [] },
    });
    await settle();

    await restart();
    await openTurn(sessionId);
    // A resume, not a new thread: the tool set is the one this thread has.
    const params = threadStarts.at(-1)!;
    expect(params.threadId).toBe(THREAD_ID);
    expect(params).not.toHaveProperty("dynamicTools");
  });

  it("starts a fresh thread with a visible notice when the signature changed", async () => {
    const { sessionId, agentId } = await makeSession();
    const server = await openTurn(sessionId);
    server.notify("session", { threadId: THREAD_ID });
    server.notify("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: CODEX_TURN, status: "completed", items: [] },
    });
    await settle();
    await restart();

    // Something that changes the declaration: the tool set is recorded by name
    // and schema, so a stored signature that no longer matches means this
    // thread cannot be given the tools the agent is now configured with.
    store.settings.setRaw(`engine.backendSession.dynamicTools.${agentId}`, "stale-signature");

    await openTurn(sessionId);
    const params = threadStarts.at(-1)!;
    expect(params).not.toHaveProperty("threadId");
    expect(params.dynamicTools).toBeDefined();
    const notice = store.blocks
      .listBySession(sessionId)
      .find((b) => b.kind === "error" && /tool/i.test((b as { message?: string }).message ?? ""));
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toMatch(/new Codex thread/i);
  });
});

describe("continuity when a fresh thread is forced (R26-bounded)", () => {
  /** The prompts the Codex harness actually sent, in order. */
  function sentPrompts(server: FakeAppServer): string[] {
    return server.sent
      .filter((frame) => frame.method === "turn/start")
      .map((frame) => {
        const input = (frame.params as { input?: { text?: string }[] }).input ?? [];
        return input.map((part) => part.text ?? "").join("");
      });
  }

  it("carries a bounded inert reference once on the first send of the new thread", async () => {
    const { sessionId, agentId } = await makeSession();
    const first = await openTurn(sessionId);
    first.notify("session", { threadId: THREAD_ID });
    first.notify("item/completed", {
      threadId: THREAD_ID,
      turnId: CODEX_TURN,
      item: { type: "agentMessage", id: "m1", text: "the earlier answer" },
    });
    first.notify("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: CODEX_TURN, status: "completed", items: [] },
    });
    await settle();
    await restart();
    store.settings.setRaw(`engine.backendSession.dynamicTools.${agentId}`, "stale-signature");

    const second = await openTurn(sessionId);
    const prompts = sentPrompts(second);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    // Labelled, inert, and clearly historical.
    expect(prompt).toMatch(/HISTORICAL CONTEXT|IMPORTED REFERENCE/);
    expect(prompt).toContain("the earlier answer");
    // The user's actual message survives, after the reference.
    // The user's own message is passed through unchanged and comes last: the
    // quotation is a prefix, not a replacement.
    expect(prompt.trimEnd().endsWith("do the thing")).toBe(true);
    // R26: bounded, and nothing about configuration or identity travels with it.
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(12_000);
    expect(prompt).not.toContain("danger-full-access");
    expect(prompt).not.toContain(agentId);
    expect(prompt).not.toContain(THREAD_ID);

    // Once only: the next turn on the same thread is the plain prompt.
    second.notify("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: CODEX_TURN, status: "completed", items: [] },
    });
    await settle();
    void call("chat.send", { sessionId, text: "second message" });
    await vi.waitFor(() => expect(sentPrompts(second).length).toBe(2));
    expect(sentPrompts(second)[1]).not.toMatch(/HISTORICAL CONTEXT|IMPORTED REFERENCE/);
  });

  it("adds no context when the thread is simply resumed", async () => {
    const { sessionId } = await makeSession();
    const first = await openTurn(sessionId);
    first.notify("session", { threadId: THREAD_ID });
    first.notify("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: CODEX_TURN, status: "completed", items: [] },
    });
    await settle();
    await restart();

    const second = await openTurn(sessionId);
    const prompts = sentPrompts(second);
    expect(prompts[0]).toBe("do the thing");
  });

  it("starts a fresh thread for a stored thread that predates the tool", async () => {
    // The mirror of the signature check above, and the case every installation
    // meets once now that the tool is universal: a thread created by a build
    // that declared nothing carries no signature, and cannot be handed a tool
    // set after the fact — so it is replaced rather than resumed.
    const { sessionId, agentId } = await makeSession({ route: false });
    const first = await openTurn(sessionId);
    first.notify("session", { threadId: THREAD_ID });
    first.notify("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: CODEX_TURN, status: "completed", items: [] },
    });
    await settle();
    await restart();

    store.settings.setRaw(backendSessionToolsKey(agentId), null);
    await openTurn(sessionId);
    const params = threadStarts.at(-1)!;
    expect(params).not.toHaveProperty("threadId");
    expect(params.dynamicTools).toBeDefined();
  });

  it("keeps the thread when only the routing target changes", async () => {
    const { sessionId, agentId } = await makeSession();
    const first = await openTurn(sessionId);
    first.notify("session", { threadId: THREAD_ID });
    first.notify("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: CODEX_TURN, status: "completed", items: [] },
    });
    await settle();
    await restart();

    // A different backend and model for sub-agents: the tool the model sees is
    // byte-identical, so the live thread must survive.
    await call("agents.update", {
      agentId,
      patch: { subagentRouting: { backend: "claude", model: "claude-opus-4-5" } },
    });
    const second = await openTurn(sessionId);
    expect(threadStarts.at(-1)!.threadId).toBe(THREAD_ID);
    expect(sentPrompts(second)[0]).toBe("do the thing");
  });
});

describe("continuity reads a bounded tail, not the whole session", () => {
  it("never loads huge non-text payloads to produce its 6 KB reference", async () => {
    const { sessionId, agentId } = await makeSession();
    const first = await openTurn(sessionId);
    first.notify("session", { threadId: THREAD_ID });
    first.notify("item/completed", {
      threadId: THREAD_ID,
      turnId: CODEX_TURN,
      item: { type: "agentMessage", id: "m1", text: "the earlier answer" },
    });
    first.notify("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: CODEX_TURN, status: "completed", items: [] },
    });
    await settle();

    // 40 tool-call blocks of ~256 KB each: ~10 MB of payload that a
    // whole-history read would pull into memory to build a 6 KB quotation.
    const turnId = store.turns.list(sessionId)[0]!.id;
    const filler = "F".repeat(256 * 1024);
    for (let index = 0; index < 40; index += 1) {
      store.blocks.upsert({
        id: `blk_big_${index}`,
        turnId,
        sessionId,
        kind: "tool_call",
        index: 100 + index,
        name: "bash",
        input: {},
        output: filler,
        status: "success",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Count what the *continuity* read pulls across the process boundary. It
    // is identified by its own projection, so this measures this code and not
    // the unrelated whole-history read `RoundTable` still performs.
    const realAll = store.db.all.bind(store.db);
    let continuityRows = 0;
    let continuityBytes = 0;
    const spy = vi
      .spyOn(store.db, "all")
      .mockImplementation((sql: string, ...params: unknown[]) => {
        const rows = realAll(sql, ...(params as never[]));
        if (sql.includes("$.text") && sql.includes("FROM blocks")) {
          continuityRows += rows.length;
          continuityBytes += Buffer.byteLength(JSON.stringify(rows), "utf8");
        }
        return rows as never;
      });

    await restart();
    store.settings.setRaw(`engine.backendSession.dynamicTools.${agentId}`, "stale-signature");
    const second = await openTurn(sessionId);
    spy.mockRestore();

    const prompt = second.sent
      .filter((frame) => frame.method === "turn/start")
      .map((frame) => ((frame.params as { input?: { text?: string }[] }).input ?? [])
        .map((part) => part.text ?? "")
        .join(""))[0]!;
    expect(prompt).toContain("the earlier answer");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(12_000);
    expect(prompt).not.toContain(filler.slice(0, 64));
    // The filler is ~10 MB of tool output. The continuity read never sees any
    // of it: it selects only `text` blocks, caps the rows and caps each row's
    // characters, so its whole result stays a few tens of kilobytes.
    expect(continuityRows).toBeGreaterThan(0);
    expect(continuityRows).toBeLessThanOrEqual(40);
    expect(continuityBytes).toBeLessThan(200_000);
  });
});

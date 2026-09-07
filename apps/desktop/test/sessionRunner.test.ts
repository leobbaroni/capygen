/**
 * The session runner over the real IPC handlers and a real temp database, with
 * a fake harness standing in for a backend. This is where the Phase 2 promises
 * are pinned: blocks are persisted as they stream (one row per harness block
 * key, not one per delta), usage lands in `usage_events`, permission and
 * AskUserQuestion answers reach the waiting backend, and a relaunched app
 * resumes the backend session instead of starting a new one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { AsyncQueue } from "@capygen/engine";
import type {
  EngineEvent,
  Harness,
  HarnessAgent,
  HarnessCapabilities,
  HarnessSession,
  PermissionAnswer,
} from "@capygen/engine";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type Block,
  type EventChannel,
  type InvokeChannel,
  type SlashCommand,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createSessionRunner, backendSessionKey } from "../src/engine/SessionRunner.js";
import { createStubEngine } from "../src/engine/stub.js";
import type { EngineDeps } from "../src/engine/types.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/migrations", import.meta.url),
);

/** A harness the test drives by hand. */
class FakeHarness implements Harness {
  readonly backend = "claude" as const;
  session: HarnessSession | null = null;
  agent: HarnessAgent | null = null;
  events = new AsyncQueue<EngineEvent>();
  prompts: string[] = [];
  interrupted = 0;
  disposed = 0;
  answers: { requestId: string; value: unknown }[] = [];
  commands: SlashCommand[] = [];

  async start(session: HarnessSession, agent: HarnessAgent): Promise<void> {
    this.session = session;
    this.agent = agent;
  }

  send(input: { turnId: string; text: string }): AsyncIterable<EngineEvent> {
    this.prompts.push(input.text);
    this.events = new AsyncQueue<EngineEvent>();
    return this.events;
  }

  async interrupt(): Promise<boolean> {
    this.interrupted += 1;
    this.events.push({ type: "turn", status: "interrupted" });
    this.events.close();
    return true;
  }

  listCommands(): SlashCommand[] {
    return this.commands;
  }

  capabilities(): HarnessCapabilities {
    return {
      streamingDeltas: true,
      permissions: true,
      questions: true,
      subagents: true,
      resume: true,
      interrupt: true,
      slashCommands: true,
    };
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    this.answers.push({ requestId, value: answer });
    return true;
  }

  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    this.answers.push({ requestId, value: answers });
    return true;
  }

  backendSessionId(): string | null {
    return null;
  }

  /**
   * Mirrors `ClaudeHarness.dispose`: settle the live turn (the queue is what
   * the runner is iterating) and only then go away. The runner's shutdown
   * contract depends on that event being pushed.
   */
  async dispose(): Promise<void> {
    this.disposed += 1;
    this.events.push({ type: "turn", status: "interrupted" });
    this.events.close();
  }
}

let dir: string;
let store: CapygenStore;
let ipc: IpcContext;
let harness: FakeHarness;
let seenAgents: HarnessAgent[];
let events: { channel: EventChannel; payload: unknown }[];

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

function eventsOn(channel: EventChannel): unknown[] {
  return events.filter((e) => e.channel === channel).map((e) => e.payload);
}

function makeContext(): IpcContext {
  return createIpcContext({
    store,
    broadcast: (channel, payload) => events.push({ channel, payload }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    makeEngine: (deps: EngineDeps) =>
      createSessionRunner({
        ...deps,
        makeHarness: (agent) => {
          seenAgents.push(agent);
          return harness;
        },
      }),
    pickDirectory: async () => path.join(dir, "project"),
    appInfo: () => ({
      name: "capygen",
      version: "0.1.0",
      electron: "44.2.0",
      chrome: "1",
      node: "24.20.0",
      platform: "win32",
      userDataDir: dir,
      logFile: path.join(dir, "logs", "capygen-desktop.log"),
      dbFile: store.db.file,
    }),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-runner-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  events = [];
  harness = new FakeHarness();
  seenAgents = [];
  ipc = makeContext();
});

afterEach(async () => {
  await ipc.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function newSession(): Promise<{ sessionId: string; agentId: string }> {
  const project = (await call("projects.pick", {})) as { id: string };
  const created = (await call("sessions.create", { projectId: project.id })) as {
    session: { id: string; leadAgentId: string };
  };
  return { sessionId: created.session.id, agentId: created.session.leadAgentId };
}

async function send(sessionId: string, text: string): Promise<string> {
  const sent = (await call("chat.send", { sessionId, text })) as { agentTurnId: string };
  await vi.waitFor(() => expect(harness.prompts).toContain(text));
  return sent.agentTurnId;
}

describe("streaming into rows", () => {
  it("upserts one row per block key while the text grows (SPEC R23)", async () => {
    const { sessionId } = await newSession();
    const turnId = await send(sessionId, "hi");

    harness.events.push({ type: "block", key: "msg:1:0", patch: { kind: "text", text: "po" } });
    harness.events.push({ type: "block", key: "msg:1:0", patch: { kind: "text", text: "pong" } });
    harness.events.push({
      type: "block",
      key: "tool:toolu_1",
      patch: {
        kind: "tool_call",
        name: "Read",
        input: { file_path: "a.md" },
        status: "running",
        toolUseId: "toolu_1",
      },
    });
    await vi.waitFor(() => expect(store.blocks.listByTurn(turnId)).toHaveLength(2));

    const rows = store.blocks.listByTurn(turnId);
    expect(rows.map((b) => b.kind)).toEqual(["text", "tool_call"]);
    expect(rows[0]).toMatchObject({ kind: "text", text: "pong", index: 0 });
    expect(rows[1]).toMatchObject({ kind: "tool_call", status: "running", index: 1 });

    // Three events, three broadcasts, but only two rows: the renderer sees the
    // growth and the database keeps one row per block.
    const streamed = (eventsOn("chat.block") as Block[]).filter((b) => b.turnId === turnId);
    expect(streamed.filter((b) => b.kind === "text").map((b) => b.id)).toEqual([
      rows[0]!.id,
      rows[0]!.id,
    ]);

    harness.events.push({ type: "turn", status: "done" });
    harness.events.close();
    await vi.waitFor(() => expect(store.turns.get(turnId)?.status).toBe("done"));
    expect(store.sessions.get(sessionId)?.status).toBe("idle");
  });

  it("records a usage row per usage event (SPEC R23)", async () => {
    const { sessionId, agentId } = await newSession();
    const turnId = await send(sessionId, "hi");

    harness.events.push({
      type: "usage",
      backend: "claude",
      model: "claude-sonnet-5",
      usage: {
        inputTokens: 4,
        outputTokens: 131,
        cacheReadTokens: 37_762,
        cacheCreationTokens: 0,
        costUsd: 0.161,
        costKnown: true,
      },
      byModel: {},
    });
    harness.events.push({ type: "turn", status: "done" });
    harness.events.close();

    await vi.waitFor(() => expect(store.usage.listBySession(sessionId)).toHaveLength(1));
    expect(store.usage.listBySession(sessionId)[0]).toMatchObject({
      agentId,
      turnId,
      backend: "claude",
      model: "claude-sonnet-5",
      inputTokens: 4,
      outputTokens: 131,
      cacheReadTokens: 37_762,
      costKnown: true,
    });
    expect(store.usage.totalsBySession(sessionId).costUsd).toBeCloseTo(0.161, 10);
  });

  it("splits a usage event by model so a sub-agent is not billed to the lead (R23)", async () => {
    const { sessionId } = await newSession();
    const turnId = await send(sessionId, "spawn a sub-agent");

    harness.events.push({
      type: "usage",
      backend: "claude",
      model: "claude-sonnet-5",
      usage: {
        inputTokens: 10,
        outputTokens: 30,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
        costUsd: 0.1,
        costKnown: false,
      },
      byModel: {
        "claude-sonnet-5": {
          inputTokens: 4,
          outputTokens: 10,
          cacheReadTokens: 100,
          cacheCreationTokens: 0,
          costUsd: 0.1,
          costKnown: true,
        },
        "claude-opus-5": {
          inputTokens: 6,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          costKnown: false,
        },
      },
    });
    harness.events.push({ type: "turn", status: "done" });
    harness.events.close();

    await vi.waitFor(() => expect(store.usage.listBySession(sessionId)).toHaveLength(2));
    const rows = store.usage.listBySession(sessionId);
    const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
    expect(byModel["claude-sonnet-5"]).toMatchObject({
      turnId, outputTokens: 10, costUsd: 0.1, costKnown: true,
    });
    expect(byModel["claude-opus-5"]).toMatchObject({
      turnId, outputTokens: 20, costUsd: 0, costKnown: false,
    });
    // The session total still adds up to what the harness reported.
    expect(store.usage.totalsBySession(sessionId).costUsd).toBeCloseTo(0.1, 10);
  });

  it("marks the turn errored and keeps the message when the harness throws", async () => {
    const { sessionId } = await newSession();
    const turnId = await send(sessionId, "hi");
    harness.events.fail(new Error("claude.exe is not signed in"));

    await vi.waitFor(() => expect(store.turns.get(turnId)?.status).toBe("error"));
    const blocks = store.blocks.listByTurn(turnId);
    expect(blocks.at(-1)).toMatchObject({
      kind: "error",
      message: "claude.exe is not signed in",
    });
    expect(store.sessions.get(sessionId)?.status).toBe("error");
  });
});

describe("permission and question round-trips", () => {
  it("broadcasts the request with its block id and delivers the answer", async () => {
    const { sessionId } = await newSession();
    const turnId = await send(sessionId, "run it");

    harness.events.push({
      type: "block",
      key: "permission:toolu_1",
      patch: {
        kind: "permission",
        request: { requestId: "req_1", toolName: "Bash", input: { command: "ls" }, suggestions: [] },
        decision: null,
      },
    });
    harness.events.push({
      type: "permission",
      requestId: "req_1",
      key: "permission:toolu_1",
      request: { requestId: "req_1", toolName: "Bash", input: { command: "ls" }, suggestions: [] },
    });

    await vi.waitFor(() => expect(eventsOn("permission.request")).toHaveLength(1));
    const asked = eventsOn("permission.request")[0] as { blockId: string; turnId: string };
    expect(asked.turnId).toBe(turnId);
    expect(store.blocks.get(asked.blockId)?.kind).toBe("permission");

    expect(
      await call("permission.answer", {
        requestId: "req_1",
        decision: "allow",
        updatedInput: { command: "ls -la" },
      }),
    ).toEqual({ ok: true });
    expect(harness.answers).toEqual([
      { requestId: "req_1", value: { behavior: "allow", updatedInput: { command: "ls -la" } } },
    ]);
    const saved = store.blocks.get(asked.blockId);
    expect(saved?.kind === "permission" && saved.decision?.behavior).toBe("allow");

    // A second answer for the same request has nothing left to unblock, and
    // says so instead of overwriting the decision that did land.
    expect(await call("permission.answer", { requestId: "req_1", decision: "deny" })).toEqual({
      ok: false,
    });
    expect(harness.answers).toHaveLength(1);
    const again = store.blocks.get(asked.blockId);
    expect(again?.kind === "permission" && again.decision?.behavior).toBe("allow");
  });

  it("collapses an allow_always decision to a plain allow for the harness (R28/R32)", async () => {
    const { sessionId } = await newSession();
    await send(sessionId, "run it again");

    harness.events.push({
      type: "block",
      key: "permission:toolu_2",
      patch: {
        kind: "permission",
        request: { requestId: "req_2", toolName: "Bash", input: { command: "ls" }, suggestions: [] },
        decision: null,
      },
    });
    harness.events.push({
      type: "permission",
      requestId: "req_2",
      key: "permission:toolu_2",
      request: { requestId: "req_2", toolName: "Bash", input: { command: "ls" }, suggestions: [] },
    });
    await vi.waitFor(() => expect(eventsOn("permission.request")).toHaveLength(1));
    const asked = eventsOn("permission.request")[0] as { blockId: string };

    expect(
      await call("permission.answer", { requestId: "req_2", decision: "allow_always" }),
    ).toEqual({ ok: true });

    // The harness — which only understands allow/deny — sees a plain allow...
    expect(harness.answers.at(-1)).toEqual({
      requestId: "req_2",
      value: { behavior: "allow" },
    });
    // ...while the persisted decision keeps the full three-way choice and the
    // "always" scope it implies, for the card and a future policy engine.
    const saved = store.blocks.get(asked.blockId);
    expect(saved?.kind === "permission" && saved.decision).toMatchObject({
      behavior: "allow_always",
      scope: "always",
    });
  });

  it("delivers AskUserQuestion answers keyed by question text", async () => {
    const { sessionId } = await newSession();
    await send(sessionId, "ask me");

    const questions = [
      {
        question: "Which colour?",
        multiSelect: false,
        options: [{ label: "Red" }, { label: "Blue" }],
      },
    ];
    harness.events.push({
      type: "block",
      key: "question:toolu_q",
      patch: { kind: "question", requestId: "req_q", questions, answers: null },
    });
    harness.events.push({
      type: "question",
      requestId: "req_q",
      key: "question:toolu_q",
      questions,
    });

    await vi.waitFor(() => expect(eventsOn("question.request")).toHaveLength(1));
    const asked = eventsOn("question.request")[0] as { blockId: string; requestId: string };
    expect(asked.requestId).toBe("req_q");

    await call("question.answer", {
      requestId: "req_q",
      answers: { "Which colour?": "Blue" },
    });
    expect(harness.answers).toEqual([
      { requestId: "req_q", value: { "Which colour?": "Blue" } },
    ]);
    const saved = store.blocks.get(asked.blockId);
    expect(saved?.kind === "question" && saved.answers).toEqual({ "Which colour?": "Blue" });
  });
});

describe("backend session lifecycle", () => {
  it("stores the backend session id and resumes it after a relaunch (R15)", async () => {
    const { sessionId, agentId } = await newSession();
    await send(sessionId, "first");

    harness.events.push({ type: "session", backendSessionId: "sdk-session-1" });
    harness.events.push({ type: "turn", status: "done" });
    harness.events.close();
    await vi.waitFor(() =>
      expect(store.settings.getRaw(backendSessionKey(agentId), null)).toBe("sdk-session-1"),
    );
    expect(seenAgents).toHaveLength(1);
    expect(seenAgents[0]?.resumeSessionId).toBeNull();

    // Relaunch: new context, same database, nothing in memory.
    await ipc.dispose();
    expect(harness.disposed).toBe(1);
    ipc = makeContext();

    await send(sessionId, "second");
    expect(seenAgents).toHaveLength(2);
    expect(seenAgents[1]).toMatchObject({
      agentId,
      model: "claude-opus-4-5",
      resumeSessionId: "sdk-session-1",
      permissionMode: "default",
    });
  });

  it("reuses one harness for a second turn in the same session (SPEC R24)", async () => {
    const { sessionId } = await newSession();
    await send(sessionId, "one");
    harness.events.push({ type: "turn", status: "done" });
    harness.events.close();
    await vi.waitFor(() => expect(store.sessions.get(sessionId)?.status).toBe("idle"));

    await send(sessionId, "two");
    expect(seenAgents).toHaveLength(1);
    expect(harness.prompts).toEqual(["one", "two"]);
  });

  it("routes an interrupt to the harness and settles the turn", async () => {
    const { sessionId } = await newSession();
    const turnId = await send(sessionId, "long job");
    expect(await call("chat.interrupt", { sessionId })).toEqual({ ok: true });
    expect(harness.interrupted).toBe(1);
    await vi.waitFor(() => expect(store.turns.get(turnId)?.status).toBe("interrupted"));
    expect(await call("chat.interrupt", { sessionId })).toEqual({ ok: false });
  });

  it("merges the backend's commands under the built-ins (R14)", async () => {
    const { sessionId } = await newSession();
    harness.commands = [
      { name: "/context", description: "shadowed", source: "backend" },
      { name: "/cockpit:pilot", description: "", source: "plugin" },
    ];
    await send(sessionId, "hi");

    const commands = (await call("chat.listCommands", { sessionId })) as SlashCommand[];
    expect(commands.filter((c) => c.name === "/context")).toHaveLength(1);
    expect(commands.at(-1)).toMatchObject({ name: "/cockpit:pilot", source: "plugin" });
    // Without a session there is no backend to ask.
    expect((await call("chat.listCommands", {})) as SlashCommand[]).toHaveLength(7);
  });
});

describe("one turn per agent, and shutdown", () => {
  it("refuses a second turn while one is streaming and keeps interrupt pointed at the live one", async () => {
    const { sessionId } = await newSession();
    const first = await send(sessionId, "long job");

    // A double Enter, a retried IPC call, or (Phase 4) a second agent: the
    // second send must not evict the entry `interrupt` needs.
    const second = (await call("chat.send", { sessionId, text: "again" })) as {
      agentTurnId: string;
    };
    await vi.waitFor(() =>
      expect(store.turns.get(second.agentTurnId)?.status).toBe("error"),
    );
    expect(harness.prompts).toEqual(["long job"]);
    // The healthy turn is untouched, and so is the session it belongs to.
    expect(store.turns.get(first)?.status).toBe("streaming");
    expect(store.sessions.get(sessionId)?.status).toBe("running");

    expect(await call("chat.interrupt", { sessionId })).toEqual({ ok: true });
    expect(harness.interrupted).toBe(1);
    await vi.waitFor(() => expect(store.turns.get(first)?.status).toBe("interrupted"));
  });

  it("interrupts the harness when the stream itself fails, so it is not left waiting", async () => {
    const { sessionId } = await newSession();
    const turnId = await send(sessionId, "hi");
    harness.events.fail(new Error("BlockSchema.parse: bad row"));

    await vi.waitFor(() => expect(store.turns.get(turnId)?.status).toBe("error"));
    // Nothing is reading the harness's events any more: without this it would
    // sit forever on a `canUseTool` answer nobody can deliver, and every later
    // turn on that agent would fail with "already running a turn".
    await vi.waitFor(() => expect(harness.interrupted).toBe(1));
  });

  it("finishes writing the last turn status before dispose() resolves (shutdown)", async () => {
    const { sessionId } = await newSession();
    const turnId = await send(sessionId, "streaming when the app quits");
    expect(store.turns.get(turnId)?.status).toBe("streaming");

    // `will-quit` closes SQLite straight after this resolves; a turn still
    // `streaming` here is one the next launch shows as running forever.
    await ipc.dispose();
    expect(store.turns.get(turnId)?.status).not.toBe("streaming");
    expect(store.sessions.get(sessionId)?.status).toBe("idle");
  });

  it("flips a turn left streaming by a crash, even with nothing to stop", async () => {
    const { sessionId } = await newSession();
    // What a relaunch sees: a row from a previous process, no engine behind it.
    const orphan = store.turns.create({ sessionId, role: "agent", status: "streaming" });
    expect(await call("chat.interrupt", { sessionId })).toEqual({ ok: true });
    expect(store.turns.get(orphan.id)?.status).toBe("interrupted");
    expect(store.sessions.get(sessionId)?.status).toBe("idle");
  });
});

describe("the echo double", () => {
  it("echoes the prompt back after its delay", async () => {
    const { sessionId } = await newSession();
    const deps: EngineDeps = {
      store,
      broadcast: (channel, payload) => events.push({ channel, payload }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const engine = createStubEngine(deps, 1);
    const turn = store.turns.create({ sessionId, role: "agent", status: "streaming" });
    engine.send({ sessionId, turnId: turn.id, text: "hello" });
    await vi.waitFor(() => expect(store.turns.get(turn.id)?.status).toBe("done"));
    expect(store.blocks.listByTurn(turn.id)[0]).toMatchObject({ text: "echo: hello" });
    engine.dispose();
  });

  it("interrupt cancels the pending reply", async () => {
    const { sessionId } = await newSession();
    const deps: EngineDeps = {
      store,
      broadcast: (channel, payload) => events.push({ channel, payload }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const engine = createStubEngine(deps, 20);
    const turn = store.turns.create({ sessionId, role: "agent", status: "streaming" });
    engine.send({ sessionId, turnId: turn.id, text: "hello" });
    expect(engine.interrupt(sessionId)).toBe(true);
    expect(engine.interrupt(sessionId)).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(store.blocks.listByTurn(turn.id)).toHaveLength(0);
    engine.dispose();
  });
});

/**
 * The default `makeHarness` — the one the app actually runs with. Every other
 * test in this file injects a fake, so this is the only place that proves
 * `agent.backend` reaches `createHarnessForBackend` at all.
 */
describe("the default harness factory", () => {
  const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];

  it("runs an `api` agent on the API harness — not on Claude", async ({ skip }) => {
    // A developer with a real key in the environment would spend money here:
    // with one present the harness would reach the provider instead of
    // stopping at the missing key.
    skip(
      ENV_KEYS.some((name) => Boolean(process.env[name])),
      "an API key is set in this environment; the no-key failure cannot be observed",
    );

    // The proof is the *shape* of the failure. Before the registry, an `api`
    // agent either threw "capygen has no harness for the api backend" or
    // silently answered as Claude; now it reaches capygen's own loop and stops
    // where it should — at the missing key (R21).
    const context = createIpcContext({
      store,
      broadcast: (channel, payload) => events.push({ channel, payload }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pickDirectory: async () => path.join(dir, "project"),
      appInfo: () => ({
        name: "capygen",
        version: "0.1.0",
        electron: "44.2.0",
        chrome: "1",
        node: "24.20.0",
        platform: "win32",
        userDataDir: dir,
        logFile: path.join(dir, "logs", "capygen-desktop.log"),
        dbFile: store.db.file,
      }),
    });
    try {
      const project = store.projects.upsertByPath({ path: path.join(dir, "project") });
      const created = store.sessions.create({
        projectId: project.id,
        mode: "solo",
        agents: [
          {
            name: "api",
            backend: "api",
            model: "claude-sonnet-4-5",
            role: "lead",
            config: { api: { provider: "anthropic", model: "claude-sonnet-4-5" } },
          },
        ],
      });
      const agentTurn = store.turns.create({
        sessionId: created.session.id,
        agentId: created.session.leadAgentId,
        role: "agent",
        status: "streaming",
      });
      context.engine.send({
        sessionId: created.session.id,
        turnId: agentTurn.id,
        agentId: created.session.leadAgentId,
        text: "hi",
      });

      await vi.waitFor(() => expect(store.turns.get(agentTurn.id)?.status).toBe("error"));
      const errors = store.blocks
        .listByTurn(agentTurn.id)
        .filter((b): b is Extract<Block, { kind: "error" }> => b.kind === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/No API key for anthropic/);
      expect(errors[0]!.message).toMatch(/Settings/);
    } finally {
      await context.dispose();
    }
  });
});

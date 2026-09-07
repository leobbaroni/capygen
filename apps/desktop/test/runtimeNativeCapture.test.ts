/**
 * [7-P1 acceptance] Do canonical global settings actually reach the backends?
 *
 * The plan (docs/plans/phase7-runtime-config.md, "Acceptance") is explicit that
 * a layering unit test proves nothing about runtime propagation: what has to be
 * shown is the *captured* Claude SDK option object and the *captured* Codex
 * JSON-RPC request, produced by the shipping path.
 *
 * So this file wires the real thing end to end — `createIpcContext` → the real
 * `SessionRunner` → the real `ClaudeHarness` / `CodexHarness` — and replaces
 * exactly one seam per backend: the SDK's `query` function and the app-server's
 * stdio transport, the same doubles `packages/engine/test` already uses. No
 * permissive recording harness stands in for a backend; every assertion below
 * reads either `ClaudeOptions` as the harness built it, or the JSON-RPC params
 * as the client serialized them.
 *
 * Nothing here spawns a CLI or calls a model, and nothing reads a personal
 * config: the database, the project directory and both backend homes are temp
 * directories this test creates, and the Claude harness is given an explicit
 * `env` so `cleanEnv(process.env)` cannot reach `~/.claude`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { ClaudeHarness, CodexHarness, type Harness, type HarnessAgent } from "@capygen/engine";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type EventChannel,
  type InvokeChannel,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createSessionRunner } from "../src/engine/SessionRunner.js";
import type { EngineDeps } from "../src/engine/types.js";
import {
  initMessage,
  makeFakeSdk,
  resultMessage,
  type FakeSdk,
} from "../../../packages/engine/test/fakeSdk.js";
import {
  createFakeAppServer,
  type FakeAppServer,
  type FakeFrame,
} from "../../../packages/engine/test/codexFakeAppServer.js";
import type { ClaudeOptions } from "../../../packages/engine/src/claude/sdk.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

/** Enough of a `thread/start` answer for the harness to accept the thread. */
const THREAD = { thread: { id: "thr_capture_1" }, model: "gpt-5.1-codex" };
const TURN = { turn: { id: "turn_capture_1" } };

let dir: string;
let projectDir: string;
let claudeHome: string;
let codexHome: string;
let store: CapygenStore;
let ipc: IpcContext;
let sdk: FakeSdk;
/**
 * One fake app-server per harness: disposing a harness closes its transport,
 * and a restarted agent gets a fresh child in production too.
 */
let codexServers: FakeAppServer[];
let builtAgents: HarnessAgent[];

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

/**
 * The real harnesses, with only their outermost I/O seam replaced. This is the
 * whole point of the file: `SessionRunner` still builds the `HarnessAgent` from
 * canonical settings, and each harness still translates that into its own wire
 * shape.
 */
function makeContext(): IpcContext {
  return createIpcContext({
    store,
    broadcast: () => {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    makeEngine: (deps: EngineDeps) =>
      createSessionRunner({
        ...deps,
        makeHarness: (agent): Harness => {
          builtAgents.push(agent);
          if (agent.backend === "codex") {
            const server = newCodexServer();
            return new CodexHarness({
              transport: server.transport,
              requestTimeoutMs: 2_000,
              interruptGraceMs: 10,
            });
          }
          return new ClaudeHarness({
            query: sdk.query,
            // Explicit, owned homes: the harness copies these into
            // `options.env`, so nothing can fall back to a personal config.
            env: {
              CLAUDE_CONFIG_DIR: claudeHome,
              CODEX_HOME: codexHome,
              PATH: "",
            },
          });
        },
      }),
    pickDirectory: async () => projectDir,
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-runtime-capture-"));
  projectDir = path.join(dir, "project");
  claudeHome = path.join(dir, "home-claude");
  codexHome = path.join(dir, "home-codex");
  for (const owned of [projectDir, claudeHome, codexHome, path.join(dir, "data")]) {
    fs.mkdirSync(owned, { recursive: true });
  }
  store = openStore(path.join(dir, "data", "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  sdk = makeFakeSdk();
  codexServers = [];
  builtAgents = [];
  ipc = makeContext();
});

afterEach(async () => {
  sdk.end();
  await ipc.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Set canonical global settings through the shipping IPC surface. */
function newCodexServer(): FakeAppServer {
  const server = createFakeAppServer({
    handlers: {
      initialize: () => ({ codexHome, platformFamily: "windows" }),
      "thread/start": () => THREAD,
      "thread/resume": () => THREAD,
      "turn/start": () => TURN,
      "skills/list": () => ({ data: [] }),
    },
  });
  codexServers.push(server);
  return server;
}

/** The server the newest Codex harness is talking to. */
function codex(): FakeAppServer {
  const server = codexServers.at(-1);
  if (!server) throw new Error("no Codex harness has been built yet");
  return server;
}

async function patchGlobals(backends: Record<string, unknown>): Promise<void> {
  await call("settings.patch", { patch: { backends } });
}

async function newSession(backend: "claude" | "codex", model: string): Promise<{
  sessionId: string;
  agentId: string;
}> {
  const project = (await call("projects.pick", {})) as { id: string };
  const created = (await call("sessions.create", {
    projectId: project.id,
    agents: [{ name: "capy", backend, model, role: "lead" }],
  })) as { session: { id: string; leadAgentId: string } };
  return { sessionId: created.session.id, agentId: created.session.leadAgentId };
}

/** Send a turn and let the Claude fake finish it, so the harness goes idle. */
async function claudeTurn(sessionId: string, text: string): Promise<ClaudeOptions> {
  const before = sdk.calls.length;
  await call("chat.send", { sessionId, text });
  await vi.waitFor(() => expect(sdk.prompts).toContain(text), { timeout: 4_000 });
  if (sdk.calls.length > before) sdk.out.push(initMessage());
  sdk.out.push(resultMessage("ok"));
  await vi.waitFor(
    () =>
      expect(
        store.turns.list(sessionId).filter((turn) => turn.status === "streaming"),
      ).toHaveLength(0),
    { timeout: 4_000 },
  );
  return sdk.options();
}

async function codexTurn(sessionId: string, text: string): Promise<void> {
  // `waitForRequest` resolves for a request already sent, so this counts
  // instead: the turn under test is the one that arrives *after* this send.
  const before = requests("turn/start").length;
  await call("chat.send", { sessionId, text });
  await vi.waitFor(() => expect(requests("turn/start").length).toBeGreaterThan(before), {
    timeout: 4_000,
  });
  codex().notify("turn/completed", {
    threadId: THREAD.thread.id,
    turn: { id: TURN.turn.id, status: "completed", items: [] },
  });
  // The runner only restarts or re-sends once the turn row has settled.
  await vi.waitFor(
    () => expect(store.turns.list(sessionId).filter((t) => t.status === "streaming")).toHaveLength(0),
    { timeout: 4_000 },
  );
}

/** Every JSON-RPC request the client actually wrote, by method. */
function requests(method: string): FakeFrame[] {
  return codexServers.flatMap((server) => server.sent.filter((f) => f.method === method));
}

/**
 * The most recent thread request, whichever kind it was: a restarted harness
 * with a live thread id resumes rather than starting, and `thread/resume`
 * carries the same configuration parameters.
 */
function lastThreadRequest(): FakeFrame | undefined {
  return codexServers
    .flatMap((server) => server.sent)
    .filter((frame) => frame.method === "thread/start" || frame.method === "thread/resume")
    .at(-1);
}

describe("global settings reach the real Claude SDK options", () => {
  it("sends the canonical global effort and permission mode, and nothing else's fields", async () => {
    await patchGlobals({ claude: { effort: "low", permissionMode: "default" } });
    // A Codex opinion exists at the same time and must not travel to Claude.
    await patchGlobals({ codex: { reasoningEffort: "high", approvalPolicy: "never" } });

    const { sessionId } = await newSession("claude", "claude-sonnet-5");
    const options = await claudeTurn(sessionId, "hello");

    expect(options.effort).toBe("low");
    expect(options.permissionMode).toBe("default");
    expect(options.model).toBe("claude-sonnet-5");
    expect(options.cwd).toBe(projectDir);
    // `bypassPermissions` is the only thing that sets this; "default" must not.
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();

    // No Codex field leaked into the Claude request.
    const keys = Object.keys(options);
    expect(keys).not.toContain("approvalPolicy");
    expect(keys).not.toContain("sandbox");
    expect(keys).not.toContain("reasoningEffort");
    expect(JSON.stringify(options.env)).not.toContain("high");

    // The homes the harness passed on are the ones this test owns.
    const env = options.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe(claudeHome);
    expect(env.CODEX_HOME).toBe(codexHome);
  });

  it("lets an explicit per-agent override beat the global default, model included", async () => {
    await patchGlobals({ claude: { effort: "low", permissionMode: "default" } });
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-5");

    const global = await claudeTurn(sessionId, "first");
    expect(global).toMatchObject({ effort: "low", model: "claude-sonnet-5" });

    await call("agents.update", {
      agentId,
      patch: {
        model: "claude-opus-4-5",
        config: { claude: { effort: "high", permissionMode: "bypassPermissions" } },
      },
    });

    const overridden = await claudeTurn(sessionId, "second");
    expect(overridden.effort).toBe("high");
    expect(overridden.model).toBe("claude-opus-4-5");
    expect(overridden.permissionMode).toBe("bypassPermissions");
    expect(overridden.allowDangerouslySkipPermissions).toBe(true);
    // The global opinion is still what it was; the agent simply outranks it.
    expect(store.globalSettings.all().backends.claude.effort).toBe("low");
  });
});

describe("global settings reach the real Codex JSON-RPC requests", () => {
  it("puts the canonical effort, approval policy and sandbox on the wire", async () => {
    await patchGlobals({
      codex: {
        reasoningEffort: "low",
        approvalPolicy: "never",
        sandbox: "read-only",
        model: "gpt-5.1-codex",
      },
    });
    // A Claude opinion exists at the same time and must not travel to Codex.
    await patchGlobals({ claude: { effort: "high", permissionMode: "bypassPermissions" } });

    const { sessionId } = await newSession("codex", "gpt-5.1-codex");
    await codexTurn(sessionId, "hello");

    const started = requests("thread/start").at(0);
    expect(started?.params).toMatchObject({
      cwd: projectDir,
      approvalPolicy: "never",
      sandbox: "read-only",
      approvalsReviewer: "user",
      model: "gpt-5.1-codex",
    });
    // Effort is a per-turn parameter in this protocol, not a thread one.
    expect(requests("turn/start").at(0)?.params).toMatchObject({
      threadId: THREAD.thread.id,
      effort: "low",
    });

    // No Claude field leaked into either Codex request.
    const wire = JSON.stringify([started, requests("turn/start").at(0)]);
    expect(wire).not.toContain("permissionMode");
    expect(wire).not.toContain("bypassPermissions");
    expect(wire).not.toContain("allowDangerouslySkipPermissions");
  });

  it("lets a per-agent Codex override win, model included", async () => {
    await patchGlobals({
      codex: { reasoningEffort: "low", approvalPolicy: "never", sandbox: "read-only" },
    });
    const { sessionId, agentId } = await newSession("codex", "gpt-5.1-codex");
    await codexTurn(sessionId, "first");
    expect(requests("thread/start").at(0)?.params).toMatchObject({ approvalPolicy: "never" });

    await call("agents.update", {
      agentId,
      patch: {
        model: "gpt-5.1-codex-mini",
        config: {
          codex: {
            reasoningEffort: "high",
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
          },
        },
      },
    });

    await codexTurn(sessionId, "second");
    expect(lastThreadRequest()?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5.1-codex-mini",
    });
    expect(requests("turn/start").at(-1)?.params).toMatchObject({ effort: "high" });
  });
});

describe("capture is fixed for a harness lifecycle, and refreshed by a restart", () => {
  it("keeps a live session on the options it started with when globals change", async () => {
    await patchGlobals({ claude: { effort: "low" } });
    const { sessionId } = await newSession("claude", "claude-sonnet-5");
    const first = await claudeTurn(sessionId, "first");
    expect(first.effort).toBe("low");
    const callsAfterStart = sdk.calls.length;

    // A global edit mid-session must not restart anything or rewrite an
    // existing backend session's options.
    await patchGlobals({ claude: { effort: "high" } });
    const second = await claudeTurn(sessionId, "second");

    expect(sdk.calls.length).toBe(callsAfterStart);
    expect(second.effort).toBe("low");
    expect(sdk.calls[0]?.options.effort).toBe("low");
  });

  it("applies new settings once an idle agent's config change restarts its harness", async () => {
    await patchGlobals({ claude: { effort: "low" } });
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-5");
    await claudeTurn(sessionId, "first");
    const before = sdk.calls.length;

    // The agent is idle: its config change disposes the harness now, and the
    // global raised in between is what the replacement must read.
    await patchGlobals({ claude: { effort: "high" } });
    await call("agents.update", { agentId, patch: { config: { claude: {} } } });

    const restarted = await claudeTurn(sessionId, "second");
    expect(sdk.calls.length).toBeGreaterThan(before);
    expect(restarted.effort).toBe("high");
    // The rebuilt harness resumed rather than starting a new backend session.
    expect(restarted.resume).toBe(initMessage().session_id);
    // Two harnesses were built for one agent: the original and the restart.
    expect(builtAgents.filter((agent) => agent.agentId === agentId).length).toBeGreaterThan(1);
  });
});

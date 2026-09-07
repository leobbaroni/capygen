/**
 * [7-P1] Runtime configuration, from the settings row to what a backend is
 * actually handed.
 *
 * The point of these cases is that they assert on the **shipping** path: the
 * agent object the runner captured and gave to `harness.start()`, not a pure
 * helper's return value and not the factory's input. Those two used to disagree
 * — the runner built one child agent for the harness factory and `delegate.ts`
 * built another for the actual start — so a test on either one alone proved
 * nothing about the run.
 *
 * What is pinned here:
 *  - global backend defaults reach Claude, Codex and API options;
 *  - an explicit per-agent override still wins, field by field;
 *  - the capture happens once per harness lifecycle and an edit mid-turn does
 *    not change the running turn's options;
 *  - a model/config edit evicts an idle harness and defers a busy one until the
 *    turn ends, however it ends;
 *  - a delegated child gets the *target* backend's defaults and model, keeps
 *    the parent's explicit section for that backend, and never inherits the
 *    parent's permission mode;
 *  - `agents.runtime` is accurate before the first send, and exposes nothing
 *    but model/effort/permission mode/pending.
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
} from "@capygen/engine";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type AgentRuntimeInfo,
  type Backend,
  type EventChannel,
  type HarnessInfo,
  type InvokeChannel,
  type SlashCommand,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createSessionRunner, backendSessionKey } from "../src/engine/SessionRunner.js";

/** One backend's section of a captured agent's effective config. */
function section(agent: HarnessAgent, backend: Backend): Record<string, unknown> {
  return ((agent.config ?? {}) as Record<string, Record<string, unknown>>)[backend] ?? {};
}

/** The `delegate_task` tool's own `run`, as an `api` agent receives it. */
type ToolRun = (
  input: Record<string, unknown>,
  ctx: {
    cwd: string;
    log: { info: () => void; warn: () => void; error: () => void };
    maxOutputChars: number;
    ask: () => Promise<Record<string, unknown>>;
  },
) => Promise<{ content: string; isError?: boolean }>;

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

/** Records exactly what `start()` was given, per agent id. */
class RecordingHarness implements Harness {
  session: HarnessSession | null = null;
  agent: HarnessAgent | null = null;
  events = new AsyncQueue<EngineEvent>();
  prompts: string[] = [];
  disposed = 0;
  interrupted = 0;
  constructor(readonly backend: Backend) {}

  async start(session: HarnessSession, agent: HarnessAgent): Promise<void> {
    this.session = session;
    this.agent = agent;
    started.push({ backend: this.backend, agent });
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
    return [];
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
  answerPermission(): boolean {
    return true;
  }
  answerQuestion(): boolean {
    return true;
  }
  answerElicitation(): boolean {
    return true;
  }
  backendSessionId(): string | null {
    return null;
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
    this.events.push({ type: "turn", status: "interrupted" });
    this.events.close();
  }
}

const BASE_HARNESSES: HarnessInfo[] = [
  {
    backend: "claude",
    label: "Claude Code",
    available: true,
    models: [
      { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    ],
    defaultModel: "claude-opus-4-5",
    providers: [],
  },
  {
    backend: "codex",
    label: "Codex",
    available: true,
    models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
    defaultModel: "gpt-5-codex",
    providers: [],
  },
  {
    backend: "api",
    label: "API model",
    available: true,
    // Flattened, as the picker sees it: both keyed providers' lists.
    models: [
      { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-mini", label: "GPT-5 mini" },
    ],
    defaultModel: "gpt-5",
    // OpenAI first: this fixture's `api` agents run `gpt-5`, and with no
    // provider selected the first keyed one is what the harness really uses.
    providers: ["openai", "anthropic"],
  },
];

let dir: string;
let store: CapygenStore;
let ipc: IpcContext;
let events: { channel: EventChannel; payload: unknown }[];
/** Every `harness.start()` the runner performed, in order. */
let started: { backend: Backend; agent: HarnessAgent }[];
/** agentId → the harness the factory handed back. */
let harnesses: Map<string, RecordingHarness>;
/** What `harness.list` reports; a case may narrow it. */
let HARNESSES: HarnessInfo[];
/** agentId → the routing wiring the runner built for it. */
let extrasByAgent: Map<string, { extraTools?: readonly { run: ToolRun }[] }>;

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

function harnessFor(agentId: string, backend: Backend): RecordingHarness {
  const existing = harnesses.get(agentId);
  if (existing && existing.backend === backend) return existing;
  const made = new RecordingHarness(backend);
  harnesses.set(agentId, made);
  return made;
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "capygen-runtime-")));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  events = [];
  started = [];
  harnesses = new Map();
  extrasByAgent = new Map();
  HARNESSES = BASE_HARNESSES.map((h) => ({ ...h, models: [...h.models] }));
  ipc = createIpcContext({
    store,
    broadcast: (channel, payload) => events.push({ channel, payload }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    catalogue: () => HARNESSES,
    listHarnesses: async () => HARNESSES,
    // The shipping runner, with only the harness *factory* replaced: the
    // capture, the resolution, the validation and the lifecycle under test are
    // all the real code path. Spreading `deps` is what hands the runner the
    // settings/catalogue/validator `createIpcContext` assembled.
    makeEngine: (engineDeps) =>
      createSessionRunner({
        ...engineDeps,
        makeHarness: (agent, extras) => {
          extrasByAgent.set(agent.agentId, extras as never);
          return harnessFor(agent.agentId, agent.backend);
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
      logFile: path.join(dir, "logs", "capygen.log"),
      dbFile: store.db.file,
    }),
  });
});

afterEach(async () => {
  await ipc.dispose();
  store.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows handle; the OS cleans temp */
  }
});

async function newSession(backend: Backend, model = ""): Promise<{ sessionId: string; agentId: string }> {
  const project = (await call("projects.pick", {})) as { id: string };
  const created = (await call("sessions.create", {
    projectId: project.id,
    agents: [{ name: "capy", backend, model, role: "lead" }],
  })) as { session: { id: string }; agents: { id: string }[] };
  return { sessionId: created.session.id, agentId: created.agents[0]!.id };
}

/**
 * The live harness for an agent, once `start()` has settled and `send()` has
 * taken the prompt. `chat.send` is fire-and-forget and the runner now awaits
 * the full startup before sending, so a test that pushes events the moment the
 * IPC call returns is pushing into the queue `send()` is about to replace.
 */
async function live(agentId: string, prompts = 1): Promise<RecordingHarness> {
  await vi.waitFor(() => expect(harnesses.get(agentId)?.prompts.length).toBe(prompts));
  return harnesses.get(agentId)!;
}

/** Finish the turn a harness is currently running. */
async function finish(
  h: RecordingHarness,
  sessionId: string,
  status: "done" | "error" = "done",
): Promise<void> {
  h.events.push(
    status === "done"
      ? { type: "turn", status: "done" }
      : { type: "turn", status: "error", error: "backend blew up" },
  );
  h.events.close();
  await vi.waitFor(() => expect(store.turns.list(sessionId).at(-1)?.status).toBe(status));
}

function runtimeOf(agentId: string): Promise<AgentRuntimeInfo | null> {
  return call("agents.runtime", { agentId }) as Promise<AgentRuntimeInfo | null>;
}

// ---------------------------------------------------------------------------

describe("global backend defaults reach the backend the runner starts", () => {
  it("carries Claude's effort and permission mode into the started agent", async () => {
    await call("settings.patch", {
      patch: { backends: { claude: { effort: "low", permissionMode: "plan" } } },
    });
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    await call("chat.send", { sessionId, text: "hi" });
    await live(agentId);

    const start = started.at(-1)!;
    expect(start.backend).toBe("claude");
    expect(start.agent.model).toBe("claude-sonnet-4-5");
    expect(start.agent.permissionMode).toBe("plan");
    // `ClaudeHarness` reads `config.claude.effort` — the field it maps to
    // `ClaudeOptions.effort`.
    expect(section(start.agent, "claude").effort).toBe("low");
  });

  it("carries Codex's approval policy, sandbox and reasoning effort", async () => {
    await call("settings.patch", {
      patch: {
        backends: {
          codex: { approvalPolicy: "on-request", sandbox: "read-only", reasoningEffort: "low" },
        },
      },
    });
    const { sessionId, agentId } = await newSession("codex", "gpt-5-codex");
    await call("chat.send", { sessionId, text: "hi" });
    await live(agentId);

    const codex = section(started.at(-1)!.agent, "codex");
    expect(codex).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      reasoningEffort: "low",
    });
    // Codex has no permission mode of its own; nothing is invented for it.
    expect(started.at(-1)!.agent.permissionMode).toBe("default");
  });

  it("carries the API provider and reasoning effort", async () => {
    await call("settings.patch", {
      patch: { backends: { api: { provider: "openai", reasoningEffort: "low" } } },
    });
    const { sessionId, agentId } = await newSession("api", "gpt-5");
    await call("chat.send", { sessionId, text: "hi" });
    await live(agentId);

    const api = section(started.at(-1)!.agent, "api");
    expect(api).toMatchObject({ provider: "openai", reasoningEffort: "low" });
  });

  it("lets an explicit per-agent override win, field by field", async () => {
    await call("settings.patch", {
      patch: { backends: { claude: { effort: "low", permissionMode: "plan" } } },
    });
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    await call("agents.update", {
      agentId,
      // Only the mode is overridden; the global effort must survive.
      patch: { config: { claude: { permissionMode: "acceptEdits" } } },
    });
    await call("chat.send", { sessionId, text: "hi" });
    await live(agentId);

    const agent = started.at(-1)!.agent;
    expect(agent.permissionMode).toBe("acceptEdits");
    expect(section(agent, "claude").effort).toBe("low");
  });

  it("does not carry one backend's permission mode to another", async () => {
    await call("settings.patch", {
      patch: { backends: { claude: { permissionMode: "bypassPermissions" } } },
    });
    const { sessionId, agentId } = await newSession("api", "gpt-5");
    await call("chat.send", { sessionId, text: "hi" });
    await live(agentId);
    expect(started.at(-1)!.agent.permissionMode).toBe("default");
  });
});

describe("the capture is per harness lifecycle", () => {
  it("a global change does not alter a running turn's options", async () => {
    await call("settings.patch", { patch: { backends: { claude: { effort: "low" } } } });
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    await call("chat.send", { sessionId, text: "first" });
    await live(agentId);
    const before = started.length;

    // Mid-turn: the harness is live and the turn has not ended.
    await call("settings.patch", { patch: { backends: { claude: { effort: "high" } } } });
    expect(started).toHaveLength(before);
    expect(
      section(started.at(-1)!.agent, "claude").effort,
    ).toBe("low");
  });

  it("applies a global change to the next harness that is built", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    await call("chat.send", { sessionId, text: "first" });
    // Finish the first turn: a second send on a busy agent is refused, so
    // without this the assertion below would pass for the wrong reason.
    await finish(await live(agentId), sessionId);

    await call("settings.patch", { patch: { backends: { claude: { effort: "high" } } } });
    // A per-agent edit is what rebuilds the harness; the global value is read
    // fresh when it does.
    await call("agents.update", { agentId, patch: { model: "claude-opus-4-5" } });
    harnesses.delete(agentId);
    const before = started.length;
    await call("chat.send", { sessionId, text: "second" });
    // The replacement's `start()` waits for the evicted harness's teardown, so
    // it lands a tick later than the send.
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(before));

    const agent = started.at(-1)!.agent;
    expect(agent.model).toBe("claude-opus-4-5");
    expect(section(agent, "claude").effort).toBe("high");
  });
});

describe("a model or config edit restarts the harness", () => {
  it("evicts an idle harness immediately, keeping the resume id", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    await call("chat.send", { sessionId, text: "hi" });
    const running = await live(agentId);
    await finish(running, sessionId);

    store.settings.setRaw(backendSessionKey(agentId), "sess_keepme");
    await call("agents.update", { agentId, patch: { model: "claude-opus-4-5" } });

    expect(running.disposed).toBe(1);
    // The conversation continues; only the options change.
    expect(store.settings.getRaw(backendSessionKey(agentId), null)).toBe("sess_keepme");
    const runtime = await runtimeOf(agentId);
    expect(runtime?.restartPending).toBe(false);
  });

  it("defers a busy agent and evicts when the turn ends", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    await call("chat.send", { sessionId, text: "hi" });
    const running = await live(agentId);

    await call("agents.update", { agentId, patch: { model: "claude-opus-4-5" } });
    // Still running: the options it is using must not change underneath it.
    expect(running.disposed).toBe(0);
    expect((await runtimeOf(agentId))?.restartPending).toBe(true);
    expect((await runtimeOf(agentId))?.model).toBe("claude-sonnet-4-5");

    running.events.push({ type: "turn", status: "done" });
    running.events.close();
    await vi.waitFor(() => expect(running.disposed).toBe(1));
    expect((await runtimeOf(agentId))?.restartPending).toBe(false);
  });

  it("evicts after a turn that ends in an error, not only a clean one", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    await call("chat.send", { sessionId, text: "hi" });
    const running = await live(agentId);
    await call("agents.update", { agentId, patch: { config: { claude: { effort: "high" } } } });
    expect(running.disposed).toBe(0);

    running.events.push({ type: "turn", status: "error", error: "backend blew up" });
    running.events.close();
    await vi.waitFor(() => expect(running.disposed).toBe(1));
  });

  it("evicts after an interrupt", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    await call("chat.send", { sessionId, text: "hi" });
    const running = await live(agentId);
    await call("agents.update", { agentId, patch: { config: { claude: { effort: "high" } } } });

    await call("chat.interrupt", { sessionId });
    await vi.waitFor(() => expect(running.disposed).toBeGreaterThan(0));
  });

  it("announces the pending state so the UI need not infer it", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    await call("chat.send", { sessionId, text: "hi" });
    await live(agentId);
    events.length = 0;
    await call("agents.update", { agentId, patch: { model: "claude-opus-4-5" } });
    expect(events.filter((e) => e.channel === "agent.runtime").map((e) => e.payload)).toEqual([
      { agentId, restartPending: true },
    ]);
  });
});

describe("agents.runtime", () => {
  it("is accurate before the first send, with no harness at all", async () => {
    await call("settings.patch", {
      patch: { backends: { claude: { effort: "low", permissionMode: "plan" } } },
    });
    const { agentId } = await newSession("claude", "claude-sonnet-4-5");

    const runtime = await runtimeOf(agentId);
    expect(runtime).toMatchObject({
      agentId,
      backend: "claude",
      model: "claude-sonnet-4-5",
      effort: "low",
      permissionMode: "plan",
      restartPending: false,
      running: false,
    });
  });

  it("reads each backend's own effort field, not whichever one is set", async () => {
    await call("settings.patch", {
      patch: { backends: { codex: { reasoningEffort: "low" }, claude: { effort: "high" } } },
    });
    const codex = await newSession("codex", "gpt-5-codex");
    expect((await runtimeOf(codex.agentId))?.effort).toBe("low");
    const claude = await newSession("claude", "claude-sonnet-4-5");
    expect((await runtimeOf(claude.agentId))?.effort).toBe("high");
  });

  it("exposes nothing but the four scalars", async () => {
    const { agentId } = await newSession("claude", "claude-sonnet-4-5");
    expect(Object.keys((await runtimeOf(agentId))!).sort()).toEqual([
      "agentId",
      "backend",
      "effort",
      "model",
      "permissionMode",
      "restartPending",
      "running",
    ]);
  });

  it("is null for an agent that does not exist", async () => {
    expect(await runtimeOf("agt_nope")).toBeNull();
  });
});

describe("a model that cannot run is refused before the backend starts", () => {
  it("refuses at the IPC boundary, before the row is written", async () => {
    const { sessionId } = await newSession("claude", "claude-sonnet-4-5");
    await expect(
      call("agents.add", {
        sessionId,
        backend: "codex",
        model: "claude-opus-4-5",
        displayName: "wrong",
      }),
    ).rejects.toThrow(/claude offers/i);
    expect(store.sessions.agents(sessionId)).toHaveLength(1);
  });

  it("refuses a pre-existing row at dispatch, with a visible error turn and no start", async () => {
    const { sessionId, agentId } = await newSession("codex", "gpt-5-codex");
    // Written straight to the row, as a session stored before the check existed
    // — or one whose catalogue moved under it.
    store.db.run("UPDATE agents SET model = ? WHERE id = ?", "claude-opus-4-5", agentId);
    const before = started.length;

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(store.turns.list(sessionId).at(-1)?.status).toBe("error"));
    // No backend was started, and the reason is on screen as a block.
    expect(started).toHaveLength(before);
    const turn = store.turns.list(sessionId).at(-1)!;
    const text = store.blocks
      .listByTurn(turn.id)
      .map((b) => JSON.stringify(b))
      .join(" ");
    expect(text).toMatch(/claude offers/i);
  });
});

describe("the backend resume id is typed to the backend that issued it", () => {
  it("is not offered to a different backend", async () => {
    const { sessionId, agentId } = await newSession("codex", "gpt-5-codex");
    // A handle from a Claude harness, left over.
    store.settings.setRaw(backendSessionKey(agentId), "claude_sess_1");
    store.settings.setRaw(`engine.backendSession.backend.${agentId}`, "claude");

    await call("chat.send", { sessionId, text: "hi" });
    await live(agentId);
    expect(started.at(-1)!.agent.resumeSessionId).toBeNull();
  });

  it("is offered when it belongs to this backend", async () => {
    const { sessionId, agentId } = await newSession("codex", "gpt-5-codex");
    store.settings.setRaw(backendSessionKey(agentId), "codex_thread_1");
    store.settings.setRaw(`engine.backendSession.backend.${agentId}`, "codex");

    await call("chat.send", { sessionId, text: "hi" });
    await live(agentId);
    expect(started.at(-1)!.agent.resumeSessionId).toBe("codex_thread_1");
  });

  it("trusts an untagged handle from an older build", async () => {
    const { sessionId, agentId } = await newSession("codex", "gpt-5-codex");
    store.settings.setRaw(backendSessionKey(agentId), "codex_thread_old");

    await call("chat.send", { sessionId, text: "hi" });
    await live(agentId);
    expect(started.at(-1)!.agent.resumeSessionId).toBe("codex_thread_old");
  });
});

/**
 * [7-P1] A delegated child runs on the **target** backend's configuration.
 *
 * The runner and `delegate.ts` used to build two separate child agents — one
 * for the harness factory, one for the actual `start()` — and both from the
 * parent, so a Claude parent's permission mode and whole config bag crossed
 * into another backend. There is one child agent now, and these assert on what
 * `start()` received.
 */
describe("delegation resolves the target backend, not the parent", () => {
  async function delegatingSession(
    target: { backend: Backend; model?: string },
    parentConfig?: Record<string, unknown>,
  ): Promise<{ sessionId: string; agentId: string; run: ToolRun }> {
    const project = (await call("projects.pick", {})) as { id: string };
    const created = (await call("sessions.create", {
      projectId: project.id,
      agents: [{ name: "capy", backend: "api", model: "gpt-5", role: "lead" }],
    })) as { session: { id: string }; agents: { id: string }[] };
    const sessionId = created.session.id;
    const agentId = created.agents[0]!.id;
    await call("agents.update", {
      agentId,
      patch: {
        subagentRouting: target,
        ...(parentConfig ? { config: parentConfig } : {}),
      },
    });
    await call("chat.send", { sessionId, text: "delegate this" });
    await live(agentId);
    const extras = extrasByAgent.get(agentId)!;
    return { sessionId, agentId, run: extras.extraTools![0]!.run };
  }

  const ctx = {
    cwd: ".",
    log: { info: () => {}, warn: () => {}, error: () => {} },
    maxOutputChars: 1000,
    ask: async () => ({}),
  };

  it("gives the child the target backend's global defaults and model", async () => {
    await call("settings.patch", {
      patch: {
        backends: {
          // The parent runs `api`, and this is the mode it was granted there.
          api: { permissionMode: "bypassPermissions" },
          // Deliberately *not* the catalogue default, so the canonical value is
          // the only thing that can produce it.
          codex: { reasoningEffort: "low", model: "gpt-5.5-codex" },
        },
      },
    });
    const { run } = await delegatingSession({ backend: "codex" });
    const child = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (started.some((s) => s.agent.agentId.includes("#sub"))) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
    void run({ description: "review", prompt: "look" }, ctx);
    await child;

    const sub = started.find((s) => s.agent.agentId.includes("#sub"))!;
    expect(sub.backend).toBe("codex");
    // The route named no model, so the target's own canonical default is used —
    // not the catalogue fallback, not the parent's, not the app-wide alias.
    expect(sub.agent.model).toBe("gpt-5.5-codex");
    expect(section(sub.agent, "codex").reasoningEffort).toBe("low");
    // The parent's `api` bypass does not cross the backend boundary: the child
    // gets the target backend's own mode, which nobody has loosened.
    expect(sub.agent.permissionMode ?? "default").toBe("default");
    // …and no `api` section travels with it either.
    expect(section(sub.agent, "api")).toEqual({});
  });

  it("keeps the parent's explicit section for the target backend", async () => {
    await call("settings.patch", {
      patch: { backends: { codex: { reasoningEffort: "medium", model: "gpt-5-codex" } } },
    });
    // A Claude-shaped parent that deliberately configures its Codex sub-agents.
    const { run } = await delegatingSession({ backend: "codex" }, {
      codex: { reasoningEffort: "low" },
    });
    void run({ description: "review", prompt: "look" }, ctx);
    await vi.waitFor(() =>
      expect(started.some((s) => s.agent.agentId.includes("#sub"))).toBe(true),
    );

    const sub = started.find((s) => s.agent.agentId.includes("#sub"))!;
    expect(section(sub.agent, "codex").reasoningEffort).toBe("low");
  });

  it("prefers the route's model over the target's default", async () => {
    await call("settings.patch", { patch: { backends: { codex: { model: "gpt-5-codex" } } } });
    const { run } = await delegatingSession({ backend: "codex", model: "gpt-5.5-codex" });
    void run({ description: "review", prompt: "look" }, ctx);
    await vi.waitFor(() =>
      expect(started.some((s) => s.agent.agentId.includes("#sub"))).toBe(true),
    );
    expect(started.find((s) => s.agent.agentId.includes("#sub"))!.agent.model).toBe("gpt-5.5-codex");
  });

  it("returns a failed tool result rather than dispatching an unresolvable child", async () => {
    // Codex is signed out: no canonical model, and no catalogue to fall back
    // on. A child with no model must not be dispatched — Codex would silently
    // take a `config.toml` default capygen cannot see.
    HARNESSES = HARNESSES.map((h) =>
      h.backend === "codex" ? { ...h, models: [], defaultModel: "", providers: [] } : h,
    );
    const { run } = await delegatingSession({ backend: "codex" });
    const before = started.length;
    // The tool's own result shape: a failed `tool_result`, not a dispatch.
    const result = await run({ description: "review", prompt: "look" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no model is configured|no sub-agent was started/i);
    expect(started).toHaveLength(before);
  });
});

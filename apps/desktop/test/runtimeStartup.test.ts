/**
 * [7-P1] The startup boundary, and what the provider is actually asked for.
 *
 * Two halves, both deliberately not using a permissive fake:
 *
 *  - a **strict lifecycle** harness that throws if `send()` arrives before
 *    `start()` has settled, with a delay on both start and dispose so the
 *    ordering is real rather than a microtask coincidence;
 *  - the **real** `ApiHarness` with a captured provider, so the model and
 *    effort that reach a request are the shipping ones. `ApiHarness.start()`
 *    awaits `loadHistory` and only then sets its config, which is exactly the
 *    state `send()` reads first.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import { ApiHarness, AsyncQueue } from "@capygen/engine";
import type {
  EngineEvent,
  Harness,
  HarnessAgent,
  HarnessCapabilities,
  HarnessSession,
  Provider,
  ProviderEvent,
  ProviderRequest,
} from "@capygen/engine";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type Backend,
  type EventChannel,
  type HarnessInfo,
  type InvokeChannel,
  type SlashCommand,
} from "@capygen/shared";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createSessionRunner } from "../src/engine/SessionRunner.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

/** The `delegate_task` tool's own `run`, as an `api`/Claude agent receives it. */
type ToolRun = (
  input: Record<string, unknown>,
  ctx: {
    cwd: string;
    log: { info: () => void; warn: () => void; error: () => void };
    maxOutputChars: number;
    ask: () => Promise<Record<string, unknown>>;
  },
) => Promise<{ content: string; isError?: boolean }>;

/** Resolves when something calls it; the test decides when. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Refuses a `send()` that arrives before `start()` has settled, and takes a
 * controllable amount of time over both start and dispose.
 */
class StrictHarness implements Harness {
  readonly backend: Backend = "claude";
  ready = false;
  startCalls = 0;
  disposeCalls = 0;
  prompts: string[] = [];
  events = new AsyncQueue<EngineEvent>();
  /** Set to a deferred to hold `start()` open. */
  holdStart: { promise: Promise<void>; resolve: () => void } | null = null;
  holdDispose: { promise: Promise<void>; resolve: () => void } | null = null;
  failStart: string | null = null;

  async start(_session: HarnessSession, _agent: HarnessAgent): Promise<void> {
    this.startCalls += 1;
    if (this.holdStart) await this.holdStart.promise;
    if (this.failStart) throw new Error(this.failStart);
    this.ready = true;
  }
  send(input: { turnId: string; text: string }): AsyncIterable<EngineEvent> {
    if (!this.ready) throw new Error("send() before start() settled");
    this.prompts.push(input.text);
    this.events = new AsyncQueue<EngineEvent>();
    return this.events;
  }
  /** False when there is no live turn to stop, as a real backend answers. */
  async interrupt(): Promise<boolean> {
    if (this.prompts.length === 0) return false;
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
      subagents: false,
      resume: true,
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
  answerElicitation(): boolean {
    return true;
  }
  backendSessionId(): string | null {
    return null;
  }
  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.holdDispose) await this.holdDispose.promise;
    this.ready = false;
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
  { backend: "codex", label: "Codex", available: true, models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }], defaultModel: "gpt-5-codex", providers: [] },
  {
    backend: "api",
    label: "API model",
    available: true,
    // Flattened, as the picker sees it: both keyed providers' lists.
    models: [
      { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-mini", label: "GPT-5 mini" },
    ],
    defaultModel: "claude-opus-4-5",
    providers: ["anthropic", "openai"],
  },
];

let dir: string;
let store: CapygenStore;
let ipc: IpcContext;
let events: { channel: EventChannel; payload: unknown }[];
let strict: Map<string, StrictHarness>;
/** Every provider request the real `ApiHarness` issued. */
let requests: ProviderRequest[];
/** Every provider the real `ApiHarness` asked to be created. */
let providersCreated: string[];
/** agentId → the routing wiring the runner built for it. */
let extrasByAgent: Map<string, { extraTools?: readonly { run: ToolRun }[] }>;
/** What `harness.list` reports; a case may narrow it. */
let HARNESSES: HarnessInfo[];
/** Resolves once `loadHistory` has been asked for; held open on demand. */
let holdHistory: { promise: Promise<void>; resolve: () => void } | null;
let historyAsked: number;

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

/** A provider that records the request and answers with one text block. */
function capturingProvider(provider: Provider["provider"]): Provider {
  return {
    provider,
    baseUrl: "https://example.invalid",
    stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      requests.push(request);
      return (async function* (): AsyncIterable<ProviderEvent> {
        yield { type: "content", index: 0, block: { type: "text", text: "ok" } };
        yield {
          type: "usage",
          model: request.model,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        };
        yield { type: "stop", reason: "end_turn" };
      })();
    },
  };
}

function makeContext(useApi: boolean): IpcContext {
  return createIpcContext({
    store,
    broadcast: (channel, payload) => events.push({ channel, payload }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    catalogue: () => HARNESSES,
    listHarnesses: async () => HARNESSES,
    makeEngine: (engineDeps) =>
      createSessionRunner({
        ...engineDeps,
        makeHarness: (agent, extras) => {
          extrasByAgent.set(agent.agentId, extras as never);
          // `useApi` picks the real `ApiHarness` for **`api` agents**; a parent
          // on another backend still gets the strict fake, so a cross-backend
          // delegation captures a genuine provider request for the child.
          if (!useApi || agent.backend !== "api") {
            const made = strict.get(agent.agentId) ?? new StrictHarness();
            strict.set(agent.agentId, made);
            return made;
          }
          // The shipping harness, with only the provider and the key replaced:
          // config resolution, history replay and the request shape are real.
          return new ApiHarness({
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            keys: { getKey: async () => "test-key" },
            createProvider: async (options) => {
              providersCreated.push(options.provider);
              return capturingProvider(options.provider);
            },
            // No MCP discovery here: the scoped resolver is P1-B's, and the
            // legacy loader would read a personal home.
            mcpServers: [],
            loadHistory: async () => {
              historyAsked += 1;
              if (holdHistory) await holdHistory.promise;
              return [];
            },
          }) as unknown as Harness;
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
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "capygen-startup-")));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  events = [];
  strict = new Map();
  requests = [];
  providersCreated = [];
  extrasByAgent = new Map();
  HARNESSES = BASE_HARNESSES.map((h) => ({ ...h, models: [...h.models] }));
  holdHistory = null;
  historyAsked = 0;
}, 30_000);

afterEach(async () => {
  await ipc.dispose();
  store.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows handle */
  }
});

async function newSession(backend: Backend, model: string): Promise<{ sessionId: string; agentId: string }> {
  const project = (await call("projects.pick", {})) as { id: string };
  const created = (await call("sessions.create", {
    projectId: project.id,
    agents: [{ name: "capy", backend, model, role: "lead" }],
  })) as { session: { id: string }; agents: { id: string }[] };
  return { sessionId: created.session.id, agentId: created.agents[0]!.id };
}

function turnStatus(sessionId: string): string | undefined {
  return store.turns.list(sessionId).at(-1)?.status;
}

// ---------------------------------------------------------------------------

describe("a turn never sends before its backend has started", () => {
  beforeEach(() => {
    ipc = makeContext(false);
  });

  it("waits for a slow start instead of sending into an unstarted harness", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    const hold = deferred();
    // Build the harness up front so the hold is in place before the send.
    const h = new StrictHarness();
    h.holdStart = hold;
    strict.set(agentId, h);

    await call("chat.send", { sessionId, text: "hi" });
    // Startup is parked: the harness must not have been asked for anything.
    await vi.waitFor(() => expect(h.startCalls).toBe(1));
    expect(h.prompts).toEqual([]);

    hold.resolve();
    await vi.waitFor(() => expect(h.prompts).toEqual(["hi"]));
  });

  it("reserves the agent before the wait, so a second send is still refused", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    const hold = deferred();
    const h = new StrictHarness();
    h.holdStart = hold;
    strict.set(agentId, h);

    await call("chat.send", { sessionId, text: "first" });
    await vi.waitFor(() => expect(h.startCalls).toBe(1));
    // Mid-startup: the slot is taken even though no stream exists yet.
    await call("chat.send", { sessionId, text: "second" });

    hold.resolve();
    await vi.waitFor(() => expect(h.prompts).toEqual(["first"]));
    // Exactly one start, and the refused turn said why.
    expect(h.startCalls).toBe(1);
    const refused = store.turns
      .list(sessionId)
      .filter((t) => t.role === "agent" && t.status === "error");
    expect(refused.length).toBeGreaterThan(0);
  });

  it("surfaces a start failure as a visible error turn, and starts nothing", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    const h = new StrictHarness();
    h.failStart = "the backend refused to start";
    strict.set(agentId, h);

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(turnStatus(sessionId)).toBe("error"));
    expect(h.prompts).toEqual([]);
    const turn = store.turns.list(sessionId).at(-1)!;
    const text = store.blocks.listByTurn(turn.id).map((b) => JSON.stringify(b)).join(" ");
    expect(text).toMatch(/refused to start/);
  });

  it("does not launch a turn that was cancelled while its backend was starting", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    const hold = deferred();
    const h = new StrictHarness();
    h.holdStart = hold;
    strict.set(agentId, h);

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(h.startCalls).toBe(1));
    await call("chat.interrupt", { sessionId });

    hold.resolve();
    await vi.waitFor(() => expect(turnStatus(sessionId)).toBe("interrupted"));
    // Nothing was ever sent — a late launch after a Stop is the bug this guards.
    expect(h.prompts).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.prompts).toEqual([]);
  });

  it("waits for the previous harness to finish closing before it starts the next", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    const first = new StrictHarness();
    strict.set(agentId, first);
    await call("chat.send", { sessionId, text: "one" });
    await vi.waitFor(() => expect(first.prompts).toEqual(["one"]));
    first.events.push({ type: "turn", status: "done" });
    first.events.close();
    await vi.waitFor(() => expect(turnStatus(sessionId)).toBe("done"));

    // Slow teardown, triggered by a config edit.
    const holdDispose = deferred();
    first.holdDispose = holdDispose;
    const second = new StrictHarness();
    await call("agents.update", { agentId, patch: { model: "claude-opus-4-5" } });
    strict.set(agentId, second);
    expect(first.disposeCalls).toBe(1);

    await call("chat.send", { sessionId, text: "two" });
    // The replacement must not start while the old one still holds the agent.
    await new Promise((r) => setTimeout(r, 30));
    expect(second.startCalls).toBe(0);

    holdDispose.resolve();
    await vi.waitFor(() => expect(second.prompts).toEqual(["two"]));
  });
});

describe("shutdown and cancellation during startup", () => {
  beforeEach(() => {
    ipc = makeContext(false);
  });

  it("neither sends nor writes when a start resolves after dispose", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    const hold = deferred();
    const h = new StrictHarness();
    h.holdStart = hold;
    strict.set(agentId, h);

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(h.startCalls).toBe(1));

    // Shutdown begins while the backend is still starting.
    const shutdown = ipc.dispose();
    hold.resolve();
    await shutdown;

    // Nothing was sent, and the turn row is whatever dispose left — never a
    // write that lands after the caller has closed the database.
    expect(h.prompts).toEqual([]);
    const before = JSON.stringify(store.turns.list(sessionId));
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(store.turns.list(sessionId))).toBe(before);
    // Re-disposing is a no-op; `afterEach` calls it again.
  });

  it("does not start a backend queued behind a teardown once the turn is cancelled", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    const first = new StrictHarness();
    strict.set(agentId, first);
    await call("chat.send", { sessionId, text: "one" });
    await vi.waitFor(() => expect(first.prompts).toEqual(["one"]));
    first.events.push({ type: "turn", status: "done" });
    first.events.close();
    await vi.waitFor(() => expect(turnStatus(sessionId)).toBe("done"));

    const holdDispose = deferred();
    first.holdDispose = holdDispose;
    const second = new StrictHarness();
    await call("agents.update", { agentId, patch: { model: "claude-opus-4-5" } });
    strict.set(agentId, second);

    await call("chat.send", { sessionId, text: "two" });
    // Wait until the turn is genuinely parked on the teardown — cancelling
    // before that would be the round table dropping a *queued* turn, which is a
    // different path and would prove nothing about the start.
    await vi.waitFor(() =>
      expect(store.turns.list(sessionId).at(-1)?.status).toBe("streaming"),
    );
    expect(second.startCalls).toBe(0);
    expect(await ipc.engine.interrupt(sessionId)).toBe(true);

    holdDispose.resolve();
    await vi.waitFor(() => expect(turnStatus(sessionId)).toBe("interrupted"));
    // The backend was never started for a turn nobody is waiting on.
    expect(second.startCalls).toBe(0);
    expect(second.prompts).toEqual([]);
  });

  it("reports a Stop during startup as a successful stop", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    const hold = deferred();
    const h = new StrictHarness();
    h.holdStart = hold;
    strict.set(agentId, h);

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(h.startCalls).toBe(1));
    // The engine's own answer, not the IPC handler's: that also flips stale
    // rows, so `{ok:true}` there would pass even if the stop did nothing.
    // The harness has had no `send`, so its `interrupt()` answers false — the
    // cancellation is the real stop and must be reported as one.
    expect(await ipc.engine.interrupt(sessionId)).toBe(true);

    hold.resolve();
    await vi.waitFor(() => expect(turnStatus(sessionId)).toBe("interrupted"));
  });

  it("disposes a harness whose start failed instead of orphaning it", async () => {
    const { sessionId, agentId } = await newSession("claude", "claude-sonnet-4-5");
    const h = new StrictHarness();
    h.failStart = "boom";
    strict.set(agentId, h);

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(turnStatus(sessionId)).toBe("error"));
    // A partial start can already hold a child process or a pool lease.
    await vi.waitFor(() => expect(h.disposeCalls).toBe(1));

    // …and the next turn builds a fresh one, after that teardown.
    const second = new StrictHarness();
    strict.set(agentId, second);
    await call("chat.send", { sessionId, text: "again" });
    await vi.waitFor(() => expect(second.prompts).toEqual(["again"]));
  });
});

describe("the real ApiHarness receives the resolved configuration", () => {
  beforeEach(() => {
    ipc = makeContext(true);
  });

  it("sends the agent's explicit model, not the global default", async () => {
    // Two distinct ids so the request cannot be mistaken for the other layer.
    await call("settings.patch", { patch: { backends: { api: { model: "claude-opus-4-5" } } } });
    const { sessionId } = await newSession("api", "claude-haiku-4-5");

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.model).toBe("claude-haiku-4-5");
  });

  it("sends the global default when the row's model is the one it resolved to", async () => {
    await call("settings.patch", { patch: { backends: { api: { model: "claude-opus-4-5" } } } });
    const { sessionId } = await newSession("api", "claude-opus-4-5");

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.model).toBe("claude-opus-4-5");
  });

  it("is not overridden by a stale config.api.model", async () => {
    const { sessionId, agentId } = await newSession("api", "claude-haiku-4-5");
    // A leftover section from an older edit; the resolved model still wins.
    await call("agents.update", {
      agentId,
      patch: { config: { api: { provider: "anthropic", model: "claude-opus-4-5" } } },
    });

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.model).toBe("claude-haiku-4-5");
  });

  it("carries the global reasoning effort into the request", async () => {
    await call("settings.patch", { patch: { backends: { api: { reasoningEffort: "low" } } } });
    const { sessionId } = await newSession("api", "claude-haiku-4-5");

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.reasoningEffort).toBe("low");
  });

  it("lets an explicit per-agent effort win over the global one", async () => {
    await call("settings.patch", { patch: { backends: { api: { reasoningEffort: "low" } } } });
    const { sessionId, agentId } = await newSession("api", "claude-haiku-4-5");
    await call("agents.update", {
      agentId,
      patch: {
        config: { api: { provider: "anthropic", model: "claude-haiku-4-5", reasoningEffort: "high" } },
      },
    });

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.reasoningEffort).toBe("high");
  });

  it("waits for the asynchronous history replay before it sends", async () => {
    const hold = deferred();
    holdHistory = hold;
    const { sessionId } = await newSession("api", "claude-haiku-4-5");

    await call("chat.send", { sessionId, text: "hi" });
    // `start()` is parked inside `loadHistory` — the config it sets is not
    // there yet, so no request may have been issued.
    await vi.waitFor(() => expect(historyAsked).toBe(1));
    expect(requests).toEqual([]);

    hold.resolve();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.model).toBe("claude-haiku-4-5");
  });
});

/**
 * [7-P1] The provider an `api` agent runs against is its own choice, and the
 * real harness must honour it over the global default — the provider decides
 * which models are even valid.
 *
 * The *model-resolution* half of this lives in `runtimeConfig.test.ts`, on the
 * delegation path: `AgentSchema.model` is `min(1)`, so an agent row always
 * carries a model and the canonical/catalogue steps are only reachable through
 * a route that omits one. `runtimeApiDelegationCapture.test.ts` also proves
 * those delegated requests through the real API harness and provider boundary.
 */
describe("the real ApiHarness runs against the agent's own provider", () => {
  beforeEach(() => {
    ipc = makeContext(true);
  });

  async function apiSessionWithAgent(
    model: string,
    config: Record<string, unknown>,
  ): Promise<{ sessionId: string; agentId: string }> {
    const project = (await call("projects.pick", {})) as { id: string };
    const created = (await call("sessions.create", {
      projectId: project.id,
      agents: [{ name: "capy", backend: "api", model, role: "lead", config: { api: config } }],
    })) as { session: { id: string }; agents: { id: string }[] };
    return { sessionId: created.session.id, agentId: created.agents[0]!.id };
  }

  async function apiSession(
    model: string,
    config: Record<string, unknown>,
  ): Promise<{ sessionId: string }> {
    return apiSessionWithAgent(model, config);
  }

  it("creates the agent's provider, not the global one", async () => {
    // Global says OpenAI; this agent says Anthropic.
    await call("settings.patch", { patch: { backends: { api: { provider: "openai" } } } });
    const { sessionId } = await apiSession("claude-opus-4-5", { provider: "anthropic" });

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(providersCreated).toEqual(["anthropic"]);
    expect(requests[0]!.model).toBe("claude-opus-4-5");
  });

  it("and the inverse: an OpenAI agent under an Anthropic global", async () => {
    await call("settings.patch", { patch: { backends: { api: { provider: "anthropic" } } } });
    const { sessionId } = await apiSession("gpt-5", { provider: "openai" });

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(providersCreated).toEqual(["openai"]);
    expect(requests[0]!.model).toBe("gpt-5");
  });

  it("falls back to the global provider when the agent names none", async () => {
    await call("settings.patch", { patch: { backends: { api: { provider: "openai" } } } });
    const { sessionId } = await apiSession("gpt-5-mini", {});

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(providersCreated).toEqual(["openai"]);
  });

  it("refuses a model that belongs to another provider before it dispatches", async () => {
    await call("settings.patch", { patch: { backends: { api: { provider: "openai" } } } });
    await expect(apiSession("claude-opus-4-5", { provider: "openai" })).rejects.toThrow(
      /anthropic model.*provider is openai/i,
    );
    expect(providersCreated).toEqual([]);
  });

  it("still allows a custom model behind a custom endpoint", async () => {
    await call("settings.patch", { patch: { backends: { api: { provider: "openai" } } } });
    const { sessionId } = await apiSession("my-org/tuned-v3", {
      provider: "openai",
      baseUrl: "https://gateway.internal/v1",
    });

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.model).toBe("my-org/tuned-v3");
  });

  /**
   * [7-P1] A gateway at a `baseUrl` of its own routinely serves ids from
   * another vendor's catalogue. The curated public lists say nothing about it,
   * so a *known* foreign id there must not be refused either — the previous
   * custom-endpoint case used a novel id and missed exactly this.
   */
  it("allows a known foreign model id at a custom endpoint", async () => {
    await call("settings.patch", { patch: { backends: { api: { provider: "openai" } } } });
    const { sessionId } = await apiSession("claude-opus-4-5", {
      provider: "openai",
      baseUrl: "https://gateway.invalid/v1",
    });

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(providersCreated).toEqual(["openai"]);
    expect(requests[0]!.model).toBe("claude-opus-4-5");
  });

  /**
   * [7-P1] Provider and model have to materialise **together**.
   *
   * With no provider stored anywhere, resolution used the first keyed provider
   * to pick the model but never wrote that provider into the captured config —
   * and `ApiHarness.resolveConfig` defaults an absent `provider` to Anthropic.
   * So an OpenAI-only profile validated `gpt-5` and then sent it to Anthropic.
   */
  it("materialises the fallback provider it resolved the model from", async () => {
    // OpenAI is the only provider with a key, and nothing selects one.
    HARNESSES = HARNESSES.map((h) =>
      h.backend === "api"
        ? {
            ...h,
            models: [
              { id: "gpt-5", label: "GPT-5" },
              { id: "gpt-5-mini", label: "GPT-5 mini" },
            ],
            defaultModel: "gpt-5",
            providers: ["openai" as const],
          }
        : h,
    );
    const { sessionId, agentId } = await apiSessionWithAgent("gpt-5", {});

    await call("chat.send", { sessionId, text: "hi" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    // factory, start and the request all agree on OpenAI.
    expect(providersCreated).toEqual(["openai"]);
    expect(requests[0]!.model).toBe("gpt-5");
    const runtime = (await call("agents.runtime", { agentId })) as { model: string };
    expect(runtime.model).toBe("gpt-5");
  });
});

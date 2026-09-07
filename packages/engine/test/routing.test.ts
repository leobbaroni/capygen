/**
 * Sub-agent routing (SPEC R12): the precedence rule, the two enforcement
 * levers, and — the promise the whole requirement rests on — that every failure
 * lands on "spawn on the inherited model" rather than on a broken turn.
 */
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AsyncQueue } from "../src/asyncQueue.js";
import type {
  EngineEvent,
  Harness,
  HarnessAgent,
  HarnessCapabilities,
  HarnessSession,
} from "../src/harness.js";
import {
  DELEGATE_TASK_TOOL,
  createDelegateMcpServer,
  createDelegateRunner,
  createSubagentRouter,
  delegateTaskTool,
  resolveRoute,
  type SpawnRequest,
} from "../src/index.js";
import type { SlashCommand } from "@capygen/shared";

const PARENT = { backend: "claude" as const, model: "claude-opus-4-5" };

const SESSION: HarnessSession = { sessionId: "ses_1", projectPath: "C:/proj" };
const AGENT: HarnessAgent = {
  agentId: "agent_a",
  name: "Alice",
  backend: "claude",
  model: "claude-opus-4-5",
  permissionMode: "default",
  resumeSessionId: null,
  config: null,
};

const REQUEST: SpawnRequest = {
  sessionId: "ses_1",
  agentId: "agent_a",
  toolName: "Agent",
  description: "count the md files",
  input: {},
};

/** A backend that answers with a fixed script and records how it was started. */
class ScriptedHarness implements Harness {
  started: { session: HarnessSession; agent: HarnessAgent } | null = null;
  prompts: string[] = [];
  disposed = 0;
  constructor(
    readonly backend: "claude" | "codex" | "api",
    private readonly script: (out: AsyncQueue<EngineEvent>) => void,
  ) {}
  async start(session: HarnessSession, agent: HarnessAgent): Promise<void> {
    this.started = { session, agent };
  }
  send(input: { turnId: string; text: string }): AsyncIterable<EngineEvent> {
    this.prompts.push(input.text);
    const out = new AsyncQueue<EngineEvent>();
    this.script(out);
    return out;
  }
  async interrupt(): Promise<boolean> {
    return false;
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
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

describe("resolveRoute precedence (SPEC R12)", () => {
  it("prefers the per-agent override over the session rule", () => {
    const decision = resolveRoute({
      agent: { model: "claude-haiku-4-5" },
      session: { backend: "codex", model: "gpt-5.5" },
      parent: PARENT,
    });
    expect(decision).toEqual({
      backend: "claude",
      model: "claude-haiku-4-5",
      sameBackend: true,
      source: "agent",
    });
  });

  it("falls back to the session rule when the agent has none", () => {
    expect(resolveRoute({ session: { backend: "codex" }, parent: PARENT })).toEqual({
      backend: "codex",
      // A cross-backend route with no model leaves the model to the backend:
      // the parent's Claude model id means nothing to Codex.
      model: "",
      sameBackend: false,
      source: "session",
    });
  });

  it("returns null — inherit — when neither layer says anything", () => {
    expect(resolveRoute({ parent: PARENT })).toBeNull();
    expect(resolveRoute({ agent: {}, session: null, parent: PARENT })).toBeNull();
  });

  it("returns null when the rule names exactly what the parent already runs", () => {
    expect(
      resolveRoute({ agent: { backend: "claude", model: PARENT.model }, parent: PARENT }),
    ).toBeNull();
  });

  it("ignores a malformed rule instead of routing onto garbage", () => {
    const decision = resolveRoute({
      agent: { model: 42 as unknown as string },
      parent: PARENT,
    });
    expect(decision).toBeNull();
  });
});

describe("the Claude hook lever", () => {
  it("rewrites the model for a same-backend route", () => {
    const router = createSubagentRouter({
      route: () => ({
        backend: "claude",
        model: "claude-haiku-4-5",
        sameBackend: true,
        source: "agent",
      }),
    });
    expect(router(REQUEST)).toEqual({ model: "claude-haiku-4-5", backend: "claude" });
  });

  it("refuses to rewrite the model for a cross-backend route", () => {
    // Handing Claude a Codex model id would fail the spawn — the opposite of
    // failing open. Delegation is the cross-backend path.
    const log = { info: vi.fn(), warn: vi.fn() };
    const router = createSubagentRouter({
      route: () => ({ backend: "codex", model: "gpt-5.5", sameBackend: false, source: "session" }),
      log,
    });
    expect(router(REQUEST)).toBeNull();
    expect(log.info).toHaveBeenCalled();
  });

  it("fails open when the policy throws", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const router = createSubagentRouter({
      route: () => {
        throw new Error("settings table is locked");
      },
      log,
    });
    expect(router(REQUEST)).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("delegate_task (SPEC R12, cross-backend)", () => {
  function textScript(text: string) {
    return (out: AsyncQueue<EngineEvent>): void => {
      out.push({ type: "block", key: "msg:0", patch: { kind: "text", text } });
      out.push({
        type: "usage",
        backend: "codex",
        model: "gpt-5.5",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.002,
        },
        byModel: {},
      });
      out.push({ type: "turn", status: "done" });
      out.close();
    };
  }

  it("runs the task on the routed backend and returns its text", async () => {
    const sub = new ScriptedHarness("codex", textScript("6 .md files"));
    const events: EngineEvent[] = [];
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      onEvent: (event) => events.push(event),
    });

    const result = await run({ description: "count files", prompt: "count the .md files" });

    expect(result).toMatchObject({ ok: true, text: "6 .md files", backend: "codex" });
    expect(sub.started?.agent.backend).toBe("codex");
    expect(sub.started?.agent.model).toBe("gpt-5.5");
    expect(sub.started?.session.projectPath).toBe("C:/proj");
    expect(sub.prompts).toEqual(["count the .md files"]);
    expect(sub.disposed).toBe(1);

    // The transcript sees a delegated sub-agent, opened and closed, and the
    // tokens are still billed to the model that spent them (R23).
    const subagents = events.filter(
      (e): e is Extract<EngineEvent, { type: "block" }> =>
        e.type === "block" && e.patch.kind === "subagent",
    );
    expect(subagents.map((e) => (e.patch as { status: string }).status)).toEqual([
      "running",
      "done",
    ]);
    expect(subagents[0]!.patch).toMatchObject({
      delegated: true,
      backend: "codex",
      model: "gpt-5.5",
      parentAgentId: "agent_a",
    });
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("keeps the sub-agent's own blocks out of the parent's key space", async () => {
    const sub = new ScriptedHarness("codex", textScript("ok"));
    const events: EngineEvent[] = [];
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      onEvent: (event) => events.push(event),
    });
    await run({ description: "d", prompt: "p" });
    const keys = events
      .filter((e): e is Extract<EngineEvent, { type: "block" }> => e.type === "block")
      .map((e) => e.key);
    expect(keys.every((k) => k.startsWith("delegate:agent_a:1"))).toBe(true);
  });

  it("fails open when there is no route", async () => {
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => null,
      makeHarness: () => {
        throw new Error("must not be built");
      },
    });
    const result = await run({ description: "d", prompt: "p" });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/no sub-agent routing rule/);
  });

  it("fails open when the routed backend cannot be started", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "api", model: "gpt-5" }),
      makeHarness: () => {
        throw new Error("no API key");
      },
      log,
    });
    const result = await run({ description: "d", prompt: "p" });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/no API key/);
    expect(log.warn).toHaveBeenCalled();
  });

  it("fails open when a route names a backend but no model it could pick", async () => {
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      // `claude` needs an explicit model id; Codex would pick its own default.
      target: () => ({ backend: "claude", model: "" }),
      makeHarness: () => {
        throw new Error("must not be built");
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const result = await run({ description: "d", prompt: "p" });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/no model/);
  });

  it("reports a failed sub-agent turn as a tool error, not as a thrown turn", async () => {
    const sub = new ScriptedHarness("codex", (out) => {
      out.push({ type: "turn", status: "error", error: "codex is not signed in" });
      out.close();
    });
    const tool = delegateTaskTool(
      createDelegateRunner({
        session: SESSION,
        parent: AGENT,
        target: () => ({ backend: "codex", model: "gpt-5.5" }),
        makeHarness: () => sub,
      }),
    );
    const result = await tool.run({ description: "d", prompt: "p" }, {
      cwd: "C:/proj",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxOutputChars: 1000,
      ask: async () => ({}),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/codex is not signed in/);
  });

  it("exposes the same tool to the api backend, refusing an empty prompt", async () => {
    const tool = delegateTaskTool(async () => ({ ok: true, text: "never reached" }));
    expect(tool.name).toBe(DELEGATE_TASK_TOOL);
    expect(tool.permissionClass).toBe("execute");
    const result = await tool.run({ description: "d", prompt: "" }, {
      cwd: "C:/proj",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxOutputChars: 1000,
      ask: async () => ({}),
    });
    expect(result.isError).toBe(true);
  });
});

describe("the Claude in-process MCP server", () => {
  it("builds one server named capygen carrying delegate_task", async () => {
    const tools: unknown[] = [];
    const servers = await createDelegateMcpServer({
      run: async () => ({ ok: true, text: "hi" }),
      loadSdk: async () => ({
        tool: (name, description, schema, handler) => {
          tools.push({ name, description, schema, handler });
          return { name };
        },
        createSdkMcpServer: (options) => ({ kind: "sdk-server", ...options }),
      }),
    });
    expect(Object.keys(servers ?? {})).toEqual(["capygen"]);
    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe(DELEGATE_TASK_TOOL);
  });

  it("returns null rather than failing the session when the SDK has no such API", async () => {
    const log = { warn: vi.fn() };
    const servers = await createDelegateMcpServer({
      run: async () => ({ ok: true, text: "hi" }),
      loadSdk: async () => {
        throw new Error("createSdkMcpServer is not a function");
      },
      log,
    });
    expect(servers).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("a delegated turn is bounded and interruptible (SPEC R12/R23/R25)", () => {
  function textScript(text: string) {
    return (out: AsyncQueue<EngineEvent>): void => {
      out.push({ type: "block", key: "msg:0", patch: { kind: "text", text } });
      out.push({ type: "turn", status: "done" });
      out.close();
    };
  }

  it("clamps the answer it hands back — it becomes a tool_result the caller re-sends", async () => {
    const huge = "x".repeat(300_000);
    const sub = new ScriptedHarness("codex", textScript(huge));
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      maxResultChars: 1_000,
    });
    const result = await run({ description: "dump", prompt: "p" });
    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThan(1_200);
    expect(result.text).toMatch(/more characters \(truncated\)/);
  });

  it("honours the calling tool runtime's own budget as every other tool does", async () => {
    const tool = delegateTaskTool(async () => ({ ok: true, text: "y".repeat(5_000) }));
    const result = await tool.run({ description: "d", prompt: "p" }, {
      cwd: "C:/proj",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxOutputChars: 100,
      ask: async () => ({}),
    });
    expect(result.content.length).toBeLessThan(200);
    expect(result.truncated).toBe(true);
    expect(result.fullOutput).toHaveLength(5_000);
  });

  it("marks every forwarded block with the sub-agent it came from", async () => {
    const sub = new ScriptedHarness("codex", textScript("the sub-agent's answer"));
    const events: EngineEvent[] = [];
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      onEvent: (event) => events.push(event),
    });
    await run({ description: "review the parser", prompt: "p" });

    const texts = events.filter(
      (e): e is Extract<EngineEvent, { type: "block" }> =>
        e.type === "block" && e.patch.kind === "text",
    );
    expect(texts).toHaveLength(1);
    // Without this the block is indistinguishable from the parent's own words,
    // in the transcript and in `RoundTable.textOfTurn` alike.
    expect(texts[0]!.patch).toMatchObject({ delegatedFrom: "review the parser" });
  });

  it("hands the child harness out so a Stop can reach it, and takes it back after", async () => {
    const seen: Harness[] = [];
    let released = 0;
    const sub = new ScriptedHarness("codex", textScript("ok"));
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      onHarness: (harness) => {
        seen.push(harness);
        return () => {
          released += 1;
        };
      },
    });
    await run({ description: "d", prompt: "p" });
    expect(seen).toEqual([sub]);
    expect(released).toBe(1);
  });
});

describe("delegate_task cancellation reaches the child (SPEC R12, R27)", () => {
  /** A child that never finishes on its own, and only stops when told. */
  class StubbornHarness extends ScriptedHarness {
    interrupts = 0;
    private out: AsyncQueue<EngineEvent> | null = null;
    /** When false, `interrupt()` is accepted but changes nothing — a backend
     *  that ignores the request, which is what `dispose()` has to cover. */
    constructor(readonly obeysInterrupt: boolean) {
      super("codex", () => {});
    }
    override send(): AsyncIterable<EngineEvent> {
      this.out = new AsyncQueue<EngineEvent>();
      return this.out;
    }
    override async interrupt(): Promise<boolean> {
      this.interrupts += 1;
      if (this.obeysInterrupt) {
        this.out?.push({ type: "turn", status: "interrupted" });
        this.out?.close();
      }
      return true;
    }
    override async dispose(): Promise<void> {
      this.disposed += 1;
      this.out?.close();
    }
  }

  function runnerFor(sub: StubbornHarness, released: { count: number }) {
    return createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      onHarness: () => () => {
        released.count += 1;
      },
      abortGraceMs: 20,
    });
  }

  it("interrupts and disposes the child when the caller's signal aborts", async () => {
    const sub = new StubbornHarness(true);
    const released = { count: 0 };
    const abort = new AbortController();
    const pending = runnerFor(sub, released)({
      description: "d",
      prompt: "p",
      signal: abort.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    const result = await pending;
    expect(sub.interrupts).toBe(1);
    expect(sub.disposed).toBe(1);
    expect(released.count).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("still disposes a child whose backend ignores the interrupt", async () => {
    const sub = new StubbornHarness(false);
    const released = { count: 0 };
    const abort = new AbortController();
    const pending = runnerFor(sub, released)({
      description: "d",
      prompt: "p",
      signal: abort.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    const result = await pending;
    expect(sub.interrupts).toBe(1);
    // No detached billing: the child is torn down even though it never
    // acknowledged the interrupt.
    expect(sub.disposed).toBe(1);
    expect(released.count).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("does not touch a child when a different call's signal aborts", async () => {
    const first = new StubbornHarness(true);
    const second = new StubbornHarness(true);
    const released = { count: 0 };
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const runFirst = runnerFor(first, released);
    const runSecond = runnerFor(second, released);
    const a = runFirst({ description: "a", prompt: "a", signal: firstAbort.signal });
    const b = runSecond({ description: "b", prompt: "b", signal: secondAbort.signal });
    await new Promise((r) => setTimeout(r, 10));
    firstAbort.abort();
    await a;
    expect(first.interrupts).toBe(1);
    expect(second.interrupts).toBe(0);
    expect(second.disposed).toBe(0);
    secondAbort.abort();
    await b;
    expect(second.interrupts).toBe(1);
  });

  it("delegateTaskTool hands the tool context's signal to the runner", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const tool = delegateTaskTool(async (req) => {
      seen.push(req.signal);
      return { ok: true, text: "done" };
    });
    const abort = new AbortController();
    await tool.run(
      { description: "d", prompt: "p" },
      {
        cwd: "C:/proj",
        signal: abort.signal,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        maxOutputChars: 1000,
        ask: async () => ({}),
      },
    );
    expect(seen).toEqual([abort.signal]);
  });
});

describe("a cancelled delegation never reaches a live child", () => {
  class SlowStartHarness extends ScriptedHarness {
    interrupts = 0;
    sends = 0;
    startResolved = false;
    private out: AsyncQueue<EngineEvent> | null = null;
    constructor(private readonly startGate: Promise<void>) {
      super("codex", () => {});
    }
    override async start(): Promise<void> {
      await this.startGate;
      this.startResolved = true;
    }
    override send(): AsyncIterable<EngineEvent> {
      this.sends += 1;
      this.out = new AsyncQueue<EngineEvent>();
      return this.out;
    }
    override async interrupt(): Promise<boolean> {
      this.interrupts += 1;
      return true;
    }
    override async dispose(): Promise<void> {
      this.disposed += 1;
      this.out?.close();
    }
  }

  it("builds no child at all when the signal is already aborted", async () => {
    const factory = vi.fn(() => new ScriptedHarness("codex", () => {}));
    const abort = new AbortController();
    abort.abort();
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: factory,
      abortGraceMs: 20,
    });
    const result = await run({ description: "d", prompt: "p", signal: abort.signal });
    expect(result.ok).toBe(false);
    // Nothing was constructed, so nothing has to be torn down.
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not send when the abort lands while start() is still running", async () => {
    let openStart: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openStart = resolve;
    });
    const sub = new SlowStartHarness(gate);
    const released = { count: 0 };
    const abort = new AbortController();
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      onHarness: () => () => {
        released.count += 1;
      },
      abortGraceMs: 20,
    });
    const pending = run({ description: "d", prompt: "p", signal: abort.signal });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    const result = await pending;
    // start() only finishes after the caller gave up; the turn must not follow.
    openStart!();
    await new Promise((r) => setTimeout(r, 20));
    expect(sub.startResolved).toBe(true);
    expect(sub.sends).toBe(0);
    expect(sub.disposed).toBeGreaterThan(0);
    expect(released.count).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("tears down and answers when start() never resolves at all", async () => {
    const sub = new SlowStartHarness(new Promise<void>(() => {}));
    const released = { count: 0 };
    const abort = new AbortController();
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      onHarness: () => () => {
        released.count += 1;
      },
      abortGraceMs: 20,
    });
    const pending = run({ description: "d", prompt: "p", signal: abort.signal });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(sub.sends).toBe(0);
    expect(sub.disposed).toBeGreaterThan(0);
    // No dead child retained in the caller's registry.
    expect(released.count).toBe(1);
  });
});

describe("a delegated call is bounded even when the child ignores everything", () => {
  /** Ignores interrupt, ignores dispose, and never yields or ends. */
  class WedgedHarness extends ScriptedHarness {
    interrupts = 0;
    disposeCalls = 0;
    returnCalls = 0;
    lateEmits = 0;
    private push: ((event: EngineEvent) => void) | null = null;
    constructor(private readonly hangDispose = false) {
      super("codex", () => {});
    }
    override send(): AsyncIterable<EngineEvent> {
      const self = this;
      return {
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          return {
            next(): Promise<IteratorResult<EngineEvent>> {
              return new Promise((resolve) => {
                self.push = (event) => {
                  self.lateEmits += 1;
                  resolve({ value: event, done: false });
                };
              });
            },
            return(): Promise<IteratorResult<EngineEvent>> {
              self.returnCalls += 1;
              return new Promise(() => {}); // even the cleanup hangs
            },
          };
        },
      };
    }
    override async interrupt(): Promise<boolean> {
      this.interrupts += 1;
      return true;
    }
    override async dispose(): Promise<void> {
      this.disposeCalls += 1;
      if (this.hangDispose) await new Promise(() => {});
    }
    /** Whatever the abandoned child eventually produces. */
    emitLate(event: EngineEvent): void {
      this.push?.(event);
    }
  }

  function runnerFor(sub: WedgedHarness, released: { count: number }, events: EngineEvent[]) {
    return createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      onEvent: (event) => events.push(event),
      onHarness: () => () => {
        released.count += 1;
      },
      abortGraceMs: 20,
    });
  }

  it("answers in bounded time when the send iterator never yields or ends", async () => {
    const sub = new WedgedHarness();
    const released = { count: 0 };
    const events: EngineEvent[] = [];
    const abort = new AbortController();
    const started = Date.now();
    const pending = runnerFor(sub, released, events)({
      description: "d",
      prompt: "p",
      signal: abort.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.ok).toBe(false);
    expect(released.count).toBe(1);
  });

  it("releases the registry even when dispose() itself hangs", async () => {
    const sub = new WedgedHarness(true);
    const released = { count: 0 };
    const events: EngineEvent[] = [];
    const abort = new AbortController();
    const started = Date.now();
    const pending = runnerFor(sub, released, events)({
      description: "d",
      prompt: "p",
      signal: abort.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    const result = await pending;
    // A wedged teardown must not hold the caller — or the registry slot.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(sub.disposeCalls).toBeGreaterThan(0);
    expect(released.count).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("emits nothing from a child that produces output after it was abandoned", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const sub = new WedgedHarness();
      const released = { count: 0 };
      const events: EngineEvent[] = [];
      const abort = new AbortController();
      const pending = runnerFor(sub, released, events)({
        description: "d",
        prompt: "p",
        signal: abort.signal,
      });
      await new Promise((r) => setTimeout(r, 10));
      abort.abort();
      await pending;
      const before = events.length;
      sub.emitLate({ type: "block", key: "msg:late", patch: { kind: "text", text: "too late" } });
      await new Promise((r) => setTimeout(r, 50));
      expect(events.length).toBe(before);
      expect(JSON.stringify(events)).not.toContain("too late");
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("leaves no abort listener behind on an ordinary completed call", async () => {
    const sub = new ScriptedHarness("codex", (out) => {
      out.push({ type: "block", key: "msg:0", patch: { kind: "text", text: "fine" } });
      out.push({ type: "turn", status: "done" });
      out.close();
    });
    const abort = new AbortController();
    const run = createDelegateRunner({
      session: SESSION,
      parent: AGENT,
      target: () => ({ backend: "codex", model: "gpt-5.5" }),
      makeHarness: () => sub,
      abortGraceMs: 20,
    });
    const result = await run({ description: "d", prompt: "p", signal: abort.signal });
    expect(result.ok).toBe(true);
    // A listener left on a long-lived signal is a leak: the parent turn's
    // signal outlives many delegated calls.
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });
});

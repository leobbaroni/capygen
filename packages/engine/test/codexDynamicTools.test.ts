/**
 * The Codex dynamic-tools bridge (Phase 9 prerequisite).
 *
 * `codex app-server` 0.153.4 lets a *client* lend the model tools: they are
 * declared once on `thread/start` as `dynamicTools: DynamicToolSpec[]`, and a
 * call arrives as the server→client request `item/tool/call`
 * (`ServerRequest.ts:20`, `v2/DynamicToolCallParams.ts`), answered with
 * `{contentItems, success}` (`v2/DynamicToolCallResponse.ts`). That is the only
 * mechanism by which a Codex lead could ever reach capygen's `delegate_task`
 * without editing the user's `config.toml`, which ADR-0004 forbids.
 *
 * Everything asserted here is transport-level and synthetic: no model runs, no
 * token is spent, and passing this proves capygen speaks the protocol — **not**
 * that a live model chooses to call the tool. That remains unproven (see
 * `scripts/probe-codex-dynamic-tools.ts` for the no-model schema-acceptance
 * probe, which is also not proof of live tool choice).
 */
import { describe, expect, it, vi } from "vitest";
import { CodexHarness, type CodexHarnessDeps } from "../src/codex/CodexHarness.js";
import type { EngineEvent, HarnessAgent, HarnessSession, PermissionAnswer } from "../src/harness.js";
import type { ToolDefinition } from "../src/tools/types.js";
import { createFakeAppServer, settle, type FakeFrame } from "./codexFakeAppServer.js";

const SESSION: HarnessSession = { sessionId: "ses_dyn", projectPath: "C:\\capygen" };
const AGENT: HarnessAgent = {
  agentId: "agent_dyn",
  name: "codex",
  backend: "codex",
  model: "gpt-5.6-luna",
  config: { codex: { reasoningEffort: "low" } },
};
const THREAD = { thread: { id: "thread_dyn" } };
const TURN = { turn: { id: "turn_dyn", status: "inProgress" } };

type CodexHarnessStore = NonNullable<CodexHarnessDeps["storeDynamicToolOutput"]>;

interface CallResponse {
  contentItems: { type: string; text?: string }[];
  success: boolean;
}

function textOf(response: unknown): string {
  const items = (response as CallResponse).contentItems;
  return items.map((item) => item.text ?? "").join("");
}

/** A `delegate_task`-shaped tool definition — the adapter shape the api backend
 *  already uses (`routing/delegate.ts` `delegateTaskTool`). */
function echoTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "delegate_task",
    description: "Run one task on another model through capygen.",
    permissionClass: "execute",
    family: "task",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    },
    run: async (input) => ({ content: `ran:${String(input.prompt ?? "")}` }),
    ...overrides,
  };
}

async function rig(
  tools: ToolDefinition[] | undefined,
  opts: { resumeId?: string; permissionMode?: HarnessAgent["permissionMode"] } = {},
) {
  const log = vi.fn();
  const server = createFakeAppServer({
    handlers: {
      initialize: () => ({}),
      "thread/start": () => THREAD,
      "thread/resume": () => THREAD,
      "skills/list": () => ({ data: [] }),
      "turn/start": () => TURN,
    },
  });
  const harness = new CodexHarness({
    transport: server.transport,
    log: { info: log, warn: log, error: log },
    ...(tools ? { dynamicTools: tools } : {}),
  });
  await harness.start(SESSION, {
    ...AGENT,
    ...(opts.resumeId ? { resumeSessionId: opts.resumeId } : {}),
    // `bypassPermissions` by default: the gate is asserted explicitly by the
    // permission tests, and every other test is about the transport.
    permissionMode: opts.permissionMode ?? "bypassPermissions",
  });
  const events: EngineEvent[] = [];
  const done = (async () => {
    for await (const event of harness.send({ turnId: "turn_row", text: "go" })) events.push(event);
  })();
  await server.waitForRequest("turn/start");
  await settle();
  return { server, harness, events, done, log };
}

function finish(server: ReturnType<typeof createFakeAppServer>): void {
  server.notify("turn/completed", {
    threadId: "thread_dyn",
    turn: { ...TURN.turn, status: "completed", items: [] },
  });
}

function call(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: "thread_dyn",
    turnId: "turn_dyn",
    callId: "call_1",
    namespace: null,
    tool: "delegate_task",
    arguments: { prompt: "hello" },
    ...overrides,
  };
}

function startFrame(server: ReturnType<typeof createFakeAppServer>, method: string): FakeFrame {
  const frame = server.sent.find((f) => f.method === method);
  if (!frame) throw new Error(`no ${method} frame was sent`);
  return frame;
}

describe("CodexHarness dynamic tools — declaration", () => {
  it("declares each tool on thread/start as a function spec carrying its JSON Schema", async () => {
    const { server, harness, done } = await rig([echoTool()]);
    const params = startFrame(server, "thread/start").params as Record<string, unknown>;
    expect(params.dynamicTools).toEqual([
      {
        type: "function",
        name: "delegate_task",
        description: "Run one task on another model through capygen.",
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    ]);
    expect(harness.dynamicToolsActive()).toBe(true);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("sends no dynamicTools key at all when the harness was given none", async () => {
    const { server, harness, done } = await rig(undefined);
    const params = startFrame(server, "thread/start").params as Record<string, unknown>;
    expect(params).not.toHaveProperty("dynamicTools");
    expect(harness.dynamicToolsActive()).toBe(false);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("sends no dynamicTools on thread/resume but keeps serving the set the thread already has", async () => {
    // The pinned binary persists the set declared at thread/start and restores
    // it on resume, including in a fresh app-server process
    // (scripts/probe-codex-dynamic-tools.ts, legs 2 and 3). Switching the
    // executors off here would refuse a call the thread is entitled to make.
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done, log } = await rig([echoTool({ run })], {
      resumeId: "thread_dyn",
    });
    const params = startFrame(server, "thread/resume").params as Record<string, unknown>;
    expect(params).not.toHaveProperty("dynamicTools");
    expect(harness.dynamicToolsActive()).toBe(true);
    expect(log.mock.calls.flat().join(" ")).toMatch(/cannot be changed on resume/i);
    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(response.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("still refuses a call for a name it no longer hosts on a resumed thread", async () => {
    const { server, harness, done } = await rig([echoTool()], { resumeId: "thread_dyn" });
    const response = (await server.ask(
      "item/tool/call",
      call({ tool: "a_tool_from_an_older_configuration" }),
    )) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response)).toMatch(/unknown_tool/);
    finish(server);
    await done;
    await harness.dispose();
  });
});

describe("CodexHarness dynamic tools — item/tool/call", () => {
  it("runs the tool and answers the real DynamicToolCallResponse schema", async () => {
    const run = vi.fn(async (input: Record<string, unknown>) => ({
      content: `ran:${String(input.prompt ?? "")}`,
    }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    const response = await server.ask("item/tool/call", call());
    expect(response).toEqual({
      contentItems: [{ type: "inputText", text: "ran:hello" }],
      success: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("reports a tool that failed as success:false without throwing at the transport", async () => {
    const { server, harness, done } = await rig([
      echoTool({ run: async () => ({ content: "no route", isError: true }) }),
    ]);
    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response)).toContain("no route");
    finish(server);
    await done;
    await harness.dispose();
  });

  it("turns a thrown tool into a generic coded failure that leaks no exception text", async () => {
    const log = vi.fn();
    const secret = "sk-live-DEADBEEF-not-for-the-model";
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/start": () => THREAD,
        "skills/list": () => ({ data: [] }),
        "turn/start": () => TURN,
      },
    });
    const harness = new CodexHarness({
      transport: server.transport,
      log: { info: log, warn: log, error: log },
      dynamicTools: [
        echoTool({
          run: async () => {
            throw new Error(`connect failed using ${secret}`);
          },
        }),
      ],
    });
    await harness.start(SESSION, { ...AGENT, permissionMode: "bypassPermissions" });
    const done = (async () => {
      for await (const _ of harness.send({ turnId: "turn_row", text: "go" })) void _;
    })();
    await server.waitForRequest("turn/start");
    await settle();

    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response)).toMatch(/tool_error/);
    expect(textOf(response)).not.toContain(secret);
    expect(textOf(response)).not.toContain("connect failed");
    expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
    expect(log.mock.calls.flat().join(" ")).not.toContain("connect failed");
    finish(server);
    await done;
    await harness.dispose();
  });

  it("refuses an unknown tool name and a namespaced call without running anything", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    const unknown = (await server.ask("item/tool/call", call({ tool: "nope" }))) as CallResponse;
    const namespaced = (await server.ask(
      "item/tool/call",
      call({ callId: "call_2", namespace: "capygen" }),
    )) as CallResponse;
    expect(unknown.success).toBe(false);
    expect(textOf(unknown)).toMatch(/unknown_tool/);
    expect(namespaced.success).toBe(false);
    expect(textOf(namespaced)).toMatch(/namespace_unsupported/);
    expect(run).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });

  it("refuses malformed arguments and a missing callId", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    const badArgs = (await server.ask(
      "item/tool/call",
      call({ arguments: "not-an-object" }),
    )) as CallResponse;
    const noId = (await server.ask("item/tool/call", call({ callId: "" }))) as CallResponse;
    expect(badArgs.success).toBe(false);
    expect(noId.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });

  it("refuses a call naming another thread or a turn that is not the active one", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    const foreign = (await server.ask(
      "item/tool/call",
      call({ threadId: "other_thread" }),
    )) as CallResponse;
    const stale = (await server.ask(
      "item/tool/call",
      call({ callId: "call_2", turnId: "turn_old" }),
    )) as CallResponse;
    expect(foreign.success).toBe(false);
    expect(textOf(foreign)).toMatch(/wrong_thread/);
    expect(stale.success).toBe(false);
    expect(textOf(stale)).toMatch(/wrong_turn/);
    expect(run).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });

  it("refuses a call that arrives after the turn has settled", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    finish(server);
    await done;
    const late = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(late.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
    await harness.dispose();
  });

  it("executes a repeated callId exactly once and refuses the duplicate", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    const first = (await server.ask("item/tool/call", call())) as CallResponse;
    const second = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(textOf(second)).toMatch(/duplicate_call/);
    expect(run).toHaveBeenCalledTimes(1);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("refuses a duplicate that arrives while the first call is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      await gate;
      return { content: "ran" };
    });
    const { server, harness, done } = await rig([echoTool({ run })]);
    const first = server.ask("item/tool/call", call());
    await settle();
    const second = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(second.success).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    expect((await first) as CallResponse).toMatchObject({ success: true });
    finish(server);
    await done;
    await harness.dispose();
  });
});

describe("CodexHarness dynamic tools — cancellation", () => {
  it("aborts an in-flight call on interrupt and answers it rather than hanging", async () => {
    const run = vi.fn(
      (_input: Record<string, unknown>, ctx: { signal?: AbortSignal }) =>
        new Promise<{ content: string }>((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { server, harness, done } = await rig([echoTool({ run: run as ToolDefinition["run"] })]);
    const pending = server.ask("item/tool/call", call());
    await settle();
    await harness.interrupt();
    const response = (await pending) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response)).toMatch(/cancel|interrupt/i);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("aborts an in-flight call on dispose and answers it rather than hanging", async () => {
    const run = vi.fn(
      (_input: Record<string, unknown>, ctx: { signal?: AbortSignal }) =>
        new Promise<{ content: string }>((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { server, harness } = await rig([echoTool({ run: run as ToolDefinition["run"] })]);
    const pending = server.ask("item/tool/call", call());
    await settle();
    await harness.dispose();
    const response = (await pending) as CallResponse;
    expect(response.success).toBe(false);
  });
});

describe("CodexHarness dynamic tools — ordinary behaviour is preserved", () => {
  it("still declines a server request it does not implement", async () => {
    const { server, harness, done } = await rig([echoTool()]);
    await expect(server.ask("account/chatgptAuthTokens/refresh", {})).rejects.toThrow(
      /does not handle/i,
    );
    finish(server);
    await done;
    await harness.dispose();
  });

  it("refuses every call when the harness advertises no tools", async () => {
    const { server, harness, done } = await rig(undefined);
    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(response.success).toBe(false);
    finish(server);
    await done;
    await harness.dispose();
  });
});

// ---------------------------------------------------------------------------
// Root review round 1 — the seven findings
// ---------------------------------------------------------------------------

describe("CodexHarness dynamic tools — one validated tool set (finding 1)", () => {
  it("declares and executes the same tool when two definitions share a name", async () => {
    const first = vi.fn(async () => ({ content: "first" }));
    const second = vi.fn(async () => ({ content: "second" }));
    const { server, harness, done } = await rig([
      echoTool({
        run: first,
        description: "first definition",
        parameters: { type: "object", properties: { a: { type: "string" } } },
      }),
      echoTool({
        run: second,
        description: "second definition",
        parameters: { type: "object", properties: { b: { type: "string" } } },
      }),
    ]);
    const declared = (startFrame(server, "thread/start").params as Record<string, unknown>)
      .dynamicTools as { name: string; description: string; inputSchema: unknown }[];
    // Exactly one spec, and the executor must be the definition that spec came
    // from — a first-wins declaration with a last-wins map would advertise one
    // schema and run the other tool's code.
    expect(declared).toHaveLength(1);
    expect(declared[0]?.description).toBe("first definition");
    expect(declared[0]?.inputSchema).toEqual({ type: "object", properties: { a: { type: "string" } } });
    const response = (await server.ask("item/tool/call", call({ arguments: {} }))) as CallResponse;
    expect(response.success).toBe(true);
    expect(textOf(response)).toBe("first");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });
});

describe("CodexHarness dynamic tools — the permission gate (finding 2)", () => {
  it("denies an execute-class tool outright in plan mode without running it", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })], { permissionMode: "plan" });
    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response)).toMatch(/denied_by_mode/);
    expect(run).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });

  it("raises a permission card in default mode and runs only after the user allows", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, events, done } = await rig([echoTool({ run })], {
      permissionMode: "default",
    });
    const pending = server.ask("item/tool/call", call());
    await settle();
    expect(run).not.toHaveBeenCalled();
    const request = events.find(
      (event): event is Extract<EngineEvent, { type: "permission" }> => event.type === "permission",
    );
    expect(request?.request.toolName).toBe("delegate_task");
    harness.answerPermission(request!.requestId, { behavior: "allow" } as PermissionAnswer);
    const response = (await pending) as CallResponse;
    expect(response.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("does not run the tool when the user denies the card", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, events, done } = await rig([echoTool({ run })], {
      permissionMode: "default",
    });
    const pending = server.ask("item/tool/call", call());
    await settle();
    const request = events.find(
      (event): event is Extract<EngineEvent, { type: "permission" }> => event.type === "permission",
    );
    harness.answerPermission(request!.requestId, {
      behavior: "deny",
      message: "no",
    } as PermissionAnswer);
    const response = (await pending) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response)).toMatch(/denied/);
    expect(run).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });

  it("does not run the tool when the turn is interrupted while its card is open", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })], { permissionMode: "default" });
    const pending = server.ask("item/tool/call", call());
    await settle();
    await harness.interrupt();
    const response = (await pending) as CallResponse;
    expect(response.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });
});

describe("CodexHarness dynamic tools — abort is bounded, not advisory (finding 3)", () => {
  /** A tool that ignores its abort signal entirely and never settles. */
  function deafTool(): ToolDefinition {
    return echoTool({ run: () => new Promise<never>(() => {}) });
  }

  it("answers an interrupt even when the tool ignores its abort signal", async () => {
    const { server, harness, done } = await rig([deafTool()]);
    const pending = server.ask("item/tool/call", call());
    await settle();
    await harness.interrupt();
    const response = (await pending) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response)).toMatch(/cancelled/);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("answers a dispose even when the tool ignores its abort signal", async () => {
    const { server, harness } = await rig([deafTool()]);
    const pending = server.ask("item/tool/call", call());
    await settle();
    await harness.dispose();
    const response = (await pending) as CallResponse;
    expect(response.success).toBe(false);
  });

  it("suppresses a late rejection from an abandoned tool", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let boom: ((err: Error) => void) | undefined;
      const { server, harness } = await rig([
        echoTool({
          run: () =>
            new Promise<never>((_resolve, reject) => {
              boom = reject;
            }),
        }),
      ]);
      const pending = server.ask("item/tool/call", call());
      await settle();
      await harness.interrupt();
      expect(((await pending) as CallResponse).success).toBe(false);
      // The abandoned tool now fails, long after capygen answered.
      boom?.(new Error("late failure nobody is waiting for"));
      await settle(5);
      expect(rejections).toEqual([]);
      await harness.dispose();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("suppresses late output from an abandoned tool", async () => {
    let finishLate: ((value: { content: string }) => void) | undefined;
    const { server, harness } = await rig([
      echoTool({
        run: () =>
          new Promise<{ content: string }>((resolve) => {
            finishLate = resolve;
          }),
      }),
    ]);
    const pending = server.ask("item/tool/call", call());
    await settle();
    await harness.interrupt();
    const answered = (await pending) as CallResponse;
    finishLate?.({ content: "too late" });
    await settle(3);
    expect(answered.success).toBe(false);
    expect(textOf(answered)).not.toContain("too late");
    // The reply is written once: a second frame for the same request id would
    // desynchronise the app-server's pending table.
    expect(server.sent.filter((f) => f.id === 0 && f.method === undefined)).toHaveLength(1);
    await harness.dispose();
  });
});

describe("CodexHarness dynamic tools — byte bounds and leak-free text (finding 4)", () => {
  it("clamps a multibyte result to 64 KiB of UTF-8 without splitting a character", async () => {
    const { server, harness, done } = await rig([
      echoTool({ run: async () => ({ content: "🙂".repeat(40_000) }) }),
    ]);
    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    const text = textOf(response);
    const bytes = Buffer.byteLength(text, "utf8");
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    // 40 000 smileys is 160 000 bytes but only 80 000 JS characters, so a
    // character-counting clamp would have let ~64 000 chars ≈ 256 KB through.
    expect(text.length).toBeLessThan(80_000);
    expect(text).not.toMatch(/[\uD800-\uDFFF]$/);
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("never echoes an oversized attacker-supplied tool name back to the model or the log", async () => {
    const log = vi.fn();
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/start": () => THREAD,
        "skills/list": () => ({ data: [] }),
        "turn/start": () => TURN,
      },
    });
    const harness = new CodexHarness({
      transport: server.transport,
      log: { info: log, warn: log, error: log },
      dynamicTools: [echoTool()],
    });
    await harness.start(SESSION, { ...AGENT, permissionMode: "bypassPermissions" });
    const done = (async () => {
      for await (const _ of harness.send({ turnId: "turn_row", text: "go" })) void _;
    })();
    await server.waitForRequest("turn/start");
    await settle();

    const huge = "A".repeat(200_000);
    const response = (await server.ask("item/tool/call", call({ tool: huge }))) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response).length).toBeLessThan(1_000);
    expect(textOf(response)).not.toContain(huge);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged.length).toBeLessThan(20_000);
    expect(logged).not.toContain(huge);
    finish(server);
    await done;
    await harness.dispose();
  });
});

describe("CodexHarness dynamic tools — strict frame validation (finding 5)", () => {
  it("accepts only a null or absent namespace", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    const asNull = (await server.ask("item/tool/call", call({ namespace: null }))) as CallResponse;
    expect(asNull.success).toBe(true);

    const absent = { ...call({ callId: "call_absent" }) };
    delete absent.namespace;
    expect(((await server.ask("item/tool/call", absent)) as CallResponse).success).toBe(true);

    for (const [index, bad] of [0, 1, "", "  ", true, {}, []].entries()) {
      const response = (await server.ask(
        "item/tool/call",
        call({ callId: `call_bad_${index}`, namespace: bad }),
      )) as CallResponse;
      expect(response.success, `namespace ${JSON.stringify(bad)}`).toBe(false);
      expect(textOf(response)).toMatch(/namespace_unsupported/);
    }
    expect(run).toHaveBeenCalledTimes(2);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("requires arguments to be present and an object", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    const missing = { ...call({ callId: "call_missing" }) };
    delete missing.arguments;
    const cases: Record<string, unknown>[] = [
      missing,
      call({ callId: "call_null", arguments: null }),
      call({ callId: "call_arr", arguments: [] }),
      call({ callId: "call_str", arguments: "{}" }),
      call({ callId: "call_num", arguments: 3 }),
    ];
    for (const params of cases) {
      const response = (await server.ask("item/tool/call", params)) as CallResponse;
      expect(response.success, JSON.stringify(params.arguments)).toBe(false);
      expect(textOf(response)).toMatch(/bad_arguments/);
    }
    expect(run).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });

  it("rejects a non-string callId or tool name", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    expect(
      ((await server.ask("item/tool/call", call({ callId: 7 }))) as CallResponse).success,
    ).toBe(false);
    expect(
      ((await server.ask("item/tool/call", call({ tool: 7 }))) as CallResponse).success,
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });
});

describe("CodexHarness dynamic tools — an interrupted turn runs nothing (finding 7)", () => {
  it("refuses a call that arrives after interrupt but before turn/completed", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { server, harness, done } = await rig([echoTool({ run })]);
    // `interrupt()` marks the turn and asks Codex to stop; `turn/completed`
    // has not arrived, so `active.settled` is still false. A call landing in
    // that window must not start work the user has already cancelled.
    await harness.interrupt();
    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response)).toMatch(/no_active_turn|cancelled/);
    expect(run).not.toHaveBeenCalled();
    finish(server);
    await done;
    await harness.dispose();
  });
});

describe("CodexHarness dynamic tools — an edited permission answer reaches the tool", () => {
  async function answerWith(answer: PermissionAnswer, tool: ToolDefinition) {
    const rigged = await rig([tool], { permissionMode: "default" });
    const pending = rigged.server.ask("item/tool/call", call());
    await settle();
    const request = rigged.events.find(
      (event): event is Extract<EngineEvent, { type: "permission" }> => event.type === "permission",
    );
    rigged.harness.answerPermission(request!.requestId, answer);
    return { ...rigged, response: (await pending) as CallResponse, request: request! };
  }

  it("runs the tool on the user's edited arguments, not the model's original", async () => {
    const seen: Record<string, unknown>[] = [];
    const run = vi.fn(async (input: Record<string, unknown>) => {
      seen.push(input);
      return { content: `ran:${String(input.prompt ?? "")}` };
    });
    const { server, harness, done, response, request } = await answerWith(
      { behavior: "allow", updatedInput: { prompt: "edited by the user" } } as PermissionAnswer,
      echoTool({ run }),
    );
    // The card was shown the model's original arguments…
    expect(request.request.input).toEqual({ prompt: "hello" });
    // …and the executor received the user's replacement.
    expect(response.success).toBe(true);
    expect(textOf(response)).toBe("ran:edited by the user");
    expect(seen).toEqual([{ prompt: "edited by the user" }]);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("keeps the original arguments when the answer edits nothing", async () => {
    const seen: Record<string, unknown>[] = [];
    const run = vi.fn(async (input: Record<string, unknown>) => {
      seen.push(input);
      return { content: "ran" };
    });
    const { server, harness, done, response } = await answerWith(
      { behavior: "allow" } as PermissionAnswer,
      echoTool({ run }),
    );
    expect(response.success).toBe(true);
    expect(seen).toEqual([{ prompt: "hello" }]);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("refuses a malformed replacement rather than running either version", async () => {
    for (const bad of ["not-an-object", 7, [], true]) {
      const run = vi.fn(async () => ({ content: "ran" }));
      const { server, harness, done, response } = await answerWith(
        { behavior: "allow", updatedInput: bad } as PermissionAnswer,
        echoTool({ run }),
      );
      expect(response.success, JSON.stringify(bad)).toBe(false);
      expect(textOf(response)).toMatch(/bad_arguments/);
      expect(run).not.toHaveBeenCalled();
      finish(server);
      await done;
      await harness.dispose();
    }
  });
});

describe("CodexHarness dynamic tools — oversized output keeps a reference (R25)", () => {
  const OVERSIZED = "🙂".repeat(40_000); // 160 000 bytes

  it("stores the exact original through the callback and names the reference", async () => {
    const stored: { callId: string; toolName: string; output: string }[] = [];
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/start": () => THREAD,
        "skills/list": () => ({ data: [] }),
        "turn/start": () => TURN,
      },
    });
    const harness = new CodexHarness({
      transport: server.transport,
      dynamicTools: [echoTool({ run: async () => ({ content: OVERSIZED }) })],
      storeDynamicToolOutput: async (info) => {
        stored.push(info);
        return "out_ref_42";
      },
    });
    await harness.start(SESSION, { ...AGENT, permissionMode: "bypassPermissions" });
    const done = (async () => {
      for await (const _ of harness.send({ turnId: "turn_row", text: "go" })) void _;
    })();
    await server.waitForRequest("turn/start");
    await settle();

    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    const text = textOf(response);
    // Nothing over the cap ever reaches the model — the stub included.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(text).toContain("out_ref_42");
    // The reference has to point at the untouched original, byte for byte.
    expect(stored).toHaveLength(1);
    expect(stored[0]?.output).toBe(OVERSIZED);
    expect(stored[0]?.callId).toBe("call_1");
    finish(server);
    await done;
    await harness.dispose();
  });

  it("prefers a tool's own fullOutput over its already-stubbed content", async () => {
    const { server, harness, done } = await rig([
      echoTool({
        run: async () => ({ content: "short stub", truncated: true, fullOutput: OVERSIZED }),
      }),
    ]);
    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    expect(Buffer.byteLength(textOf(response), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(textOf(response)).toMatch(/not retained|unavailable/i);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("says the output is unavailable when persistence fails, leaking nothing", async () => {
    const log = vi.fn();
    const secret = "s3cret-path-C:/keys/prod.pem";
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/start": () => THREAD,
        "skills/list": () => ({ data: [] }),
        "turn/start": () => TURN,
      },
    });
    const harness = new CodexHarness({
      transport: server.transport,
      log: { info: log, warn: log, error: log },
      dynamicTools: [echoTool({ run: async () => ({ content: OVERSIZED }) })],
      storeDynamicToolOutput: async () => {
        throw new Error(`disk full writing ${secret}`);
      },
    });
    await harness.start(SESSION, { ...AGENT, permissionMode: "bypassPermissions" });
    const done = (async () => {
      for await (const _ of harness.send({ turnId: "turn_row", text: "go" })) void _;
    })();
    await server.waitForRequest("turn/start");
    await settle();

    const response = (await server.ask("item/tool/call", call())) as CallResponse;
    const text = textOf(response);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(text).toMatch(/could not be saved|unavailable/i);
    expect(text).not.toContain(secret);
    expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("says the output was not retained when no store is wired", async () => {
    const { server, harness, done } = await rig([
      echoTool({ run: async () => ({ content: OVERSIZED }) }),
    ]);
    const text = textOf((await server.ask("item/tool/call", call())) as CallResponse);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(text).toMatch(/not retained/i);
    finish(server);
    await done;
    await harness.dispose();
  });
});

describe("CodexHarness dynamic tools — the store cannot outlive the abort", () => {
  const OVER = "🙂".repeat(40_000);

  /** Rig whose store never settles unless the test settles it. */
  async function rigWithStore(store: CodexHarnessStore) {
    const log = vi.fn();
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/start": () => THREAD,
        "skills/list": () => ({ data: [] }),
        "turn/start": () => TURN,
      },
    });
    const harness = new CodexHarness({
      transport: server.transport,
      log: { info: log, warn: log, error: log },
      dynamicTools: [echoTool({ run: async () => ({ content: OVER }) })],
      storeDynamicToolOutput: store,
    });
    await harness.start(SESSION, { ...AGENT, permissionMode: "bypassPermissions" });
    const done = (async () => {
      for await (const _ of harness.send({ turnId: "turn_row", text: "go" })) void _;
    })();
    await server.waitForRequest("turn/start");
    await settle();
    return { server, harness, done, log };
  }

  it("answers an interrupt while the store hangs, instead of blocking on it", async () => {
    const { server, harness, done } = await rigWithStore(() => new Promise<string>(() => {}));
    const pending = server.ask("item/tool/call", call());
    await settle();
    await harness.interrupt();
    const response = (await pending) as CallResponse;
    expect(response.success).toBe(false);
    expect(textOf(response)).toMatch(/cancelled/);
    finish(server);
    await done;
    await harness.dispose();
  });

  it("answers a dispose while the store hangs", async () => {
    const { server, harness } = await rigWithStore(() => new Promise<string>(() => {}));
    const pending = server.ask("item/tool/call", call());
    await settle();
    await harness.dispose();
    expect(((await pending) as CallResponse).success).toBe(false);
  });

  it("never turns a late store result into a success after cancellation", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let saveLate: ((ref: string) => void) | undefined;
      let failLate: ((err: Error) => void) | undefined;
      const { server, harness } = await rigWithStore(
        () =>
          new Promise<string>((resolve, reject) => {
            saveLate = resolve;
            failLate = reject;
          }),
      );
      const pending = server.ask("item/tool/call", call());
      await settle();
      await harness.interrupt();
      const answered = (await pending) as CallResponse;
      expect(answered.success).toBe(false);

      // The store now finishes, long after capygen answered. Neither ending may
      // reach the model, and neither may surface as an unhandled rejection.
      saveLate?.("out_ref_late");
      await settle(3);
      failLate?.(new Error("late store failure"));
      await settle(5);
      expect(answered.success).toBe(false);
      expect(textOf(answered)).not.toContain("out_ref_late");
      expect(rejections).toEqual([]);
      // Exactly one reply frame for the request.
      expect(server.sent.filter((f) => f.id === 0 && f.method === undefined)).toHaveLength(1);
      await harness.dispose();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

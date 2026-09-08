/**
 * Local policy enforcement at the boundaries each backend actually offers
 * (Phase 9, ADR-0007).
 *
 * Everything here drives a **real harness** through its real gate: the local
 * authorizer is the only double. The assertions that matter most are negative —
 * a denied tool never runs, and a local allow never turns into a native allow.
 */
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ApiHarness } from "../src/api/ApiHarness.js";
import { ClaudeHarness } from "../src/claude/ClaudeHarness.js";
import { CodexHarness } from "../src/codex/CodexHarness.js";
import { AsyncQueue } from "../src/asyncQueue.js";
import { authorizeLocally, jsonSnapshot } from "../src/policy/types.js";
import type { LocalAuthorizationRequest, LocalAuthorize } from "../src/policy/types.js";
import type { EngineEvent, HarnessAgent, HarnessSession } from "../src/harness.js";
import type { ToolDefinition } from "../src/tools/types.js";
import type { Provider, ProviderEvent } from "../src/api/providers/types.js";
import { DEFER, createFakeAppServer, settle } from "./codexFakeAppServer.js";
import { makeFakeSdk, initMessage } from "./fakeSdk.js";

const SESSION: HarnessSession = { sessionId: "ses_pol", projectPath: "C:\\proj" };

function agent(overrides: Partial<HarnessAgent> = {}): HarnessAgent {
  return {
    agentId: "agent_pol",
    name: "pol",
    backend: "api",
    model: "claude-sonnet-5",
    permissionMode: "bypassPermissions",
    resumeSessionId: null,
    config: { api: { provider: "anthropic", model: "claude-sonnet-5" } },
    ...overrides,
  } as HarnessAgent;
}

/** Records every request the harness made, and answers as the test dictates. */
function authorizer(
  reply: (request: LocalAuthorizationRequest, index: number) => unknown,
): { authorize: LocalAuthorize; seen: LocalAuthorizationRequest[] } {
  const seen: LocalAuthorizationRequest[] = [];
  const authorize: LocalAuthorize = (request) => {
    seen.push(request);
    return reply(request, seen.length - 1) as never;
  };
  return { authorize, seen };
}

// ---------------------------------------------------------------------------
// the seam itself
// ---------------------------------------------------------------------------

describe("authorizeLocally fails closed", () => {
  const request = (): LocalAuthorizationRequest => ({
    boundary: "api-tool",
    toolName: "bash",
    input: { command: "ls" },
    cwd: "C:\\proj",
    signal: new AbortController().signal,
    stage: "final",
    callId: "call_1",
  });
  const editable = { allowInputReplacement: true, requireObject: true };

  it("passes through untouched when no authorizer is wired", async () => {
    const req = request();
    expect(await authorizeLocally(undefined, req, editable)).toEqual({
      allowed: true,
      input: req.input,
    });
  });

  it("refuses when the authorizer throws", async () => {
    const verdict = await authorizeLocally(
      () => {
        throw new Error("policy database is locked at C:/Users/me/.capygen/policy.db");
      },
      request(),
      editable,
    );
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    // Never the thrown text: it reaches a model's context.
    expect(verdict.message).not.toContain("policy.db");
  });

  it.each([
    ["a non-object", "yes"],
    ["a null", null],
    ["a missing allowed flag", { approvedInput: {} }],
    ["an allow with no approvedInput", { allowed: true }],
  ])("refuses %s answer", async (_label, answer) => {
    const verdict = await authorizeLocally(() => answer as never, request(), editable);
    expect(verdict.allowed).toBe(false);
  });

  it("refuses a signal that aborted before or during the call", async () => {
    const pre = new AbortController();
    pre.abort();
    expect(
      (await authorizeLocally(() => ({ allowed: true, approvedInput: {} }), { ...request(), signal: pre.signal }, editable))
        .allowed,
    ).toBe(false);

    const late = new AbortController();
    const verdict = await authorizeLocally(
      async () => {
        late.abort();
        return { allowed: true, approvedInput: {} };
      },
      { ...request(), signal: late.signal },
      editable,
    );
    expect(verdict.allowed).toBe(false);
  });

  it("refuses an edited input where the boundary cannot apply one", async () => {
    const verdict = await authorizeLocally(
      () => ({ allowed: true, approvedInput: { command: "rm -rf /" } }),
      request(),
      { allowInputReplacement: false, requireObject: false },
    );
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.message).toMatch(/cannot apply/i);
  });

  it("accepts an identical input at a non-editable boundary, key order aside", async () => {
    const verdict = await authorizeLocally(
      () => ({ allowed: true, approvedInput: { b: 2, a: 1 } }),
      { ...request(), input: { a: 1, b: 2 } },
      { allowInputReplacement: false, requireObject: false },
    );
    expect(verdict.allowed).toBe(true);
    const snap = jsonSnapshot((verdict as { input: unknown }).input);
    expect(snap.ok && snap.canonical).toBe((jsonSnapshot({ a: 1, b: 2 }) as { canonical: string }).canonical);
  });
});

// ---------------------------------------------------------------------------
// api-tool
// ---------------------------------------------------------------------------

function scripted(responses: ProviderEvent[][]): Provider {
  let index = 0;
  return {
    provider: "anthropic",
    baseUrl: "",
    async *stream() {
      const events = responses[index++] ?? [{ type: "stop", reason: "end_turn" }];
      for (const event of events) yield event;
    },
  } as unknown as Provider;
}

function toolCall(id: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { type: "content", index: 0, block: { type: "tool_use", id, name, input } },
    { type: "stop", reason: "tool_use" },
  ] as ProviderEvent[];
}

function apiRig(options: {
  authorize?: LocalAuthorize;
  responses: ProviderEvent[][];
  tool: ToolDefinition;
  permissionMode?: HarnessAgent["permissionMode"];
}) {
  const harness = new ApiHarness({
    keys: { getKey: async () => "k" },
    loadHistory: async () => [],
    mcpServers: [],
    extraTools: [options.tool] as never,
    ...(options.authorize ? { authorizeLocal: options.authorize } : {}),
    createProvider: async () => scripted(options.responses),
  } as never);
  return harness;
}

function echoTool(run: ToolDefinition["run"], name = "local_probe"): ToolDefinition {
  return {
    name,
    description: "probe",
    permissionClass: "execute",
    family: "task",
    parameters: { type: "object", properties: { value: { type: "string" } } },
    run,
  };
}

async function drain(harness: ApiHarness, turnId = "t1"): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of harness.send({ turnId, text: "go" })) events.push(event);
  return events;
}

describe("api tools consult local policy immediately before execution", () => {
  it("does not run a tool the local policy denied", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { authorize, seen } = authorizer(() => ({
      allowed: false,
      message: "Blocked by the rule 'no shell'.",
    }));
    const harness = apiRig({
      authorize,
      tool: echoTool(run),
      responses: [toolCall("c1", "local_probe", { value: "x" }), []],
    });
    await harness.start(SESSION, agent());
    const events = await drain(harness);
    expect(run).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ boundary: "api-tool", toolName: "local_probe", cwd: "C:\\proj" });
    expect(seen[0]!.input).toEqual({ value: "x" });
    expect(JSON.stringify(events)).toContain("no shell");
    await harness.dispose();
  });

  it("executes only the approved input, not the model's original", async () => {
    const seenInputs: unknown[] = [];
    const run = vi.fn(async (input: Record<string, unknown>) => {
      seenInputs.push(input);
      return { content: "ran" };
    });
    const { authorize } = authorizer(() => ({
      allowed: true,
      approvedInput: { value: "edited-by-operator" },
    }));
    const harness = apiRig({
      authorize,
      tool: echoTool(run),
      responses: [toolCall("c1", "local_probe", { value: "original" }), []],
    });
    await harness.start(SESSION, agent());
    await drain(harness);
    expect(seenInputs).toEqual([{ value: "edited-by-operator" }]);
    await harness.dispose();
  });

  it("checks every dequeued call, so admitting one never authorizes the next", async () => {
    const ran: string[] = [];
    const run = vi.fn(async (input: Record<string, unknown>) => {
      ran.push(String(input.value));
      return { content: "ran" };
    });
    const { authorize, seen } = authorizer((request) =>
      (request.input as { value: string }).value === "second"
        ? { allowed: false, message: "denied" }
        : { allowed: true, approvedInput: request.input },
    );
    const harness = apiRig({
      authorize,
      tool: echoTool(run),
      responses: [
        [
          { type: "content", index: 0, block: { type: "tool_use", id: "c1", name: "local_probe", input: { value: "first" } } },
          { type: "content", index: 1, block: { type: "tool_use", id: "c2", name: "local_probe", input: { value: "second" } } },
          { type: "stop", reason: "tool_use" },
        ] as ProviderEvent[],
        [],
      ],
    });
    await harness.start(SESSION, agent());
    await drain(harness);
    expect(seen).toHaveLength(2);
    expect(ran).toEqual(["first"]);
    await harness.dispose();
  });

  it("keeps plan mode's hard deny even when local policy would allow", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { authorize, seen } = authorizer((request) => ({
      allowed: true,
      approvedInput: request.input,
    }));
    const harness = apiRig({
      authorize,
      tool: echoTool(run),
      permissionMode: "plan",
      responses: [toolCall("c1", "local_probe", { value: "x" }), []],
    });
    await harness.start(SESSION, agent({ permissionMode: "plan" }));
    await drain(harness);
    expect(run).not.toHaveBeenCalled();
    // The native gate refused first; local policy is never consulted, and
    // certainly never gets to overturn it.
    expect(seen).toHaveLength(0);
    await harness.dispose();
  });

  it("rechecks after a native approval card is answered", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    // The operator revoked the rule while the card was on screen.
    const { authorize, seen } = authorizer(() => ({
      allowed: false,
      message: "That restriction changed while you were deciding.",
    }));
    const harness = apiRig({
      authorize,
      tool: echoTool(run),
      responses: [toolCall("c1", "local_probe", { value: "x" }), []],
    });
    await harness.start(SESSION, agent({ permissionMode: "default" }));
    const events: EngineEvent[] = [];
    for await (const event of harness.send({ turnId: "t1", text: "go" })) {
      events.push(event);
      if (event.type === "permission") harness.answerPermission(event.requestId, { behavior: "allow" });
    }
    // The user said yes; the policy still says no, and the policy wins.
    expect(run).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    await harness.dispose();
  });
});

// ---------------------------------------------------------------------------
// codex-dynamic-tool and the approval categories
// ---------------------------------------------------------------------------

const THREAD = { thread: { id: "thread_pol" } };
const TURN = { turn: { id: "turn_pol", status: "inProgress" } };

function codexRig(options: {
  authorize?: LocalAuthorize;
  tools?: ToolDefinition[];
  config?: Record<string, unknown>;
}) {
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
    ...(options.tools ? { dynamicTools: options.tools } : {}),
    ...(options.authorize ? { authorizeLocal: options.authorize } : {}),
  } as never);
  return { server, harness };
}

async function codexTurn(
  harness: CodexHarness,
  server: ReturnType<typeof createFakeAppServer>,
  responder?: (event: EngineEvent) => void,
) {
  const events: EngineEvent[] = [];
  const done = (async () => {
    for await (const event of harness.send({ turnId: "row", text: "go" })) {
      events.push(event);
      responder?.(event);
    }
  })();
  await server.waitForRequest("turn/start");
  await settle();
  return { events, done };
}

function dynamicCall(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread_pol",
    turnId: "turn_pol",
    callId: "call_1",
    namespace: null,
    tool: "local_probe",
    arguments: { value: "x" },
    ...overrides,
  };
}

describe("codex dynamic tools consult local policy after the host gate", () => {
  it("does not run a tool the local policy denied", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { authorize, seen } = authorizer(() => ({ allowed: false, message: "denied by rule" }));
    const { server, harness } = codexRig({ authorize, tools: [echoTool(run)] });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server);
    const response = (await server.ask("item/tool/call", dynamicCall())) as {
      contentItems: { text?: string }[];
      success: boolean;
    };
    expect(response.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ boundary: "codex-dynamic-tool", toolName: "local_probe" });
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("executes the approved input and still refuses a duplicate callId", async () => {
    const inputs: unknown[] = [];
    const run = vi.fn(async (input: Record<string, unknown>) => {
      inputs.push(input);
      return { content: "ran" };
    });
    const { authorize } = authorizer(() => ({ allowed: true, approvedInput: { value: "edited" } }));
    const { server, harness } = codexRig({ authorize, tools: [echoTool(run)] });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server);
    expect(((await server.ask("item/tool/call", dynamicCall())) as { success: boolean }).success).toBe(true);
    const repeat = (await server.ask("item/tool/call", dynamicCall())) as {
      contentItems: { text?: string }[];
      success: boolean;
    };
    expect(repeat.success).toBe(false);
    expect(repeat.contentItems.map((c) => c.text).join("")).toMatch(/duplicate_call/);
    expect(inputs).toEqual([{ value: "edited" }]);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });
});

describe("codex native approval categories", () => {
  it("declines a command the local policy denied, whatever the user answered", async () => {
    const { authorize, seen } = authorizer(() => ({ allowed: false, message: "no" }));
    const { server, harness } = codexRig({ authorize });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    // The user approves every card as it appears; the local restriction still
    // refuses, because it is consulted after the answer and before the reply.
    const { done } = await codexTurn(harness, server, (event) => {
      if (event.type === "permission") harness.answerPermission(event.requestId, { behavior: "allow" });
    });
    const pending = server.ask("item/commandExecution/requestApproval", {
      threadId: "thread_pol",
      turnId: "turn_pol",
      itemId: "item_1",
      command: "rm -rf .",
      cwd: "C:\\proj",
    });
    expect(await pending).toEqual({ decision: "decline" });
    expect(seen[0]).toMatchObject({ boundary: "codex-command-approval", toolName: "shell" });
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("declines rather than pretending to apply an edited command", async () => {
    const { authorize } = authorizer(() => ({
      allowed: true,
      approvedInput: { command: "echo safe", cwd: "C:\\proj", kind: "command" },
    }));
    const { server, harness } = codexRig({ authorize });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server, (event) => {
      if (event.type === "permission") harness.answerPermission(event.requestId, { behavior: "allow" });
    });
    const pending = server.ask("item/commandExecution/requestApproval", {
      threadId: "thread_pol",
      turnId: "turn_pol",
      itemId: "item_1",
      command: "rm -rf .",
      cwd: "C:\\proj",
    });
    // The protocol takes a decision, not a rewritten command.
    expect(await pending).toEqual({ decision: "decline" });
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("still refuses the permissions category outright", async () => {
    const { authorize } = authorizer(() => ({ allowed: true, approvedInput: {} }));
    const { server, harness } = codexRig({ authorize });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server);
    await expect(
      server.ask("item/permissions/requestApproval", { threadId: "thread_pol", turnId: "turn_pol", itemId: "i" }),
    ).rejects.toThrow(/does not handle/i);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });
});

describe("local policy capabilities are per agent and per captured lifecycle", () => {
  it("reports codex approval categories unavailable under approvalPolicy never", async () => {
    const { server, harness } = codexRig({ tools: [echoTool(async () => ({ content: "" }))] });
    await harness.start(
      SESSION,
      agent({ backend: "codex", model: "gpt-5.6-luna", config: { codex: { approvalPolicy: "never" } } }),
    );
    const { done } = await codexTurn(harness, server);
    const support = new Map(harness.localPolicyCapabilities!().map((s) => [s.boundary, s]));
    expect(support.get("codex-command-approval")).toEqual({
      boundary: "codex-command-approval",
      available: false,
      reason: "native-approval-disabled",
    });
    expect(support.get("codex-file-approval")?.available).toBe(false);
    expect(support.get("codex-permissions-approval")).toEqual({
      boundary: "codex-permissions-approval",
      available: false,
      reason: "capability-unproven",
    });
    expect(support.get("codex-dynamic-tool")?.available).toBe(true);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("reports the dynamic tool boundary unavailable when no tools were declared", async () => {
    const { server, harness } = codexRig({});
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server);
    const support = new Map(harness.localPolicyCapabilities!().map((s) => [s.boundary, s]));
    expect(support.get("codex-dynamic-tool")).toEqual({
      boundary: "codex-dynamic-tool",
      available: false,
      reason: "harness-unavailable",
    });
    expect(support.get("codex-command-approval")?.available).toBe(true);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("names only its own backend's boundaries", async () => {
    const api = new ApiHarness({ keys: { getKey: async () => "k" }, loadHistory: async () => [] } as never);
    await api.start(SESSION, agent());
    expect(api.localPolicyCapabilities!()).toEqual([
      { boundary: "api-tool", available: true, reason: null },
    ]);
    await api.dispose();
  });
});

// ---------------------------------------------------------------------------
// claude-pre-tool
// ---------------------------------------------------------------------------

describe("the Claude hook enforces local policy without widening native rules", () => {
  async function claudeRig(authorize?: LocalAuthorize) {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      ...(authorize ? { authorizeLocal: authorize } : {}),
    } as never);
    await harness.start(SESSION, agent({ backend: "claude", model: "claude-opus-4-5" }));
    const events: EngineEvent[] = [];
    const turn = (async () => {
      for await (const event of harness.send({ turnId: "t1", text: "go" })) events.push(event);
    })();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.out.push(initMessage());
    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0];
    return { fake, harness, hook: hook!, turn, events };
  }

  function fire(hook: NonNullable<Awaited<ReturnType<typeof claudeRig>>["hook"]>, toolName: string, input: unknown) {
    return hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_use_id: "toolu_1",
        tool_input: input,
      } as never,
      "toolu_1",
      { signal: new AbortController().signal } as never,
    );
  }

  it("registers one matcher-less hook so ordinary tools reach it at all", async () => {
    const { fake, harness, turn } = await claudeRig();
    const matchers = fake.options().hooks?.PreToolUse?.map((m) => m.matcher);
    // A `Task|Agent` matcher never fires for Bash, which is exactly the tool a
    // restriction is usually about.
    expect(matchers).toEqual([undefined]);
    fake.end();
    await harness.dispose();
    await turn;
  });

  it("denies through the hook when local policy denies", async () => {
    const { fake, harness, hook, turn } = await claudeRig(() => ({
      allowed: false,
      message: "Blocked by the rule 'no shell'.",
    }));
    const output = (await fire(hook, "Bash", { command: "rm -rf ." })) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("no shell");
    fake.end();
    await harness.dispose();
    await turn;
  });

  it("stays neutral on a local allow so native rules still decide", async () => {
    const { fake, harness, hook, turn } = await claudeRig((request) => ({
      allowed: true,
      approvedInput: request.input,
    }));
    const output = (await fire(hook, "Bash", { command: "ls" })) as {
      hookSpecificOutput?: { permissionDecision?: string; updatedInput?: unknown };
    };
    // Never `allow`: that would override the user's own Claude permission
    // rules, which capygen's local policy has no authority to widen.
    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    // And no `updatedInput` when nothing was actually replaced.
    expect(output.hookSpecificOutput?.updatedInput).toBeUndefined();
    fake.end();
    await harness.dispose();
    await turn;
  });

  it("passes an actual replacement through as updatedInput", async () => {
    const { fake, harness, hook, turn } = await claudeRig(() => ({
      allowed: true,
      approvedInput: { command: "ls -la" },
    }));
    const output = (await fire(hook, "Bash", { command: "ls" })) as {
      hookSpecificOutput?: { permissionDecision?: string; updatedInput?: unknown };
    };
    expect(output.hookSpecificOutput?.updatedInput).toEqual({ command: "ls -la" });
    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    fake.end();
    await harness.dispose();
    await turn;
  });

  it("keeps sub-agent routing working inside the same hook", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      routeSubagent: () => ({ backend: "claude", model: "claude-haiku-4-5" }),
      authorizeLocal: (request: LocalAuthorizationRequest) => ({ allowed: true, approvedInput: request.input }),
    } as never);
    await harness.start(SESSION, agent({ backend: "claude", model: "claude-opus-4-5" }));
    const events: EngineEvent[] = [];
    const turn = (async () => {
      for await (const event of harness.send({ turnId: "t1", text: "go" })) events.push(event);
    })();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0]!;
    const output = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "toolu_task",
        tool_input: { description: "count files", subagent_type: "general-purpose" },
      } as never,
      "toolu_task",
      { signal: new AbortController().signal } as never,
    )) as {
      hookSpecificOutput?: { updatedInput?: { model?: string }; permissionDecision?: string };
    };
    expect(output.hookSpecificOutput?.updatedInput?.model).toBe("claude-haiku-4-5");
    // Proved against the real CLI: the rewrite survives a neutral decision, so
    // routing no longer ships an unconditional native allow.
    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    fake.end();
    await harness.dispose();
    await turn;
  });

  it("denies a routed sub-agent spawn the local policy refused", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      routeSubagent: () => ({ backend: "claude", model: "claude-haiku-4-5" }),
      authorizeLocal: () => ({ allowed: false, message: "no sub-agents" }),
    } as never);
    await harness.start(SESSION, agent({ backend: "claude", model: "claude-opus-4-5" }));
    const events: EngineEvent[] = [];
    const turn = (async () => {
      for await (const event of harness.send({ turnId: "t1", text: "go" })) events.push(event);
    })();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0]!;
    const output = (await hook(
      { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "t", tool_input: {} } as never,
      "t",
      { signal: new AbortController().signal } as never,
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    // Routing must not be a way around a restriction.
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    fake.end();
    await harness.dispose();
    await turn;
  });
});

// ---------------------------------------------------------------------------
// Astra review round 2
// ---------------------------------------------------------------------------

describe("authorizeLocally is bounded by the signal, not merely aware of it", () => {
  const base = (signal: AbortSignal): LocalAuthorizationRequest => ({
    boundary: "api-tool",
    toolName: "bash",
    input: { command: "ls" },
    cwd: "C:\\proj",
    signal,
    stage: "final",
    callId: "call_1",
  });
  const opts = { allowInputReplacement: true, requireObject: true };

  it("settles when the signal aborts while the authorizer hangs", async () => {
    const controller = new AbortController();
    const verdict = authorizeLocally(() => new Promise<never>(() => {}), base(controller.signal), opts);
    controller.abort();
    // A plain `await` on a callback that never settles waits for ever, whatever
    // the signal says.
    expect((await verdict).allowed).toBe(false);
  });

  it("ignores a late success and a late rejection from an abandoned callback", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new AbortController();
      let allow: ((value: never) => void) | undefined;
      let fail: ((err: Error) => void) | undefined;
      const first = authorizeLocally(
        () => new Promise((resolve) => { allow = resolve; }),
        base(controller.signal),
        opts,
      );
      const second = authorizeLocally(
        () => new Promise((_r, reject) => { fail = reject; }),
        base(controller.signal),
        opts,
      );
      controller.abort();
      expect((await first).allowed).toBe(false);
      expect((await second).allowed).toBe(false);
      allow?.({ allowed: true, approvedInput: { command: "rm -rf /" } } as never);
      fail?.(new Error("too late"));
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("refuses a pre-aborted request even with no authorizer wired", async () => {
    const controller = new AbortController();
    controller.abort();
    // Pass-through must not become "run it anyway" for a cancelled call.
    expect((await authorizeLocally(undefined, base(controller.signal), opts)).allowed).toBe(false);
  });

  it("removes its abort listener on the ordinary path", async () => {
    const controller = new AbortController();
    await authorizeLocally(
      () => ({ allowed: true, approvedInput: { command: "ls" } }),
      base(controller.signal),
      opts,
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("jsonSnapshot is strict, bounded and total", () => {
  it("keeps an own __proto__ property instead of eliding it", () => {
    const value = Object.create(null) as Record<string, unknown>;
    value["__proto__"] = { evil: true };
    value.b = 1;
    const snap = jsonSnapshot(value);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    // Building the canonical form with `out = {}; out[key] = …` sets the
    // prototype instead of a property, so this pair vanished silently — two
    // different inputs then shared one identity.
    expect(snap.canonical).toContain('"__proto__"');
    expect(snap.canonical).toContain('"evil"');
  });

  it.each([
    ["undefined", { a: undefined }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["a function", { a: () => 1 }],
    ["a bigint", { a: BigInt(1) }],
    ["a symbol value", { a: Symbol("s") }],
  ])("refuses %s rather than eliding or throwing", (_label, value) => {
    const snap = jsonSnapshot(value);
    expect(snap.ok).toBe(false);
  });

  it("refuses an array hole", () => {
    const holey = [1, , 3];
    expect(jsonSnapshot({ a: holey }).ok).toBe(false);
  });

  it("refuses a getter rather than invoking it", () => {
    let invoked = 0;
    const value = {};
    Object.defineProperty(value, "a", {
      enumerable: true,
      get() {
        invoked += 1;
        return 1;
      },
    });
    expect(jsonSnapshot(value).ok).toBe(false);
    expect(invoked).toBe(0);
  });

  it("refuses a cycle instead of throwing", () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    expect(() => jsonSnapshot(value)).not.toThrow();
    expect(jsonSnapshot(value).ok).toBe(false);
  });

  it("refuses values that exceed its bounds", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 200; i += 1) deep = { deep };
    expect(jsonSnapshot(deep).ok).toBe(false);
    expect(jsonSnapshot({ a: "x".repeat(2_000_000) }).ok).toBe(false);
  });

  it("is order-insensitive and byte-preserving", () => {
    const a = jsonSnapshot({ b: "ß\u0301", a: 1 });
    const b = jsonSnapshot({ a: 1, b: "ß\u0301" });
    expect(a.ok && b.ok && a.canonical === b.canonical).toBe(true);
    expect(a.ok && a.canonical).toContain("ß\u0301");
  });
});

describe("an unusable approved input refuses instead of running the original", () => {
  it("api: refuses when the authorizer replaces the input with a non-object", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { authorize } = authorizer(() => ({ allowed: true, approvedInput: "not an object" }));
    const harness = apiRig({
      authorize,
      tool: echoTool(run),
      responses: [toolCall("c1", "local_probe", { value: "original" }), []],
    });
    await harness.start(SESSION, agent());
    await drain(harness);
    // Silently running `{value:"original"}` would execute an input the
    // authorizer never approved.
    expect(run).not.toHaveBeenCalled();
    await harness.dispose();
  });

  it("api: refuses a non-representable approved input", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { authorize } = authorizer(() => ({ allowed: true, approvedInput: { value: Number.NaN } }));
    const harness = apiRig({
      authorize,
      tool: echoTool(run),
      responses: [toolCall("c1", "local_probe", { value: "original" }), []],
    });
    await harness.start(SESSION, agent());
    await drain(harness);
    expect(run).not.toHaveBeenCalled();
    await harness.dispose();
  });

  it("codex: refuses when the approved input is not an object", async () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const { authorize } = authorizer(() => ({ allowed: true, approvedInput: 7 }));
    const { server, harness } = codexRig({ authorize, tools: [echoTool(run)] });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server);
    const response = (await server.ask("item/tool/call", dynamicCall())) as { success: boolean };
    expect(response.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });
});

describe("a hook authorization cannot outlive its turn", () => {
  it("denies when the turn is interrupted while the authorizer is waiting", async () => {
    let allow: ((value: never) => void) | undefined;
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      authorizeLocal: () => new Promise((resolve) => { allow = resolve as never; }),
    } as never);
    await harness.start(SESSION, agent({ backend: "claude", model: "claude-opus-4-5" }));
    const events: EngineEvent[] = [];
    const turn = (async () => {
      for await (const event of harness.send({ turnId: "t1", text: "go" })) events.push(event);
    })();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0]!;
    const pending = hook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t", tool_input: { command: "ls" } } as never,
      "t",
      { signal: new AbortController().signal } as never,
    );
    await new Promise((r) => setTimeout(r, 5));
    // The user presses Stop while the card is open.
    await harness.interrupt();
    const output = (await pending) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    // A late approval must change nothing.
    allow?.({ allowed: true, approvedInput: { command: "ls" } } as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    fake.end();
    await harness.dispose();
    await turn;
  });

  it("denies when the SDK aborts the hook itself", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      authorizeLocal: () => new Promise<never>(() => {}),
    } as never);
    await harness.start(SESSION, agent({ backend: "claude", model: "claude-opus-4-5" }));
    const events: EngineEvent[] = [];
    const turn = (async () => {
      for await (const event of harness.send({ turnId: "t1", text: "go" })) events.push(event);
    })();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0]!;
    const hookAbort = new AbortController();
    const pending = hook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t", tool_input: {} } as never,
      "t",
      { signal: hookAbort.signal } as never,
    );
    await new Promise((r) => setTimeout(r, 5));
    hookAbort.abort();
    const output = (await pending) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    fake.end();
    await harness.dispose();
    await turn;
  });
});

describe("routing is authorized as what will actually run", () => {
  it("shows the authorizer the routed input and forwards exactly what it approved", async () => {
    const seen: unknown[] = [];
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({
      query: fake.query,
      routeSubagent: () => ({ backend: "claude", model: "claude-haiku-4-5" }),
      authorizeLocal: (request: LocalAuthorizationRequest) => {
        seen.push(request.input);
        return { allowed: true, approvedInput: { ...(request.input as object), audited: true } };
      },
    } as never);
    await harness.start(SESSION, agent({ backend: "claude", model: "claude-opus-4-5" }));
    const events: EngineEvent[] = [];
    const turn = (async () => {
      for await (const event of harness.send({ turnId: "t1", text: "go" })) events.push(event);
    })();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0]!;
    const output = (await hook(
      { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "t", tool_input: { description: "d" } } as never,
      "t",
      { signal: new AbortController().signal } as never,
    )) as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } };
    // The route was applied first, so the authorizer saw the final input…
    expect(seen).toEqual([{ description: "d", model: "claude-haiku-4-5" }]);
    // …and nothing rewrote it afterwards: what ships is the approved value.
    expect(output.hookSpecificOutput?.updatedInput).toEqual({
      description: "d",
      model: "claude-haiku-4-5",
      audited: true,
    });
    fake.end();
    await harness.dispose();
    await turn;
  });
});

describe("Codex file approval authorizes the whole change, not a summary", () => {
  async function fileApprovalRig(reply: (r: LocalAuthorizationRequest) => unknown) {
    const { authorize, seen } = authorizer(reply);
    const { server, harness } = codexRig({ authorize });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server, (event) => {
      if (event.type === "permission") harness.answerPermission(event.requestId, { behavior: "allow" });
    });
    return { server, harness, done, seen };
  }

  function notifyChange(server: ReturnType<typeof createFakeAppServer>, diff: string) {
    server.notify("item/started", {
      threadId: "thread_pol",
      turnId: "turn_pol",
      item: {
        type: "fileChange",
        id: "item_1",
        status: "inProgress",
        changes: [{ path: "src/a.ts", kind: { type: "update" }, diff }],
      },
    });
  }

  it("includes the captured diff and the complete approval parameters", async () => {
    const { server, harness, done, seen } = await fileApprovalRig((request) => ({
      allowed: true,
      approvedInput: request.input,
    }));
    notifyChange(server, "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n");
    await settle();
    const decision = await server.ask("item/fileChange/requestApproval", {
      threadId: "thread_pol",
      turnId: "turn_pol",
      itemId: "item_1",
      reason: "edit",
      grantRoot: "C:\\proj",
    });
    expect(decision).toEqual({ decision: "accept" });
    const authorized = JSON.stringify(seen[0]!.input);
    // Paths and kinds alone would let a different edit to the same file reuse
    // an exact grant.
    expect(authorized).toContain("const a = 2");
    expect(authorized).toContain("grantRoot");
    expect(authorized).toContain("item_1");
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("declines rather than authorizing an oversized change set", async () => {
    const { server, harness, done, seen } = await fileApprovalRig((request) => ({
      allowed: true,
      approvedInput: request.input,
    }));
    notifyChange(server, "x".repeat(400_000));
    await settle();
    const decision = await server.ask("item/fileChange/requestApproval", {
      threadId: "thread_pol",
      turnId: "turn_pol",
      itemId: "item_1",
    });
    expect(decision).toEqual({ decision: "decline" });
    // A truncated value would authorize something other than what runs.
    expect(seen).toHaveLength(0);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });
});

describe("capabilities report only what is proved", () => {
  it("reports the Claude pre-tool boundary available, on native evidence", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({ query: fake.query } as never);
    await harness.start(SESSION, agent({ backend: "claude", model: "claude-opus-4-5" }));
    // Proved against the real CLI by scripts/probe-claude-hook-precedence.ts:
    // hook deny beats a native allow rule and bypassPermissions, and a neutral
    // hook leaves a native deny intact — with a positive control that runs.
    expect(harness.localPolicyCapabilities!()).toEqual([
      { boundary: "claude-pre-tool", available: true, reason: null },
    ]);
    await harness.dispose();
  });

  it("reports Codex approvals unavailable when the reviewer is not this client", async () => {
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        // The user's config routes approvals to Codex's own reviewer, so no
        // approval request ever reaches capygen.
        "thread/start": () => ({ ...THREAD, approvalsReviewer: "auto_review" }),
        "skills/list": () => ({ data: [] }),
        "turn/start": () => TURN,
      },
    });
    const harness = new CodexHarness({ transport: server.transport } as never);
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server);
    const support = new Map(harness.localPolicyCapabilities!().map((s) => [s.boundary, s]));
    expect(support.get("codex-command-approval")).toEqual({
      boundary: "codex-command-approval",
      available: false,
      reason: "native-approval-disabled",
    });
    expect(support.get("codex-file-approval")?.available).toBe(false);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });
});

describe("a Codex approval cannot be authorized into a turn that ended", () => {
  async function hungRig() {
    let release: ((value: never) => void) | undefined;
    const { authorize, seen } = authorizer(
      () => new Promise((resolve) => { release = resolve as never; }),
    );
    const { server, harness } = codexRig({ authorize });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server, (event) => {
      if (event.type === "permission") harness.answerPermission(event.requestId, { behavior: "allow" });
    });
    const pending = server.ask("item/commandExecution/requestApproval", {
      threadId: "thread_pol",
      turnId: "turn_pol",
      itemId: "item_1",
      command: "echo hi",
      cwd: "C:\\proj",
    });
    await settle();
    return { server, harness, done, pending, seen, release: () => release?.({ allowed: true, approvedInput: {} } as never) };
  }

  it("declines when the turn is interrupted while the authorizer hangs", async () => {
    const { server, harness, done, pending, release } = await hungRig();
    // The probe's case: a controller sampled once never learns about this.
    await harness.interrupt();
    expect(await pending).toEqual({ decision: "decline" });
    release();
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "interrupted", items: [] } });
    await done;
    await harness.dispose();
  });

  it("declines when the turn completes while the authorizer hangs", async () => {
    const { server, harness, done, pending, release } = await hungRig();
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    expect(await pending).toEqual({ decision: "decline" });
    release();
    await done;
    await harness.dispose();
  });

  it("declines when a replacement turn has taken over", async () => {
    const { server, harness, done, pending, release } = await hungRig();
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    // A second turn is now the active one. The waiting approval belongs to the
    // first, and must never be authorized against whichever turn happens to be
    // current when its card is answered.
    const second = (async () => {
      for await (const _ of harness.send({ turnId: "row2", text: "again" })) void _;
    })();
    await server.waitForRequest("turn/start");
    await settle();
    expect(await pending).toEqual({ decision: "decline" });
    release();
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await second;
    await harness.dispose();
  });

  it("declines when the harness is disposed while the authorizer hangs", async () => {
    const { harness, pending, release } = await hungRig();
    await harness.dispose();
    expect(await pending).toEqual({ decision: "decline" });
    release();
  });
});

describe("Codex refuses a mis-addressed approval before anyone is asked", () => {
  async function rig() {
    const cards: unknown[] = [];
    // Echoes the input: an approval boundary cannot apply an edit, so anything
    // else is correctly refused (proved separately above).
    const { authorize, seen } = authorizer((request) => ({
      allowed: true,
      approvedInput: request.input,
    }));
    const { server, harness } = codexRig({ authorize });
    await harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const { done } = await codexTurn(harness, server, (event) => {
      if (event.type === "permission") {
        cards.push(event.requestId);
        harness.answerPermission(event.requestId, { behavior: "allow" });
      }
    });
    return { server, harness, done, seen, cards };
  }

  const approval = (overrides: Record<string, unknown> = {}) => ({
    threadId: "thread_pol",
    turnId: "turn_pol",
    itemId: "item_1",
    command: "echo hi",
    cwd: "C:\\proj",
    ...overrides,
  });

  it("declines a request naming another thread without raising a card", async () => {
    const { server, harness, done, seen, cards } = await rig();
    expect(await server.ask("item/commandExecution/requestApproval", approval({ threadId: "other" })))
      .toEqual({ decision: "decline" });
    // Neither the user nor the policy is consulted about somebody else's thread.
    expect(cards).toHaveLength(0);
    expect(seen).toHaveLength(0);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("declines a request naming a turn that is not the active one", async () => {
    const { server, harness, done, seen, cards } = await rig();
    expect(await server.ask("item/commandExecution/requestApproval", approval({ turnId: "turn_old" })))
      .toEqual({ decision: "decline" });
    expect(cards).toHaveLength(0);
    expect(seen).toHaveLength(0);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("declines a file approval that arrives after the turn ended", async () => {
    const { server, harness, done, seen, cards } = await rig();
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    expect(await server.ask("item/fileChange/requestApproval", { threadId: "thread_pol", turnId: "turn_pol", itemId: "i" }))
      .toEqual({ decision: "decline" });
    expect(cards).toHaveLength(0);
    expect(seen).toHaveLength(0);
    await harness.dispose();
  });

  it("still admits a correctly addressed approval", async () => {
    const { server, harness, done, seen, cards } = await rig();
    expect(await server.ask("item/commandExecution/requestApproval", approval())).toEqual({
      decision: "accept",
    });
    expect(cards).toHaveLength(1);
    expect(seen).toHaveLength(1);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });
});

describe("Claude rechecks local policy after the native permission card", () => {
  async function rig(authorizeLocal: LocalAuthorize) {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({ query: fake.query, authorizeLocal } as never);
    await harness.start(SESSION, agent({ backend: "claude", model: "claude-opus-4-5", permissionMode: "default" }));
    const events: EngineEvent[] = [];
    const turn = (async () => {
      for await (const event of harness.send({ turnId: "t1", text: "go" })) events.push(event);
    })();
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    return { fake, harness, turn, events };
  }

  it("refuses when a rule is revoked while the native card is waiting", async () => {
    let allowed = true;
    const seen: LocalAuthorizationRequest[] = [];
    const { fake, harness, turn, events } = await rig((request) => {
      seen.push(request);
      return allowed
        ? { allowed: true, approvedInput: request.input }
        : { allowed: false, message: "the rule was revoked while you were deciding" };
    });
    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0]!;
    // The pre-hook allows.
    expect(
      ((await hook(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu", tool_input: { command: "ls" } } as never,
        "tu",
        { signal: new AbortController().signal } as never,
      )) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision,
    ).toBeUndefined();

    const canUseTool = fake.options().canUseTool!;
    const decision = canUseTool("Bash", { command: "ls" }, { toolUseID: "tu", signal: new AbortController().signal } as never);
    await settle();
    const request = events.find(
      (event): event is Extract<EngineEvent, { type: "permission" }> => event.type === "permission",
    );
    // The operator revokes the rule, then answers the card.
    allowed = false;
    harness.answerPermission(request!.requestId, { behavior: "allow" });
    expect(await decision).toMatchObject({ behavior: "deny" });
    // Two checks for one call, and both name the same call.
    expect(seen.map((r) => r.stage)).toEqual(["pre", "final"]);
    expect(new Set(seen.map((r) => r.callId)).size).toBe(1);
    fake.end();
    await harness.dispose();
    await turn;
  });

  it("rechecks the operator's edited input, not the model's original", async () => {
    const seen: LocalAuthorizationRequest[] = [];
    const { fake, harness, turn, events } = await rig((request) => {
      seen.push(request);
      return { allowed: true, approvedInput: request.input };
    });
    const canUseTool = fake.options().canUseTool!;
    const decision = canUseTool("Bash", { command: "ls" }, { toolUseID: "tu", signal: new AbortController().signal } as never);
    await settle();
    const request = events.find(
      (event): event is Extract<EngineEvent, { type: "permission" }> => event.type === "permission",
    );
    harness.answerPermission(request!.requestId, {
      behavior: "allow",
      updatedInput: { command: "ls -la" },
    });
    expect(await decision).toMatchObject({ behavior: "allow", updatedInput: { command: "ls -la" } });
    // The final check saw what the operator actually approved.
    expect(seen.at(-1)).toMatchObject({ stage: "final", input: { command: "ls -la" } });
    fake.end();
    await harness.dispose();
    await turn;
  });

  it("never asks the local policy about a natively denied call", async () => {
    const seen: LocalAuthorizationRequest[] = [];
    const { fake, harness, turn, events } = await rig((request) => {
      seen.push(request);
      return { allowed: true, approvedInput: request.input };
    });
    const canUseTool = fake.options().canUseTool!;
    const decision = canUseTool("Bash", { command: "ls" }, { toolUseID: "tu", signal: new AbortController().signal } as never);
    await settle();
    const request = events.find(
      (event): event is Extract<EngineEvent, { type: "permission" }> => event.type === "permission",
    );
    harness.answerPermission(request!.requestId, { behavior: "deny", message: "no" });
    expect(await decision).toMatchObject({ behavior: "deny" });
    // A native refusal is already the answer; asking again could only mint an
    // audit record for something nobody is going to run.
    expect(seen).toHaveLength(0);
    fake.end();
    await harness.dispose();
    await turn;
  });
});

describe("Codex correlates an approval's turn id, even before that id is known", () => {
  /** A server whose `turn/start` reply is withheld until the test releases it. */
  function slowTurnRig(authorize: LocalAuthorize) {
    let turnStartId: string | number | undefined;
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/start": () => THREAD,
        "skills/list": () => ({ data: [] }),
        // Held open, so the approval below genuinely lands in the window
        // before the client has learned its own turn id.
        "turn/start": () => DEFER,
      },
    });
    const harness = new CodexHarness({ transport: server.transport, authorizeLocal: authorize } as never);
    return {
      server,
      harness,
      release: () => {
        turnStartId ??= server.sent.find((f) => f.method === "turn/start")?.id;
        if (turnStartId !== undefined) server.emit({ id: turnStartId, result: TURN });
      },
    };
  }

  async function open(authorize: LocalAuthorize) {
    const cards: string[] = [];
    const rig = slowTurnRig(authorize);
    await rig.harness.start(SESSION, agent({ backend: "codex", model: "gpt-5.6-luna" }));
    const done = (async () => {
      for await (const event of rig.harness.send({ turnId: "row", text: "go" })) {
        if (event.type === "permission") {
          cards.push(event.requestId);
          rig.harness.answerPermission(event.requestId, { behavior: "allow" });
        }
      }
    })();
    await rig.server.waitForRequest("turn/start");
    await settle();
    return { ...rig, cards, done };
  }

  const approval = (turnId: unknown) => {
    const params: Record<string, unknown> = {
      threadId: "thread_pol",
      itemId: "item_1",
      command: "echo hi",
      cwd: "C:\\proj",
    };
    if (turnId !== undefined) params.turnId = turnId;
    return params;
  };

  const echo: LocalAuthorize = (request) => ({ allowed: true, approvedInput: request.input });

  it("admits a legitimate approval that arrives before turn/start answered", async () => {
    const { server, harness, release, cards, done } = await open(echo);
    // The approval is on the wire before the client has learned the turn id.
    const pending = server.ask("item/commandExecution/requestApproval", approval("turn_pol"));
    await settle();
    release();
    expect(await pending).toEqual({ decision: "accept" });
    expect(cards).toHaveLength(1);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("declines a stale approval from an older turn that arrives in the same window", async () => {
    const { server, harness, release, cards, done } = await open(echo);
    // Same window, but this one belongs to a turn that has already gone. Before
    // the fix it was admitted because the id was simply not compared, and the
    // later identity check compares the *turn object*, which matches.
    const pending = server.ask("item/commandExecution/requestApproval", approval("turn_previous"));
    await settle();
    release();
    expect(await pending).toEqual({ decision: "decline" });
    expect(cards).toHaveLength(0);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("declines an approval that names no turn at all", async () => {
    const { server, harness, release, cards, done } = await open(echo);
    const pending = server.ask("item/commandExecution/requestApproval", approval(undefined));
    await settle();
    release();
    expect(await pending).toEqual({ decision: "decline" });
    expect(cards).toHaveLength(0);
    server.notify("turn/completed", { threadId: "thread_pol", turn: { ...TURN.turn, status: "completed", items: [] } });
    await done;
    await harness.dispose();
  });

  it("declines rather than waiting for ever when the turn id never arrives", async () => {
    const { server, harness, cards, done } = await open(echo);
    const pending = server.ask("item/commandExecution/requestApproval", approval("turn_pol"));
    await settle();
    // turn/start is never released; the turn is interrupted instead.
    await harness.interrupt();
    expect(await pending).toEqual({ decision: "decline" });
    expect(cards).toHaveLength(0);
    void done;
    await harness.dispose();
  });
});

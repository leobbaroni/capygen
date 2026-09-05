/**
 * The Claude harness against a fake SDK: one scripted turn exercising text
 * deltas → tool call → AskUserQuestion → result, plus the properties the rest of
 * the app relies on (one backend session across turns, per-turn usage deltas,
 * the sub-agent hook, interrupt).
 */
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeHarness,
  SUBAGENT_HOOK_MATCHER,
  buildCommands,
  deltaUsage,
  parseQuestions,
  readClaudeConfig,
} from "../src/claude/ClaudeHarness.js";
import { cleanEnv } from "../src/env.js";
import type { EngineEvent, HarnessAgent, HarnessSession } from "../src/harness.js";
import type { ClaudeOptions } from "../src/claude/sdk.js";
import {
  SESSION_ID,
  assistantMessage,
  errorResult,
  initMessage,
  makeFakeSdk,
  messageStart,
  resultMessage,
  textDelta,
  thinkingDelta,
  toolResultMessage,
  type FakeSdk,
} from "./fakeSdk.js";

const SESSION: HarnessSession = { sessionId: "ses_1", projectPath: "C:\\project" };
const AGENT: HarnessAgent = {
  agentId: "agt_1",
  name: "capy",
  backend: "claude",
  model: "claude-sonnet-5",
};

async function start(
  fake: FakeSdk,
  overrides: Partial<HarnessAgent> = {},
  deps: Record<string, unknown> = {},
): Promise<ClaudeHarness> {
  const harness = new ClaudeHarness({ query: fake.query, ...deps });
  await harness.start(SESSION, { ...AGENT, ...overrides });
  return harness;
}

/** Consume a turn in the background so the test can react while it runs. */
function drain(events: AsyncIterable<EngineEvent>): {
  events: EngineEvent[];
  done: Promise<void>;
} {
  const seen: EngineEvent[] = [];
  const done = (async () => {
    for await (const event of events) seen.push(event);
  })();
  return { events: seen, done };
}

function blocks(events: EngineEvent[], kind: string): { key: string; patch: Record<string, unknown> }[] {
  return events
    .filter((e): e is Extract<EngineEvent, { type: "block" }> => e.type === "block")
    .filter((e) => e.patch.kind === kind)
    .map((e) => ({ key: e.key, patch: e.patch as unknown as Record<string, unknown> }));
}

describe("ClaudeHarness — one full turn", () => {
  it("maps deltas, tool calls, a question and the result onto engine events", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "read the file" }));

    // The prompt reaches the SDK as plain text — slash commands included.
    await vi.waitFor(() => expect(fake.prompts).toEqual(["read the file"]));

    fake.out.push(initMessage());
    await vi.waitFor(() => expect(turn.events.some((e) => e.type === "session")).toBe(true));
    const session = turn.events.find((e) => e.type === "session");
    expect(session).toMatchObject({ backendSessionId: SESSION_ID, model: "claude-sonnet-5" });
    expect(harness.backendSessionId()).toBe(SESSION_ID);
    expect(harness.listCommands().map((c) => c.name)).toEqual([
      "/context",
      "/compact",
      "/dataviz",
      "/cockpit:pilot",
    ]);

    // Streaming text: one block, growing.
    fake.out.push(messageStart("msg_01"));
    fake.out.push(thinkingDelta(0, "checking"));
    fake.out.push(textDelta(1, "Read"));
    fake.out.push(textDelta(1, "ing it"));
    await vi.waitFor(() => expect(blocks(turn.events, "text")).toHaveLength(2));
    const texts = blocks(turn.events, "text");
    expect(texts.map((b) => b.patch.text)).toEqual(["Read", "Reading it"]);
    // Same key both times: the runner upserts one row (SPEC R23).
    expect(new Set(texts.map((b) => b.key)).size).toBe(1);
    expect(blocks(turn.events, "thinking")[0]?.patch.text).toBe("checking");

    // The settled assistant message plus a tool call.
    fake.out.push(
      assistantMessage("msg_01", [
        { type: "thinking", thinking: "checking" },
        { type: "text", text: "Reading it" },
        { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "a.md" } },
      ]),
    );
    await vi.waitFor(() => expect(blocks(turn.events, "tool_call")).toHaveLength(1));
    expect(blocks(turn.events, "tool_call")[0]).toMatchObject({
      key: "tool:toolu_01",
      patch: { name: "Read", status: "running", toolUseId: "toolu_01" },
    });

    fake.out.push(toolResultMessage("toolu_01", "file contents"));
    await vi.waitFor(() => expect(blocks(turn.events, "tool_call")).toHaveLength(2));
    expect(blocks(turn.events, "tool_call")[1]).toMatchObject({
      key: "tool:toolu_01",
      patch: { name: "Read", status: "success", output: "file contents" },
    });

    // AskUserQuestion arrives through canUseTool, not through the stream.
    const input = {
      questions: [
        {
          question: "Which colour do you prefer?",
          header: "Colour",
          multiSelect: false,
          options: [
            { label: "Red", description: "Choose red" },
            { label: "Blue", description: "Choose blue" },
          ],
        },
      ],
    };
    const asked = fake.options().canUseTool?.("AskUserQuestion", input, {
      signal: new AbortController().signal,
      toolUseID: "toolu_q",
      requestId: "req-sdk-1",
    } as never);

    await vi.waitFor(() => expect(turn.events.some((e) => e.type === "question")).toBe(true));
    const question = turn.events.find(
      (e): e is Extract<EngineEvent, { type: "question" }> => e.type === "question",
    );
    expect(question?.questions[0]?.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    expect(blocks(turn.events, "question")[0]?.patch.answers).toBeNull();

    expect(harness.answerQuestion("nope", {})).toBe(false);
    expect(
      harness.answerQuestion(question!.requestId, {
        "Which colour do you prefer?": "Blue",
      }),
    ).toBe(true);

    // The proven wire shape: the answers ride back on updatedInput (spike §4).
    expect(await asked).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "Which colour do you prefer?": "Blue" },
      },
    });
    await vi.waitFor(() =>
      expect(blocks(turn.events, "question").at(-1)?.patch.answers).toEqual({
        "Which colour do you prefer?": "Blue",
      }),
    );

    fake.out.push(
      resultMessage("Blue", {
        "claude-sonnet-5": { input: 4, output: 131, cacheRead: 37_762, cost: 0.161 },
      }),
    );
    await turn.done;

    const usage = turn.events.find(
      (e): e is Extract<EngineEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usage?.usage).toEqual({
      inputTokens: 4,
      outputTokens: 131,
      cacheReadTokens: 37_762,
      cacheCreationTokens: 0,
      costUsd: 0.161,
    });
    expect(blocks(turn.events, "usage")).toHaveLength(1);
    expect(turn.events.at(-1)).toEqual({ type: "turn", status: "done" });

    await harness.dispose();
  });
});

describe("ClaudeHarness — efficiency (SPEC R24)", () => {
  it("keeps one backend session across turns and injects no per-turn system prompt", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);

    const first = drain(harness.send({ turnId: "trn_1", text: "one" }));
    await vi.waitFor(() => expect(fake.prompts).toEqual(["one"]));
    fake.out.push(initMessage());
    fake.out.push(resultMessage("ok", { "claude-sonnet-5": { input: 2, output: 4, cost: 0.05 } }));
    await first.done;

    const second = drain(harness.send({ turnId: "trn_2", text: "two" }));
    await vi.waitFor(() => expect(fake.prompts).toEqual(["one", "two"]));
    // Cumulative totals, as the CLI reports them in a streaming session.
    fake.out.push(
      resultMessage("ok", { "claude-sonnet-5": { input: 5, output: 9, cost: 0.08 } }),
    );
    await second.done;

    // One process, one prompt cache, one system prompt.
    expect(fake.calls).toHaveLength(1);
    const options: ClaudeOptions = fake.options();
    expect(options.systemPrompt).toBeUndefined();
    expect(options.model).toBe("claude-sonnet-5");
    expect(options.cwd).toBe("C:\\project");
    expect(options.settingSources).toEqual(["user", "project"]);
    expect(options.includePartialMessages).toBe(true);
    expect(options.permissionMode).toBe("default");
    expect(options.resume).toBeUndefined();

    // Second turn bills only its own delta, not the running total.
    const usage = second.events.find(
      (e): e is Extract<EngineEvent, { type: "usage" }> => e.type === "usage",
    );
    expect(usage?.usage).toMatchObject({ inputTokens: 3, outputTokens: 5 });
    expect(usage?.usage.costUsd).toBeCloseTo(0.03, 10);

    await harness.dispose();
  });

  it("resumes the stored backend session id on a fresh process", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake, { resumeSessionId: "prev-session-id" });
    const turn = drain(harness.send({ turnId: "trn_1", text: "again" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.options().resume).toBe("prev-session-id");
    fake.out.push(resultMessage("ok"));
    await turn.done;
    await harness.dispose();
  });
});

describe("ClaudeHarness — permissions (SPEC R27)", () => {
  it("asks, then returns the user's decision to the backend", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "run it" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    const allowed = fake.options().canUseTool?.(
      "Bash",
      { command: "ls" },
      {
        signal: new AbortController().signal,
        toolUseID: "toolu_b",
        requestId: "req-sdk",
        decisionReason: "not in the allowlist",
      } as never,
    );
    await vi.waitFor(() => expect(turn.events.some((e) => e.type === "permission")).toBe(true));
    const ask = turn.events.find(
      (e): e is Extract<EngineEvent, { type: "permission" }> => e.type === "permission",
    );
    expect(ask?.request).toMatchObject({
      toolName: "Bash",
      input: { command: "ls" },
      reason: "not in the allowlist",
    });

    expect(
      harness.answerPermission(ask!.requestId, {
        behavior: "allow",
        updatedInput: { command: "ls -la" },
      }),
    ).toBe(true);
    expect(await allowed).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls -la" },
    });
    await vi.waitFor(() =>
      expect(blocks(turn.events, "permission").at(-1)?.patch.decision).toMatchObject({
        behavior: "allow",
        scope: "once",
      }),
    );

    const denied = fake.options().canUseTool?.(
      "Bash",
      { command: "rm -rf /" },
      { signal: new AbortController().signal, toolUseID: "toolu_c", requestId: "r2" } as never,
    );
    await vi.waitFor(() =>
      expect(turn.events.filter((e) => e.type === "permission")).toHaveLength(2),
    );
    const second = turn.events.filter(
      (e): e is Extract<EngineEvent, { type: "permission" }> => e.type === "permission",
    )[1];
    harness.answerPermission(second!.requestId, { behavior: "deny", message: "no" });
    expect(await denied).toEqual({ behavior: "deny", message: "no" });

    fake.out.push(resultMessage("stopped"));
    await turn.done;
    await harness.dispose();
  });

  it("denies rather than auto-approves when no turn is open to ask in", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.out.push(resultMessage("done"));
    await turn.done;

    const answer = await fake.options().canUseTool?.(
      "Bash",
      { command: "ls" },
      { signal: new AbortController().signal, toolUseID: "t", requestId: "r" } as never,
    );
    expect(answer).toMatchObject({ behavior: "deny" });
    await harness.dispose();
  });
});

describe("ClaudeHarness — sub-agents (SPEC R12)", () => {
  it("registers the hook on both wire names and fails open by default", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "delegate" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    const matchers = fake.options().hooks?.PreToolUse?.map((m) => m.matcher);
    expect(matchers).toEqual([SUBAGENT_HOOK_MATCHER]);

    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0];
    const output = await hook?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "toolu_task",
        tool_input: { description: "Count .md files", subagent_type: "general-purpose" },
      } as never,
      "toolu_task",
      { signal: new AbortController().signal },
    );
    expect(output).toEqual({});

    await vi.waitFor(() => expect(blocks(turn.events, "subagent")).toHaveLength(1));
    expect(blocks(turn.events, "subagent")[0]).toMatchObject({
      key: "subagent:toolu_task",
      patch: {
        name: "general-purpose",
        description: "Count .md files",
        status: "spawned",
        model: null,
      },
    });

    fake.out.push(resultMessage("done"));
    await turn.done;
    await harness.dispose();
  });

  it("rewrites the model when a routing policy answers, and ignores one that throws", async () => {
    const fake = makeFakeSdk();
    const harness = await start(
      fake,
      {},
      { routeSubagent: (req: { description: string }) => (req.description === "boom" ? bang() : { model: "haiku" }) },
    );
    const turn = drain(harness.send({ turnId: "trn_1", text: "delegate" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0];

    expect(
      await hook?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: { description: "explore", prompt: "go" },
        } as never,
        "toolu_a",
        { signal: new AbortController().signal },
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { description: "explore", prompt: "go", model: "haiku" },
      },
    });

    // A policy that throws must not stop the spawn (fail open).
    expect(
      await hook?.(
        { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "boom" } } as never,
        "toolu_b",
        { signal: new AbortController().signal },
      ),
    ).toEqual({});

    fake.out.push(resultMessage("done"));
    await turn.done;
    await harness.dispose();
  });
});

function bang(): never {
  throw new Error("routing endpoint down");
}

describe("ClaudeHarness — failure and interruption", () => {
  it("ends the turn as interrupted and calls the SDK's interrupt", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "long job" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    expect(await harness.interrupt()).toBe(true);
    expect(fake.interrupts).toBe(1);
    fake.out.push(resultMessage("partial"));
    await turn.done;
    expect(turn.events.at(-1)).toEqual({ type: "turn", status: "interrupted" });
    // Nothing is running any more.
    expect(await harness.interrupt()).toBe(false);
    await harness.dispose();
  });

  it("surfaces an error result as an error block and an errored turn", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "boom" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.out.push(errorResult("error_during_execution", ["spawn ENOENT"]));
    await turn.done;
    expect(blocks(turn.events, "error")[0]?.patch.detail).toBe("spawn ENOENT");
    expect(turn.events.at(-1)).toMatchObject({ type: "turn", status: "error" });
    await harness.dispose();
  });

  it("errors the turn when the backend process dies mid-stream", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.end();
    await turn.done;
    expect(turn.events.at(-1)).toMatchObject({ type: "turn", status: "error" });
    await harness.dispose();
  });

  it("refuses a second turn while one is running", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const first = drain(harness.send({ turnId: "trn_1", text: "one" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    const second = drain(harness.send({ turnId: "trn_2", text: "two" }));
    await second.done;
    expect(second.events).toEqual([
      { type: "turn", status: "error", error: "this agent is already running a turn" },
    ]);

    fake.out.push(resultMessage("done"));
    await first.done;
    await harness.dispose();
  });
});

describe("pure mappers", () => {
  it("reads AskUserQuestion input, skipping malformed entries", () => {
    expect(
      parseQuestions({
        questions: [
          { question: "A?", header: "A", multiSelect: true, options: [{ label: "x" }, {}] },
          { header: "no question" },
        ],
      }),
    ).toEqual([{ question: "A?", header: "A", multiSelect: true, options: [{ label: "x" }] }]);
    expect(parseQuestions(null)).toEqual([]);
  });

  it("labels slash commands by where they came from (R14)", () => {
    expect(
      buildCommands({
        slash_commands: ["context", "dataviz", "cockpit:pilot", "other:thing"],
        skills: ["dataviz"],
        plugins: [{ name: "cockpit" }],
      }),
    ).toEqual([
      { name: "/context", description: "", source: "backend" },
      { name: "/dataviz", description: "", source: "skill" },
      { name: "/cockpit:pilot", description: "", source: "plugin" },
      { name: "/other:thing", description: "", source: "backend" },
    ]);
  });

  it("clamps a usage delta at zero when the counters restart", () => {
    const previous = {
      a: {
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 1,
      },
    };
    const current = {
      a: {
        inputTokens: 4,
        outputTokens: 12,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 2,
      },
    };
    expect(deltaUsage(previous, current).a).toMatchObject({
      inputTokens: 0,
      outputTokens: 2,
      costUsd: 1,
    });
  });

  it("reads only the config keys it knows", () => {
    expect(
      readClaudeConfig({
        claude: {
          permissionMode: "plan",
          settingSources: ["user", "bogus"],
          strictMcpConfig: true,
          allowedTools: ["Read", 7],
          nonsense: true,
        },
      }),
    ).toEqual({
      permissionMode: "plan",
      settingSources: ["user"],
      strictMcpConfig: true,
      allowedTools: ["Read"],
    });
    expect(readClaudeConfig(undefined)).toEqual({});
  });

  it("strips the nested-session markers and forces UTF-8", () => {
    const env = cleanEnv({
      PATH: "C:\\bin",
      CLAUDECODE: "1",
      CLAUDE_PID: "42",
      CLAUDE_EFFORT: "high",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_AGENT_SDK_VERSION: "0.0.1",
      ANTHROPIC_MODEL: "keep-me",
    });
    expect(env).toEqual({
      PATH: "C:\\bin",
      ANTHROPIC_MODEL: "keep-me",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    });
  });
});

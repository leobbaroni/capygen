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
  readModelUsage,
  sumUsage,
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
      costKnown: true,
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

  /**
   * [P2-effort] `config.claude.effort` is the agent's configured reasoning
   * effort. `Options.effort` exists on the installed SDK
   * (`sdk.d.ts:1758`, inside the `Options` type at 1396-2279, typed
   * `EffortLevel = 'low'|'medium'|'high'|'xhigh'|'max'`), so it belongs on the
   * options object this backend session is built from.
   */
  /** Start the one backend session and settle its first turn, so the captured
   *  options are the ones the SDK was really called with. */
  async function optionsFor(overrides: Partial<HarnessAgent>): Promise<ClaudeOptions> {
    const fake = makeFakeSdk();
    const harness = await start(fake, overrides);
    const turn = drain(harness.send({ turnId: "trn_1", text: "go" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const options = fake.options();
    fake.out.push(resultMessage("ok"));
    await turn.done;
    await harness.dispose();
    return options;
  }

  it("[P2-effort] sends a configured effort level on the query options", async () => {
    expect((await optionsFor({ config: { claude: { effort: "low" } } })).effort).toBe("low");
  });

  it("[P2-effort] sends effort on a resumed session too", async () => {
    const options = await optionsFor({
      resumeSessionId: "prev-session-id",
      config: { claude: { effort: "low" } },
    });
    expect(options.resume).toBe("prev-session-id");
    expect(options.effort).toBe("low");
  });

  it("[P2-effort] accepts every level the installed SDK declares", async () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect((await optionsFor({ config: { claude: { effort: level } } })).effort).toBe(level);
    }
  });

  it("[P2-effort] leaves effort unset when the agent configures none", async () => {
    expect((await optionsFor({})).effort).toBeUndefined();
  });

  it("[P2-effort] drops an unknown effort instead of sending it or failing", async () => {
    // The shared schema types `effort` as a free-form string, so an unknown
    // value is reachable. It must not reach the SDK, and must not cost the
    // session: same convention as an unknown `permissionMode`.
    for (const bogus of ["turbo", "LOW", "", " low ", 7, null, {}]) {
      const options = await optionsFor({ config: { claude: { effort: bogus } } });
      expect(options.effort).toBeUndefined();
      expect(options.model).toBe("claude-sonnet-5");
    }
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

describe("ClaudeHarness — AskUserQuestion is rendered once", () => {
  it("folds the tool_use and tool_result frames into the question block", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "ask me" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    const input = {
      questions: [
        {
          question: "Red or blue?",
          header: "Colour",
          multiSelect: false,
          options: [{ label: "Red" }, { label: "Blue" }],
        },
      ],
    };
    const asked = fake.options().canUseTool?.("AskUserQuestion", input, {
      signal: new AbortController().signal,
      toolUseID: "toolu_q",
      requestId: "req-1",
    } as never);
    await vi.waitFor(() => expect(turn.events.some((e) => e.type === "question")).toBe(true));
    const question = turn.events.find(
      (e): e is Extract<EngineEvent, { type: "question" }> => e.type === "question",
    );
    harness.answerQuestion(question!.requestId, { "Red or blue?": "Blue" });
    await asked;

    // The same call also comes down the stream as a normal tool_use plus its
    // tool_result. Those must NOT become a second, raw tool-call card next to
    // the question card the user already answered.
    fake.out.push(
      assistantMessage("msg_q", [
        { type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input },
      ]),
    );
    fake.out.push(toolResultMessage("toolu_q", "Blue"));
    fake.out.push(resultMessage("Blue"));
    await turn.done;

    expect(blocks(turn.events, "tool_call")).toEqual([]);
    expect(blocks(turn.events, "question").at(-1)?.patch.answers).toEqual({
      "Red or blue?": "Blue",
    });
    await harness.dispose();
  });
});

describe("ClaudeHarness — block keys across the two views of a message", () => {
  /**
   * [C] Observed live 2026-09-06: a reply whose stream is
   * `[0]=thinking, [1]=text` arrives settled as `content: [text]` — the SDK
   * drops the thinking block. Keyed by the raw content index, the settled walk
   * wrote the answer over the *thinking* block (index 0) as well as under its
   * own key, and the transcript rendered the whole reply twice.
   */
  it("does not duplicate the reply when the settled message omits the thinking block", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "think then answer" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    fake.out.push(initMessage());
    fake.out.push(messageStart("m1"));
    fake.out.push(thinkingDelta(0, "weighing it up"));
    fake.out.push(textDelta(1, "the answer"));
    // …and the settled message, with the thinking block gone and the text
    // therefore at index 0.
    fake.out.push(assistantMessage("m1", [{ type: "text", text: "the answer" }]));

    await vi.waitFor(() => expect(blocks(turn.events, "text").length).toBeGreaterThan(0));
    const textKeys = new Set(blocks(turn.events, "text").map((b) => b.key));
    const thinkingKeys = new Set(blocks(turn.events, "thinking").map((b) => b.key));
    expect([...textKeys]).toEqual(["msg:m1:text:0"]);
    expect([...thinkingKeys]).toEqual(["msg:m1:thinking:0"]);
    // The thinking block keeps its own words; nothing overwrote it.
    expect(blocks(turn.events, "thinking").at(-1)!.patch.text).toBe("weighing it up");

    fake.out.push(resultMessage("done"));
    await turn.done;
    await harness.dispose();
  });

  it("keys two text blocks of one message apart", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "two paragraphs" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    fake.out.push(initMessage());
    fake.out.push(messageStart("m1"));
    fake.out.push(
      assistantMessage("m1", [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    );
    await vi.waitFor(() => expect(blocks(turn.events, "text")).toHaveLength(2));
    expect(blocks(turn.events, "text").map((b) => b.key)).toEqual([
      "msg:m1:text:0",
      "msg:m1:text:1",
    ]);

    fake.out.push(resultMessage("done"));
    await turn.done;
    await harness.dispose();
  });
});

describe("ClaudeHarness — describeSnapshot (SPEC R13)", () => {
  it("has nothing before the first init, and the init's own fields after it", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    // `agents.describe` on an agent that has not spoken must not guess.
    expect(harness.describeSnapshot()).toBeNull();

    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.out.push(initMessage({ permissionMode: "bypassPermissions" }));
    await vi.waitFor(() => expect(harness.describeSnapshot()).not.toBeNull());

    expect(harness.describeSnapshot()).toEqual({
      model: "claude-sonnet-5",
      permissionMode: "bypassPermissions",
      tools: ["Bash", "Read", "Task"],
      mcpServers: [],
      skills: ["dataviz", "cockpit:pilot"],
      // the plugin's filesystem path has no business on an info card
      plugins: [{ name: "cockpit", version: "3.0.0" }],
    });

    fake.out.push(resultMessage("done"));
    await turn.done;
    await harness.dispose();
  });

  it("keeps whatever an init omits from breaking the card", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.out.push(
      initMessage({ tools: undefined, mcp_servers: undefined, permissionMode: undefined }),
    );
    await vi.waitFor(() => expect(harness.describeSnapshot()).not.toBeNull());
    const snapshot = harness.describeSnapshot()!;
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.mcpServers).toEqual([]);
    expect(snapshot.permissionMode).toBe("default");

    fake.out.push(resultMessage("done"));
    await turn.done;
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

  /**
   * [C] The hook runs *before* the assistant message carrying the same
   * `tool_use` is delivered, and both upsert the block. The second used to
   * pass `model: str(input.model) ?? null` — an explicit `null`, which
   * `upsertSubagent` treats as "clear it" — so a spawn the policy had just
   * re-homed onto haiku came back with no model at all and the agents pane
   * showed the routing as having done nothing (SPEC R12/R13).
   */
  it("keeps the routed model when the tool_use frame for the same spawn arrives after", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake, {}, { routeSubagent: () => ({ model: "haiku" }) });
    const turn = drain(harness.send({ turnId: "trn_1", text: "delegate" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    const hook = fake.options().hooks?.PreToolUse?.[0]?.hooks[0];
    await hook?.(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "toolu_task",
        tool_input: { description: "count files", subagent_type: "general-purpose" },
      } as never,
      "toolu_task",
      { signal: new AbortController().signal },
    );

    // …and now the model's own frame for the very same call, which names no
    // model because the *policy* chose it, not the model.
    fake.out.push(
      assistantMessage("m1", [
        {
          type: "tool_use",
          id: "toolu_task",
          name: "Agent",
          input: { description: "count files", subagent_type: "general-purpose" },
        },
      ]),
    );

    await vi.waitFor(() => expect(blocks(turn.events, "subagent").length).toBeGreaterThan(2));
    const last = blocks(turn.events, "subagent").at(-1)!;
    expect(last.key).toBe("subagent:toolu_task");
    expect(last.patch.model).toBe("haiku");
    expect(last.patch.delegated).toBe(false);

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

describe("ClaudeHarness — a cancelled question is not a submitted one", () => {
  it("interrupt leaves the card cancelled with no answers, and denies the tool", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "ask me" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    const input = {
      questions: [
        { question: "Which?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
      ],
    };
    const asked = fake.options().canUseTool?.("AskUserQuestion", input, {
      signal: new AbortController().signal,
      toolUseID: "toolu_q",
      requestId: "req-1",
    } as never);
    await vi.waitFor(() => expect(turn.events.some((e) => e.type === "question")).toBe(true));

    // The user presses Stop while the card is open.
    await harness.interrupt();

    // `{}` used to come back here, which the card read as a submission and
    // rendered as a green "Submitted" with an empty list.
    expect(await asked).toMatchObject({ behavior: "deny" });
    await vi.waitFor(() =>
      expect(blocks(turn.events, "question").at(-1)?.patch.status).toBe("cancelled"),
    );
    expect(blocks(turn.events, "question").at(-1)?.patch.answers).toBeNull();
    await harness.dispose();
  });

  it("treats an empty answer map from the card's Decline button as cancelled", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "ask me" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const asked = fake.options().canUseTool?.(
      "AskUserQuestion",
      { questions: [{ question: "Which?", multiSelect: false, options: [{ label: "A" }] }] },
      { signal: new AbortController().signal, toolUseID: "toolu_q", requestId: "r" } as never,
    );
    await vi.waitFor(() => expect(turn.events.some((e) => e.type === "question")).toBe(true));
    const question = turn.events.find(
      (e): e is Extract<EngineEvent, { type: "question" }> => e.type === "question",
    )!;
    expect(harness.answerQuestion(question.requestId, {})).toBe(true);
    expect(await asked).toMatchObject({ behavior: "deny" });
    await vi.waitFor(() =>
      expect(blocks(turn.events, "question").at(-1)?.patch.status).toBe("cancelled"),
    );
    await harness.dispose();
  });
});

describe("ClaudeHarness — slash command details (R14)", () => {
  it("folds supportedCommands() descriptions and argument hints onto init's names", async () => {
    const fake = makeFakeSdk();
    // `init.slash_commands` is a bare string[]; this control request is where
    // the description and argumentHint live (spike §8.1).
    fake.supportedCommands = [
      { name: "cockpit:pilot", description: "(Cockpit) Pilot", argumentHint: "<what next>" },
      { name: "usage", description: "Show tokens and cost", argumentHint: "", aliases: ["cost"] },
    ];
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.out.push(
      initMessage({
        slash_commands: ["cockpit:pilot", "cost", "context"],
        skills: [],
        plugins: [{ name: "cockpit" }],
      }),
    );

    await vi.waitFor(() => {
      const pilot = harness.listCommands().find((c) => c.name === "/cockpit:pilot");
      expect(pilot?.description).toBe("(Cockpit) Pilot");
    });
    const commands = harness.listCommands();
    // An argumentHint is what stops the composer firing the command with no
    // argument the moment it is selected.
    expect(commands.find((c) => c.name === "/cockpit:pilot")?.argumentHint).toBe("<what next>");
    // `/cost` is an alias of `usage`, so it inherits that entry's description.
    expect(commands.find((c) => c.name === "/cost")?.description).toBe("Show tokens and cost");
    // Nothing said about `/context`: it keeps the bare name rather than lying.
    expect(commands.find((c) => c.name === "/context")?.description).toBe("");
    expect(fake.supportedCommandCalls).toBe(1);
    await harness.dispose();
    await turn.done;
  });

  it("replaces the list when the CLI pushes system/commands_changed", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_1", text: "hi" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.out.push(initMessage({ slash_commands: ["context"], skills: [], plugins: [] }));
    await vi.waitFor(() => expect(harness.listCommands()).toHaveLength(1));
    fake.out.push({
      type: "system",
      subtype: "commands_changed",
      commands: [{ name: "context", description: "Show current context usage", argumentHint: "" }],
    } as never);
    await vi.waitFor(() =>
      expect(harness.listCommands()[0]?.description).toBe("Show current context usage"),
    );
    await harness.dispose();
    await turn.done;
  });
});

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

  it("keeps reported zero-cost knowledge through Claude model deltas and sums", () => {
    const reported = readModelUsage({
      free: { inputTokens: 4, outputTokens: 1, costUSD: 0 },
      missing: { inputTokens: 2, outputTokens: 1 },
    });
    expect(reported.free).toMatchObject({ costUsd: 0, costKnown: true });
    expect(reported.missing).toMatchObject({ costUsd: 0, costKnown: false });

    const delta = deltaUsage({}, reported);
    expect(delta.free?.costKnown).toBe(true);
    expect(delta.missing?.costKnown).toBe(false);
    expect(sumUsage({ free: delta.free! }).costKnown).toBe(true);
    expect(sumUsage(delta).costKnown).toBe(false);
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

  it("[P2-effort] reads a valid effort level and drops anything else", () => {
    expect(readClaudeConfig({ claude: { effort: "low" } })).toEqual({ effort: "low" });
    expect(readClaudeConfig({ claude: { effort: "max" } })).toEqual({ effort: "max" });
    for (const bogus of ["turbo", "LOW", "", 7, null, {}, []]) {
      expect(readClaudeConfig({ claude: { effort: bogus } })).toEqual({});
    }
    // An unknown effort must not take a valid sibling down with it.
    expect(readClaudeConfig({ claude: { effort: "turbo", permissionMode: "plan" } })).toEqual({
      permissionMode: "plan",
    });
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

describe("ClaudeHarness — large tool output (R25)", () => {
  it("keeps the whole value on the block while sending a stub as the output", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake, {}, { maxToolOutputChars: 32 });
    const turn = drain(harness.send({ turnId: "trn_big", text: "read a big file" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    fake.out.push(initMessage());
    fake.out.push(
      assistantMessage("m1", [
        { type: "tool_use", id: "toolu_big", name: "Read", input: { file_path: "big.txt" } },
      ]),
    );
    const whole = `${"a".repeat(64)}THE-TAIL`;
    fake.out.push(toolResultMessage("toolu_big", whole));

    await vi.waitFor(() =>
      expect(blocks(turn.events, "tool_call").some((b) => b.patch.truncated === true)).toBe(true),
    );
    const call = blocks(turn.events, "tool_call").at(-1)!.patch;
    expect(String(call.output)).toContain("more characters");
    expect(String(call.output)).not.toContain("THE-TAIL");
    // SPEC §Edge Cases: "stored whole, sent to the model truncated with a
    // stub" — without this the rest of the value exists nowhere in capygen
    // and R25's expandable stub has nothing to expand into.
    expect(call.fullOutput).toBe(whole);

    fake.out.push(resultMessage("done"));
    await turn.done;
    await harness.dispose();
  });

  it("forgets a turn's tool bookkeeping once it settles", async () => {
    const fake = makeFakeSdk();
    const harness = await start(fake);
    const turn = drain(harness.send({ turnId: "trn_leak", text: "use a tool" }));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    fake.out.push(initMessage());
    fake.out.push(
      assistantMessage("m1", [
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.md" } },
      ]),
    );
    await vi.waitFor(() => expect(blocks(turn.events, "tool_call")).toHaveLength(1));

    const inner = harness as unknown as { toolNames: Map<string, string> };
    expect(inner.toolNames.has("toolu_1")).toBe(true);

    fake.out.push(resultMessage("done"));
    await turn.done;
    // A harness outlives every turn of a session (R15); these entries are only
    // needed while their turn is live.
    expect(inner.toolNames.has("toolu_1")).toBe(false);
    await harness.dispose();
  });
});

/**
 * The API-model harness (SPEC R9, R23, R24, R25, R27, R31, R32).
 *
 * The harness is driven by a **scripted provider**: an array of canned
 * responses, each a list of `ProviderEvent`s, handed out one per round trip.
 * That is the whole test rig — no SDK, no key, no network — and it lets each
 * test say exactly what the model "did" and then assert the blocks, the cards
 * and the usage that came out.
 *
 * The one exception is the cache-control test, which drives the **real**
 * `AnthropicProvider` against a fake client so the assertion lands on the
 * request body that would actually go over the wire (R24), not on a helper.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApiHarness,
  MODEL_PRICES,
  PRICES_ASSUMED_ON,
  apiPriceFor,
  buildSystemPrompt,
  envKeyProvider,
  estimateCost,
  maskKey,
  readThinking,
  resolveApiConfig,
  resolveApiKey,
} from "../src/api/index.js";
import { AnthropicProvider } from "../src/api/providers/anthropic.js";
import type {
  ChatMessage,
  Provider,
  ProviderEvent,
  ProviderRequest,
} from "../src/api/providers/types.js";
import type { EngineEvent, HarnessAgent, HarnessSession } from "../src/harness.js";
import type { Block, PermissionRequest, Question } from "@capygen/shared";

// ---------------------------------------------------------------------------
// rig
// ---------------------------------------------------------------------------

interface Scripted {
  requests: ProviderRequest[];
  provider: Provider;
}

function scriptedProvider(responses: ProviderEvent[][]): Scripted {
  const requests: ProviderRequest[] = [];
  let index = 0;
  const provider: Provider = {
    provider: "anthropic",
    async *stream(request) {
      // Snapshot the messages: the harness mutates its own array in place.
      requests.push({ ...request, messages: request.messages.map(cloneMessage) });
      const events = responses[index] ?? [{ type: "stop", reason: "end_turn" }];
      index += 1;
      for (const event of events) yield event;
    },
  };
  return { requests, provider };
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return { role: message.role, content: message.content.map((block) => ({ ...block })) };
}

function text(t: string): ProviderEvent[] {
  return [
    { type: "text_delta", index: 0, text: t },
    { type: "content", index: 0, block: { type: "text", text: t } },
    {
      type: "usage",
      model: "claude-sonnet-5",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1_000,
        cacheCreationTokens: 0,
      },
    },
    { type: "stop", reason: "end_turn" },
  ];
}

function toolCall(id: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { type: "content", index: 0, block: { type: "tool_use", id, name, input } },
    { type: "stop", reason: "tool_use" },
  ];
}

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "capygen-api-"));
  await fs.writeFile(path.join(root, "notes.txt"), "alpha\nbeta\ngamma\n", "utf8");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const SESSION: HarnessSession = { sessionId: "sess_1", projectPath: "" };

function agent(overrides: Partial<HarnessAgent> = {}): HarnessAgent {
  return {
    agentId: "agent_1",
    name: "Lead",
    backend: "api",
    model: "claude-sonnet-5",
    config: { api: { provider: "anthropic", model: "claude-sonnet-5" } },
    ...overrides,
  };
}

/** Drain a turn's events, feeding cards their answers as they arrive. */
async function runTurn(
  harness: ApiHarness,
  turnId: string,
  responder?: (event: EngineEvent, harness: ApiHarness) => void,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of harness.send({ turnId, text: "go" })) {
    events.push(event);
    responder?.(event, harness);
  }
  return events;
}

/** The last patch emitted for each block key — what the transcript ends up with. */
function finalBlocks(events: EngineEvent[]): Map<string, Partial<Block>> {
  const blocks = new Map<string, Partial<Block>>();
  for (const event of events) {
    if (event.type === "block") blocks.set(event.key, event.patch as Partial<Block>);
  }
  return blocks;
}

function useMcpOff(): { useMcp: false } {
  return { useMcp: false };
}

// ---------------------------------------------------------------------------

describe("a plain text turn", () => {
  it("streams deltas, settles the block, and reports usage with a cost", async () => {
    const { provider, requests } = scriptedProvider([text("Hello there")]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());

    const events = await runTurn(harness, "turn_1");
    const deltas = events.filter(
      (e) => e.type === "block" && e.patch.kind === "text",
    );
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(finalBlocks(events).get("msg:a1:0")).toEqual({ kind: "text", text: "Hello there" });

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({
      backend: "api",
      model: "claude-sonnet-5",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1_000 },
    });
    // 10 in + 5 out + 1000 cache read at the sonnet prices in pricing.ts.
    const cost = (usage as { usage: { costUsd: number } }).usage.costUsd;
    expect(cost).toBeCloseTo((3 * 10 + 15 * 5 + 0.3 * 1_000) / 1_000_000, 12);
    expect(usage?.type === "usage" ? usage.usage.costKnown : undefined).toBe(true);
    expect(events.at(-1)).toEqual({ type: "turn", status: "done" });

    // R24: exactly one request, with the tools the agent was given.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools.map((t) => t.name)).toContain("read_file");
    await harness.dispose();
  });

  it("marks usage from an unpriced API model as unknown cost", async () => {
    const model = "provider/model-without-a-price";
    const response = text("unknown price").map((event) =>
      event.type === "usage" ? { ...event, model } : event,
    );
    const { provider } = scriptedProvider([response]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent({
      model,
      config: { api: { provider: "anthropic", model } },
    }));

    const usage = (await runTurn(harness, "turn_unknown")).find((event) => event.type === "usage");
    expect(usage?.type === "usage" ? usage.usage : null).toMatchObject({
      costUsd: 0,
      costKnown: false,
    });
    await harness.dispose();
  });

  it("keeps the system prompt byte-identical across turns (R24)", async () => {
    const { provider, requests } = scriptedProvider([text("one"), text("two")]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());
    await runTurn(harness, "turn_1");
    await runTurn(harness, "turn_2");

    expect(requests).toHaveLength(2);
    expect(requests[1]?.system).toBe(requests[0]?.system);
    expect(requests[0]?.system).toContain(root);
    // Tool order is part of the cached prefix too.
    expect(requests[1]?.tools.map((t) => t.name)).toEqual(requests[0]?.tools.map((t) => t.name));
    // The second turn carries the first turn's exchange.
    expect(requests[1]?.messages).toHaveLength(3);
    expect(requests[1]?.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "one" }],
    });
    await harness.dispose();
  });

  it("replays a history the desktop hands it, and never reads the database itself", async () => {
    const { provider, requests } = scriptedProvider([text("ok")]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
      loadHistory: () => [
        { role: "user", content: [{ type: "text", text: "earlier" }] },
        { role: "assistant", content: [{ type: "text", text: "earlier reply" }] },
      ],
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());
    await runTurn(harness, "turn_1");
    expect(requests[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    await harness.dispose();
  });
});

describe("the tool loop", () => {
  it("runs read_file then edit_file and feeds each result back", async () => {
    const { provider, requests } = scriptedProvider([
      toolCall("t1", "read_file", { path: "notes.txt" }),
      toolCall("t2", "edit_file", {
        path: "notes.txt",
        old_string: "beta",
        new_string: "BETA",
      }),
      text("Renamed beta."),
    ]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start(
      { ...SESSION, projectPath: root },
      // acceptEdits so the write runs without a card; the deny path is next.
      agent({ permissionMode: "acceptEdits" }),
    );

    const events = await runTurn(harness, "turn_1");
    const blocks = finalBlocks(events);

    expect(blocks.get("tool:t1")).toMatchObject({
      kind: "tool_call",
      name: "read_file",
      status: "success",
      family: "read",
    });
    expect(String((blocks.get("tool:t1") as { output: string }).output)).toContain(
      "     2\tbeta",
    );
    expect(blocks.get("tool:t2")).toMatchObject({
      kind: "tool_call",
      name: "edit_file",
      status: "success",
      family: "edit",
    });
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
    expect(events.at(-1)).toEqual({ type: "turn", status: "done" });

    // Three round trips; each one carries the previous tool_result.
    expect(requests).toHaveLength(3);
    const secondUser = requests[1]?.messages.at(-1);
    expect(secondUser?.content[0]).toMatchObject({ type: "tool_result", toolUseId: "t1" });
    await harness.dispose();
  });

  it("tells the model when it asked for a tool that does not exist", async () => {
    const { provider } = scriptedProvider([toolCall("t1", "no_such_tool", {}), text("sorry")]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());
    const blocks = finalBlocks(await runTurn(harness, "turn_1"));
    expect(blocks.get("tool:t1")).toMatchObject({ status: "error" });
    expect(String((blocks.get("tool:t1") as { output: string }).output)).toContain(
      "No tool named no_such_tool",
    );
    await harness.dispose();
  });

  it("stops at the iteration cap instead of looping forever", async () => {
    const { provider } = scriptedProvider(
      Array.from({ length: 6 }, (_, i) => toolCall(`t${i}`, "list_dir", {})),
    );
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
      maxIterations: 3,
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());
    const events = await runTurn(harness, "turn_1");
    expect(finalBlocks(events).get("error:turn_1")).toMatchObject({
      kind: "error",
      message: "The agent made 3 tool rounds without finishing.",
    });
    expect(events.at(-1)).toEqual({
      type: "turn",
      status: "error",
      error: "tool-call limit reached",
    });
    await harness.dispose();
  });

  it("truncates a huge tool output for the model but keeps it whole on the block (R25)", async () => {
    const big = path.join(root, "big.txt");
    await fs.writeFile(big, "z".repeat(5_000), "utf8");
    const { provider, requests } = scriptedProvider([
      toolCall("t1", "read_file", { path: "big.txt" }),
      text("read it"),
    ]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
      maxToolOutputChars: 200,
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());
    const blocks = finalBlocks(await runTurn(harness, "turn_1"));
    const block = blocks.get("tool:t1") as {
      output: string;
      truncated?: boolean;
      fullOutput?: string;
    };
    expect(block.truncated).toBe(true);
    expect(block.output.length).toBeLessThan(400);
    expect((block.fullOutput ?? "").length).toBeGreaterThan(5_000);
    // What the model actually received is the stub, not the whole file.
    const sent = requests[1]?.messages.at(-1)?.content[0] as { content: string };
    expect(sent.content.length).toBeLessThan(400);
    await harness.dispose();
  });
});

describe("permission cards (R27, R32)", () => {
  it("asks before a write in default mode and denies when the user says no", async () => {
    const { provider, requests } = scriptedProvider([
      toolCall("t1", "write_file", { path: "denied.txt", content: "nope" }),
      text("Understood."),
    ]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());

    const seen: PermissionRequest[] = [];
    const events = await runTurn(harness, "turn_1", (event, h) => {
      if (event.type !== "permission") return;
      seen.push(event.request);
      h.answerPermission(event.requestId, { behavior: "deny", message: "Not this one." });
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolName).toBe("write_file");
    const blocks = finalBlocks(events);
    expect(blocks.get("permission:t1")).toMatchObject({
      kind: "permission",
      decision: { behavior: "deny", scope: "once", message: "Not this one." },
      displayName: "write_file",
    });
    expect(blocks.get("tool:t1")).toMatchObject({ status: "denied" });
    // The file was never written and the model was told why.
    await expect(fs.stat(path.join(root, "denied.txt"))).rejects.toThrow();
    const result = requests[1]?.messages.at(-1)?.content[0] as {
      content: string;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Not this one.");
    await harness.dispose();
  });

  it("runs the tool with the narrowed input when the user edits and allows", async () => {
    const { provider } = scriptedProvider([
      toolCall("t1", "write_file", { path: "wide.txt", content: "wide" }),
      text("done"),
    ]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());
    await runTurn(harness, "turn_1", (event, h) => {
      if (event.type !== "permission") return;
      h.answerPermission(event.requestId, {
        behavior: "allow",
        updatedInput: { path: "narrow.txt", content: "narrow" },
      });
    });
    expect(await fs.readFile(path.join(root, "narrow.txt"), "utf8")).toBe("narrow");
    await expect(fs.stat(path.join(root, "wide.txt"))).rejects.toThrow();
    await harness.dispose();
  });

  it("never asks for a read, and never asks in bypassPermissions", async () => {
    const { provider } = scriptedProvider([
      toolCall("t1", "list_dir", {}),
      toolCall("t2", "write_file", { path: "bypass.txt", content: "ok" }),
      text("done"),
    ]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start(
      { ...SESSION, projectPath: root },
      agent({ permissionMode: "bypassPermissions" }),
    );
    const events = await runTurn(harness, "turn_1");
    expect(events.filter((e) => e.type === "permission")).toHaveLength(0);
    expect(await fs.readFile(path.join(root, "bypass.txt"), "utf8")).toBe("ok");
    await harness.dispose();
  });

  it("denies a write outright in plan mode rather than offering a card", async () => {
    const { provider } = scriptedProvider([
      toolCall("t1", "write_file", { path: "plan.txt", content: "x" }),
      text("Here is the plan."),
    ]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent({ permissionMode: "plan" }));
    const events = await runTurn(harness, "turn_1");
    expect(events.filter((e) => e.type === "permission")).toHaveLength(0);
    expect(finalBlocks(events).get("tool:t1")).toMatchObject({ status: "denied" });
    await expect(fs.stat(path.join(root, "plan.txt"))).rejects.toThrow();
    await harness.dispose();
  });
});

describe("ask_user_question (R32)", () => {
  it("raises a question card, waits, and hands the answer to the model", async () => {
    const { provider, requests } = scriptedProvider([
      toolCall("t1", "ask_user_question", {
        questions: [
          {
            question: "Which database?",
            header: "Storage",
            options: [{ label: "SQLite" }, { label: "Postgres" }],
          },
        ],
        allow_other: false,
      }),
      text("SQLite it is."),
    ]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());

    const asked: Question[][] = [];
    const events = await runTurn(harness, "turn_1", (event, h) => {
      if (event.type !== "question") return;
      asked.push(event.questions);
      h.answerQuestion(event.requestId, { "Which database?": "SQLite" });
    });

    expect(asked[0]?.[0]?.header).toBe("Storage");
    const blocks = finalBlocks(events);
    expect(blocks.get("question:t1")).toMatchObject({
      kind: "question",
      answers: { "Which database?": "SQLite" },
      allowOther: false,
    });
    // The question card *is* the rendering: no duplicate tool_call block.
    expect(blocks.has("tool:t1")).toBe(false);
    // No permission card either — `interaction` is never gated.
    expect(events.filter((e) => e.type === "permission")).toHaveLength(0);

    const answer = requests[1]?.messages.at(-1)?.content[0] as { content: string };
    expect(answer.content).toContain("→ SQLite");
    await harness.dispose();
  });
});

describe("MCP tools and widgets (R31)", () => {
  it("emits a widget block when a tool result carries a ui:// resource", async () => {
    const { provider } = scriptedProvider([
      toolCall("t1", "mcp__demo__card", { title: "Sales" }),
      text("there you go"),
    ]);
    const harness = new ApiHarness({
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
      // A one-server pool whose client is entirely fake.
      mcpPool: fakePool(),
    });
    await harness.start(
      { ...SESSION, projectPath: root },
      agent({ permissionMode: "bypassPermissions" }),
    );
    const blocks = finalBlocks(await runTurn(harness, "turn_1"));

    expect(blocks.get("tool:t1")).toMatchObject({
      kind: "tool_call",
      family: "mcp",
      serverName: "demo",
      status: "success",
    });
    expect(blocks.get("widget:t1")).toMatchObject({
      kind: "widget",
      toolCallId: "t1",
      serverName: "demo",
      toolName: "card",
      resourceUri: "ui://demo/card.html",
      htmlStatus: "pending",
      html: null,
      toolInput: { title: "Sales" },
      meta: { "ui/resourceUri": "ui://demo/card.html" },
    });
    const widget = blocks.get("widget:t1") as { toolResult: { structuredContent?: unknown } };
    expect(widget.toolResult.structuredContent).toEqual({ n: 1 });
    await harness.dispose();
  });
});

/** A pool-shaped double: no SDK, no process, one MCP-App tool. */
function fakePool(): never {
  const tools = [
    {
      name: "card",
      qualifiedName: "mcp__demo__card",
      serverName: "demo",
      description: "a card",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      meta: { "ui/resourceUri": "ui://demo/card.html" },
    },
  ];
  return {
    listAllTools: async () => tools,
    listTools: async () => tools,
    callTool: async () => ({
      content: [{ type: "text", text: "card: Sales" }],
      structuredContent: { n: 1 },
      _meta: { "ui/resourceUri": "ui://demo/card.html" },
    }),
    readResource: async () => [],
    list: () => [],
    enabled: () => [],
    failureReason: () => undefined,
    close: async () => {},
  } as never;
}

describe("interrupting a turn", () => {
  it("ends the turn as interrupted and stops the loop", async () => {
    const { provider, requests } = scriptedProvider([
      toolCall("t1", "list_dir", {}),
      toolCall("t2", "list_dir", {}),
    ]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());

    const events: EngineEvent[] = [];
    const stream = harness.send({ turnId: "turn_1", text: "go" });
    for await (const event of stream) {
      events.push(event);
      if (event.type === "block" && event.patch.kind === "tool_call") {
        await harness.interrupt();
      }
    }
    expect(events.at(-1)).toEqual({ type: "turn", status: "interrupted" });
    expect(requests.length).toBeLessThan(3);
    await harness.dispose();
  });

  it("refuses a second concurrent turn on the same agent", async () => {
    const { provider } = scriptedProvider([text("hi")]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());
    const first = harness.send({ turnId: "turn_1", text: "one" });
    const second = harness.send({ turnId: "turn_2", text: "two" });
    const secondEvents: EngineEvent[] = [];
    for await (const event of second) secondEvents.push(event);
    expect(secondEvents[0]).toMatchObject({ type: "turn", status: "error" });
    for await (const _ of first) void _;
    await harness.dispose();
  });
});

describe("keys (SPEC R21)", () => {
  it("prefers the injected provider and falls back to the environment", async () => {
    expect(
      await resolveApiKey("anthropic", {
        keys: { getKey: () => "from-storage" },
        env: { ANTHROPIC_API_KEY: "from-env" },
      }),
    ).toBe("from-storage");
    expect(
      await resolveApiKey("openai", { keys: { getKey: () => null }, env: { OPENAI_API_KEY: "e" } }),
    ).toBe("e");
    expect(
      await resolveApiKey("openrouter", { env: { OPENROUTER_API_KEY: "  " } }),
    ).toBeNull();
    expect(envKeyProvider({ OPENROUTER_API_KEY: " r " }).getKey("openrouter")).toBe("r");
  });

  it("masks a key to its ends, and only its ends", () => {
    expect(maskKey("sk-ant-api03-abcdefghijklmnop")).toBe("sk-ant…mnop");
    expect(maskKey("short")).toBe("…");
  });

  it("fails the turn with a sentence that names the fix when no key exists", async () => {
    const { provider } = scriptedProvider([text("never reached")]);
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => provider,
      keys: { getKey: () => null },
      env: {},
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());
    const events = await runTurn(harness, "turn_1");
    expect(events.at(-1)).toMatchObject({ type: "turn", status: "error" });
    expect(finalBlocks(events).get("error:turn_1")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Settings ▸ API keys") as unknown as string,
    });
    await harness.dispose();
  });
});

describe("cache_control on the wire (R24)", () => {
  it("appears on the system block and the last tool of the real request body", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: (body: Record<string, unknown>) => {
          bodies.push(body);
          return (async function* () {
            yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
            yield {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "hi" },
            };
            yield { type: "content_block_stop", index: 0 };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
          })();
        },
      },
    };
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => new AnthropicProvider(client),
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent());
    await runTurn(harness, "turn_1");
    await runTurn(harness, "turn_2");

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      const system = body.system as { cache_control?: unknown }[];
      expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
      const tools = body.tools as { name: string; cache_control?: unknown }[];
      expect(tools.at(-1)?.name).toBe("ask_user_question");
      expect(tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
      expect(tools.filter((t) => t.cache_control !== undefined)).toHaveLength(1);
    }
    // The cached prefix (system + tools) is byte-identical between turns.
    expect(JSON.stringify(bodies[1]?.system)).toBe(JSON.stringify(bodies[0]?.system));
    expect(JSON.stringify(bodies[1]?.tools)).toBe(JSON.stringify(bodies[0]?.tools));
    await harness.dispose();
  });
});

/**
 * The live test policy pins `claude-sonnet-5` at `low`. That claim is only true
 * if the effort survives every leg — `agent.config.api.reasoningEffort` →
 * `resolveApiConfig` → `ProviderRequest.reasoningEffort` → the Anthropic body.
 * Asserting the **outbound body** rather than the resolved config is the point:
 * the field used to stop at the provider boundary and be silently dropped, so
 * a policy that said `low` paid the model's default effort instead.
 */
describe("reasoning effort on the wire", () => {
  /**
   * A fake Anthropic client that records every outbound body. No key, no
   * network. Typed as the provider's own first constructor parameter
   * (`AnthropicClientLike`) rather than `unknown`, so the fake is checked
   * against the real seam instead of being cast past it.
   */
  type AnthropicClient = ConstructorParameters<typeof AnthropicProvider>[0];

  function recordingClient(): { bodies: Record<string, unknown>[]; client: AnthropicClient } {
    const bodies: Record<string, unknown>[] = [];
    // Annotated, not cast: the fake has to satisfy the seam structurally, so a
    // change to `AnthropicClientLike` fails here instead of at runtime.
    const client: AnthropicClient = {
      messages: {
        create: (body: Record<string, unknown>) => {
          bodies.push(body);
          return (async function* () {
            yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
            yield { type: "content_block_stop", index: 0 };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
          })();
        },
      },
    };
    return { bodies, client };
  }

  async function bodiesFor(apiConfig: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const { bodies, client } = recordingClient();
    const harness = new ApiHarness({
      ...useMcpOff(),
      createProvider: async () => new AnthropicProvider(client),
      keys: { getKey: () => "sk-test" },
    });
    await harness.start({ ...SESSION, projectPath: root }, agent({ config: { api: apiConfig } }));
    await runTurn(harness, "turn_1");
    await harness.dispose();
    return bodies;
  }

  it("sends the pinned test model at low effort as output_config.effort", async () => {
    const bodies = await bodiesFor({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoningEffort: "low",
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe("claude-sonnet-5");
    expect(bodies[0]?.output_config).toEqual({ effort: "low" });
  });

  it("omits output_config when the agent configures no effort", async () => {
    const bodies = await bodiesFor({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(bodies[0]?.output_config).toBeUndefined();
  });

  it("drops an effort the Messages API does not accept rather than sending it", async () => {
    // `minimal` is valid for OpenAI and invalid for Anthropic; the adapter
    // degrades to the model default instead of failing the turn.
    const bodies = await bodiesFor({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoningEffort: "minimal",
    });
    expect(bodies[0]?.output_config).toBeUndefined();
  });

  it("keeps the cache breakpoints while effort is set", async () => {
    const body = (await bodiesFor({
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoningEffort: "low",
    }))[0]!;
    expect((body.system as { cache_control?: unknown }[])[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect((body.tools as { cache_control?: unknown }[]).at(-1)?.cache_control).toEqual({
      type: "ephemeral",
    });
  });
});

describe("config, prompt and pricing", () => {
  it("uses the agent model and falls back to api config only when it is empty", () => {
    expect(
      resolveApiConfig(
        agent({ model: "gpt-5.6-luna", config: { api: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" } } }),
        {},
      ),
    ).toMatchObject({
      provider: "openrouter",
      model: "gpt-5.6-luna",
      maxTokens: 8_192,
      permissionMode: "default",
    });
    expect(
      resolveApiConfig(
        agent({ model: "", config: { api: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" } } }),
        {},
      ),
    ).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
    expect(resolveApiConfig(agent({ config: null, model: "gpt-5" }), {})).toMatchObject({
      provider: "anthropic",
      model: "gpt-5",
    });
    // The agent's own permissionMode wins over the config's.
    expect(
      resolveApiConfig(
        agent({
          permissionMode: "plan",
          config: { api: { provider: "openai", model: "gpt-5", permissionMode: "bypassPermissions" } },
        }),
        {},
      ).permissionMode,
    ).toBe("plan");
  });

  it("accepts the three ways a thinking budget gets written", () => {
    expect(readThinking(4_096)).toEqual({ type: "enabled", budgetTokens: 4_096 });
    expect(readThinking({ budgetTokens: 2_048 })).toEqual({ type: "enabled", budgetTokens: 2_048 });
    expect(readThinking({ budget_tokens: 1_024 })).toEqual({
      type: "enabled",
      budgetTokens: 1_024,
    });
    expect(readThinking({ type: "disabled" })).toBeUndefined();
    expect(readThinking(undefined)).toBeUndefined();
  });

  it("builds a system prompt with nothing that changes inside a session (R24)", () => {
    const prompt = buildSystemPrompt({ cwd: "C:/repo", platform: "win32", agentName: "Lead" });
    expect(prompt).toContain("C:/repo");
    expect(prompt).toContain("Windows");
    expect(prompt).toContain("PowerShell");
    expect(prompt).toContain('the agent named "Lead"');
    // No date, no turn counter, no file list: those are what break the cache.
    expect(prompt).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(buildSystemPrompt({ cwd: "C:/repo", platform: "win32", agentName: "Lead" })).toBe(
      prompt,
    );
  });

  it("prices by longest prefix, and says when it has no price at all", () => {
    expect(apiPriceFor("claude-sonnet-4-5-20250929")).toEqual(MODEL_PRICES["claude-sonnet-"]);
    // OpenRouter's vendor/model ids resolve to the same row.
    expect(apiPriceFor("anthropic/claude-opus-4.1")).toEqual(MODEL_PRICES["claude-opus-"]);
    expect(apiPriceFor("gpt-5-mini")).toEqual(MODEL_PRICES["gpt-5-mini"]);
    expect(apiPriceFor("some-unknown-model")).toBeNull();
    expect(
      estimateCost("some-unknown-model", {
        inputTokens: 1_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toEqual({ costUsd: 0, isEstimate: false });
    expect(
      estimateCost("claude-sonnet-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toEqual({ costUsd: 0, isEstimate: true });
    // The table is [assumed]; the date it was written is part of the contract.
    expect(PRICES_ASSUMED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

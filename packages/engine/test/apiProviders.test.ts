/**
 * The two provider adapters (SPEC R9, R23, R24).
 *
 * Both are tested the same way: a **recorded stream** — a plain array of the
 * event objects the SDK would yield — driven through the exported mapper, plus
 * an assertion on the request body the adapter builds. No SDK, no key, no
 * network. The recorded shapes come from each API's documented stream events
 * and from the installed `.d.ts` (`@anthropic-ai/sdk` 0.124.0 `Usage`,
 * `openai` 7.10.0 `ResponseUsage`), which is where the two usage conventions
 * this file pins down were read from.
 */
import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  CACHE_CONTROL_EPHEMERAL,
  DEFAULT_BASE_URLS,
  OPENROUTER_BASE_URL,
  OpenAiProvider,
  anthropicMessages,
  anthropicStopReason,
  anthropicUsage,
  buildAnthropicBody,
  buildOpenAiBody,
  clientOptions,
  createProvider,
  mapAnthropicStream,
  mapOpenAiStream,
  openaiInput,
  openaiUsage,
  supportsReasoning,
  type ChatMessage,
  type ProviderEvent,
  type ProviderRequest,
  type ToolSchema,
} from "../src/api/providers/index.js";

const TOOLS: ToolSchema[] = [
  { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
  { name: "bash", description: "run", parameters: { type: "object", properties: {} } },
];

const MESSAGES: ChatMessage[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "claude-sonnet-5",
    system: "SYSTEM PROMPT",
    tools: TOOLS,
    messages: MESSAGES,
    maxTokens: 1_000,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

async function* replay(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe("the Anthropic request body (SPEC R24)", () => {
  it("puts cache_control on the system block and on the LAST tool", () => {
    const body = buildAnthropicBody(request());
    const system = body.system as { type: string; text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(1);
    expect(system[0]?.text).toBe("SYSTEM PROMPT");
    expect(system[0]?.cache_control).toEqual(CACHE_CONTROL_EPHEMERAL);

    const tools = body.tools as { name: string; cache_control?: unknown }[];
    expect(tools.map((t) => t.name)).toEqual(["read_file", "bash"]);
    // One breakpoint covers the whole prefix; marking every tool would spend
    // three of the four available for no extra coverage.
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual(CACHE_CONTROL_EPHEMERAL);
  });

  it("uses input_schema, not parameters, and always streams", () => {
    const body = buildAnthropicBody(request());
    const tools = body.tools as { input_schema?: unknown; parameters?: unknown }[];
    expect(tools[0]?.input_schema).toEqual({ type: "object", properties: {} });
    expect(tools[0]?.parameters).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1_000);
  });

  it("omits the tools key entirely when there are none", () => {
    expect(buildAnthropicBody(request({ tools: [] })).tools).toBeUndefined();
  });

  it("sends thinking when it is configured", () => {
    const body = buildAnthropicBody(
      request({ thinking: { type: "enabled", budgetTokens: 4_096 } }),
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4_096 });
  });

  it("maps tool_use and tool_result blocks, and drops unsigned thinking", () => {
    const mapped = anthropicMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "no signature" },
          { type: "thinking", thinking: "signed", signature: "sig" },
          { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "toolu_1", content: "ok" },
          { type: "tool_result", toolUseId: "toolu_2", content: "bad", isError: true },
        ],
      },
    ]) as { role: string; content: Record<string, unknown>[] }[];

    expect(mapped[0]?.content).toEqual([
      { type: "thinking", thinking: "signed", signature: "sig" },
      { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } },
    ]);
    expect(mapped[1]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "ok",
    });
    expect(mapped[1]?.content[1]?.is_error).toBe(true);
  });
});

describe("the Anthropic stream mapper", () => {
  it("turns a text + tool_use response into deltas, settled blocks, usage and stop", async () => {
    const events = await collect(
      mapAnthropicStream(
        replay([
          {
            type: "message_start",
            message: {
              id: "msg_1",
              model: "claude-sonnet-5",
              usage: {
                input_tokens: 12,
                output_tokens: 0,
                cache_read_input_tokens: 900,
                cache_creation_input_tokens: 100,
              },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_9", name: "read_file", input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"path":' },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 42 },
          },
          { type: "message_stop" },
        ]),
        "fallback",
      ),
    );

    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text))
      .toEqual(["Hel", "lo"]);
    const content = events.filter((e) => e.type === "content");
    expect(content[0]).toEqual({ type: "content", index: 0, block: { type: "text", text: "Hello" } });
    expect(content[1]).toEqual({
      type: "content",
      index: 1,
      block: { type: "tool_use", id: "toolu_9", name: "read_file", input: { path: "a.ts" } },
    });
    expect(events.at(-2)).toEqual({
      type: "usage",
      model: "claude-sonnet-5",
      usage: {
        inputTokens: 12,
        outputTokens: 42,
        cacheReadTokens: 900,
        cacheCreationTokens: 100,
      },
    });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("carries a thinking block's signature through the signature_delta", async () => {
    const events = await collect(
      mapAnthropicStream(
        replay([
          { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "hmm" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "abc" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]),
        "m",
      ),
    );
    expect(events).toContainEqual({
      type: "content",
      index: 0,
      block: { type: "thinking", thinking: "hmm", signature: "abc" },
    });
  });

  it("settles a block the stream never closed, rather than losing the text", async () => {
    const events = await collect(
      mapAnthropicStream(
        replay([
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut" } },
        ]),
        "m",
      ),
    );
    expect(events).toContainEqual({
      type: "content",
      index: 0,
      block: { type: "text", text: "cut" },
    });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "other" });
  });

  it("survives a truncated tool input instead of throwing", async () => {
    const events = await collect(
      mapAnthropicStream(
        replay([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "t", name: "bash" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"command":' },
          },
          { type: "content_block_stop", index: 0 },
        ]),
        "m",
      ),
    );
    expect(events[0]).toEqual({
      type: "content",
      index: 0,
      block: { type: "tool_use", id: "t", name: "bash", input: {} },
    });
  });

  it("reads Anthropic usage as uncached input", () => {
    expect(
      anthropicUsage({
        input_tokens: 5,
        output_tokens: 6,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: 7,
      }),
    ).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheCreationTokens: 7,
    });
  });

  it("maps every stop reason it is given", () => {
    expect(anthropicStopReason("end_turn")).toBe("end_turn");
    expect(anthropicStopReason("stop_sequence")).toBe("end_turn");
    expect(anthropicStopReason("tool_use")).toBe("tool_use");
    expect(anthropicStopReason("max_tokens")).toBe("max_tokens");
    expect(anthropicStopReason("refusal")).toBe("refusal");
    expect(anthropicStopReason("something_new")).toBe("other");
  });

  it("passes the abort signal to the client", async () => {
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const provider = new AnthropicProvider({
      messages: {
        create: (_body, options) => {
          seen = options?.signal;
          return replay([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]);
        },
      },
    });
    await collect(provider.stream(request({ signal: controller.signal })));
    expect(seen).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// OpenAI / OpenRouter
// ---------------------------------------------------------------------------

describe("the OpenAI request body", () => {
  it("sends the system prompt as instructions and the tools as function tools", () => {
    const body = buildOpenAiBody(request({ model: "gpt-5" }));
    expect(body.instructions).toBe("SYSTEM PROMPT");
    expect(body.stream).toBe(true);
    // Every request is self-contained: no server-side conversation state.
    expect(body.store).toBe(false);
    const tools = body.tools as { type: string; name: string; strict: boolean }[];
    expect(tools[0]).toEqual({
      type: "function",
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: {} },
      strict: false,
    });
  });

  it("sends reasoning effort only for models that accept it", () => {
    expect(supportsReasoning("gpt-5")).toBe(true);
    expect(supportsReasoning("o4-mini")).toBe(true);
    expect(supportsReasoning("openai/gpt-5-mini")).toBe(true);
    expect(supportsReasoning("gpt-4o")).toBe(false);

    expect(buildOpenAiBody(request({ model: "gpt-5", reasoningEffort: "high" })).reasoning).toEqual(
      { effort: "high" },
    );
    expect(
      buildOpenAiBody(request({ model: "gpt-4o", reasoningEffort: "high" })).reasoning,
    ).toBeUndefined();
  });

  it("replays a tool loop as function_call / function_call_output items keyed by call_id", () => {
    const items = openaiInput([
      { role: "user", content: [{ type: "text", text: "do it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "call_abc", name: "bash", input: { command: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_abc", content: "ok" }] },
    ]) as Record<string, unknown>[];

    expect(items[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "do it" }] });
    expect(items[1]).toEqual({
      role: "assistant",
      content: [{ type: "output_text", text: "on it" }],
    });
    expect(items[2]).toEqual({
      type: "function_call",
      call_id: "call_abc",
      name: "bash",
      arguments: '{"command":"ls"}',
    });
    expect(items[3]).toEqual({
      type: "function_call_output",
      call_id: "call_abc",
      output: "ok",
    });
  });
});

describe("the OpenAI stream mapper", () => {
  it("turns a text + function_call response into deltas, blocks, usage and stop", async () => {
    const events = await collect(
      mapOpenAiStream(
        replay([
          { type: "response.created", response: { model: "gpt-5" } },
          { type: "response.output_text.delta", output_index: 0, delta: "Hel" },
          { type: "response.output_text.delta", output_index: 0, delta: "lo" },
          { type: "response.output_text.done", output_index: 0, text: "Hello" },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "read_file",
              arguments: '{"path":"a.ts"}',
            },
          },
          {
            type: "response.completed",
            response: {
              model: "gpt-5",
              status: "completed",
              output: [{ type: "function_call" }],
              usage: {
                input_tokens: 1_000,
                output_tokens: 20,
                input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 },
              },
            },
          },
        ]),
        "fallback",
      ),
    );

    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text))
      .toEqual(["Hel", "lo"]);
    expect(events).toContainEqual({
      type: "content",
      index: 1,
      // `call_id`, not the item id: that is what function_call_output must echo.
      block: { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
    });
    expect(events.at(-2)).toEqual({
      type: "usage",
      model: "gpt-5",
      usage: {
        // 1000 total input − 800 cached = 200 billed at the input rate.
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 800,
        cacheCreationTokens: 0,
      },
    });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("maps reasoning deltas to thinking", async () => {
    const events = await collect(
      mapOpenAiStream(
        replay([
          { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "think" },
          { type: "response.reasoning_summary_text.done", output_index: 0, text: "thinking" },
          { type: "response.completed", response: { status: "completed", output: [] } },
        ]),
        "m",
      ),
    );
    expect(events[0]).toEqual({ type: "thinking_delta", index: 0, text: "think" });
    expect(events[1]).toEqual({
      type: "content",
      index: 0,
      block: { type: "thinking", thinking: "thinking" },
    });
  });

  it("reports an incomplete response as max_tokens", async () => {
    const events = await collect(
      mapOpenAiStream(
        replay([
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [],
            },
          },
        ]),
        "m",
      ),
    );
    expect(events.at(-1)).toEqual({ type: "stop", reason: "max_tokens" });
  });

  it("surfaces a failed response as an error event", async () => {
    const events = await collect(
      mapOpenAiStream(
        replay([
          { type: "response.failed", response: { error: { message: "rate limited" } } },
        ]),
        "m",
      ),
    );
    expect(events[0]).toEqual({ type: "error", message: "rate limited" });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "other" });
  });

  it("subtracts cached and cache-written tokens from OpenAI's inclusive input count", () => {
    expect(
      openaiUsage({
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
      }),
    ).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 60,
      cacheCreationTokens: 20,
    });
    // Never negative, whatever the API reports.
    expect(
      openaiUsage({ input_tokens: 5, input_tokens_details: { cached_tokens: 50 } }).inputTokens,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

describe("createProvider", () => {
  it("gives OpenRouter the OpenAI protocol at its own base URL with the app headers", () => {
    expect(clientOptions({ provider: "openrouter", apiKey: "k" })).toEqual({
      apiKey: "k",
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/leobbaroni/capygen",
        "X-Title": "capygen",
      },
    });
    expect(clientOptions({ provider: "openai", apiKey: "k" })).toEqual({
      apiKey: "k",
      baseURL: DEFAULT_BASE_URLS.openai,
    });
    // Anthropic's SDK has its own default; only override it when asked.
    expect(clientOptions({ provider: "anthropic", apiKey: "k" })).toEqual({ apiKey: "k" });
    expect(clientOptions({ provider: "anthropic", apiKey: "k", baseUrl: "https://gw" })).toEqual({
      apiKey: "k",
      baseURL: "https://gw",
    });
  });

  it("tags the provider so usage rows can tell OpenAI and OpenRouter apart", async () => {
    const openaiClient = { responses: { create: () => replay([]) } };
    const router = await createProvider({ provider: "openrouter", apiKey: "k", openaiClient });
    const openai = await createProvider({ provider: "openai", apiKey: "k", openaiClient });
    expect(router.provider).toBe("openrouter");
    expect(router.baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(openai.provider).toBe("openai");
    expect(openai instanceof OpenAiProvider).toBe(true);

    const anthropic = await createProvider({
      provider: "anthropic",
      apiKey: "k",
      anthropicClient: { messages: { create: () => replay([]) } },
    });
    expect(anthropic instanceof AnthropicProvider).toBe(true);
    expect(anthropic.provider).toBe("anthropic");
  });
});

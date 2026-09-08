/**
 * The OpenAI provider: the **Responses** API, streaming, function tools,
 * reasoning effort. Also serves OpenRouter, which is the same wire protocol
 * behind a different base URL (`providers/index.ts` builds both).
 *
 * Responses, not Chat Completions, for one reason that matters to SPEC R24:
 * Responses does server-side prompt caching on the prefix automatically (there
 * is no `cache_control` to set — `usage.input_tokens_details.cached_tokens`
 * reports what hit), and it is the only OpenAI API that carries reasoning items
 * across a tool loop. `store: false` keeps every request self-contained: a
 * desktop app that reconstructs the conversation from its own SQLite must not
 * also depend on a server-side conversation id it cannot see.
 *
 * Two shape differences from Anthropic that this adapter absorbs:
 *
 *  - a tool call is identified by **`call_id`**, not the item id, and that is
 *    the id `function_call_output` must echo. `ChatContent.tool_use.id` holds
 *    the `call_id` so the neutral loop needs to know nothing about it.
 *  - `usage.input_tokens` **includes** the cached tokens, unlike Anthropic's.
 *    `openaiUsage` subtracts them so the price table always receives
 *    "uncached input" (`providers/types.ts` `RawUsage`).
 */
import type { ApiProvider } from "@capygen/shared";
import {
  ZERO_USAGE,
  isRecord,
  num,
  str,
  type ChatMessage,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
  type RawUsage,
  type StopReason,
  type ToolSchema,
} from "./types.js";

export interface OpenAiClientLike {
  responses: {
    create(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  };
}

/** Models that take `reasoning.effort`. Everything else rejects the field. */
export function supportsReasoning(model: string): boolean {
  const id = model.toLowerCase();
  return (
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.startsWith("gpt-5") ||
    id.includes("/o1") ||
    id.includes("/o3") ||
    id.includes("/o4") ||
    id.includes("/gpt-5")
  );
}

export function openaiTools(tools: readonly ToolSchema[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // `strict` demands every property be required and `additionalProperties`
    // false; our schemas have optional arguments on purpose, so it stays off.
    strict: false,
  }));
}

/**
 * Our neutral messages → Responses `input` items.
 *
 * Assistant text is replayed as `output_text`, tool calls as `function_call`
 * and results as `function_call_output` — the three item types the Responses
 * API accepts back as input. `thinking` blocks are **not** replayed: an
 * encrypted reasoning item can only be sent back with the exact opaque payload
 * the API issued, which our neutral vocabulary does not carry, and a plain-text
 * imitation would be rejected.
 */
export function openaiInput(messages: readonly ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    const textParts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.length > 0) textParts.push(block.text);
        continue;
      }
      if (block.type === "image") {
        // Images ride with the text they were sent with, so the collected text
        // is flushed into the *same* message rather than a separate one.
        const text = textParts.join("\n");
        textParts.length = 0;
        out.push({
          role: message.role,
          content: [
            ...(text ? [{ type: "input_text", text }] : []),
            { type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}` },
          ],
        });
        continue;
      }
      if (block.type === "tool_use") {
        // Flush any text collected before this call so ordering survives.
        flushText(out, message.role, textParts);
        out.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
        continue;
      }
      if (block.type === "tool_result") {
        flushText(out, message.role, textParts);
        out.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: block.content,
        });
        continue;
      }
    }
    flushText(out, message.role, textParts);
  }
  return out;
}

function flushText(out: unknown[], role: "user" | "assistant", parts: string[]): void {
  if (parts.length === 0) return;
  const text = parts.join("\n");
  parts.length = 0;
  out.push({
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  });
}

export function buildOpenAiBody(request: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    instructions: request.system,
    input: openaiInput(request.messages),
    max_output_tokens: request.maxTokens,
    stream: true,
    store: false,
  };
  if (request.tools.length > 0) {
    body.tools = openaiTools(request.tools);
    body.tool_choice = "auto";
  }
  if (request.reasoningEffort && supportsReasoning(request.model)) {
    body.reasoning = { effort: request.reasoningEffort };
  }
  return body;
}

/** `response.usage` → our counts, with the cached tokens taken back out of
 * `input_tokens` (see the file header). */
export function openaiUsage(raw: unknown): RawUsage {
  if (!isRecord(raw)) return { ...ZERO_USAGE };
  const details = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const cacheRead = num(details.cached_tokens);
  const cacheWrite = num(details.cache_write_tokens);
  const total = num(raw.input_tokens);
  return {
    inputTokens: Math.max(0, total - cacheRead - cacheWrite),
    outputTokens: num(raw.output_tokens),
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
  };
}

export function openaiStopReason(response: unknown): StopReason {
  if (!isRecord(response)) return "other";
  const status = str(response.status);
  if (status === "incomplete") {
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
    return str(details.reason) === "max_output_tokens" ? "max_tokens" : "other";
  }
  if (status !== "completed") return "other";
  const output = Array.isArray(response.output) ? response.output : [];
  const hasCall = output.some((item) => isRecord(item) && str(item.type) === "function_call");
  if (hasCall) return "tool_use";
  const refused = output.some(
    (item) =>
      isRecord(item) &&
      Array.isArray(item.content) &&
      item.content.some((part) => isRecord(part) && str(part.type) === "refusal"),
  );
  return refused ? "refusal" : "end_turn";
}

/**
 * Raw Responses stream → `ProviderEvent`s. Exported for the same reason the
 * Anthropic mapper is: a recorded event array is the whole test fixture.
 */
export async function* mapOpenAiStream(
  events: AsyncIterable<unknown>,
  fallbackModel: string,
): AsyncGenerator<ProviderEvent> {
  let model = fallbackModel;
  let usage: RawUsage | null = null;
  let stop: StopReason | null = null;
  let errored = false;

  for await (const raw of events) {
    if (!isRecord(raw)) continue;
    const type = str(raw.type);
    const index = num(raw.output_index);

    switch (type) {
      case "response.created":
      case "response.in_progress": {
        const response = isRecord(raw.response) ? raw.response : {};
        model = str(response.model) ?? model;
        break;
      }
      case "response.output_text.delta": {
        const text = str(raw.delta);
        if (text) yield { type: "text_delta", index, text };
        break;
      }
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        const text = str(raw.delta);
        if (text) yield { type: "thinking_delta", index, text };
        break;
      }
      case "response.output_text.done": {
        const text = str(raw.text);
        if (text) yield { type: "content", index, block: { type: "text", text } };
        break;
      }
      case "response.reasoning_text.done":
      case "response.reasoning_summary_text.done": {
        const text = str(raw.text);
        if (text) yield { type: "content", index, block: { type: "thinking", thinking: text } };
        break;
      }
      case "response.output_item.done": {
        const item = isRecord(raw.item) ? raw.item : {};
        if (str(item.type) !== "function_call") break;
        yield {
          type: "content",
          index,
          block: {
            type: "tool_use",
            // `call_id` is what `function_call_output` must echo; the item's
            // own `id` is not accepted there.
            id: str(item.call_id) ?? str(item.id) ?? "",
            name: str(item.name) ?? "",
            input: parseArguments(item.arguments),
          },
        };
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = isRecord(raw.response) ? raw.response : {};
        model = str(response.model) ?? model;
        usage = openaiUsage(response.usage);
        stop = openaiStopReason(response);
        break;
      }
      case "response.failed":
      case "error": {
        const response = isRecord(raw.response) ? raw.response : {};
        const error = isRecord(response.error)
          ? response.error
          : isRecord(raw.error)
            ? raw.error
            : {};
        errored = true;
        yield {
          type: "error",
          message: str(error.message) ?? str(raw.message) ?? "the provider reported an error",
        };
        break;
      }
      default:
        break;
    }
  }

  if (usage) yield { type: "usage", model, usage };
  yield { type: "stop", reason: stop ?? (errored ? "other" : "end_turn") };
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export class OpenAiProvider implements Provider {
  readonly provider: ApiProvider;
  readonly baseUrl: string | undefined;
  private readonly client: OpenAiClientLike;

  constructor(client: OpenAiClientLike, provider: ApiProvider = "openai", baseUrl?: string) {
    this.client = client;
    this.provider = provider;
    this.baseUrl = baseUrl;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const body = buildOpenAiBody(request);
    const events = await this.client.responses.create(
      body,
      request.signal ? { signal: request.signal } : undefined,
    );
    yield* mapOpenAiStream(events, request.model);
  }
}

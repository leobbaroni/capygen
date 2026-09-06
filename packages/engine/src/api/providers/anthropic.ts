/**
 * The Anthropic provider: Messages API, streaming, tools, prompt caching.
 *
 * **SPEC R24 lives here.** All four `cache_control: {type:"ephemeral"}`
 * breakpoints Anthropic allows are written into every request body:
 *
 *   1. on the single system text block,
 *   2. on the **last** tool definition,
 *   3. on the last content block of the **last** message, and
 *   4. on the last content block of the message before it.
 *
 * Anthropic caches a *prefix*, and a breakpoint caches everything up to and
 * including the block it is on — so a marker on the last tool covers the whole
 * `tools` array plus the system prompt in front of it. Marking every tool would
 * spend breakpoints for no extra coverage. Both the prompt
 * (`buildSystemPrompt`, built once per session) and the tool array (stable
 * order, `builtinTools`) are byte-identical across the turns of a session,
 * which is the only reason the cache ever hits.
 *
 * The two **message** breakpoints are the ones that make a long session
 * affordable, and they were missing: with breakpoints only on system+tools the
 * cached prefix stopped where the conversation started, so every byte of
 * `messages` was re-billed at the full input rate on every request — on each
 * of the up to 24 tool-loop round trips inside a single turn, and again on
 * every later turn of the session (`ApiHarness.messages` only grows). The
 * trailing pair is Anthropic's documented conversation pattern: the last
 * breakpoint *writes* the cache covering the whole history, and the one behind
 * it *reads* what the previous request wrote.
 *
 * The client is reached through `AnthropicClientLike` rather than the SDK's own
 * types. The SDK types the stream through generated unions whose members change
 * between minor versions (the Codex harness hit exactly that), and a structural
 * interface stating the six fields this file reads is both more honest and
 * trivially fakeable in a test.
 */
import type { ApiProvider } from "@capygen/shared";
import {
  ZERO_USAGE,
  isRecord,
  num,
  str,
  type ChatContent,
  type ChatMessage,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
  type RawUsage,
  type StopReason,
  type ToolSchema,
} from "./types.js";

/** The one call this provider makes. `create` with `stream:true` resolves to
 * an async iterable of raw stream events (`@anthropic-ai/sdk` `Stream`). */
export interface AnthropicClientLike {
  messages: {
    create(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  };
}

export const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" } as const;

/** `system` is always an array so the cache breakpoint has a block to sit on. */
export function anthropicSystem(system: string): unknown[] {
  return [{ type: "text", text: system, cache_control: CACHE_CONTROL_EPHEMERAL }];
}

/** Tool definitions with the breakpoint on the last one (see the file header). */
export function anthropicTools(tools: readonly ToolSchema[]): unknown[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(index === tools.length - 1 ? { cache_control: CACHE_CONTROL_EPHEMERAL } : {}),
  }));
}

/**
 * Our neutral messages → Anthropic content blocks.
 *
 * A `thinking` block without its `signature` is dropped: the API rejects a
 * replayed thinking block that cannot be verified, and losing the visible
 * reasoning from an earlier turn is much cheaper than losing the turn.
 */
export function anthropicMessages(messages: readonly ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    const content: unknown[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text.length > 0) content.push({ type: "text", text: block.text });
          break;
        case "thinking":
          if (block.signature) {
            content.push({
              type: "thinking",
              thinking: block.thinking,
              signature: block.signature,
            });
          }
          break;
        case "tool_use":
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          });
          break;
        case "tool_result":
          content.push({
            type: "tool_result",
            tool_use_id: block.toolUseId,
            content: block.content,
            ...(block.isError ? { is_error: true } : {}),
          });
          break;
      }
    }
    if (content.length > 0) out.push({ role: message.role, content });
  }
  return markMessageCacheBreakpoints(out);
}

/** How many trailing messages carry a cache breakpoint (see the file header). */
export const MESSAGE_CACHE_BREAKPOINTS = 2;

/**
 * Put a `cache_control` marker on the last content block of each of the final
 * {@link MESSAGE_CACHE_BREAKPOINTS} messages. Exported so the request-capture
 * test can assert it on the real body rather than on an intention.
 */
export function markMessageCacheBreakpoints(messages: unknown[]): unknown[] {
  const start = Math.max(0, messages.length - MESSAGE_CACHE_BREAKPOINTS);
  for (let i = start; i < messages.length; i += 1) {
    const message = messages[i] as { content?: unknown[] } | undefined;
    const content = message?.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    const last = content[content.length - 1];
    if (!isRecord(last)) continue;
    content[content.length - 1] = { ...last, cache_control: CACHE_CONTROL_EPHEMERAL };
  }
  return messages;
}

export function buildAnthropicBody(request: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: anthropicSystem(request.system),
    messages: anthropicMessages(request.messages),
    stream: true,
  };
  if (request.tools.length > 0) body.tools = anthropicTools(request.tools);
  if (request.thinking) {
    body.thinking = { type: "enabled", budget_tokens: request.thinking.budgetTokens };
  }
  return body;
}

/** `message.usage` → our counts. Anthropic's `input_tokens` already **excludes**
 * cached tokens, so it is the uncached input the price table wants. */
export function anthropicUsage(raw: unknown): RawUsage {
  if (!isRecord(raw)) return { ...ZERO_USAGE };
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
    cacheCreationTokens: num(raw.cache_creation_input_tokens),
  };
}

export function anthropicStopReason(raw: unknown): StopReason {
  switch (str(raw)) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

interface OpenBlock {
  type: string;
  text: string;
  signature?: string;
  id?: string;
  name?: string;
  /** `input_json_delta` arrives as partial JSON text, parsed at block stop. */
  partialJson: string;
}

/**
 * Turn one raw Anthropic stream into `ProviderEvent`s.
 *
 * Split out of `stream()` so a test can drive it from a recorded array of
 * events without a client, a key or a network — which is what
 * `test/apiProviders.test.ts` does.
 */
export async function* mapAnthropicStream(
  events: AsyncIterable<unknown>,
  fallbackModel: string,
): AsyncGenerator<ProviderEvent> {
  const open = new Map<number, OpenBlock>();
  let model = fallbackModel;
  let usage: RawUsage = { ...ZERO_USAGE };
  let sawUsage = false;
  let stop: StopReason | null = null;

  for await (const raw of events) {
    if (!isRecord(raw)) continue;
    const type = str(raw.type);

    if (type === "message_start") {
      const message = isRecord(raw.message) ? raw.message : {};
      model = str(message.model) ?? model;
      usage = anthropicUsage(message.usage);
      sawUsage = true;
      continue;
    }

    if (type === "content_block_start") {
      const index = num(raw.index);
      const block = isRecord(raw.content_block) ? raw.content_block : {};
      open.set(index, {
        type: str(block.type) ?? "text",
        text: str(block.text) ?? str(block.thinking) ?? "",
        ...(str(block.signature) ? { signature: str(block.signature) as string } : {}),
        ...(str(block.id) ? { id: str(block.id) as string } : {}),
        ...(str(block.name) ? { name: str(block.name) as string } : {}),
        partialJson: "",
      });
      continue;
    }

    if (type === "content_block_delta") {
      const index = num(raw.index);
      const entry = open.get(index);
      const delta = isRecord(raw.delta) ? raw.delta : {};
      const deltaType = str(delta.type);
      if (!entry) continue;
      if (deltaType === "text_delta" && typeof delta.text === "string") {
        entry.text += delta.text;
        yield { type: "text_delta", index, text: delta.text };
      } else if (deltaType === "thinking_delta" && typeof delta.thinking === "string") {
        entry.text += delta.thinking;
        yield { type: "thinking_delta", index, text: delta.thinking };
      } else if (deltaType === "signature_delta" && typeof delta.signature === "string") {
        entry.signature = (entry.signature ?? "") + delta.signature;
      } else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
        entry.partialJson += delta.partial_json;
      }
      continue;
    }

    if (type === "content_block_stop") {
      const index = num(raw.index);
      const entry = open.get(index);
      open.delete(index);
      if (!entry) continue;
      const settled = settleBlock(entry);
      if (settled) yield { type: "content", index, block: settled };
      continue;
    }

    if (type === "message_delta") {
      const delta = isRecord(raw.delta) ? raw.delta : {};
      stop = anthropicStopReason(delta.stop_reason);
      // `message_delta.usage` carries the final output count (and, on some
      // models, a corrected input count); merge rather than replace.
      const tail = anthropicUsage(raw.usage);
      usage = {
        inputTokens: tail.inputTokens || usage.inputTokens,
        outputTokens: tail.outputTokens || usage.outputTokens,
        cacheReadTokens: tail.cacheReadTokens || usage.cacheReadTokens,
        cacheCreationTokens: tail.cacheCreationTokens || usage.cacheCreationTokens,
      };
      sawUsage = true;
      continue;
    }

    if (type === "error") {
      const error = isRecord(raw.error) ? raw.error : {};
      yield { type: "error", message: str(error.message) ?? "the provider reported an error" };
      continue;
    }
  }

  // Anything still open means the stream was cut mid-block; settle it anyway so
  // partial text is not silently lost.
  for (const [index, entry] of open) {
    const settled = settleBlock(entry);
    if (settled) yield { type: "content", index, block: settled };
  }
  if (sawUsage) yield { type: "usage", model, usage };
  yield { type: "stop", reason: stop ?? "other" };
}

function settleBlock(entry: OpenBlock): ChatContent | null {
  if (entry.type === "text") {
    return entry.text.length > 0 ? { type: "text", text: entry.text } : null;
  }
  if (entry.type === "thinking") {
    return {
      type: "thinking",
      thinking: entry.text,
      ...(entry.signature ? { signature: entry.signature } : {}),
    };
  }
  if (entry.type === "tool_use") {
    return {
      type: "tool_use",
      id: entry.id ?? "",
      name: entry.name ?? "",
      input: parseJsonOrEmpty(entry.partialJson),
    };
  }
  // `redacted_thinking` and anything the API adds later: nothing renderable.
  return null;
}

function parseJsonOrEmpty(text: string): unknown {
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    // A truncated tool input is the model's problem to notice, not a crash.
    return {};
  }
}

export class AnthropicProvider implements Provider {
  readonly provider: ApiProvider = "anthropic";
  readonly baseUrl: string | undefined;
  private readonly client: AnthropicClientLike;

  constructor(client: AnthropicClientLike, baseUrl?: string) {
    this.client = client;
    this.baseUrl = baseUrl;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const body = buildAnthropicBody(request);
    const events = await this.client.messages.create(
      body,
      request.signal ? { signal: request.signal } : undefined,
    );
    yield* mapAnthropicStream(events, request.model);
  }
}

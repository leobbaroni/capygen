/**
 * The provider seam: one provider-neutral request/event vocabulary that both
 * the Anthropic Messages API and the OpenAI Responses API are translated into.
 *
 * Why not just use each SDK's own types in the loop? Because the agent loop, the
 * permission gate, the tool runtime and the usage accounting are identical for
 * all three providers, and duplicating them per provider is how the second
 * provider quietly grows different permission behaviour. Everything
 * provider-shaped lives behind `Provider.stream`; everything else is shared.
 *
 * The vocabulary is closer to Anthropic's than to OpenAI's (content blocks,
 * `tool_use`/`tool_result`) because it is the shape capygen's `Block` union
 * already speaks — the OpenAI adapter is the one doing the translating.
 */
import type { ApiProvider } from "@capygen/shared";

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export type ChatContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ChatContent[];
}

export interface ThinkingConfig {
  type: "enabled";
  budgetTokens: number;
}

export interface ProviderRequest {
  model: string;
  /** The stable session prompt (R24). Never rebuilt between turns. */
  system: string;
  tools: ToolSchema[];
  messages: ChatMessage[];
  maxTokens: number;
  /** Anthropic extended thinking. */
  thinking?: ThinkingConfig | undefined;
  /**
   * Reasoning effort, honoured by both adapters: OpenAI sends it as
   * `reasoning.effort` (`minimal` | `low` | `medium` | `high`), Anthropic as
   * `output_config.effort` (`low` | `medium` | `high` | `xhigh` | `max`).
   * Free-form here because the two vocabularies differ; each adapter drops a
   * value its own API does not accept rather than failing the turn.
   */
  reasoningEffort?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface RawUsage {
  /** Uncached input tokens only — each adapter normalises to this. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export const ZERO_USAGE: RawUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export type ProviderEvent =
  /** Streaming text for content block `index`; `text` is the delta only. */
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  /** A settled content block. Tool calls only ever arrive this way. */
  | { type: "content"; index: number; block: ChatContent }
  | { type: "usage"; model: string; usage: RawUsage }
  | { type: "stop"; reason: StopReason }
  /** The provider reported an error mid-stream (not a transport failure). */
  | { type: "error"; message: string };

export interface Provider {
  readonly provider: ApiProvider;
  /** The resolved base URL, for the diagnostics pane. Never contains a key. */
  readonly baseUrl?: string | undefined;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

/** Assistant content, in order, as the loop rebuilt it from a stream. */
export function assistantMessageFrom(blocks: ChatContent[]): ChatMessage {
  return { role: "assistant", content: blocks };
}

export function addRawUsage(a: RawUsage, b: RawUsage): RawUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

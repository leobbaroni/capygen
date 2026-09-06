/**
 * Cost accounting for `api`-backend turns (SPEC R23).
 *
 * The Claude harness gets `costUSD` from the SDK; the raw provider APIs return
 * token counts and nothing else, so capygen multiplies them itself.
 *
 * **[assumed] — recorded 2026-09-06.** Every number below is a list price taken
 * from memory, not from a verified fetch of the providers' pricing pages (this
 * machine has no API key for any of the three, so no live call could confirm
 * one). They are USD per **million** tokens. If a price is wrong the only thing
 * that is wrong is the dollar figure in the usage meter: token counts come from
 * the provider's own response and are unaffected.
 *
 * `costUsd` is 0 — not a guess — for a model with no entry, and `isEstimate`
 * says which happened, so the UI can mark an unknown model rather than quietly
 * report free.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million tokens written to the prompt cache. */
  cacheWrite: number;
  /** USD per million tokens read from the prompt cache. */
  cacheRead: number;
}

/** Longest-prefix match, so `claude-sonnet-4-5-20250929` finds `claude-sonnet-`. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic [assumed 2026-09-06]
  "claude-opus-": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-3-opus": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  // OpenAI [assumed 2026-09-06]
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheWrite: 0.05, cacheRead: 0.005 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 },
  "gpt-5": { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheWrite: 0.4, cacheRead: 0.1 },
  "gpt-4.1": { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheWrite: 0.15, cacheRead: 0.075 },
  "gpt-4o": { input: 2.5, output: 10, cacheWrite: 2.5, cacheRead: 1.25 },
  "o4-mini": { input: 1.1, output: 4.4, cacheWrite: 1.1, cacheRead: 0.275 },
  "o3-mini": { input: 1.1, output: 4.4, cacheWrite: 1.1, cacheRead: 0.55 },
  o3: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
};

/** The date the table above was written, surfaced in the UI next to a cost. */
export const PRICES_ASSUMED_ON = "2026-09-06";

/**
 * OpenRouter model ids are `vendor/model` (`anthropic/claude-sonnet-4.5`);
 * strip the vendor so the same table answers for them.
 */
export function normalizeModelId(model: string): string {
  const slash = model.lastIndexOf("/");
  const bare = slash >= 0 ? model.slice(slash + 1) : model;
  return bare.toLowerCase();
}

export function priceFor(model: string): ModelPrice | null {
  const id = normalizeModelId(model);
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (!id.startsWith(key)) continue;
    if (!best || key.length > best.key.length) best = { key, price };
  }
  return best?.price ?? null;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface CostEstimate {
  costUsd: number;
  /** False when the model has no price row: the cost is 0 because it is unknown. */
  isEstimate: boolean;
}

/**
 * Uncached input is billed at the input rate, cache writes at the write rate and
 * cache reads at the read rate. Anthropic reports `input_tokens` *excluding* the
 * cached ones and OpenAI reports `input_tokens` *including* them, so the caller
 * normalises to "uncached input" before getting here — see each provider.
 */
export function estimateCost(model: string, tokens: TokenCounts): CostEstimate {
  const price = priceFor(model);
  if (!price) return { costUsd: 0, isEstimate: false };
  const perToken = (millions: number, count: number): number => (millions * count) / 1_000_000;
  const costUsd =
    perToken(price.input, tokens.inputTokens) +
    perToken(price.output, tokens.outputTokens) +
    perToken(price.cacheWrite, tokens.cacheCreationTokens) +
    perToken(price.cacheRead, tokens.cacheReadTokens);
  return { costUsd, isEstimate: true };
}

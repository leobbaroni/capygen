/**
 * Cost estimates for Codex models (SPEC R23: "estimated cost per turn").
 *
 * **Every number here is `[assumed]`.** Unlike the Claude harness — where the
 * SDK's own `result.modelUsage[*].costUSD` is authoritative — `codex app-server`
 * reports tokens only (`thread/tokenUsage/updated`, spike §4) and no price. No
 * price list for the model ids this machine's Codex offers (`gpt-6-astra`,
 * `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.2` —
 * `model/list`, spike §2) was verified anywhere on this machine, so the table
 * below is a **placeholder shaped like OpenAI's published GPT-5 API pricing**
 * ($1.25 / $0.125 / $10.00 per 1M input / cached-input / output tokens) and is
 * marked as such in the data itself.
 *
 * Consequences, on purpose:
 *   - an unknown model costs **0**, never a guess: `priceFor` returns `null`
 *     and `estimateCodexCost` returns 0, so the usage meter shows tokens and no
 *     invented money;
 *   - `CodexPrice.assumed` is `true` on every entry, so the UI can label the
 *     figure rather than present it as billed;
 *   - when real prices land, only this file changes.
 */
import type { UsageTotals } from "@capygen/shared";
import type { CodexTokenUsageBreakdown } from "./protocol.js";

export interface CodexPrice {
  /** USD per 1M fresh (non-cached) input tokens. */
  inputPerMTok: number;
  /** USD per 1M cached input tokens. */
  cachedInputPerMTok: number;
  /** USD per 1M output tokens (reasoning tokens included). */
  outputPerMTok: number;
  /** Always true here — see the file comment. */
  assumed: true;
}

const GPT5_SHAPED: CodexPrice = {
  inputPerMTok: 1.25,
  cachedInputPerMTok: 0.125,
  outputPerMTok: 10,
  assumed: true,
};

/**
 * Keyed by model-id prefix, longest match first (`gpt-5.6-sol` matches the
 * `gpt-5.6` entry). Prefixes rather than exact ids because Codex's catalogue
 * gains variants between releases and a new `gpt-5.6-*` should not silently
 * fall to zero.
 */
export const CODEX_PRICES: Record<string, CodexPrice> = {
  "gpt-6": GPT5_SHAPED,
  "gpt-5.6": GPT5_SHAPED,
  "gpt-5.5": GPT5_SHAPED,
  "gpt-5.4": GPT5_SHAPED,
  "gpt-5.3": GPT5_SHAPED,
  "gpt-5.2": GPT5_SHAPED,
};

export function priceFor(model: string): CodexPrice | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  let best: { prefix: string; price: CodexPrice } | null = null;
  for (const [prefix, price] of Object.entries(CODEX_PRICES)) {
    if (!id.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, price };
  }
  return best?.price ?? null;
}

/**
 * `TokenUsageBreakdown` → capygen's `UsageTotals`, *without* the cost.
 *
 * `inputTokens` from Codex is the whole prompt including the part served from
 * cache, and `cachedInputTokens` is that part [assumed: it is how OpenAI's
 * Responses usage is documented and the only reading that keeps
 * `input + output ≈ total`]. capygen's `inputTokens` means "fresh input", the
 * same thing the Claude harness records, so the cached share is subtracted here
 * rather than counted twice on the meter. Clamped at zero: a breakdown where
 * the cached count exceeds the input count is a backend bug, not a negative
 * bill.
 */
export function readCodexUsage(breakdown: CodexTokenUsageBreakdown | undefined): UsageTotals {
  const input = num(breakdown?.inputTokens);
  const cached = num(breakdown?.cachedInputTokens);
  const cacheWrite = num(breakdown?.cacheWriteInputTokens);
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: num(breakdown?.outputTokens),
    cacheReadTokens: cached,
    cacheCreationTokens: cacheWrite,
    costUsd: 0,
  };
}

/** The `[assumed]` dollar figure for one turn; 0 when the model is unknown. */
export function estimateCodexCost(model: string, usage: UsageTotals): number {
  const price = priceFor(model);
  if (!price) return 0;
  const cost =
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    ((usage.cacheReadTokens + usage.cacheCreationTokens) / 1_000_000) *
      price.cachedInputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok;
  // Sub-cent turns are the common case; six decimals keeps them visible without
  // parading floating-point noise into the UI.
  return Math.round(cost * 1e6) / 1e6;
}

/** Tokens *and* the assumed cost — what the harness emits per turn. */
export function codexUsageWithCost(
  model: string,
  breakdown: CodexTokenUsageBreakdown | undefined,
): UsageTotals {
  const usage = readCodexUsage(breakdown);
  return {
    ...usage,
    costUsd: estimateCodexCost(model, usage),
    costKnown: priceFor(model) !== null,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

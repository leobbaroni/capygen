/**
 * Pure formatting helpers shared by the block cards. Split out from the
 * components so they can be unit-tested without React.
 */
import type { UsageEvent, UsageTotals } from "@capygen/shared";

/** `JSON.stringify(value, null, 2)`, falling back to `String(value)` for
 *  anything that throws (a circular structure, a BigInt, …). */
export function toPrettyJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One-line summary of a tool call's input for the collapsed trigger row. */
export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return truncate(input, 80);
  if (typeof input !== "object") return truncate(String(input), 80);
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  const parts = keys.slice(0, 3).map((key) => {
    const v = obj[key];
    const rendered = typeof v === "string" ? v : toPrettyJson(v);
    return `${key}: ${truncate(rendered.replace(/\s+/g, " ").trim(), 40)}`;
  });
  return truncate(parts.join(", "), 100);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `1_234` → `"1,234"`; used for token counts. */
export function formatCount(n: number): string {
  return n.toLocaleString();
}

export function formatCostUsd(costUsd: number): string {
  return `$${costUsd.toFixed(costUsd < 0.01 && costUsd > 0 ? 4 : 2)}`;
}

const EMPTY_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

/** Sum a list of `usage_events` into one `UsageTotals` (R23's session/day
 *  meters, and a turn's overall total above its per-model breakdown). */
export function sumUsage(events: readonly UsageEvent[]): UsageTotals {
  return events.reduce<UsageTotals>(
    (acc, e) => ({
      inputTokens: acc.inputTokens + e.inputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + e.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + e.cacheCreationTokens,
      costUsd: acc.costUsd + e.costUsd,
    }),
    { ...EMPTY_TOTALS },
  );
}

export interface UsageByModel {
  model: string;
  totals: UsageTotals;
}

/** Group `usage_events` by model, in first-seen order — the per-turn
 *  breakdown tooltip (R23) and the Usage page's per-model rows both want
 *  this shape rather than re-deriving it from the raw event list. */
export function groupUsageByModel(events: readonly UsageEvent[]): UsageByModel[] {
  const order: string[] = [];
  const byModel = new Map<string, UsageEvent[]>();
  for (const e of events) {
    if (!byModel.has(e.model)) {
      order.push(e.model);
      byModel.set(e.model, []);
    }
    byModel.get(e.model)?.push(e);
  }
  return order.map((model) => ({ model, totals: sumUsage(byModel.get(model) ?? []) }));
}

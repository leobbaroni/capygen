/** Strict processed-token accounting; cache savings affect cost, not this denominator. */
export const PAIR_ORDERS = [["baseline", "app"], ["app", "baseline"], ["baseline", "app"]] as const;
export type Lane = "baseline" | "app";
export interface Counters {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Separately reported subset of output, never added to processed tokens. */
  reasoning: number | null;
  costUsd: number | null;
}
export interface TurnMeasurement { turn: number; status: "done" | "error"; usage: Counters | null; durationMs: number }
export interface LaneMeasurement {
  lane: Lane;
  settingsHash: string;
  effectiveHash: string | null;
  cliVersion: string | null;
  sdkVersion: string;
  model: string;
  effort: string;
  turns: TurnMeasurement[];
  error: string | null;
  /** Numeric accounting only; no messages, configuration or credentials. */
  observedModelUsage?: { model: string; counters: Record<string, number | null> }[];
}
export interface PairMeasurement { pair: number; order: readonly Lane[]; lanes: LaneMeasurement[] }
export interface Cohort {
  schemaVersion: 1;
  cohortId: string;
  revision: string;
  sourceHash: string;
  fixtureHash: string;
  promptsHash: string;
  createdAt: string;
  pairs: PairMeasurement[];
  unavailableReason?: string;
}
const COUNTERS = ["uncachedInput", "cacheRead", "cacheWrite", "output"] as const;
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function validUsage(u: Counters | null): u is Counters {
  return !!u && COUNTERS.every(key => count(u[key])) &&
    (u.reasoning === null || count(u.reasoning) && u.reasoning <= u.output) &&
    (u.costUsd === null || typeof u.costUsd === "number" && Number.isFinite(u.costUsd) && u.costUsd >= 0);
}
export function processed(u: Counters): number { return u.uncachedInput + u.cacheRead + u.cacheWrite + u.output; }
export function difference(previous: Counters | null, current: Counters): Counters {
  if (!validUsage(current) || previous && !validUsage(previous)) throw new Error("Unknown usage");
  const delta = { ...current };
  for (const key of COUNTERS) {
    delta[key] = current[key] - (previous?.[key] ?? 0);
    if (delta[key] < 0) throw new Error("Cumulative usage reset; cohort is invalid");
  }
  delta.reasoning = current.reasoning === null || previous?.reasoning === null ? null : current.reasoning - (previous?.reasoning ?? 0);
  delta.costUsd = current.costUsd === null || previous?.costUsd === null ? null : current.costUsd - (previous?.costUsd ?? 0);
  if (!validUsage(delta)) throw new Error("Cumulative usage decreased");
  return delta;
}
/** SDK modelUsage is cumulative; missing fields are unknown, never zero. */
export function claudeSnapshot(raw: unknown, expectedModel = "claude-sonnet-5"): Counters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Missing model usage");
  const entries = Object.entries(raw);
  if (entries.length !== 1 || entries[0]?.[0] !== expectedModel) throw new Error("Unexpected model accounting");
  const row = entries[0][1] as Record<string, unknown>;
  const result: Counters = {
    uncachedInput: row.inputTokens as number, cacheRead: row.cacheReadInputTokens as number,
    cacheWrite: row.cacheCreationInputTokens as number, output: row.outputTokens as number,
    reasoning: typeof row.thinkingTokens === "number" ? row.thinkingTokens : null,
    costUsd: typeof row.costUSD === "number" ? row.costUSD : null,
  };
  if (!validUsage(result)) throw new Error("Incomplete model usage");
  return result;
}
export function summarize(cohort: Cohort) {
  const issues: string[] = [];
  if (cohort.unavailableReason) issues.push(cohort.unavailableReason);
  if (cohort.pairs.length !== 3) issues.push("Three registered pairs are required");
  const pairs: { pair: number; baseline: number; app: number; ratio: number; baselineCostUsd: number | null; appCostUsd: number | null;
    baselineCachedInputFraction: number | null; appCachedInputFraction: number | null; baselineDurationMs: number; appDurationMs: number }[] = [];
  const first = cohort.pairs[0]?.lanes[0];
  for (let i = 0; i < cohort.pairs.length; i++) {
    const pair = cohort.pairs[i]!;
    if (pair.pair !== i + 1 || JSON.stringify(pair.order) !== JSON.stringify(PAIR_ORDERS[i])) issues.push(`Pair ${i + 1}: invalid order`);
    if (pair.lanes.length !== 2 || pair.lanes.some((lane, n) => lane.lane !== pair.order[n])) { issues.push(`Pair ${i + 1}: missing/duplicate lane`); continue; }
    for (const lane of pair.lanes) {
      if (first && (lane.settingsHash !== first.settingsHash || lane.effectiveHash !== first.effectiveHash)) issues.push(`Pair ${i + 1}: cohort settings/effective metadata changed`);
      if (lane.error || lane.turns.length !== 20 || lane.turns.some((t, n) => t.turn !== n + 1 || t.status !== "done" || !validUsage(t.usage) || !count(t.durationMs) || !Number.isSafeInteger(processed(t.usage)) || processed(t.usage) === 0)) issues.push(`Pair ${i + 1} ${lane.lane}: incomplete or invalid turns`);
      if (lane.model !== "claude-sonnet-5" || lane.effort !== "low" || lane.cliVersion !== "2.1.261" || lane.sdkVersion !== "0.3.261") issues.push(`Pair ${i + 1} ${lane.lane}: model/effort/version mismatch`);
    }
    const baseline = pair.lanes.find(l => l.lane === "baseline")!;
    const app = pair.lanes.find(l => l.lane === "app")!;
    if (!baseline.effectiveHash || baseline.effectiveHash !== app.effectiveHash || baseline.settingsHash !== app.settingsHash) issues.push(`Pair ${i + 1}: effective tools/MCP/permissions/settings mismatch`);
    const total = (lane: LaneMeasurement) => lane.turns.reduce((sum, t) => sum + (validUsage(t.usage) ? processed(t.usage) : 0), 0);
    const b = total(baseline), a = total(app);
    if (b <= 0) issues.push(`Pair ${i + 1}: zero baseline`);
    const cost = (lane:LaneMeasurement):number|null => lane.turns.every(t => validUsage(t.usage) && t.usage.costUsd !== null)
      ? lane.turns.reduce((s,t)=>s+(t.usage!.costUsd!),0) : null;
    const cached = (lane:LaneMeasurement):number|null => {
      if(!lane.turns.every(t=>validUsage(t.usage))) return null;
      const input = lane.turns.reduce((s,t)=>s+t.usage!.uncachedInput+t.usage!.cacheRead+t.usage!.cacheWrite,0);
      return input ? lane.turns.reduce((s,t)=>s+t.usage!.cacheRead,0)/input : null;
    };
    pairs.push({ pair: i + 1, baseline: b, app: a, ratio: b > 0 ? a / b : NaN,
      baselineCostUsd:cost(baseline),appCostUsd:cost(app),baselineCachedInputFraction:cached(baseline),appCachedInputFraction:cached(app),
      baselineDurationMs:baseline.turns.reduce((s,t)=>s+t.durationMs,0),appDurationMs:app.turns.reduce((s,t)=>s+t.durationMs,0) });
  }
  const valid = issues.length === 0 && pairs.length === 3;
  const ratios = pairs.map(p => p.ratio);
  const mean = valid ? ratios.reduce((a, b) => a + b, 0) / 3 : null;
  const pooledRatio = valid ? pairs.reduce((s, p) => s + p.app, 0) / pairs.reduce((s, p) => s + p.baseline, 0) : null;
  return { verdict: !valid ? "unavailable" : pooledRatio! <= 1.10 ? "pass" : "fail", issues, pairs,
    pooledRatio, mean, sampleStandardDeviation: mean === null ? null : Math.sqrt(ratios.reduce((sum, n) => sum + (n - mean) ** 2, 0) / 2),
    range: valid ? [Math.min(...ratios), Math.max(...ratios)] : null };
}

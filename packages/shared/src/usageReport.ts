import { z } from "zod";
import { BackendSchema } from "./domain.js";

export const UsageRangeSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  timeZone: z.string().min(1).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Unknown time zone"),
}).refine((value) => value.to > value.from, "End must follow start");
export type UsageRange = z.infer<typeof UsageRangeSchema>;
export const UsageAggregateSchema = z.object({
  events: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheCreationTokens: z.number().nonnegative(),
  knownCostUsd: z.number().nonnegative(),
  unknownCostEvents: z.number().int().nonnegative(),
});
export const UsageReportSchema = z.object({
  range: UsageRangeSchema,
  totals: UsageAggregateSchema,
  days: z.array(UsageAggregateSchema.extend({ day: z.string() })),
  byBackendModel: z.array(UsageAggregateSchema.extend({ backend: BackendSchema, model: z.string() })),
  sessions: z.array(UsageAggregateSchema.extend({ sessionId: z.string(), title: z.string() })),
});
export type UsageReport = z.infer<typeof UsageReportSchema>;
type Aggregate = z.infer<typeof UsageAggregateSchema>;
export interface UsageReportEvent {
  sessionId: string; backend: z.infer<typeof BackendSchema>; model: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheCreationTokens: number; costUsd: number; costKnown?: boolean; ts: number;
}
const empty = (): Aggregate => ({ events: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, knownCostUsd: 0, unknownCostEvents: 0 });

/** Pure aggregation; the database selects the range before passing rows here. */
export function buildUsageReport(events: readonly UsageReportEvent[], input: UsageRange, titles: ReadonlyMap<string, string> = new Map()): UsageReport {
  const range = UsageRangeSchema.parse(input);
  const date = new Intl.DateTimeFormat("en", { timeZone: range.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const totals = empty();
  const days = new Map<string, Aggregate>();
  const models = new Map<string, UsageReport["byBackendModel"][number]>();
  const sessions = new Map<string, UsageReport["sessions"][number]>();
  function add(total: Aggregate, event: UsageReportEvent): void {
    total.events++;
    total.inputTokens += event.inputTokens;
    total.outputTokens += event.outputTokens;
    total.cacheReadTokens += event.cacheReadTokens;
    total.cacheCreationTokens += event.cacheCreationTokens;
    // Old positive prices remain usable; old zero values did not distinguish unknown.
    if (event.costKnown ?? event.costUsd > 0) total.knownCostUsd += event.costUsd;
    else total.unknownCostEvents++;
  }
  for (const event of events) {
    if (event.ts < range.from || event.ts >= range.to) continue;
    const parts = date.formatToParts(event.ts);
    const get = (name: string) => parts.find((part) => part.type === name)!.value;
    const day = `${get("year")}-${get("month")}-${get("day")}`;
    const dayTotal = days.get(day) ?? empty();
    days.set(day, dayTotal);
    const key = JSON.stringify([event.backend, event.model]);
    const modelTotal = models.get(key) ?? { ...empty(), backend: event.backend, model: event.model };
    models.set(key, modelTotal);
    const sessionTotal = sessions.get(event.sessionId) ?? { ...empty(), sessionId: event.sessionId, title: titles.get(event.sessionId) || "Untitled session" };
    sessions.set(event.sessionId, sessionTotal);
    for (const aggregate of [totals, dayTotal, modelTotal, sessionTotal]) add(aggregate, event);
  }
  return { range, totals, days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, total]) => ({ day, ...total })), byBackendModel: [...models.values()].sort((a, b) => b.knownCostUsd - a.knownCostUsd), sessions: [...sessions.values()].sort((a, b) => b.knownCostUsd - a.knownCostUsd) };
}

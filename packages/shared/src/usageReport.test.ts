import { describe, expect, it } from "vitest";
import { buildUsageReport } from "./usageReport.js";

describe("usage report", () => {
  const base = { sessionId: "s", backend: "api" as const, model: "m", inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheCreationTokens: 2, costUsd: 0 };
  it("keeps unknown cost separate from explicitly reported zero and groups local days", () => {
    const report = buildUsageReport([
      { ...base, ts: Date.parse("2026-03-08T04:30:00Z"), costKnown: false },
      { ...base, ts: Date.parse("2026-03-08T07:30:00Z"), costKnown: true },
      { ...base, sessionId: "second", backend: "claude", model: "other", ts: Date.parse("2026-03-08T08:30:00Z"), costUsd: 0.5, costKnown: true },
    ], { from: 0, to: Date.parse("2027-01-01Z"), timeZone: "America/New_York" });
    expect(report.totals).toMatchObject({ events: 3, inputTokens: 30, outputTokens: 9, knownCostUsd: 0.5, unknownCostEvents: 1 });
    expect(report.days.map((day) => day.day)).toEqual(["2026-03-07", "2026-03-08"]);
    expect(report.byBackendModel).toHaveLength(2);
    expect(report.sessions).toHaveLength(2);
  });
  it("uses an exclusive upper bound and refuses invalid ranges or zones", () => {
    expect(buildUsageReport([{ ...base, ts: 10 }], { from: 0, to: 10, timeZone: "UTC" }).totals.events).toBe(0);
    expect(() => buildUsageReport([], { from: 20, to: 10, timeZone: "UTC" })).toThrow();
    expect(() => buildUsageReport([], { from: 0, to: 10, timeZone: "Invalid/Zone" })).toThrow();
  });
});

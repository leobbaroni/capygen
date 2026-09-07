import { describe, expect, it } from "vitest";
import {
  RecurrenceError,
  nextRecurrenceOccurrence,
  normalizeRecurrence,
  parseRecurrence,
} from "./recurrence.js";

const utc = (value: string): number => Date.parse(value);

describe("parseRecurrence", () => {
  it("parses and canonically orders the supported RRULE subset", () => {
    expect(normalizeRecurrence("byminute=45,15;freq=weekly;byday=FR,MO;interval=2;byhour=9")).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=15,45",
    );
    expect(parseRecurrence("RRULE:FREQ=MINUTELY")).toEqual({
      frequency: "MINUTELY",
      interval: 1,
      normalized: "FREQ=MINUTELY;INTERVAL=1",
    });
  });

  it.each([
    "FREQ=YEARLY",
    "FREQ=DAILY;COUNT=3",
    "FREQ=WEEKLY;BYDAY=1MO",
    "FREQ=DAILY;BYDAY=MO",
    "FREQ=MONTHLY;BYHOUR=24",
    "FREQ=HOURLY;BYMINUTE=60",
    "FREQ=MONTHLY;BYMONTHDAY=0",
    "FREQ=MINUTELY;INTERVAL=366",
    "FREQ=DAILY;FREQ=WEEKLY",
    "FREQ=WEEKLY;BYDAY=MO,MO",
    "FREQ=DAILY;BYHOUR=9;BYHOUR=10",
  ])("rejects unsupported or ambiguous rule %s", (rule) => {
    expect(() => parseRecurrence(rule)).toThrow(RecurrenceError);
  });
});

describe("nextRecurrenceOccurrence", () => {
  it("returns the anchor itself when it is strictly after the cursor", () => {
    const anchor = utc("2026-01-01T09:15:00.000Z");
    expect(nextRecurrenceOccurrence({
      rule: "FREQ=DAILY",
      scheduleAnchorAt: anchor,
      timeZone: "UTC",
      after: anchor - 1,
    })).toBe(anchor);
  });

  it("keeps minute and hour intervals anchored while jumping over elapsed periods", () => {
    const minuteAnchor = utc("2026-01-01T00:01:00.000Z");
    expect(nextRecurrenceOccurrence({
      rule: "FREQ=MINUTELY;INTERVAL=15",
      scheduleAnchorAt: minuteAnchor,
      timeZone: "UTC",
      after: utc("2026-01-01T08:02:00.000Z"),
    })).toBe(utc("2026-01-01T08:16:00.000Z"));

    expect(nextRecurrenceOccurrence({
      rule: "FREQ=HOURLY;INTERVAL=3;BYMINUTE=5,35",
      scheduleAnchorAt: utc("2026-01-01T01:20:00.000Z"),
      timeZone: "UTC",
      after: utc("2026-01-02T09:36:00.000Z"),
    })).toBe(utc("2026-01-02T10:05:00.000Z"));
  });

  it("anchors daily and weekly intervals to the local calendar", () => {
    expect(nextRecurrenceOccurrence({
      rule: "FREQ=DAILY;INTERVAL=2;BYHOUR=8;BYMINUTE=30",
      scheduleAnchorAt: utc("2026-01-01T08:30:00.000Z"),
      timeZone: "UTC",
      after: utc("2026-01-02T23:00:00.000Z"),
    })).toBe(utc("2026-01-03T08:30:00.000Z"));

    expect(nextRecurrenceOccurrence({
      rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=10;BYMINUTE=0",
      scheduleAnchorAt: utc("2026-01-05T10:00:00.000Z"),
      timeZone: "UTC",
      after: utc("2026-01-09T10:00:00.000Z"),
    })).toBe(utc("2026-01-19T10:00:00.000Z"));
  });

  it("skips months in which a requested day does not exist", () => {
    expect(nextRecurrenceOccurrence({
      rule: "FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0",
      scheduleAnchorAt: utc("2026-01-31T09:00:00.000Z"),
      timeZone: "UTC",
      after: utc("2026-01-31T09:00:00.000Z"),
    })).toBe(utc("2026-03-31T09:00:00.000Z"));
  });

  it("skips a nonexistent spring-forward wall time", () => {
    expect(nextRecurrenceOccurrence({
      rule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=30",
      scheduleAnchorAt: utc("2024-03-09T07:30:00.000Z"),
      timeZone: "America/New_York",
      after: utc("2024-03-09T07:30:00.000Z"),
    })).toBe(utc("2024-03-11T06:30:00.000Z"));
  });

  it("resolves non-hour IANA offsets without rounding", () => {
    expect(nextRecurrenceOccurrence({
      rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=15",
      scheduleAnchorAt: utc("2026-01-01T03:30:00.000Z"),
      timeZone: "Asia/Kathmandu",
      after: utc("2026-01-01T03:30:00.000Z"),
    })).toBe(utc("2026-01-02T03:30:00.000Z"));
  });

  it("chooses the earlier instant in a fall-back fold exactly once", () => {
    const input = {
      rule: "FREQ=DAILY;BYHOUR=1;BYMINUTE=30",
      scheduleAnchorAt: utc("2024-11-02T05:30:00.000Z"),
      timeZone: "America/New_York",
    } as const;
    const fold = nextRecurrenceOccurrence({ ...input, after: input.scheduleAnchorAt });
    expect(fold).toBe(utc("2024-11-03T05:30:00.000Z"));
    expect(nextRecurrenceOccurrence({ ...input, after: fold })).toBe(utc("2024-11-04T06:30:00.000Z"));
    expect(nextRecurrenceOccurrence({ ...input, after: utc("2024-11-03T06:30:00.000Z") })).toBe(
      utc("2024-11-04T06:30:00.000Z"),
    );
  });

  it("does not replay the second copy of minutely wall times in a fold", () => {
    expect(nextRecurrenceOccurrence({
      rule: "FREQ=MINUTELY",
      scheduleAnchorAt: utc("2024-11-03T04:59:00.000Z"),
      timeZone: "America/New_York",
      after: utc("2024-11-03T06:30:00.000Z"),
    })).toBe(utc("2024-11-03T07:00:00.000Z"));
  });

  it("validates the IANA zone and timestamp inputs", () => {
    expect(() => nextRecurrenceOccurrence({
      rule: "FREQ=DAILY",
      scheduleAnchorAt: utc("2026-01-01T00:00:00.000Z"),
      timeZone: "Not/A_Zone",
      after: utc("2026-01-01T00:00:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "INVALID_TIME_ZONE" }));
    expect(() => nextRecurrenceOccurrence({
      rule: "FREQ=DAILY",
      scheduleAnchorAt: Number.MAX_SAFE_INTEGER,
      timeZone: "UTC",
      after: 0,
    })).toThrowError(expect.objectContaining({ code: "INVALID_TIMESTAMP" }));
  });

  it("fails explicitly when no future occurrence exists in the supported horizon", () => {
    expect(() => nextRecurrenceOccurrence({
      rule: "FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59",
      scheduleAnchorAt: utc("2100-12-31T23:59:00.000Z"),
      timeZone: "UTC",
      after: utc("2100-12-31T23:59:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "NO_OCCURRENCE" }));
  });
});

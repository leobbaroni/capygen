import { describe, expect, it } from "vitest";
import { AutomationRunSchema, AutomationSchema } from "./automations.js";

describe("automation contracts", () => {
  it("accepts a paused legacy automation without an agent", () => {
    const value = { id: "a", projectId: "p", agentId: null, name: "Daily", prompt: "Report", rrule: "FREQ=DAILY", timeZone: "UTC", scheduleAnchorAt: 1, nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastRunSessionId: null, disabledReason: "legacy_missing_agent", enabled: false, createdAt: 1, updatedAt: 1 };
    expect(AutomationSchema.parse(value)).toEqual(value);
  });

  it("keeps running out of the persisted last-run status union", () => {
    const base = { id: "r", automationId: "a", trigger: "scheduled", scheduledAt: 1, firedAt: 1, finishedAt: null, sessionId: null, errorCode: null };
    expect(AutomationRunSchema.safeParse({ ...base, status: "running" }).success).toBe(true);
    expect(AutomationSchema.safeParse({ id: "a", projectId: "p", agentId: null, name: "x", prompt: "x", rrule: "x", timeZone: "UTC", scheduleAnchorAt: 1, nextRunAt: null, lastRunAt: 1, lastRunStatus: "running", lastRunSessionId: null, disabledReason: null, enabled: false, createdAt: 1, updatedAt: 1 }).success).toBe(false);
  });
});

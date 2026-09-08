import { describe, expect, it } from "vitest";
import { parseCustomModeDocument } from "@capygen/shared";
import { planCrewDebate, resolveCrewTask } from "../src/routing/customCrew.js";

const parsed = parseCustomModeDocument({
  version: 1, title: "Routing fixture",
  roster: [
    { id: "lead", label: "Lead", role: "lead", target: { backend: "codex", model: "astra", effort: "low" } },
    { id: "debater", label: "Debater", role: "member", target: { backend: "claude", model: "fable", effort: "medium" } },
    { id: "hard", label: "Hard", role: "worker", target: { backend: "claude", model: "opus", effort: "medium" } },
    { id: "easy", label: "Easy", role: "worker", target: { backend: "codex", model: "luna", effort: "low" } },
  ],
  routing: [{ id: "hard-first", difficulties: ["hard"], target: "hard" }, { id: "dev", taskKinds: ["development"], target: "easy" }],
  defaultWorker: "easy",
  debate: { enabled: true, triggers: ["core"], participants: ["debater"] },
});
if (!parsed.ok) throw new Error("Invalid test fixture");
const crew = parsed.document;

describe("custom crew dispatch decisions", () => {
  it("uses first match and records the exact classified route", () => {
    expect(resolveCrewTask(crew, { taskKind: "development", difficulty: "hard" })).toMatchObject({
      ok: true, member: { id: "hard" }, evidence: { ruleId: "hard-first", taskKind: "development", difficulty: "hard", rosterId: "hard" },
    });
  });
  it("uses only the explicit default when no rule matches", () => {
    expect(resolveCrewTask(crew, { taskKind: "general", difficulty: "easy" })).toMatchObject({ ok: true, member: { id: "easy" }, evidence: { ruleId: null } });
  });
  it.each([{}, { taskKind: "unknown", difficulty: "easy" }, { taskKind: "general" }])("refuses missing or invalid classification", (request) => {
    expect(resolveCrewTask(crew, request).ok).toBe(false);
  });
  it("refuses a corrupted target instead of falling back", () => {
    expect(resolveCrewTask({ ...crew, defaultWorker: "missing" }, { taskKind: "general", difficulty: "easy" }).ok).toBe(false);
  });
  it("requires enough remaining hops for debaters and explicit lead return", () => {
    expect(planCrewDebate(crew, "core", 2, 3).ok).toBe(false);
    expect(planCrewDebate(crew, "core", 1, 3)).toEqual({ ok: true, rosterIds: ["debater", "lead"] });
  });
  it("refuses disabled, unmatched and invalid hop requests", () => {
    expect(planCrewDebate(crew, "major", 0, 3).ok).toBe(false);
    expect(planCrewDebate({ ...crew, debate: { ...crew.debate, enabled: false } }, "core", 0, 3).ok).toBe(false);
    expect(planCrewDebate(crew, "core", NaN, 3).ok).toBe(false);
  });
});

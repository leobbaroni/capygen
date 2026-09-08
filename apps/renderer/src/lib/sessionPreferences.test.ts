import { beforeEach, expect, it } from "vitest";
import { loadRoundTableRoster, loadRoundTableSettings, saveRoundTableRoster, saveRoundTableSettings } from "./sessionPreferences";
beforeEach(() => localStorage.clear());
it("restores roster/effort and session defaults without retaining arbitrary config", () => {
  saveRoundTableRoster([{ name: "Lead", backend: "codex", model: "model", role: "lead", config: { codex: { reasoningEffort: "low", env: { TOKEN: "private" } } } }]);
  expect(loadRoundTableRoster()[0]?.config).toEqual({ codex: { reasoningEffort: "low" } });
  expect(localStorage.getItem("capygen.roundTableRoster.v1")).not.toContain("private");
  saveRoundTableSettings({ hopCap: 5, parallelAgents: true });
  expect(loadRoundTableSettings()).toEqual({ hopCap: 5, parallelAgents: true });
});
it("ignores corrupt persisted preferences", () => {
  localStorage.setItem("capygen.roundTableRoster.v1", "broken");
  localStorage.setItem("capygen.roundTableSettings.v1", '{"hopCap":0}');
  expect(loadRoundTableRoster()).toEqual([]);
  expect(loadRoundTableSettings()).toBeNull();
});

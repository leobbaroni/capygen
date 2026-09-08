import { expect, it } from "vitest";
import { openStore } from "../src/index.js";

const crew = {
  version: 1, title: "Crew", defaultWorker: "worker",
  roster: [
    { id: "lead", label: "Captain", role: "lead", target: { backend: "codex", model: "fixture", effort: "low" } },
    { id: "member", label: "Reviewer", role: "member", target: { backend: "claude", model: "fixture", effort: "medium" } },
    { id: "worker", label: "Worker", role: "worker", target: { backend: "api", provider: "openai", model: "fixture", effort: "low" } },
  ],
};

it("applies a fresh crew atomically while preserving historical agents and refusing inactive mutations", () => {
  const store = openStore(":memory:");
  try {
    const project = store.projects.upsertByPath({ path: "C:/crew-fixture" });
    const { session, agents: [old] } = store.sessions.create({ projectId: project.id, mode: "solo",
      agents: [{ name: "Captain", role: "lead", backend: "codex", model: "old", config: { nativeSessionId: "old-native", permissionMode: "bypassPermissions" } }] });
    store.db.run("INSERT INTO turns(id,session_id,agent_id,role,created_at) VALUES ('history',?,?, 'agent',1)", session.id, old!.id);
    const before = store.sessions.get(session.id);
    store.db.exec("CREATE TRIGGER fail_crew BEFORE INSERT ON agents WHEN NEW.name = 'Reviewer' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    expect(() => store.sessions.applyCrew(session.id, crew)).toThrow("fixture failure");
    expect(store.sessions.get(session.id)).toEqual(before);
    expect(store.sessions.agents(session.id)).toEqual([old]);
    expect(store.sessions.historicalAgents(session.id)).toEqual([old]);
    store.db.exec("DROP TRIGGER fail_crew");
    const result = store.sessions.applyCrew(session.id, crew);
    expect(result.session.mode).toBe("custom");
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]!.mentionName).toBe(old!.mentionName);
    expect(result.agents[0]!.config).toEqual({ codex: { reasoningEffort: "low" } });
    expect(result.agents[1]!.config).toEqual({ claude: { effort: "medium" } });
    expect(result.session.settings.crewBindings).toEqual({ lead: result.agents[0]!.id, member: result.agents[1]!.id });
    expect(store.sessions.historicalAgents(session.id)).toHaveLength(3);
    expect(store.sessions.agent(old!.id)).toEqual(old);
    expect(store.db.get("SELECT agent_id FROM turns WHERE id='history'")).toEqual({ agent_id: old!.id });
    expect(store.db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(() => store.sessions.updateAgent(old!.id, { displayName: "Changed" })).toThrow("inactive");
    expect(() => store.sessions.removeAgent(old!.id)).toThrow("inactive");
    expect(() => store.sessions.setLead(session.id, old!.id)).toThrow("inactive");
    expect(() => store.sessions.updateSettings(session.id, { crew: result.session.settings.crew })).toThrow("require applyCrew");
    expect(() => store.sessions.addAgent(session.id, { backend: "codex", model: "fixture" })).toThrow("require applyCrew");
    expect(() => store.sessions.updateAgent(result.agents[0]!.id, { displayName: "Drift" })).toThrow("require applyCrew");
    expect(() => store.sessions.removeAgent(result.agents[0]!.id)).toThrow("require applyCrew");
    expect(() => store.sessions.setLead(session.id, result.agents[1]!.id)).toThrow("require applyCrew");
    expect(() => store.sessions.setMode(session.id, "custom")).toThrow("requires applyCrew");
    expect(store.sessions.setMode(session.id, "solo").settings.crew).toBeUndefined();
    expect(store.sessions.agents(session.id)).toEqual(result.agents);
  } finally { store.close(); }
});

it("refuses pending turns and unanswered interactions even when session status is idle", () => {
  const store = openStore(":memory:");
  try {
    const project = store.projects.upsertByPath({ path: "C:/crew-pending" });
    const { session } = store.sessions.create({ projectId: project.id, mode: "solo", agents: [] });
    store.db.run("INSERT INTO turns(id,session_id,role,status,created_at) VALUES ('pending',?,'user','pending',1)", session.id);
    expect(() => store.sessions.applyCrew(session.id, crew)).toThrow("pending or active turns");
    store.db.run("UPDATE turns SET status='done' WHERE id='pending'");
    store.db.run("INSERT INTO blocks(id,turn_id,session_id,kind,block_index,payload_json,created_at,updated_at) VALUES ('question','pending',?,'question',0,?,1,1)", session.id,
      JSON.stringify({ requestId: "q", questions: [], answers: null }));
    expect(() => store.sessions.applyCrew(session.id, crew)).toThrow("pending interactions");
    expect(store.sessions.agents(session.id)).toEqual([]);
  } finally { store.close(); }
});

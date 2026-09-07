import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, readMigrations, type CapygenStore } from "../src/index.js";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
let dir: string; let file: string; let store: CapygenStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-persistence-"));
  file = path.join(dir, "capygen.db");
  store = openStore(file, { migrationsDir });
});
afterEach(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

function seed(name = "one") {
  const project = store.projects.upsertByPath({ path: path.join(dir, name) });
  const created = store.sessions.create({ projectId: project.id, mode: "solo", agents: [{ name: "Lead", backend: "codex", model: "gpt", role: "lead", config: null }] });
  return { project, ...created, agent: created.agents[0]! };
}

function automation(projectId: string, agentId: string, nextRunAt = 100) {
  return store.automations.create({ projectId, agentId, name: "Every minute", prompt: "Report", rrule: "FREQ=MINUTELY", timeZone: "UTC", scheduleAnchorAt: 1, nextRunAt }, 1);
}

describe("automation persistence", () => {
  it("preserves placeholder rows and pauses legacy automations during migration", () => {
    store.close();
    const legacyFile = path.join(dir, "legacy.db");
    const legacy = openStore(legacyFile, { migrations: readMigrations(migrationsDir).filter((migration) => migration.id < "0007_automations_inbox") });
    const project = legacy.projects.upsertByPath({ path: path.join(dir, "legacy-project") });
    const created = legacy.sessions.create({ projectId: project.id, mode: "solo", agents: [{ name: "Lead", backend: "codex", model: "gpt", role: "lead", config: null }] });
    legacy.db.run("INSERT INTO automations (id,project_id,title,schedule,prompt,enabled,last_run,created_at,updated_at) VALUES (?,?,?,?,?,1,NULL,1,1)", "old-auto", project.id, "", "", "");
    legacy.db.run("INSERT INTO automations (id,project_id,title,schedule,prompt,enabled,last_run,created_at,updated_at) VALUES (?,NULL,?,?,?,1,NULL,1,1)", "orphan-auto", "Orphan", "0 * * * *", "Run");
    legacy.db.run("INSERT INTO inbox_items (id,session_id,kind,body,read,created_at) VALUES (?,?,?,?,0,1)", "old-inbox", created.session.id, "old-kind", "Old body");
    legacy.close();
    const migrated = openStore(legacyFile, { migrationsDir });
    expect(migrated.automations.get("old-auto")).toMatchObject({ agentId: null, name: "Legacy automation", prompt: "Legacy automation prompt", rrule: "FREQ=DAILY", enabled: false, disabledReason: "legacy_missing_agent" });
    expect(migrated.db.get<{ id: string }>("SELECT id FROM legacy_automations WHERE id='orphan-auto'")?.id).toBe("orphan-auto");
    expect(migrated.db.get<{ id: string }>("SELECT id FROM legacy_inbox_items WHERE id='old-inbox'")?.id).toBe("old-inbox");
    migrated.close();
    store = openStore(file, { migrationsDir });
  });

  it("requires a live agent in the same project and keeps project immutable", () => {
    const a = seed("a"); const b = seed("b");
    expect(() => automation(a.project.id, b.agent.id)).toThrow(/different project/);
    store.db.run("UPDATE sessions SET origin='import' WHERE id=?", a.session.id);
    expect(() => automation(a.project.id, a.agent.id)).toThrow(/imported/);
  });

  it("claims once, advances next run atomically, attaches a session, and releases on finish", () => {
    const seeded = seed(); const item = automation(seeded.project.id, seeded.agent.id);
    const claim = store.automations.claimScheduled({ automationId: item.id, scheduledAt: 100, firedAt: 101, nextRunAt: 160 });
    expect(claim?.run.status).toBe("running");
    expect(store.automations.get(item.id)?.nextRunAt).toBe(160);
    expect(store.automations.claimScheduled({ automationId: item.id, scheduledAt: 160, firedAt: 161, nextRunAt: 220 })).toBeNull();
    store.automations.attachSession(claim!.run.id, seeded.session.id);
    const done = store.automations.finishRun({ runId: claim!.run.id, status: "succeeded", finishedAt: 150 });
    expect(done.sessionId).toBe(seeded.session.id);
    expect(store.automations.getActiveRun(item.id)).toBeNull();
    expect(store.automations.get(item.id)).toMatchObject({ lastRunStatus: "succeeded", lastRunSessionId: seeded.session.id });
  });

  it("rejects stale, early and duplicate scheduled claims", () => {
    const seeded = seed(); const item = automation(seeded.project.id, seeded.agent.id);
    expect(store.automations.claimScheduled({ automationId: item.id, scheduledAt: 100, firedAt: 99, nextRunAt: 160 })).toBeNull();
    store.automations.update(item.id, { nextRunAt: 90 }, 2);
    expect(store.automations.claimScheduled({ automationId: item.id, scheduledAt: 100, firedAt: 101, nextRunAt: 160 })).toBeNull();
    store.automations.update(item.id, { nextRunAt: 100 }, 3);
    const claim = store.automations.claimScheduled({ automationId: item.id, scheduledAt: 100, firedAt: 101, nextRunAt: 160 })!;
    store.automations.finishRun({ runId: claim.run.id, status: "succeeded", finishedAt: 102 });
    store.automations.update(item.id, { nextRunAt: 100 }, 4);
    expect(store.automations.claimScheduled({ automationId: item.id, scheduledAt: 100, firedAt: 103, nextRunAt: 160 })).toBeNull();
  });

  it("does not move an attached run to a different session", () => {
    const seeded = seed();
    const other = store.sessions.create({ projectId: seeded.project.id, mode: "solo", agents: [{ name: "Other", backend: "codex", model: "gpt", role: "lead", config: null }] });
    const item = automation(seeded.project.id, seeded.agent.id);
    const claim = store.automations.claimManual({ automationId: item.id, firedAt: 10 })!;
    expect(store.automations.attachSession(claim.run.id, seeded.session.id).sessionId).toBe(seeded.session.id);
    expect(store.automations.attachSession(claim.run.id, seeded.session.id).sessionId).toBe(seeded.session.id);
    expect(() => store.automations.attachSession(claim.run.id, other.session.id)).toThrow(/different session/);
    expect(store.automations.getRun(claim.run.id)?.sessionId).toBe(seeded.session.id);
  });

  it("refuses deletion during a run and allows pause without cancelling it", () => {
    const seeded = seed(); const item = automation(seeded.project.id, seeded.agent.id);
    const claim = store.automations.claimManual({ automationId: item.id, firedAt: 10 })!;
    store.automations.setEnabled(item.id, false, { disabledReason: "user_paused" }, 11);
    expect(store.automations.getActiveRun(item.id)?.id).toBe(claim.run.id);
    expect(() => store.automations.remove(item.id)).toThrowError(expect.objectContaining({ code: "automation_running" }));
    store.automations.finishRun({ runId: claim.run.id, status: "cancelled", finishedAt: 12 });
    expect(store.automations.remove(item.id)).toBe(true);
  });

  it("reconciles active and missed work once without replaying a backlog", () => {
    const seeded = seed(); const active = automation(seeded.project.id, seeded.agent.id, 500);
    const overdue = automation(seeded.project.id, seeded.agent.id, 50);
    store.automations.claimManual({ automationId: active.id, firedAt: 20 });
    store.close(); store = openStore(file, { migrationsDir });
    const result = store.automations.reconcileStartup({ now: 100, nextRunAt: () => 160 });
    expect(result).toEqual({ interrupted: 1, skipped: 1, paused: 0 });
    expect(store.automations.listRuns(overdue.id)).toHaveLength(1);
    expect(store.automations.get(overdue.id)).toMatchObject({ nextRunAt: 160, lastRunStatus: "skipped" });
    expect(store.automations.reconcileStartup({ now: 100, nextRunAt: () => 160 })).toEqual({ interrupted: 0, skipped: 0, paused: 0 });
  });

  it("pauses an invalid overdue schedule", () => {
    const seeded = seed(); const item = automation(seeded.project.id, seeded.agent.id, 50);
    expect(store.automations.reconcileStartup({ now: 100, nextRunAt: () => { throw new Error("bad rule"); } })).toEqual({ interrupted: 0, skipped: 0, paused: 1 });
    expect(store.automations.get(item.id)).toMatchObject({ enabled: false, disabledReason: "invalid_schedule", nextRunAt: null });
  });
});

describe("Inbox persistence", () => {
  function turn() {
    const seeded = seed();
    return { ...seeded, turn: store.turns.create({ sessionId: seeded.session.id, role: "agent" }) };
  }

  it("deduplicates event projection across restart and tracks resolve/read independently", () => {
    const seeded = turn();
    const draft = { sessionId: seeded.session.id, turnId: seeded.turn.id, requestId: "request-1", kind: "permission" as const, title: "Permission", body: "Allow?", dedupeKey: `permission:${seeded.session.id}:request-1`, targetBlockId: null, createdAt: 10 };
    expect(store.inbox.insertIgnore(draft).inserted).toBe(true);
    store.close(); store = openStore(file, { migrationsDir });
    const duplicate = store.inbox.insertIgnore({ ...draft, createdAt: 11 });
    expect(duplicate.inserted).toBe(false);
    store.inbox.resolveByRequest(seeded.session.id, "request-1", 12);
    expect(store.inbox.get(duplicate.item.id)).toMatchObject({ resolvedAt: 12, readAt: null });
    expect(store.inbox.unreadCount()).toBe(1);
    store.inbox.markRead(duplicate.item.id, true, 13);
    expect(store.inbox.get(duplicate.item.id)).toMatchObject({ resolvedAt: 12, readAt: 13 });
  });

  it("filters kinds, marks all read and paginates with a stable tuple cursor", () => {
    const seeded = turn();
    for (const [index, kind] of (["finished", "error", "finished"] as const).entries()) {
      const eventTurn = index === 0 ? seeded.turn : store.turns.create({ sessionId: seeded.session.id, role: "agent" });
      store.inbox.insertIgnore({ sessionId: seeded.session.id, turnId: eventTurn.id, requestId: null, kind, title: kind, body: "", dedupeKey: `${kind}:${eventTurn.id}`, targetBlockId: null, createdAt: index + 1 });
    }
    const first = store.inbox.list({ kind: "finished", limit: 1 });
    expect(first).toHaveLength(1);
    expect(store.inbox.list({ kind: "finished", before: { createdAt: first[0]!.createdAt, id: first[0]!.id } })).toHaveLength(1);
    expect(store.inbox.markAllRead(20, seeded.session.id)).toBe(3);
    expect(store.inbox.unreadCount(seeded.session.id)).toBe(0);
  });
});

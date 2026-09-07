/**
 * Storage tests against a real temp database file — not :memory: — because the
 * things worth checking (WAL open, the pre-migration backup, reopen-restores)
 * only exist on disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS, newId, type Block, type Task, type TextBlock } from "@capygen/shared";
import {
  openStore,
  openDatabase,
  readMigrations,
  pendingMigrations,
  openRaw,
  type CapygenStore,
} from "../src/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

let dir: string;
let file: string;
let store: CapygenStore;

function open(): CapygenStore {
  return openStore(file, { migrationsDir: MIGRATIONS_DIR });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-db-"));
  file = path.join(dir, "capygen.db");
  store = open();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed by the test */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedSession() {
  const project = store.projects.upsertByPath({ path: path.join(dir, "proj") });
  const created = store.sessions.create({
    projectId: project.id,
    mode: "solo",
    title: "First session",
    agents: [
      { name: "capy", backend: "claude", model: "claude-opus-4-5", role: "lead", config: null },
    ],
  });
  return { project, ...created };
}

function textBlock(
  sessionId: string,
  turnId: string,
  index: number,
  text: string,
): TextBlock {
  const ts = Date.now();
  return {
    id: newId("block"),
    turnId,
    sessionId,
    kind: "text",
    index,
    text,
    createdAt: ts,
    updatedAt: ts,
  };
}

describe("migrations", () => {
  it("creates every table SPEC §Data names, plus the tool_calls view", () => {
    const names = store.db
      .all<{ name: string; type: string }>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view')",
      )
      .map((r) => `${r.type}:${r.name}`);

    for (const table of [
      "projects",
      "sessions",
      "agents",
      "turns",
      "blocks",
      "usage_events",
      "tasks",
      "automations",
      "inbox_items",
      "settings",
      "mcp_servers",
      "plugins",
      "skills",
      "shares",
      "members",
      "policies",
      "approvals",
      "tool_outputs",
      "workspace_layouts",
      "dev_servers",
      "schema_migrations",
    ]) {
      expect(names, `missing table ${table}`).toContain(`table:${table}`);
    }
    expect(names).toContain("view:tool_calls");
  });

  it("no longer constrains blocks.kind to a fixed list (0002): a new kind inserts fine", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "agent" });
    expect(() =>
      store.blocks.upsert({
        id: newId("block"),
        turnId: turn.id,
        sessionId: session.id,
        kind: "widget",
        index: 0,
        toolCallId: "toolu_1",
        serverName: "higgsfield",
        toolName: "animate",
        resourceUri: "ui://higgsfield/animate",
        html: null,
        htmlStatus: "pending",
        toolInput: {},
        toolResult: null,
        meta: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    ).not.toThrow();
  });

  it("is idempotent: reopening applies nothing and writes no backup", () => {
    expect(store.migration.applied).toEqual([
      "0001_init",
      "0002_widgets_elicitations_tool_outputs",
      "0003_round_table_agents",
      "0004_workspace_panes",
      "0005_integrations_backend_column",
    ]);
    expect(store.migration.backupFile).toBeNull();
    store.close();

    const again = open();
    expect(again.migration.applied).toEqual([]);
    expect(again.migration.backupFile).toBeNull();
    again.close();

    const backups = fs.readdirSync(dir).filter((f) => f.includes(".backup-"));
    expect(backups).toEqual([]);
    store = open();
  });

  it("copies the database before applying a pending migration", () => {
    const { session } = seedSession();
    store.close();

    const extra = [
      ...readMigrations(MIGRATIONS_DIR),
      { id: "9999_probe", sql: "CREATE TABLE probe (a INTEGER)" },
    ];
    const opened = openDatabase(file, { migrations: extra });
    expect(opened.result.applied).toEqual(["9999_probe"]);
    expect(opened.result.backupFile).not.toBeNull();
    expect(fs.existsSync(opened.result.backupFile!)).toBe(true);
    opened.db.close();

    // The backup is the pre-migration state: it has the session but not `probe`.
    const restored = openRaw(opened.result.backupFile!, { wal: false });
    expect(restored.get("SELECT id FROM sessions WHERE id = ?", session.id)).toBeTruthy();
    expect(
      restored.get("SELECT name FROM sqlite_master WHERE name = 'probe'"),
    ).toBeUndefined();
    restored.close();

    store = open();
  });

  it("reports pending migrations without writing to the database", () => {
    const migrations = readMigrations(MIGRATIONS_DIR);
    expect(pendingMigrations(store.db, migrations)).toEqual([]);
    const fresh = openRaw(":memory:");
    expect(pendingMigrations(fresh, migrations).map((m) => m.id)).toEqual([
      "0001_init",
      "0002_widgets_elicitations_tool_outputs",
      "0003_round_table_agents",
      "0004_workspace_panes",
      "0005_integrations_backend_column",
    ]);
    expect(
      fresh.get("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'"),
    ).toBeUndefined();
    fresh.close();
  });
});

describe("projects", () => {
  it("is keyed by path and derives a name from the last segment", () => {
    const p = store.projects.upsertByPath({ path: "C:\\Users\\x\\Desktop\\GITHUB\\capygen" });
    expect(p.name).toBe("capygen");
    const again = store.projects.upsertByPath({ path: "C:\\Users\\x\\Desktop\\GITHUB\\capygen" });
    expect(again.id).toBe(p.id);
    expect(store.projects.list()).toHaveLength(1);
  });

  it("round-trips a layout blob", () => {
    const p = store.projects.upsertByPath({ path: path.join(dir, "layout-proj") });
    store.projects.setLayout(p.id, { panels: ["files", "terminal"] });
    expect(store.projects.get(p.id)?.layout).toEqual({ panels: ["files", "terminal"] });
  });
});

describe("sessions and agents", () => {
  it("creates a session, its agents, and points lead_agent_id at the lead", () => {
    const { session, agents } = seedSession();
    expect(session.mode).toBe("solo");
    expect(session.archived).toBe(false);
    expect(session.status).toBe("idle");
    expect(agents).toHaveLength(1);
    expect(session.leadAgentId).toBe(agents[0]!.id);
    expect(store.sessions.agents(session.id).map((a) => a.backend)).toEqual(["claude"]);
  });

  it("picks the agent flagged lead even when it is not first", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "rt") });
    const { session, agents } = store.sessions.create({
      projectId: project.id,
      mode: "round-table",
      title: "",
      agents: [
        { name: "codey", backend: "codex", model: "gpt-5", role: "member", config: null },
        { name: "capy", backend: "claude", model: "claude-opus-4-5", role: "lead", config: null },
      ],
    });
    expect(session.leadAgentId).toBe(agents[1]!.id);
  });

  it("archives and unarchives, and list() hides archived by default", () => {
    const { session } = seedSession();
    store.sessions.setArchived(session.id, true);
    expect(store.sessions.list()).toHaveLength(0);
    expect(store.sessions.list({ includeArchived: true })).toHaveLength(1);
    expect(store.sessions.setArchived(session.id, false)?.archived).toBe(false);
    expect(store.sessions.list()).toHaveLength(1);
  });

  it("rolls back the whole create when an agent insert fails", () => {
    const before = store.sessions.list({ includeArchived: true }).length;
    expect(() =>
      store.sessions.create({
        projectId: "prj_does_not_exist",
        mode: "solo",
        title: "",
        agents: [{ name: "x", backend: "claude", model: "m", role: "lead", config: null }],
      }),
    ).toThrow();
    expect(store.sessions.list({ includeArchived: true })).toHaveLength(before);
    expect(store.db.all("SELECT id FROM agents")).toHaveLength(0);
  });
});

describe("Phase 4: session modes, agents, dispatcher, routing (contracts)", () => {
  it("defaults displayName to name and mints a unique mentionName per session", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "mentions") });
    const { agents } = store.sessions.create({
      projectId: project.id,
      mode: "round-table",
      title: "",
      agents: [
        { name: "Capy Lead", backend: "claude", model: "claude-opus-4-5", role: "lead", config: null },
        // Same label as another agent: the second one must not collide.
        { name: "Capy Lead", backend: "codex", model: "gpt-5.5", role: "member", config: null },
      ],
    });
    expect(agents[0]).toMatchObject({ displayName: "Capy Lead", mentionName: "capy-lead", order: 0 });
    expect(agents[1]).toMatchObject({ displayName: "Capy Lead", mentionName: "capy-lead-2", order: 1 });
  });

  it("reads a pre-migration-0003 agent row back with a synthesized displayName/mentionName/role", () => {
    const { session } = seedSession();
    const legacyId = newId("agent");
    // Simulate a row written before 0003: only the columns 0001 defined.
    store.db.run(
      `INSERT INTO agents (id, session_id, name, backend, model, role, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      legacyId,
      session.id,
      "Legacy Bot",
      "api",
      "gpt-5",
      "agent", // the pre-Phase-4 free-text default, never "lead"/"member"
      Date.now(),
    );
    const legacy = store.sessions.agent(legacyId);
    expect(legacy).toMatchObject({
      name: "Legacy Bot",
      displayName: "Legacy Bot",
      mentionName: "legacy-bot",
      role: "member",
      order: 0,
    });
  });

  it("agents.add derives a label from the backend when the caller names neither displayName nor mentionName", () => {
    const { session } = seedSession();
    const added = store.sessions.addAgent(session.id, { backend: "codex", model: "gpt-5.5" });
    expect(added).toMatchObject({
      displayName: "Codex agent",
      mentionName: "codex-agent",
      role: "member",
      backend: "codex",
    });
    expect(store.sessions.agents(session.id).map((a) => a.id)).toContain(added.id);
  });

  it("agents.add promotes to lead and demotes the previous lead when role:'lead' is given", () => {
    const { session, agents } = seedSession();
    const added = store.sessions.addAgent(session.id, {
      backend: "codex",
      model: "gpt-5.5",
      displayName: "Codey",
      role: "lead",
    });
    expect(store.sessions.get(session.id)?.leadAgentId).toBe(added.id);
    expect(store.sessions.agent(agents[0]!.id)?.role).toBe("member");
  });

  it("updateAgent merge-patches only the given fields, mints a unique mentionName on rename, and refuses role:'lead'", () => {
    const { session, agents } = seedSession();
    const other = store.sessions.addAgent(session.id, { backend: "codex", model: "gpt-5.5", mentionName: "codex" });

    const patched = store.sessions.updateAgent(other.id, { description: "reviews diffs" });
    expect(patched).toMatchObject({ description: "reviews diffs", mentionName: "codex", model: "gpt-5.5" });

    const renamed = store.sessions.updateAgent(other.id, { mentionName: "capy" }); // collides with the lead
    expect(renamed.mentionName).toBe("capy-2");

    expect(() => store.sessions.updateAgent(other.id, { role: "lead" })).toThrow(/setLead/);
    expect(store.sessions.agent(agents[0]!.id)?.role).toBe("lead"); // unchanged
  });

  it("removeAgent clears leadAgentId when the removed agent was the lead", () => {
    const { session, agents } = seedSession();
    expect(store.sessions.removeAgent(agents[0]!.id)).toBe(true);
    expect(store.sessions.get(session.id)?.leadAgentId).toBeNull();
    expect(store.sessions.agents(session.id)).toHaveLength(0);
    expect(store.sessions.removeAgent("agt_nope")).toBe(false);
  });

  it("setLead promotes one agent and demotes the previous lead in the same write", () => {
    const { session, agents } = seedSession();
    const other = store.sessions.addAgent(session.id, { backend: "codex", model: "gpt-5.5" });

    const updated = store.sessions.setLead(session.id, other.id);
    expect(updated.leadAgentId).toBe(other.id);
    expect(store.sessions.agent(other.id)?.role).toBe("lead");
    expect(store.sessions.agent(agents[0]!.id)?.role).toBe("member");

    expect(() => store.sessions.setLead(session.id, "agt_nope")).toThrow();
  });

  it("setMode switches mode without touching agents or the transcript", () => {
    const { session } = seedSession();
    const updated = store.sessions.setMode(session.id, "round-table");
    expect(updated.mode).toBe("round-table");
    expect(store.sessions.agents(session.id)).toHaveLength(1);
  });

  it("a session with no settings_json reads back the shipping defaults", () => {
    const { session } = seedSession();
    expect(session.settings).toEqual({ hopCap: 3, parallelAgents: false });
  });

  it("updateSettings merges into existing settings instead of resetting the rest (the jitless-defaults bug this schema avoids)", () => {
    const { session } = seedSession();
    store.sessions.updateSettings(session.id, { hopCap: 5 });
    const afterFirst = store.sessions.get(session.id)!;
    expect(afterFirst.settings).toMatchObject({ hopCap: 5, parallelAgents: false });

    // A second, unrelated patch must not clobber the hopCap the first patch set.
    store.sessions.updateSettings(session.id, { parallelAgents: true });
    const afterSecond = store.sessions.get(session.id)!;
    expect(afterSecond.settings).toEqual({ hopCap: 5, parallelAgents: true });
  });

  it("accepts a sub-agent routing override under settings.routing and survives a reopen", () => {
    const { session } = seedSession();
    store.sessions.updateSettings(session.id, {
      routing: { subagents: { backend: "codex", model: "gpt-5.5" } },
    });
    store.close();
    store = open();
    expect(store.sessions.get(session.id)?.settings.routing).toEqual({
      subagents: { backend: "codex", model: "gpt-5.5" },
    });
  });

  it("records a turn's mentions, triggeredByTurnId and speakerLabel, and round-trips them after a reopen", () => {
    const { session, agents } = seedSession();
    const userTurn = store.turns.create({ sessionId: session.id, role: "user", mentions: [agents[0]!.id] });
    const agentTurn = store.turns.create({
      sessionId: session.id,
      agentId: agents[0]!.id,
      role: "agent",
      parentTurnId: userTurn.id,
      hopIndex: 1,
      triggeredByTurnId: userTurn.id,
      speakerLabel: "@capy",
    });

    expect(userTurn.mentions).toEqual([agents[0]!.id]);
    expect(agentTurn.triggeredByTurnId).toBe(userTurn.id);
    expect(agentTurn.speakerLabel).toBe("@capy");

    store.close();
    store = open();
    const turns = store.turns.list(session.id);
    expect(turns[0]!.mentions).toEqual([agents[0]!.id]);
    expect(turns[1]!.triggeredByTurnId).toBe(userTurn.id);
    expect(turns[1]!.speakerLabel).toBe("@capy");
  });

  it("a turn with no mentions reads back an empty array, not null", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "user" });
    expect(turn.mentions).toEqual([]);
    expect(store.turns.get(turn.id)?.mentions).toEqual([]);
  });

  it("totals one agent's usage across sessions for agents.describe's usage summary", () => {
    const { session, agents } = seedSession();
    store.usage.record({
      sessionId: session.id,
      agentId: agents[0]!.id,
      turnId: null,
      backend: "claude",
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheCreationTokens: 10,
      costUsd: 0.0125,
    });
    expect(store.usage.totalsByAgent(agents[0]!.id)).toEqual({
      input: 100,
      output: 20,
      cached: 910,
      costUsd: 0.0125,
    });
    expect(store.usage.totalsByAgent("agt_nope")).toEqual({ input: 0, output: 0, cached: 0, costUsd: 0 });
  });
});

describe("turns and blocks", () => {
  it("upserts a block by id instead of appending a duplicate", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "agent", status: "streaming" });

    const block = textBlock(session.id, turn.id, 0, "he");
    store.blocks.upsert(block);
    store.blocks.upsert({ ...block, text: "hello", updatedAt: block.updatedAt + 5 });

    const blocks = store.blocks.listByTurn(turn.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "text", text: "hello", index: 0 });
    expect(store.blocks.nextIndex(turn.id)).toBe(1);
  });

  it("preserves kind-specific payload for every block kind", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "agent" });
    const ts = Date.now();
    const envelope = { turnId: turn.id, sessionId: session.id, createdAt: ts, updatedAt: ts };

    store.blocks.upsert({
      ...envelope,
      id: newId("block"),
      kind: "tool_call",
      index: 0,
      name: "Bash",
      input: { command: "ls" },
      output: "a.ts\n",
      status: "success",
      toolUseId: "toolu_1",
    });
    store.blocks.upsert({
      ...envelope,
      id: newId("block"),
      kind: "question",
      index: 1,
      requestId: "req_1",
      questions: [{ question: "Which?", multiSelect: false, options: [{ label: "A" }] }],
      answers: { Which: "A" },
    });
    store.blocks.upsert({
      ...envelope,
      id: newId("block"),
      kind: "permission",
      index: 2,
      request: { requestId: "req_2", toolName: "Bash", input: { command: "rm" }, suggestions: [] },
      decision: null,
    });
    store.blocks.upsert({
      ...envelope,
      id: newId("block"),
      kind: "widget",
      index: 3,
      toolCallId: "toolu_2",
      serverName: "higgsfield",
      toolName: "animate",
      resourceUri: "ui://higgsfield/animate",
      htmlStatus: "ready",
      html: "<div>hi</div>",
      toolInput: { prompt: "a capybara" },
      toolResult: null,
      meta: null,
    });
    store.blocks.upsert({
      ...envelope,
      id: newId("block"),
      kind: "elicitation",
      index: 4,
      requestId: "req_3",
      schema: { type: "object", properties: { name: { type: "string" } } },
      answers: null,
      status: "pending",
    });

    const blocks = store.blocks.listByTurn(turn.id);
    expect(blocks.map((b) => b.kind)).toEqual([
      "tool_call",
      "question",
      "permission",
      "widget",
      "elicitation",
    ]);
    expect(blocks[0]).toMatchObject({ name: "Bash", status: "success", toolUseId: "toolu_1" });
    expect(blocks[1]).toMatchObject({ answers: { Which: "A" } });
    expect(blocks[2]).toMatchObject({ decision: null });
    expect(blocks[3]).toMatchObject({ htmlStatus: "ready", resourceUri: "ui://higgsfield/animate" });
    expect(blocks[4]).toMatchObject({ status: "pending" });
  });

  it("orders a session's blocks by turn then index", () => {
    const { session } = seedSession();
    const t1 = store.turns.create({ sessionId: session.id, role: "user" });
    const t2 = store.turns.create({ sessionId: session.id, role: "agent" });
    store.blocks.upsert(textBlock(session.id, t2.id, 1, "second-b"));
    store.blocks.upsert(textBlock(session.id, t2.id, 0, "second-a"));
    store.blocks.upsert(textBlock(session.id, t1.id, 0, "first"));

    const texts = store.blocks
      .listBySession(session.id)
      .map((b) => (b.kind === "text" ? b.text : b.kind));
    expect(texts).toEqual(["first", "second-a", "second-b"]);
  });

  it("cascades block and turn deletion when a session goes away", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "agent" });
    store.blocks.upsert(textBlock(session.id, turn.id, 0, "bye"));
    store.db.run("DELETE FROM sessions WHERE id = ?", session.id);
    expect(store.db.all("SELECT id FROM turns")).toHaveLength(0);
    expect(store.db.all("SELECT id FROM blocks")).toHaveLength(0);
  });

  it("tracks turn status through a streamed turn", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "agent", status: "pending" });
    expect(store.turns.setStatus(turn.id, "streaming")?.status).toBe("streaming");
    expect(store.turns.setStatus(turn.id, "done")?.status).toBe("done");
  });
});

describe("tool_outputs (migration 0002 — a block's outputRef)", () => {
  it("puts and gets a full value by id, minting one when none is given", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "agent" });
    const block = store.blocks.upsert(textBlock(session.id, turn.id, 0, "hi"));
    const whole = { lines: Array.from({ length: 5000 }, (_, i) => `line ${i}`) };

    const saved = store.toolOutputs.put({ blockId: block.id, content: whole });
    expect(saved.id).toMatch(/^tout_[0-9a-f]{32}$/);
    expect(store.toolOutputs.get(saved.id)).toEqual(saved);
    expect(store.toolOutputs.get(saved.id)?.content).toEqual(whole);
    expect(store.toolOutputs.get("tout_nope")).toBeNull();
  });

  it("overwrites content by id instead of inserting a duplicate row", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "agent" });
    const block = store.blocks.upsert(textBlock(session.id, turn.id, 0, "hi"));

    store.toolOutputs.put({ id: "tout_fixed", blockId: block.id, content: "first" });
    store.toolOutputs.put({ id: "tout_fixed", blockId: block.id, content: "second" });

    expect(store.toolOutputs.get("tout_fixed")?.content).toBe("second");
    expect(store.db.all("SELECT id FROM tool_outputs")).toHaveLength(1);
  });

  it("cascades on the owning block's deletion", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "agent" });
    const block = store.blocks.upsert(textBlock(session.id, turn.id, 0, "hi"));
    const saved = store.toolOutputs.put({ blockId: block.id, content: "x" });

    store.db.run("DELETE FROM blocks WHERE id = ?", block.id);
    expect(store.toolOutputs.get(saved.id)).toBeNull();
  });
});

describe("usage events", () => {
  it("records events and totals them per session", () => {
    const { session, agents } = seedSession();
    store.usage.record({
      sessionId: session.id,
      agentId: agents[0]!.id,
      turnId: null,
      backend: "claude",
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheCreationTokens: 10,
      costUsd: 0.0125,
    });
    store.usage.record({
      sessionId: session.id,
      agentId: agents[0]!.id,
      turnId: null,
      backend: "claude",
      model: "claude-opus-4-5",
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreationTokens: 0,
      costUsd: 0.002,
    });

    expect(store.usage.listBySession(session.id)).toHaveLength(2);
    const totals = store.usage.totalsBySession(session.id);
    expect(totals.inputTokens).toBe(150);
    expect(totals.cacheReadTokens).toBe(1000);
    expect(totals.costUsd).toBeCloseTo(0.0145, 6);
  });
});

describe("settings", () => {
  it("returns the shipping defaults for an empty table", () => {
    const s = store.settings.all();
    expect(s.theme).toBe("system");
    expect(s.hopCap).toBe(3);
  });

  it("patches, persists, and survives a reopen", () => {
    store.settings.patch({ theme: "dark", hopCap: 5 });
    store.close();
    store = open();
    const s = store.settings.all();
    expect(s.theme).toBe("dark");
    expect(s.hopCap).toBe(5);
    expect(s.defaultBackend).toBe("claude");
  });

  it("ignores unknown keys left behind by a newer build", () => {
    store.settings.setRaw("some_future_key", { a: 1 });
    expect(() => store.settings.all()).not.toThrow();
    expect(store.settings.all().theme).toBe("system");
  });

  it("stores raw non-user state such as window geometry", () => {
    store.settings.setRaw("window.state", { width: 1400, height: 900, maximized: false });
    expect(store.settings.getRaw("window.state", null)).toEqual({
      width: 1400,
      height: 900,
      maximized: false,
    });
    expect(store.settings.getRaw("missing.key", "fallback")).toBe("fallback");
  });
});

describe("restart persistence (R15)", () => {
  it("restores the session list and a session's transcript after reopening", () => {
    const { session } = seedSession();
    const userTurn = store.turns.create({ sessionId: session.id, role: "user" });
    store.blocks.upsert(textBlock(session.id, userTurn.id, 0, "hello"));
    const agentTurn = store.turns.create({
      sessionId: session.id,
      agentId: store.sessions.agents(session.id)[0]!.id,
      role: "agent",
      parentTurnId: userTurn.id,
      hopIndex: 1,
    });
    store.blocks.upsert(textBlock(session.id, agentTurn.id, 0, "echo: hello"));
    store.close();

    store = open();
    const sessions = store.sessions.list();
    expect(sessions.map((s) => s.id)).toEqual([session.id]);
    const turns = store.turns.list(session.id);
    expect(turns.map((t) => t.role)).toEqual(["user", "agent"]);
    expect(turns[1]!.parentTurnId).toBe(userTurn.id);
    expect(turns[1]!.hopIndex).toBe(1);
    const blocks = store.blocks.listBySession(session.id);
    expect(blocks.map((b) => (b.kind === "text" ? b.text : b.kind))).toEqual([
      "hello",
      "echo: hello",
    ]);
  });
});

describe("reopening after a crash", () => {
  it("closes out turns and sessions the previous run left in flight", () => {
    const { session } = seedSession();
    const turn = store.turns.create({ sessionId: session.id, role: "agent", status: "streaming" });
    const done = store.turns.create({ sessionId: session.id, role: "user", status: "done" });
    store.sessions.setStatus(session.id, "running");
    expect(store.turns.hasStreaming(session.id)).toBe(true);
    store.close();

    // A `streaming` row can only be a crash or a quit mid-turn: nothing is
    // writing to it at the moment the file is opened. Left alone it locks the
    // session's composer forever (`isBusy` stays true, Stop has nothing to stop).
    store = open();
    expect(store.reconciled).toEqual({ turns: 1, sessions: 1 });
    expect(store.turns.get(turn.id)?.status).toBe("interrupted");
    expect(store.turns.get(done.id)?.status).toBe("done");
    expect(store.sessions.get(session.id)?.status).toBe("idle");
    expect(store.turns.hasStreaming(session.id)).toBe(false);
  });

  it("leaves a healthy database alone", () => {
    const { session } = seedSession();
    store.close();
    store = open();
    expect(store.reconciled).toEqual({ turns: 0, sessions: 0 });
    expect(store.sessions.get(session.id)?.status).toBe("idle");
  });
});

describe("Phase 5: workspace_layouts, dev_servers, tasks (migration 0004)", () => {
  it("workspace_layouts: get() is null until set(), then round-trips and survives a reopen", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "layout") });
    expect(store.workspaceLayouts.get(project.id)).toBeNull();

    const saved = store.workspaceLayouts.set(project.id, { grid: { root: { type: "leaf" } } });
    expect(saved.layoutJson).toEqual({ grid: { root: { type: "leaf" } } });

    store.close();
    store = open();
    expect(store.workspaceLayouts.get(project.id)?.layoutJson).toEqual({
      grid: { root: { type: "leaf" } },
    });
  });

  it("workspace_layouts: set() overwrites the one row a project has, never appends", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "layout2") });
    store.workspaceLayouts.set(project.id, { v: 1 });
    store.workspaceLayouts.set(project.id, { v: 2 });
    expect(store.workspaceLayouts.get(project.id)?.layoutJson).toEqual({ v: 2 });
    expect(store.db.all("SELECT project_id FROM workspace_layouts")).toHaveLength(1);
  });

  it("dev_servers: create() mints an id, defaults args to [], and round-trips port/url/env", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "servers") });
    const server = store.devServers.create({
      projectId: project.id,
      server: {
        name: "web",
        source: "custom",
        command: "npm run dev",
        args: [],
        cwd: project.path,
        port: 3000,
        url: "http://localhost:3000",
        env: { NODE_ENV: "development" },
      },
    });
    expect(server.id).toMatch(/^srv_[0-9a-f]{32}$/);
    expect(store.devServers.get(server.id)).toEqual(server);
    expect(store.devServers.listByProject(project.id)).toEqual([server]);
  });

  it("dev_servers: update() merge-patches without clobbering unrelated fields, and null clears port/url/env", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "servers2") });
    const server = store.devServers.create({
      projectId: project.id,
      server: { name: "web", source: "package.json", command: "npm run dev", args: [], cwd: project.path },
    });
    expect(server.port).toBeUndefined();

    const withUrl = store.devServers.update(server.id, { port: 4000, url: "http://localhost:4000" });
    expect(withUrl).toMatchObject({ name: "web", port: 4000, url: "http://localhost:4000" });

    const cleared = store.devServers.update(server.id, { port: null });
    expect(cleared.port).toBeUndefined();
    expect(cleared.url).toBe("http://localhost:4000"); // untouched by the port-only patch
  });

  it("dev_servers: upsert() by id updates in place instead of duplicating (a re-detected script)", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "servers3") });
    const ts = Date.now();
    const detected = {
      id: "srv_deterministic",
      projectId: project.id,
      name: "web",
      source: "package.json" as const,
      command: "npm run dev",
      args: [],
      cwd: project.path,
      createdAt: ts,
      updatedAt: ts,
    };
    store.devServers.upsert(detected);
    store.devServers.upsert({ ...detected, url: "http://localhost:5173", updatedAt: ts + 1 });
    const rows = store.devServers.listByProject(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: "http://localhost:5173" });
  });

  it("dev_servers: remove() deletes the row", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "servers4") });
    const server = store.devServers.create({
      projectId: project.id,
      server: { name: "web", source: "custom", command: "npm run dev", args: [], cwd: project.path },
    });
    expect(store.devServers.remove(server.id)).toBe(true);
    expect(store.devServers.get(server.id)).toBeNull();
    expect(store.devServers.remove(server.id)).toBe(false);
  });

  it("tasks: create() defaults status/source/order, and reads back sessionId/agentId as null when omitted", () => {
    const task = store.tasks.create({ title: "Wire the terminal pane" });
    expect(task).toMatchObject({
      title: "Wire the terminal pane",
      status: "pending",
      source: "manual",
      order: 0,
      sessionId: null,
      agentId: null,
    });
    expect(store.tasks.get(task.id)).toEqual(task);
  });

  it("tasks: upsert() by id keeps a TodoWrite-derived task's row stable across re-sends", () => {
    const { session, agents } = seedSession();
    const ts = Date.now();
    const derived: Task = {
      id: "tsk_todo_0",
      sessionId: session.id,
      agentId: agents[0]!.id,
      title: "Read the SPEC",
      status: "in_progress",
      source: "todo_write",
      order: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    store.tasks.upsert(derived);
    store.tasks.upsert({ ...derived, status: "completed", updatedAt: ts + 1 });

    const rows = store.tasks.listBySession(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", source: "todo_write" });
  });

  it("tasks: list() dispatches on sessionId, then projectId (joined through sessions), else everything", () => {
    const { project, session } = seedSession();
    store.tasks.create({ sessionId: session.id, title: "In this session" });
    store.tasks.create({ title: "Belongs to nothing" });

    expect(store.tasks.list({ sessionId: session.id }).map((t) => t.title)).toEqual([
      "In this session",
    ]);
    expect(store.tasks.list({ projectId: project.id }).map((t) => t.title)).toEqual([
      "In this session",
    ]);
    expect(store.tasks.list().map((t) => t.title).sort()).toEqual([
      "Belongs to nothing",
      "In this session",
    ]);
  });

  it("tasks: update() merge-patches only title/status/agentId/order, never source or sessionId", () => {
    const { session } = seedSession();
    const task = store.tasks.create({ sessionId: session.id, title: "Draft", source: "codex_plan" });

    const patched = store.tasks.update(task.id, { status: "completed", order: 3 });
    expect(patched).toMatchObject({
      title: "Draft",
      status: "completed",
      source: "codex_plan",
      sessionId: session.id,
      order: 3,
    });

    expect(() => store.tasks.update("tsk_nope", { status: "completed" })).toThrow(/unknown task/);
  });

  it("tasks: remove() deletes the row", () => {
    const task = store.tasks.create({ title: "Throwaway" });
    expect(store.tasks.remove(task.id)).toBe(true);
    expect(store.tasks.get(task.id)).toBeNull();
  });
});

describe("Phase 6: global settings, integrations caches (migration 0005)", () => {
  it("globalSettings.all() returns the shipping defaults for an empty row", () => {
    expect(store.globalSettings.all()).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("globalSettings.patch() merges one section without clobbering its siblings, and survives a reopen", () => {
    store.globalSettings.patch({ general: { submitWithCtrlEnter: true } });
    expect(store.globalSettings.all().general).toEqual({
      ...DEFAULT_GLOBAL_SETTINGS.general,
      submitWithCtrlEnter: true,
    });

    // A second, unrelated patch must not reset the first patch's field —
    // the same jitless-defaults hazard `SettingsRepo.patch` already avoids
    // for the flat `Settings`.
    store.globalSettings.patch({ appearance: { theme: "dark" } });
    const afterSecond = store.globalSettings.all();
    expect(afterSecond.general.submitWithCtrlEnter).toBe(true);
    expect(afterSecond.appearance.theme).toBe("dark");

    store.close();
    store = open();
    expect(store.globalSettings.all().general.submitWithCtrlEnter).toBe(true);
    expect(store.globalSettings.all().appearance.theme).toBe("dark");
  });

  /**
   * [7-P1] `general.defaultModel` is a **derived view** of
   * `backends[general.defaultBackend].model`, so it is stripped before every
   * write. Storing it too would let the two drift — and, worse, would leave a
   * stale alias behind after `reset("backends")` cleared the canonical model,
   * which the next read would resurrect as if the user had chosen it.
   */
  it("never persists the derived general.defaultModel alias", () => {
    // The alias names the selected backend's model, so this is one write of
    // one field — it is translated onto `backends.claude.model` and the alias
    // itself is never stored.
    store.globalSettings.patch({ general: { defaultModel: "claude-sonnet-4-5" } });
    const raw = JSON.parse(
      store.db.get<{ value_json: string }>(
        "SELECT value_json FROM settings WHERE key = ?",
        "global_settings",
      )!.value_json,
    ) as { general: Record<string, unknown>; backends: Record<string, { model?: string }> };
    expect("defaultModel" in raw.general).toBe(false);
    expect(raw.backends.claude?.model).toBe("claude-sonnet-4-5");

    // Clearing the canonical model leaves nothing behind to resurrect.
    store.globalSettings.reset("backends");
    const after = JSON.parse(
      store.db.get<{ value_json: string }>(
        "SELECT value_json FROM settings WHERE key = ?",
        "global_settings",
      )!.value_json,
    ) as { general: Record<string, unknown>; backends: Record<string, { model?: string }> };
    expect("defaultModel" in after.general).toBe(false);
    expect(after.backends.claude?.model).toBeUndefined();
  });

  /**
   * [7-P1] The four read states used to collapse into "the shipping defaults",
   * and the next `patch`/`reset` then wrote a merge of those defaults straight
   * over bytes this build could not parse — losing a newer build's settings,
   * or a user's real preferences, with no message at all.
   */
  describe("globalSettings read states", () => {
    function rawRow(): string | undefined {
      return store.db.get<{ value_json: string }>(
        "SELECT value_json FROM settings WHERE key = ?",
        "global_settings",
      )?.value_json;
    }

    it("reports a missing row as writable defaults", () => {
      const read = store.globalSettings.read();
      expect(read.state).toBe("missing");
      expect(read.writable).toBe(true);
      expect(read.settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    });

    it("reports a row this build wrote as valid and writable", () => {
      store.globalSettings.patch({ appearance: { theme: "dark" } });
      const read = store.globalSettings.read();
      expect(read.state).toBe("valid");
      expect(read.writable).toBe(true);
      expect(read.settings.appearance.theme).toBe("dark");
    });

    it("serves a newer build's row read-only and preserves its bytes", () => {
      const future = JSON.stringify({ version: 99, appearance: { theme: "dark" }, futureField: 1 });
      store.settings.setRaw("global_settings", JSON.parse(future));
      const read = store.globalSettings.read();
      expect(read.state).toBe("future");
      expect(read.writable).toBe(false);
      expect(read.reason).toMatch(/newer version/i);
      expect(read.settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
      expect(() => store.globalSettings.patch({ appearance: { theme: "light" } })).toThrow(
        /newer version/i,
      );
      expect(() => store.globalSettings.reset("all")).toThrow(/newer version/i);
      // The unknown field a newer build wrote is still there.
      expect(JSON.parse(rawRow()!)).toMatchObject({ version: 99, futureField: 1 });
    });

    it("serves an unparseable row read-only and preserves its bytes", () => {
      store.db.run(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        "global_settings",
        "{not json",
        Date.now(),
      );
      const read = store.globalSettings.read();
      expect(read.state).toBe("corrupt");
      expect(read.writable).toBe(false);
      expect(read.settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
      expect(() => store.globalSettings.patch({ closeToTray: false })).toThrow(/could not read/i);
      expect(rawRow()).toBe("{not json");
    });
  });

  it("globalSettings.reset() resets one section, and 'all' resets everything", () => {
    store.globalSettings.patch({
      general: { defaultModel: "claude-sonnet-4-5" },
      appearance: { theme: "dark" },
    });
    const generalReset = store.globalSettings.reset("general");
    expect(generalReset.general).toEqual(DEFAULT_GLOBAL_SETTINGS.general);
    expect(generalReset.appearance.theme).toBe("dark"); // untouched

    const allReset = store.globalSettings.reset("all");
    expect(allReset).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("mcpServers: upsert() mints a deterministic id from backend+scope+name and round-trips every field", () => {
    const entry = store.mcpServers.upsert({
      backend: "claude",
      name: "higgsfield",
      transport: "stdio",
      command: "npx",
      args: ["-y", "higgsfield-mcp"],
      env: { HIGGSFIELD_API_KEY: "${HIGGSFIELD_API_KEY}" },
      scope: "project",
      source: "C:\\proj\\.mcp.json",
      enabled: true,
      tools: ["animate", "edit"],
    });
    expect(entry.tools).toEqual(["animate", "edit"]);
    expect(store.mcpServers.get("claude", "project", "higgsfield")).toEqual(entry);
  });

  it("mcpServers: re-upserting the same natural key updates in place instead of duplicating", () => {
    const draft = {
      backend: "codex" as const,
      name: "docs",
      transport: "http" as const,
      url: "https://docs.example/mcp",
      scope: "user" as const,
      source: "live",
      enabled: true,
    };
    store.mcpServers.upsert(draft);
    store.mcpServers.upsert({ ...draft, enabled: false, status: "failed" });
    const rows = store.mcpServers.listByBackend("codex");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enabled: false, status: "failed" });
  });

  it("mcpServers: listByBackend() only returns that backend's entries", () => {
    store.mcpServers.upsert({
      backend: "claude",
      name: "a",
      transport: "stdio",
      scope: "user",
      source: "live",
      enabled: true,
    });
    store.mcpServers.upsert({
      backend: "codex",
      name: "b",
      transport: "stdio",
      scope: "user",
      source: "live",
      enabled: true,
    });
    expect(store.mcpServers.listByBackend("claude").map((e) => e.name)).toEqual(["a"]);
    expect(store.mcpServers.listByBackend("api")).toEqual([]);
  });

  it("mcpServers: update() merge-patches by natural key and throws for an unknown one", () => {
    store.mcpServers.upsert({
      backend: "claude",
      name: "a",
      transport: "stdio",
      command: "npx",
      scope: "user",
      source: "live",
      enabled: true,
    });
    const updated = store.mcpServers.update("claude", "user", "a", { enabled: false });
    expect(updated).toMatchObject({ enabled: false, command: "npx" }); // command untouched
    expect(() => store.mcpServers.update("claude", "user", "nope", { enabled: true })).toThrow(
      /unknown mcp server/,
    );
  });

  it("mcpServers: remove() deletes by natural key", () => {
    store.mcpServers.upsert({
      backend: "claude",
      name: "a",
      transport: "stdio",
      scope: "user",
      source: "live",
      enabled: true,
    });
    expect(store.mcpServers.remove("claude", "user", "a")).toBe(true);
    expect(store.mcpServers.get("claude", "user", "a")).toBeNull();
    expect(store.mcpServers.remove("claude", "user", "a")).toBe(false);
  });

  it("plugins: upsert() keys by backend+name, defaults commands/skills to [], and version round-trips through the empty-string column", () => {
    const plugin = store.plugins.upsert({
      backend: "claude",
      name: "cockpit",
      marketplace: "anthropic-experimental",
      source: "C:\\Users\\x\\.claude\\plugins\\installed_plugins.json",
    });
    expect(plugin).toMatchObject({ enabled: true, installed: true, commands: [], skills: [] });
    expect(plugin.version).toBeUndefined();
    expect(store.plugins.get("claude", "cockpit")).toEqual(plugin);
  });

  it("plugins: setEnabled() flips the flag without touching manifest fields, and throws for an unknown plugin", () => {
    store.plugins.upsert({
      backend: "claude",
      name: "cockpit",
      commands: ["/pilot"],
      skills: [],
      source: "live",
    });
    const disabled = store.plugins.setEnabled("claude", "cockpit", false);
    expect(disabled).toMatchObject({ enabled: false, commands: ["/pilot"] });
    expect(() => store.plugins.setEnabled("claude", "nope", true)).toThrow(/unknown plugin/);
  });

  it("plugins: listByBackend() filters and remove() deletes", () => {
    store.plugins.upsert({ backend: "claude", name: "a", source: "live" });
    store.plugins.upsert({ backend: "codex", name: "b", source: "live" });
    expect(store.plugins.listByBackend("claude").map((p) => p.name)).toEqual(["a"]);
    expect(store.plugins.remove("claude", "a")).toBe(true);
    expect(store.plugins.listByBackend("claude")).toEqual([]);
  });

  it("skills: upsert() keys by backend+scope+name, reusing the 0001 source column for scope", () => {
    const skill = store.skills.upsert({
      backend: "claude",
      name: "graphify",
      scope: "user",
      path: "C:\\Users\\x\\.claude\\skills\\graphify\\SKILL.md",
      description: "Build a knowledge graph",
    });
    expect(skill.enabled).toBe(true);
    expect(store.skills.get("claude", "user", "graphify")).toEqual(skill);
    // The row's own `source` column literally holds the scope value.
    expect(store.db.get<{ source: string }>("SELECT source FROM skills WHERE id = ?", "claude:user:graphify")?.source).toBe(
      "user",
    );
  });

  it("skills: setEnabled() resolves by name alone when scope is omitted, and disambiguates when it is given", () => {
    store.skills.upsert({ backend: "claude", name: "pilot", scope: "user", path: "u.md" });
    store.skills.upsert({ backend: "claude", name: "pilot", scope: "project", path: "p.md" });

    const byName = store.skills.setEnabled("claude", "pilot", false);
    expect(byName.enabled).toBe(false);

    const byScope = store.skills.setEnabled("claude", "pilot", false, "project");
    expect(byScope.scope).toBe("project");
    expect(() => store.skills.setEnabled("claude", "nope", true)).toThrow(/unknown skill/);
  });

  it("skills: listByBackend() filters by backend", () => {
    store.skills.upsert({ backend: "claude", name: "a", scope: "user", path: "a.md" });
    store.skills.upsert({ backend: "codex", name: "b", scope: "user", path: "b.md" });
    expect(store.skills.listByBackend("claude").map((s) => s.name)).toEqual(["a"]);
  });

  it("toolPolicies: upsert() is idempotent by backend+scope+pattern (migration 0005's unique index)", () => {
    store.toolPolicies.upsert({ backend: "codex", pattern: "Bash(rm *)", decision: "deny", scope: "global" });
    store.toolPolicies.upsert({ backend: "codex", pattern: "Bash(rm *)", decision: "ask", scope: "global" });
    const rows = store.toolPolicies.listByBackend("codex");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "ask" });
  });

  it("toolPolicies: listByBackend() filters by backend and remove() deletes by natural key", () => {
    store.toolPolicies.upsert({ backend: "claude", pattern: "Bash(*)", decision: "ask", scope: "global" });
    store.toolPolicies.upsert({ backend: "codex", pattern: "Bash(*)", decision: "allow", scope: "project" });
    expect(store.toolPolicies.listByBackend("claude").map((p) => p.decision)).toEqual(["ask"]);
    expect(store.toolPolicies.remove("claude", "global", "Bash(*)")).toBe(true);
    expect(store.toolPolicies.listByBackend("claude")).toEqual([]);
    // The other backend's row is untouched.
    expect(store.toolPolicies.listByBackend("codex")).toHaveLength(1);
  });
});

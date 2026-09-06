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
import { newId, type Block, type TextBlock } from "@capygen/shared";
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
        { name: "codey", backend: "codex", model: "gpt-5", role: "agent", config: null },
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

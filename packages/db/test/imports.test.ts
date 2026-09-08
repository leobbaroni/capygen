import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptImportSnapshot } from "@capygen/shared";
import {
  migrate,
  openRaw,
  openStore,
  readMigrations,
  type CapygenStore,
} from "../src/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

let dir: string;
let file: string;
let store: CapygenStore;

function open(): CapygenStore {
  return openStore(file, { migrationsDir: MIGRATIONS_DIR });
}

function snapshot(overrides: Partial<TranscriptImportSnapshot> = {}): TranscriptImportSnapshot {
  return {
    backend: "codex",
    format: "codex-rollout/rust-v0.153.4",
    nativeId: "thread-native-1",
    title: "Imported example",
    sourcePath: "C:\\selected\\rollout.jsonl",
    sourceBytes: 123,
    sourceSha256: "a".repeat(64),
    cwd: "C:\\historical",
    startedAt: "2026-09-07T00:00:00.000Z",
    endedAt: "2026-09-07T00:01:00.000Z",
    entries: [
      {
        index: 0,
        at: "2026-09-07T00:00:00.000Z",
        label: "user",
        truncated: false,
        kind: "message",
        speaker: "user",
        text: "Build it",
      },
      {
        index: 1,
        at: "2026-09-07T00:01:00.000Z",
        label: "Bash (historical)",
        truncated: false,
        kind: "activity-result",
        name: "Bash",
        text: "done",
        failed: false,
      },
    ],
    counts: {
      records: 3,
      entries: 2,
      messages: 1,
      thinking: 0,
      activities: 1,
      notices: 0,
      droppedConfiguration: 1,
      unknownRecords: 0,
      echoedEvents: 0,
      truncatedTexts: 0,
      normalizedBytes: 900,
    },
    unknownTypes: [],
    warnings: [{ code: "configuration-dropped", message: "Configuration was omitted", count: 1 }],
    complete: true,
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-import-db-"));
  file = path.join(dir, "capygen.db");
  store = open();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // A test may already have closed the connection.
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("transcript import persistence", () => {
  it("commits one read-only artifact transactionally, with provenance and inert chronological entries", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "destination") });
    const input = snapshot();

    const result = store.imports.commit({ projectId: project.id, snapshot: input });

    expect(result.duplicate).toBe(false);
    expect(result.session).toMatchObject({
      projectId: project.id,
      title: "Imported example",
      mode: "solo",
      status: "idle",
      leadAgentId: null,
      origin: "import",
      continuationSourceSessionId: null,
    });
    expect(store.sessions.agents(result.session.id)).toEqual([]);
    expect(() =>
      store.sessions.addAgent(result.session.id, { backend: "codex", model: "gpt-5" }),
    ).toThrow(/read-only import/i);
    expect(() => store.sessions.setMode(result.session.id, "round-table")).toThrow(/read-only import/i);
    expect(() => store.sessions.updateSettings(result.session.id, { hopCap: 2 })).toThrow(/read-only import/i);
    expect(() => store.sessions.setStatus(result.session.id, "running")).toThrow(/read-only import/i);
    expect(store.imports.get(result.session.id)).toEqual({
      sessionId: result.session.id,
      importedAt: expect.any(Number),
      ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "entries")),
    });
    expect(store.imports.entries(result.session.id)).toEqual(input.entries);

    const raw = store.db.get<{ origin: string; continuation_source_session_id: string | null }>(
      "SELECT origin, continuation_source_session_id FROM sessions WHERE id = ?",
      result.session.id,
    );
    expect(raw).toEqual({ origin: "import", continuation_source_session_id: null });
  });

  it("survives restart and deduplicates the same backend/native id/hash across destinations", () => {
    const firstProject = store.projects.upsertByPath({ path: path.join(dir, "one") });
    const secondProject = store.projects.upsertByPath({ path: path.join(dir, "two") });
    const created = store.imports.commit({ projectId: firstProject.id, snapshot: snapshot() });
    store.close();

    store = open();
    const duplicate = store.imports.commit({ projectId: secondProject.id, snapshot: snapshot() });

    expect(duplicate).toEqual({ session: created.session, duplicate: true });
    expect(store.sessions.list({ includeArchived: true })).toHaveLength(1);
    expect(store.imports.entries(created.session.id)).toEqual(snapshot().entries);
  });

  it("refuses an unknown destination project even when the snapshot is already imported", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "destination") });
    store.imports.commit({ projectId: project.id, snapshot: snapshot() });

    expect(() =>
      store.imports.commit({ projectId: "project_missing", snapshot: snapshot() }),
    ).toThrow(/unknown project: project_missing/);
  });

  it("deduplicates through a second store connection and enforces provenance uniqueness in SQLite", () => {
    const firstProject = store.projects.upsertByPath({ path: path.join(dir, "one") });
    const secondProject = store.projects.upsertByPath({ path: path.join(dir, "two") });
    const created = store.imports.commit({ projectId: firstProject.id, snapshot: snapshot() });
    const secondStore = open();
    try {
      expect(secondStore.imports.commit({ projectId: secondProject.id, snapshot: snapshot() })).toEqual({
        session: created.session,
        duplicate: true,
      });

      secondStore.db.run(
        `INSERT INTO sessions
           (id, project_id, origin, artifact_kind, mode, title, status, archived,
            created_at, updated_at)
         VALUES (?, ?, 'import', 'native-transcript', 'solo', '', 'idle', 0, 1, 1)`,
        "session_collision",
        secondProject.id,
      );
      expect(() =>
        secondStore.db.run(
          `INSERT INTO transcript_imports
             (session_id, backend, native_id, source_path, source_sha256, format,
              metadata_json, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          "session_collision",
          "codex",
          "thread-native-1",
          "C:\\other\\rollout.jsonl",
          "a".repeat(64),
          "codex-rollout/rust-v0.153.4",
          "{}",
          2,
        ),
      ).toThrow(/unique constraint/i);
    } finally {
      secondStore.close();
    }
  });

  it("keeps snapshots with the same native id but a different hash separate", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "destination") });
    const first = store.imports.commit({ projectId: project.id, snapshot: snapshot() });
    const second = store.imports.commit({
      projectId: project.id,
      snapshot: snapshot({ sourceSha256: "b".repeat(64) }),
    });

    expect(second.duplicate).toBe(false);
    expect(second.session.id).not.toBe(first.session.id);
  });

  it("pages entries in chronological order and reads a bounded chronological tail", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "destination") });
    const base = snapshot();
    const third = {
      index: 2,
      at: "2026-09-07T00:02:00.000Z",
      label: "notice",
      truncated: false,
      kind: "notice" as const,
      text: "older history omitted",
    };
    const created = store.imports.commit({
      projectId: project.id,
      snapshot: snapshot({
        entries: [...base.entries, third],
        counts: { ...base.counts, entries: 3, notices: 1 },
      }),
    });

    expect(store.imports.entries(created.session.id, { offset: 1, limit: 1 })).toEqual([
      base.entries[1],
    ]);
    expect(store.imports.tail(created.session.id, 2)).toEqual([base.entries[1], third]);
    expect(() => store.imports.entries(created.session.id, { limit: 101 })).toThrow(/1 to 100/);
  });

  it("rolls back the session, provenance and entries when any entry insert fails", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "destination") });
    store.db.exec(`
      CREATE TRIGGER fail_second_import_entry
      BEFORE INSERT ON transcript_import_entries
      WHEN NEW.entry_index = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected entry failure');
      END;
    `);

    expect(() => store.imports.commit({ projectId: project.id, snapshot: snapshot() })).toThrow(
      /injected entry failure/,
    );
    expect(store.sessions.list({ includeArchived: true })).toEqual([]);
    expect(store.db.get("SELECT session_id FROM transcript_imports")).toBeUndefined();
    expect(store.db.get("SELECT session_id FROM transcript_import_entries")).toBeUndefined();
  });

  it("links only an empty live session to an imported source", () => {
    const project = store.projects.upsertByPath({ path: path.join(dir, "destination") });
    const source = store.imports.commit({ projectId: project.id, snapshot: snapshot() }).session;
    const destination = store.sessions.create({
      projectId: project.id,
      mode: "solo",
      title: "Continuation",
      agents: [{ name: "capy", backend: "codex", model: "gpt-5", role: "lead", config: null }],
    }).session;

    expect(store.imports.linkContinuation(destination.id, source.id)).toMatchObject({
      id: destination.id,
      origin: "live",
      continuationSourceSessionId: source.id,
    });
    expect(() => store.imports.linkContinuation(source.id, source.id)).toThrow(/live session/i);

    const missingLead = store.sessions.create({
      projectId: project.id,
      mode: "solo",
      title: "No backend",
      agents: [],
    }).session;
    expect(() => store.imports.linkContinuation(missingLead.id, source.id)).toThrow(/lead agent/i);

    const nonImportSource = store.sessions.create({
      projectId: project.id,
      mode: "solo",
      title: "Other live",
      agents: [{ name: "other", backend: "codex", model: "gpt-5", role: "lead", config: null }],
    }).session;
    expect(() => store.imports.linkContinuation(nonImportSource.id, destination.id)).toThrow(
      /imported source/i,
    );

    const withHistory = store.sessions.create({
      projectId: project.id,
      mode: "solo",
      title: "Already used",
      agents: [{ name: "used", backend: "codex", model: "gpt-5", role: "lead", config: null }],
    }).session;
    store.turns.create({ sessionId: withHistory.id, role: "user" });
    expect(() => store.imports.linkContinuation(withHistory.id, source.id)).toThrow(/fresh session/i);
  });

  it("backs up and migrates a legacy 0005 database without changing its live session", () => {
    store.close();
    fs.rmSync(file, { force: true });
    const legacy = openRaw(file, { wal: false });
    const oldMigrations = readMigrations(MIGRATIONS_DIR).filter((migration) => migration.id <= "0005_integrations_backend_column");
    migrate(legacy, oldMigrations);
    legacy.run(
      "INSERT INTO projects (id, path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      "project_legacy", "C:\\legacy", "legacy", 1, 1,
    );
    legacy.run(
      "INSERT INTO sessions (id, project_id, mode, title, status, archived, created_at, updated_at) VALUES (?, ?, 'solo', 'Legacy', 'idle', 0, ?, ?)",
      "session_legacy", "project_legacy", 1, 1,
    );
    legacy.close();

    store = open();
    // Everything after the legacy 0005 snapshot, derived so a new migration
    // does not break a case about *this* one.
    expect(store.migration.applied).toEqual(
      readMigrations(MIGRATIONS_DIR)
        .map((m) => m.id)
        .filter((id) => id > "0005_integrations_backend_column"),
    );
    expect(store.migration.backupFile).toBeTruthy();
    expect(store.sessions.get("session_legacy")).toMatchObject({
      title: "Legacy",
      origin: "live",
      continuationSourceSessionId: null,
    });

    const backup = openRaw(store.migration.backupFile!, { wal: false });
    expect(backup.get("SELECT id FROM sessions WHERE id = 'session_legacy'")).toBeTruthy();
    expect(backup.get("SELECT name FROM sqlite_master WHERE name = 'transcript_imports'")).toBeUndefined();
    expect(backup.all<{ name: string }>("PRAGMA table_info(sessions)").map((column) => column.name)).not.toContain("origin");
    backup.close();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShareBundle, ShareComment, ShareEntry, TranscriptImportSnapshot } from "@capygen/shared";
import { SharesRepo, openStore, type CapygenStore, type Database } from "../src/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

let dir: string;
let file: string;
let store: CapygenStore;
let projectId: string;

const open = (): CapygenStore => openStore(file, { migrationsDir: MIGRATIONS_DIR });

// The override bag is deliberately loose so a case can build a non-message
// entry or an out-of-range index; the cast is what lets it stay one helper.
const entry = (index: number, over: Record<string, unknown> = {}): ShareEntry => ({
  index, at: null, label: "assistant", truncated: false,
  kind: "message", speaker: "assistant", text: `Shared reply ${index}`, ...over,
} as ShareEntry);

const comment = (over: Record<string, unknown> = {}): ShareComment => ({
  id: "b".repeat(32), entryIndex: 0, author: "Reviewer", body: "Looks right",
  createdAt: "2026-09-07T11:00:00Z", replyToId: null, resolved: false, ...over,
} as ShareComment);

function bundle(over: Partial<ShareBundle> = {}): ShareBundle {
  return {
    kind: "capygen.share", version: 1, bundleId: "a".repeat(32),
    createdAt: "2026-09-07T10:00:00Z", appVersion: "0.1.0",
    source: {
      title: "Shared session", mode: "solo", startedAt: null, endedAt: null,
      agents: [{ label: "Assistant", backend: "claude", model: "claude-opus-5" }],
    },
    entries: [entry(0)],
    counts: { entries: 1, messages: 1, thinking: 0, activities: 0, notices: 0,
      truncatedTexts: 0, droppedInteractive: 0, droppedThinking: 0, droppedWidgets: 0,
      droppedUsage: 0, redactions: 0 },
    comments: [],
    ...over,
  } as ShareBundle;
}

function snapshot(over: Partial<TranscriptImportSnapshot> = {}): TranscriptImportSnapshot {
  return {
    backend: "codex", format: "codex-rollout/rust-v0.153.4", nativeId: "thread-native-1",
    title: "Imported example", sourcePath: "C:\\selected\\rollout.jsonl", sourceBytes: 123,
    sourceSha256: "a".repeat(64), cwd: "C:\\historical", startedAt: null, endedAt: null,
    entries: [{ index: 0, at: null, label: "user", truncated: false,
      kind: "message", speaker: "user", text: "Build it" }],
    counts: { records: 1, entries: 1, messages: 1, thinking: 0, activities: 0, notices: 0,
      droppedConfiguration: 0, unknownRecords: 0, echoedEvents: 0, truncatedTexts: 0,
      normalizedBytes: 400 },
    unknownTypes: [], warnings: [], complete: true, ...over,
  } as TranscriptImportSnapshot;
}

/** A connection whose Nth write fails, to prove the commit rolls back whole. */
function failAfter(db: Database, writes: number): Database {
  let seen = 0;
  return {
    ...db,
    run(sql: string, ...params: never[]) {
      seen += 1;
      if (seen > writes) throw new Error("disk full");
      return db.run(sql, ...params);
    },
  } as Database;
}

const sessionCount = (): number =>
  Number(store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")!.n);
const shareRows = (): number =>
  Number(store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM share_imports")!.n);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-shares-"));
  file = path.join(dir, "capygen.db");
  store = open();
  projectId = store.projects.upsertByPath({ path: path.join(dir, "project") }).id;
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("share bundle persistence", () => {
  it("commits an inert bundle as a read-only shared artifact with no agents or resume identity", () => {
    const { session, duplicate } = store.shares.commit({ projectId, bundle: bundle() });
    expect(duplicate).toBe(false);
    expect(session).toMatchObject({ projectId, origin: "import", mode: "solo", leadAgentId: null });
    expect(store.sessions.agents(session.id)).toEqual([]);
    expect(store.shares.artifactKindOf(session.id)).toBe("shared-bundle");
    expect(session).toMatchObject({ artifactKind: "shared-bundle" });
    // The artifact carries no native/backend identity a resume could use.
    const row = store.db.get<Record<string, unknown>>(
      "SELECT * FROM share_imports WHERE session_id = ?", session.id)!;
    expect(Object.keys(row)).not.toContain("native_id");
    expect(JSON.stringify(row)).not.toContain("thread-native");
  });

  it("reads back metadata, paged entries and comments", () => {
    const comments = [comment(), comment({ id: "c".repeat(32), entryIndex: null,
      replyToId: "b".repeat(32), resolved: true })];
    const entries = [entry(0), entry(1), entry(2)];
    const { session } = store.shares.commit({ projectId, bundle: bundle({
      entries, comments,
      counts: { ...bundle().counts, entries: 3, messages: 3 },
    }) });

    const record = store.shares.get(session.id)!;
    expect(record).toMatchObject({ sessionId: session.id, bundleId: "a".repeat(32),
      schemaVersion: 1, appVersion: "0.1.0" });
    expect(record.source.title).toBe("Shared session");
    expect(record.counts.entries).toBe(3);
    expect(record.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(store.shares.entries(session.id).map((e) => e.index)).toEqual([0, 1, 2]);
    expect(store.shares.entries(session.id, { offset: 1, limit: 1 }).map((e) => e.index)).toEqual([1]);
    expect(store.shares.tail(session.id, 2).map((e) => e.index)).toEqual([1, 2]);
    expect(() => store.shares.entries(session.id, { limit: 101 })).toThrow();
    expect(() => store.shares.entries(session.id, { offset: -1 })).toThrow();

    expect(store.shares.comments(session.id).map((c) => c.id)).toEqual(["b".repeat(32), "c".repeat(32)]);
    expect(store.shares.comments(session.id)[1]).toMatchObject({ entryIndex: null, resolved: true,
      replyToId: "b".repeat(32) });
  });

  it("returns null for an unknown or non-shared session", () => {
    const native = store.imports.commit({ projectId, snapshot: snapshot() });
    expect(store.shares.get("ses_missing")).toBeNull();
    expect(store.shares.get(native.session.id)).toBeNull();
    expect(store.shares.artifactKindOf(native.session.id)).toBe("native-transcript");
  });

  it("finds a committed bundle by its bundle id", () => {
    const { session } = store.shares.commit({ projectId, bundle: bundle() });
    expect(store.shares.findByBundleId("a".repeat(32))?.id).toBe(session.id);
    expect(store.shares.findByBundleId("f".repeat(32))).toBeNull();
  });
});

describe("share bundle validation and atomicity", () => {
  it("revalidates the bundle and mutates nothing when it is invalid", () => {
    const before = sessionCount();
    const invalid = [
      { ...bundle(), version: 2 },
      { ...bundle(), counts: { ...bundle().counts, entries: 9 } },
      { ...bundle(), entries: [entry(3)] },
      { ...bundle(), bundleId: "not-hex" },
      { ...bundle(), comments: [comment({ replyToId: "f".repeat(32) })] },
      { ...bundle(), sessionId: "ses_1" },
    ];
    for (const value of invalid) {
      expect(() => store.shares.commit({ projectId, bundle: value as ShareBundle })).toThrow();
    }
    expect(sessionCount()).toBe(before);
    expect(shareRows()).toBe(0);
  });

  it("refuses an unknown destination project without creating a session", () => {
    expect(() => store.shares.commit({ projectId: "prj_missing", bundle: bundle() })).toThrow(/unknown project/);
    expect(sessionCount()).toBe(0);
    expect(shareRows()).toBe(0);
  });

  it("rolls the whole commit back when a write fails part-way", () => {
    const repo = new SharesRepo(failAfter(store.db, 3));
    expect(() => repo.commit({ projectId, bundle: bundle({
      entries: [entry(0), entry(1)], comments: [comment()],
      counts: { ...bundle().counts, entries: 2, messages: 2 },
    }) })).toThrow(/disk full/);
    expect(sessionCount()).toBe(0);
    expect(shareRows()).toBe(0);
    expect(store.db.get("SELECT COUNT(*) AS n FROM share_import_entries")).toMatchObject({ n: 0 });
    expect(store.db.get("SELECT COUNT(*) AS n FROM share_import_comments")).toMatchObject({ n: 0 });
  });
});

describe("share bundle identity", () => {
  it("treats the same bundle as an idempotent duplicate", () => {
    const first = store.shares.commit({ projectId, bundle: bundle() });
    const second = store.shares.commit({ projectId, bundle: bundle() });
    expect(second.duplicate).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(sessionCount()).toBe(1);
    expect(shareRows()).toBe(1);
  });

  it("hashes content canonically, so key order alone is not a different bundle", () => {
    const first = store.shares.commit({ projectId, bundle: bundle() });
    const reordered = JSON.parse(JSON.stringify(bundle(), ["comments", "counts", "entries",
      "source", "appVersion", "createdAt", "bundleId", "version", "kind", "title", "mode",
      "startedAt", "endedAt", "agents", "label", "backend", "model", "index", "at", "label",
      "truncated", "kind", "speaker", "text", "entries", "messages", "thinking", "activities",
      "notices", "truncatedTexts", "droppedInteractive", "droppedThinking", "droppedWidgets",
      "droppedUsage", "redactions"])) as ShareBundle;
    const second = store.shares.commit({ projectId, bundle: reordered });
    expect(second.duplicate).toBe(true);
    expect(second.session.id).toBe(first.session.id);
  });

  it("refuses a different bundle claiming an id that is already taken", () => {
    store.shares.commit({ projectId, bundle: bundle() });
    const conflicting = bundle({ entries: [entry(0, { text: "Tampered" })] });
    expect(() => store.shares.commit({ projectId, bundle: conflicting })).toThrow(/already/i);
    expect(sessionCount()).toBe(1);
    expect(store.shares.entries(store.shares.findByBundleId("a".repeat(32))!.id)[0]!.text)
      .toBe("Shared reply 0");
  });

  it("keeps bundle-local comment ids from colliding across bundles", () => {
    const one = store.shares.commit({ projectId, bundle: bundle({ comments: [comment()] }) });
    const two = store.shares.commit({ projectId, bundle: bundle({
      bundleId: "d".repeat(32), comments: [comment({ body: "A different note" })] }) });
    expect(two.session.id).not.toBe(one.session.id);
    expect(store.shares.comments(one.session.id)[0]!.body).toBe("Looks right");
    expect(store.shares.comments(two.session.id)[0]!.body).toBe("A different note");
    expect(store.db.get("SELECT COUNT(*) AS n FROM share_import_comments")).toMatchObject({ n: 2 });
  });

  it("survives a restart and cascades away with its session", () => {
    const { session } = store.shares.commit({ projectId, bundle: bundle({ comments: [comment()] }) });
    store.close();
    store = open();
    expect(store.shares.get(session.id)?.bundleId).toBe("a".repeat(32));
    expect(store.shares.entries(session.id)).toHaveLength(1);
    expect(store.shares.comments(session.id)).toHaveLength(1);

    store.db.run("DELETE FROM sessions WHERE id = ?", session.id);
    expect(shareRows()).toBe(0);
    expect(store.db.get("SELECT COUNT(*) AS n FROM share_import_entries")).toMatchObject({ n: 0 });
    expect(store.db.get("SELECT COUNT(*) AS n FROM share_import_comments")).toMatchObject({ n: 0 });
  });
});

describe("native transcript imports are unchanged", () => {
  it("still commits, deduplicates and is tagged as a native transcript", () => {
    const first = store.imports.commit({ projectId, snapshot: snapshot() });
    expect(first.duplicate).toBe(false);
    expect(first.session.origin).toBe("import");
    expect(store.shares.artifactKindOf(first.session.id)).toBe("native-transcript");
    const again = store.imports.commit({ projectId, snapshot: snapshot() });
    expect(again.duplicate).toBe(true);
    expect(again.session.id).toBe(first.session.id);
    expect(store.imports.get(first.session.id)?.nativeId).toBe("thread-native-1");
    expect(store.imports.entries(first.session.id)).toHaveLength(1);
  });

  it("keeps native provenance uniqueness independent of shared bundles", () => {
    store.shares.commit({ projectId, bundle: bundle() });
    const native = store.imports.commit({ projectId, snapshot: snapshot() });
    expect(native.duplicate).toBe(false);
    expect(sessionCount()).toBe(2);
    expect(() => store.db.run(
      `INSERT INTO transcript_imports
         (session_id, backend, native_id, source_path, source_sha256, format, metadata_json, imported_at)
       VALUES (?, 'codex', 'thread-native-1', 'p', ?, 'f', '{}', 1)`,
      native.session.id + "-x", "a".repeat(64))).toThrow();
  });

  it("refuses a shared bundle as a native continuation source", () => {
    const shared = store.shares.commit({ projectId, bundle: bundle() });
    const fresh = store.sessions.create({ projectId, mode: "solo",
      agents: [{ name: "Assistant", backend: "claude", model: "claude-opus-5", role: "lead",
        config: null }] });
    expect(() => store.imports.linkContinuation(fresh.session.id, shared.session.id)).toThrow();
    expect(store.sessions.get(fresh.session.id)?.continuationSourceSessionId).toBeNull();
  });

  it("leaves migration 0001's parity `shares` table and its rows untouched", () => {
    store.db.run("INSERT INTO shares (id, session_id, kind, target, created_at) VALUES ('s1', NULL, 'link', '', 1)");
    store.close();
    store = open();
    expect(store.db.get("SELECT COUNT(*) AS n FROM shares")).toMatchObject({ n: 1 });
    // The Phase 9 artifact lives in its own sibling table, not in that one.
    store.shares.commit({ projectId: store.projects.list()[0]!.id, bundle: bundle() });
    expect(store.db.get("SELECT COUNT(*) AS n FROM shares")).toMatchObject({ n: 1 });
    expect(shareRows()).toBe(1);
  });
});

describe("session artifact kinds", () => {
  it("refuses an imported session with no artifact kind and a live session with one", () => {
    expect(() => store.db.run(
      `INSERT INTO sessions (id, project_id, origin, mode, title, status, archived, created_at, updated_at)
       VALUES ('ses_x', ?, 'import', 'solo', 't', 'idle', 0, 1, 1)`, projectId)).toThrow(/artifact_kind/);
    expect(() => store.db.run(
      `INSERT INTO sessions (id, project_id, origin, artifact_kind, mode, title, status, archived, created_at, updated_at)
       VALUES ('ses_y', ?, 'live', 'shared-bundle', 'solo', 't', 'idle', 0, 1, 1)`, projectId)).toThrow(/artifact_kind/);
    expect(() => store.db.run(
      `INSERT INTO sessions (id, project_id, origin, artifact_kind, mode, title, status, archived, created_at, updated_at)
       VALUES ('ses_z', ?, 'import', 'something-else', 'solo', 't', 'idle', 0, 1, 1)`, projectId)).toThrow();
  });

  it("leaves live sessions without an artifact kind", () => {
    const fresh = store.sessions.create({ projectId, mode: "solo",
      agents: [{ name: "Assistant", backend: "claude", model: "claude-opus-5", role: "lead",
        config: null }] });
    expect(store.shares.artifactKindOf(fresh.session.id)).toBeNull();
  });
});

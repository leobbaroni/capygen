/**
 * Locally authored notes (migration 0011, P15 item C — storage layer).
 *
 * The invariants worth pinning: a received bundle stays byte-identical whatever
 * a reader writes locally, anchors are one shape each, replies cannot leave
 * their session or close a cycle, and a re-export carries notes without ever
 * emitting a dangling anchor or reply.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, readMigrations, type CapygenStore } from "../src/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

let dir: string;
let store: CapygenStore;
let projectId: string;
let sessionId: string;
let otherSessionId: string;

/**
 * Give a session real content to anchor against.
 *
 * Notes validate their anchor now, so a fixture that files one against a block
 * or entry that does not exist is refused — which is the point. These rows are
 * written directly because the case is about the note, not about how the
 * artifact got there.
 */
function seedArtifact(id: string, entries = 6): void {
  store.db.run(
    `INSERT INTO share_imports
       (session_id, bundle_id, content_sha256, schema_version, app_version,
        bundle_created_at, metadata_json, imported_at)
     VALUES (?, ?, ?, 1, '0.1.0', '2026-09-07T10:00:00Z', '{}', 1)`,
    id, `${id}-bundle`.padEnd(32, "0").slice(0, 32), "a".repeat(64),
  );
  for (let i = 0; i < entries; i += 1) {
    store.db.run(
      "INSERT INTO share_import_entries (session_id, entry_index, entry_json) VALUES (?, ?, '{}')",
      id, i,
    );
  }
}

/** One received comment, so a local reply has something real to name. */
function seedReceivedComment(id: string, commentId: string): void {
  store.db.run(
    `INSERT INTO share_import_comments
       (session_id, comment_id, ordinal, entry_index, author, body, created_at,
        reply_to_id, resolved)
     VALUES (?, ?, 0, 0, 'Sender', 'their remark', '2026-09-07T11:00:00Z', NULL, 0)`,
    id, commentId,
  );
}

function seedBlock(id: string, blockId: string): void {
  const turnId = `trn_${blockId}`;
  store.db.run(
    "INSERT INTO turns (id, session_id, agent_id, role, status, hop_index, created_at) VALUES (?, ?, NULL, 'agent', 'done', 0, 1)",
    turnId, id,
  );
  store.db.run(
    `INSERT INTO blocks (id, turn_id, session_id, kind, block_index, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, 'text', 0, '{}', 1, 1)`,
    blockId, turnId, id,
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-notes-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  projectId = store.projects.upsertByPath({ path: path.join(dir, "p"), name: "p" }).id;
  sessionId = store.sessions.create({ projectId, mode: "solo", agents: [] }).session.id;
  otherSessionId = store.sessions.create({ projectId, mode: "solo", agents: [] }).session.id;
  seedArtifact(sessionId);
  seedArtifact(otherSessionId);
  seedBlock(sessionId, "blk_1");
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const draft = (over: Record<string, unknown> = {}) => ({
  sessionId, anchor: { kind: "session" as const }, authorLabel: "Me", body: "a note", ...over,
}) as Parameters<CapygenStore["localNotes"]["create"]>[0];

describe("migration 0011", () => {
  it("ships as its own migration and leaves the received-bundle tables alone", () => {
    // Position, not recency: later migrations are added all the time, and this
    // case is about 0011 not disturbing 0009's tables.
    const ids = readMigrations(MIGRATIONS_DIR).map((m) => m.id);
    expect(ids).toContain("0011_share_comments");
    // 0009's tables are untouched: a local note is a sibling row, not an edit.
    const columns = store.db
      .all<{ name: string }>("PRAGMA table_info(share_import_comments)")
      .map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["comment_id", "author", "body", "resolved"]));
    expect(columns).not.toContain("local");
  });

  it("admits exactly one anchor shape per kind", () => {
    const insert = (kind: string, blockId: string | null, entryIndex: number | null) =>
      store.db.run(
        `INSERT INTO local_share_notes
           (id, session_id, anchor_kind, block_id, entry_index, author_label, body,
            resolved, reply_to_id, created_at, updated_at)
         VALUES ('n_probe', ?, ?, ?, ?, 'Me', 'x', 0, NULL, 1, 1)`,
        sessionId, kind, blockId, entryIndex,
      );
    expect(() => insert("block", null, null)).toThrow();
    expect(() => insert("entry", null, null)).toThrow();
    expect(() => insert("session", "blk_1", null)).toThrow();
    expect(() => insert("entry", "blk_1", 0)).toThrow();
    expect(() => insert("elsewhere", null, null)).toThrow();
    expect(() => insert("entry", null, -1)).toThrow();
  });

  it("bounds the label and body in the schema, not only in the repository", () => {
    const insert = (label: string, body: string) =>
      store.db.run(
        `INSERT INTO local_share_notes
           (id, session_id, anchor_kind, block_id, entry_index, author_label, body,
            resolved, reply_to_id, created_at, updated_at)
         VALUES (?, ?, 'session', NULL, NULL, ?, ?, 0, NULL, 1, 1)`,
        `n_${label.length}_${body.length}`, sessionId, label, body,
      );
    expect(() => insert("  ", "x")).toThrow();
    expect(() => insert("x".repeat(121), "x")).toThrow();
    expect(() => insert("Me", "")).toThrow();
    expect(() => insert("Me", "x".repeat(16_385))).toThrow();
  });

  it("deletes a session's notes with the session, and keeps them when a block goes", () => {
    const note = store.localNotes.create(draft({ anchor: { kind: "block", blockId: "blk_1" } }));
    // No foreign key to blocks on purpose: a deleted turn must not take the
    // operator's own writing with it.
    store.db.run("DELETE FROM blocks WHERE id = 'blk_1'");
    expect(store.localNotes.get(note.id)).not.toBeNull();
    // And it stays editable, rather than becoming stuck because the thing it
    // pointed at is gone.
    expect(store.localNotes.update(note.id, { body: "still editable" }).body).toBe("still editable");

    store.db.run("DELETE FROM sessions WHERE id = ?", sessionId);
    expect(store.localNotes.get(note.id)).toBeNull();
  });
});

describe("LocalNotesRepo", () => {
  it("creates, edits, resolves and deletes", () => {
    const note = store.localNotes.create(draft({ body: "first" }), 100);
    expect(note).toMatchObject({ body: "first", resolved: false, createdAt: 100, updatedAt: 100 });

    const edited = store.localNotes.update(note.id, { body: "second" }, 200);
    expect(edited).toMatchObject({ body: "second", createdAt: 100, updatedAt: 200 });

    expect(store.localNotes.update(note.id, { resolved: true }).resolved).toBe(true);
    expect(store.localNotes.remove(note.id)).toBe(true);
    expect(store.localNotes.get(note.id)).toBeNull();
  });

  it("re-anchors a note without losing it", () => {
    const note = store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: 3 } }));
    expect(note.anchor).toEqual({ kind: "entry", entryIndex: 3 });
    expect(store.localNotes.update(note.id, { anchor: { kind: "session" } }).anchor)
      .toEqual({ kind: "session" });
  });

  it("refuses an empty, oversized or unlabelled note", () => {
    expect(() => store.localNotes.create(draft({ body: "   " }))).toThrow(/cannot be empty/);
    expect(() => store.localNotes.create(draft({ body: "x".repeat(16_385) }))).toThrow(/16384 bytes/);
    // Byte bounds, not JS length: a 4-byte code point counts as four.
    expect(() => store.localNotes.create(draft({ body: "😀".repeat(4097) }))).toThrow(/16384 bytes/);
    expect(() => store.localNotes.create(draft({ authorLabel: " " }))).toThrow(/author label/);
    expect(() => store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: -1 } })))
      .toThrow(/non-negative/);
  });

  it("keeps a reply inside its own session and out of a cycle", () => {
    const parent = store.localNotes.create(draft());
    const reply = store.localNotes.create(draft({ replyToId: parent.id }));
    expect(reply.replyToId).toBe(parent.id);

    expect(() =>
      store.localNotes.create(draft({ sessionId: otherSessionId, replyToId: parent.id })),
    ).toThrow(/same session/);
    expect(() => store.localNotes.create(draft({ replyToId: "note_missing" })))
      .toThrow(/must name a note in this session/);

    // Deleting a parent takes its replies with it.
    store.localNotes.remove(parent.id);
    expect(store.localNotes.get(reply.id)).toBeNull();
  });

  it("pages a session's notes in authored order", () => {
    for (let i = 0; i < 5; i += 1) {
      store.localNotes.create(draft({ body: `note ${i}` }), 100 + i);
    }
    expect(store.localNotes.list(sessionId, { offset: 0, limit: 2 }).map((n) => n.body))
      .toEqual(["note 0", "note 1"]);
    expect(store.localNotes.list(sessionId, { offset: 4, limit: 2 }).map((n) => n.body))
      .toEqual(["note 4"]);
    expect(store.localNotes.count(sessionId)).toBe(5);
    expect(store.localNotes.count(otherSessionId)).toBe(0);
    expect(() => store.localNotes.list(sessionId, { limit: 101 })).toThrow();
  });
});

describe("notes re-exported into a bundle", () => {
  it("never leaves an anchor or a reply pointing at nothing", () => {
    const onEntry = store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: 2 } }), 100);
    const onDropped = store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: 4 } }), 101);
    // A block id means nothing on another machine.
    const onBlock = store.localNotes.create(draft({ anchor: { kind: "block", blockId: "blk_1" } }), 102);
    const reply = store.localNotes.create(draft({ replyToId: onEntry.id }), 103);
    const orphanReply = store.localNotes.create(draft({ replyToId: onDropped.id }), 104);

    const comments = store.localNotes.toShareComments(sessionId, {
      // The export withheld entry 4 (reasoning, say).
      omitEntry: (index) => index === 4,
    });
    expect(comments).toHaveLength(5);

    const byBody = new Map(comments.map((c) => [c.body, c]));
    // Every id is a bundle-legal 32-hex value, and every anchor either points
    // at a carried entry or at nothing.
    for (const comment of comments) {
      expect(comment.id).toMatch(/^[0-9a-f]{32}$/);
      expect(comment.entryIndex === null || comment.entryIndex >= 0).toBe(true);
    }
    expect(comments.filter((c) => c.entryIndex === 2)).toHaveLength(1);
    // The dropped entry's note survives as a session-level remark, not a
    // dangling anchor.
    expect(comments.filter((c) => c.entryIndex === 4)).toHaveLength(0);
    // A block anchor cannot travel, so it becomes session-level too.
    expect(byBody.size).toBeGreaterThan(0);
    expect(onBlock.anchor.kind).toBe("block");

    const replies = comments.filter((c) => c.replyToId !== null);
    // Both parents survived as comments, so both replies keep their edge.
    expect(replies).toHaveLength(2);
    for (const r of replies) {
      expect(comments.some((c) => c.id === r.replyToId)).toBe(true);
    }
    expect(orphanReply.replyToId).toBe(onDropped.id);
    expect(reply.replyToId).toBe(onEntry.id);
  });

  it("gives every note a distinct, stable bundle comment id", () => {
    // A bundle requires unique 32-hex ids. Deriving one by stripping non-hex
    // characters and truncating collided for uuids differing only in their last
    // character, which the share schema rejects as a duplicate.
    const notes = Array.from({ length: 40 }, (_, i) =>
      store.localNotes.create(draft({ body: `note ${i}` }), 100 + i));
    const first = store.localNotes.toShareComments(sessionId);
    const ids = first.map((c) => c.id);

    expect(ids).toHaveLength(notes.length);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    // Stable: the same note exports to the same comment every time.
    expect(store.localNotes.toShareComments(sessionId).map((c) => c.id)).toEqual(ids);
  });

  it("points a surviving reply at its parent's exported id", () => {
    const parent = store.localNotes.create(draft({ body: "parent" }), 100);
    store.localNotes.create(draft({ body: "child", replyToId: parent.id }), 101);
    const comments = store.localNotes.toShareComments(sessionId);
    const exportedParent = comments.find((c) => c.body === "parent");
    const exportedChild = comments.find((c) => c.body === "child");
    expect(exportedChild?.replyToId).toBe(exportedParent?.id);
    expect(exportedChild?.replyToId).not.toBeNull();
  });

  it("remaps an anchor when the export renumbers entries", () => {
    store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: 5 } }));
    const [comment] = store.localNotes.toShareComments(sessionId, {
      remapEntry: (index) => index - 2,
    });
    expect(comment?.entryIndex).toBe(3);
  });

  it("leaves the received bundle's own identity untouched", () => {
    // A note is a separate row; nothing about the artifact's stored content
    // changes, so a re-import of the same file is still a duplicate.
    const before = store.db.all("SELECT * FROM share_import_comments");
    store.localNotes.create(draft({ body: "local remark" }));
    expect(store.db.all("SELECT * FROM share_import_comments")).toEqual(before);
  });
});

describe("anchors and replies are checked on the way in", () => {
  it("bounds the author label in UTF-8 bytes, not characters", () => {
    // 120 four-byte code points is 480 bytes: legal by JS length, and a label
    // the share format would refuse on re-export.
    expect(() => store.localNotes.create(draft({ authorLabel: "😀".repeat(120) })))
      .toThrow(/120 bytes/);
    expect(store.localNotes.create(draft({ authorLabel: "😀".repeat(30) })).authorLabel)
      .toBe("😀".repeat(30));
  });

  it("refuses an anchor that names another session's content", () => {
    seedBlock(otherSessionId, "blk_other");
    expect(() => store.localNotes.create(draft({ anchor: { kind: "block", blockId: "blk_other" } })))
      .toThrow(/its own session/);
    expect(() => store.localNotes.create(draft({ anchor: { kind: "block", blockId: "blk_absent" } })))
      .toThrow(/no such block/);
  });

  it("refuses an entry index past the end of the artifact", () => {
    // The artifact carries six entries, so 5 is the last valid anchor.
    expect(store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: 5 } })).anchor)
      .toEqual({ kind: "entry", entryIndex: 5 });
    expect(() => store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: 6 } })))
      .toThrow(/past the end/);
    // A live session has no stored entries to anchor against at all.
    const live = store.sessions.create({ projectId, mode: "solo", agents: [] }).session.id;
    expect(() => store.localNotes.create(draft({ sessionId: live, anchor: { kind: "entry", entryIndex: 0 } })))
      .toThrow(/no stored entries/);
  });

  it("checks a re-anchor but leaves an existing dangling anchor editable", () => {
    const note = store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: 2 } }));
    expect(() => store.localNotes.update(note.id, { anchor: { kind: "entry", entryIndex: 99 } }))
      .toThrow(/past the end/);
    // Editing only the body does not re-check an anchor whose target may since
    // have gone; the note is the operator's writing and must stay editable.
    store.db.run("DELETE FROM share_import_entries WHERE session_id = ? AND entry_index = 2", sessionId);
    expect(store.localNotes.update(note.id, { body: "edited anyway" }).body).toBe("edited anyway");
  });

  it("replies to a received comment without touching the sender's rows", () => {
    const received = "e".repeat(32);
    seedReceivedComment(sessionId, received);
    const before = store.db.all("SELECT * FROM share_import_comments WHERE session_id = ?", sessionId);

    const reply = store.localNotes.create(draft({ replyToReceivedId: received }));
    expect(reply.replyToReceivedId).toBe(received);
    expect(reply.replyToId).toBeNull();
    // The artifact is unchanged, so its content identity is unchanged.
    expect(store.db.all("SELECT * FROM share_import_comments WHERE session_id = ?", sessionId))
      .toEqual(before);

    expect(() => store.localNotes.create(draft({ replyToReceivedId: "d".repeat(32) })))
      .toThrow(/received comment in this session/);
    expect(() => store.localNotes.create(draft({ sessionId: otherSessionId, replyToReceivedId: received })))
      .toThrow(/received comment in this session/);
  });

  it("refuses a reply that names two parents", () => {
    const received = "e".repeat(32);
    seedReceivedComment(sessionId, received);
    const parent = store.localNotes.create(draft());
    expect(() =>
      store.localNotes.create(draft({ replyToId: parent.id, replyToReceivedId: received })),
    ).toThrow(/one parent/);
  });

  it("carries a received-comment reply only when the bundle carries the parent", () => {
    const received = "e".repeat(32);
    seedReceivedComment(sessionId, received);
    store.localNotes.create(draft({ body: "my reply", replyToReceivedId: received }));

    const withParent = store.localNotes.toShareComments(sessionId, {
      carriedReceivedIds: new Set([received]),
    });
    expect(withParent.find((c) => c.body === "my reply")?.replyToId).toBe(received);

    // Re-exported without the sender's comments, the reply must not name a
    // parent the bundle does not contain.
    const withoutParent = store.localNotes.toShareComments(sessionId);
    expect(withoutParent.find((c) => c.body === "my reply")?.replyToId).toBeNull();
  });

  it("drops a withheld anchor instead of restoring it", () => {
    store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: 3 } }));
    // A remapper returns null precisely to say "not in this bundle"; the old
    // `?? original` fallback put the withheld anchor straight back.
    const [comment] = store.localNotes.toShareComments(sessionId, { remapEntry: () => null });
    expect(comment?.entryIndex).toBeNull();
  });

  it("bounds how many notes one export carries", () => {
    for (let i = 0; i < 5; i += 1) store.localNotes.create(draft({ body: `n${i}` }), 100 + i);
    // Refusal, not truncation — see the cap case below.
    expect(() => store.localNotes.toShareComments(sessionId, { limit: 2 })).toThrow(/more than 2/);
    expect(store.localNotes.toShareComments(sessionId, { limit: 5 })).toHaveLength(5);
    // The cap is a ceiling on the requested limit, not a suggestion.
    expect(store.localNotes.toShareComments(sessionId, { limit: 10_000 }).length)
      .toBeLessThanOrEqual(1000);
  });
});

describe("a note's block anchor and the export cap", () => {
  it("reports the block a note was anchored to, for the caller to re-anchor", () => {
    const note = store.localNotes.create(draft({ anchor: { kind: "block", blockId: "blk_1" } }));
    let anchors: ReadonlyMap<string, string> = new Map();
    const [comment] = store.localNotes.toShareComments(sessionId, {
      onBlockAnchors: (map) => { anchors = map; },
    });
    // A block id cannot travel as an index, so the comment leaves unanchored
    // and the caller is told which block to resolve it against.
    expect(comment?.entryIndex).toBeNull();
    expect(anchors.get(comment!.id)).toBe("blk_1");
    expect(note.anchor.kind).toBe("block");
  });

  it("reports nothing for entry- and session-anchored notes", () => {
    store.localNotes.create(draft({ anchor: { kind: "entry", entryIndex: 1 } }), 100);
    store.localNotes.create(draft({ anchor: { kind: "session" } }), 101);
    let anchors: ReadonlyMap<string, string> = new Map();
    store.localNotes.toShareComments(sessionId, { onBlockAnchors: (map) => { anchors = map; } });
    expect(anchors.size).toBe(0);
  });

  it("refuses over the cap rather than silently dropping the tail", () => {
    for (let i = 0; i < 4; i += 1) store.localNotes.create(draft({ body: `n${i}` }), 100 + i);
    // A bundle whose comment list looks complete and is not is undetectable to
    // whoever receives it, so the cap refuses instead of trimming.
    expect(() => store.localNotes.toShareComments(sessionId, { limit: 3 }))
      .toThrow(/more than 3 notes/);
    expect(store.localNotes.toShareComments(sessionId, { limit: 4 })).toHaveLength(4);
    expect(store.localNotes.toShareComments(sessionId, { limit: 5 })).toHaveLength(4);
  });
});

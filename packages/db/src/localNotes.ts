/**
 * Locally authored notes on a session (migration 0011, Phase 9 / P15).
 *
 * A note is *this machine's* content. A received bundle's own comments live in
 * `share_import_comments` and are never touched here, so adding, editing or
 * resolving a note cannot change an artifact's content hash — and therefore
 * cannot turn a later re-import of the same file from a duplicate into a
 * conflict.
 *
 * `authorLabel` is a display label the operator typed. It is not an account and
 * not verified, and the same rule that governs `local_members.label` applies:
 * nothing built on this may present it as an authenticated identity.
 *
 * Anchors are stable by construction: a live block id, an artifact entry index,
 * or nothing at all. There is no foreign key on the block id on purpose — a
 * deleted turn must not delete the note somebody wrote about it — so a reader
 * treats a missing referent as "the anchored content is gone".
 */
import { createHash } from "node:crypto";
import { ShareCommentSchema, type ShareComment } from "@capygen/shared";
import type { Database, Row } from "./driver.js";
import { boolToInt, intToBool } from "./driver.js";

/** Bounds mirror `SHARE_LIMITS`, so a storable note is also an exportable one. */
export const NOTE_BODY_MAX_BYTES = 16_384;
/** Bytes, not characters: `SHARE_LIMITS.maxLabelBytes` counts UTF-8, so a
 *  label bounded by JS length could store 120 multibyte characters here and
 *  then fail to re-export. */
export const NOTE_LABEL_MAX_BYTES = 120;
/** How many notes one export may carry, so a re-export is bounded by
 *  construction rather than by however many the operator happened to write. */
export const NOTE_EXPORT_MAX = 1000;

export type LocalNoteAnchor =
  | { kind: "block"; blockId: string }
  | { kind: "entry"; entryIndex: number }
  | { kind: "session" };

export interface LocalNote {
  id: string;
  sessionId: string;
  anchor: LocalNoteAnchor;
  authorLabel: string;
  body: string;
  resolved: boolean;
  replyToId: string | null;
  replyToReceivedId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LocalNoteDraft {
  sessionId: string;
  anchor: LocalNoteAnchor;
  authorLabel: string;
  body: string;
  /** Another local note in this session. */
  replyToId?: string | null;
  /** One of the sender's received comments, by its bundle-local id. Replying
   *  to a received comment never writes to the sender's immutable rows. */
  replyToReceivedId?: string | null;
}

export interface LocalNotePatch {
  body?: string;
  resolved?: boolean;
  anchor?: LocalNoteAnchor;
}

export interface LocalNotePage {
  offset?: number;
  limit?: number;
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/**
 * A note's id as a bundle-legal comment id.
 *
 * A bundle requires 32 lowercase hex characters and requires them to be unique;
 * a note id is `note_<uuid hex>`, which is neither. Stripping the non-hex
 * characters and truncating looked sufficient and was not: `note_` contributes
 * an `e`, so the result was 33 characters and the truncation dropped the last
 * one — two notes whose uuids differed only in their final character produced
 * the same comment id, which the share schema would reject as a duplicate, or
 * worse, would silently re-point a reply at the wrong parent.
 *
 * A truncated SHA-256 of the full id is deterministic (the same note exports to
 * the same comment every time) and uses the whole input, so distinctness is
 * preserved to the width the format allows.
 */
function shareCommentId(noteId: string): string {
  return createHash("sha256").update(noteId, "utf8").digest("hex").slice(0, 32);
}

function localNoteId(): string {
  return `note_${crypto.randomUUID().replaceAll("-", "")}`;
}

function page(input: LocalNotePage): { offset: number; limit: number } {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("note offset must be a non-negative integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("note limit must be an integer from 1 to 100");
  }
  return { offset, limit };
}

/** Byte bounds, not JS length: a bundle counts its text in UTF-8. */
function validate(input: { authorLabel: string; body: string }): void {
  if (input.authorLabel.trim() === "" || utf8Bytes(input.authorLabel) > NOTE_LABEL_MAX_BYTES) {
    throw new Error(`a note's author label must be 1 to ${NOTE_LABEL_MAX_BYTES} bytes`);
  }
  if (input.body.trim() === "") throw new Error("a note cannot be empty");
  if (utf8Bytes(input.body) > NOTE_BODY_MAX_BYTES) {
    throw new Error(`a note's body must be at most ${NOTE_BODY_MAX_BYTES} bytes`);
  }
}

function anchorColumns(anchor: LocalNoteAnchor): {
  kind: string;
  blockId: string | null;
  entryIndex: number | null;
} {
  if (anchor.kind === "block") return { kind: "block", blockId: anchor.blockId, entryIndex: null };
  if (anchor.kind === "entry") {
    if (!Number.isSafeInteger(anchor.entryIndex) || anchor.entryIndex < 0) {
      throw new Error("a note's entry index must be a non-negative integer");
    }
    return { kind: "entry", blockId: null, entryIndex: anchor.entryIndex };
  }
  return { kind: "session", blockId: null, entryIndex: null };
}

function rowToNote(row: Row): LocalNote {
  const kind = String(row.anchor_kind);
  const anchor: LocalNoteAnchor =
    kind === "block"
      ? { kind: "block", blockId: String(row.block_id) }
      : kind === "entry"
        ? { kind: "entry", entryIndex: Number(row.entry_index) }
        : { kind: "session" };
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    anchor,
    authorLabel: String(row.author_label),
    body: String(row.body),
    resolved: intToBool(row.resolved),
    replyToId: row.reply_to_id === null || row.reply_to_id === undefined ? null : String(row.reply_to_id),
    replyToReceivedId:
      row.reply_to_received_id === null || row.reply_to_received_id === undefined
        ? null
        : String(row.reply_to_received_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class LocalNotesRepo {
  constructor(private readonly db: Database) {}

  get(id: string): LocalNote | null {
    const row = this.db.get<Row>("SELECT * FROM local_share_notes WHERE id = ?", id);
    return row ? rowToNote(row) : null;
  }

  /** A session's notes in authored order, paged. */
  list(sessionId: string, options: LocalNotePage = {}): LocalNote[] {
    const { offset, limit } = page(options);
    return this.db
      .all<Row>(
        `SELECT * FROM local_share_notes WHERE session_id = ?
         ORDER BY created_at, id LIMIT ? OFFSET ?`,
        sessionId,
        limit,
        offset,
      )
      .map(rowToNote);
  }

  count(sessionId: string): number {
    return Number(
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM local_share_notes WHERE session_id = ?",
        sessionId,
      )?.n ?? 0,
    );
  }

  create(draft: LocalNoteDraft, now = Date.now()): LocalNote {
    validate(draft);
    const anchor = anchorColumns(draft.anchor);
    this.assertAnchorBelongs(draft.sessionId, draft.anchor);
    const replyToId = draft.replyToId ?? null;
    const replyToReceivedId = draft.replyToReceivedId ?? null;
    if (replyToId !== null && replyToReceivedId !== null) {
      throw new Error("a reply names one parent, not both a note and a received comment");
    }
    if (replyToId !== null) this.assertReplyable(draft.sessionId, replyToId, null);
    if (replyToReceivedId !== null) this.assertReceivedComment(draft.sessionId, replyToReceivedId);
    const id = localNoteId();
    this.db.run(
      `INSERT INTO local_share_notes
         (id, session_id, anchor_kind, block_id, entry_index, author_label, body,
          resolved, reply_to_id, reply_to_received_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      id, draft.sessionId, anchor.kind, anchor.blockId, anchor.entryIndex,
      draft.authorLabel, draft.body, replyToId, replyToReceivedId, now, now,
    );
    const written = this.get(id);
    if (!written) throw new Error("note vanished immediately after insert");
    return written;
  }

  /** Edit a note's body, anchor or resolved flag. Threading is not editable. */
  update(id: string, patch: LocalNotePatch, now = Date.now()): LocalNote {
    const current = this.get(id);
    if (!current) throw new Error(`unknown note: ${id}`);
    const next = {
      authorLabel: current.authorLabel,
      body: patch.body ?? current.body,
    };
    validate(next);
    const nextAnchor = patch.anchor ?? current.anchor;
    // Only a *new* anchor is checked. An existing one whose target has since
    // been deleted must keep the note, not make it uneditable — the note is the
    // operator's own writing and outlives what it pointed at.
    if (patch.anchor !== undefined) this.assertAnchorBelongs(current.sessionId, nextAnchor);
    const anchor = anchorColumns(nextAnchor);
    this.db.run(
      `UPDATE local_share_notes
          SET anchor_kind = ?, block_id = ?, entry_index = ?, body = ?, resolved = ?, updated_at = ?
        WHERE id = ?`,
      anchor.kind, anchor.blockId, anchor.entryIndex, next.body,
      boolToInt(patch.resolved ?? current.resolved), now, id,
    );
    const written = this.get(id);
    if (!written) throw new Error("note vanished immediately after update");
    return written;
  }

  /** Deleting a note deletes the replies beneath it (the schema cascades). */
  remove(id: string): boolean {
    return this.db.run("DELETE FROM local_share_notes WHERE id = ?", id) > 0;
  }

  /**
   * An anchor must name content that exists **in this session**.
   *
   * Without this a note could be filed against another session's block or an
   * entry index past the end of the artifact, and the first time anyone noticed
   * would be a re-export carrying an anchor the bundle cannot satisfy. The
   * check runs on the way in, where it can still be refused with a sentence.
   */
  private assertAnchorBelongs(sessionId: string, anchor: LocalNoteAnchor): void {
    if (anchor.kind === "session") return;
    if (anchor.kind === "block") {
      const row = this.db.get<{ session_id: string }>(
        "SELECT session_id FROM blocks WHERE id = ?",
        anchor.blockId,
      );
      if (!row) throw new Error(`no such block in this session: ${anchor.blockId}`);
      if (row.session_id !== sessionId) {
        throw new Error("a note must anchor to content in its own session");
      }
      return;
    }
    // An entry index is only meaningful against a stored artifact. Both artifact
    // kinds are checked, so a note on a native transcript is bounded too.
    const counted = this.db.get<{ n: number }>(
      `SELECT (
         (SELECT COUNT(*) FROM share_import_entries WHERE session_id = ?)
         + (SELECT COUNT(*) FROM transcript_import_entries WHERE session_id = ?)
       ) AS n`,
      sessionId,
      sessionId,
    );
    const total = Number(counted?.n ?? 0);
    if (total === 0) {
      throw new Error("this session has no stored entries to anchor a note to");
    }
    if (anchor.entryIndex >= total) {
      throw new Error(`entry ${anchor.entryIndex} is past the end of this artifact`);
    }
  }

  /** A reply to the sender's own comment, which is never modified by this. */
  private assertReceivedComment(sessionId: string, commentId: string): void {
    const row = this.db.get<{ comment_id: string }>(
      "SELECT comment_id FROM share_import_comments WHERE session_id = ? AND comment_id = ?",
      sessionId,
      commentId,
    );
    if (!row) throw new Error("a reply must name a received comment in this session");
  }

  /**
   * A reply must name a note in the same session, and the chain it joins must
   * not close on itself.
   *
   * The composite foreign key already refuses a cross-session parent; this
   * walks the ancestry so a cycle is refused with a sentence rather than by a
   * later reader looping. The walk is bounded by the chain it is checking.
   */
  private assertReplyable(sessionId: string, parentId: string, selfId: string | null): void {
    const seen = new Set<string>(selfId === null ? [] : [selfId]);
    let cursor: string | null = parentId;
    while (cursor !== null) {
      if (seen.has(cursor)) throw new Error("a note cannot reply to its own thread");
      seen.add(cursor);
      const row: { session_id: string; reply_to_id: string | null } | undefined = this.db.get(
        "SELECT session_id, reply_to_id FROM local_share_notes WHERE id = ?",
        cursor,
      );
      if (!row) throw new Error(`a reply must name a note in this session: ${parentId}`);
      if (row.session_id !== sessionId) {
        throw new Error("a reply must name a note in the same session");
      }
      cursor = row.reply_to_id ?? null;
    }
  }

  /**
   * Notes as share comments, for re-export.
   *
   * Only entry- and session-anchored notes can travel: a block id means nothing
   * on another machine, so a block-anchored note is re-anchored to the session
   * rather than carrying a dangling reference. `omitEntry` drops the anchor of
   * a note attached to an entry the export left out — the caller passes the
   * indices it withheld (reasoning, for instance), and the note survives as a
   * session-level remark instead of pointing at nothing.
   *
   * Reply edges are preserved only where both ends survive; a reply whose
   * parent was dropped becomes a top-level comment, because the share schema
   * refuses a reply to a comment the bundle does not carry.
   */
  toShareComments(
    sessionId: string,
    options: {
      omitEntry?: (entryIndex: number) => boolean;
      /** Return null to drop the anchor; a number to move it. */
      remapEntry?: (entryIndex: number) => number | null;
      /** Received comment ids the bundle actually carries, for reply edges. */
      carriedReceivedIds?: ReadonlySet<string>;
      limit?: number;
      /** Receives "exported comment id → the block the note was anchored to",
       *  so a live export can re-anchor it through its own projection map. */
      onBlockAnchors?: (anchors: ReadonlyMap<string, string>) => void;
    } = {},
  ): ShareComment[] {
    const limit = Math.min(options.limit ?? NOTE_EXPORT_MAX, NOTE_EXPORT_MAX);
    // A cap is a refusal threshold, not a budget to trim to — the same rule the
    // share projection applies to entries. Silently dropping the tail would
    // produce a bundle whose comment list looks complete and is not, which
    // whoever receives it has no way to detect. Read one past the cap purely to
    // find out whether there is a tail to refuse over.
    const notes = this.db
      .all<Row>(
        "SELECT * FROM local_share_notes WHERE session_id = ? ORDER BY created_at, id LIMIT ?",
        sessionId,
        limit + 1,
      )
      .map(rowToNote);
    if (notes.length > limit) {
      throw new Error(
        `this session has more than ${limit} notes and cannot be exported as one bundle`,
      );
    }

    const kept = new Set(notes.map((note) => note.id));
    const blockAnchors = new Map<string, string>();
    const comments = notes.map((note) => {
      let entryIndex: number | null = null;
      if (note.anchor.kind === "entry") {
        const original = note.anchor.entryIndex;
        if (options.omitEntry?.(original) === true) {
          entryIndex = null;
        } else if (options.remapEntry) {
          // `?? original` was wrong: a remapper returns null precisely to say
          // "this entry is not in the bundle", and the fallback restored the
          // anchor it had just withheld. `undefined` (no remapper) is the only
          // case that keeps the original index.
          entryIndex = options.remapEntry(original);
        } else {
          entryIndex = original;
        }
      }
      // A reply survives only where its parent does. A local parent must be in
      // this bounded page; a received parent must be one the bundle carries.
      const localParent =
        note.replyToId !== null && kept.has(note.replyToId) ? shareCommentId(note.replyToId) : null;
      const receivedParent =
        note.replyToReceivedId !== null
        && (options.carriedReceivedIds?.has(note.replyToReceivedId) ?? false)
          ? note.replyToReceivedId
          : null;
      // A block anchor cannot travel as an index; the caller resolves it
      // against the projection that actually produced the entries.
      if (note.anchor.kind === "block") {
        blockAnchors.set(shareCommentId(note.id), note.anchor.blockId);
      }
      return ShareCommentSchema.parse({
        id: shareCommentId(note.id),
        entryIndex,
        author: note.authorLabel,
        body: note.body,
        createdAt: new Date(note.createdAt).toISOString(),
        replyToId: localParent ?? receivedParent,
        resolved: note.resolved,
      });
    });
    options.onBlockAnchors?.(blockAnchors);
    return comments;
  }
}

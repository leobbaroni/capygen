-- capygen 0011 — locally authored notes on a session (Phase 9 / P15, item C).
--
-- **A received bundle stays immutable.** `share_import_comments` (0009) holds
-- what the sender wrote, and nothing in this migration writes to it: a local
-- note is a *separate* row in a separate table, so the artifact's identity —
-- its `content_sha256`, and therefore whether a re-import is a duplicate or a
-- conflict — is unaffected by anything a reader adds here. Editing the received
-- rows in place would have been the cheap route and would have silently changed
-- what this machine believes the sender sent.
--
-- One table serves every session kind, because a note means the same thing on a
-- live session, a native transcript and a received bundle; only its anchor
-- differs.
--
-- Author labels are labels. `author_label` is free text the local operator
-- typed, exactly like `local_members.label`: it is not an account and must
-- never be presented as a verified identity. A note inherited from a sender is
-- not stored here at all, so nothing in this table can be confused for one.

CREATE TABLE local_share_notes (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- Anchors ------------------------------------------------------------------
  -- Three kinds, and exactly one shape each:
  --   * `block`   — a live session's rendered unit, by `blocks.id`;
  --   * `entry`   — an artifact's entry, by its position in the stored bundle
  --                 or transcript;
  --   * `session` — the whole session, anchored to nothing in particular.
  --
  -- `block_id` deliberately carries **no foreign key**. A note is content the
  -- operator wrote; deleting the turn it pointed at must not delete it, and a
  -- CASCADE here would do exactly that. A missing referent therefore reads as
  -- "the anchored content is gone", which a reader shows as an unanchored note,
  -- the same convention `local_policy_audit` uses for its identifiers.
  anchor_kind   TEXT NOT NULL CHECK (anchor_kind IN ('block', 'entry', 'session')),
  block_id      TEXT,
  entry_index   INTEGER CHECK (entry_index IS NULL OR entry_index >= 0),

  -- Content ------------------------------------------------------------------
  -- Bounds mirror `SHARE_LIMITS` (`maxCommentBytes` 16384, label 120) so a note
  -- that is storable is also exportable; the schema in @capygen/shared enforces
  -- the byte-exact version on every write, and these are the backstop.
  author_label  TEXT NOT NULL CHECK (length(trim(author_label)) BETWEEN 1 AND 120),
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 16384),
  resolved      INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),

  -- Threading ----------------------------------------------------------------
  -- A reply names a parent **in the same session**, and a parent is either
  -- another local note or one of the sender's received comments. Two columns,
  -- because they are two different tables and a single column could not have a
  -- foreign key to both:
  --
  --   * `reply_to_id`              → another row here;
  --   * `reply_to_received_id`     → `share_import_comments.comment_id`.
  --
  -- Replying to a received comment is what makes a bundle reviewable at all,
  -- and it must not be done by writing into the sender's rows: those carry the
  -- artifact's canonical identity, and editing them would change whether a
  -- re-import of the same file is a duplicate or a conflict.
  --
  -- Both composite foreign keys pin the parent to this session, so a reply can
  -- never cross sessions and a re-export cannot carry a parent the bundle does
  -- not contain.
  reply_to_id           TEXT,
  reply_to_received_id  TEXT,

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  CHECK (
    (anchor_kind = 'block'   AND block_id IS NOT NULL AND entry_index IS NULL) OR
    (anchor_kind = 'entry'   AND block_id IS NULL     AND entry_index IS NOT NULL) OR
    (anchor_kind = 'session' AND block_id IS NULL     AND entry_index IS NULL)
  ),
  -- A note cannot reply to itself; deeper cycles are refused by the repository,
  -- which walks the chain on write.
  CHECK (reply_to_id IS NULL OR reply_to_id <> id),
  -- A reply has at most one parent: naming both a local note and a received
  -- comment would leave the thread's shape ambiguous on re-export.
  CHECK (reply_to_id IS NULL OR reply_to_received_id IS NULL),

  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, reply_to_id)
    REFERENCES local_share_notes (session_id, id) ON DELETE CASCADE,
  -- Received comments are immutable and are never deleted while their artifact
  -- exists, so this edge needs no delete rule of its own; dropping the session
  -- cascades both tables.
  FOREIGN KEY (session_id, reply_to_received_id)
    REFERENCES share_import_comments (session_id, comment_id) ON DELETE CASCADE
);

CREATE INDEX local_share_notes_by_session
  ON local_share_notes (session_id, created_at, id);

-- Reading every note anchored to one entry is what the artifact reader does per
-- page, so it gets its own index rather than a scan of the session's notes.
CREATE INDEX local_share_notes_by_entry
  ON local_share_notes (session_id, entry_index)
  WHERE entry_index IS NOT NULL;

CREATE INDEX local_share_notes_by_block
  ON local_share_notes (session_id, block_id)
  WHERE block_id IS NOT NULL;

-- capygen 0009 — Phase 9 shared-bundle artifacts.
--
-- A received bundle is a *sibling* of a native transcript import, never a
-- variant of one. Both are read-only artifacts, so both keep `origin = 'import'`
-- and the read-only guards already written against it; what distinguishes them
-- is the new `artifact_kind` discriminator. The alternative — a third `origin`
-- value — would mean rebuilding the heavily referenced `sessions` table just to
-- widen a CHECK, and would silently reclassify every existing guard that tests
-- `origin = 'import'`.
--
-- Native transcript provenance is untouched: `transcript_imports` keeps its
-- columns and its UNIQUE (backend, native_id, source_sha256) natural key.

-- 1. The artifact discriminator ---------------------------------------------
-- NULL for live sessions; set for every read-only artifact. Backfilled for the
-- transcript imports that already exist, which are all native by definition.
ALTER TABLE sessions ADD COLUMN artifact_kind TEXT
  CHECK (artifact_kind IS NULL OR artifact_kind IN ('native-transcript', 'shared-bundle'));

UPDATE sessions SET artifact_kind = 'native-transcript' WHERE origin = 'import';

CREATE INDEX sessions_by_artifact_kind
  ON sessions (artifact_kind)
  WHERE artifact_kind IS NOT NULL;

-- ALTER TABLE cannot add a table-level CHECK, and the invariant is worth more
-- than a repository-only rule: an artifact with no kind, or a live session
-- claiming one, would let a future reader pick the wrong artifact table — the
-- exact confusion the discriminator exists to prevent.
CREATE TRIGGER sessions_artifact_kind_insert
BEFORE INSERT ON sessions
WHEN (NEW.origin = 'import' AND NEW.artifact_kind IS NULL)
  OR (NEW.origin <> 'import' AND NEW.artifact_kind IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'artifact_kind is required for imported sessions and forbidden otherwise');
END;

CREATE TRIGGER sessions_artifact_kind_update
BEFORE UPDATE OF origin, artifact_kind ON sessions
WHEN (NEW.origin = 'import' AND NEW.artifact_kind IS NULL)
  OR (NEW.origin <> 'import' AND NEW.artifact_kind IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'artifact_kind is required for imported sessions and forbidden otherwise');
END;

-- 2. Shared-bundle provenance ------------------------------------------------
-- Migration 0001's `shares (id, session_id, kind, target, created_at)` is left
-- exactly as it is: SPEC §Data names it, `store.test.ts` asserts it, and this
-- migration adds siblings rather than replacing it. Its rows keep their meaning
-- and its name stays free for the M6 parity surface it was reserved for.
-- `bundle_id` is UNIQUE on its own, not paired with the hash: re-importing the
-- same bytes must be idempotent, while a *different* bundle claiming an id that
-- is already taken is a conflict to refuse, not a second row to create.
-- `content_sha256` is over the canonical serialization of the validated bundle,
-- so the same content with different key order hashes the same.
CREATE TABLE share_imports (
  session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  bundle_id         TEXT NOT NULL UNIQUE,
  content_sha256    TEXT NOT NULL,
  schema_version    INTEGER NOT NULL,
  app_version       TEXT NOT NULL,
  bundle_created_at TEXT NOT NULL,
  metadata_json     TEXT NOT NULL,
  imported_at       INTEGER NOT NULL
);

CREATE INDEX share_imports_by_imported_at ON share_imports (imported_at DESC);

-- Entries retain only the inert union from @capygen/shared, exactly as the
-- native transcript entries do. The composite key enforces one chronological
-- row per bundle position.
CREATE TABLE share_import_entries (
  session_id  TEXT NOT NULL REFERENCES share_imports(session_id) ON DELETE CASCADE,
  entry_index INTEGER NOT NULL CHECK (entry_index >= 0),
  entry_json  TEXT NOT NULL,
  PRIMARY KEY (session_id, entry_index)
);

-- Comment ids are *bundle-local*: two unrelated bundles may legitimately both
-- contain comment "b…b". Identity is therefore the composite (session_id,
-- comment_id), and the reply edge is a composite foreign key into the same
-- session — a reply can never point at a comment in a different artifact.
-- `ordinal` preserves the bundle's own order, which is also what makes a reply
-- edge acyclic (the schema admits only replies to earlier comments).
CREATE TABLE share_import_comments (
  session_id  TEXT NOT NULL REFERENCES share_imports(session_id) ON DELETE CASCADE,
  comment_id  TEXT NOT NULL,
  ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
  entry_index INTEGER CHECK (entry_index IS NULL OR entry_index >= 0),
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  reply_to_id TEXT,
  resolved    INTEGER NOT NULL CHECK (resolved IN (0, 1)),
  PRIMARY KEY (session_id, comment_id),
  FOREIGN KEY (session_id, reply_to_id)
    REFERENCES share_import_comments (session_id, comment_id) ON DELETE CASCADE
);

CREATE INDEX share_import_comments_by_position
  ON share_import_comments (session_id, ordinal);

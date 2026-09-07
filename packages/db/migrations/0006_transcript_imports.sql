-- capygen 0006 — Phase 7 transcript-import artifacts.
--
-- Imported sessions are deliberately distinguishable from live sessions and
-- carry no agent/backend resume identity. A continuation is a separate live
-- session that may point back to exactly one imported artifact.

ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'live'
  CHECK (origin IN ('live', 'import'));
ALTER TABLE sessions ADD COLUMN continuation_source_session_id TEXT
  REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX sessions_by_continuation_source
  ON sessions (continuation_source_session_id)
  WHERE continuation_source_session_id IS NOT NULL;

-- The natural key makes confirming the same reviewed bytes idempotent even
-- when the user selects a different destination project the second time.
CREATE TABLE transcript_imports (
  session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  backend       TEXT NOT NULL CHECK (backend IN ('claude', 'codex')),
  native_id     TEXT NOT NULL,
  source_path   TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  format        TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  imported_at   INTEGER NOT NULL,
  UNIQUE (backend, native_id, source_sha256)
);

CREATE INDEX transcript_imports_by_native_id
  ON transcript_imports (backend, native_id, imported_at DESC);

-- Entries retain only the normalized inert union from @capygen/shared. The
-- composite key enforces one chronological row per snapshot position.
CREATE TABLE transcript_import_entries (
  session_id  TEXT NOT NULL REFERENCES transcript_imports(session_id) ON DELETE CASCADE,
  entry_index INTEGER NOT NULL CHECK (entry_index >= 0),
  entry_json  TEXT NOT NULL,
  PRIMARY KEY (session_id, entry_index)
);

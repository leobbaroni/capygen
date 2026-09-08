-- Replace only the constrained scalar column, preserving the sessions table's
-- identity and every incoming foreign key. The migrator wraps all four steps
-- in one transaction; no foreign-key disabling or writable_schema is needed.
ALTER TABLE sessions RENAME COLUMN mode TO legacy_mode;
ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'solo'
  CHECK (mode IN ('solo', 'round-table', 'custom'));
UPDATE sessions SET mode = legacy_mode;
ALTER TABLE sessions DROP COLUMN legacy_mode;

-- Phase 8 persisted automations, run leases and restart-safe Inbox projection.
-- The Phase 1 placeholder rows are retained. Because they predate agent
-- selection, every migrated automation is paused until the user selects one.

ALTER TABLE automations RENAME TO automations_legacy;

CREATE TABLE automations (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id            TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  name                TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  rrule               TEXT NOT NULL,
  time_zone           TEXT NOT NULL,
  schedule_anchor_at  INTEGER NOT NULL,
  next_run_at         INTEGER,
  last_run_at         INTEGER,
  last_run_status     TEXT CHECK (last_run_status IN
                         ('succeeded','failed','skipped','cancelled','interrupted')),
  last_run_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  disabled_reason     TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

INSERT INTO automations
  (id, project_id, agent_id, name, prompt, rrule, time_zone,
   schedule_anchor_at, next_run_at, last_run_at, last_run_status,
   last_run_session_id, disabled_reason, enabled, created_at, updated_at)
SELECT id, project_id, NULL,
       substr(CASE WHEN title = '' THEN 'Legacy automation' ELSE title END, 1, 200),
       substr(CASE WHEN prompt = '' THEN 'Legacy automation prompt' ELSE prompt END, 1, 65536),
       substr(CASE WHEN schedule = '' THEN 'FREQ=DAILY' ELSE schedule END, 1, 4096),
       'UTC', created_at, NULL, last_run,
       CASE WHEN last_run IS NULL THEN NULL ELSE 'succeeded' END,
       NULL, 'legacy_missing_agent', 0, created_at, updated_at
FROM automations_legacy
WHERE project_id IS NOT NULL;

-- Rows without a project cannot satisfy the live contract. Keep the complete
-- placeholder table for audit/recovery instead of discarding those rows.
ALTER TABLE automations_legacy RENAME TO legacy_automations;
CREATE INDEX automations_due ON automations (enabled, next_run_at);
CREATE INDEX automations_by_project ON automations (project_id, updated_at DESC);

CREATE TABLE automation_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL CHECK (trigger IN ('scheduled','manual')),
  status        TEXT NOT NULL CHECK (status IN
                  ('running','succeeded','failed','skipped','cancelled','interrupted')),
  scheduled_at  INTEGER,
  fired_at      INTEGER NOT NULL,
  finished_at   INTEGER,
  session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  error_code    TEXT
);
CREATE INDEX automation_runs_by_automation
  ON automation_runs (automation_id, fired_at DESC, id DESC);

-- A lease has no expiry. Only terminal completion or startup reconciliation
-- removes it, so a slow run can never be mistaken for a dead run.
CREATE TABLE automation_run_leases (
  automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL UNIQUE REFERENCES automation_runs(id) ON DELETE CASCADE,
  acquired_at   INTEGER NOT NULL
);

DROP INDEX inbox_unread;
ALTER TABLE inbox_items RENAME TO inbox_items_legacy;

CREATE TABLE inbox_items (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id         TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  request_id      TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('permission','question','elicitation','finished','error')),
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  dedupe_key      TEXT NOT NULL UNIQUE,
  target_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER,
  read_at         INTEGER
);

-- Old placeholder rows did not identify a turn, so they cannot be projected
-- into the stronger navigation/deduplication contract. They are retained in
-- an audit table rather than silently coerced into live notifications.
ALTER TABLE inbox_items_legacy RENAME TO legacy_inbox_items;

CREATE INDEX inbox_by_session ON inbox_items (session_id, created_at DESC, id DESC);
CREATE INDEX inbox_unread ON inbox_items (read_at, created_at DESC);
CREATE INDEX inbox_unresolved_request
  ON inbox_items (session_id, request_id) WHERE resolved_at IS NULL;

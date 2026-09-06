-- capygen 0004 — Phase 5 contracts: per-project dockview layout, dev servers,
-- and the columns `tasks` (created empty in 0001) needs to be a real table
-- (SPEC R16-R18).
--
-- Three additive pieces, no table rebuilt:
--
--   * `workspace_layouts` is new. It is deliberately separate from
--     `projects.layout_json` (0001): that column was a Phase 2 placeholder
--     nothing ever wrote to (grep confirms no reader/writer existed before
--     this migration), and giving the pane system its own table — keyed by
--     `project_id`, one row per project — means a future "named layouts" or
--     "per-workspace-window layout" feature is an additive table, not a
--     reshaped column. `projects.layout_json` is untouched and unused; a
--     later migration can drop it once nothing references it (SPEC still
--     names it, so it stays until that is reconciled).
--
--   * `dev_servers` is new: one row per detected-or-custom dev server
--     *definition* (`DevServerSchema`). Its *live run state* (`DevServerRun`
--     — pid, status, discovered url) is **not** persisted here or anywhere:
--     a pid from the last run is meaningless after a restart, and
--     `DevServerService` (Phase 5 Build) holds run state in memory only. What
--     *is* worth keeping is the definition itself, including a `port`/`url`
--     a detector discovered on a previous run (so the next `servers.list`
--     does not have to rediscover it).
--
--   * `tasks` (0001) gets two additive columns: `agent_id` (which agent's
--     plan this item came from — 0001 had no notion of agents-per-task) and
--     `order_index` (display order, same `NOT NULL DEFAULT 0` pattern 0003
--     used for `agents.order_index`, which SQLite allows on `ADD COLUMN`
--     because the default is a constant, not a table rewrite). `status` and
--     `source` keep their free-text columns from 0001 (no CHECK, same
--     reasoning 0002 gave for dropping `blocks.kind`'s CHECK): `TaskSchema`
--     in `@capygen/shared` is the enumeration now (`TaskStatusSchema`:
--     pending/in_progress/completed/cancelled; `TaskSourceSchema`:
--     todo_write/codex_plan/manual — a stricter, renamed vocabulary than
--     0001's placeholder `'agent'` default, which is harmless to leave in the
--     column definition because nothing has ever written a `tasks` row yet
--     (grep confirms no writer existed before this migration) and every
--     future write goes through `TasksRepo`, which always supplies an
--     explicit `source`).
--
-- No `terminals` table: a `node-pty` process is a live OS handle that cannot
-- survive the app closing, so a persisted row would describe a terminal that
-- no longer exists and nothing to reconnect it to. `TerminalInfo` values live
-- only in `TerminalService`'s in-memory registry (Phase 5 Build); `@capygen/db`
-- has no repository for it. This is a decision, not an oversight — see
-- `TerminalInfoSchema`'s doc comment in `@capygen/shared`.

CREATE TABLE workspace_layouts (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  layout_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE dev_servers (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  source     TEXT NOT NULL,
  command    TEXT NOT NULL,
  args_json  TEXT,
  cwd        TEXT NOT NULL,
  port       INTEGER,
  url        TEXT,
  env_json   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX dev_servers_by_project ON dev_servers (project_id, updated_at DESC);

ALTER TABLE tasks ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;

CREATE INDEX tasks_by_agent ON tasks (agent_id, updated_at DESC);

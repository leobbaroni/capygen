-- capygen 0001_init — the schema from SPEC.md §Data & State Changes.
--
-- Forward-only. The migrator copies the database file next to itself before
-- applying anything, so "rollback" means restoring that copy (SPEC §Data).
--
-- Two deliberate departures from the SPEC's entity list, both additive:
--   * `blocks` is the physical table for every rendered unit in a turn (text,
--     thinking, tool_call, diff, permission, question, subagent, error, usage).
--     The SPEC named only `tool_calls`; one table with a `kind` discriminator
--     matches the Block union in @capygen/shared and keeps ordering inside a
--     turn in one index. `tool_calls` survives as a VIEW so the SPEC's name
--     still resolves.
--   * `turns` carries `status`; the SPEC listed `content_json`, which the
--     blocks table replaces (content is never a single blob for a streamed turn).
--
-- Timestamps are INTEGER milliseconds since the epoch. Booleans are 0/1.
-- JSON columns hold `json` text and are read back with JSON.parse.

CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  path             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  layout_json      TEXT,
  dev_servers_json TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL CHECK (mode IN ('solo', 'round-table')),
  lead_agent_id TEXT,
  title         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'idle'
                CHECK (status IN ('idle', 'running', 'waiting', 'error')),
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX sessions_by_project ON sessions (project_id, archived, updated_at DESC);
CREATE INDEX sessions_by_updated ON sessions (archived, updated_at DESC);

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  backend     TEXT NOT NULL CHECK (backend IN ('claude', 'codex', 'api')),
  model       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'agent',
  config_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX agents_by_session ON agents (session_id, created_at);

CREATE TABLE turns (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id       TEXT REFERENCES agents(id) ON DELETE SET NULL,
  role           TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  status         TEXT NOT NULL DEFAULT 'done'
                 CHECK (status IN ('pending', 'streaming', 'done', 'error', 'interrupted')),
  parent_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  hop_index      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX turns_by_session ON turns (session_id, created_at, id);

-- Every rendered unit inside a turn. `payload_json` holds the kind-specific
-- fields; the columns hoisted out of it are the ones queries filter on.
CREATE TABLE blocks (
  id           TEXT PRIMARY KEY,
  turn_id      TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'text', 'thinking', 'tool_call', 'diff', 'permission',
                 'question', 'subagent', 'error', 'usage')),
  block_index  INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX blocks_by_turn ON blocks (turn_id, block_index);
CREATE INDEX blocks_by_session ON blocks (session_id, created_at);

-- SPEC.md names this entity `tool_calls`; it is the tool-call slice of blocks.
CREATE VIEW tool_calls AS
  SELECT id, turn_id, session_id, block_index, payload_json, created_at, updated_at
  FROM blocks WHERE kind = 'tool_call';

CREATE TABLE usage_events (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id              TEXT REFERENCES agents(id) ON DELETE SET NULL,
  turn_id               TEXT REFERENCES turns(id) ON DELETE SET NULL,
  backend               TEXT NOT NULL CHECK (backend IN ('claude', 'codex', 'api')),
  model                 TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL DEFAULT 0,
  ts                    INTEGER NOT NULL
);
CREATE INDEX usage_by_session ON usage_events (session_id, ts);
CREATE INDEX usage_by_ts ON usage_events (ts);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Surfaces later phases fill in (SPEC §Data). Created now so the first
-- migration is the whole shape and Phase 8+ adds rows, not tables.
CREATE TABLE tasks (
  id         TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  source     TEXT NOT NULL DEFAULT 'agent',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tasks_by_session ON tasks (session_id, updated_at DESC);

CREATE TABLE automations (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  schedule   TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run   INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE inbox_items (
  id         TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  read       INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX inbox_unread ON inbox_items (read, created_at DESC);

CREATE TABLE mcp_servers (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL DEFAULT 'user',
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL,
  -- Tool schemas are cached here and only filled on first listing (R26).
  tools_json  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE plugins (
  id            TEXT PRIMARY KEY,
  backend       TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  manifest_json TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE skills (
  id            TEXT PRIMARY KEY,
  backend       TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'user',
  metadata_json TEXT,
  updated_at    INTEGER NOT NULL
);

-- Local parity surfaces (M6): roles and rules apply to local sessions only.
CREATE TABLE shares (
  id         TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL
);

CREATE TABLE policies (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL DEFAULT 'default',
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  pattern    TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('allow', 'deny', 'ask')),
  created_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  block_id    TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  decision    TEXT NOT NULL,
  decided_by  TEXT NOT NULL DEFAULT 'user',
  created_at  INTEGER NOT NULL
);

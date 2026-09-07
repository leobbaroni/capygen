-- capygen 0010 — Phase 9 / P17 local execution policy state (ADR-0007).
--
-- Authority. Backend configuration files stay authoritative for native
-- permission rules; migration 0001's `policies` table (widened by 0005) is the
-- *cache* of those native per-tool rules and keeps that job unchanged. What
-- this migration adds is capygen's own, additional local restriction store —
-- application state, never a copy of a native policy file. The two must not
-- share a table: `policies` has a `(backend, scope, pattern)` natural key where
-- `scope` is a free-text project-name-ish label, which is exactly the collision
-- ADR-0007 says the local store must avoid by carrying explicit scope ids.
--
-- Legacy rows are preserved. `members` and `approvals` (0001) were reserved for
-- the M6 parity surface and have never been read or written; they are left
-- exactly as they are, and the tables below are siblings, not replacements.
-- Renaming or repurposing them would silently reclassify rows that a future
-- parity surface may still claim, and `store.test.ts` asserts their presence.
--
-- Grants are deliberately absent from this file. ADR-0007 binds a session grant
-- to a captured connection/harness lifecycle token; a grant that outlived the
-- process that minted the token would be an authorization for a lifecycle that
-- no longer exists. Grants therefore live only in main-process memory
-- (apps/desktop/src/policies/grants.ts) and die with the process.

-- 1. Local execution profiles ------------------------------------------------
-- Named local execution profiles, not logins: ADR-0007's "Local identity
-- boundary". A label is an unauthenticated display string and must never be
-- presented as a verified identity. Exactly one built-in profile exists, the
-- owner every pre-existing session resolves to.
CREATE TABLE local_members (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  built_in   INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- At most one built-in profile, so "the built-in owner" is a single row and not
-- a query that could return two.
CREATE UNIQUE INDEX local_members_built_in ON local_members (built_in) WHERE built_in = 1;

INSERT INTO local_members (id, label, role, built_in, created_at, updated_at)
VALUES ('mbr_builtin_owner', 'Owner', 'owner', 1, 0, 0);

-- A built-in profile cannot be demoted or deleted: every existing session
-- resolves to it, and a demoted owner would retroactively strip execution from
-- sessions that were never reassigned.
CREATE TRIGGER local_members_built_in_immutable
BEFORE UPDATE OF role, built_in ON local_members
WHEN OLD.built_in = 1 AND (NEW.role <> 'owner' OR NEW.built_in <> 1)
BEGIN
  SELECT RAISE(ABORT, 'the built-in owner profile cannot change role');
END;

CREATE TRIGGER local_members_built_in_undeletable
BEFORE DELETE ON local_members
WHEN OLD.built_in = 1
BEGIN
  SELECT RAISE(ABORT, 'the built-in owner profile cannot be deleted');
END;

-- 2. Session subject assignment ----------------------------------------------
-- One row per session that has *chosen* a profile. A session with no row is not
-- unassigned-and-broken: it resolves to the built-in owner, which is how every
-- session that existed before this migration keeps executing. Kept out of
-- `sessions` on purpose — the assignment is policy state owned by this store,
-- and `sessions` is referenced by nine tables and two triggers.
--
-- ON DELETE RESTRICT is the schema half of "removing an assigned member is
-- refused until sessions are reassigned"; the service refuses first, with the
-- list of sessions, so the constraint is the backstop, not the error message.
CREATE TABLE session_member_assignments (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES local_members(id) ON DELETE RESTRICT,
  assigned_at INTEGER NOT NULL
);

CREATE INDEX session_member_assignments_by_member
  ON session_member_assignments (member_id);

-- 3. Local restriction rules --------------------------------------------------
-- Scope carries explicit ids, never a name. `backend` is *derived* from
-- `boundary` (shared's `policyBoundaryBackend`) and stored only so queries can
-- filter without decoding; the CHECK below makes a contradictory pair
-- unrepresentable rather than merely unwritten.
--
-- `pattern` is bounded literal text with `*` wildcards. The character set is
-- enforced by `LocalToolPatternSchema` in @capygen/shared on every write; SQL
-- keeps the bound that matters most here (non-empty, <= 256) so a direct
-- writer cannot store an unbounded blob.
CREATE TABLE local_policy_rules (
  id         TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'session')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  boundary   TEXT NOT NULL CHECK (boundary IN (
               'api-tool', 'claude-pre-tool', 'codex-dynamic-tool',
               'codex-command-approval', 'codex-file-approval',
               'codex-permissions-approval')),
  backend    TEXT NOT NULL CHECK (backend IN ('claude', 'codex', 'api')),
  pattern    TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 256),
  decision   TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'ask')),
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (scope_kind = 'global'  AND project_id IS NULL     AND session_id IS NULL) OR
    (scope_kind = 'project' AND project_id IS NOT NULL AND session_id IS NULL) OR
    (scope_kind = 'session' AND project_id IS NULL     AND session_id IS NOT NULL)
  ),
  CHECK (
    (boundary = 'api-tool'        AND backend = 'api')    OR
    (boundary = 'claude-pre-tool' AND backend = 'claude') OR
    (boundary NOT IN ('api-tool', 'claude-pre-tool') AND backend = 'codex')
  )
);

-- One rule per (scope, boundary, pattern). COALESCE, not the bare columns:
-- SQLite treats NULLs as distinct in a UNIQUE index, so two identical global
-- rules would both be admitted by the naive key.
CREATE UNIQUE INDEX local_policy_rules_natural_key ON local_policy_rules (
  scope_kind, COALESCE(project_id, ''), COALESCE(session_id, ''), boundary, pattern
);

-- Evaluation reads by scope on the hot path (every dequeued tool call).
CREATE INDEX local_policy_rules_by_scope
  ON local_policy_rules (scope_kind, COALESCE(project_id, ''), COALESCE(session_id, ''), enabled);

-- 4. Bounded decision audit ---------------------------------------------------
-- Metadata only. ADR-0007 forbids copying tool arguments, argument hashes,
-- credentials, tool output or raw exception text into these rows, so there is
-- deliberately no column any of those could land in — an omission enforced by
-- the absence of a column, not by a convention a later writer could forget.
--
-- No foreign keys: an audit record must survive the session, rule or profile it
-- names, and a CASCADE would erase exactly the history a refusal review needs.
-- The identifiers are therefore plain text, and a reader treats a missing
-- referent as "deleted", not as corruption.
CREATE TABLE local_policy_audit (
  id                 TEXT PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  request_id         TEXT,
  session_id         TEXT,
  agent_id           TEXT,
  backend            TEXT NOT NULL CHECK (backend IN ('claude', 'codex', 'api')),
  boundary           TEXT NOT NULL,
  boundary_available INTEGER NOT NULL CHECK (boundary_available IN (0, 1)),
  tool_name          TEXT NOT NULL CHECK (length(tool_name) <= 256),
  decision           TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'ask')),
  source             TEXT NOT NULL CHECK (source IN (
                       'rule', 'grant', 'default', 'approval', 'subject', 'error')),
  rule_id            TEXT,
  scope_kind         TEXT CHECK (scope_kind IS NULL
                       OR scope_kind IN ('global', 'project', 'session')),
  scope_id           TEXT,
  member_id          TEXT,
  -- An unauthenticated display label, recorded as it read at decision time.
  member_label       TEXT CHECK (member_label IS NULL OR length(member_label) <= 120),
  member_role        TEXT CHECK (member_role IS NULL
                       OR member_role IN ('owner', 'editor', 'viewer'))
);

CREATE INDEX local_policy_audit_by_ts ON local_policy_audit (ts DESC, id DESC);
CREATE INDEX local_policy_audit_by_session ON local_policy_audit (session_id, ts DESC);

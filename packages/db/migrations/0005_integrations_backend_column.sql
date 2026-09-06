-- capygen 0005 — Phase 6 contracts: give the integrations caches a `backend`
-- column (SPEC R28-R30).
--
-- `settings` itself needs no table change: `GlobalSettingsSchema`
-- (`@capygen/shared`) is one more versioned JSON blob, stored under a single
-- dedicated key (`global_settings`) in the existing key/value `settings`
-- table (0001) — the same `getRaw`/`setRaw` shape `SettingsRepo` already uses
-- for non-user state like window geometry. A sectioned object with defaults
-- per leaf does not need columns of its own any more than `Project.layout`
-- or `Session.settings_json` did.
--
-- What *does* need a column: `integrations.list {backend}` (R28) has to
-- filter each cache by backend, and two of the four integrations tables
-- 0001 already created cannot do that yet —
--
--   * `mcp_servers (id, scope, name, config_json, tools_json, updated_at)`
--     has no `backend` at all. `McpServersRepo` mints its row id from the
--     natural key `${backend}:${scope}:${name}` (`McpServerEntry` has no
--     `id` field — see its doc comment in `@capygen/shared`), so the column
--     is additive here for the same reason 0003 added `agents.order_index`:
--     SQLite allows `ADD COLUMN ... DEFAULT 'claude'` without a table
--     rewrite because the default is a constant, and nothing has ever
--     written a `mcp_servers` row before this migration (grep confirms no
--     reader/writer existed), so the default only matters for the one
--     legacy row Phase 2's migration itself never actually populated.
--   * `policies (id, scope, session_id, pattern, action, created_at)` is the
--     same story, plus it never had an `updated_at` at all — every other
--     cache table this file touches has one, and `ToolPoliciesRepo.upsert`
--     needs it for the same "insert or replace by natural key" pattern
--     `DevServersRepo`/`TasksRepo` already use.
--
-- `plugins (backend, name, version, enabled, ...)` and
-- `skills (backend, name, description, source, ...)` already have `backend`
-- hoisted (0001) — `PluginEntry`/`SkillEntry`'s remaining fields
-- (`marketplace`, `installed`, `path`, `commands`, `skills`; `path`,
-- `pluginName`, `enabled` respectively) fit inside their existing
-- `manifest_json`/`metadata_json` blobs, so neither table changes here.
-- `skills.source` is reused as-is for `SkillEntry.scope` (both are
-- "user"/"project"/"plugin" free text) rather than being renamed.

ALTER TABLE mcp_servers ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude';
CREATE INDEX mcp_servers_by_backend ON mcp_servers (backend, scope);

ALTER TABLE policies ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE policies ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX policies_by_backend ON policies (backend, scope);
-- One decision per (backend, scope, pattern) natural key — `ToolPoliciesRepo`
-- upserts against it instead of accumulating duplicate rows for the same
-- pattern.
CREATE UNIQUE INDEX policies_natural_key ON policies (backend, scope, pattern);

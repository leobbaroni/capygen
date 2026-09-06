-- capygen 0003 — Phase 4 contracts: session modes, named/mentionable agents,
-- round-table dispatch fields on turns (ADR-0002, SPEC R10-R13).
--
-- Every new column is additive (`ALTER TABLE ... ADD COLUMN`), so no table is
-- rebuilt and no existing row needs a value up front:
--   * `agents.display_name`/`mention_name`/`description`/`color` and
--     `sessions.settings_json`/`turns.mentions_json`/`speaker_label` are all
--     nullable — @capygen/shared's repos synthesize the Phase-4 fields a
--     pre-migration row is missing at *read* time (`rowToAgent` derives
--     `displayName`/`mentionName` from `name` via `deriveMentionName`,
--     `rowToSession` falls back to `SessionSettingsSchema`'s defaults,
--     `rowToTurn` falls back to `[]`/`null`), exactly the "zod is the single
--     source of truth" approach 0002 took for `blocks.kind`.
--   * `agents.order_index` is `NOT NULL DEFAULT 0`, which SQLite allows on
--     `ADD COLUMN` because the default is a constant, not a table rewrite.
--   * `agents.role` keeps its free-text column (no CHECK, as it always was) —
--     `AgentRoleSchema` (`'lead' | 'member'`) is the enumeration now, same
--     reasoning as 0002 dropping `blocks.kind`'s CHECK; a legacy `'agent'`
--     value (the old default) reads back as `'member'` (`rowToAgent`).
--
-- `agents(session_id, mention_name)` gets a partial unique index rather than
-- a plain one: existing rows keep `mention_name IS NULL` until the next
-- write, and a plain UNIQUE index would treat every one of those NULLs as
-- equal in some engines — SQLite in fact treats NULLs as distinct for UNIQUE,
-- but the partial form says the real intent outright (uniqueness applies once
-- a session actually has mention names assigned) and costs nothing extra.

ALTER TABLE agents ADD COLUMN display_name TEXT;
ALTER TABLE agents ADD COLUMN mention_name TEXT;
ALTER TABLE agents ADD COLUMN description TEXT;
ALTER TABLE agents ADD COLUMN subagent_routing_json TEXT;
ALTER TABLE agents ADD COLUMN color TEXT;
ALTER TABLE agents ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX agents_mention_per_session ON agents (session_id, mention_name)
  WHERE mention_name IS NOT NULL;

-- `SessionSettings` (hopCap, routing, parallelAgents — SessionSettingsSchema).
-- NULL means "use the shipping defaults"; `SessionsRepo.updateSettings` is
-- the only writer.
ALTER TABLE sessions ADD COLUMN settings_json TEXT;

-- Round-table dispatch fields (TurnSchema): `mentions` (agent ids this turn's
-- text @-addresses), `triggeredByTurnId` (the mention that caused this turn —
-- distinct from `parent_turn_id`, see TurnSchema's doc comment) and
-- `speakerLabel` (the rendered round-table header, fixed at creation).
ALTER TABLE turns ADD COLUMN mentions_json TEXT;
ALTER TABLE turns ADD COLUMN triggered_by_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL;
ALTER TABLE turns ADD COLUMN speaker_label TEXT;

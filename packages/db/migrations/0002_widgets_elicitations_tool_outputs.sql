-- capygen 0002 — new block kinds (widget, elicitation — R31/R32), and a side
-- table for full tool/widget outputs so a big result does not have to live
-- inline on every block read.
--
-- `blocks.kind` carried a CHECK enumerating every kind as of 0001. SQLite has
-- no `ALTER TABLE ... DROP/ADD CONSTRAINT`, so widening it means recreating
-- the table. Rather than widen the enumeration again for the next block kind,
-- this migration drops it entirely: `BlockSchema` in `@capygen/shared` is
-- already the single source of truth for which kinds exist (every write goes
-- through `BlocksRepo.upsert`, which re-parses with it), so a duplicate
-- enumeration in SQL is a second place to remember to update and nothing else
-- checks it. `kind` stays `NOT NULL` — only the fixed list is dropped.
--
-- Caveat for whoever changes `blocks` again: with `foreign_keys = ON` (set for
-- every connection, driver.ts), `DROP TABLE blocks` performs SQLite's implicit
-- "delete every row first", which cascades to `approvals.block_id` (`ON DELETE
-- CASCADE`). `approvals` has no writer before Phase 9, so this migration drops
-- zero real rows today. If `approvals` is populated before the next blocks
-- migration, that DROP needs `PRAGMA foreign_keys = OFF` issued on a
-- connection *outside* any transaction first — `migrate()` always wraps a
-- migration's SQL in one transaction, and SQLite only applies a change to this
-- pragma starting with the *next* transaction, so setting it here would not
-- take effect in time.

CREATE TABLE blocks_new (
  id           TEXT PRIMARY KEY,
  turn_id      TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  block_index  INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO blocks_new (id, turn_id, session_id, kind, block_index, payload_json, created_at, updated_at)
  SELECT id, turn_id, session_id, kind, block_index, payload_json, created_at, updated_at FROM blocks;

DROP VIEW tool_calls;
DROP TABLE blocks;
ALTER TABLE blocks_new RENAME TO blocks;

CREATE INDEX blocks_by_turn ON blocks (turn_id, block_index);
CREATE INDEX blocks_by_session ON blocks (session_id, created_at);

-- Unchanged definition, recreated because DROP TABLE blocks took the view
-- with it (a VIEW does not survive its underlying table being dropped, even
-- when a same-named replacement appears in the same transaction).
CREATE VIEW tool_calls AS
  SELECT id, turn_id, session_id, block_index, payload_json, created_at, updated_at
  FROM blocks WHERE kind = 'tool_call';

-- Full tool/widget outputs kept out of the block row itself: a block sets
-- `outputRef` (ToolCallBlock) to one of these ids instead of carrying a large
-- value on every session read (R25's "stored whole" now has a second home
-- besides `ToolCallBlock.fullOutput` for the cases worth the extra table).
CREATE TABLE tool_outputs (
  id         TEXT PRIMARY KEY,
  block_id   TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX tool_outputs_by_block ON tool_outputs (block_id);

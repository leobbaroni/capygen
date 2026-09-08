-- Retain prior crew rows so turns, blocks and usage keep their original identities.
ALTER TABLE agents ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
DROP INDEX agents_mention_per_session;
CREATE UNIQUE INDEX agents_mention_per_session ON agents (session_id, mention_name)
  WHERE mention_name IS NOT NULL AND active = 1;

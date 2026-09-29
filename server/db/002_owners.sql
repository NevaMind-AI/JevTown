-- Owners, for a backend many players share (docs/14 §2.1).
--
-- One column on `worlds` is enough: every other world table cascades from it, so owning the world
-- is owning every row under it. `llm_calls` gets its own because the quota counts by owner, not by
-- world, and a new world must not come with a fresh quota (§2.4).
--
-- An owner is a hash of the player's token, never the token itself. Rows written before owners
-- existed belong to `local`, which is the owner a local server gives every request (§4.4) and a
-- hash can never equal.

ALTER TABLE worlds ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'local';
CREATE INDEX IF NOT EXISTS worlds_by_owner ON worlds (owner_id, created_at);

ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS owner_id text;
CREATE INDEX IF NOT EXISTS llm_calls_by_owner ON llm_calls (owner_id, called_at);

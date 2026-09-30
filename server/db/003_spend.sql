-- Spend, not calls (docs/14 §3.6).
--
-- A count of calls misprices both kinds of call: a System One decision costs about two thousandths
-- of a chat completion. Each row records what the call was estimated to cost when it was made, at
-- the prices configured then, so changing a price never reprices history.
--
-- The time index serves the global daily circuit breaker, which sums every owner's spend.

ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cost_usd double precision NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS llm_calls_by_time ON llm_calls (called_at);

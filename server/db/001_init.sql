-- The storage schema of docs/11 §6.
--
-- The backend stores. It never executes simulation logic (docs/11 §4.1), and nothing in this file
-- knows what a tick is. Two rules shape almost all of it:
--
--   * `idx` is assigned by the frontend, never by a sequence here. A server-assigned sequence
--     quietly restores server ordering, and a batch retried after a network timeout would assign a
--     second range to the same events. The primary key on `(world_id, idx)` is the idempotency
--     key, and it is what makes retry-on-timeout safe (§4.2).
--   * World state is written whole, not as a delta. Batching already bought what a delta chain was
--     for, and a chain costs a correctness surface we would then have to defend (§7.1).
--
-- Two things docs/11 describes are deliberately absent. `memories.embedding` is a plain array
-- rather than a pgvector column, because search runs in the browser for now (plan D4); moving to
-- pgvector later is a column type change and an index, not a schema redesign. And
-- `world_snapshots` is absent because it buys time travel, which is a debugging feature nobody has
-- asked for yet (§7.1, F6) -- `world_state` plus `events` resumes a world without it.

CREATE TABLE IF NOT EXISTS worlds (
  id              text PRIMARY KEY,
  name            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'running',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The parsed world file: map, descriptions, world_rules, god config. Nothing mutates per tick, so
-- the frontend loads it whole, once. Replaces maps + four description tables (§6.4).
CREATE TABLE IF NOT EXISTS world_definition (
  world_id        text PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  doc             jsonb NOT NULL,
  loaded_at       timestamptz NOT NULL DEFAULT now()
);

-- The log. Both clocks are stored: game_time for the simulation, wall_time for debugging and cost
-- attribution. Neither is reconstructible from the other later.
CREATE TABLE IF NOT EXISTS events (
  world_id        text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  idx             bigint NOT NULL,
  kind            text NOT NULL,
  game_time       bigint NOT NULL,
  wall_time       bigint NOT NULL,
  batch_id        text,
  payload         jsonb NOT NULL,
  PRIMARY KEY (world_id, idx)
);

-- One row per world. Upserted per batch, guarded on `version` (§4.3).
CREATE TABLE IF NOT EXISTS world_state (
  world_id        text PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  idx             bigint NOT NULL,
  version         bigint NOT NULL,
  state           jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The writer lease. The table that stops two tabs corrupting a world (§4.3): a frontend claims it,
-- heartbeats it, and any batch bearing a stale generation is rejected. The loser goes read-only
-- rather than forking the history.
CREATE TABLE IF NOT EXISTS world_sessions (
  world_id        text PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  session_id      text NOT NULL,
  generation      bigint NOT NULL,
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  heartbeat_at    timestamptz NOT NULL DEFAULT now()
);

-- The sync ledger. Without it "what did we lose" is unanswerable, and a retried batch would look
-- like a version conflict rather than the no-op it is.
CREATE TABLE IF NOT EXISTS batches (
  world_id        text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  batch_id        text NOT NULL,
  from_idx        bigint NOT NULL,
  to_idx          bigint NOT NULL,
  base_version    bigint NOT NULL,
  new_version     bigint NOT NULL,
  session_id      text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, batch_id)
);

-- ---------------------------------------------------------------- prose, dialogue, memory

-- `state`/`state_ref` exclusive: an oversized document goes to `blobs` and travels as a hash.
-- Kept out of world_state for the reason §7.2 gives -- different write rhythm, different author,
-- different reader.
CREATE TABLE IF NOT EXISTS entity_state (
  world_id        text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  entity_id       text NOT NULL,
  version         bigint NOT NULL,
  state           text,
  state_ref       text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, entity_id, version)
);

-- Content-addressed, append-only, dedupes naturally, never needs invalidation.
CREATE TABLE IF NOT EXISTS blobs (
  hash            text PRIMARY KEY,
  content         text NOT NULL
);

-- Completed conversations. Live ones are in world_state's JSON. This is `archivedConversations`
-- renamed and given its real job: a parent for messages, and the source for "when did A and B last
-- talk" -- which is why `participatedTogether` is gone (§6.4).
CREATE TABLE IF NOT EXISTS conversations (
  world_id        text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  creator         text NOT NULL,
  participants    text[] NOT NULL,
  created         bigint NOT NULL,
  ended           bigint NOT NULL,
  num_messages    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, conversation_id)
);

-- `interactionTurns` merged in. It existed only because `messages` demanded a conversationId and a
-- player-id author, and a fixed entity is neither; a polymorphic (author_kind, author_id) removes
-- the reason. `message_uuid` stays as the frontend-generated idempotency key.
CREATE TABLE IF NOT EXISTS messages (
  world_id        text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  channel_kind    text NOT NULL,
  channel_id      text NOT NULL,
  seq             integer NOT NULL,
  author_kind     text NOT NULL,
  author_id       text NOT NULL,
  text            text NOT NULL,
  message_uuid    text NOT NULL,
  created_at      bigint NOT NULL,
  PRIMARY KEY (world_id, message_uuid)
);
CREATE INDEX IF NOT EXISTS messages_channel
  ON messages (world_id, channel_kind, channel_id, seq);

-- Kept separate, deliberately: its rows are (role: event|verdict, content) and genuinely not
-- (speaker, text) pairs. `through_idx` stays on the rows rather than in a mutable counter, so a
-- truncated transcript loses history but never double-judges.
CREATE TABLE IF NOT EXISTS god_transcript (
  world_id        text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  role            text NOT NULL,
  content         text NOT NULL,
  batch_id        text,
  idx             bigint,
  through_idx     bigint,
  PRIMARY KEY (world_id, seq)
);

-- Cheap, rebuildable from the log, explicitly outside replay, and "how did this entity get here"
-- is a question we will actually ask (§6.3).
CREATE TABLE IF NOT EXISTS state_audit (
  world_id        text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  seq             bigserial,
  entity_id       text NOT NULL,
  field           text NOT NULL,
  source          text NOT NULL,
  before_text     text NOT NULL DEFAULT '',
  after_text      text NOT NULL DEFAULT '',
  reason          text NOT NULL DEFAULT '',
  input_idx       bigint NOT NULL,
  batch_id        text,
  tags            jsonb,
  PRIMARY KEY (world_id, seq)
);
CREATE INDEX IF NOT EXISTS state_audit_by_input ON state_audit (world_id, input_idx);

-- The embedding lives on the row. Convex forced a second table because its vector index was a
-- table-level thing; nothing else did. A `double precision[]` today, a `vector` column the day
-- search moves off the client (plan D4).
CREATE TABLE IF NOT EXISTS memories (
  world_id        text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  memory_id       text NOT NULL,
  player_id       text NOT NULL,
  description     text NOT NULL,
  importance      double precision NOT NULL,
  last_access     bigint NOT NULL,
  created_at      bigint NOT NULL,
  data            jsonb NOT NULL,
  embedding       double precision[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (world_id, memory_id)
);
CREATE INDEX IF NOT EXISTS memories_by_player ON memories (world_id, player_id);

-- Keep. It saves real money.
CREATE TABLE IF NOT EXISTS embeddings_cache (
  text_hash       text PRIMARY KEY,
  embedding       double precision[] NOT NULL
);

-- Names of players who have left the world, so an old conversation still reads.
CREATE TABLE IF NOT EXISTS player_names (
  world_id        text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  player_id       text NOT NULL,
  name            text NOT NULL,
  PRIMARY KEY (world_id, player_id)
);

-- §4.4's quota reads this, and it is how spend reconciles against Langfuse. The client drives the
-- bill now; this is the row that makes that visible rather than merely true.
CREATE TABLE IF NOT EXISTS llm_calls (
  id              bigserial PRIMARY KEY,
  world_id        text,
  purpose         text,
  model           text,
  prompt_tokens   integer,
  completion_tokens integer,
  latency_ms      integer,
  trace_id        text,
  called_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_calls_by_world ON llm_calls (world_id, called_at);

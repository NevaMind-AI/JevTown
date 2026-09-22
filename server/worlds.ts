import type pg from 'pg';
import { db, transaction } from './db/index.ts';
import type {
  BatchRequest,
  BatchResponse,
  BootstrapResponse,
  LlmCallRecord,
  SessionRequest,
  SessionResponse,
} from './protocol.ts';
import type { AgentStoreSnapshot, StoreChange } from '../agent/store/memoryStore.ts';

/** Create a world, or return the one already there. Creating is idempotent by id. */
export async function createWorld(input: {
  id: string;
  name?: string;
  definition?: unknown;
}): Promise<{ id: string; created: boolean }> {
  return await transaction(async (client) => {
    const existing = await client.query('SELECT id FROM worlds WHERE id = $1', [input.id]);
    if (existing.rowCount) return { id: input.id, created: false };
    await client.query('INSERT INTO worlds (id, name) VALUES ($1, $2)', [
      input.id,
      input.name ?? input.id,
    ]);
    if (input.definition !== undefined) {
      await client.query(
        'INSERT INTO world_definition (world_id, doc) VALUES ($1, $2::jsonb)' +
          ' ON CONFLICT (world_id) DO UPDATE SET doc = EXCLUDED.doc, loaded_at = now()',
        [input.id, JSON.stringify(input.definition)],
      );
    }
    return { id: input.id, created: true };
  });
}

/**
 * Claim or renew the writer lease.
 *
 * Two browsers open on one world would interleave two divergent histories into one log, and this
 * is not hypothetical — people leave tabs open (docs/11 §4.3). The claim bumps `generation`, so
 * every batch the previous holder sends afterwards is rejected and it goes read-only rather than
 * forking. Renewing is the same call from the holder, which makes the heartbeat free.
 */
export async function claimSession(
  worldId: string,
  request: SessionRequest,
): Promise<SessionResponse> {
  return await transaction(async (client) => {
    const held = await client.query<{ session_id: string; generation: string }>(
      'SELECT session_id, generation FROM world_sessions WHERE world_id = $1 FOR UPDATE',
      [worldId],
    );
    const current = held.rows[0];
    if (current && current.session_id !== request.sessionId && !request.steal) {
      return {
        ok: false,
        reason: 'held',
        holder: current.session_id,
        generation: Number(current.generation),
      };
    }
    if (current && current.session_id === request.sessionId) {
      await client.query('UPDATE world_sessions SET heartbeat_at = now() WHERE world_id = $1', [
        worldId,
      ]);
      return { ok: true, sessionId: request.sessionId, generation: Number(current.generation) };
    }
    const generation = (current ? Number(current.generation) : 0) + 1;
    await client.query(
      'INSERT INTO world_sessions (world_id, session_id, generation) VALUES ($1, $2, $3)' +
        ' ON CONFLICT (world_id) DO UPDATE SET session_id = EXCLUDED.session_id,' +
        ' generation = EXCLUDED.generation, claimed_at = now(), heartbeat_at = now()',
      [worldId, request.sessionId, generation],
    );
    return { ok: true, sessionId: request.sessionId, generation };
  });
}

/**
 * Take one batch, whole or not at all.
 *
 * Three guards, in the order that makes each one cheap. A batch id already in the ledger is a
 * retry, and answering it with success is what makes retry-on-timeout safe. A stale generation is
 * the other tab. A mismatched base version means an acknowledgement went missing, and the answer
 * is to tell the client what we actually hold so it can re-send from there rather than guess.
 */
export async function applyBatch(worldId: string, batch: BatchRequest): Promise<BatchResponse> {
  return await transaction(async (client) => {
    const already = await client.query(
      'SELECT new_version FROM batches WHERE world_id = $1 AND batch_id = $2',
      [worldId, batch.batchId],
    );
    if (already.rowCount) {
      return {
        ok: true,
        version: Number(already.rows[0].new_version),
        changeSeq: batch.changeSeq,
        duplicate: true,
      };
    }

    const session = await client.query<{ session_id: string; generation: string }>(
      'SELECT session_id, generation FROM world_sessions WHERE world_id = $1 FOR UPDATE',
      [worldId],
    );
    const stored = await client.query<{ version: string }>(
      'SELECT version FROM world_state WHERE world_id = $1 FOR UPDATE',
      [worldId],
    );
    const storedVersion = stored.rowCount ? Number(stored.rows[0].version) : 0;

    const holder = session.rows[0];
    if (
      !holder ||
      holder.session_id !== batch.sessionId ||
      Number(holder.generation) !== batch.generation
    ) {
      return { ok: false, reason: 'stale-session', version: storedVersion };
    }
    if (storedVersion !== batch.baseVersion) {
      return { ok: false, reason: 'version-conflict', version: storedVersion };
    }

    for (const event of batch.events) {
      // `ON CONFLICT DO NOTHING` on the frontend-assigned key: an event already in the log stays
      // as it was recorded, and a partial resend cannot duplicate it (docs/11 §4.2).
      await client.query(
        'INSERT INTO events (world_id, idx, kind, game_time, wall_time, batch_id, payload)' +
          ' VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (world_id, idx) DO NOTHING',
        [
          worldId,
          event.idx,
          event.kind,
          event.gameTime,
          event.wallTime,
          batch.batchId,
          JSON.stringify(event.payload ?? null),
        ],
      );
    }

    await applyChanges(client, worldId, batch.batchId, batch.changes);

    await client.query(
      'INSERT INTO world_state (world_id, idx, version, state) VALUES ($1, $2, $3, $4::jsonb)' +
        ' ON CONFLICT (world_id) DO UPDATE SET idx = EXCLUDED.idx, version = EXCLUDED.version,' +
        ' state = EXCLUDED.state, updated_at = now()',
      [worldId, batch.toIdx, batch.newVersion, JSON.stringify(batch.state ?? null)],
    );
    await client.query(
      'INSERT INTO batches (world_id, batch_id, from_idx, to_idx, base_version, new_version,' +
        ' session_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        worldId,
        batch.batchId,
        batch.fromIdx,
        batch.toIdx,
        batch.baseVersion,
        batch.newVersion,
        batch.sessionId,
      ],
    );
    return { ok: true, version: batch.newVersion, changeSeq: batch.changeSeq, duplicate: false };
  });
}

/** Every durable write in the batch, each idempotent on its own key. */
async function applyChanges(
  client: pg.PoolClient,
  worldId: string,
  batchId: string,
  changes: StoreChange[],
) {
  for (const change of changes) {
    switch (change.kind) {
      case 'entityState':
        await client.query(
          'INSERT INTO entity_state (world_id, entity_id, version, state) VALUES ($1,$2,$3,$4)' +
            ' ON CONFLICT (world_id, entity_id, version) DO NOTHING',
          [worldId, change.entityId, change.version, change.state],
        );
        break;
      case 'blob':
        await client.query(
          'INSERT INTO blobs (hash, content) VALUES ($1,$2) ON CONFLICT (hash) DO NOTHING',
          [change.hash, change.content],
        );
        break;
      case 'message':
        await client.query(
          'INSERT INTO messages (world_id, channel_kind, channel_id, seq, author_kind,' +
            ' author_id, text, message_uuid, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)' +
            ' ON CONFLICT (world_id, message_uuid) DO NOTHING',
          [
            worldId,
            'conversation',
            change.message.conversationId,
            0,
            'player',
            change.message.author,
            change.message.text,
            change.message.messageUuid,
            change.message.createdAt,
          ],
        );
        break;
      case 'memory':
        await client.query(
          'INSERT INTO memories (world_id, memory_id, player_id, description, importance,' +
            ' last_access, created_at, data, embedding) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)' +
            ' ON CONFLICT (world_id, memory_id) DO NOTHING',
          [
            worldId,
            change.memory.id,
            change.memory.playerId,
            change.memory.description,
            change.memory.importance,
            change.memory.lastAccess,
            change.memory.createdAt,
            JSON.stringify(change.memory.data),
            change.memory.embedding,
          ],
        );
        break;
      case 'conversation':
        await client.query(
          'INSERT INTO conversations (world_id, conversation_id, creator, participants, created,' +
            ' ended, num_messages) VALUES ($1,$2,$3,$4,$5,$6,$7)' +
            ' ON CONFLICT (world_id, conversation_id) DO NOTHING',
          [
            worldId,
            change.conversation.id,
            change.conversation.creator,
            change.conversation.participants,
            change.conversation.created,
            change.conversation.ended,
            change.conversation.numMessages,
          ],
        );
        break;
      case 'playerName':
        await client.query(
          'INSERT INTO player_names (world_id, player_id, name) VALUES ($1,$2,$3)' +
            ' ON CONFLICT (world_id, player_id) DO UPDATE SET name = EXCLUDED.name',
          [worldId, change.playerId, change.name],
        );
        break;
      case 'transcript':
        await client.query(
          'INSERT INTO god_transcript (world_id, seq, role, content, batch_id, idx, through_idx)' +
            ' VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (world_id, seq) DO NOTHING',
          [
            worldId,
            change.row.seq,
            change.row.role,
            change.row.content,
            change.row.batchId ?? batchId,
            change.row.inputNumber ?? null,
            change.row.throughInputNumber ?? null,
          ],
        );
        break;
      case 'audit':
        await client.query(
          'INSERT INTO state_audit (world_id, seq, entity_id, field, source, before_text,' +
            ' after_text, reason, input_idx, batch_id, tags)' +
            ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)' +
            ' ON CONFLICT (world_id, seq) DO NOTHING',
          [
            worldId,
            change.row.seq,
            change.row.entityId,
            change.row.field,
            change.row.source,
            change.row.before,
            change.row.after,
            change.row.reason,
            change.row.inputNumber,
            change.row.batchId ?? batchId,
            JSON.stringify(change.row.tags ?? null),
          ],
        );
        break;
      case 'turn':
        await client.query(
          'INSERT INTO messages (world_id, channel_kind, channel_id, seq, author_kind,' +
            ' author_id, text, message_uuid, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)' +
            ' ON CONFLICT (world_id, message_uuid) DO NOTHING',
          [
            worldId,
            'interaction',
            change.turn.interactionId,
            change.turn.seq,
            change.turn.speaker === 'actor' ? 'player' : 'entity',
            change.turn.speaker === 'actor' ? change.turn.actorId : change.turn.targetId,
            change.turn.text,
            `${change.turn.interactionId}:${change.turn.seq}`,
            0,
          ],
        );
        break;
      case 'embedding':
        await client.query(
          'INSERT INTO embeddings_cache (text_hash, embedding) VALUES ($1,$2)' +
            ' ON CONFLICT (text_hash) DO NOTHING',
          [change.textHash, change.embedding],
        );
        break;
    }
  }
}

/**
 * Everything needed to resume, in one round trip.
 *
 * Resume reads this and replays nothing (docs/11 §6.1). The log stays a log: it is what a run is
 * reproducible *from*, not how a world is loaded.
 */
export async function bootstrap(worldId: string): Promise<BootstrapResponse | null> {
  const pool = db();
  const world = await pool.query<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM worlds WHERE id = $1',
    [worldId],
  );
  if (!world.rowCount) return null;

  const [
    definition,
    state,
    entityState,
    blobs,
    messages,
    memories,
    conversations,
    names,
    transcript,
    audits,
    embeddings,
  ] = await Promise.all([
    pool.query('SELECT doc FROM world_definition WHERE world_id = $1', [worldId]),
    pool.query('SELECT idx, version, state FROM world_state WHERE world_id = $1', [worldId]),
    pool.query(
      'SELECT entity_id, version, state FROM entity_state WHERE world_id = $1' +
        ' ORDER BY entity_id, version',
      [worldId],
    ),
    pool.query('SELECT hash, content FROM blobs'),
    pool.query(
      'SELECT channel_id, author_id, text, message_uuid, created_at FROM messages' +
        " WHERE world_id = $1 AND channel_kind = 'conversation' ORDER BY created_at",
      [worldId],
    ),
    pool.query(
      'SELECT memory_id, player_id, description, importance, last_access, created_at, data,' +
        ' embedding FROM memories WHERE world_id = $1 ORDER BY created_at',
      [worldId],
    ),
    pool.query(
      'SELECT conversation_id, creator, participants, created, ended, num_messages' +
        ' FROM conversations WHERE world_id = $1',
      [worldId],
    ),
    pool.query('SELECT player_id, name FROM player_names WHERE world_id = $1', [worldId]),
    pool.query(
      'SELECT seq, role, content, batch_id, idx, through_idx FROM god_transcript' +
        ' WHERE world_id = $1 ORDER BY seq',
      [worldId],
    ),
    pool.query(
      'SELECT seq, entity_id, field, source, before_text, after_text, reason, input_idx,' +
        ' batch_id, tags FROM state_audit WHERE world_id = $1 ORDER BY seq',
      [worldId],
    ),
    pool.query('SELECT text_hash, embedding FROM embeddings_cache'),
  ]);

  const byEntity = new Map<string, { version: number; state: string }[]>();
  for (const row of entityState.rows) {
    const list = byEntity.get(row.entity_id) ?? [];
    list.push({ version: Number(row.version), state: row.state ?? '' });
    byEntity.set(row.entity_id, list);
  }
  const byConversation = new Map<string, any[]>();
  for (const row of messages.rows) {
    const list = byConversation.get(row.channel_id) ?? [];
    list.push({
      conversationId: row.channel_id,
      messageUuid: row.message_uuid,
      author: row.author_id,
      text: row.text,
      createdAt: Number(row.created_at),
    });
    byConversation.set(row.channel_id, list);
  }
  const storedMemories = memories.rows.map((row) => ({
    id: row.memory_id,
    playerId: row.player_id,
    description: row.description,
    importance: Number(row.importance),
    lastAccess: Number(row.last_access),
    createdAt: Number(row.created_at),
    data: row.data,
    embedding: (row.embedding ?? []).map(Number),
  }));

  const store: AgentStoreSnapshot = {
    format: 'agent-store-1',
    entityState: [...byEntity.entries()],
    blobs: blobs.rows.map((row) => [row.hash, row.content]),
    messages: [...byConversation.entries()],
    memories: storedMemories as never,
    conversations: conversations.rows.map((row) => ({
      id: row.conversation_id,
      creator: row.creator,
      participants: row.participants,
      created: Number(row.created),
      ended: Number(row.ended),
      numMessages: Number(row.num_messages),
    })) as never,
    playerNames: names.rows.map((row) => [row.player_id, row.name]),
    transcript: transcript.rows.map((row) => ({
      seq: Number(row.seq),
      role: row.role,
      content: row.content,
      batchId: row.batch_id ?? undefined,
      inputNumber: row.idx === null ? undefined : Number(row.idx),
      throughInputNumber: row.through_idx === null ? undefined : Number(row.through_idx),
    })) as never,
    audits: audits.rows.map((row) => ({
      entityId: row.entity_id,
      field: row.field,
      source: row.source,
      before: row.before_text,
      after: row.after_text,
      reason: row.reason,
      inputNumber: Number(row.input_idx),
      batchId: row.batch_id ?? undefined,
      tags: row.tags ?? undefined,
    })) as never,
    turns: [],
    embeddings: embeddings.rows.map((row) => [row.text_hash, (row.embedding ?? []).map(Number)]),
    // A resumed world keeps minting ids above everything it already has.
    nextMemoryId:
      storedMemories.reduce((max, m) => Math.max(max, Number(m.id.split(':')[1]) || 0), 0) + 1,
    // Nothing is owed to the backend at resume: everything here came from it.
    changes: [],
    nextChangeSeq: 1,
    auditSeq: audits.rowCount ?? 0,
  };

  return {
    world: world.rows[0],
    definition: definition.rows[0]?.doc ?? null,
    state: state.rowCount
      ? {
          idx: Number(state.rows[0].idx),
          version: Number(state.rows[0].version),
          state: state.rows[0].state,
        }
      : null,
    store,
  };
}

export async function readEvents(worldId: string, from: number, to: number) {
  const result = await db().query(
    'SELECT idx, kind, game_time, wall_time, batch_id, payload FROM events' +
      ' WHERE world_id = $1 AND idx >= $2 AND idx <= $3 ORDER BY idx',
    [worldId, from, to],
  );
  return result.rows.map((row) => ({
    idx: Number(row.idx),
    kind: row.kind,
    gameTime: Number(row.game_time),
    wallTime: Number(row.wall_time),
    batchId: row.batch_id,
    payload: row.payload,
  }));
}

/** One row per model call. §4.4's quota reads this, and spend reconciles against Langfuse. */
export async function recordLlmCall(call: LlmCallRecord) {
  await db().query(
    'INSERT INTO llm_calls (world_id, purpose, model, prompt_tokens, completion_tokens,' +
      ' latency_ms, trace_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [
      call.worldId ?? null,
      call.purpose ?? null,
      call.model ?? null,
      call.promptTokens ?? null,
      call.completionTokens ?? null,
      call.latencyMs ?? null,
      call.traceId ?? null,
    ],
  );
}

/** Calls this world has made in the trailing window, for the quota to read. */
export async function callsInWindow(worldId: string, windowMs: number): Promise<number> {
  const result = await db().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM llm_calls WHERE world_id = $1' +
      " AND called_at > now() - ($2::bigint * interval '1 millisecond')",
    [worldId, windowMs],
  );
  return Number(result.rows[0]?.count ?? 0);
}

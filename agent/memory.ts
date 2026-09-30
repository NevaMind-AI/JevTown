import { ChatTrace, fetchEmbedding, runPurpose } from './model/client';
import { DEFAULT_IMPORTANCE } from './purposes/memoryImportance';
import { asyncMap } from '../engine/util/asyncMap';
import { GameId } from '../engine/aiTown/ids';
import { Tracer } from './model/tracing';
import { AgentContext, ArchivedConversation, StoredMemory } from './ports';
import { memoryStamp, memoryUnitsPerHour } from './storyClock';
import { memoryDisabled } from './config';

// How long to wait before updating a memory's last access time.
/**
 * Don't re-date a memory that was read in the last five minutes.
 *
 * In minutes rather than milliseconds because memories are dated on the fiction clock where the
 * host has one (docs/13 §3.5), and five fiction minutes is 300 story seconds, not 300,000. The
 * unit is applied at the point of use through `memoryUnitsPerHour`.
 */
export const MEMORY_ACCESS_THROTTLE_MINUTES = 5;
// We fetch 10x the number of memories by relevance, to have more candidates
// for sorting by relevance + recency + importance.
const MEMORY_OVERFETCH = 10;

export type Memory = StoredMemory;
export type MemoryType = Memory['data']['type'];
export type MemoryOfType<T extends MemoryType> = Omit<Memory, 'data'> & {
  data: Extract<Memory['data'], { type: T }>;
};

/**
 * Both sides of a finished conversation, named.
 *
 * Was a Convex `internalQuery` joining five tables. The live half comes from the world document;
 * only the archive is a real fetch, and `playerName` covers the case the old query needed
 * `archivedPlayers` for — a partner who has since left the world.
 */
export async function loadConversation(
  ctx: AgentContext,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
): Promise<{
  player: { id: string; name: string };
  otherPlayer: { id: string; name: string };
  conversation: ArchivedConversation;
}> {
  const player = ctx.world.player(playerId);
  if (!player) {
    throw new Error(`Player ${playerId} not found`);
  }
  const playerDescription = ctx.world.playerDescription(playerId);
  if (!playerDescription) {
    throw new Error(`Player description for ${playerId} not found`);
  }
  const conversation = await ctx.store.archivedConversation(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  const otherPlayerId = await ctx.store.otherParticipant(playerId, conversationId);
  if (!otherPlayerId) {
    throw new Error(
      `Couldn't find other participant in conversation ${conversationId} with player ${playerId}`,
    );
  }
  const otherName =
    ctx.world.playerDescription(otherPlayerId)?.name ?? (await ctx.store.playerName(otherPlayerId));
  if (!otherName) {
    throw new Error(`Player description for ${otherPlayerId} not found`);
  }
  return {
    player: { id: player.id, name: playerDescription.name },
    otherPlayer: { id: otherPlayerId, name: otherName },
    conversation,
  };
}

export async function rememberConversation(
  ctx: AgentContext,
  agentId: GameId<'agents'>,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
) {
  if (memoryDisabled()) return;
  const data = await loadConversation(ctx, playerId, conversationId);
  const { player, otherPlayer } = data;
  const messages = await ctx.store.listMessages(conversationId);
  if (!messages.length) {
    return;
  }

  const authors = new Set<GameId<'players'>>();
  for (const message of messages) {
    authors.add((message.author === player.id ? player.id : otherPlayer.id) as GameId<'players'>);
  }
  // The control path for agents with no prose state, but still the same conversation -- so it
  // joins the same trace as the turns rather than floating on its own.
  const tracer = await Tracer.forConversation({
    worldId: ctx.world.worldId,
    conversationId,
    name: `${player.name} ↔ ${otherPlayer.name}`,
    startedAt: data.conversation.created,
    metadata: { playerId, agentId, otherPlayerId: otherPlayer.id },
  });
  // The prompt is the server's (`conversation.remember`, docs/14 §3.2).
  const { result: content } = await runPurpose(
    'conversation.remember',
    {
      speaker: player.name,
      listener: otherPlayer.name,
      history: messages.map((message) => ({
        fromSpeaker: message.author === player.id,
        text: message.text,
      })),
    },
    tracer.generation('conversation.remember', { playerId }),
  );
  const description = `Conversation with ${otherPlayer.name} at ${new Date(
    data.conversation.created,
  ).toLocaleString()}: ${content}`;
  const importance = await calculateImportance(
    description,
    tracer.generation('memory.importance', { playerId }),
  );
  await tracer.close();
  const { embedding } = await fetchEmbedding(description);
  authors.delete(player.id as GameId<'players'>);
  await ctx.store.insertMemory({
    playerId: player.id as GameId<'players'>,
    description,
    importance,
    lastAccess: messages[messages.length - 1].createdAt,
    data: {
      type: 'conversation',
      conversationId,
      playerIds: [...authors],
    },
    embedding,
  });
  await reflectOnMemories(ctx, playerId);
  return description;
}

/**
 * The three-way ranking of docs/05 §5.2: relevance, recency and importance, each normalised over
 * the candidate set and summed.
 *
 * The store finds candidates; the ranking stays here. It is the part that encodes what this world
 * thinks a relevant memory is, and it has no business living in a database adapter.
 */
export async function searchMemories(
  ctx: AgentContext,
  playerId: GameId<'players'>,
  searchEmbedding: number[],
  n: number = 3,
): Promise<StoredMemory[]> {
  const candidates = await ctx.store.searchMemories(
    playerId,
    searchEmbedding,
    n * MEMORY_OVERFETCH,
  );
  if (candidates.length === 0) {
    return [];
  }
  const stamp = memoryStamp(ctx.clock);
  const perHour = memoryUnitsPerHour(ctx.clock);
  const recencyScore = candidates.map(({ memory }) => {
    const hoursSinceAccess = (stamp - memory.lastAccess) / perHour;
    return 0.99 ** Math.floor(hoursSinceAccess);
  });
  const relevanceRange = makeRange(candidates.map((c) => c.score));
  const importanceRange = makeRange(candidates.map((c) => c.memory.importance));
  const recencyRange = makeRange(recencyScore);
  const memoryScores = candidates.map(({ memory, score }, idx) => ({
    memory,
    overallScore:
      normalize(score, relevanceRange) +
      normalize(memory.importance, importanceRange) +
      normalize(recencyScore[idx], recencyRange),
  }));
  memoryScores.sort((a, b) => b.overallScore - a.overallScore);
  const accessed = memoryScores.slice(0, n);
  const throttle = (MEMORY_ACCESS_THROTTLE_MINUTES * perHour) / 60;
  const stale = accessed
    .filter(({ memory }) => memory.lastAccess < stamp - throttle)
    .map(({ memory }) => memory.id);
  if (stale.length) {
    await ctx.store.touchMemories(stale, stamp);
  }
  return accessed.map(({ memory }) => memory);
}

function makeRange(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [min, max] as const;
}

function normalize(value: number, range: readonly [number, number]) {
  const [min, max] = range;
  return (value - min) / (max - min);
}

/**
 * `trace` is optional because this is called from three places with very different context --
 * a conversation, a reflection, and a state write. Callers that have a tracer hand one over;
 * callers that don't get an untraced call rather than a trace with no meaningful parent.
 *
 * The prompt and the parsing live on the server now, as the `memory.importance` purpose
 * (`agent/purposes/memoryImportance.ts`, docs/14 §3.2).
 */
export async function calculateImportance(description: string, trace?: ChatTrace) {
  try {
    const { result } = await runPurpose('memory.importance', { description }, trace);
    return result;
  } catch (e) {
    // Every caller rates a memory it is about to write. Rethrowing here would take the memory
    // down with the rating, so the score degrades instead.
    console.error('Could not rate memory importance, using the default:', e);
    return DEFAULT_IMPORTANCE;
  }
}

async function reflectOnMemories(ctx: AgentContext, playerId: GameId<'players'>) {
  const name = ctx.world.playerDescription(playerId)?.name;
  if (!name) {
    throw new Error(`Player description for ${playerId} not found`);
  }
  const memories = await ctx.store.recentMemories(playerId, 100);
  const lastReflectionTs = await ctx.store.lastReflectionAt(playerId);

  // should only reflect if lastest 100 items have importance score of >500
  const sumOfImportanceScore = memories
    .filter((m) => m.createdAt > (lastReflectionTs ?? 0))
    .reduce((acc, curr) => acc + curr.importance, 0);
  const shouldReflect = sumOfImportanceScore > 500;

  if (!shouldReflect) {
    return false;
  }
  console.debug('sum of importance score = ', sumOfImportanceScore);
  console.debug('Reflecting...');
  // A reflection belongs to no conversation -- it is drawn from a hundred of them -- so it gets
  // its own trace, keyed by the run rather than by anything in the world.
  const tracer = await Tracer.standalone({
    worldId: ctx.world.worldId,
    key: `reflection:${ctx.world.worldId}:${playerId}:${crypto.randomUUID()}`,
    name: `${name} reflects`,
    tags: ['reflection'],
    metadata: { playerId, memories: memories.length, sumOfImportanceScore },
  });
  try {
    // The prompt and the reading of its JSON are the server's (`memory.reflect`, docs/14 §3.2). An
    // answer that is not an array of insights over these statements comes back as an error, and
    // lands in the catch below as an unreadable reflection always has.
    const { result: insights } = await runPurpose(
      'memory.reflect',
      { name, statements: memories.map((memory) => memory.description) },
      tracer.generation('memory.reflect', { playerId }),
    );
    const memoriesToSave = await asyncMap(insights, async (item) => {
      const relatedMemoryIds = item.statementIds.map((idx) => memories[idx].id);
      const importance = await calculateImportance(
        item.insight,
        tracer.generation('memory.importance', { playerId }),
      );
      const { embedding } = await fetchEmbedding(item.insight);
      console.debug('adding reflection memory...', item.insight);
      return {
        description: item.insight,
        embedding,
        importance,
        relatedMemoryIds,
      };
    });

    const lastAccess = memoryStamp(ctx.clock);
    for (const { embedding, relatedMemoryIds, ...rest } of memoriesToSave) {
      await ctx.store.insertMemory({
        playerId,
        lastAccess,
        embedding,
        ...rest,
        data: { type: 'reflection', relatedMemoryIds },
      });
    }
    await tracer.close({ output: memoriesToSave.map((m) => m.description) });
  } catch (e) {
    console.error('error saving or parsing reflection', e);
    // An unparseable reflection is the interesting case. Its raw text is in the server's
    // `memory.reflect` generation, and why it could not be read is here.
    await tracer.close({
      level: 'ERROR',
      statusMessage: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
  return true;
}

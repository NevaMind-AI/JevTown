import { ChatTrace, LLMMessage, chatCompletion, fetchEmbedding } from './model/client';
import { asyncMap } from '../engine/util/asyncMap';
import { GameId } from '../engine/aiTown/ids';
import { Tracer } from './model/tracing';
import { AgentContext, ArchivedConversation, StoredMemory } from './ports';

// How long to wait before updating a memory's last access time.
export const MEMORY_ACCESS_THROTTLE = 300_000; // In ms
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
  if (process.env.DISABLE_MEMORY === 'true') return;
  const data = await loadConversation(ctx, playerId, conversationId);
  const { player, otherPlayer } = data;
  const messages = await ctx.store.listMessages(conversationId);
  if (!messages.length) {
    return;
  }

  const llmMessages: LLMMessage[] = [
    {
      role: 'user',
      content: `You are ${player.name}, and you just finished a conversation with ${otherPlayer.name}. I would
      like you to summarize the conversation from ${player.name}'s perspective, using first-person pronouns like
      "I," and add if you liked or disliked this interaction.`,
    },
  ];
  const authors = new Set<GameId<'players'>>();
  for (const message of messages) {
    const author = message.author === player.id ? player : otherPlayer;
    authors.add(author.id as GameId<'players'>);
    const recipient = message.author === player.id ? otherPlayer : player;
    llmMessages.push({
      role: 'user',
      content: `${author.name} to ${recipient.name}: ${message.text}`,
    });
  }
  llmMessages.push({ role: 'user', content: 'Summary:' });
  // The control path for agents with no prose state, but still the same conversation -- so it
  // joins the same trace as the turns rather than floating on its own.
  const tracer = await Tracer.forConversation({
    worldId: ctx.world.worldId,
    conversationId,
    name: `${player.name} ↔ ${otherPlayer.name}`,
    startedAt: data.conversation.created,
    metadata: { playerId, agentId, otherPlayerId: otherPlayer.id },
  });
  const { content } = await chatCompletion({
    messages: llmMessages,
    max_tokens: 500,
    trace: tracer.generation('conversation.remember', { playerId }),
  });
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
  const ts = Date.now();
  const recencyScore = candidates.map(({ memory }) => {
    const hoursSinceAccess = (ts - memory.lastAccess) / 1000 / 60 / 60;
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
  const stale = accessed
    .filter(({ memory }) => memory.lastAccess < ts - MEMORY_ACCESS_THROTTLE)
    .map(({ memory }) => memory.id);
  if (stale.length) {
    await ctx.store.touchMemories(stale, ts);
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

// A 0-9 rating is a single token of content, but a budget of exactly 1 leaves no room for
// anything the model puts *around* it -- a leading newline, `**7**`, a chat template's preamble.
// Worse, our gateway answers a truncated completion with a fatal 400 rather than the standard
// `finish_reason: "length"`, so overrunning by one token loses the whole action. Small enough to
// stay cheap, generous enough that the digit always fits.
const IMPORTANCE_MAX_TOKENS = 16;
// Importance only ranks memories against each other. A rating we could not get or could not read
// is worth a mid-scale guess -- never worth losing the memory it belongs to.
const DEFAULT_IMPORTANCE = 5;

/**
 * `trace` is optional because this is called from three places with very different context --
 * a conversation, a reflection, and a state write. Callers that have a tracer hand one over;
 * callers that don't get an untraced call rather than a trace with no meaningful parent.
 */
export async function calculateImportance(description: string, trace?: ChatTrace) {
  let importanceRaw: string;
  try {
    ({ content: importanceRaw } = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: `On the scale of 0 to 9, where 0 is purely mundane (e.g., brushing teeth, making bed) and 9 is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory.
      Memory: ${description}
      Answer on a scale of 0 to 9. Respond with number only, e.g. "5"`,
        },
      ],
      temperature: 1,
      max_tokens: IMPORTANCE_MAX_TOKENS,
      trace,
    }));
  } catch (e) {
    // Every caller rates a memory it is about to write. Rethrowing here would take the memory
    // down with the rating, so the score degrades instead.
    console.error('Could not rate memory importance, using the default:', e);
    return DEFAULT_IMPORTANCE;
  }
  return parseImportance(importanceRaw);
}

// The prompt asks for a bare digit and that is usually what comes back, but a wrapper like
// `**7**` or `Rating: 7` still carries one. A long answer is a different matter: it tends to
// restate the prompt ("on a scale of 0 to 9..."), whose first number is not the rating -- so it
// is not trusted to contain one at all.
export function parseImportance(raw: string): number {
  const trimmed = raw.trim();
  const found = /^\d+$/.test(trimmed)
    ? trimmed
    : trimmed.length <= 32
      ? trimmed.match(/\d+/)?.[0]
      : undefined;
  if (found === undefined) {
    console.debug('Could not parse memory importance from: ', raw);
    return DEFAULT_IMPORTANCE;
  }
  // The scale is 0-9; a model that answers "10" still gets clamped onto it.
  return Math.min(9, Math.max(0, Number(found)));
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
  const prompt = ['[no prose]', '[Output only JSON]', `You are ${name}, statements about you:`];
  memories.forEach((m, idx) => {
    prompt.push(`Statement ${idx}: ${m.description}`);
  });
  prompt.push('What 3 high-level insights can you infer from the above statements?');
  prompt.push(
    'Return in JSON format, where the key is a list of input statements that contributed to your insights and value is your insight. Make the response parseable by Typescript JSON.parse() function. DO NOT escape characters or include "\n" or white space in response.',
  );
  prompt.push(
    'Example: [{insight: "...", statementIds: [1,2]}, {insight: "...", statementIds: [1]}, ...]',
  );

  // A reflection belongs to no conversation -- it is drawn from a hundred of them -- so it gets
  // its own trace, keyed by the run rather than by anything in the world.
  const tracer = await Tracer.standalone({
    worldId: ctx.world.worldId,
    key: `reflection:${ctx.world.worldId}:${playerId}:${crypto.randomUUID()}`,
    name: `${name} reflects`,
    tags: ['reflection'],
    metadata: { playerId, memories: memories.length, sumOfImportanceScore },
  });
  const { content: reflection } = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: prompt.join('\n'),
      },
    ],
    trace: tracer.generation('memory.reflect', { playerId }),
  });

  try {
    const insights = JSON.parse(reflection) as { insight: string; statementIds: number[] }[];
    const memoriesToSave = await asyncMap(insights, async (item) => {
      const relatedMemoryIds = item.statementIds.map((idx: number) => memories[idx].id);
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

    const lastAccess = Date.now();
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
    console.debug('reflection', reflection);
    // An unparseable reflection is the interesting case, so the trace keeps the raw text.
    await tracer.close({
      output: reflection,
      level: 'ERROR',
      statusMessage: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
  return true;
}

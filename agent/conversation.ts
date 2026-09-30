import { runPurpose } from './model/client';
import * as memory from './memory';
import * as embeddingsCache from './embeddingsCache';
import { GameId } from '../engine/aiTown/ids';
import { NUM_MEMORIES_TO_SEARCH } from '../engine/constants';
import { promptContextFor } from './promptContext';
import { Tracer } from './model/tracing';
import { AgentContext } from './ports';
import { memoryDisabled, numMemoriesToSearch } from './config';
import type { Line, Speakers } from './purposes/conversation';

// Rendered on the server now; re-exported for what already imports it from here.
export { relatedMemoriesMessages } from './purposes/conversation';

export async function startConversationMessage(
  ctx: AgentContext,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<string> {
  const data = await promptData(ctx, playerId, otherPlayerId, conversationId);
  const { player, otherPlayer, lastConversation } = data;
  const memories = memoryDisabled()
    ? []
    : await memory.searchMemories(
        ctx,
        player.id as GameId<'players'>,
        await embeddingsCache.fetchEmbedding(
          ctx,
          `${player.name} is talking to ${otherPlayer.name}`,
        ),
        numMemoriesToSearch(NUM_MEMORIES_TO_SEARCH),
      );

  const memoryWithOtherPlayer = memories.find(
    (m) => m.data.type === 'conversation' && m.data.playerIds.includes(otherPlayerId),
  );

  const tracer = await Tracer.forConversation({
    worldId: ctx.world.worldId,
    conversationId,
    name: `${player.name} ↔ ${otherPlayer.name}`,
    metadata: { playerId, otherPlayerId },
  });
  const { result } = await runPurpose(
    'conversation.start',
    {
      ...(await speakers(ctx, playerId, data)),
      memories: memories.map(({ description }) => description),
      recallsListener: memoryWithOtherPlayer !== undefined,
      lastTalked: lastConversation
        ? {
            then: new Date(lastConversation.created).toLocaleString(),
            now: new Date().toLocaleString(),
          }
        : undefined,
    },
    tracer.generation('conversation.start', { speaker: player.name }),
  );
  await tracer.close();
  return result;
}

export async function continueConversationMessage(
  ctx: AgentContext,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<string> {
  const data = await promptData(ctx, playerId, otherPlayerId, conversationId);
  const { player, otherPlayer, conversation } = data;
  const memories = memoryDisabled()
    ? []
    : await memory.searchMemories(
        ctx,
        player.id as GameId<'players'>,
        await embeddingsCache.fetchEmbedding(ctx, `What do you think about ${otherPlayer.name}?`),
        3,
      );

  const tracer = await Tracer.forConversation({
    worldId: ctx.world.worldId,
    conversationId,
    name: `${player.name} ↔ ${otherPlayer.name}`,
    startedAt: conversation.created,
    metadata: { playerId, otherPlayerId },
  });
  const { result } = await runPurpose(
    'conversation.continue',
    {
      ...(await speakers(ctx, playerId, data)),
      memories: memories.map(({ description }) => description),
      // Fiction time only (docs/13 §3.5); the server words it.
      storyTime: ctx.clock.storyTime(),
      messagesSoFar: conversation.numMessages,
      history: await history(ctx, playerId, conversation.id as GameId<'conversations'>),
    },
    tracer.generation('conversation.continue', { speaker: player.name }),
  );
  await tracer.close();
  return result;
}

export async function leaveConversationMessage(
  ctx: AgentContext,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<string> {
  const data = await promptData(ctx, playerId, otherPlayerId, conversationId);
  const { player, otherPlayer, conversation } = data;

  const tracer = await Tracer.forConversation({
    worldId: ctx.world.worldId,
    conversationId,
    name: `${player.name} ↔ ${otherPlayer.name}`,
    startedAt: conversation.created,
    metadata: { playerId, otherPlayerId },
  });
  const { result } = await runPurpose(
    'conversation.leave',
    {
      ...(await speakers(ctx, playerId, data)),
      history: await history(ctx, playerId, conversation.id as GameId<'conversations'>),
    },
    tracer.generation('conversation.leave', { speaker: player.name }),
  );
  await tracer.close();
  return result;
}

/**
 * What the speaker knows, as the vars every conversation purpose shares.
 *
 * The prompts themselves are built on the server now (`agent/purposes/conversation.ts`, docs/14
 * §3.2). This is the part only the tab can supply: the world it holds and the speaker's prose.
 */
async function speakers(
  ctx: AgentContext,
  playerId: GameId<'players'>,
  data: Awaited<ReturnType<typeof promptData>>,
): Promise<Speakers> {
  const context = await promptContextFor(ctx, playerId);
  return {
    speaker: data.player.name,
    listener: data.otherPlayer.name,
    identity: data.agent.identity,
    behavior: data.agent.behavior,
    listenerIdentity: data.otherAgent?.identity,
    context: context
      ? { worldRules: context.worldRules, worldState: context.worldState, state: context.state }
      : undefined,
  };
}

/** The conversation so far, from the speaker's side. */
async function history(
  ctx: AgentContext,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
): Promise<Line[]> {
  const messages = await ctx.store.listMessages(conversationId);
  return messages.map((message) => ({
    fromSpeaker: message.author === playerId,
    text: message.text,
  }));
}

/**
 * Both speakers, their agents and the last time they talked.
 *
 * Was a Convex `internalQuery` over six tables. Five of the six are the world document and the
 * description maps, which are synchronous reads now; only "when did these two last talk" is still
 * a fetch, and docs/11 §6.4 derives that from `conversations.participants` rather than keeping
 * the `participatedTogether` projection Convex made us materialise.
 */
async function promptData(
  ctx: AgentContext,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
) {
  const player = ctx.world.player(playerId);
  if (!player) {
    throw new Error(`Player ${playerId} not found`);
  }
  const playerDescription = ctx.world.playerDescription(playerId);
  if (!playerDescription) {
    throw new Error(`Player description for ${playerId} not found`);
  }
  const otherPlayer = ctx.world.player(otherPlayerId);
  if (!otherPlayer) {
    throw new Error(`Player ${otherPlayerId} not found`);
  }
  const otherPlayerDescription = ctx.world.playerDescription(otherPlayerId);
  if (!otherPlayerDescription) {
    throw new Error(`Player description for ${otherPlayerId} not found`);
  }
  const conversation = ctx.world.conversation(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  const agent = ctx.world.agentForPlayer(playerId);
  if (!agent) {
    throw new Error(`Player ${playerId} not found`);
  }
  const agentDescription = ctx.world.agentDescription(agent.id);
  if (!agentDescription) {
    throw new Error(`Agent description for ${agent.id} not found`);
  }
  const otherAgent = ctx.world.agentForPlayer(otherPlayerId);
  let otherAgentDescription;
  if (otherAgent) {
    otherAgentDescription = ctx.world.agentDescription(otherAgent.id);
    if (!otherAgentDescription) {
      throw new Error(`Agent description for ${otherAgent.id} not found`);
    }
  }
  const lastConversation = await ctx.store.lastConversationBetween(playerId, otherPlayerId);
  return {
    player: { name: playerDescription.name, ...player },
    otherPlayer: { name: otherPlayerDescription.name, ...otherPlayer },
    conversation,
    agent: {
      identity: agentDescription.identity,
      behavior: agentDescription.behavior,
      ...agent,
    },
    otherAgent: otherAgent && {
      identity: otherAgentDescription!.identity,
      ...otherAgent,
    },
    lastConversation: lastConversation ?? null,
  };
}

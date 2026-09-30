import { fetchEmbedding, runPurpose } from './model/client';
import { GameId } from '../engine/aiTown/ids';
import { AgentContext } from './ports';
import { memoryStamp } from './storyClock';
import { Tracer } from './model/tracing';
import { agentIdForPlayer, promptContextFor } from './promptContext';
import { proseOf } from './purposes/sections';
import type { StateUpdateOutcome } from './purposes/stateWrite';
import { calculateImportance, loadConversation } from './memory';

// The re-ask loop runs on the server now, inside the state-writing purposes (docs/14 §3.2).
// Re-exported for what already imports it from here.
export { requestStateUpdate } from './purposes/stateWrite';
export type { StateUpdateOutcome } from './purposes/stateWrite';

/**
 * docs/05 §6.1: on conclusion, each side makes **one** call that emits its rewritten state, its
 * physics projection, its new memories and its reason — never four calls. This replaces the
 * summarise-only call that `memory.rememberConversation` makes.
 */
export async function updateStateAfterConversation(
  ctx: AgentContext,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
): Promise<StateUpdateOutcome | null> {
  const context = await promptContextFor(ctx, playerId);
  if (!context) {
    return null;
  }
  const data = await loadConversation(ctx, playerId, conversationId);
  const messages = await ctx.store.listMessages(conversationId);
  if (!messages.length) {
    return null;
  }
  const { player, otherPlayer } = data;

  // Same conversation id, so this lands in the same trace as the turns it is summarising -- the
  // state write is the last thing that happens to a conversation, not a separate event.
  const tracer = await Tracer.forConversation({
    worldId: ctx.world.worldId,
    conversationId,
    name: `${player.name} ↔ ${otherPlayer.name}`,
    metadata: { playerId, otherPlayerId: otherPlayer.id },
  });
  // The prompt, the re-ask and the parsing run on the server (`conversation.state`, docs/14
  // §3.2). A re-ask gets its own span there, named `conversation.state.reask.<n>`.
  const { result: outcome } = await runPurpose(
    'conversation.state',
    {
      self: proseOf(context),
      speaker: player.name,
      listener: otherPlayer.name,
      history: messages.map((message) => ({
        fromSpeaker: message.author === player.id,
        text: message.text,
      })),
    },
    tracer.generation('conversation.state', { playerId, attempt: 0 }),
  );

  await sendStateUpdate(ctx, playerId, outcome);
  await storeConversationMemories(ctx, playerId, conversationId, otherPlayer, outcome, tracer);
  // Closed last so the importance calls above ride out in the same export.
  await tracer.close({ metadata: { reasks: outcome.reasks, fellBack: outcome.fellBack } });
  return outcome;
}

/**
 * Send the update into the engine. The prose reaches the database through the input log and
 * `saveWorld`, never from here — and the conformance record rides along in `tags`, which is what
 * turns "does prose state drift" into a query over a real run (docs/08 §7 D6).
 */
export async function sendStateUpdate(
  ctx: AgentContext,
  entityId: string,
  outcome: StateUpdateOutcome,
) {
  // No physics rides here. The handler derives it from the document's own tag, which is what
  // lets a god write move physics too (docs/05 §4.3 as amended).
  await ctx.inputs.send('entityUpdateState', {
    entityId,
    state: outcome.state,
    // docs/13 §4: the record patch rides the same input as the state document, so one model call
    // is one write at one step boundary. It survives a state that fell back to the previous
    // document — an over-budget paragraph is no reason to lose a task line (docs/13 §1.7).
    world: outcome.update.world,
    memory: outcome.update.memory,
    reason: outcome.update.reason,
    tags: {
      ...(outcome.conformance ?? {}),
      reasks: outcome.reasks,
      fellBack: outcome.fellBack,
      problems: outcome.problems,
    },
  });
}

/**
 * Memory storage stays here rather than in the input handler: `memories` requires an
 * `embeddingId` that a mutation cannot produce. The input above already carried the text, which
 * is what docs/05 §9.1 requires of the log; this is the searchable copy.
 */
async function storeConversationMemories(
  ctx: AgentContext,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
  otherPlayer: { id: string; name: string },
  outcome: StateUpdateOutcome,
  tracer?: Tracer,
) {
  if (!agentIdForPlayer(ctx, playerId)) {
    return;
  }
  for (const entry of outcome.update.memory) {
    const description = `Conversation with ${otherPlayer.name}: ${entry}`;
    const importance = await calculateImportance(
      description,
      tracer?.generation('memory.importance', { playerId }),
    );
    const { embedding } = await fetchEmbedding(description);
    await ctx.store.insertMemory({
      playerId,
      description,
      importance,
      lastAccess: memoryStamp(ctx.clock),
      data: {
        type: 'conversation',
        conversationId,
        playerIds: [otherPlayer.id as GameId<'players'>],
      },
      embedding,
    });
  }
}

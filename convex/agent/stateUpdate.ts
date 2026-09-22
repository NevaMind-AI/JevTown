import { Id } from '../_generated/dataModel';
import { ActionCtx } from '../_generated/server';
import { api, internal } from '../_generated/api';
import { LLMMessage, chatCompletion, fetchEmbedding } from '../util/llm';
import { GameId } from '../aiTown/ids';
import { ENVELOPE_INSTRUCTION, STATE_REASK_LIMIT, STATE_WORD_BUDGET } from '../prose/contract';
import { EnvelopeUpdate, parseEnvelope } from '../prose/envelope';
import { Tracer } from './tracing';
import { Conformance, StateDocument, parseStateDocument } from '../prose/stateDocument';
import { stateWritingSystemPrompt } from './promptContext';
import { calculateImportance } from './memory';

const selfInternal = internal.agent.promptContext;

export interface StateUpdateOutcome {
  update: EnvelopeUpdate;
  document?: StateDocument;
  conformance?: Conformance;
  /** Present only when the update survived: the document to write. */
  state?: string;
  reasks: number;
  /** True when the update was discarded and the entity keeps its previous document. */
  fellBack: boolean;
  problems: string[];
}

/**
 * The re-ask loop of docs/08 §7 D2, as a pure function over an `ask` callback.
 *
 * It lives in an action rather than in an input handler because **Convex mutations cannot call
 * models**: a handler can reject or truncate but never re-ask. Length is the only thing worth
 * re-asking over — a missing section, an invented head-state or a document with no structure at
 * all are tolerated and recorded, because what an entity does with a malformed state document is
 * an observation rather than a bug (docs/05 §5.1 as amended).
 *
 * Taking `ask` as a parameter is what makes the loop testable without a model.
 */
export async function requestStateUpdate(opts: {
  ask: (retryHint?: string) => Promise<string>;
  reaskLimit?: number;
}): Promise<StateUpdateOutcome> {
  const limit = opts.reaskLimit ?? STATE_REASK_LIMIT;
  let reasks = 0;
  let raw = await opts.ask();
  let parsed = parseEnvelope(raw);
  let problems = [...parsed.problems, ...parsed.self.problems];

  for (;;) {
    const state = parsed.self.state;
    if (state === undefined) {
      // No state in the envelope. Nothing to fall back *from* — the entity simply keeps what it
      // had, and physics and memory in the same envelope still apply.
      return { update: parsed.self, reasks, fellBack: false, problems };
    }
    const { document, conformance } = parseStateDocument(state);
    conformance.reasks = reasks;
    if (!conformance.overBudget) {
      return { update: parsed.self, document, conformance, state, reasks, fellBack: false, problems };
    }
    if (reasks >= limit) {
      conformance.fellBack = true;
      problems = [...problems, `still over ${STATE_WORD_BUDGET} words after ${reasks} re-ask(s)`];
      return {
        update: { ...parsed.self, state: undefined },
        document,
        conformance,
        reasks,
        fellBack: true,
        problems,
      };
    }
    reasks += 1;
    raw = await opts.ask(
      `That was ${conformance.wordCount} words, over the ${STATE_WORD_BUDGET}-word limit. Send the same state document again, shorter, keeping every section.`,
    );
    parsed = parseEnvelope(raw);
    problems = [...problems, ...parsed.problems, ...parsed.self.problems];
  }
}

/**
 * docs/05 §6.1: on conclusion, each side makes **one** call that emits its rewritten state, its
 * physics projection, its new memories and its reason — never four calls. This replaces the
 * summarise-only call that `memory.rememberConversation` makes.
 */
export async function updateStateAfterConversation(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
): Promise<StateUpdateOutcome | null> {
  const context = await ctx.runQuery(selfInternal.queryPromptContext, {
    worldId,
    entityId: playerId,
  });
  if (!context) {
    return null;
  }
  const data = await ctx.runQuery(internal.agent.memory.loadConversation, {
    worldId,
    playerId,
    conversationId,
  });
  const messages = await ctx.runQuery(internal.agent.memory.loadMessages, {
    worldId,
    conversationId,
  });
  if (!messages.length) {
    return null;
  }
  const { player, otherPlayer } = data;

  const transcript: LLMMessage[] = messages.map((message) => {
    const author = message.author === player.id ? player : otherPlayer;
    const recipient = message.author === player.id ? otherPlayer : player;
    return {
      role: 'user' as const,
      content: `${author.name} to ${recipient.name}: ${message.text}`,
    };
  });

  const system = stateWritingSystemPrompt(context, ENVELOPE_INSTRUCTION);
  // Same conversation id, so this lands in the same trace as the turns it is summarising -- the
  // state write is the last thing that happens to a conversation, not a separate event.
  const tracer = await Tracer.forConversation({
    worldId,
    conversationId,
    name: `${player.name} ↔ ${otherPlayer.name}`,
    metadata: { playerId, otherPlayerId: otherPlayer.id },
  });
  let attempt = 0;
  const outcome = await requestStateUpdate({
    ask: async (retryHint) => {
      const llmMessages: LLMMessage[] = [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `You just finished a conversation with ${otherPlayer.name}. It went like this.`,
        },
        ...transcript,
        {
          role: 'user',
          content:
            retryHint ??
            `Rewrite your state now that the conversation is over, and say what you will remember.`,
        },
      ];
      const { content } = await chatCompletion({
        messages: llmMessages,
        max_tokens: 1200,
        trace: tracer.generation(
          attempt === 0 ? 'conversation.state' : `conversation.state.reask.${attempt}`,
          { playerId, attempt },
        ),
      });
      attempt++;
      return content;
    },
  });

  await sendStateUpdate(ctx, worldId, playerId, outcome);
  await storeConversationMemories(
    ctx,
    worldId,
    playerId,
    conversationId,
    otherPlayer,
    outcome,
    tracer,
  );
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
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  entityId: string,
  outcome: StateUpdateOutcome,
) {
  await ctx.runMutation(api.aiTown.main.sendInput, {
    worldId,
    name: 'entityUpdateState',
    // No physics rides here. The handler derives it from the document's own tag, which is what
    // lets a god write move physics too (docs/05 §4.3 as amended).
    args: {
      entityId,
      state: outcome.state,
      memory: outcome.update.memory,
      reason: outcome.update.reason,
      tags: {
        ...(outcome.conformance ?? {}),
        reasks: outcome.reasks,
        fellBack: outcome.fellBack,
        problems: outcome.problems,
      },
    },
  });
}

/**
 * Memory storage stays here rather than in the input handler: `memories` requires an
 * `embeddingId` that a mutation cannot produce. The input above already carried the text, which
 * is what docs/05 §9.1 requires of the log; this is the searchable copy.
 */
async function storeConversationMemories(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
  otherPlayer: { id: string; name: string },
  outcome: StateUpdateOutcome,
  tracer?: Tracer,
) {
  const agent = await ctx.runQuery(internal.agent.promptContext.queryAgentForPlayer, {
    worldId,
    playerId,
  });
  if (!agent) {
    return;
  }
  for (const entry of outcome.update.memory) {
    const description = `Conversation with ${otherPlayer.name}: ${entry}`;
    const importance = await calculateImportance(
      description,
      tracer?.generation('memory.importance', { playerId }),
    );
    const { embedding } = await fetchEmbedding(description);
    await ctx.runMutation(internal.agent.memory.insertMemory, {
      agentId: agent.agentId as GameId<'agents'>,
      playerId,
      description,
      importance,
      lastAccess: Date.now(),
      data: {
        type: 'conversation',
        conversationId,
        playerIds: [otherPlayer.id as GameId<'players'>],
      },
      embedding,
    });
  }
}

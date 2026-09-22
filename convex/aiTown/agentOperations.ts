import { v } from 'convex/values';
import { internalAction } from '../_generated/server';

import { rememberConversation } from '../agent/memory';
import { updateStateAfterConversation } from '../agent/stateUpdate';
import { GameId, agentId, conversationId, playerId } from './ids';
import {
  continueConversationMessage,
  leaveConversationMessage,
  startConversationMessage,
} from '../agent/conversation';
import { assertNever } from '../util/assertNever';
import { DecisionManifest } from './manifest';
import { decisionSystemPrompt, idleFallback, parseDecision } from '../agent/decide';
import { interactWithEntity } from '../agent/interact';
import { chatCompletion } from '../util/llm';
import { api, internal } from '../_generated/api';
import { sleep } from '../util/sleep';
import { Tracer } from '../agent/tracing';

export const agentRememberConversation = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    // docs/05 §6.1: one call rewrites state, emits physics, and writes memory. It replaces the
    // summarise-only call — but only for entities that actually carry prose state. An agent
    // created from `data/characters.ts` has none, and stays on the original path so it remains a
    // usable control (docs/07 §6.3).
    const context = await ctx.runQuery(internal.agent.promptContext.queryPromptContext, {
      worldId: args.worldId,
      entityId: args.playerId,
    });
    if (context?.state !== undefined) {
      await updateStateAfterConversation(
        ctx,
        args.worldId,
        args.playerId as GameId<'players'>,
        args.conversationId as GameId<'conversations'>,
      );
    } else {
      await rememberConversation(
        ctx,
        args.worldId,
        args.agentId as GameId<'agents'>,
        args.playerId as GameId<'players'>,
        args.conversationId as GameId<'conversations'>,
      );
    }
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishRememberConversation',
      args: {
        agentId: args.agentId,
        operationId: args.operationId,
      },
    });
  },
});

export const agentGenerateMessage = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    otherPlayerId: playerId,
    operationId: v.string(),
    type: v.union(v.literal('start'), v.literal('continue'), v.literal('leave')),
    messageUuid: v.string(),
  },
  handler: async (ctx, args) => {
    let completionFn;
    switch (args.type) {
      case 'start':
        completionFn = startConversationMessage;
        break;
      case 'continue':
        completionFn = continueConversationMessage;
        break;
      case 'leave':
        completionFn = leaveConversationMessage;
        break;
      default:
        assertNever(args.type);
    }
    const text = await completionFn(
      ctx,
      args.worldId,
      args.conversationId as GameId<'conversations'>,
      args.playerId as GameId<'players'>,
      args.otherPlayerId as GameId<'players'>,
    );

    await ctx.runMutation(internal.aiTown.agent.agentSendMessage, {
      worldId: args.worldId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      playerId: args.playerId,
      text,
      messageUuid: args.messageUuid,
      leaveConversation: args.type === 'leave',
      operationId: args.operationId,
    });
  },
});

/**
 * docs/05 §6.4 and docs/09 §5: one model call replaces the `Math.random()` branch that chose
 * between inviting, wandering and doing an activity, and the uniform random tile that used to be
 * a destination. It runs in an action and re-enters through an input, so it is replay-safe by
 * construction and adds no nondeterminism source (docs/05 §10).
 */
export const agentDecide = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    manifest: v.any(),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const manifest = args.manifest as DecisionManifest;
    const context = await ctx.runQuery(internal.agent.promptContext.queryPromptContext, {
      worldId: args.worldId,
      entityId: args.playerId,
    });
    let decision = idleFallback('This agent has no description to think with.');
    let problems: string[] = [];
    if (context) {
      // A decision belongs to no conversation by definition -- it is what the agent does *instead*
      // of being in one -- so it gets its own trace, keyed by the operation.
      const tracer = await Tracer.standalone({
        worldId: args.worldId,
        key: `decision:${args.worldId}:${args.operationId}`,
        name: `${context.name} decides`,
        tags: ['decision'],
        metadata: { playerId: args.playerId, agentId: args.agentId },
      });
      const { content } = await chatCompletion({
        messages: [
          { role: 'system', content: decisionSystemPrompt(context, manifest) },
          { role: 'user', content: 'What do you do next?' },
        ],
        max_tokens: 400,
        trace: tracer.generation('agent.decide'),
      });
      ({ decision, problems } = parseDecision(content, manifest));
      await tracer.close({
        output: decision,
        metadata: { action: decision.action, problems },
        ...(problems.length ? { level: 'ERROR' as const, statusMessage: problems.join('; ') } : {}),
      });
    }
    // Jitter against the OCC hotspot on the input path (docs/05 §9.7).
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'agentDecideAction',
      args: {
        agentId: args.agentId,
        operationId: args.operationId,
        action: decision.action,
        target: decision.action === 'approach' ? decision.target : undefined,
        intent: decision.action === 'approach' ? decision.intent : undefined,
        anchor: decision.action === 'wander' ? decision.anchor : undefined,
        durationMs: decision.action === 'idle' ? decision.durationMs : undefined,
        description: decision.action === 'idle' ? decision.description : undefined,
        emoji: decision.action === 'idle' ? decision.emoji : undefined,
        reason: decision.reason,
        problems,
      },
    });
  },
});

/** docs/09 §6: the agent has arrived at what it chose to approach. */
export const agentInteract = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    targetId: v.string(),
    intent: v.string(),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    await interactWithEntity(
      ctx,
      args.worldId,
      args.playerId as GameId<'players'>,
      args.targetId,
      args.intent,
    );
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishInteraction',
      args: { agentId: args.agentId, operationId: args.operationId },
    });
  },
});

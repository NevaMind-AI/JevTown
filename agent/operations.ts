import { rememberConversation } from './memory';
import { updateStateAfterConversation } from './stateUpdate';
import { GameId } from '../engine/aiTown/ids';
import {
  continueConversationMessage,
  leaveConversationMessage,
  startConversationMessage,
} from './conversation';
import { assertNever } from '../engine/util/assertNever';
import { DecisionManifest } from '../engine/aiTown/manifest';
import { decisionSystemPrompt, idleFallback, parseDecision } from './decide';
import { decisionFromAnswers, jevDecisionRequest } from './decideJev';
import { interactWithEntity } from './interact';
import { chatCompletion, systemOne } from './model/client';
import { Tracer } from './model/tracing';
import { promptContextFor } from './promptContext';
import { AgentContext } from './ports';
import { decider } from './config';

/**
 * The four things an agent can go away and do.
 *
 * Each was a Convex `internalAction` scheduled from `saveWorld`; each is a plain async function
 * now, and `runAgentOperation` below is the dispatch table that used to be a switch over
 * `internal.aiTown.agentOperations`. The shape is unchanged and deliberately so: an operation
 * reads the world, makes model calls, and re-enters through `ctx.inputs.send`. Nothing here
 * writes world state, which is what keeps a run replayable from its log without a model
 * (docs/05 §9, docs/10 §4).
 *
 * One thing is gone. Every operation used to end with `await sleep(Math.random() * 1000)` to
 * spread out contention on `engineInsertInput`'s input-number allocation (docs/05 §9.7). Under
 * frontend authority there is one queue in one runtime, so there is nothing to contend for --
 * and the jitter was an unseeded `Math.random()` in the path of a replayable event besides.
 */

export interface OperationArgs {
  operationId: string;
  playerId: GameId<'players'>;
  agentId: GameId<'agents'>;
  [key: string]: any;
}

export async function runAgentOperation(
  ctx: AgentContext,
  name: string,
  args: OperationArgs,
): Promise<void> {
  switch (name) {
    case 'agentRememberConversation':
      return await agentRememberConversation(ctx, args as any);
    case 'agentGenerateMessage':
      return await agentGenerateMessage(ctx, args as any);
    case 'agentDecide':
      return await agentDecide(ctx, args as any);
    case 'agentInteract':
      return await agentInteract(ctx, args as any);
    default:
      throw new Error(`Unknown operation: ${name}`);
  }
}

export async function agentRememberConversation(
  ctx: AgentContext,
  args: {
    playerId: GameId<'players'>;
    agentId: GameId<'agents'>;
    conversationId: GameId<'conversations'>;
    operationId: string;
  },
) {
  // docs/05 §6.1: one call rewrites state, emits physics, and writes memory. It replaces the
  // summarise-only call — but only for entities that actually carry prose state. An agent
  // created from `data/characters.ts` has none, and stays on the original path so it remains a
  // usable control (docs/07 §6.3).
  const context = await promptContextFor(ctx, args.playerId);
  if (context?.state !== undefined) {
    await updateStateAfterConversation(ctx, args.playerId, args.conversationId);
  } else {
    await rememberConversation(ctx, args.agentId, args.playerId, args.conversationId);
  }
  await ctx.inputs.send('finishRememberConversation', {
    agentId: args.agentId,
    operationId: args.operationId,
  });
}

export async function agentGenerateMessage(
  ctx: AgentContext,
  args: {
    playerId: GameId<'players'>;
    agentId: GameId<'agents'>;
    conversationId: GameId<'conversations'>;
    otherPlayerId: GameId<'players'>;
    operationId: string;
    type: 'start' | 'continue' | 'leave';
    messageUuid: string;
  },
) {
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
  const text = await completionFn(ctx, args.conversationId, args.playerId, args.otherPlayerId);

  // Was `internal.aiTown.agent.agentSendMessage`, a mutation that wrote the row and queued the
  // input in one transaction. The two are separate calls now; the input is what the simulation
  // sees, and `messageUuid` is what makes the row idempotent if the batch is retried
  // (docs/11 §6.2).
  await ctx.store.insertMessage({
    conversationId: args.conversationId,
    messageUuid: args.messageUuid,
    author: args.playerId,
    text,
    createdAt: Date.now(),
  });
  await ctx.inputs.send('agentFinishSendingMessage', {
    conversationId: args.conversationId,
    agentId: args.agentId,
    timestamp: Date.now(),
    leaveConversation: args.type === 'leave',
    operationId: args.operationId,
  });
}

/**
 * docs/05 §6.4 and docs/09 §5: one model call replaces the `Math.random()` branch that chose
 * between inviting, wandering and doing an activity, and the uniform random tile that used to be
 * a destination. The decision re-enters through an input, so it is replay-safe by construction
 * and adds no nondeterminism source (docs/05 §10).
 */
export async function agentDecide(
  ctx: AgentContext,
  args: {
    playerId: GameId<'players'>;
    agentId: GameId<'agents'>;
    manifest: DecisionManifest;
    operationId: string;
  },
) {
  const manifest = args.manifest;
  const context = await promptContextFor(ctx, args.playerId);
  let decision = idleFallback('This agent has no description to think with.');
  let problems: string[] = [];
  if (context) {
    // A decision belongs to no conversation by definition -- it is what the agent does *instead*
    // of being in one -- so it gets its own trace, keyed by the operation.
    const tracer = await Tracer.standalone({
      worldId: ctx.world.worldId,
      key: `decision:${ctx.world.worldId}:${args.operationId}`,
      name: `${context.name} decides`,
      tags: ['decision', `decider:${decider()}`],
      metadata: { playerId: args.playerId, agentId: args.agentId },
    });
    // The two deciders of docs/12 §1. Same manifest, same trace shape, same `Decision` out --
    // which is the whole point of the flag: they are comparable, and neither is load-bearing for
    // the other. What differs is that the Jev decider returns no prose (docs/12 §2).
    if (decider() === 'jev') {
      const request = jevDecisionRequest(context, manifest);
      const { answers } = await systemOne({
        state: request.state,
        questions: request.questions,
        worldId: ctx.world.worldId,
        trace: tracer.generation('agent.decide'),
      });
      ({ decision, problems } = decisionFromAnswers(answers, request));
    } else {
      const { content } = await chatCompletion({
        messages: [
          { role: 'system', content: decisionSystemPrompt(context, manifest) },
          { role: 'user', content: 'What do you do next?' },
        ],
        max_tokens: 400,
        trace: tracer.generation('agent.decide'),
      });
      ({ decision, problems } = parseDecision(content, manifest));
    }
    await tracer.close({
      output: decision,
      metadata: { action: decision.action, problems },
      ...(problems.length ? { level: 'ERROR' as const, statusMessage: problems.join('; ') } : {}),
    });
  }
  await ctx.inputs.send('agentDecideAction', {
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
  });
}

/** docs/09 §6: the agent has arrived at what it chose to approach. */
export async function agentInteract(
  ctx: AgentContext,
  args: {
    playerId: GameId<'players'>;
    agentId: GameId<'agents'>;
    targetId: string;
    intent: string;
    operationId: string;
  },
) {
  await interactWithEntity(ctx, args.playerId, args.targetId, args.intent);
  await ctx.inputs.send('finishInteraction', {
    agentId: args.agentId,
    operationId: args.operationId,
  });
}

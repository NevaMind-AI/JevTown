import { v } from '../util/validators';
import { agentId, conversationId, parseGameId } from './ids';
import { Player } from './player';
import { conversationInputs } from './conversation';
import { sourceOfTarget, targetIsStillLegal } from './manifest';
import { inputHandler } from './inputHandler';
import { Descriptions } from '../../data/characters';
import { AgentDescription } from './agentDescription';
import { Agent } from './agent';
import { Game } from './game';

export const agentInputs = {
  finishRememberConversation: inputHandler({
    args: {
      operationId: v.string(),
      agentId,
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} isn't remembering ${args.operationId}`);
      } else {
        delete agent.inProgressOperation;
        delete agent.toRemember;
      }
      return null;
    },
  }),
  /**
   * docs/09 §5. Applies whichever of the three actions the model chose. Every branch is a no-op
   * when the world has moved underneath it: the decision was made in an action, against a
   * snapshot, and a model call takes seconds (docs/09 §8). The predecessor `finishDoSomething`
   * threw when the invitee was gone, which stock AI Town got away with only because its candidate
   * query ran milliseconds before the input.
   */
  agentDecideAction: inputHandler({
    args: {
      agentId,
      operationId: v.string(),
      action: v.union(v.literal('approach'), v.literal('wander'), v.literal('idle')),
      target: v.optional(v.string()),
      intent: v.optional(v.string()),
      anchor: v.optional(v.string()),
      durationMs: v.optional(v.number()),
      description: v.optional(v.string()),
      emoji: v.optional(v.string()),
      reason: v.string(),
      problems: v.optional(v.array(v.string())),
    },
    handler: (game, now, args) => {
      const agent = game.world.agents.get(parseGameId('agents', args.agentId));
      if (!agent) {
        throw new Error(`Couldn't find agent: ${args.agentId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${args.agentId} didn't have ${args.operationId} in progress`);
        return null;
      }
      delete agent.inProgressOperation;
      agent.lastDecision = now;
      const player = game.world.players.get(agent.playerId)!;

      switch (args.action) {
        case 'idle':
          player.activity = {
            description: args.description ?? 'standing still',
            emoji: args.emoji,
            until: now + (args.durationMs ?? 30_000),
          };
          return null;
        case 'wander': {
          // docs/13 §2: the engine names the place and the world that owns the ground picks the
          // tile — the nearest free one, by walking — because only it knows who stands where.
          if (!args.anchor || !game.mapFor(game.sceneOf(player)).anchor(args.anchor)) {
            console.debug(`No place ${args.anchor} here; deciding again`);
            return null;
          }
          if (player.sourceId === undefined) {
            console.debug(`Agent ${args.agentId} has no body the host can move`);
            return null;
          }
          game.queueMove({ kind: 'wander', body: player.sourceId, anchor: args.anchor });
          return null;
        }
        case 'approach': {
          if (!args.target || !targetIsStillLegal(game, now, player, args.target)) {
            console.debug(`Target ${args.target} is no longer legal; deciding again`);
            return null;
          }
          const target = sourceOfTarget(game, args.target);
          if (player.sourceId === undefined || target === undefined) {
            console.debug(`No body to walk ${args.agentId} to ${args.target}; deciding again`);
            return null;
          }
          // Where to stand is the ground's question (docs/13 §2), and so is whether anywhere
          // beside the target is free. If nowhere is, `bodyMoveFailed` comes back and this is
          // cleared; arrival is `Agent.tickApproach`'s to notice.
          agent.pendingInteraction = {
            targetId: args.target,
            intent: args.intent ?? '',
            startedWalking: now,
            lastIssued: now,
          };
          game.queueMove({ kind: 'approach', body: player.sourceId, target });
          return null;
        }
      }
    },
  }),

  /**
   * A move the world that owns the ground could not start (docs/13 §2): nowhere free beside the
   * target, a place with no free tile, a target that left the scene.
   *
   * Only an approach has anything to undo. Without this the agent would stand waiting for an
   * arrival that is never coming until `APPROACH_TIMEOUT` — a minute of game time, twenty of
   * fiction — so it is told, and decides again.
   */
  bodyMoveFailed: inputHandler({
    args: { body: v.string(), kind: v.string(), reason: v.string() },
    handler: (game, now, args) => {
      if (args.kind !== 'approach') return null;
      const player = [...game.world.players.values()].find((p) => p.sourceId === args.body);
      const agent = player && [...game.world.agents.values()].find((a) => a.playerId === player.id);
      if (agent?.pendingInteraction) {
        console.debug(`Approach by ${args.body} could not start: ${args.reason}`);
        delete agent.pendingInteraction;
      }
      return null;
    },
  }),

  finishInteraction: inputHandler({
    args: { agentId, operationId: v.string() },
    handler: (game, now, args) => {
      const agent = game.world.agents.get(parseGameId('agents', args.agentId));
      if (!agent) {
        throw new Error(`Couldn't find agent: ${args.agentId}`);
      }
      if (agent.inProgressOperation?.operationId === args.operationId) {
        delete agent.inProgressOperation;
      }
      delete agent.pendingInteraction;
      agent.lastDecision = now;
      return null;
    },
  }),

  agentFinishSendingMessage: inputHandler({
    args: {
      agentId,
      conversationId,
      timestamp: v.number(),
      operationId: v.string(),
      leaveConversation: v.boolean(),
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      const player = game.world.players.get(agent.playerId);
      if (!player) {
        throw new Error(`Couldn't find player: ${agent.playerId}`);
      }
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) {
        throw new Error(`Couldn't find conversation: ${conversationId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} wasn't sending a message ${args.operationId}`);
        return null;
      }
      delete agent.inProgressOperation;
      conversationInputs.finishSendingMessage.handler(game, now, {
        playerId: agent.playerId,
        conversationId: args.conversationId,
        timestamp: args.timestamp,
      });
      if (args.leaveConversation) {
        conversation.leave(game, now, player);
      }
      return null;
    },
  }),
  createAgent: inputHandler({
    args: {
      descriptionIndex: v.number(),
    },
    handler: (game, now, args) => {
      const description = Descriptions[args.descriptionIndex];
      const playerId = Player.join(
        game,
        now,
        description.name,
        description.character,
        description.identity,
      );
      const agentId = game.allocId('agents');
      game.world.agents.set(
        agentId,
        new Agent({
          id: agentId,
          playerId: playerId,
          inProgressOperation: undefined,
          lastConversation: undefined,
          lastInviteAttempt: undefined,
          toRemember: undefined,
        }),
      );
      game.agentDescriptions.set(
        agentId,
        new AgentDescription({
          agentId: agentId,
          identity: description.identity,
        }),
      );
      return { agentId };
    },
  }),
};

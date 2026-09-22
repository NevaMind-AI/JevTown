import { v } from 'convex/values';
import { agentId, conversationId, parseGameId } from './ids';
import { Player } from './player';
import { Conversation, conversationInputs } from './conversation';
import { blocked, movePlayer } from './movement';
import { targetIsStillLegal } from './manifest';
import { Point } from '../util/types';
import { distance } from '../util/geometry';
import { inputHandler } from './inputHandler';
import { Descriptions } from '../../data/characters';
import { AgentDescription } from './agentDescription';
import { Agent } from './agent';
import { Game } from './game';

/**
 * Where to stand to act on a target: the target itself if it moves, otherwise the nearest free
 * tile adjacent to its anchor rect — an anchor is a rectangle, so a 3x2 gate has ten choices
 * (docs/09 §6).
 */
function approachDestination(
  game: Game,
  now: number,
  player: Player,
  targetId: string,
): Point | undefined {
  if (targetId.startsWith('p:')) {
    const other = game.world.players.get(parseGameId('players', targetId));
    return other && { x: Math.floor(other.position.x), y: Math.floor(other.position.y) };
  }
  const entity = game.world.entities.get(parseGameId('entities', targetId));
  if (!entity) {
    return undefined;
  }
  const free = game.worldMap
    .approachTiles(entity.anchor)
    .filter((tile) => !blocked(game, now, tile));
  if (free.length === 0) {
    return undefined;
  }
  return free.reduce((best, tile) =>
    distance(player.position, tile) < distance(player.position, best) ? tile : best,
  );
}

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
      if (!agent.inProgressOperation || agent.inProgressOperation.operationId !== args.operationId) {
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
          const tiles = args.anchor ? game.worldMap.anchorTiles(args.anchor) : [];
          const free = tiles.filter((tile) => !blocked(game, now, tile));
          if (free.length === 0) {
            console.debug(`Nowhere free in ${args.anchor}; deciding again`);
            return null;
          }
          movePlayer(game, now, player, game.rng.pick(free));
          return null;
        }
        case 'approach': {
          if (!args.target || !targetIsStillLegal(game, now, player, args.target)) {
            console.debug(`Target ${args.target} is no longer legal; deciding again`);
            return null;
          }
          if (args.target.startsWith('p:')) {
            // Tier (a) needs no approach state of its own: `Conversation` already owns walking
            // toward a target that is itself walking (docs/09 §6).
            const invitee = game.world.players.get(parseGameId('players', args.target));
            if (!invitee) {
              return null;
            }
            Conversation.start(game, now, player, invitee);
            agent.lastInviteAttempt = now;
            return null;
          }
          const destination = approachDestination(game, now, player, args.target);
          if (!destination) {
            console.debug(`No way to stand next to ${args.target}; deciding again`);
            return null;
          }
          agent.pendingInteraction = {
            targetId: args.target,
            intent: args.intent ?? '',
            startedWalking: now,
          };
          movePlayer(game, now, player, destination);
          return null;
        }
      }
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

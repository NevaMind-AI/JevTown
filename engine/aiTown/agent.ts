import { ObjectType, v } from '../util/validators';
import { GameId, parseGameId } from './ids';
import { agentId, conversationId, playerId } from './ids';
import { Player } from './player';
import { Game } from './game';
import {
  ACTION_TIMEOUT,
  APPROACH_TIMEOUT,
  AWKWARD_CONVERSATION_TIMEOUT,
  CONVERSATION_DISTANCE,
  INTERACTION_DISTANCE,
  MIN_DECISION_INTERVAL,
  INVITE_ACCEPT_PROBABILITY,
  INVITE_TIMEOUT,
  MAX_CONVERSATION_DURATION,
  MAX_CONVERSATION_MESSAGES,
  MESSAGE_COOLDOWN,
  MIDPOINT_THRESHOLD,
} from '../constants';
import { distance } from '../util/geometry';
import { movePlayer, stopPlayer } from './movement';
import { DecisionManifest, buildManifest, targetIsStillLegal } from './manifest';

export class Agent {
  id: GameId<'agents'>;
  playerId: GameId<'players'>;
  toRemember?: GameId<'conversations'>;
  lastConversation?: number;
  lastInviteAttempt?: number;
  lastDecision?: number;
  pendingInteraction?: { targetId: string; intent: string; startedWalking: number };
  inProgressOperation?: {
    name: string;
    operationId: string;
    started: number;
  };

  constructor(serialized: SerializedAgent) {
    const { id, lastConversation, lastInviteAttempt, inProgressOperation } = serialized;
    this.lastDecision = serialized.lastDecision;
    this.pendingInteraction = serialized.pendingInteraction;
    const playerId = parseGameId('players', serialized.playerId);
    this.id = parseGameId('agents', id);
    this.playerId = playerId;
    this.toRemember =
      serialized.toRemember !== undefined
        ? parseGameId('conversations', serialized.toRemember)
        : undefined;
    this.lastConversation = lastConversation;
    this.lastInviteAttempt = lastInviteAttempt;
    this.inProgressOperation = inProgressOperation;
  }

  tick(game: Game, now: number) {
    const player = game.world.players.get(this.playerId);
    if (!player) {
      throw new Error(`Invalid player ID ${this.playerId}`);
    }
    if (this.inProgressOperation) {
      if (now < this.inProgressOperation.started + ACTION_TIMEOUT) {
        // Wait on the operation to finish.
        return;
      }
      console.log(`Timing out ${JSON.stringify(this.inProgressOperation)}`);
      delete this.inProgressOperation;
    }

    // Remember before deciding (docs/09 §7). This branch used to sit *after* the decision, so an
    // agent chose its next action on memory that did not yet include the conversation it had just
    // left — harmless in stock AI Town, where the engine never reads memory, and a bug here, where
    // memory feeds target selection (docs/05 §9.1).
    if (this.toRemember) {
      console.log(`Agent ${this.id} remembering conversation ${this.toRemember}`);
      this.startOperation(game, now, 'agentRememberConversation', {
        worldId: game.worldId,
        playerId: this.playerId,
        agentId: this.id,
        conversationId: this.toRemember,
      });
      delete this.toRemember;
      return;
    }

    const conversation = game.world.playerConversation(player);
    const member = conversation?.participants.get(player.id);

    // Being in a conversation, walking, or busy cancels an activity, as before.
    if (player.activity && player.activity.until > now && (conversation || player.pathfinding)) {
      player.activity.until = now;
    }
    // Check to see if we have a conversation we need to remember.
    if (this.toRemember) {
      // Fire off the action to remember the conversation.
      console.log(`Agent ${this.id} remembering conversation ${this.toRemember}`);
      this.startOperation(game, now, 'agentRememberConversation', {
        worldId: game.worldId,
        playerId: this.playerId,
        agentId: this.id,
        conversationId: this.toRemember,
      });
      delete this.toRemember;
      return;
    }
    if (conversation && member) {
      const [otherPlayerId, otherMember] = [...conversation.participants.entries()].find(
        ([id]) => id !== player.id,
      )!;
      const otherPlayer = game.world.players.get(otherPlayerId)!;
      if (member.status.kind === 'invited') {
        // Accept a conversation with another agent with some probability and with
        // a human unconditionally.
        if (otherPlayer.human || game.rng.random() < INVITE_ACCEPT_PROBABILITY) {
          console.log(`Agent ${player.id} accepting invite from ${otherPlayer.id}`);
          conversation.acceptInvite(game, player);
          // Stop moving so we can start walking towards the other player.
          if (player.pathfinding) {
            delete player.pathfinding;
          }
        } else {
          console.log(`Agent ${player.id} rejecting invite from ${otherPlayer.id}`);
          conversation.rejectInvite(game, now, player);
        }
        return;
      }
      if (member.status.kind === 'walkingOver') {
        // Leave a conversation if we've been waiting for too long.
        if (member.invited + INVITE_TIMEOUT < now) {
          console.log(`Giving up on invite to ${otherPlayer.id}`);
          conversation.leave(game, now, player);
          return;
        }

        // Don't keep moving around if we're near enough.
        const playerDistance = distance(player.position, otherPlayer.position);
        if (playerDistance < CONVERSATION_DISTANCE) {
          return;
        }

        // Keep moving towards the other player.
        // If we're close enough to the player, just walk to them directly.
        if (!player.pathfinding) {
          let destination;
          if (playerDistance < MIDPOINT_THRESHOLD) {
            destination = {
              x: Math.floor(otherPlayer.position.x),
              y: Math.floor(otherPlayer.position.y),
            };
          } else {
            destination = {
              x: Math.floor((player.position.x + otherPlayer.position.x) / 2),
              y: Math.floor((player.position.y + otherPlayer.position.y) / 2),
            };
          }
          console.log(`Agent ${player.id} walking towards ${otherPlayer.id}...`, destination);
          movePlayer(game, now, player, destination);
        }
        return;
      }
      if (member.status.kind === 'participating') {
        const started = member.status.started;
        if (conversation.isTyping && conversation.isTyping.playerId !== player.id) {
          // Wait for the other player to finish typing.
          return;
        }
        if (!conversation.lastMessage) {
          const isInitiator = conversation.creator === player.id;
          const awkwardDeadline = started + AWKWARD_CONVERSATION_TIMEOUT;
          // Send the first message if we're the initiator or if we've been waiting for too long.
          if (isInitiator || awkwardDeadline < now) {
            // Grab the lock on the conversation and send a "start" message.
            console.log(`${player.id} initiating conversation with ${otherPlayer.id}.`);
            const messageUuid = game.rng.uuid();
            conversation.setIsTyping(now, player, messageUuid);
            this.startOperation(game, now, 'agentGenerateMessage', {
              worldId: game.worldId,
              playerId: player.id,
              agentId: this.id,
              conversationId: conversation.id,
              otherPlayerId: otherPlayer.id,
              messageUuid,
              type: 'start',
            });
            return;
          } else {
            // Wait on the other player to say something up to the awkward deadline.
            return;
          }
        }
        // See if the conversation has been going on too long and decide to leave.
        const tooLongDeadline = started + MAX_CONVERSATION_DURATION;
        if (tooLongDeadline < now || conversation.numMessages > MAX_CONVERSATION_MESSAGES) {
          console.log(`${player.id} leaving conversation with ${otherPlayer.id}.`);
          const messageUuid = game.rng.uuid();
          conversation.setIsTyping(now, player, messageUuid);
          this.startOperation(game, now, 'agentGenerateMessage', {
            worldId: game.worldId,
            playerId: player.id,
            agentId: this.id,
            conversationId: conversation.id,
            otherPlayerId: otherPlayer.id,
            messageUuid,
            type: 'leave',
          });
          return;
        }
        // Wait for the awkward deadline if we sent the last message.
        if (conversation.lastMessage.author === player.id) {
          const awkwardDeadline = conversation.lastMessage.timestamp + AWKWARD_CONVERSATION_TIMEOUT;
          if (now < awkwardDeadline) {
            return;
          }
        }
        // Wait for a cooldown after the last message to simulate "reading" the message.
        const messageCooldown = conversation.lastMessage.timestamp + MESSAGE_COOLDOWN;
        if (now < messageCooldown) {
          return;
        }
        // Grab the lock and send a message!
        console.log(`${player.id} continuing conversation with ${otherPlayer.id}.`);
        const messageUuid = game.rng.uuid();
        conversation.setIsTyping(now, player, messageUuid);
        this.startOperation(game, now, 'agentGenerateMessage', {
          worldId: game.worldId,
          playerId: player.id,
          agentId: this.id,
          conversationId: conversation.id,
          otherPlayerId: otherPlayer.id,
          messageUuid,
          type: 'continue',
        });
        return;
      }
      // An agent in a conversation is not off deciding to wander: a hard gate (docs/09 §2).
      return;
    }

    if (this.pendingInteraction && this.tickApproach(game, now, player)) {
      return;
    }

    const doingActivity = player.activity && player.activity.until > now;
    if (doingActivity || player.pathfinding) {
      return;
    }
    // The one piece of pacing the model must not own (docs/09 §10).
    if (this.lastDecision !== undefined && now < this.lastDecision + MIN_DECISION_INTERVAL) {
      return;
    }

    this.startOperation(game, now, 'agentDecide', {
      worldId: game.worldId,
      playerId: this.playerId,
      agentId: this.id,
      manifest: buildManifest(game, now, this, player),
    });
  }

  /**
   * An approach the model chose, still in flight (docs/09 §6). Returns true when it handled the
   * tick; false means the approach was abandoned and the agent should decide again.
   */
  private tickApproach(game: Game, now: number, player: Player): boolean {
    const pending = this.pendingInteraction!;
    if (!targetIsStillLegal(game, now, player, pending.targetId)) {
      delete this.pendingInteraction;
      return false;
    }
    if (now > pending.startedWalking + APPROACH_TIMEOUT) {
      // The path may be blocked by something that is not going to move.
      console.log(`Agent ${this.id} gave up approaching ${pending.targetId}`);
      stopPlayer(player);
      delete this.pendingInteraction;
      return false;
    }
    const entity = game.world.entities.get(parseGameId('entities', pending.targetId));
    if (!entity) {
      delete this.pendingInteraction;
      return false;
    }
    const tiles = game.worldMap.anchorTiles(entity.anchor);
    const nearest = tiles.reduce(
      (best, tile) => Math.min(best, distance(player.position, tile)),
      Infinity,
    );
    if (nearest > INTERACTION_DISTANCE) {
      // Still walking.
      return true;
    }
    stopPlayer(player);
    this.startOperation(game, now, 'agentInteract', {
      worldId: game.worldId,
      playerId: this.playerId,
      agentId: this.id,
      targetId: pending.targetId,
      intent: pending.intent,
    });
    return true;
  }

  startOperation<Name extends AgentOperationName>(
    game: Game,
    now: number,
    name: Name,
    args: AgentOperationArgs[Name],
  ) {
    if (this.inProgressOperation) {
      throw new Error(
        `Agent ${this.id} already has an operation: ${JSON.stringify(this.inProgressOperation)}`,
      );
    }
    const operationId = game.allocId('operations');
    console.log(`Agent ${this.id} starting operation ${name} (${operationId})`);
    game.scheduleOperation(name, { operationId, ...args } as any);
    this.inProgressOperation = {
      name,
      operationId,
      started: now,
    };
  }

  serialize(): SerializedAgent {
    return {
      id: this.id,
      playerId: this.playerId,
      toRemember: this.toRemember,
      lastConversation: this.lastConversation,
      lastInviteAttempt: this.lastInviteAttempt,
      lastDecision: this.lastDecision,
      pendingInteraction: this.pendingInteraction,
      inProgressOperation: this.inProgressOperation,
    };
  }
}

/** An approach chosen by the model and not yet resolved into an interaction (docs/09 §6). */
export const pendingInteraction = v.object({
  targetId: v.string(),
  intent: v.string(),
  startedWalking: v.number(),
});

export const serializedAgent = {
  id: agentId,
  playerId: playerId,
  toRemember: v.optional(conversationId),
  lastConversation: v.optional(v.number()),
  lastInviteAttempt: v.optional(v.number()),
  lastDecision: v.optional(v.number()),
  pendingInteraction: v.optional(pendingInteraction),
  inProgressOperation: v.optional(
    v.object({
      name: v.string(),
      operationId: v.string(),
      started: v.number(),
    }),
  ),
};
export type SerializedAgent = ObjectType<typeof serializedAgent>;

/**
 * The asynchronous work an agent can ask for, and the arguments it supplies.
 *
 * The engine names an operation and hands over its arguments; what actually runs it -- a Convex
 * action today, a browser task after docs/11 §1 -- is the host's business. Declaring the map here
 * rather than deriving it from `internal.aiTown.agentOperations` is what lets this module compile
 * with no runtime host, and it keeps the call sites type-checked either way.
 *
 * `operationId` is deliberately absent: `startOperation` allocates it from the world's id
 * sequence, so it is replayable and never supplied by a caller.
 */
export type AgentOperationArgs = {
  agentRememberConversation: {
    worldId: string;
    playerId: GameId<'players'>;
    agentId: GameId<'agents'>;
    conversationId: GameId<'conversations'>;
  };
  agentGenerateMessage: {
    worldId: string;
    playerId: GameId<'players'>;
    agentId: GameId<'agents'>;
    conversationId: GameId<'conversations'>;
    otherPlayerId: GameId<'players'>;
    messageUuid: string;
    type: 'start' | 'continue' | 'leave';
  };
  agentDecide: {
    worldId: string;
    playerId: GameId<'players'>;
    agentId: GameId<'agents'>;
    manifest: DecisionManifest;
  };
  agentInteract: {
    worldId: string;
    playerId: GameId<'players'>;
    agentId: GameId<'agents'>;
    targetId: string;
    intent: string;
  };
};

export type AgentOperationName = keyof AgentOperationArgs;

/** The operation names, for hosts that dispatch on a string. */
export const AGENT_OPERATION_NAMES = [
  'agentRememberConversation',
  'agentGenerateMessage',
  'agentDecide',
  'agentInteract',
] as const satisfies readonly AgentOperationName[];

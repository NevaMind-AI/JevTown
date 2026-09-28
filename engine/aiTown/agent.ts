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
  MAX_CONVERSATION_DURATION,
  MAX_CONVERSATION_MESSAGES,
  MESSAGE_COOLDOWN,
  REAPPROACH_INTERVAL,
} from '../constants';
import { distance } from '../util/geometry';
import { Conversation } from './conversation';
import {
  DecisionManifest,
  buildManifest,
  sourceOfTarget,
  targetIsStillLegal,
} from './manifest';

export class Agent {
  id: GameId<'agents'>;
  playerId: GameId<'players'>;
  toRemember?: GameId<'conversations'>;
  lastConversation?: number;
  lastInviteAttempt?: number;
  lastDecision?: number;
  pendingInteraction?: {
    targetId: string;
    intent: string;
    startedWalking: number;
    lastIssued?: number;
  };
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
    if (player.activity && player.activity.until > now && (conversation || player.speed > 0)) {
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
      const [otherPlayerId] = [...conversation.participants.entries()].find(
        ([id]) => id !== player.id,
      )!;
      const otherPlayer = game.world.players.get(otherPlayerId)!;
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
    if (doingActivity || player.speed > 0) {
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
      game.stopBody(player);
      delete this.pendingInteraction;
      return false;
    }
    // Distances mean something only within one scene (docs/13 §2): two bodies at (4, 7) in two
    // different rooms are not close.
    const here = game.sceneOf(player);
    if (pending.targetId.startsWith('p:')) {
      // docs/13 §2: an approach to another actor ends in a conversation the same way an approach
      // to a prop ends in an interaction — on arrival, and only then.
      const other = game.world.players.get(parseGameId('players', pending.targetId));
      if (!other) {
        delete this.pendingInteraction;
        return false;
      }
      if (
        game.sceneOf(other) !== here ||
        distance(player.position, other.position) > CONVERSATION_DISTANCE
      ) {
        this.keepApproaching(game, now, player, pending);
        return true;
      }
      game.stopBody(player);
      delete this.pendingInteraction;
      const { error } = Conversation.start(game, now, player, other);
      this.lastInviteAttempt = now;
      if (error) {
        console.log(`Agent ${this.id} arrived but could not start talking: ${error}`);
        return false;
      }
      return true;
    }
    const entity = game.world.entities.get(parseGameId('entities', pending.targetId));
    if (!entity) {
      delete this.pendingInteraction;
      return false;
    }
    const nearest =
      game.sceneOf(entity) !== here
        ? Infinity
        : game
            .mapFor(here)
            .anchorTiles(entity.anchor)
            .reduce((best, tile) => Math.min(best, distance(player.position, tile)), Infinity);
    if (nearest > INTERACTION_DISTANCE) {
      this.keepApproaching(game, now, player, pending);
      return true;
    }
    game.stopBody(player);
    this.startOperation(game, now, 'agentInteract', {
      worldId: game.worldId,
      playerId: this.playerId,
      agentId: this.id,
      targetId: pending.targetId,
      intent: pending.intent,
    });
    return true;
  }

  /**
   * Re-aim an approach whose walk ended short (docs/13 §2).
   *
   * The approach was resolved against where the target stood when it was sent; a person walks
   * on. The host only reports a walk that could not start — not one that finished beside where
   * somebody used to be — so noticing that is this side's job. Asked again only once the body has
   * stopped and a step's worth of time has passed, so a sync that has not arrived yet is not
   * mistaken for a walk that ended.
   */
  private keepApproaching(
    game: Game,
    now: number,
    player: Player,
    pending: NonNullable<Agent['pendingInteraction']>,
  ) {
    if (player.speed > 0) return;
    if (now < (pending.lastIssued ?? pending.startedWalking) + REAPPROACH_INTERVAL) return;
    const target = sourceOfTarget(game, pending.targetId);
    if (player.sourceId === undefined || target === undefined) return;
    pending.lastIssued = now;
    game.queueMove({ kind: 'approach', body: player.sourceId, target });
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
  /** When the approach was last asked for, so a short walk is re-aimed at a steady pace. */
  lastIssued: v.optional(v.number()),
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

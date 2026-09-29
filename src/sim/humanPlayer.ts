import type { GameId } from '../../engine/aiTown/ids';
import type { AgenticRuntime } from './agenticRuntime';
import { FACING } from './bodyBridge';

/**
 * The authored id of the person at the keyboard, on both sides of the seam (docs/13 §2).
 *
 * `MemoryWorld` has no entity for the player — it is `draft.player` — so nothing in a world file
 * can collide with this, and `BodyBridge` never finds it among the entities it syncs.
 */
export const HUMAN_SOURCE_ID = '__player__';

/**
 * Who the agents think they are talking to. A placeholder until a world file authors the player;
 * the engine requires a character, and nothing draws this one.
 */
const DEFAULT_IDENTITY: HumanIdentity = {
  name: '玩家',
  description: 'The person the player controls.',
  character: 'f1',
};

export interface HumanIdentity {
  name: string;
  description: string;
  character: string;
}

/** What `HumanPlayer` needs of the world that owns the ground. `MemoryWorld` satisfies it. */
export interface HumanGround {
  inspect(): {
    sceneId: string;
    player: { x: number; y: number };
    orientation: number;
    moving: unknown;
    entities: Record<string, { sceneId: string; position: number[] }>;
  };
}

export interface ChatLine {
  id: string;
  mine: boolean;
  name: string;
  text: string;
}

export interface ChatView {
  /** `failed`: the engine refused to start it — the agent was busy, or no longer beside you. */
  status: 'connecting' | 'open' | 'ended' | 'failed';
  partnerName: string;
  lines: ChatLine[];
  partnerTyping: boolean;
}

/**
 * The human in the agentic world: a body, and a voice.
 *
 * The body is a `Player` with a `human` token, joined once and kept where `draft.player` stands by
 * the same `syncBodies` input the agents' bodies use, so the engine knows who is close enough to
 * talk to. The voice is the engine's original human path — `startConversation`, then a message
 * row plus `finishSendingMessage` per line — which an agent answers exactly as it answers another
 * agent: its turn comes when the other side spoke last (`Agent.tick`), and its prompt reads every
 * line from the store.
 *
 * Called by the host around the agentic step, beside `BodyBridge`.
 */
export class HumanPlayer {
  private sentBody?: string;
  private joinSentAt?: number;
  private talk?: {
    self: GameId<'players'>;
    partner: GameId<'players'>;
    partnerName: string;
    sentAt: number;
    conversationId?: string;
  };
  /** Conversations already asked to end, so a stray one is left once rather than every frame. */
  private leaving = new Set<string>();

  constructor(
    private runtime: AgenticRuntime,
    private world: HumanGround,
    private identity: HumanIdentity = DEFAULT_IDENTITY,
    private uuid: () => string = () => crypto.randomUUID(),
  ) {}

  /** Join if absent, and carry the body in if it moved. Call before `runtime.advance`. */
  syncIn() {
    const state = this.world.inspect();
    const me = this.me();
    if (!me) {
      // A join lands on the next tick. Only once a tick has run and still found no body — a
      // refused join, or `HUMAN_IDLE_TOO_LONG` having removed it — is it worth sending again.
      if (this.joinSentAt !== undefined && this.runtime.time <= this.joinSentAt) return;
      this.joinSentAt = this.runtime.time;
      this.sentBody = undefined;
      this.runtime.send('join', {
        name: this.identity.name,
        character: this.identity.character,
        description: this.identity.description,
        tokenIdentifier: HUMAN_SOURCE_ID,
        scene: state.sceneId,
        position: { x: state.player.x, y: state.player.y },
        sourceId: HUMAN_SOURCE_ID,
      });
      return;
    }
    const body = {
      sourceId: HUMAN_SOURCE_ID,
      scene: state.sceneId,
      x: state.player.x,
      y: state.player.y,
      walking: state.moving !== null,
      facing: FACING[state.orientation] ?? FACING[90],
    };
    const fingerprint = JSON.stringify(body);
    if (fingerprint !== this.sentBody) {
      this.sentBody = fingerprint;
      this.runtime.send('syncBodies', { bodies: [body] });
    }

    // A conversation nobody is showing is one the human cannot answer in. Leave it rather than
    // keep an agent talking to nobody until `MAX_CONVERSATION_DURATION`.
    this.track();
    const conversation = this.conversation();
    if (
      conversation &&
      conversation.id !== this.talk?.conversationId &&
      !this.leaving.has(conversation.id)
    ) {
      this.leaving.add(conversation.id);
      this.runtime.send('leaveConversation', { playerId: me.id, conversationId: conversation.id });
    }
  }

  /** The agent standing next to the player, by authored id: who E would talk to. */
  adjacentAgent(): string | undefined {
    const state = this.world.inspect();
    const game = this.runtime.game;
    for (const agent of game.world.sortedAgents()) {
      const id = game.world.players.get(agent.playerId)?.sourceId;
      const entity = id !== undefined ? state.entities[id] : undefined;
      if (!entity || entity.sceneId !== state.sceneId) continue;
      const dx = Math.abs(entity.position[0] - state.player.x);
      const dy = Math.abs(entity.position[1] - state.player.y);
      if (dx + dy === 1) return id;
    }
    return undefined;
  }

  /**
   * Whether the entity with this authored id has an agent to talk to. An NPC authored in both
   * the story and the world file does: the story gives it a body and dialogue, the world file a
   * mind, and this is what the dialogue's chat button asks.
   */
  canTalkTo(sourceId: string): boolean {
    const game = this.runtime.game;
    return game.world
      .sortedAgents()
      .some((agent) => game.world.players.get(agent.playerId)?.sourceId === sourceId);
  }

  /** Ask to talk to the agent with this authored id. The answer shows up in `view()`. */
  talkTo(sourceId: string): boolean {
    // Where the player stands now, not as of the last frame: the engine refuses at range.
    this.syncIn();
    const me = this.me();
    const game = this.runtime.game;
    const partner = game.world.sortedPlayers().find((p) => p.sourceId === sourceId);
    if (!me || !partner) return false;
    this.talk = {
      self: me.id,
      partner: partner.id,
      partnerName: game.playerDescriptions.get(partner.id)?.name ?? sourceId,
      sentAt: this.runtime.time,
    };
    this.runtime.send('startConversation', { playerId: me.id, invitee: partner.id });
    return true;
  }

  /** Say one line. Refused unless the conversation is open. */
  async say(text: string): Promise<boolean> {
    this.track();
    const talk = this.talk;
    const conversation = this.conversation();
    const line = text.trim();
    if (!line || !talk || !conversation || conversation.id !== talk.conversationId) return false;
    // Game time on both stamps, as an agent's line has (docs/13 §3.5): `timestamp` becomes
    // `lastMessage.timestamp`, which `Agent.tick` subtracts from game-time `now`.
    const now = this.runtime.time;
    await this.runtime.store.insertMessage({
      conversationId: conversation.id,
      messageUuid: this.uuid(),
      author: talk.self,
      text: line,
      createdAt: now,
    });
    this.runtime.send('finishSendingMessage', {
      playerId: talk.self,
      conversationId: conversation.id,
      timestamp: now,
    });
    return true;
  }

  /** Stop talking. Ends the conversation for both sides, as either side leaving always has. */
  leave() {
    this.track();
    const talk = this.talk;
    const conversation = this.conversation();
    if (talk && conversation && conversation.id === talk.conversationId) {
      this.leaving.add(conversation.id);
      this.runtime.send('leaveConversation', {
        playerId: talk.self,
        conversationId: conversation.id,
      });
    }
    // A request still in flight is dropped too: if it does start, `syncIn` leaves it.
    this.talk = undefined;
  }

  async view(): Promise<ChatView | undefined> {
    this.track();
    const talk = this.talk;
    if (!talk) return undefined;
    const conversation = this.conversation();
    const open = !!conversation && conversation.id === talk.conversationId;
    const status: ChatView['status'] = open
      ? 'open'
      : talk.conversationId
        ? 'ended'
        : // The request is applied on the tick after it was sent; past that, no conversation
          // means the engine refused it.
          this.runtime.time > talk.sentAt
          ? 'failed'
          : 'connecting';
    const messages = talk.conversationId
      ? await this.runtime.store.listMessages(talk.conversationId)
      : [];
    return {
      status,
      partnerName: talk.partnerName,
      lines: messages.map((message) => {
        const mine = message.author === talk.self;
        return {
          id: message.messageUuid,
          mine,
          name: mine ? this.identity.name : talk.partnerName,
          text: message.text,
        };
      }),
      partnerTyping: open && conversation?.isTyping?.playerId === talk.partner,
    };
  }

  private me() {
    return this.runtime.game.world.sortedPlayers().find((p) => p.sourceId === HUMAN_SOURCE_ID);
  }

  private conversation() {
    const me = this.me();
    return me ? this.runtime.game.world.playerConversation(me) : undefined;
  }

  /** Bind a requested conversation to the one the engine started for it. */
  private track() {
    const talk = this.talk;
    const conversation = this.conversation();
    if (
      talk &&
      !talk.conversationId &&
      conversation?.participants.has(talk.partner) &&
      !this.leaving.has(conversation.id)
    ) {
      talk.conversationId = conversation.id;
    }
  }
}

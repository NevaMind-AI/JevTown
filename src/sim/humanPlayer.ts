import type { GameId } from '../../engine/aiTown/ids';
import { HumanExchange } from '../../agent/interact';
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
 * A fixed actor (tier b) is talked to differently, because it is not a `Player` (`08` §7 D3): a
 * `HumanExchange`, the same turn-taking an agent has with it, one reply per line the human types.
 * The runtime's `engage` lock keeps it to one exchange at a time, human or agent.
 *
 * Called by the host around the agentic step, beside `BodyBridge`.
 */
/** A mobile agent, spoken to through the engine's `Conversation`. */
interface ConversationTalk {
  kind: 'conversation';
  self: GameId<'players'>;
  partner: GameId<'players'>;
  partnerName: string;
  sentAt: number;
  conversationId?: string;
}

/** A fixed actor, spoken to through a `HumanExchange` that answers each line as it comes. */
interface ExchangeTalk {
  kind: 'exchange';
  entityId: string;
  partnerName: string;
  exchange?: HumanExchange;
  failed?: boolean;
  typing: boolean;
}

/** Who can be talked to, by authored id. */
type Talker =
  | { kind: 'agent'; playerId: GameId<'players'>; name: string }
  | { kind: 'fixed'; entityId: string; name: string };

export class HumanPlayer {
  private sentBody?: string;
  private joinSentAt?: number;
  private talk?: ConversationTalk | ExchangeTalk;
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
    const shown = this.talk?.kind === 'conversation' ? this.talk.conversationId : undefined;
    if (conversation && conversation.id !== shown && !this.leaving.has(conversation.id)) {
      this.leaving.add(conversation.id);
      this.runtime.send('leaveConversation', { playerId: me.id, conversationId: conversation.id });
    }
  }

  /** Who stands next to the player and can be talked to, by authored id: who E would talk to. */
  adjacentTalker(): string | undefined {
    const state = this.world.inspect();
    for (const id of this.talkers().keys()) {
      const entity = state.entities[id];
      if (!entity || entity.sceneId !== state.sceneId) continue;
      const dx = Math.abs(entity.position[0] - state.player.x);
      const dy = Math.abs(entity.position[1] - state.player.y);
      if (dx + dy === 1) return id;
    }
    return undefined;
  }

  /**
   * Whether the entity with this authored id has a mind to talk to: a mobile agent or a fixed
   * actor. An NPC authored in both the story and the world file does — the story gives it a body
   * and dialogue, the world file a mind — and this is what the dialogue's chat button asks.
   */
  canTalkTo(sourceId: string): boolean {
    return this.talkers().has(sourceId);
  }

  /** Ask to talk to whoever has this authored id. The answer shows up in `view()`. */
  talkTo(sourceId: string): boolean {
    const talker = this.talkers().get(sourceId);
    if (!talker) return false;
    // Where the player stands now, not as of the last frame: the engine refuses at range.
    this.syncIn();
    const me = this.me();
    if (!me) return false;
    if (talker.kind === 'agent') {
      this.talk = {
        kind: 'conversation',
        self: me.id,
        partner: talker.playerId,
        partnerName: talker.name,
        sentAt: this.runtime.time,
      };
      this.runtime.send('startConversation', { playerId: me.id, invitee: talker.playerId });
      return true;
    }
    const talk: ExchangeTalk = {
      kind: 'exchange',
      entityId: talker.entityId,
      partnerName: talker.name,
      typing: false,
    };
    this.talk = talk;
    // One exchange at a time: an agent mid-exchange with it, and the human has to wait.
    if (!this.runtime.engage(talker.entityId)) {
      talk.failed = true;
      return true;
    }
    HumanExchange.open(this.runtime.context, talker.entityId, {
      id: me.id,
      name: this.identity.name,
    }).then(
      (exchange) => {
        if (this.talk === talk) talk.exchange = exchange;
        // Left before it opened: nothing was said, so there is nothing to conclude.
        else this.runtime.release(talker.entityId);
      },
      (error) => {
        console.error('Could not open the exchange:', error);
        talk.failed = true;
        this.runtime.release(talker.entityId);
      },
    );
    return true;
  }

  /** Say one line. Refused unless the conversation is open and it is the human's turn. */
  async say(text: string): Promise<boolean> {
    const line = text.trim();
    const talk = this.talk;
    if (!line || !talk) return false;
    if (talk.kind === 'exchange') {
      if (!talk.exchange || talk.typing) return false;
      talk.typing = true;
      // The reply is awaited in the background: the human's line is visible at once, and the
      // chat shows the fixed actor answering until it has.
      talk.exchange
        .reply(line)
        .catch((error) => console.error('The fixed actor could not answer:', error))
        .finally(() => {
          talk.typing = false;
        });
      return true;
    }
    this.track();
    const conversation = this.conversation();
    if (!conversation || conversation.id !== talk.conversationId) return false;
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
    const talk = this.talk;
    this.talk = undefined;
    if (!talk) return;
    if (talk.kind === 'exchange') {
      const { exchange, entityId } = talk;
      if (!exchange) return; // still opening, or refused: `talkTo` releases it
      // The fixed actor writes what the exchange left it with. It stays engaged until that write
      // is in, so an agent arriving meanwhile cannot race it.
      exchange
        .conclude()
        .catch((error) => console.error('The fixed actor could not write its state:', error))
        .finally(() => this.runtime.release(entityId));
      return;
    }
    const conversation = this.conversation();
    if (
      conversation &&
      (conversation.id === talk.conversationId ||
        (!talk.conversationId && conversation.participants.has(talk.partner)))
    ) {
      this.leaving.add(conversation.id);
      this.runtime.send('leaveConversation', {
        playerId: talk.self,
        conversationId: conversation.id,
      });
    }
    // A request still in flight is dropped too: if it does start, `syncIn` leaves it.
  }

  async view(): Promise<ChatView | undefined> {
    this.track();
    const talk = this.talk;
    if (!talk) return undefined;
    if (talk.kind === 'exchange') {
      return {
        status: talk.failed ? 'failed' : talk.exchange ? 'open' : 'connecting',
        partnerName: talk.partnerName,
        lines: (talk.exchange?.lines ?? []).map((line, i) => ({
          id: String(i),
          mine: line.speaker === 'actor',
          name: line.name,
          text: line.text,
        })),
        partnerTyping: talk.typing,
      };
    }
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

  /**
   * Everyone with a mind, by authored id: mobile agents and fixed actors. A prop (tier c) is not
   * here — it is acted on, never spoken to (docs/05 §3).
   */
  private talkers(): Map<string, Talker> {
    const game = this.runtime.game;
    const talkers = new Map<string, Talker>();
    for (const agent of game.world.sortedAgents()) {
      const player = game.world.players.get(agent.playerId);
      if (player?.sourceId === undefined) continue;
      talkers.set(player.sourceId, {
        kind: 'agent',
        playerId: player.id,
        name: game.playerDescriptions.get(player.id)?.name ?? player.sourceId,
      });
    }
    for (const entity of game.world.sortedEntities()) {
      if (entity.kind !== 'actor' || entity.sourceId === undefined) continue;
      talkers.set(entity.sourceId, {
        kind: 'fixed',
        entityId: entity.id,
        name: game.entityDescriptions.get(entity.id)?.name ?? entity.sourceId,
      });
    }
    return talkers;
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
    if (talk?.kind !== 'conversation') return;
    const conversation = this.conversation();
    if (
      !talk.conversationId &&
      conversation?.participants.has(talk.partner) &&
      !this.leaving.has(conversation.id)
    ) {
      talk.conversationId = conversation.id;
    }
  }
}

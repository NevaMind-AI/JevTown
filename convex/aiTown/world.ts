import { ObjectType, v } from 'convex/values';
import { Conversation, serializedConversation } from './conversation';
import { Player, serializedPlayer } from './player';
import { Agent, serializedAgent } from './agent';
import { Entity, serializedEntity } from './entity';
import { GameId, compareGameIds, parseGameId, playerId } from './ids';
import { parseMap } from '../util/object';
import { Rng, serializedRng } from '../util/rng';

// Worlds created before docs/08 A0 carry no seed. They get this one, so they stay deterministic
// from the point they're next loaded even though their history isn't reproducible.
const LEGACY_SEED = 0;

export const historicalLocations = v.array(
  v.object({
    playerId,
    location: v.bytes(),
  }),
);

export const serializedWorld = {
  nextId: v.number(),

  // Seeds the simulation PRNG. Immutable once the world is created; docs/05 §2 sources it from
  // `meta.seed` in the world file, which arrives with A4. Optional so existing worlds load.
  seed: v.optional(v.number()),
  // The PRNG's current state, advanced by the engine and committed with every step.
  rng: v.optional(v.object(serializedRng)),
  conversations: v.array(v.object(serializedConversation)),
  players: v.array(v.object(serializedPlayer)),
  agents: v.array(v.object(serializedAgent)),
  // Fixed entities: tiers (b) and (c). Optional so worlds created before A4 load.
  entities: v.optional(v.array(v.object(serializedEntity))),
  // Points at the current common-knowledge row in `entityState`, exactly as `stateVersion` points
  // at an entity's (docs/05 §5.3, §8). The prose itself is never in the world document; this
  // integer is the change signal, and it is the only thing common knowledge costs per step.
  commonKnowledgeVersion: v.optional(v.number()),
  historicalLocations: v.optional(historicalLocations),
};
export type SerializedWorld = ObjectType<typeof serializedWorld>;

export class World {
  nextId: number;
  seed: number;
  rng: Rng;
  conversations: Map<GameId<'conversations'>, Conversation>;
  players: Map<GameId<'players'>, Player>;
  agents: Map<GameId<'agents'>, Agent>;
  entities: Map<GameId<'entities'>, Entity>;
  commonKnowledgeVersion: number;
  historicalLocations?: Map<GameId<'players'>, ArrayBuffer>;

  constructor(serialized: SerializedWorld) {
    const { nextId, historicalLocations } = serialized;

    this.nextId = nextId;
    this.seed = serialized.seed ?? LEGACY_SEED;
    this.rng = serialized.rng ? new Rng(serialized.rng) : Rng.fromSeed(this.seed);
    this.conversations = parseMap(serialized.conversations, Conversation, (c) => c.id);
    this.players = parseMap(serialized.players, Player, (p) => p.id);
    this.agents = parseMap(serialized.agents, Agent, (a) => a.id);
    this.entities = parseMap(serialized.entities ?? [], Entity, (e) => e.id);
    this.commonKnowledgeVersion = serialized.commonKnowledgeVersion ?? 0;

    if (historicalLocations) {
      this.historicalLocations = new Map();
      for (const { playerId, location } of historicalLocations) {
        this.historicalLocations.set(parseGameId('players', playerId), location);
      }
    }
  }

  playerConversation(player: Player): Conversation | undefined {
    return this.sortedConversations().find((c) => c.participants.has(player.id));
  }

  // Iterate in id order everywhere the order is observable, rather than in `Map` insertion order.
  sortedPlayers(): Player[] {
    return [...this.players.values()].sort((a, b) => compareGameIds(a.id, b.id));
  }

  sortedAgents(): Agent[] {
    return [...this.agents.values()].sort((a, b) => compareGameIds(a.id, b.id));
  }

  sortedConversations(): Conversation[] {
    return [...this.conversations.values()].sort((a, b) => compareGameIds(a.id, b.id));
  }

  sortedEntities(): Entity[] {
    return [...this.entities.values()].sort((a, b) => compareGameIds(a.id, b.id));
  }

  serialize(): SerializedWorld {
    return {
      nextId: this.nextId,
      seed: this.seed,
      rng: this.rng.serialize(),
      // Serialized in id order too, so the stored document is canonical and `parseMap`'s insertion
      // order can't carry history forward into behaviour.
      conversations: this.sortedConversations().map((c) => c.serialize()),
      players: this.sortedPlayers().map((p) => p.serialize()),
      agents: this.sortedAgents().map((a) => a.serialize()),
      entities: this.sortedEntities().map((e) => e.serialize()),
      commonKnowledgeVersion: this.commonKnowledgeVersion,
      historicalLocations:
        this.historicalLocations &&
        [...this.historicalLocations.entries()].map(([playerId, location]) => ({
          playerId,
          location,
        })),
    };
  }
}

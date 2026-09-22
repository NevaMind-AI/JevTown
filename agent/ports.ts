import { GameId } from '../engine/aiTown/ids';
import { SerializedPlayer } from '../engine/aiTown/player';
import { SerializedAgent } from '../engine/aiTown/agent';
import { SerializedConversation } from '../engine/aiTown/conversation';
import { SerializedEntity } from '../engine/aiTown/entity';
import { SerializedPlayerDescription } from '../engine/aiTown/playerDescription';
import { SerializedAgentDescription } from '../engine/aiTown/agentDescription';
import { SerializedEntityDescription } from '../engine/aiTown/entityDescription';
import { InputArgs, InputNames } from '../engine/aiTown/inputs';

/**
 * What the agent layer needs from the world around it.
 *
 * Every function in `agent/` used to take a Convex `ActionCtx` and reach for `ctx.runQuery`,
 * `ctx.db` and `ctx.vectorSearch`. That is the coupling this file replaces: three small interfaces
 * the layer is written against, and which a host implements however it likes. Convex implemented
 * them with tables; after docs/11 §1 the browser implements `WorldReader` straight off the
 * in-memory `Game` and `AgentStore` against IndexedDB plus the backend of §6.
 *
 * The split between the two readers is not arbitrary. `WorldReader` is synchronous because the
 * simulation is in memory by definition — whoever runs the agent layer is holding the `Game`.
 * `AgentStore` is asynchronous because it is the durable tier, and in phase 5 it is across a
 * network.
 */

// ---------------------------------------------------------------- the world, in memory

/** World-level prose from the world file (docs/05 §2, §7). Static for the life of a world. */
export interface WorldDescription {
  worldRules: string;
  godPersona?: string;
  /**
   * The rules no actor ever sees. Under frontend authority these travel to the browser, so
   * "hidden from actors" is a prompt-construction discipline rather than a transport boundary
   * (docs/11 §8). Nothing in this layer may put them in an actor's prompt.
   */
  godHiddenRules?: string;
  maxTranscriptTurns?: number;
  godGateEnabled?: boolean;
}

export interface WorldReader {
  readonly worldId: string;

  players(): SerializedPlayer[];
  agents(): SerializedAgent[];
  conversations(): SerializedConversation[];
  entities(): SerializedEntity[];

  player(playerId: string): SerializedPlayer | undefined;
  conversation(conversationId: string): SerializedConversation | undefined;
  entity(entityId: string): SerializedEntity | undefined;
  agentForPlayer(playerId: string): SerializedAgent | undefined;

  playerDescription(playerId: string): SerializedPlayerDescription | undefined;
  agentDescription(agentId: string): SerializedAgentDescription | undefined;
  entityDescription(entityId: string): SerializedEntityDescription | undefined;
  worldDescription(): WorldDescription;
}

// ---------------------------------------------------------------- the durable tier

export type MemoryData =
  | { type: 'relationship'; playerId: GameId<'players'> }
  | {
      type: 'conversation';
      conversationId: GameId<'conversations'>;
      playerIds: GameId<'players'>[];
    }
  | { type: 'reflection'; relatedMemoryIds: string[] };

export interface StoredMemory {
  id: string;
  playerId: GameId<'players'>;
  description: string;
  importance: number;
  lastAccess: number;
  createdAt: number;
  data: MemoryData;
  /**
   * Kept on the row. Convex forced a second `memoryEmbeddings` table because its vector index was
   * a table-level thing; nothing else did, and docs/11 §6.2 collapses the two back together.
   */
  embedding: number[];
}

export interface StoredMessage {
  conversationId: GameId<'conversations'>;
  messageUuid: string;
  author: GameId<'players'>;
  text: string;
  createdAt: number;
}

/** A conversation that has ended. Live ones are in the world document. */
export interface ArchivedConversation {
  id: GameId<'conversations'>;
  creator: GameId<'players'>;
  created: number;
  ended: number;
  numMessages: number;
  participants: GameId<'players'>[];
}

export interface TranscriptRow {
  seq: number;
  role: 'event' | 'verdict';
  content: string;
  batchId?: string;
  inputNumber?: number;
  /** The high-water mark this batch consumed, so nothing is ever judged twice (docs/05 §7.4). */
  throughInputNumber?: number;
}

export interface AuditRow {
  entityId: string;
  field: 'state' | 'memory' | 'physics';
  source: 'self' | 'interaction' | 'god';
  before: string;
  after: string;
  reason: string;
  inputNumber: number;
  batchId?: string;
  tags?: unknown;
}

export interface InteractionTurn {
  interactionId: string;
  actorId: string;
  targetId: string;
  speaker: 'actor' | 'target';
  text: string;
}

export interface ScoredMemory {
  memory: StoredMemory;
  /** Similarity against the search vector. Only its rank within a result set is meaningful. */
  score: number;
}

export interface AgentStore {
  // -- prose (docs/05 §8)
  readEntityState(entityId: string): Promise<string | undefined>;

  // -- dialogue
  listMessages(conversationId: string): Promise<StoredMessage[]>;
  insertMessage(message: StoredMessage): Promise<void>;

  // -- memory (docs/05 §5.2)
  insertMemory(memory: Omit<StoredMemory, 'id' | 'createdAt'>): Promise<void>;
  /**
   * Nearest neighbours by embedding, over-fetched. Ranking by relevance, recency and importance
   * is the agent layer's business and stays in `memory.ts`; this only has to find candidates.
   */
  searchMemories(playerId: string, embedding: number[], limit: number): Promise<ScoredMemory[]>;
  recentMemories(playerId: string, limit: number): Promise<StoredMemory[]>;
  lastReflectionAt(playerId: string): Promise<number | undefined>;
  touchMemories(memoryIds: string[], at: number): Promise<void>;

  // -- conversation history
  archivedConversation(conversationId: string): Promise<ArchivedConversation | undefined>;
  /** The name of a player who may have left the world since. */
  playerName(playerId: string): Promise<string | undefined>;
  otherParticipant(
    playerId: string,
    conversationId: string,
  ): Promise<GameId<'players'> | undefined>;
  lastConversationBetween(
    playerId: string,
    otherPlayerId: string,
  ): Promise<ArchivedConversation | undefined>;

  // -- the god (docs/05 §7)
  godTranscript(limit: number): Promise<TranscriptRow[]>;
  appendGodTranscript(row: Omit<TranscriptRow, 'seq'>): Promise<void>;
  auditsAfter(inputNumber: number): Promise<AuditRow[]>;

  // -- interaction (docs/05 §6.2)
  recordInteractionTurn(turn: InteractionTurn): Promise<void>;

  // -- embeddings cache
  cachedEmbeddings(textHashes: string[]): Promise<{ index: number; embedding: number[] }[]>;
  cacheEmbeddings(entries: { textHash: string; embedding: number[] }[]): Promise<void>;
}

// ---------------------------------------------------------------- back into the simulation

/**
 * How a model result re-enters the world.
 *
 * Every outcome of a model call becomes an engine input rather than a direct write (docs/05 §9,
 * docs/11 §6.1), which is what keeps a run replayable without ever calling a model again.
 */
export interface InputQueue {
  send<Name extends InputNames>(name: Name, args: InputArgs<Name>): Promise<unknown>;
}

/** The three handed to every operation, in place of a Convex `ActionCtx`. */
export interface AgentContext {
  world: WorldReader;
  store: AgentStore;
  inputs: InputQueue;
}

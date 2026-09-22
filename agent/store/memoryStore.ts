import {
  AgentStore,
  ArchivedConversation,
  AuditRow,
  InteractionTurn,
  ScoredMemory,
  StoredMemory,
  StoredMessage,
  TranscriptRow,
} from '../ports';
import { GameId } from '../../engine/aiTown/ids';

/**
 * `AgentStore` in memory, and serializable.
 *
 * Everything the durable tier of docs/05 §8 holds lives in plain maps here. That is enough for a
 * single tab running a single world, and it is what phase 5 replaces with the Postgres of
 * docs/11 §6 behind the same interface.
 *
 * Serializable is the point, not a convenience. Prose state, memory and the god's transcript are
 * as much a part of a saved world as positions are — a world restored without its memories is a
 * different world — so `snapshot()` and `restore()` exist so the store rides along in whatever
 * saves the simulation. Nothing in here keeps a handle, a promise or a class instance for exactly
 * that reason: a snapshot has to survive `JSON.stringify`.
 */

export interface AgentStoreSnapshot {
  format: 'agent-store-1';
  entityState: [string, { version: number; state: string }[]][];
  blobs: [string, string][];
  messages: [string, StoredMessage[]][];
  memories: StoredMemory[];
  conversations: ArchivedConversation[];
  playerNames: [string, string][];
  transcript: TranscriptRow[];
  audits: AuditRow[];
  turns: (InteractionTurn & { seq: number })[];
  embeddings: [string, number[]][];
  nextMemoryId: number;
}

/**
 * Cosine similarity.
 *
 * Plan D4: memory search runs here rather than in a vector index. One caller, a few hundred
 * vectors per world, and the browser is already holding them — pgvector buys nothing until a
 * world's memory count makes this slow, and it costs a second store to keep in sync.
 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  const norm = Math.sqrt(aa) * Math.sqrt(bb);
  return norm === 0 ? 0 : dot / norm;
}

export class InMemoryAgentStore implements AgentStore {
  /** Append-only per entity, ordered by the version the input handler allocated. */
  private entityState = new Map<string, { version: number; state: string }[]>();
  /** Content-addressed and append-only, so it dedupes naturally (docs/05 §9.5). */
  private blobs = new Map<string, string>();
  private messages = new Map<string, StoredMessage[]>();
  private memories: StoredMemory[] = [];
  private conversations = new Map<string, ArchivedConversation>();
  /** Names of players who have since left the world, so an old conversation still reads. */
  private playerNames = new Map<string, string>();
  private transcript: TranscriptRow[] = [];
  private audits: AuditRow[] = [];
  private turns: (InteractionTurn & { seq: number })[] = [];
  private embeddings = new Map<string, number[]>();
  private nextMemoryId = 1;

  // ---------------------------------------------------------------- prose

  async readEntityState(entityId: string): Promise<string | undefined> {
    return this.readEntityStateSync(entityId);
  }

  /**
   * The same read, without the promise.
   *
   * `AgentStore` is asynchronous because phase 5 puts it across a network. This implementation is
   * not, and the runtime needs the previous document inline while it drains a tick — an audit row
   * records what a write replaced, and awaiting mid-drain would let another tick interleave.
   */
  readEntityStateSync(entityId: string): string | undefined {
    const versions = this.entityState.get(entityId);
    return versions?.length ? versions[versions.length - 1].state : undefined;
  }

  /** Called by the runtime as it drains the engine's prose queue. Not part of `AgentStore`. */
  appendEntityState(entityId: string, version: number, state: string) {
    const versions = this.entityState.get(entityId) ?? [];
    // The handler allocates versions, so a replayed write lands on a number already here.
    if (versions.some((row) => row.version === version)) return;
    versions.push({ version, state });
    versions.sort((a, b) => a.version - b.version);
    this.entityState.set(entityId, versions);
  }

  writeBlob(hash: string, content: string) {
    if (!this.blobs.has(hash)) this.blobs.set(hash, content);
  }

  readBlob(hash: string): string | undefined {
    return this.blobs.get(hash);
  }

  // ---------------------------------------------------------------- dialogue

  async listMessages(conversationId: string): Promise<StoredMessage[]> {
    return [...(this.messages.get(conversationId) ?? [])];
  }

  async insertMessage(message: StoredMessage): Promise<void> {
    const list = this.messages.get(message.conversationId) ?? [];
    // `messageUuid` is the idempotency key, so a replayed batch is a no-op (docs/11 §6.2).
    if (list.some((m) => m.messageUuid === message.messageUuid)) return;
    list.push(message);
    this.messages.set(message.conversationId, list);
  }

  // ---------------------------------------------------------------- memory

  async insertMemory(memory: Omit<StoredMemory, 'id' | 'createdAt'>): Promise<void> {
    this.memories.push({
      ...memory,
      id: `m:${this.nextMemoryId++}`,
      createdAt: Date.now(),
    });
  }

  async searchMemories(
    playerId: string,
    embedding: number[],
    limit: number,
  ): Promise<ScoredMemory[]> {
    return this.memories
      .filter((memory) => memory.playerId === playerId && memory.embedding.length > 0)
      .map((memory) => ({ memory, score: cosine(embedding, memory.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async recentMemories(playerId: string, limit: number): Promise<StoredMemory[]> {
    return this.memories
      .filter((memory) => memory.playerId === playerId)
      .slice(-limit)
      .reverse();
  }

  async lastReflectionAt(playerId: string): Promise<number | undefined> {
    let latest: number | undefined;
    for (const memory of this.memories) {
      if (memory.playerId !== playerId || memory.data.type !== 'reflection') continue;
      if (latest === undefined || memory.createdAt > latest) latest = memory.createdAt;
    }
    return latest;
  }

  async touchMemories(memoryIds: string[], at: number): Promise<void> {
    const wanted = new Set(memoryIds);
    for (const memory of this.memories) {
      if (wanted.has(memory.id)) memory.lastAccess = at;
    }
  }

  // ---------------------------------------------------------------- conversation history

  async archivedConversation(conversationId: string): Promise<ArchivedConversation | undefined> {
    return this.conversations.get(conversationId);
  }

  /** Called by the runtime when a conversation leaves the world document. */
  archiveConversation(conversation: ArchivedConversation) {
    if (!this.conversations.has(conversation.id)) {
      this.conversations.set(conversation.id, conversation);
    }
  }

  /** Called by the runtime when a player leaves, so its name outlives it. */
  rememberPlayerName(playerId: string, name: string) {
    this.playerNames.set(playerId, name);
  }

  async playerName(playerId: string): Promise<string | undefined> {
    return this.playerNames.get(playerId);
  }

  async otherParticipant(
    playerId: string,
    conversationId: string,
  ): Promise<GameId<'players'> | undefined> {
    const conversation = this.conversations.get(conversationId);
    return conversation?.participants.find((id) => id !== playerId);
  }

  /**
   * The most recent finished conversation between two players.
   *
   * docs/11 §6.4 drops `participatedTogether`: it was a pure projection of
   * `conversations.participants` that Convex made us materialise. Derived here instead, and worth
   * materialising again only with a measurement to point at.
   */
  async lastConversationBetween(
    playerId: string,
    otherPlayerId: string,
  ): Promise<ArchivedConversation | undefined> {
    let best: ArchivedConversation | undefined;
    for (const conversation of this.conversations.values()) {
      if (
        !conversation.participants.includes(playerId as GameId<'players'>) ||
        !conversation.participants.includes(otherPlayerId as GameId<'players'>)
      ) {
        continue;
      }
      if (!best || conversation.ended > best.ended) best = conversation;
    }
    return best;
  }

  // ---------------------------------------------------------------- the god

  async godTranscript(limit: number): Promise<TranscriptRow[]> {
    return this.transcript.slice(-limit).reverse();
  }

  async appendGodTranscript(row: Omit<TranscriptRow, 'seq'>): Promise<void> {
    const seq = (this.transcript[this.transcript.length - 1]?.seq ?? 0) + 1;
    this.transcript.push({ ...row, seq });
  }

  async auditsAfter(inputNumber: number): Promise<AuditRow[]> {
    return this.audits.filter((audit) => audit.inputNumber > inputNumber);
  }

  /** Called by the runtime as it drains the engine's prose queue. */
  appendAudit(audit: AuditRow) {
    this.audits.push(audit);
  }

  // ---------------------------------------------------------------- interaction

  async recordInteractionTurn(turn: InteractionTurn): Promise<void> {
    const seq = this.turns.filter((t) => t.interactionId === turn.interactionId).length;
    this.turns.push({ ...turn, seq });
  }

  /** The last exchange an entity took part in, oldest turn first. For the entity panel. */
  recentInteraction(entityId: string): (InteractionTurn & { seq: number })[] {
    const last = [...this.turns].reverse().find((t) => t.targetId === entityId);
    if (!last) return [];
    return this.turns
      .filter((t) => t.interactionId === last.interactionId)
      .sort((a, b) => a.seq - b.seq);
  }

  // ---------------------------------------------------------------- embeddings cache

  async cachedEmbeddings(textHashes: string[]): Promise<{ index: number; embedding: number[] }[]> {
    const out: { index: number; embedding: number[] }[] = [];
    textHashes.forEach((hash, index) => {
      const embedding = this.embeddings.get(hash);
      if (embedding) out.push({ index, embedding });
    });
    return out;
  }

  async cacheEmbeddings(entries: { textHash: string; embedding: number[] }[]): Promise<void> {
    for (const entry of entries) this.embeddings.set(entry.textHash, entry.embedding);
  }

  // ---------------------------------------------------------------- persistence

  snapshot(): AgentStoreSnapshot {
    return structuredClone({
      format: 'agent-store-1' as const,
      entityState: [...this.entityState.entries()],
      blobs: [...this.blobs.entries()],
      messages: [...this.messages.entries()],
      memories: this.memories,
      conversations: [...this.conversations.values()],
      playerNames: [...this.playerNames.entries()],
      transcript: this.transcript,
      audits: this.audits,
      turns: this.turns,
      embeddings: [...this.embeddings.entries()],
      nextMemoryId: this.nextMemoryId,
    });
  }

  static restore(snapshot: AgentStoreSnapshot): InMemoryAgentStore {
    const store = new InMemoryAgentStore();
    store.restoreFrom(snapshot);
    return store;
  }

  /** Replace this store's contents in place, for a runtime that already holds a reference. */
  restoreFrom(snapshot: AgentStoreSnapshot) {
    if (snapshot?.format !== 'agent-store-1') {
      throw new Error('Unsupported agent store snapshot');
    }
    const copy = structuredClone(snapshot);
    this.entityState = new Map(copy.entityState);
    this.blobs = new Map(copy.blobs);
    this.messages = new Map(copy.messages);
    this.memories = copy.memories;
    this.conversations = new Map(copy.conversations.map((c) => [c.id, c]));
    this.playerNames = new Map(copy.playerNames);
    this.transcript = copy.transcript;
    this.audits = copy.audits;
    this.turns = copy.turns;
    this.embeddings = new Map(copy.embeddings);
    this.nextMemoryId = copy.nextMemoryId;
  }
}

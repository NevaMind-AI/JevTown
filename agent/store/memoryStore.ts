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

/**
 * One durable write, as it leaves for the backend.
 *
 * The store is append-only everywhere it matters, so "what is new since last time" is a sequence
 * number rather than a diff. World state ships whole every batch (docs/11 §7.1); these tables do
 * not, because their write rhythm is different -- prose changes on change, not every tick -- and
 * shipping the lot each time would carry documents that did not move (§7.2).
 */
export type StoreChange =
  | { seq: number; kind: 'entityState'; entityId: string; version: number; state: string }
  | { seq: number; kind: 'blob'; hash: string; content: string }
  | { seq: number; kind: 'message'; message: StoredMessage }
  | { seq: number; kind: 'memory'; memory: StoredMemory }
  | { seq: number; kind: 'conversation'; conversation: ArchivedConversation }
  | { seq: number; kind: 'playerName'; playerId: string; name: string }
  | { seq: number; kind: 'transcript'; row: TranscriptRow }
  | { seq: number; kind: 'audit'; row: AuditRow & { seq: number } }
  | { seq: number; kind: 'turn'; turn: InteractionTurn & { seq: number } }
  | { seq: number; kind: 'embedding'; textHash: string; embedding: number[] };

/** `Omit` does not distribute over a union; this does, so each variant keeps its own fields. */
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

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
  changes: StoreChange[];
  nextChangeSeq: number;
  auditSeq: number;
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
  /** Unshipped durable writes, oldest first. Pruned once the backend acknowledges them. */
  private changes: StoreChange[] = [];
  private nextChangeSeq = 1;
  private auditSeq = 0;

  private record(change: WithoutSeq<StoreChange>) {
    this.changes.push({ ...change, seq: this.nextChangeSeq++ } as StoreChange);
  }

  /** Everything written after `seq`, for the next batch. */
  changesSince(seq: number): StoreChange[] {
    return this.changes.filter((change) => change.seq > seq);
  }

  /** The sequence a batch would ship up to. */
  get changeSeq(): number {
    return this.nextChangeSeq - 1;
  }

  /** Drop what the backend has durably taken. Called only on a acknowledged batch. */
  pruneChanges(throughSeq: number) {
    this.changes = this.changes.filter((change) => change.seq > throughSeq);
  }

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
    this.record({ kind: 'entityState', entityId, version, state });
  }

  writeBlob(hash: string, content: string) {
    if (this.blobs.has(hash)) return;
    this.blobs.set(hash, content);
    this.record({ kind: 'blob', hash, content });
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
    this.record({ kind: 'message', message });
  }

  // ---------------------------------------------------------------- memory

  async insertMemory(memory: Omit<StoredMemory, 'id' | 'createdAt'>): Promise<void> {
    const stored: StoredMemory = {
      ...memory,
      id: `m:${this.nextMemoryId++}`,
      createdAt: Date.now(),
    };
    this.memories.push(stored);
    this.record({ kind: 'memory', memory: stored });
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
    if (this.conversations.has(conversation.id)) return;
    this.conversations.set(conversation.id, conversation);
    this.record({ kind: 'conversation', conversation });
  }

  /** Called by the runtime when a player leaves, so its name outlives it. */
  rememberPlayerName(playerId: string, name: string) {
    if (this.playerNames.get(playerId) === name) return;
    this.playerNames.set(playerId, name);
    this.record({ kind: 'playerName', playerId, name });
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
    const stored = { ...row, seq };
    this.transcript.push(stored);
    this.record({ kind: 'transcript', row: stored });
  }

  async auditsAfter(inputNumber: number): Promise<AuditRow[]> {
    return this.audits.filter((audit) => audit.inputNumber > inputNumber);
  }

  /** Called by the runtime as it drains the engine's prose queue. */
  appendAudit(audit: AuditRow) {
    this.audits.push(audit);
    this.record({ kind: 'audit', row: { ...audit, seq: ++this.auditSeq } });
  }

  // ---------------------------------------------------------------- interaction

  async recordInteractionTurn(turn: InteractionTurn): Promise<void> {
    const seq = this.turns.filter((t) => t.interactionId === turn.interactionId).length;
    const stored = { ...turn, seq };
    this.turns.push(stored);
    this.record({ kind: 'turn', turn: stored });
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
    for (const entry of entries) {
      if (this.embeddings.has(entry.textHash)) continue;
      this.embeddings.set(entry.textHash, entry.embedding);
      this.record({ kind: 'embedding', textHash: entry.textHash, embedding: entry.embedding });
    }
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
      changes: this.changes,
      nextChangeSeq: this.nextChangeSeq,
      auditSeq: this.auditSeq,
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
    this.changes = copy.changes ?? [];
    this.nextChangeSeq = copy.nextChangeSeq ?? 1;
    this.auditSeq = copy.auditSeq ?? 0;
  }
}

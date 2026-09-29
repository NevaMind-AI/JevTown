import type {
  BatchRequest,
  BatchResponse,
  BootstrapResponse,
  SessionResponse,
} from '../../server/protocol';
import { AgenticRuntime, AgenticRuntimeSnapshot } from './agenticRuntime';

/**
 * Shipping a world to the backend, and getting it back.
 *
 * The frontend is the authority (docs/11 §1); this is the part that makes losing the tab cost at
 * most the last unacknowledged batch rather than the whole run. Three things carry that promise,
 * and none of them is "hope the request arrives":
 *
 *   * **`idx` is ours.** Every event is numbered before it is sent, so a batch re-sent after a
 *     timeout writes the same rows and the primary key makes it a no-op (§4.2).
 *   * **Every batch carries a version chain.** `baseVersion` says what we think is stored; the
 *     backend rejects anything else. Answering a rejection by re-reading rather than by merging
 *     is what stops two histories quietly becoming one.
 *   * **Unacknowledged batches outlive the page.** They queue in the outbox and go again on the
 *     next start, which is the difference between "we lost a batch" and "we lost a session".
 *
 * A batch boundary is the only moment the world is consistent, so a batch is built from one
 * snapshot taken at one instant, and a model call in flight at that moment lands in the next one.
 */

const DEFAULT_BASE = '/worlds';

/** Where unacknowledged batches wait. IndexedDB in a browser, memory anywhere else. */
export interface BatchOutbox {
  add(batch: BatchRequest): Promise<void>;
  list(): Promise<BatchRequest[]>;
  remove(batchId: string): Promise<void>;
}

export class MemoryOutbox implements BatchOutbox {
  private batches: BatchRequest[] = [];
  async add(batch: BatchRequest) {
    this.batches.push(batch);
  }
  async list() {
    return [...this.batches];
  }
  async remove(batchId: string) {
    this.batches = this.batches.filter((batch) => batch.batchId !== batchId);
  }
}

/**
 * The browser outbox.
 *
 * IndexedDB rather than `localStorage` because a batch carries a whole world document, and
 * because this has to survive the tab closing mid-flight — which is exactly the case the
 * kill-the-tab test covers.
 */
export class IndexedDbOutbox implements BatchOutbox {
  constructor(private dbName = 'remaining-time-sync') {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('batches', { keyPath: 'batchId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) {
    const database = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = work(database.transaction('batches', mode).objectStore('batches'));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }

  async add(batch: BatchRequest) {
    await this.run('readwrite', (store) => store.put(batch));
  }
  async list() {
    return await this.run<BatchRequest[]>('readonly', (store) => store.getAll());
  }
  async remove(batchId: string) {
    await this.run('readwrite', (store) => store.delete(batchId));
  }
}

export interface SyncClientOptions {
  worldId: string;
  runtime: AgenticRuntime;
  /** Identifies this tab for the lease. Stable for the life of the page. */
  sessionId?: string;
  baseUrl?: string;
  outbox?: BatchOutbox;
  /**
   * Called when another tab has taken the lease. The world keeps running locally but nothing it
   * produces will be stored, so the honest thing is to stop pretending it is being saved.
   */
  onReadOnly?: (reason: string) => void;
  fetchImpl?: typeof fetch;
}

export class SyncClient {
  private readonly worldId: string;
  private readonly runtime: AgenticRuntime;
  private readonly baseUrl: string;
  private readonly outbox: BatchOutbox;
  private readonly onReadOnly?: (reason: string) => void;
  private readonly http: typeof fetch;

  readonly sessionId: string;
  private generation = 0;
  private storedVersion = 0;
  private shippedIdx = -1;
  private shippedChangeSeq = 0;
  private readOnly = false;
  private flushing = false;

  constructor(options: SyncClientOptions) {
    this.worldId = options.worldId;
    this.runtime = options.runtime;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.outbox = options.outbox ?? new MemoryOutbox();
    this.onReadOnly = options.onReadOnly;
    this.http = options.fetchImpl ?? fetch;
    this.sessionId = options.sessionId ?? `s:${Math.random().toString(36).slice(2)}`;
  }

  get isReadOnly() {
    return this.readOnly;
  }
  get version() {
    return this.storedVersion;
  }

  private async post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await this.http(`${this.baseUrl}/${this.worldId}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // 409 is the protocol's own refusal and carries a body worth reading. Anything else — a world
    // this token does not own, a batch over the size cap — is not an answer to the batch, and
    // reading it as one would set the stored version from a field that is not there. The caller
    // keeps the batch in the outbox.
    if (response.status !== 200 && response.status !== 409) {
      throw new Error(`Storage ${path} failed (${response.status}): ${await response.text()}`);
    }
    return { status: response.status, body: (await response.json()) as T };
  }

  /** Read a world back. Resume reads state and the store and replays nothing (docs/11 §6.1). */
  async bootstrap(): Promise<BootstrapResponse | null> {
    const response = await this.http(`${this.baseUrl}/${this.worldId}/bootstrap`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Bootstrap failed (${response.status})`);
    return (await response.json()) as BootstrapResponse;
  }

  /**
   * Take the writer lease, then re-send anything the last session did not get acknowledged.
   *
   * `steal` is the default because the common case is not two live tabs — it is the same person
   * reopening the world after the last tab went away without releasing anything. A lease that
   * needed an explicit release would make a crash look like contention forever.
   */
  async start(options: { steal?: boolean } = {}): Promise<boolean> {
    const { status, body } = await this.post<SessionResponse>('/session', {
      sessionId: this.sessionId,
      steal: options.steal ?? true,
    });
    if (status !== 200 || !body.ok) {
      this.readOnly = true;
      this.onReadOnly?.(
        body.ok === false ? `Another session holds this world (${body.holder}).` : 'Lease refused.',
      );
      return false;
    }
    this.generation = body.generation;
    this.readOnly = false;
    await this.resend();
    return true;
  }

  /** Renew the lease. Cheap, and the same call as claiming it. */
  async heartbeat(): Promise<void> {
    if (this.readOnly) return;
    const { body } = await this.post<SessionResponse>('/session', { sessionId: this.sessionId });
    if (!body.ok) this.goReadOnly(`Lost the lease to ${body.holder}.`);
  }

  /**
   * Anything the outbox still holds, oldest first.
   *
   * A batch left by an earlier page — a reload, a crash, a stretch offline — carries that page's
   * session and generation, which the lease just taken has superseded. Sent as stored, it would be
   * refused as `stale-session`, and this tab would go read-only while holding the lease
   * (docs/14 §4.5). So every batch is re-stamped with the current lease and keeps its `batchId`.
   * The other two guards still decide: a `batchId` already in the ledger answers `duplicate`, and
   * a `baseVersion` other than the stored one answers `version-conflict`, so a re-stamped batch
   * can only land exactly where it was always going to.
   *
   * An earlier page's batch describes that page's runtime, not this one, so taking it moves only
   * the stored version and leaves this runtime's own counters alone.
   *
   * Once resume is wired (docs/14 §5 step 0), this has to run before the bootstrap it restores
   * from, or the restored runtime starts a batch behind the stored version.
   */
  private async resend() {
    for (const owed of await this.outbox.list()) {
      const own = owed.sessionId === this.sessionId;
      const batch = { ...owed, sessionId: this.sessionId, generation: this.generation };
      const { body } = await this.post<BatchResponse>('/batches', batch);
      if (body.ok && own) {
        await this.acknowledge(batch, body.version, body.changeSeq);
      } else if (body.ok) {
        // A duplicate answers with the version that batch made, which may be older than what is
        // stored now; only a batch that actually landed moves the stored version.
        if (!body.duplicate) this.storedVersion = body.version;
        await this.outbox.remove(batch.batchId);
      } else if (body.reason === 'stale-session') {
        // Another tab has taken the lease since this one did. Now it really is theirs.
        this.goReadOnly('Another session took this world while we were away.');
        return;
      } else {
        // The backend is ahead of this batch, so it is already stored or superseded. Drop it and
        // let the next full flush reconcile from what the backend actually holds.
        await this.outbox.remove(batch.batchId);
        this.storedVersion = body.version;
      }
    }
  }

  /**
   * Ship everything since the last acknowledgement.
   *
   * One snapshot, taken once: the events, the world document and the store's changes all describe
   * the same instant. Building them at three different moments would ship a state that never
   * existed.
   */
  async flush(): Promise<BatchResponse | null> {
    if (this.readOnly || this.flushing) return null;
    this.flushing = true;
    try {
      const snapshot = this.runtime.snapshot();
      const events = this.runtime.eventsSince(this.shippedIdx);
      const changes = this.runtime.store.changesSince(this.shippedChangeSeq);
      if (events.length === 0 && changes.length === 0) return null;

      const batch = this.buildBatch(snapshot, events, changes);
      // Durable before it is sent: if the tab dies between here and the response, the batch is
      // still owed and `start()` will send it again.
      await this.outbox.add(batch);
      const { body } = await this.post<BatchResponse>('/batches', batch);

      if (body.ok) {
        await this.acknowledge(batch, body.version, body.changeSeq);
        return body;
      }
      if (body.reason === 'stale-session') {
        this.goReadOnly('Another session holds this world.');
        await this.outbox.remove(batch.batchId);
        return body;
      }
      // A version conflict means an acknowledgement went missing. The next flush re-sends from
      // what the backend says it holds, and state ships whole anyway — so there is nothing to
      // merge, only a base to correct (docs/11 §4.3).
      this.storedVersion = body.version;
      this.shippedIdx = body.version;
      await this.outbox.remove(batch.batchId);
      return body;
    } finally {
      this.flushing = false;
    }
  }

  private buildBatch(
    snapshot: AgenticRuntimeSnapshot,
    events: ReturnType<AgenticRuntime['eventsSince']>,
    changes: ReturnType<AgenticRuntime['store']['changesSince']>,
  ): BatchRequest {
    const { store: _store, ...world } = snapshot;
    const toIdx = events.length ? events[events.length - 1].idx : this.storedVersion;
    return {
      batchId: `b:${this.sessionId}:${this.storedVersion}:${toIdx}`,
      sessionId: this.sessionId,
      generation: this.generation,
      baseVersion: this.storedVersion,
      // The version chain is the idx chain, so a version says exactly how much log it covers.
      newVersion: toIdx,
      fromIdx: events.length ? events[0].idx : this.storedVersion,
      toIdx,
      events: events.map((event) => ({
        idx: event.idx,
        kind: event.name,
        gameTime: event.gameTime,
        wallTime: event.wallTime,
        payload: event.args,
      })),
      state: world,
      changes,
      changeSeq: this.runtime.store.changeSeq,
    };
  }

  private async acknowledge(batch: BatchRequest, version: number, changeSeq: number) {
    this.storedVersion = version;
    this.shippedIdx = batch.toIdx;
    this.shippedChangeSeq = changeSeq;
    this.runtime.pruneEvents(batch.toIdx);
    this.runtime.store.pruneChanges(changeSeq);
    await this.outbox.remove(batch.batchId);
  }

  private goReadOnly(reason: string) {
    if (this.readOnly) return;
    this.readOnly = true;
    this.onReadOnly?.(reason);
  }
}

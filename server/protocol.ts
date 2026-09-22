import type { AgentStoreSnapshot, StoreChange } from '../agent/store/memoryStore';

/**
 * The contract between the tab that owns a world and the backend that stores it.
 *
 * Types only: nothing here runs, so the client imports it and the bundle keeps none of it.
 *
 * Read docs/11 §4 alongside this. The three rules that shape every field below are that the
 * frontend assigns `idx`, that there is exactly one writer at a time, and that a batch boundary is
 * the only moment the world is consistent — so a batch is all-or-nothing and carries the state
 * whole rather than as a delta.
 */

export interface BatchEvent {
  /** Frontend-assigned and unique per world. The idempotency key, with `world_id` (§4.2). */
  idx: number;
  /** Player input, agent decision, model result, god verdict — so the log filters without parsing. */
  kind: string;
  gameTime: number;
  wallTime: number;
  payload: unknown;
}

export interface BatchRequest {
  /** Identifies this attempt. A retry reuses it, which is what makes the retry a no-op. */
  batchId: string;
  sessionId: string;
  generation: number;
  /** The version this batch expects to find stored. A mismatch is a rejected batch, not a merge. */
  baseVersion: number;
  newVersion: number;
  fromIdx: number;
  toIdx: number;
  events: BatchEvent[];
  /** The whole world document. No deltas (§7.1). */
  state: unknown;
  /** Durable writes since the last acknowledged batch. */
  changes: StoreChange[];
  /** The store's change sequence this batch ships up to, echoed back on success. */
  changeSeq: number;
}

export type BatchResponse =
  | { ok: true; version: number; changeSeq: number; duplicate: boolean }
  | {
      ok: false;
      /**
       * `stale-session` means another tab holds the lease: go read-only.
       * `version-conflict` means we missed an acknowledgement: re-send from stored state.
       */
      reason: 'stale-session' | 'version-conflict';
      /** What the backend actually holds, so the client can resynchronise rather than guess. */
      version: number;
    };

export interface SessionRequest {
  sessionId: string;
  /** Take the lease even if another session holds it. The taker wins; the loser finds out. */
  steal?: boolean;
}

export type SessionResponse =
  | { ok: true; sessionId: string; generation: number }
  | { ok: false; reason: 'held'; holder: string; generation: number };

export interface BootstrapResponse {
  world: { id: string; name: string; status: string };
  /** `null` for a world created without one. */
  definition: unknown;
  /** `null` for a world that has never shipped a batch. */
  state: { idx: number; version: number; state: unknown } | null;
  /**
   * The durable tier, reassembled into exactly what the in-memory store restores from.
   *
   * This is what makes "clear the browser and come back" work without replaying anything: resume
   * reads state and the store, and the log stays a log (§6.1).
   */
  store: AgentStoreSnapshot;
}

export interface LlmCallRecord {
  worldId?: string;
  purpose?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  traceId?: string;
}

export type { StoreChange, AgentStoreSnapshot };

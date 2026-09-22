import { v } from 'convex/values';
import { DatabaseReader, DatabaseWriter, internalMutation } from '../_generated/server';
import { Id } from '../_generated/dataModel';
import { AUDIT_EXCERPT_CHARS, BLOB_THRESHOLD_BYTES } from '../../engine/prose/contract';

/**
 * Write helpers for the prose tier. These are plain functions over the database rather than
 * mutations, because the engine's input handlers cannot write: `handleInput` mutates the
 * in-memory `Game` and the database write happens later, in `saveWorld`. Everything here is
 * meant to be called from there (A4), or from an action through the wrappers at the bottom.
 */

// ---------------------------------------------------------------- blobs (docs/05 §9.5)

/**
 * Content-addressed hash. Uses Web Crypto, so this runs in an **action**, not a mutation — which
 * is the right place anyway: an oversized payload is detected before the input is sent.
 */
export async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function exceedsBlobThreshold(content: string): boolean {
  return new TextEncoder().encode(content).length >= BLOB_THRESHOLD_BYTES;
}

export async function writeBlob(db: DatabaseWriter, hash: string, content: string) {
  const existing = await db
    .query('blobs')
    .withIndex('byHash', (q) => q.eq('hash', hash))
    .first();
  if (existing) {
    return existing._id;
  }
  return await db.insert('blobs', { hash, content });
}

export async function readBlob(db: DatabaseReader, hash: string): Promise<string | undefined> {
  const blob = await db
    .query('blobs')
    .withIndex('byHash', (q) => q.eq('hash', hash))
    .first();
  return blob?.content;
}

// ---------------------------------------------------------------- entity state (docs/05 §8)

export type StatePayload = { state: string } | { stateRef: string };

/**
 * Append a document at a caller-allocated version.
 *
 * The version comes from the world document — the input handler bumps `entity.stateVersion` when
 * it applies the update — rather than from a query here. That keeps the world document the single
 * authority on version numbers and avoids a read-modify-write on a path that already serializes.
 */
export async function appendEntityState(
  db: DatabaseWriter,
  worldId: Id<'worlds'>,
  entityId: string,
  version: number,
  payload: StatePayload,
  now: number,
) {
  await db.insert('entityState', { worldId, entityId, version, ...payload, updatedAt: now });
}

export async function latestEntityState(
  db: DatabaseReader,
  worldId: Id<'worlds'>,
  entityId: string,
) {
  return await db
    .query('entityState')
    .withIndex('byEntity', (q) => q.eq('worldId', worldId).eq('entityId', entityId))
    .order('desc')
    .first();
}

/** The current document, resolving a blob reference if the version carries one. */
export async function readEntityState(
  db: DatabaseReader,
  worldId: Id<'worlds'>,
  entityId: string,
): Promise<string | undefined> {
  const latest = await latestEntityState(db, worldId, entityId);
  if (!latest) {
    return undefined;
  }
  return latest.state ?? (latest.stateRef ? await readBlob(db, latest.stateRef) : undefined);
}

// ---------------------------------------------------------------- audit (docs/05 §9.3)

export function excerpt(text: string): { text: string; truncated: boolean } {
  if (text.length <= AUDIT_EXCERPT_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, AUDIT_EXCERPT_CHARS), truncated: true };
}

export interface AuditEntry {
  worldId: Id<'worlds'>;
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

export async function appendAudit(db: DatabaseWriter, entry: AuditEntry) {
  const latest = await db
    .query('stateAudit')
    .withIndex('byEntity', (q) => q.eq('worldId', entry.worldId).eq('entityId', entry.entityId))
    .order('desc')
    .first();
  const before = excerpt(entry.before);
  const after = excerpt(entry.after);
  await db.insert('stateAudit', {
    worldId: entry.worldId,
    entityId: entry.entityId,
    seq: (latest?.seq ?? 0) + 1,
    field: entry.field,
    source: entry.source,
    before: before.text,
    after: after.text,
    beforeTruncated: before.truncated,
    afterTruncated: after.truncated,
    reason: entry.reason,
    inputNumber: entry.inputNumber,
    batchId: entry.batchId,
    tags: entry.tags,
  });
}

// ---------------------------------------------------------------- god transcript (docs/05 §7.3)

export async function appendGodTranscript(
  db: DatabaseWriter,
  worldId: Id<'worlds'>,
  role: 'event' | 'verdict',
  content: string,
  options: { batchId?: string; inputNumber?: number } = {},
) {
  const latest = await db
    .query('godTranscript')
    .withIndex('bySeq', (q) => q.eq('worldId', worldId))
    .order('desc')
    .first();
  await db.insert('godTranscript', {
    worldId,
    seq: (latest?.seq ?? 0) + 1,
    role,
    content,
    batchId: options.batchId,
    inputNumber: options.inputNumber,
  });
}

// ---------------------------------------------------------------- action-side wrappers

/** Called from an action once it has hashed an oversized payload, before sending the input. */
export const storeBlob = internalMutation({
  args: { hash: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    await writeBlob(ctx.db, args.hash, args.content);
    return args.hash;
  },
});

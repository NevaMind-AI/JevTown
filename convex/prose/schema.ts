import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * The prose tier of docs/05 §8: written on change only, derived, and rebuildable from the input
 * log. None of it is in the world document, because the tick loop never reads prose and the
 * world document is rewritten in full every step.
 */
export const proseTables = {
  // docs/05 §8. The world document carries only a `stateVersion` integer pointing at the current
  // row here, which is cheap to replicate every step and gives the client a change signal
  // without carrying the prose. `state` and `stateRef` are exclusive: oversized documents go to
  // `blobs` and travel as a hash (§9.5).
  entityState: defineTable({
    worldId: v.id('worlds'),
    entityId: v.string(),
    version: v.number(),
    state: v.optional(v.string()),
    stateRef: v.optional(v.string()),
    updatedAt: v.number(),
  }).index('byEntity', ['worldId', 'entityId', 'version']),

  // docs/05 §9.3. Never read by the engine, explicitly not part of replay, and rebuildable from
  // the log — it exists so a human can answer "how did this entity get here" without
  // reconstructing it. `reason` is mandatory because with no condition trace it is the only
  // thing carrying that weight.
  stateAudit: defineTable({
    worldId: v.id('worlds'),
    entityId: v.string(),
    seq: v.number(),
    field: v.union(v.literal('state'), v.literal('memory'), v.literal('physics')),
    source: v.union(v.literal('self'), v.literal('interaction'), v.literal('god')),
    // Excerpts, not the authoritative copies — those are `entityState` and the input log. Bounded
    // so one very long document cannot produce a very large audit row.
    before: v.string(),
    after: v.string(),
    beforeTruncated: v.boolean(),
    afterTruncated: v.boolean(),
    reason: v.string(),
    inputNumber: v.number(),
    batchId: v.optional(v.string()),
    // Unvalidated by design (docs/05 §9.4). Carries the parser's conformance record, which is
    // what makes drift answerable by query rather than by a harness (docs/08 §7 D6).
    tags: v.optional(v.any()),
  })
    .index('byEntity', ['worldId', 'entityId', 'seq'])
    .index('byInput', ['worldId', 'inputNumber']),

  // docs/05 §9.5. Append-only and content-addressed, so it deduplicates naturally and never
  // needs invalidation. The log stays authoritative because the hash is.
  blobs: defineTable({
    hash: v.string(),
    content: v.string(),
  }).index('byHash', ['hash']),

  // Turns of an interaction between an actor and a fixed entity. Deliberately not the `messages`
  // table, for the reason docs/05 §7.3 gives about the god: `messages` requires a `conversationId`
  // and an `author` that is a player id, and a fixed entity is neither — faking them mints ids
  // that other code will later validate.
  interactionTurns: defineTable({
    worldId: v.id('worlds'),
    interactionId: v.string(),
    seq: v.number(),
    actorId: v.string(),
    targetId: v.string(),
    speaker: v.union(v.literal('actor'), v.literal('target')),
    text: v.string(),
  }).index('byInteraction', ['worldId', 'interactionId', 'seq']),

  // docs/05 §7.3. Deliberately not the `messages` table: the god has no conversation id and no
  // player id, it is invisible by design, and its turns are not (author, text) pairs. It is a
  // rebuildable cache that exists only to condition the live model — replay needs the god's
  // decisions, which are inputs, not its deliberations.
  godTranscript: defineTable({
    worldId: v.id('worlds'),
    seq: v.number(),
    role: v.union(v.literal('event'), v.literal('verdict')),
    content: v.string(),
    batchId: v.optional(v.string()),
    inputNumber: v.optional(v.number()),
    // The high-water mark this batch consumed. The god's watermark lives on its own rows rather
    // than in a mutable counter elsewhere, so a truncated transcript loses history but never
    // causes the same interaction to be judged twice.
    throughInputNumber: v.optional(v.number()),
  }).index('bySeq', ['worldId', 'seq']),
};

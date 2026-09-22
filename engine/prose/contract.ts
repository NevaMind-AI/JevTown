/**
 * The `state_contract` — engine-owned.
 *
 * docs/08 §7 D1 moved this out of `world.json`: it is the format this engine's parser reads and
 * the god's gate judges against, so a writer agent able to rewrite it could emit a contract the
 * parser cannot enforce, with nothing able to detect the disagreement. It lives in code,
 * versioned with the engine, and the writer agent obeys it rather than declaring it.
 *
 * See docs/05-agentic-world-format.md §5.1 (as amended).
 */

/**
 * Budgets are in words, not characters. They are loose on purpose: state complexity scales with
 * the complexity of the world, and a tight cap on a structured document truncates the intention
 * section, which is the part the next decision reads.
 */
export const STATE_WORD_BUDGET = 1000;
export const MEMORY_WORD_BUDGET = 60;
export const REASON_WORD_BUDGET = 40;

/** `state` gets one re-ask before falling back to the previous document; nothing else retries. */
export const STATE_REASK_LIMIT = 1;

/**
 * How much of a state document the audit table keeps in `before`/`after`. The audit is derived
 * and rebuildable (docs/05 §9.3) — the authoritative copies are `entityState` and the input log —
 * so it stores an excerpt rather than risking a large row per write.
 */
export const AUDIT_EXCERPT_CHARS = 2000;

/**
 * Payloads at or above this go to `blobs` content-addressed and travel as a hash. Set well below
 * Convex's 1 MB document cap so the hash path is exercised in normal operation rather than
 * discovered the first time a model produces an unusually long document (docs/05 §9.5).
 */
export const BLOB_THRESHOLD_BYTES = 64 * 1024;

/**
 * The head lines, identical in both variants. Everything above the first paragraph.
 */
const STATE_HEAD = `state: <one word or short phrase>
<optional extra lines, one per line, each "name: value">`;

/**
 * The bracketed blocks, identical in both variants and last in both.
 *
 * They sit at the foot of the document rather than under the head lines so that the prose runs
 * uninterrupted from the head-state to the intention — the part the next decision reads — and so
 * that the one position rule ("anything in angle brackets goes last") is the same sentence for an
 * actor and a prop, whose documents end differently.
 */
const STATE_TAIL = `<optional <blocked/> or <unblocked/>, then an optional <items> block - see below>`;

const ACTOR_SHAPE = `${STATE_HEAD}

<a paragraph, in natural language, about how you are right now>

<one or a few sentences saying what you mean to do next>

${STATE_TAIL}`;

const PROP_SHAPE = `${STATE_HEAD}

<a paragraph, in natural language, about the condition it is now in>

${STATE_TAIL}`;

/**
 * A document's rules are assembled from three named pieces rather than one block, because one of
 * them names its subject and the others do not.
 *
 * An entity's head-state is sourced from its `description`; common knowledge has no description,
 * and a rule telling it to use one would leave a dangling referent. This branch already learned
 * that a model resolves rather than notices — the god read the example nouns in a rule as the rule
 * itself (docs/08 §5 A7) — and a pronoun with nothing behind it fails the same way. So the rules
 * that name a subject are written once per subject, and the ones about shape alone are shared.
 */
const HEAD_STATE_RULE = `- Line one always begins "state: ", followed by one word or a short phrase naming the condition
  this subject is in now. Take it from the words its own description already uses, and reuse the
  one last written unless something has actually changed. Do not coin a new one for its own sake.`;

const SHAPE_RULES = `- Extra "name: value" lines are a last resort. Most of the time there should be none — keep
  finer detail in the paragraph, where it can carry nuance a field cannot.
- Separate each part with one blank line.`;

const PARAGRAPH_RULE = `- The paragraph holds what another character could plausibly learn by dealing with this subject
  now. Do not restate the description; that never changes. Do not narrate history that belongs in
  memory.`;

const DOCUMENT_RULES = `${HEAD_STATE_RULE}
${SHAPE_RULES}
${PARAGRAPH_RULE}`;

const BRACKETED_BLOCK_RULES = `- Two optional blocks may come last, below everything else, in this order. Anything written in
  angle brackets belongs at the very end of the document and nowhere else. Do not write either one
  unless this subject's own description tells you to. Almost nothing needs them.
  <blocked/> or <unblocked/> — whether the space this subject occupies can be walked through
  right now. Once you use these at all, write the true one every single time you write a state,
  not only when it changes. Writing neither leaves things exactly as they are; writing both is
  read as writing neither.
  <items>
  "a thing" = 1
  "another thing" = 3
  </items>
  — what this subject is carrying right now. One line per kind of thing, with its count.`;

const SHARED_RULES = `${DOCUMENT_RULES}
${BRACKETED_BLOCK_RULES}`;

const ACTOR_RULES = `- Write it in the first person, as yourself: "I am", never "she is".
- Your intention — what you mean to do next, in your own terms — is the last prose you write.
  Only the bracketed blocks, if you write any, come after it.`;

const PROP_RULES = `- Write it in the third person, about the thing: "the door is", never "I am". You are describing
  it, not speaking as it.
- Do not give it an intention. It is a thing; it has a condition, not a plan.`;

const BUDGET_RULE = `- Stay under ${STATE_WORD_BUDGET} words in total.`;

/** Injected into every system prompt that writes an actor's own state. */
export const ACTOR_STATE_CONTRACT = `Write your state as a document in exactly this shape:

${ACTOR_SHAPE}

${SHARED_RULES}
${ACTOR_RULES}
${BUDGET_RULE}`;

/**
 * Injected when an actor writes a prop's state (docs/05 §6.2). A prop has a condition, not a
 * plan, so this variant has no intention section.
 */
export const PROP_STATE_CONTRACT = `Write the thing's new state as a document in exactly this shape:

${PROP_SHAPE}

${SHARED_RULES}
${PROP_RULES}
${BUDGET_RULE}`;

/**
 * Both variants for a reader that judges both — the god (docs/05 §7), which sees a mixed batch
 * and has to hold each document against the right one.
 *
 * Concatenating the two contracts would state `SHARED_RULES` twice, in full, in every gate call.
 * That is not only tokens: a rule repeated verbatim is a rule that can be *edited* in one copy
 * and not the other by a model reading fast, and a judge holding two near-identical rule lists
 * has to decide which it is judging against before it can judge anything. Here the shared part is
 * stated once and the two variants differ only where they actually differ, which is also the
 * distinction the batch labels point at.
 *
 * The variant-specific rules are reused verbatim rather than rephrased into a judge's voice, so
 * the god cannot drift from what the writer was actually told.
 */
export const BOTH_TIERS_STATE_CONTRACT = `Every entity writes its state as a document. There are two variants of one shape.

An entity that acts writes:

${ACTOR_SHAPE}

An entity that does not act — one that has a condition rather than a plan — writes the same shape
without the intention part:

${PROP_SHAPE}

These rules hold for both variants:

${SHARED_RULES}
${BUDGET_RULE}

These hold only for an entity that acts:
${ACTOR_RULES}

These hold only for an entity that does not act:
${PROP_RULES}`;

/**
 * The envelope of docs/05 §6.1. One call rewrites the prose, and the physics projection rides
 * *inside* that prose as the `<blocked/>` / `<unblocked/>` tag — never a second call, never a
 * separate classifier pass, and now not even a second field to keep in step with the first.
 */
export const ENVELOPE_INSTRUCTION = `Reply with one JSON object and nothing else:

{
  "state": "<your whole state document, in the shape above>",
  "memory": ["<one sentence you will remember>", "..."],
  "reason": "<one sentence on why your state changed>"
}

- "state" is the complete document, not a diff. Write it out in full every time.
- "reason" is required. It is the only record of why this happened.`;

/** The nested shape of docs/05 §6.2, where one call updates the actor and the prop it acted on. */
export const TARGET_ENVELOPE_INSTRUCTION = `Reply with one JSON object and nothing else:

{
  "self":   { "state": "<your document>", "memory": ["..."], "reason": "..." },
  "target": { "state": "<the thing's document>", "reason": "..." }
}

- Write both documents out in full.
- If the thing's description tells you it can be blocked or unblocked, the tag at the end of
  "target.state" is what tells the world it changed: a door that is now open must carry
  <unblocked/>, or nobody will be able to walk through it.
- Both "reason" fields are required.`;

export const MEMORY_CONTRACT = `One sentence, first person, past tense, one discrete fact or impression per entry. Stay under ${MEMORY_WORD_BUDGET} words per entry.`;

export type EntityTier = 'actor' | 'prop';

export function stateContractFor(tier: EntityTier): string {
  return tier === 'actor' ? ACTOR_STATE_CONTRACT : PROP_STATE_CONTRACT;
}

// ---------------------------------------------------------------- common knowledge (docs/05 §5.3)

/**
 * The reserved `entityState.entityId` under which the world's common knowledge is stored.
 *
 * It is a key in the prose tier and nothing else. Deliberately **not** an `Entity`: staying out of
 * `world.entities` is what makes "not targetable, no physics, no memory, never rendered" true by
 * construction rather than by four exclusion checks in the manifest, the collision overlay, the
 * targeting set and the client.
 *
 * `entityState.entityId` is an unvalidated string that already mixes id namespaces (`p:` for tier
 * (a), entity ids otherwise), so a third namespace costs nothing. The double underscores keep it
 * outside anything `parseGameId` would accept.
 */
export const COMMON_KNOWLEDGE_ID = '__world__';

/**
 * Common knowledge has a condition, not a plan, so it takes the prop shape without the intention
 * section — and without the bracketed tail, since it occupies no space and carries nothing. It is
 * the same document format every entity writes, which is the point: one parser, one budget, one
 * conformance record.
 */
const COMMON_KNOWLEDGE_SHAPE = `${STATE_HEAD}

<a paragraph, in natural language, of what is true in this world right now>`;

/**
 * The scope rule, which is the whole of what keeps this from becoming a back door.
 *
 * An actor cannot see another entity's state and learns it only by interacting (docs/05 §6.4).
 * Common knowledge is read by everyone, so anything written here is known by everyone without
 * anybody having learned it. That is a deliberate exception and it is only safe while what goes in
 * is restricted to what every inhabitant would already know anyway.
 */
const COMMON_KNOWLEDGE_RULES = `- Write only what is settled and what everyone in this world would already know: things that
  happened in the open, or that the whole place would have heard by now. Write it in the third
  person, about the world.
- One character's belief, one character's secret, or anything only the people present could know
  does NOT go here. That stays in their own state and their own memory. Everyone reads this, so
  writing it here is the same as telling everyone.
- Nothing here is secret, and nothing here is in doubt. If a fact is not yet settled, leave it out
  and wait.
- Do not restate the rules of the world; those never change and are given separately. This is only
  what has come to be true within them.
- Keep it short. Most worlds need a handful of lines, and a fact that stops mattering should be
  dropped rather than kept forever.`;

/** Injected wherever common knowledge is written — today only the god's intervention. */
/** The world has no `description` to source a head-state from; it has the rules it runs on. */
const COMMON_KNOWLEDGE_HEAD_STATE_RULE = `- Line one always begins "state: ", followed by one word or a short phrase naming where this
  world stands now. Reuse the one last written unless something has actually changed. Do not coin
  a new one for its own sake.`;

export const COMMON_KNOWLEDGE_CONTRACT = `Common knowledge is one document, in this shape:

${COMMON_KNOWLEDGE_SHAPE}

${COMMON_KNOWLEDGE_HEAD_STATE_RULE}
${SHAPE_RULES}
${COMMON_KNOWLEDGE_RULES}
${BUDGET_RULE}`;

import { STATE_WORD_BUDGET } from './contract';

/**
 * Parsing for the state document of docs/05 §5.1 (as amended by docs/08 §7 D1).
 *
 * The single hard rule here: **this never throws.** Length is the only hard restriction on
 * prose, and a missing section, an invented head-state, a broken typed line or a document with
 * no structure at all are all tolerated and recorded. What an entity does with a malformed
 * state document is an observation, not a bug to be prevented.
 *
 * What this deliberately does *not* do is split the body into sections. The contract still asks
 * for a paragraph of condition and, from an actor, an intention — but that split is soft guidance
 * to the writer, never a rule to check, and no consumer ever needed either half alone: the client
 * renders the document whole and every prompt injects it whole. The structural signal that made
 * drift queryable was `blockCount`, and "did it write an intention" was only ever a rendering of
 * it, so nothing is lost by not guessing which block is which.
 *
 * The `Conformance` record every parse returns is what makes the tolerant stance affordable: it
 * goes into `stateAudit.tags`, which turns "does prose state drift over a long run"
 * (docs/05 §13 A1) into a query over a real run rather than a separate harness (docs/08 §7 D6).
 */

export type StateFields = Record<string, string>;

/** What a document asserts about its subject's solidity, if it asserts anything. */
export type PhysicsTag = 'blocked' | 'unblocked';

/** `conflicting` when a document claims both, which asserts nothing and keeps the old value. */
export type PhysicsTagStatus = 'absent' | PhysicsTag | 'conflicting';

export interface StateDocument {
  /** The head-state token. Never validated — an entity's vocabulary is its own description. */
  headState?: string;
  /** `name: value` lines after the head-state. Expected to be empty for most entities. */
  fields: StateFields;
  /**
   * `<blocked/>` or `<unblocked/>`, the one part of a state document the engine acts on.
   *
   * Undefined means the document asserted nothing, and the entity keeps the physics it had —
   * never a default. Most entities never switch and so never write a tag at all; the ones that do
   * are told to in their own `behavior`, and are told to write the true one **every** time, so
   * the tag is a level rather than an edge and a repeated write is idempotent.
   */
  physicsTag?: PhysicsTag;
  /**
   * The `<items>` block, if there was one. Nothing in the engine reads this — it is prose with a
   * shape, kept parsed only so a run can be queried. The moment something branches on it, this
   * branch has reinvented `vars` (docs/05 §9.4).
   */
  items?: Record<string, number>;
  /**
   * The `<tasks>` block of docs/13 §1.2: `task-id = step-id`, one line per task.
   *
   * This is the branch the `items` note above warns against, taken deliberately and argued in
   * docs/13 §1.6. The warning still describes the failure mode, so the rule that makes it
   * affordable is enforced by the callers rather than here: **an unrecognised value is never an
   * error.** This returns whatever was written and leaves judging it to the reader.
   *
   * Only on the world-state document in practice, but parsed on every document, because a parser
   * that knows which entity it is reading has a second way to be wrong.
   */
  tasks?: Record<string, string>;
  /**
   * The `<player_items>` block of docs/13 §1.4 — `<items>`' shape, for what the player carries.
   * Separate from `items` because that one is the *subject's* inventory and this one is not.
   */
  playerItems?: Record<string, number>;
  /** The document as written, which is the only form anything downstream consumes. */
  raw: string;
}

export type HeadStateStatus = 'matched' | 'malformed' | 'missing';

export interface Conformance {
  headState: HeadStateStatus;
  /**
   * The token itself, not just whether line one parsed. With no authored vocabulary to check it
   * against, the observed distribution per entity is the only remaining handle on head-state
   * drift, and it is only queryable if it reaches `stateAudit.tags`.
   */
  headStateToken?: string;
  fieldCount: number;
  blockCount: number;
  physicsTag: PhysicsTagStatus;
  itemCount: number;
  taskCount: number;
  playerItemCount: number;
  wordCount: number;
  /**
   * Words the budget actually applies to: the document with its record blocks removed
   * (docs/13 §1.7).
   *
   * The blocks are records, not prose, and an over-budget update is discarded whole
   * (`agent/stateUpdate.ts`). Counting them would let a long paragraph revert task state — a
   * silent loss, which docs/13 §0 rules out however much prose owns the value.
   */
  budgetWordCount: number;
  charCount: number;
  overBudget: boolean;
  /** Set by the caller once it knows whether it truncated or re-asked. */
  truncated: boolean;
  reasks: number;
  /** True when the update was discarded and the previous document kept (docs/05 §5.1). */
  fellBack: boolean;
}

export interface ParsedState {
  document: StateDocument;
  conformance: Conformance;
}

const HEAD_STATE = /^state\s*:\s*(.*)$/i;
const FIELD = /^([A-Za-z_][A-Za-z0-9_ -]*?)\s*:\s*(.*)$/;
// Tolerant on purpose: `< blocked />`, `<unblocked>` and the well-formed spelling all count, and
// the tag is looked for anywhere in the document rather than at an agreed position. A model that
// gets the shape nearly right should not silently fail to open a door.
const PHYSICS_TAG = /<\s*(blocked|unblocked)\s*\/?\s*>/gi;
// Blocks are matched by name with the same tolerance the physics tag gets, and anywhere in the
// document rather than at an agreed position.
const blockPattern = (name: string) =>
  new RegExp(`<\\s*${name}\\s*>([\\s\\S]*?)<\\s*\\/\\s*${name}\\s*>`, 'i');
const ITEMS_BLOCK = blockPattern('items');
const PLAYER_ITEMS_BLOCK = blockPattern('player_items');
const TASKS_BLOCK = blockPattern('tasks');
const ITEM_LINE = /^"?\s*([^"=]+?)\s*"?\s*=\s*(-?\d+)$/;
// Same shape, any token on the right: a step id, `done`, or something we do not recognise yet.
const TASK_LINE = /^"?\s*([^"=]+?)\s*"?\s*=\s*(\S[^\n]*?)$/;

function parsePhysicsTag(text: string): { tag?: PhysicsTag; status: PhysicsTagStatus } {
  const found = new Set([...text.matchAll(PHYSICS_TAG)].map((m) => m[1].toLowerCase()));
  if (found.size === 0) {
    return { status: 'absent' };
  }
  if (found.size > 1) {
    // Both, in one document. It asserts nothing, so the entity keeps what it had — the same
    // direction absence takes, and the one that cannot open a door nobody opened.
    return { status: 'conflicting' };
  }
  const tag = [...found][0] as PhysicsTag;
  return { tag, status: tag };
}

function parseCountBlock(text: string, pattern: RegExp): Record<string, number> | undefined {
  const block = pattern.exec(text);
  if (!block) {
    return undefined;
  }
  const items: Record<string, number> = {};
  for (const line of block[1].split('\n')) {
    const match = ITEM_LINE.exec(line.trim());
    if (match && match[1] !== '') {
      items[match[1]] = Number(match[2]);
    }
  }
  return items;
}

/** `task-id = step-id`. The value is never validated here; see `StateDocument.tasks`. */
function parseTasks(text: string): Record<string, string> | undefined {
  const block = TASKS_BLOCK.exec(text);
  if (!block) {
    return undefined;
  }
  const tasks: Record<string, string> = {};
  for (const line of block[1].split('\n')) {
    const match = TASK_LINE.exec(line.trim());
    if (match && match[1] !== '') {
      tasks[match[1]] = match[2].trim();
    }
  }
  return tasks;
}

/**
 * The document with its record blocks removed, which is what the word budget applies to
 * (docs/13 §1.7, §1.8 item B).
 */
export function budgetedText(text: string): string {
  return text
    .replace(new RegExp(TASKS_BLOCK.source, 'gi'), '')
    .replace(new RegExp(PLAYER_ITEMS_BLOCK.source, 'gi'), '')
    .trim();
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

export function overBudget(text: string, budget: number = STATE_WORD_BUDGET): boolean {
  return wordCount(text) > budget;
}

/** Truncate on a word boundary. Used where the contract says truncate rather than re-ask. */
export function truncateWords(text: string, budget: number): { text: string; truncated: boolean } {
  const words = text.trim().split(/\s+/);
  if (text.trim() === '' || words.length <= budget) {
    return { text, truncated: false };
  }
  return { text: words.slice(0, budget).join(' '), truncated: true };
}

export function parseStateDocument(raw: string): ParsedState {
  const normalized = (raw ?? '').replace(/\r\n/g, '\n').trim();
  const blocks = normalized
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '');

  const fields: StateFields = {};
  let headState: string | undefined;
  let headStatus: HeadStateStatus = 'missing';

  if (blocks.length > 0) {
    const headerLines = blocks[0].split('\n').map((line) => line.trim());
    const headMatch = HEAD_STATE.exec(headerLines[0] ?? '');
    if (headMatch) {
      const value = headMatch[1].trim();
      if (value === '') {
        // `state:` with nothing after it. Recorded, tolerated.
        headStatus = 'malformed';
      } else {
        headState = value;
        headStatus = 'matched';
      }
      // Only the head block's remaining lines are read as fields; a `name: value` line further
      // down is prose that happens to contain a colon. A line here that is not a field is simply
      // not one — it stays in `raw` like everything else, so recognising nothing drops nothing.
      for (const line of headerLines.slice(1)) {
        const field = FIELD.exec(line);
        if (field) {
          fields[field[1].trim()] = field[2].trim();
        }
      }
    }
  }

  const physics = parsePhysicsTag(normalized);
  const items = parseCountBlock(normalized, ITEMS_BLOCK);
  const playerItems = parseCountBlock(normalized, PLAYER_ITEMS_BLOCK);
  const tasks = parseTasks(normalized);
  const budgeted = budgetedText(normalized);

  return {
    document: {
      headState,
      fields,
      physicsTag: physics.tag,
      items,
      tasks,
      playerItems,
      raw: normalized,
    },
    conformance: {
      headState: headStatus,
      headStateToken: headState,
      fieldCount: Object.keys(fields).length,
      blockCount: blocks.length,
      physicsTag: physics.status,
      itemCount: items ? Object.keys(items).length : 0,
      taskCount: tasks ? Object.keys(tasks).length : 0,
      playerItemCount: playerItems ? Object.keys(playerItems).length : 0,
      wordCount: wordCount(normalized),
      budgetWordCount: wordCount(budgeted),
      charCount: normalized.length,
      overBudget: overBudget(budgeted),
      truncated: false,
      reasks: 0,
      fellBack: false,
    },
  };
}

/**
 * What a document asserts about its subject's physics, as a patch over whatever is there now.
 *
 * An empty patch is the answer to "it said nothing" and to "it said both", and both must leave
 * the entity alone. Guessing `blocksMovement: false` here would open doors nobody opened.
 */
export function physicsPatchFrom(document: StateDocument): { blocksMovement?: boolean } {
  return document.physicsTag ? { blocksMovement: document.physicsTag === 'blocked' } : {};
}

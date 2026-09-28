import { budgetedText, parseStateDocument } from './stateDocument';

/**
 * Folding the world-state document's version chain (docs/13 §4).
 *
 * The document has two writers now — the god and, in the conversation where it happens, an agent
 * — and a writer that has to restate fifty task lines to change one will eventually not. So a
 * write is a **patch**, and what everything downstream reads is the fold of every patch so far.
 *
 * The rule is per part, and it falls out of what can be keyed:
 *
 * | part                | on a write that contains it | on a write that omits it |
 * | ------------------- | --------------------------- | ------------------------ |
 * | head-state + prose  | replaced whole              | kept                     |
 * | `<tasks>`           | merged line by line         | kept                     |
 * | `<player_items>`    | merged line by line         | kept                     |
 *
 * **Leaving a line out never removes it.** That is what makes the merge total without a tombstone
 * vocabulary: `<player_items>` says a thing is gone by writing it `= 0`, and a task line is never
 * removed at all, because the set of tasks is authored and fixed (docs/13 §1.2).
 *
 * Why folding at read rather than merging at write: the store already keeps every version, sorted
 * and idempotent by the version the input handler allocated, so patches commute by construction —
 * two agents touching different lines cannot lose each other's write, with no read-modify-write
 * anywhere. The cost is that the document stops being a thing some model wrote and becomes
 * something this function assembled; a conformance record therefore describes a patch, not a
 * state. docs/13 §4 records that.
 */

export interface WorldStateParts {
  /** Head-state, any fields, and the paragraph: whatever the last writer of prose wrote. */
  prose: string;
  tasks: Record<string, string>;
  playerItems: Record<string, number>;
}

export interface WorldStateFold extends WorldStateParts {
  /** The composed document, which is what every reader and every prompt should see. */
  document: string;
}

/** Quoted only when it has to be: `ITEM_LINE` and `TASK_LINE` both accept either spelling. */
function recordLine(name: string, value: string | number): string {
  return `${/[\s"=]/.test(name) ? `"${name}"` : name} = ${value}`;
}

function block(name: string, lines: string[]): string[] {
  return lines.length ? [[`<${name}>`, ...lines, `</${name}>`].join('\n')] : [];
}

export function renderWorldState(parts: WorldStateParts): string {
  return [
    ...(parts.prose ? [parts.prose] : []),
    ...block(
      'tasks',
      Object.entries(parts.tasks).map(([id, step]) => recordLine(id, step)),
    ),
    ...block(
      'player_items',
      Object.entries(parts.playerItems).map(([id, count]) => recordLine(id, count)),
    ),
  ].join('\n\n');
}

/**
 * A patch with its prose removed: what an entity other than the god is allowed to write.
 *
 * docs/13 §4.2 divides the document by what can be keyed — the blocks merge, the paragraph does
 * not, so the paragraph stays with the one writer that sees the whole world. This is where that
 * division is enforced instead of being asked for: a writer that has just been told to describe
 * its own condition is the one most likely to describe the world's as well.
 *
 * Returns `''` when there was nothing to keep, which the caller reads as "no patch" rather than as
 * "a patch that clears everything" — an empty block is a no-op either way (see `foldWorldState`).
 */
export function recordPatchOnly(patch: string): { patch: string; droppedProse: boolean } {
  const { document } = parseStateDocument(patch);
  return {
    patch: renderWorldState({
      prose: '',
      tasks: document.tasks ?? {},
      playerItems: document.playerItems ?? {},
    }),
    droppedProse: budgetedText(document.raw) !== '',
  };
}

export function foldWorldState(versions: readonly string[]): WorldStateFold {
  const parts: WorldStateParts = { prose: '', tasks: {}, playerItems: {} };
  for (const version of versions) {
    const { document } = parseStateDocument(version);
    // Everything that is not a record block. A patch carrying only blocks says nothing about the
    // prose, and the prose it says nothing about is the prose that stays.
    const prose = budgetedText(document.raw);
    if (prose !== '') parts.prose = prose;
    // An empty block is a no-op rather than an assertion that there is nothing. Asserting
    // emptiness is exactly the destructive operation the merge exists to make unsayable, and a
    // model that opens `<tasks>` and writes no lines has almost certainly changed its mind rather
    // than decided to clear the record.
    Object.assign(parts.tasks, document.tasks ?? {});
    Object.assign(parts.playerItems, document.playerItems ?? {});
  }
  return { ...parts, document: renderWorldState(parts) };
}

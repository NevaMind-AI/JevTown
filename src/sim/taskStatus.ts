import { WORLD_STATE_ID } from '../../engine/prose/contract';
import { parseStateDocument } from '../../engine/prose/stateDocument';
import type { Task } from '../../prototype/content';
import type { MemoryWorld } from '../../prototype/world';
import type { AgenticRuntime } from './agenticRuntime';

/**
 * Reading task progress out of the world-state document (docs/13 §1.2, §1.8 item D).
 *
 * This is the reader half of the flip. `progressTasks` still computes the typed progress and the
 * prose still has to agree with it; what changes here is which of the two the screen believes.
 * Both running at once is the point: while they do, the typed path is a reference implementation
 * for the prose one and `taskDisagreements` is a free measurement of whether a model can hold a
 * step id stable. That instrument disappears when docs/13 §1.5's deletions land, so it is worth
 * having pointed at something first.
 *
 * The rule docs/13 §1.6 makes non-optional runs through every function here: **an unrecognised
 * value is never an error.** A task whose line we cannot read is in progress with an unknown step
 * — it is never failed, never dropped from the board, and never a thrown exception. Unparseable
 * prose degrades the view, never the world.
 */

/** Written when the task is finished. Any other value is meant to be a step id. */
export const DONE = 'done';

export interface ProseTaskState {
  taskId: string;
  /** The step the document names, when it names one this task actually has. */
  step?: Task['steps'][number];
  done: boolean;
  /**
   * What was written, when it was neither `done` nor a step this task has. Kept rather than
   * discarded: it is the measurement, and the reason the board can say "unknown" honestly.
   */
  unrecognised?: string;
}

/**
 * The world-state document as written, or undefined when there is no agentic world.
 *
 * Synchronous on purpose — this is read on the render path, and the store keeps it in memory.
 */
export function readWorldStateDocument(runtime: AgenticRuntime | undefined): string | undefined {
  return runtime?.store.readEntityStateSync(WORLD_STATE_ID);
}

/** The `<tasks>` block of that document, or undefined when there is no block to read. */
export function readWorldTasks(document: string | undefined): Record<string, string> | undefined {
  return document === undefined ? undefined : parseStateDocument(document).document.tasks;
}

/** What the document says about each authored task, in authored order. */
export function proseTaskStates(
  tasks: Task[],
  written: Record<string, string> | undefined,
): ProseTaskState[] {
  if (!written) return [];
  return tasks.map((task) => {
    const value = Object.hasOwn(written, task.id) ? written[task.id].trim() : undefined;
    if (value === undefined) {
      // A task with no line is one nothing has said anything about yet, which is where every
      // task starts. Not an unrecognised value, and not done.
      return { taskId: task.id, done: false };
    }
    if (value.toLowerCase() === DONE) {
      return { taskId: task.id, done: true };
    }
    const step = task.steps.find((candidate) => candidate.id === value);
    return step
      ? { taskId: task.id, step, done: false }
      : { taskId: task.id, done: false, unrecognised: value };
  });
}

/**
 * The step the waypoint should point at: the first unfinished task's step.
 *
 * Undefined covers three different situations that the caller treats the same way — no document,
 * every task done, and a task whose line we could not read. Only the last is a surprise, and
 * `proseTaskStates` keeps it visible for whoever wants to say so.
 */
export function currentProseStep(
  tasks: Task[],
  written: Record<string, string> | undefined,
): { taskId: string; step?: Task['steps'][number] } | undefined {
  for (const state of proseTaskStates(tasks, written)) {
    if (!state.done) return { taskId: state.taskId, step: state.step };
  }
  return undefined;
}

/**
 * Block keys that match no authored task — the silent failure merge creates (docs/13 §4).
 *
 * Under replace semantics a misspelled id was loud: the real line vanished with it, and §1.6's
 * guard rendered the task as unknown. Under merge it is inert. The old line survives untouched,
 * the misspelling lands as a row nothing reads — the reader looks up by authored id and never
 * enumerates the block — and the task holds its previous step for the rest of the run with no
 * signal anywhere. So the reader has to enumerate it once, for this.
 *
 * Generic on the known set so `<player_items>` gets the same treatment against authored item ids
 * the moment anything reads that block.
 */
export function unknownKeys(
  known: readonly string[],
  written: Record<string, unknown> | undefined,
): string[] {
  if (!written) return [];
  return Object.keys(written).filter((key) => !known.includes(key));
}

export interface TaskDisagreement {
  taskId: string;
  /** The step id the document names, `done`, or `(nothing written)`. */
  prose: string;
  /** The step id the typed path computed, or `done`. */
  typed: string;
}

/**
 * Where the two paths differ, for the run-long question docs/13 §1.8 asks: does a model hold a
 * step id stable across rewrites under a word budget?
 *
 * Returns rows, never logs. Where and how loudly to report a disagreement is the caller's
 * decision, and a pure function is the one that can be tested.
 */
export function taskDisagreements(
  tasks: Task[],
  views: ReturnType<MemoryWorld['taskViews']>,
  written: Record<string, string> | undefined,
): TaskDisagreement[] {
  if (!written) return [];
  const rows: TaskDisagreement[] = [];
  for (const state of proseTaskStates(tasks, written)) {
    const task = tasks.find((candidate) => candidate.id === state.taskId)!;
    const view = views.find((candidate) => candidate.id === state.taskId);
    // A task the view does not carry has not been activated yet; the typed path has no opinion,
    // so there is nothing to disagree with.
    if (!view) continue;
    const pending = task.steps.find((step) => !view.completed.includes(step.id));
    const typed = pending ? pending.id : DONE;
    const prose = state.done ? DONE : (state.step?.id ?? state.unrecognised ?? '(nothing written)');
    if (prose !== typed) rows.push({ taskId: state.taskId, prose, typed });
  }
  return rows;
}

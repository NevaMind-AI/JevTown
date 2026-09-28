import type { Content } from './content.js';
import type { State } from './world.js';

/**
 * How many milliseconds of simulation time one story second costs.
 *
 * docs/13 §3.2 keeps two clocks: `draft.time` belongs to the engine and `storyTime` to the
 * fiction. This is the only conversion between them, and it exists because three places were
 * computing it independently and one of them was wrong.
 *
 * Two clock shapes, one answer:
 *
 *   * **batch** (`realSecondsPerTick`/`gameSecondsPerTick`) — the shipped shape. 30 real seconds
 *     buy 600 story seconds, so 50ms per story second. `storyTime` itself only moves in 600s
 *     steps, but the *rate* is this, and that is what a wait has to charge.
 *   * **rate** (`rate` story seconds per real second) — 1000/rate.
 *
 * A world with no story clock at all runs 1:1, which is what `waitUntil` already assumed.
 *
 * The bug this fixes (docs/13 §3.8): `waitUntil` derived the rate as
 * `realSecondsPerTick * 1000 / gameSecondsPerTick`, which is right for batch and silently falls
 * back to 1000 under `rate` — so waiting an hour cost 3,600,000ms of simulation time where living
 * it cost 180,000. Batch and no-clock arithmetic are unchanged by routing through here, which is
 * what keeps existing recordings replayable.
 */
export function msPerStorySecond(content: Content | null | undefined, state: State): number {
  const clock = content?.story.clock;
  if (state.clock) {
    // Batch. `gameSecondsPerTick` is required whenever `realSecondsPerTick` is set, and the
    // content validator enforces both as integers ≥ 1.
    return (state.clock.realSecondsPerTick * 1000) / clock!.gameSecondsPerTick!;
  }
  return clock?.rate ? 1000 / clock.rate : 1000;
}

/**
 * Fiction time now, in story seconds, including the part of the current tick already elapsed.
 *
 * `storyTime` is the stored value and under the batch clock it only moves every
 * `realSecondsPerTick`; this is the smooth reading between those steps. Use it for anything a
 * person or a model reads, and the stored `storyTime` for anything the engine branches on
 * (docs/13 §3.4's keying table).
 */
export function storySecondsNow(content: Content | null | undefined, state: State): number {
  if (!state.clock) return state.storyTime;
  return state.storyTime + state.clock.elapsedMs / msPerStorySecond(content, state);
}

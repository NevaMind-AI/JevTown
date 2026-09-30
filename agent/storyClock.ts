/**
 * Fiction time, as a model is told it.
 *
 * docs/13 §3.5: anything an agent is told about time is `storyTime`, never a wall clock and never
 * the simulation's millisecond counter. This module is the one place that turns the stored story
 * second into words, so the phrasing is the same in every prompt.
 *
 * `storyTime` is seconds on the story's own calendar, not since the run began: the shipped world
 * starts at 64,800 — 18:00 on its first day (`prototype/content.ts`, `startTimeSeconds`). So the
 * day number here is a property of the content's calendar and not of how long anybody has played.
 *
 * The server imports this through `agent/purposes/` (docs/14 §3.2), and runs with type stripping
 * and no build step. So it keeps to no imports, and to TypeScript that only needs erasing.
 */

const SECONDS_PER_DAY = 86_400;

export interface StoryMoment {
  /** 1-based, counting from the first day of the story's calendar. */
  day: number;
  hour: number;
  minute: number;
}

export function storyMoment(storySeconds: number): StoryMoment {
  const clamped = Math.max(0, Math.floor(storySeconds));
  const within = clamped % SECONDS_PER_DAY;
  return {
    day: Math.floor(clamped / SECONDS_PER_DAY) + 1,
    hour: Math.floor(within / 3600),
    minute: Math.floor((within % 3600) / 60),
  };
}

/** `day 2, 06:30` — short enough to sit inside a sentence without taking it over. */
export function formatStoryTime(storySeconds: number): string {
  const { day, hour, minute } = storyMoment(storySeconds);
  return `day ${day}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * How long ago something was, in fiction.
 *
 * Both arguments must be story seconds. Passing one story second and one game millisecond is the
 * mistake docs/13 §3.1 exists to prevent, and it is silent, so callers take the whole span from
 * the same clock or say nothing at all.
 */
export function formatStoryElapsed(fromStorySeconds: number, toStorySeconds: number): string {
  const seconds = Math.max(0, Math.floor(toStorySeconds - fromStorySeconds));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------- dating a memory

/**
 * The clock a memory is dated by.
 *
 * Recency decay asks "how long ago, as the character experiences it" — which is fiction time, not
 * real time. Dating memories by the wall clock made the decay almost inert: at the shipped 20×,
 * a memory an hour old in the fiction is three real minutes old, and `0.99 ** hours` never moves
 * off 1 (docs/13 §3.5).
 *
 * A host with no story clock falls back to game milliseconds. That fallback is a *unit* change, so
 * both the stamp and the elapsed-hours conversion come from here and never from a caller — a stamp
 * written in one unit and read in the other is silent and unrecoverable.
 */
export interface MemoryClock {
  now(): number;
  storyTime(): number | undefined;
}

export function memoryStamp(clock: MemoryClock): number {
  return clock.storyTime() ?? clock.now();
}

/**
 * How many of `memoryStamp`'s units make an hour: 3,600 for story seconds, 3,600,000 for game ms.
 *
 * Every duration compared against a memory stamp — the recency decay, the access throttle — is
 * expressed as hours and scaled through this, so switching units cannot leave one of them behind.
 */
export function memoryUnitsPerHour(clock: MemoryClock): number {
  return clock.storyTime() !== undefined ? 3_600 : 3_600_000;
}

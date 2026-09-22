import type { Recording } from '../../prototype/replay';
import { equal } from '../../prototype/entityRecording';

type Change = [path: string[]] | [path: string[], value: unknown];
type State = Recording['finalState'];
type StoredRecording = Omit<Recording, 'format' | 'events'> & {
  format: 'remaining-time-run-delta-2';
  initialState: State;
  events: (Omit<Recording['events'][number], 'state'> & { changes: Change[] })[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Arrays are replaced as a unit; objects (including the entity registry) store only changed fields.
function changes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string[] = [],
): Change[] {
  const result: Change[] = [];
  for (const key of Object.keys(before))
    if (before[key] !== undefined && (!Object.hasOwn(after, key) || after[key] === undefined))
      result.push([[...path, key]]);
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    const previous = Object.hasOwn(before, key) ? before[key] : undefined;
    if (object(previous) && object(value)) result.push(...changes(previous, value, [...path, key]));
    else if (!equal(previous, value)) result.push([[...path, key], value]);
  }
  return result;
}

export function encodeRecording(run: Recording): StoredRecording {
  const { format, events, initialState, ...metadata } = run;
  if (!initialState || !equal(events.at(-1)?.state ?? initialState, run.finalState))
    throw new Error('Recording endpoint mismatch');
  let previous = initialState;
  return {
    ...metadata,
    format: 'remaining-time-run-delta-2',
    initialState,
    events: events.map(({ state, ...event }, i) => {
      if (event.sequence !== (run.startSequence ?? 0) + i + 1)
        throw new Error('Recording prefix missing or discontinuous');
      const delta = changes(previous, state);
      previous = state;
      return { ...event, changes: delta };
    }),
  };
}

export function decodeRecording(input: unknown): Recording {
  if (
    !object(input) ||
    !['remaining-time-run-delta-1', 'remaining-time-run-delta-2'].includes(input.format as string)
  )
    return input as Recording; // Full-state JSON saves keep their original validation path.
  const hasStart = input.format === 'remaining-time-run-delta-2';
  if (
    !object(input.initialState) ||
    !object(input.finalState) ||
    !Array.isArray(input.events) ||
    input.events.length > 100000 ||
    input.eventCount !== input.events.length
  )
    throw new Error('Invalid compact recording');
  const { format, initialState, events, ...metadata } = input as StoredRecording;
  const state = structuredClone(initialState);
  const restored = events.map((event, i) => {
    if (!object(event) || !Array.isArray(event.changes) || Object.hasOwn(event, 'state'))
      throw new Error('Invalid state changes');
    if (event.sequence !== (metadata.startSequence ?? 0) + i + 1)
      throw new Error('Recording prefix missing or discontinuous');
    const { changes: delta, ...recorded } = event;
    for (const change of delta) {
      if (
        !Array.isArray(change) ||
        (change.length !== 1 && change.length !== 2) ||
        !Array.isArray(change[0]) ||
        !change[0].length ||
        change[0].some(
          (key) =>
            typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key),
        )
      )
        throw new Error('Invalid state change path');
      const path = change[0];
      let parent: Record<string, unknown> = state;
      for (const key of path.slice(0, -1)) {
        if (!Object.hasOwn(parent, key) || !object(parent[key]))
          throw new Error('Invalid state change parent');
        parent = parent[key] as Record<string, unknown>;
      }
      const key = path[path.length - 1];
      if (change.length === 1) {
        if (!Object.hasOwn(parent, key)) throw new Error('Invalid state change deletion');
        delete parent[key];
      } else parent[key] = structuredClone(change[1]);
    }
    return { ...recorded, state: structuredClone(state) };
  });
  if (!equal(state, metadata.finalState)) throw new Error('Recording endpoint mismatch');
  return {
    ...metadata,
    format: 'remaining-time-run-1',
    events: restored,
    ...(hasStart ? { initialState } : {}),
  };
}

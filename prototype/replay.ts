import { MemoryWorld, validAdvance } from './world.js';
import { equal } from './entityRecording.js';

export type Recording = ReturnType<MemoryWorld['recording']>;
export type RecordingBundle = { format: 'remaining-time-saves-1'; chunks: Recording[] };

export function recordingPrefix(source: Recording[], tail: Recording) {
  const chunks = source.filter(
    (c) => c.eventCount && (c.startSequence ?? 0) + c.eventCount <= (tail.startSequence ?? 0),
  );
  if (tail.eventCount || !chunks.length) chunks.push(tail);
  return chunks;
}

function validate(run: Recording, start: number, definition?: Recording) {
  if (
    !run ||
    run.format !== 'remaining-time-run-1' ||
    !['memory-world-1', 'memory-world-2', 'memory-world-3', 'memory-world-4'].includes(run.rules)
  )
    throw new Error('Unsupported recording version');
  if (
    !run.config ||
    !Number.isSafeInteger(run.config.stepMs) ||
    run.config.stepMs < 1 ||
    run.config.stepMs > 60000 ||
    !run.config.npc ||
    !Number.isInteger(run.config.npc.x) ||
    !Number.isInteger(run.config.npc.y) ||
    !Array.isArray(run.events) ||
    run.events.length > 100000 ||
    !run.content
  )
    throw new Error('Invalid recording');
  if (run.eventCount !== run.events.length || (start > 0 && !run.eventCount))
    throw new Error('Recording event count mismatch');
  if ((run.startSequence ?? 0) !== start || !Number.isSafeInteger(start + run.eventCount))
    throw new Error('Recording prefix missing or discontinuous');
  if (
    definition &&
    (run.rules !== definition.rules ||
      !equal(run.content, definition.content) ||
      !equal(run.config, definition.config))
  )
    throw new Error('Recording definition mismatch');
}

export function checkRecordingLink(previous: Recording, next: Recording) {
  if ((next.startSequence ?? 0) !== (previous.startSequence ?? 0) + previous.eventCount)
    throw new Error('Recording prefix missing or discontinuous');
  if (
    next.rules !== previous.rules ||
    !equal(next.content, previous.content) ||
    !equal(next.config, previous.config)
  )
    throw new Error('Recording definition mismatch');
  if (next.initialState && !equal(previous.finalState, next.initialState))
    throw new Error('Recording boundary state mismatch');
}

// Local saves restore the recorded endpoint directly; imported recordings still use createReplay.
export function restoreSnapshot(
  run: Recording,
  clock = Date.now,
  random = Math.random,
  atStart = false,
): MemoryWorld {
  validate(run, run?.startSequence ?? 0);
  const end = (run.startSequence ?? 0) + run.eventCount,
    last = run.events.at(-1),
    snapshot = run.snapshot;
  if (
    !snapshot ||
    snapshot.sequence !== end ||
    (run.eventCount && (last?.sequence !== end || !equal(last.state, run.finalState)))
  )
    throw new Error('Snapshot endpoint mismatch');
  const world = new MemoryWorld(
    clock,
    random,
    {
      width: 5,
      height: 5,
      objectTiles: [],
      spawn: { x: 1, y: 1 },
      npc: run.config.npc,
      stepMs: run.config.stepMs,
    },
    run.rules,
  );
  world.load(run.content.scenes, run.content.story, run.content.npcs);
  const state = run.finalState;
  if (
    !state ||
    Object.keys(world.inspect()).some((key) => !Object.hasOwn(state, key)) ||
    !world.scene(state.sceneId) ||
    !Number.isFinite(state.time) ||
    !Number.isSafeInteger(state.balance) ||
    !Number.isSafeInteger(state.storyTime) ||
    !Number.isFinite(state.player?.x) ||
    !Number.isFinite(state.player?.y)
  )
    throw new Error('Invalid snapshot state');
  const start = run.startSequence ?? 0;
  const startSnapshot = {
    ...snapshot,
    sequence: start,
    requests: snapshot.requests.filter(([, request]) => request.sequence <= start),
  };
  if (run.initialState) {
    if (!start && !equal(world.recordedState(), run.initialState))
      throw new Error('Recording initial state mismatch');
    world.restoreSnapshot(run.initialState, startSnapshot);
  }
  if (atStart) {
    if (!run.initialState) throw new Error('Recording initial state missing');
    return world;
  }
  world.restoreSnapshot(state, snapshot);
  return world;
}

// Embedded content pins history independently of later authoring edits.
export function createReplay(input: unknown, origin?: Recording) {
  const bundle = input as RecordingBundle;
  let chunks = bundle?.format === 'remaining-time-saves-1' ? bundle.chunks : [input as Recording];
  if (!Array.isArray(chunks) || !chunks.length) throw new Error('Invalid recording chunks');
  const offset = origin
    ? (origin.startSequence ?? 0) + origin.eventCount
    : chunks[0]?.initialState
      ? (chunks[0].startSequence ?? 0)
      : 0;
  let total = offset;
  let previous = origin;
  for (const chunk of chunks) {
    validate(chunk, total, origin ?? chunks[0]);
    if (previous) checkRecordingLink(previous, chunk);
    if (chunks.length > 1 && !chunk.eventCount) throw new Error('Empty recording chunk');
    total += chunk.eventCount;
    previous = chunk;
  }
  let definition = chunks[0];
  let recordedAt: number | null = null;
  const clock = () => recordedAt ?? Date.now(),
    random = () => {
      throw new Error('Unrecorded random decision');
    };
  const world = origin
    ? restoreSnapshot(origin, clock, random)
    : definition.initialState
      ? restoreSnapshot(definition, clock, random, true)
      : new MemoryWorld(
          clock,
          random,
          {
            width: 5,
            height: 5,
            objectTiles: [],
            spawn: { x: 1, y: 1 },
            npc: definition.config.npc,
            stepMs: definition.config.stepMs,
          },
          definition.rules,
        );
  if (!origin && !definition.initialState)
    world.load(definition.content.scenes, definition.content.story, definition.content.npcs);
  let index = offset,
    first = offset;
  let continued = false;
  const checkpoints = new Map<number, () => void>([[offset, world.checkpoint()]]);
  const checkEnd = (run: Recording) => {
    if (!equal(world.recordedState(), run.finalState) || !equal(world.history(), run.events))
      throw new Error('Replay final state or event stream mismatch');
  };
  return {
    world,
    get index() {
      return index;
    },
    get start() {
      return first;
    },
    get total() {
      return total;
    },
    get nextDelayMs() {
      if (index === total) return undefined;
      const run = chunks.find((c) => (c.startSequence ?? 0) + c.eventCount > index);
      const cause = run?.events[index - (run.startSequence ?? 0)]?.cause;
      if (!cause || (cause.type === 'advance' && !validAdvance(cause.ms, cause.steps)))
        throw new Error(`Invalid event ${index + 1}`);
      return cause.type === 'advance' ? cause.ms : 0;
    },
    get checkpointCount() {
      return checkpoints.size;
    },
    // Streaming restore retains only the current disk chunk and its replay cache.
    append(input: unknown) {
      if (continued || index !== total) throw new Error('Finish replay before appending');
      this.step();
      const run = input as Recording;
      validate(run, total, definition);
      checkRecordingLink(chunks[chunks.length - 1], run);
      world.releaseRecording(index);
      first = index;
      chunks = [run];
      definition = run;
      total += run.eventCount;
      checkpoints.clear();
      checkpoints.set(index, world.checkpoint());
    },
    seek(target: number) {
      if (continued) throw new Error('Replay has been continued as a game');
      if (!Number.isInteger(target) || target < first || target > total)
        throw new Error('Invalid replay position');
      if (target < index) {
        const start = Math.max(...[...checkpoints.keys()].filter((k) => k <= target));
        checkpoints.get(start)!();
        index = start;
        recordedAt = null;
      }
      while (index < target) this.step();
    },
    continueGame() {
      continued = true;
      recordedAt = null;
      return world;
    },
    step() {
      if (continued) throw new Error('Replay has been continued as a game');
      if (index === total) {
        checkEnd(chunks[chunks.length - 1]);
        recordedAt = null;
        return false;
      }
      // ponytail: linear chunk lookup for manual bundle playback; index if thousands of slots matter.
      const run = chunks.find((c) => (c.startSequence ?? 0) + c.eventCount > index)!;
      const start = run.startSequence ?? 0;
      if (index === start) {
        if (run.initialState && !equal(world.recordedState(), run.initialState))
          throw new Error('Recording boundary state mismatch');
        if (world.recordingStats().startSequence !== start) world.releaseRecording(start);
      }
      const event = run.events[index - start];
      if (
        !event ||
        event.sequence !== index + 1 ||
        !Number.isFinite(event.recordedAt) ||
        !event.cause
      )
        throw new Error(`Invalid event ${index + 1}`);
      recordedAt = event.recordedAt;
      const result =
        event.cause.type === 'advance'
          ? world.advance(event.cause.ms, event.cause.steps)
          : world.execute(event.cause);
      if (!equal(result, event.result) || !equal(world.recordedState(), event.state))
        throw new Error(`Replay diverged at event ${index + 1}`);
      index++;
      if (index === start + run.eventCount) checkEnd(run);
      if (index % 2000 === 0 && !checkpoints.has(index)) {
        checkpoints.set(index, world.checkpoint());
        if (checkpoints.size > 9)
          checkpoints.delete([...checkpoints.keys()].find((k) => k !== first)!);
      }
      if (index === total) recordedAt = null;
      return true;
    },
  };
}

export function replayRecording(input: unknown): MemoryWorld {
  const replay = createReplay(input);
  while (replay.step()) {
    /* Execute every event, independent of rendering cadence. */
  }
  return replay.world;
}

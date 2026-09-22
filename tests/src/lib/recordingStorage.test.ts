import { readFileSync } from 'node:fs';
import { loadPackage } from '../../../prototype/package';
import { MemoryWorld } from '../../../prototype/world';
import {
  checkRecordingLink,
  createReplay,
  replayRecording,
  restoreSnapshot,
} from '../../../prototype/replay';
import { decodeRecording, encodeRecording } from '../../../src/lib/recordingStorage';

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = async (path: string) =>
  JSON.parse(
    readFileSync(
      `${path.startsWith('maps/') || path.startsWith('animations/') ? 'src' : 'public'}/content/remaining-time/${path}`,
      'utf8',
    ),
  );

async function world() {
  const content = await loadPackage(await read('manifest.json'), read);
  const result = new MemoryWorld(
    () => 1,
    () => 0,
  );
  result.load(content.scenes, content.story, content.npcs);
  return result;
}

test('compact room saves retain exact events, snapshots, mixed legacy playback, seeking and continuation', async () => {
  const live = await world();
  expect(decodeRecording(json(encodeRecording(live.recording())))).toEqual(json(live.recording()));
  const move = { requestId: 'compact-move', type: 'move', dx: 0, dy: -1 };
  live.execute(move);
  for (let i = 0; i < 100; i++) expect(live.advance(100).ok).toBe(true);
  const original = live.recording();
  const encoded = encodeRecording(original);
  const decoded = decodeRecording(json(encoded));
  const fullBytes = Buffer.byteLength(JSON.stringify(original));
  const compactBytes = Buffer.byteLength(JSON.stringify(encoded));
  expect(compactBytes).toBeLessThan(fullBytes / 5);
  console.info(`26-room save: ${fullBytes} bytes full -> ${compactBytes} bytes compact`);
  expect(decoded).toEqual(json(original));
  const legacyDelta = json({
    ...encoded,
    format: 'remaining-time-run-delta-1',
    initialState: original.events[0].state,
  });
  legacyDelta.events[0].changes = [];
  const { initialState, ...legacyFull } = json(original);
  expect(decodeRecording(legacyDelta)).toEqual(legacyFull);
  expect(live.recording()).toEqual(original);
  expect(replayRecording(decoded).inspect()).toEqual(live.inspect());
  const resumed = restoreSnapshot(decoded);
  expect(resumed.inspect()).toEqual(live.inspect());
  resumed.execute(move);
  expect(resumed.recordingStats().eventCount).toBe(0);

  live.releaseRecording(live.recordingStats().end);
  expect(live.advance(100).ok).toBe(true);
  const legacy = json(live.recording());
  expect(decodeRecording(legacy)).toBe(legacy);
  const replay = createReplay({ format: 'remaining-time-saves-1', chunks: [decoded, legacy] });
  replay.seek(replay.total);
  replay.seek(1);
  replay.seek(replay.total);
  const branch = replay.continueGame();
  expect(branch.inspect()).toEqual(live.inspect());
  branch.advance(100);
  live.advance(100);
  expect(branch.inspect()).toEqual(live.inspect());
  const streamed = createReplay(legacy, decoded);
  streamed.seek(streamed.total);
  expect(streamed.world.inspect()).toEqual(restoreSnapshot(legacy).inspect());
});

test('state deltas preserve additions, deletions, arrays, nulls and independent event states', async () => {
  const live = await world();
  live.advance(100);
  live.advance(100);
  live.advance(100);
  const run = live.recording();
  const [first, second, third] = run.events.map((event) => event.state);
  first.dialogueTopic = 'greeting';
  second.vars.extra = true;
  second.entities.n07.path = [
    [1, 2],
    [3, 4],
  ];
  second.entities.n07.moving = { target: { x: 1, y: 2 }, arrivesAt: 400 };
  delete third.entities.n07;
  third.clues = ['clue'];
  run.finalState = third;
  const stored = json(encodeRecording(run));
  const decoded = decodeRecording(stored);
  expect(decoded).toEqual(json(run));
  decoded.events[0].state.entities.n07.position[0] = -100;
  expect(decoded.events[1].state.entities.n07.position).toEqual(second.entities.n07.position);
  expect(stored.initialState.entities.n07.position).toEqual(first.entities.n07.position);
});

test('compact saves reject malformed changes and unsafe object paths', async () => {
  const live = await world();
  live.advance(100);
  const stored = json(encodeRecording(live.recording()));
  for (const change of [
    [[], 1],
    [['__proto__', 'polluted'], true],
    [['constructor', 'prototype', 'polluted'], true],
    [['entities', 'absent', 'name'], 'bad'],
    [['player', 'x', 'nested'], 1],
    [['absent']],
    [['time'], 1, 2],
  ]) {
    const bad = json(stored);
    bad.events[0].changes = [change] as (typeof bad.events)[0]['changes'];
    expect(() => decodeRecording(bad)).toThrow('Invalid state change');
  }
  expect(() => decodeRecording({ ...stored, eventCount: 2 })).toThrow('Invalid compact recording');
});

test('timer-only steps accumulate without events and save exactly the start and endpoint', async () => {
  const live = await world(),
    reference = await world();
  const initial = live.inspect();
  for (let i = 0; i < 100; i++) {
    expect(live.step(100).ok).toBe(true);
    expect(reference.advance(100).ok).toBe(true);
  }
  expect(live.recordingStats().eventCount).toBe(0);
  expect(live.recordingStats().pendingMs).toBe(10000);
  expect(live.inspect()).toEqual(reference.inspect());
  const checkpoint = live.checkpoint();
  const run = live.recording();
  expect(run.eventCount).toBe(1);
  expect(run.events[0].cause).toEqual({ type: 'advance', ms: 10000, steps: [[100, 100]] });
  const stored = json(encodeRecording(run));
  expect(stored.initialState).toEqual(json(initial));
  expect(stored.finalState).toEqual(json(live.inspect()));
  expect(stored.events.every((event) => !Object.hasOwn(event, 'state'))).toBe(true);
  expect(replayRecording(decodeRecording(stored)).inspect()).toEqual(live.inspect());
  const oldBytes = Buffer.byteLength(JSON.stringify(reference.recording()));
  const bytes = Buffer.byteLength(JSON.stringify(stored));
  console.info(`100 idle steps: 100 -> ${run.eventCount} events, ${oldBytes} -> ${bytes} bytes`);
  expect(bytes).toBeLessThan(oldBytes / 10);
  checkpoint();
  expect(live.recordingStats().eventCount).toBe(0);
  expect(live.recordingStats().pendingMs).toBe(10000);
  expect(live.recording()).toEqual(run);

  // A write can finish after another idle step: its time belongs to the next segment.
  live.step(17);
  live.releaseRecording(run.eventCount);
  expect(live.recordingStats().pendingMs).toBe(17);
  const next = decodeRecording(json(encodeRecording(live.recording())));
  checkRecordingLink(run, next);
  expect(next.initialState).toEqual(run.finalState);
  const replay = createReplay(next);
  expect(replay.world.inspect()).toEqual(run.finalState);
  replay.seek(replay.total);
  expect(replay.world.inspect()).toEqual(live.inspect());
  expect(restoreSnapshot(next).inspect()).toEqual(live.inspect());
});

test('commands and movement retain idle timing, exact step sizes and branching behavior', async () => {
  const live = await world(),
    reference = await world();
  for (const ms of [17, 83]) {
    live.step(ms);
    reference.advance(ms);
  }
  const move = { requestId: 'sparse-move', type: 'move', dx: 0, dy: -1 };
  expect(live.execute(move)).toEqual(reference.execute(move));
  expect(live.recordingStats().eventCount).toBe(2); // Accrued time, then the command.
  for (let i = 0; i < 12; i++) {
    live.step(100);
    reference.advance(100);
    expect(live.inspect()).toEqual(reference.inspect());
  }
  expect(live.recordingStats().eventCount).toBeLessThan(reference.recordingStats().eventCount);
  const run = decodeRecording(json(encodeRecording(live.recording())));
  expect(run.events[0].cause).toEqual({
    type: 'advance',
    ms: 100,
    steps: [
      [17, 1],
      [83, 1],
    ],
  });
  const replay = createReplay(run);
  replay.seek(replay.total);
  replay.seek(2);
  const branch = replay.continueGame();
  for (let i = 0; i < 12; i++) branch.step(100);
  expect(branch.inspect()).toEqual(live.inspect());
  expect(replayRecording(branch.recording()).inspect()).toEqual(live.inspect());
  const restored = restoreSnapshot(run);
  restored.execute(move);
  expect(restored.recordingStats().eventCount).toBe(0);
  const before = restored.inspect();
  for (const steps of [[[100, 0]], [[100, 100001]], [[-1, 1]], [[100, 1]]])
    expect(restored.advance(200, steps as [number, number][]).ok).toBe(false);
  expect(restored.inspect()).toEqual(before);
});

test('endpoint and cross-segment calibration rejects inconsistent saves', async () => {
  const live = await world();
  live.step(100);
  const first = live.recording();
  live.releaseRecording(first.eventCount);
  live.step(100);
  const second = live.recording();
  const badEnd = json(encodeRecording(second));
  badEnd.finalState.balance++;
  expect(() => decodeRecording(badEnd)).toThrow('endpoint mismatch');
  const badDelta = json(encodeRecording(second));
  badDelta.events[0].changes.push([['balance'], second.finalState.balance + 1]);
  expect(() => decodeRecording(badDelta)).toThrow('endpoint mismatch');
  const badStart = json(encodeRecording(second));
  badStart.initialState.player.x++;
  expect(() => decodeRecording(badStart)).toThrow('endpoint mismatch');
  const shifted = json(second);
  shifted.initialState!.balance++;
  shifted.finalState.balance++;
  shifted.events.forEach((event) => event.state.balance++);
  const decoded = decodeRecording(json(encodeRecording(shifted)));
  expect(() => checkRecordingLink(first, decoded)).toThrow('boundary state mismatch');
  expect(() =>
    createReplay({ format: 'remaining-time-saves-1', chunks: [first, decoded] }),
  ).toThrow('boundary state mismatch');
});

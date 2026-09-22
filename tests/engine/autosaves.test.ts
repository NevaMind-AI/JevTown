import { MemoryWorld } from '../../prototype/world';
import { createReplay, recordingPrefix, replayRecording } from '../../prototype/replay';
import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';

test('persisted prefixes rotate without losing concurrent events, movement or deduplication; chunks replay and branch continuously', () => {
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load([room, corridor], story);
  const move = { requestId: 'move', type: 'move', dx: 1, dy: 0 };
  const bad = { requestId: 'bad', type: 'interact', target: 'n07' };
  expect(world.execute(move).ok).toBe(true);
  world.advance(500);
  expect(world.execute(bad).ok).toBe(false);
  const first = world.recording(),
    boundary = world.recordingStats().end;
  world.advance(100); // A write can complete after new events have already committed in memory.
  world.releaseRecording(boundary);
  expect(world.recordingStats().eventCount).toBe(1);
  expect(world.inspect().moving).not.toBeNull();
  expect(world.execute(move).ok).toBe(true);
  expect(world.execute(bad).ok).toBe(false);
  expect(world.recordingStats().eventCount).toBe(1);
  const second = world.recording();
  world.releaseRecording(world.recordingStats().end);
  world.advance(400);
  const third = world.recording(),
    chunks = [first, second, third],
    bundle = { format: 'remaining-time-saves-1', chunks };
  expect(replayRecording(bundle).inspect()).toEqual(world.inspect());
  const stream = createReplay(first);
  stream.seek(stream.total);
  stream.append(second);
  stream.seek(stream.total);
  stream.append(third);
  stream.seek(stream.total);
  expect(stream.world.inspect()).toEqual(world.inspect());
  const before = stream.world.recordingStats().end;
  expect(stream.world.execute(move).ok).toBe(true);
  expect(stream.world.execute(bad).ok).toBe(false);
  expect(stream.world.recordingStats().end).toBe(before);
  const replay = createReplay(bundle);
  replay.seek(replay.total);
  replay.seek(boundary + 1);
  const live = replay.continueGame();
  live.advance(200);
  const prefix = recordingPrefix(chunks, live.recording());
  expect(prefix).toHaveLength(2);
  expect(replayRecording({ format: 'remaining-time-saves-1', chunks: prefix }).inspect()).toEqual(
    live.inspect(),
  );
  expect(replayRecording(second).inspect().time).toBe(second.finalState.time);
  expect(() => createReplay({ ...second, initialState: undefined })).toThrow('prefix');
  expect(() => createReplay({ ...bundle, chunks: [first, third] })).toThrow('discontinuous');
  expect(() =>
    createReplay({
      ...bundle,
      chunks: [first, { ...second, config: { ...second.config, stepMs: 100 } }],
    }),
  ).toThrow('definition mismatch');
  const corrupt = structuredClone(bundle);
  corrupt.chunks[1].events[0].state.balance++;
  expect(() => replayRecording(corrupt)).toThrow('boundary state mismatch');
  expect(() => world.releaseRecording(world.recordingStats().end + 1)).toThrow('boundary');
});

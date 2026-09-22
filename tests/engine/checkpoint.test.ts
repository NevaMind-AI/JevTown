import { jest } from '@jest/globals';
import { MemoryWorld } from '../../prototype/world';
import { createReplay, replayRecording } from '../../prototype/replay';
import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';

test('checkpoint restores in-flight movement, failed/successful deduplication and history prefix', () => {
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load([room, corridor], story);
  const move = { requestId: 'move', type: 'move', dx: 1, dy: 0 };
  world.execute(move);
  world.advance(500);
  const bad = { requestId: 'bad', type: 'interact', target: 'n07' };
  expect(world.execute(bad).ok).toBe(false);
  const restore = world.checkpoint();
  const original = world.recording();
  const finish = () => {
    expect(world.execute(move).ok).toBe(true);
    expect(world.execute(bad).ok).toBe(false);
    world.advance(500);
    world.execute({ requestId: 'talk', type: 'interact', target: 'n07' });
    return world.recording();
  };
  const first = finish();
  restore();
  expect(world.recording()).toEqual(original);
  expect(finish()).toEqual(first);
  restore();
  world.advance(250);
  expect(replayRecording(world.recording()).inspect()).toEqual(world.inspect());
});

test('cached seeks reproduce full replay across checkpoint boundaries', () => {
  const w = new MemoryWorld(
    () => 1,
    () => 0,
  );
  // Exercise cache eviction within the event payload budget, independently of NPC data size.
  w.load([{ ...room, entities: [] }], { ...story, interactions: {}, tasks: [] });
  for (let i = 0; i < 20000; i++) expect(w.advance(1).ok).toBe(true);
  const run = w.recording();
  const replay = createReplay(run);
  replay.seek(20000);
  const advance = jest.spyOn(replay.world, 'advance');
  expect(replay.checkpointCount).toBe(9);
  replay.seek(18000);
  expect(advance).not.toHaveBeenCalled();
  replay.seek(2000);
  expect(advance).toHaveBeenCalledTimes(2000); // Evicted cache is rebuilt from preserved history.
  advance.mockRestore();
  for (const target of [2001, 1999, 4000, 0]) {
    replay.seek(target);
    const baseline = createReplay(run);
    baseline.seek(target);
    expect(replay.world.recording()).toEqual(baseline.world.recording());
  }
});

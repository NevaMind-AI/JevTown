import { MemoryWorld } from '../../prototype/world';
import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';

test('history budget stops atomically and does not accumulate rejected requests', () => {
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  const large = structuredClone(story);
  large.vars = {
    ...Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`flag${i}`, false])),
    has_pass: false,
  };
  large.vars.has_pass = false;
  world.load([room, corridor], large);
  let before = world.inspect();
  for (let i = 0; i < 2000 && !world.recordingCapacityReached(); i++) {
    before = world.inspect();
    world.advance(1);
  }
  expect(world.recordingCapacityReached()).toBe(true);
  expect(world.inspect()).toEqual(before);
  const count = world.history().length;
  for (let i = 0; i < 20; i++)
    expect(world.execute({ requestId: `full${i}`, type: 'closeDialogue' }).ok).toBe(false);
  expect(world.history()).toHaveLength(count);
  expect(world.recording().finalState).toEqual(before);
  world.releaseRecording(world.recordingStats().end);
  expect(world.recordingCapacityReached()).toBe(false);
  expect(world.recordingStats().bytes).toBe(0);
  expect(world.advance(1)).toEqual({ ok: true });
  expect(world.inspect().time).toBe(before.time + 1);
  world.reset();
  expect(world.recordingCapacityReached()).toBe(false);
});

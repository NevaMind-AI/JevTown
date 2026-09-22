import { MemoryWorld } from '../../prototype/world';
import { replayRecording } from '../../prototype/replay';
import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';

test('clock settles at the boundary, preserves progress on speed changes and replays exactly', () => {
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load([room, corridor], {
    ...story,
    clock: { realSecondsPerTick: 30, gameSecondsPerTick: 600, idlePauseSeconds: 60 },
  });
  const initial = world.inspect();
  expect(world.advance(15000).ok).toBe(true);
  expect(world.inspect().balance).toBe(initial.balance);
  expect(world.inspect().storyTime).toBe(initial.storyTime);
  expect(world.gameTime()).toBe(initial.storyTime + 300);
  const speed = { requestId: 'speed', type: 'setClockSpeed', seconds: 60 };
  expect(world.execute(speed).ok).toBe(true);
  expect(world.inspect().clock?.elapsedMs).toBe(30000);
  expect(world.gameTime()).toBe(initial.storyTime + 300);
  expect(world.execute(speed).ok).toBe(true);
  expect(world.advance(29999).ok).toBe(true);
  expect(world.inspect().balance).toBe(initial.balance);
  expect(world.advance(1).ok).toBe(true);
  expect(world.inspect().storyTime).toBe(initial.storyTime + 600);
  expect(world.inspect().balance).toBe(initial.balance - 600);
  expect(world.inspect().clock?.elapsedMs).toBe(0);
  const restored = replayRecording(world.recording());
  expect(restored.inspect()).toEqual(world.inspect());
  expect(restored.advance(60000)).toEqual(world.advance(60000));
  expect(restored.inspect()).toEqual(world.inspect());
});

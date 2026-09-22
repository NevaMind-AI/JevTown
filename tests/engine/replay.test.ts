import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';
import { MemoryWorld } from '../../prototype/world';
import { createReplay, replayRecording } from '../../prototype/replay';

test('portable recording replays every state, preserves deduplication and continues identically', () => {
  const world = new MemoryWorld(
    () => 7,
    () => 0,
  );
  world.load([room, corridor], story);
  const move = { requestId: 'move', type: 'move', dx: 1, dy: 0 };
  world.execute(move);
  world.advance(500);
  const run = JSON.parse(JSON.stringify(world.recording()));
  const stepped = createReplay(run);
  expect(stepped.index).toBe(0);
  expect(stepped.world.inspect().moving).toBeNull();
  expect(stepped.step()).toBe(true);
  expect(stepped.index).toBe(1);
  expect(stepped.world.inspect().moving).not.toBeNull();
  stepped.step();
  expect(stepped.step()).toBe(false);
  expect(stepped.world.inspect()).toEqual(world.inspect());
  stepped.seek(0);
  expect(stepped.index).toBe(0);
  expect(stepped.world.inspect().moving).toBeNull();
  stepped.seek(run.events.length);
  expect(stepped.world.inspect()).toEqual(world.inspect());
  expect(() => stepped.seek(-1)).toThrow('position');
  expect(() => stepped.seek(run.events.length + 1)).toThrow('position');
  const branch = createReplay(run);
  branch.seek(1);
  const live = branch.continueGame();
  expect(() => branch.seek(0)).toThrow('continued');
  expect(live.history()).toHaveLength(1);
  live.advance(250);
  expect(live.history()).toHaveLength(2);
  expect(live.inspect().time).toBe(250);
  expect(run.events[1].cause.ms).toBe(500);
  expect(replayRecording(live.recording()).inspect()).toEqual(live.inspect());
  const restored = replayRecording(run);
  expect(restored.inspect()).toEqual(world.inspect());
  expect(restored.execute(move)).toEqual(world.execute(move));
  world.advance(500);
  restored.advance(500);
  const talk = { requestId: 'talk', type: 'interact', target: 'n07' };
  world.execute(talk);
  restored.execute(talk);
  const invalid = { requestId: 'bad', type: 'interact', target: 'missing' };
  expect(world.execute(invalid).ok).toBe(false);
  restored.execute(invalid);
  expect(restored.inspect()).toEqual(world.inspect());
  expect(replayRecording(JSON.parse(JSON.stringify(world.recording()))).inspect()).toEqual(
    world.inspect(),
  );
  run.events[0].state.balance--;
  expect(() => replayRecording(run)).toThrow('diverged');
  expect(() => replayRecording({ ...world.recording(), rules: 'future' })).toThrow('version');
  const truncated = world.recording();
  truncated.events.pop();
  expect(() => replayRecording(truncated)).toThrow('mismatch');
  expect(() => new MemoryWorld().recording()).toThrow('content-driven');
});

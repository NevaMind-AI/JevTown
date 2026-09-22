import { MemoryWorld, formatTime } from '../../prototype/world';

test('local lifecycle, validation, isolation, retries, clock and random injection', () => {
  const world = new MemoryWorld(
    () => 123,
    () => 0,
  );
  const initial = world.inspect();
  const reject = (command: unknown) => {
    const before = world.inspect();
    expect(world.execute(command).ok).toBe(false);
    expect(world.inspect()).toEqual(before);
  };
  reject(null);
  reject({ requestId: 'bad', type: 'move', dx: NaN, dy: 0 });
  reject({ requestId: 'extra', type: 'interact', target: 'n07', admin: true });
  reject({ requestId: 'far', type: 'interact', target: 'n07' });
  expect(world.advance(500).ok).toBe(true);
  const command = { requestId: 'move', type: 'move', dx: 1, dy: 0 };
  expect(world.execute(command)).toEqual({ ok: true });
  const history = world.history();
  expect(world.execute(command)).toEqual({ ok: true });
  expect(world.history()).toEqual(history);
  reject({ ...command, dx: -1 });
  expect(world.advance(999).ok).toBe(true);
  expect(world.inspect().player).toEqual(initial.player);
  expect(world.advance(1).ok).toBe(true);
  expect(world.inspect().player).toEqual({ x: 2, y: 1 });
  reject({ ...command, requestId: 'blocked' });
  reject({ requestId: 'unknown', type: 'interact', target: 'other' });
  expect(world.execute({ requestId: 'talk', type: 'interact', target: 'n07' }).ok).toBe(true);
  expect(world.inspect().npc.interactions).toBe(1);
  expect(world.execute({ requestId: 'talk', type: 'interact', target: 'n07' }).ok).toBe(true);
  expect(world.inspect().npc.interactions).toBe(1);
  const before = world.inspect();
  expect(world.advance(Infinity).ok).toBe(false);
  expect(world.inspect()).toEqual(before);
  expect(world.history().every((event) => event.recordedAt === 123)).toBe(true);
  const copy = world.inspect();
  copy.npc.interactions = 99;
  expect(world.inspect()).toEqual(before);
  expect(JSON.parse(JSON.stringify(before))).toEqual(before);
  world.reset();
  expect(world.inspect()).toEqual(initial);
  expect(world.history()).toEqual([]);
  expect(world.execute(command).ok).toBe(true);
});

test('legacy world keeps explicit clocks during movement cancellation and dialogue locking', () => {
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  const initial = world.inspect();
  let id = 0;
  const send = (command: object) => world.execute({ requestId: String(++id), ...command });
  expect(formatTime(25200)).toBe('7:00:00');
  expect(formatTime(90061)).toBe('25:01:01');
  expect(formatTime(-1800)).toBe('-0:30:00');
  expect(() => formatTime(NaN)).toThrow();
  expect(send({ type: 'move', dx: 2, dy: 0 }).ok).toBe(false);
  expect(send({ type: 'move', dx: 1, dy: 0 }).ok).toBe(true);
  world.advance(6000);
  expect(world.inspect().player).toEqual({ x: 2, y: 1 });
  expect(world.inspect().balance).toBe(initial.balance);
  expect(world.inspect().storyTime).toBe(initial.storyTime);
  expect(send({ type: 'move', dx: 0, dy: 1 }).ok).toBe(true);
  expect(send({ type: 'cancel' }).ok).toBe(true);
  world.advance(10000);
  expect(world.inspect().player).toEqual({ x: 2, y: 1 });
  expect(send({ type: 'interact', target: 'n07' }).ok).toBe(true);
  expect(send({ type: 'move', dx: 0, dy: 1 }).ok).toBe(false);
  expect(send({ type: 'closeDialogue' }).ok).toBe(true);
  expect(world.inspect().balance).toBe(initial.balance);
  expect(world.inspect().storyTime).toBe(initial.storyTime);
});

test('facing follows steps, and persists after stopping', () => {
  const world = new MemoryWorld();
  for (const [dx, dy, orientation] of [
    [1, 0, 0],
    [0, 1, 90],
    [-1, 0, 180],
    [0, -1, 270],
  ]) {
    expect(world.execute({ requestId: `step-${orientation}`, type: 'move', dx, dy }).ok).toBe(true);
    expect(world.inspect().orientation).toBe(orientation);
    world.advance(1000);
    expect(world.inspect().orientation).toBe(orientation);
  }
  world.execute({ requestId: 'turn', type: 'move', dx: 0, dy: 1 });
  expect(world.inspect().orientation).toBe(90);
  world.execute({ requestId: 'cancel', type: 'cancel' });
  expect(world.inspect().orientation).toBe(90);
  world.advance(1000);
  expect(world.inspect().player).toEqual({ x: 1, y: 1 });
  world.reset();
  expect(world.inspect().orientation).toBe(90);
});

test('map layers block direct movement', () => {
  const tiles = Array.from({ length: 5 }, () => Array(5).fill(-1));
  tiles[2][1] = 7;
  const world = new MemoryWorld(
    () => 1,
    () => 0,
    {
      width: 5,
      height: 5,
      objectTiles: [tiles],
      spawn: { x: 1, y: 1 },
      npc: { x: 3, y: 1 },
      stepMs: 160,
    },
  );
  const before = world.inspect();
  expect(world.execute({ requestId: 'wall', type: 'move', dx: 1, dy: 0 }).ok).toBe(false);
  expect(world.inspect()).toEqual({ ...before, orientation: 0 });
  expect(world.execute({ requestId: 'step', type: 'move', dx: 0, dy: 1 }).ok).toBe(true);
  world.advance(160);
  expect(world.inspect().player).toEqual({ x: 1, y: 2 });
});

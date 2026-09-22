import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';
import { loadContent } from '../../prototype/content';
import { MemoryWorld } from '../../prototype/world';

test('NPC and player face each other on successful interaction from all four sides', () => {
  for (const [position, orientation] of [
    [[4, 5], 180],
    [[6, 5], 0],
    [[5, 4], 270],
    [[5, 6], 90],
  ] as [number[], number][]) {
    const scene = structuredClone(room);
    scene.anchors.start = position;
    const world = new MemoryWorld();
    world.load([scene, corridor], story);
    expect(world.execute({ requestId: 'talk', type: 'interact', target: 'n07' }).ok).toBe(true);
    expect(world.inspect().entities.n07.orientation).toBe(orientation);
    expect(world.inspect().orientation).toBe((orientation + 180) % 360);
    const before = world.inspect();
    expect(world.execute({ requestId: 'invalid', type: 'interact', target: 'missing' }).ok).toBe(
      false,
    );
    expect(world.inspect()).toEqual(before);
  }
});

test('JSON permission, payment, roundtrip, stale choices and atomic failure', () => {
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load([room, corridor], story);
  let n = 0;
  const send = (c: object) => world.execute({ requestId: `c${n++}`, ...c });
  const move = (dx: number, dy: number, count = 1) => {
    for (let i = 0; i < count; i++) {
      expect(send({ type: 'move', dx, dy }).ok).toBe(true);
      world.advance(1000);
    }
  };
  move(1, 0);
  send({ type: 'interact', target: 'n07' });
  const revision = world.inspect().interactionRevision;
  expect(send({ type: 'choose', choice: 'permit', revision }).ok).toBe(true);
  expect(world.inspect().vars.has_pass).toBe(true);
  expect(send({ type: 'choose', choice: 'service', revision }).ok).toBe(false);
  send({ type: 'interact', target: 'n07' });
  const payment = {
    requestId: 'pay',
    type: 'choose',
    choice: 'service',
    revision: world.inspect().interactionRevision,
  };
  expect(world.execute(payment).ok).toBe(true);
  expect(world.execute(payment).ok).toBe(true);
  expect(world.inspect().balance).toBe(23400);
  move(0, 1);
  move(1, 0, 5);
  move(0, -1);
  const enter = { requestId: 'enter', type: 'move', dx: 1, dy: 0 };
  expect(world.execute(enter).ok).toBe(true);
  expect(world.inspect().sceneId).toBe('corridor');
  expect(world.inspect().player).toEqual({ x: 2, y: 3 });
  expect(world.execute(enter).ok).toBe(true);
  expect(world.inspect().sceneId).toBe('corridor');
  expect(send({ type: 'move', dx: -1, dy: 0 }).ok).toBe(true);
  expect(world.inspect().sceneId).toBe('room');
  expect(world.inspect().player).toEqual({ x: 9, y: 5 });
  expect(world.inspect().balance).toBe(23400);
  expect(world.inspect().vars.has_pass).toBe(true);
  const snapshot = world.inspect();
  expect(() => world.load([room], story)).toThrow();
  expect(world.inspect()).toEqual(snapshot);
});

test('reject invalid contract and keep locked portal choice unavailable', () => {
  for (const mutate of [
    (r: any) => (r.schema_version = '9'),
    (r: any) => (r.entities[1].portal.anchor = 'missing'),
    (r: any) => (r.map.extra = true),
    (r: any) => (r.entities[0].position = [0, 0]),
  ]) {
    const r = structuredClone(room);
    mutate(r);
    expect(() => loadContent([r, corridor], story)).toThrow();
  }
  const world = new MemoryWorld();
  world.load([room, corridor], story);
  let id = 0;
  for (const [dx, dy, count] of [
    [0, 1, 1],
    [1, 0, 6],
    [0, -1, 1],
  ])
    for (let i = 0; i < count; i++) {
      world.execute({ requestId: String(id++), type: 'move', dx, dy });
      world.advance(1000);
    }
  expect(world.execute({ requestId: 'door', type: 'interact', target: 'room.exit' }).ok).toBe(
    false,
  );
  expect(world.choices()).toEqual([]);
  const before = world.inspect();
  expect(world.execute({ requestId: 'locked', type: 'move', dx: 1, dy: 0 }).ok).toBe(false);
  expect(world.inspect()).toEqual({ ...before, orientation: 0 });
});

test('story binds directly to entity IDs; inert entities need no story entry', () => {
  const changed = structuredClone(story);
  changed.interactions.n07.text = 'Entity-owned dialogue';
  const world = new MemoryWorld();
  world.load([room, corridor], changed);
  world.execute({ requestId: 'move', type: 'move', dx: 1, dy: 0 });
  world.advance(1000);
  world.execute({ requestId: 'talk', type: 'interact', target: 'n07' });
  expect(world.inspect().npc.reply).toBe('Entity-owned dialogue');
  const unknown = {
    ...changed,
    interactions: { ...changed.interactions, ghost: changed.interactions.n07 },
  };
  expect(() => loadContent([room, corridor], unknown)).toThrow('unknown entity');
  const inertStory = structuredClone(story);
  inertStory.tasks = [];
  delete (inertStory.interactions as Record<string, unknown>).n07;
  const inert = new MemoryWorld();
  inert.load([room, corridor], inertStory);
  inert.execute({ requestId: 'move', type: 'move', dx: 1, dy: 0 });
  inert.advance(1000);
  expect(inert.nearby()).toEqual([]);
  expect(inert.execute({ requestId: 'talk', type: 'interact', target: 'n07' }).ok).toBe(false);
});

test('JSON tasks advance in order on actual movement and matching interaction', () => {
  const world = new MemoryWorld();
  world.load([room, corridor], story);
  let id = 0;
  const send = (c: object) => world.execute({ requestId: String(id++), ...c });
  send({ type: 'move', dx: 1, dy: 0 });
  send({ type: 'cancel' });
  expect(world.taskViews()[0].progress.walk?.count ?? 0).toBe(0);
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 0],
  ]) {
    expect(send({ type: 'move', dx, dy }).ok).toBe(true);
    world.advance(1000);
  }
  expect(world.taskViews()[0].completed).toEqual(['walk']);
  send({ type: 'interact', target: 'n07' });
  expect(world.taskViews()[0].completed).toEqual(['walk', 'talk']);
  world.reset();
  expect(world.taskViews()[0].completed).toEqual([]);
  const invalid = structuredClone(story);
  invalid.tasks[0].steps[1].condition.where!.entityId = 'missing';
  expect(() => loadContent([room, corridor], invalid)).toThrow('task entity');
  const changed = structuredClone(story);
  changed.tasks[0].title = 'JSON title';
  changed.tasks[0].steps.reverse();
  const reordered = new MemoryWorld();
  reordered.load([room, corridor], changed);
  reordered.execute({ requestId: 'm', type: 'move', dx: 1, dy: 0 });
  reordered.advance(1000);
  expect(reordered.taskViews()[0].progress.walk?.count ?? 0).toBe(0);
  reordered.execute({ requestId: 'i', type: 'interact', target: 'n07' });
  expect(reordered.taskViews()[0].title).toBe('JSON title');
  expect(reordered.taskViews()[0].completed).toEqual(['talk']);
});

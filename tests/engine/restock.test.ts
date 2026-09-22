import { shopFixture as pack } from './shop.testHelpers';
import { loadContent } from '../../prototype/content';
import { MemoryWorld } from '../../prototype/world';
import { createReplay, replayRecording } from '../../prototype/replay';
const day = 86400,
  start = 18 * 3600;
test('daily replenishment uses explicit game time, with exact boundaries, atomic recording, dedup and checkpoint continuation', async () => {
  const content = await pack(),
    original = JSON.stringify(content);
  let clock = 1,
    failClock = false;
  const world = new MemoryWorld(
    () => {
      if (failClock) throw Error('clock failure');
      return clock;
    },
    () => 0,
  );
  world.load(content.scenes, content.story, content.npcs);
  world.execute({ requestId: 'talk', type: 'interact', target: 'merchant' });
  world.execute({
    requestId: 'buy',
    type: 'buy',
    target: 'merchant',
    item: 'spring-water',
    quantity: 1,
    revision: world.inspect().interactionRevision,
  });
  const stock = () => world.inspect().commerce!.stock['merchant']['spring-water'];
  expect(stock()).toBe(29);
  expect(world.inspect().commerce!.nextRestock).toEqual({ merchant: start + day });
  clock += day * 1000;
  world.advance(60000);
  expect(stock()).toBe(29);
  expect(world.inspect().storyTime).toBe(start);
  expect(
    world.execute({ requestId: 'almost', type: 'advanceStoryTime', seconds: day - 1 }).ok,
  ).toBe(true);
  expect(stock()).toBe(29);
  const restore = world.checkpoint(),
    before = world.recording(),
    revision = world.inspect().interactionRevision;
  const due = { requestId: 'due', type: 'advanceStoryTime', seconds: 1 };
  failClock = true;
  expect(() => world.execute(due)).toThrow('clock failure');
  expect(world.recording()).toEqual(before);
  failClock = false;
  expect(world.execute(due)).toEqual({ ok: true });
  const replenished = world.recording();
  expect(stock()).toBe(30);
  expect(world.inspect().storyTime).toBe(start + day);
  expect(world.inspect().commerce!.nextRestock!['merchant']).toBe(start + 2 * day);
  expect(world.inspect().balance).toBe(before.finalState.balance);
  expect(world.inspect().commerce!.inventory).toEqual(before.finalState.commerce!.inventory);
  expect(world.execute(due)).toEqual({ ok: true });
  expect(world.recording()).toEqual(replenished);
  expect(
    world.execute({
      requestId: 'stale',
      type: 'buy',
      target: 'merchant',
      item: 'spring-water',
      quantity: 1,
      revision,
    }).ok,
  ).toBe(false);
  expect(world.inspect()).toEqual(replenished.finalState);
  expect(replayRecording(world.recording()).inspect()).toEqual(world.inspect());
  restore();
  expect(world.recording()).toEqual(before);
  expect(world.execute(due)).toEqual({ ok: true });
  expect(world.recording()).toEqual(replenished);
  const replay = createReplay(replenished);
  replay.seek(before.eventCount);
  const branch = replay.continueGame();
  expect(branch.execute(due)).toEqual({ ok: true });
  expect(branch.inspect()).toEqual(replenished.finalState);
  expect(branch.execute({ requestId: 'tomorrow', type: 'advanceStoryTime', seconds: day }).ok).toBe(
    true,
  );
  expect(replayRecording(branch.recording()).inspect()).toEqual(branch.inspect());
  expect(JSON.stringify(content)).toBe(original);
  world.reset();
  expect(world.inspect().commerce!.nextRestock!['merchant']).toBe(start + day);
});

test('skipped days preserve schedule phase and surplus stock while unconfigured merchants do not replenish', async () => {
  const content = await pack();
  content.story.shops!['merchant'].offers.find((o) => o.item === 'spring-water')!.stock = 2;
  content.scenes[0].entities.push({
    id: 'supplier',
    name: 'Supplier',
    character: 'f1',
    position: [21, 5],
    interactionOffsets: [[-1, 2]],
  });
  content.story.interactions.supplier = { text: 'Supply', choices: [] };
  content.story.shops!.supplier = {
    name: 'Supply',
    offers: [{ item: 'spring-water', buySeconds: 1, sellSeconds: 0, stock: 5 }],
  };
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load(content.scenes, content.story, content.npcs);
  world.execute({ requestId: 'talk-supply', type: 'interact', target: 'supplier' });
  expect(
    world.execute({
      requestId: 'buy',
      type: 'buy',
      target: 'supplier',
      item: 'spring-water',
      quantity: 3,
      revision: world.inspect().interactionRevision,
    }).ok,
  ).toBe(true);
  world.execute({ requestId: 'talk-hostess', type: 'interact', target: 'merchant' });
  expect(
    world.execute({
      requestId: 'sell',
      type: 'sell',
      target: 'merchant',
      item: 'spring-water',
      quantity: 3,
      revision: world.inspect().interactionRevision,
    }).ok,
  ).toBe(true);
  expect(world.inspect().commerce!.stock['merchant']['spring-water']).toBe(5);
  expect(
    world.execute({ requestId: 'skip', type: 'advanceStoryTime', seconds: 3 * day + 120 }).ok,
  ).toBe(true);
  expect(world.inspect().commerce!.stock['merchant']['spring-water']).toBe(5);
  expect(world.inspect().commerce!.stock.supplier['spring-water']).toBe(2);
  expect(world.inspect().commerce!.nextRestock).toEqual({ merchant: start + 4 * day });
  expect(replayRecording(world.recording()).inspect()).toEqual(world.inspect());
});

test('restock config and clock commands are bounded; old commerce state and existing hour advancement stay compatible', async () => {
  const content = await pack();
  for (const value of [
    null,
    {},
    [],
    { enabled: true, intervalSeconds: day },
    ...[0, -1, 1.5, 604801, true, '86400'].map((intervalSeconds) => ({ intervalSeconds })),
  ]) {
    const story = structuredClone(content.story);
    (story.shops!['merchant'] as any).restock = value;
    expect(() => loadContent(content.scenes, story)).toThrow();
  }
  const hourly = structuredClone(content);
  hourly.story.shops!['merchant'].restock = { intervalSeconds: 3600 };
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load(hourly.scenes, hourly.story, hourly.npcs);
  const before = world.recording();
  for (const seconds of [0, -1, 1.5, 604801, NaN])
    expect(world.execute({ requestId: 'invalid', type: 'advanceStoryTime', seconds }).ok).toBe(
      false,
    );
  expect(
    world.execute({ requestId: 'extra', type: 'advanceStoryTime', seconds: day, now: 1 }).ok,
  ).toBe(false);
  expect(world.recording()).toEqual(before);
  expect(world.execute({ requestId: 'hour', type: 'nextScene' }).ok).toBe(true);
  expect(world.inspect().commerce!.nextRestock!['merchant']).toBe(start + 7200);
  expect(replayRecording(world.recording()).inspect()).toEqual(world.inspect());
  delete content.story.shops!['merchant'].restock;
  const old = new MemoryWorld(
    () => 1,
    () => 0,
  );
  old.load(content.scenes, content.story, content.npcs);
  expect(old.inspect().commerce).not.toHaveProperty('nextRestock');
  expect(old.execute({ requestId: 'day', type: 'advanceStoryTime', seconds: day }).ok).toBe(true);
  expect(old.inspect().commerce).not.toHaveProperty('nextRestock');
  expect(replayRecording(old.recording()).inspect()).toEqual(old.inspect());
});

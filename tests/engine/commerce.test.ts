import { shopFixture as pack } from './shop.testHelpers';
import { loadContent } from '../../prototype/content';
import { MemoryWorld } from '../../prototype/world';
import { createReplay, replayRecording } from '../../prototype/replay';

test('shop purchases and sales atomically update time, inventory and stock with dedup, checkpoints and replay', async () => {
  const content = await pack();
  content.scenes[0].anchors.entrance = [20, 7];
  const original = JSON.stringify(content);
  let clockFails = false;
  const world = new MemoryWorld(
    () => {
      if (clockFails) throw new Error('clock failure');
      return 1;
    },
    () => 0,
  );
  world.load(content.scenes, content.story, content.npcs);
  let id = 0;
  const trade = (type: 'buy' | 'sell', quantity: number) => ({
    requestId: String(id++),
    type,
    target: 'merchant',
    item: 'spring-water',
    quantity,
    revision: world.inspect().interactionRevision,
  });
  const before = world.inspect();
  expect(world.execute(trade('buy', 1)).ok).toBe(false);
  expect(world.inspect()).toEqual(before);
  expect(world.execute({ requestId: 'talk', type: 'interact', target: 'merchant' }).ok).toBe(true);
  const purchase = trade('buy', 3);
  expect(world.execute(purchase)).toEqual({ ok: true });
  const bought = world.inspect(),
    count = world.history().length;
  expect(bought.balance).toBe(25200 - 360);
  expect(bought.commerce!.inventory).toEqual({ 'spring-water': 3 });
  expect(bought.commerce!.stock['merchant']['spring-water']).toBe(27);
  expect(world.execute(purchase)).toEqual({ ok: true });
  expect(world.history()).toHaveLength(count);
  expect(world.execute({ ...purchase, quantity: 2 }).ok).toBe(false);
  expect(world.inspect()).toEqual(bought);
  expect(world.execute({ ...purchase, requestId: 'stale' })).toEqual({
    ok: false,
    error: '交易状态已更新，请重试',
  });
  expect(world.inspect()).toEqual(bought);
  const restore = world.checkpoint();
  const sale = trade('sell', 1);
  expect(world.execute(sale)).toEqual({ ok: true });
  const sold = world.inspect();
  expect(sold.balance).toBe(24900);
  expect(sold.commerce!.inventory['spring-water']).toBe(2);
  expect(sold.commerce!.stock['merchant']['spring-water']).toBe(28);
  expect(world.execute(sale)).toEqual({ ok: true });
  expect(world.inspect()).toEqual(sold);
  restore();
  expect(world.inspect()).toEqual(bought);
  expect(world.execute(purchase)).toEqual({ ok: true });
  expect(world.inspect()).toEqual(bought);
  expect(world.execute(sale)).toEqual({ ok: true });
  expect(world.inspect()).toEqual(sold);
  expect(world.execute(trade('sell', 2)).ok).toBe(true);
  expect(world.inspect().commerce!.inventory).toEqual({});
  expect(world.shopView()!.offers.find((i) => i.id === 'spring-water')!.stock).toBe(30);
  const run = world.recording();
  expect(replayRecording(run).inspect()).toEqual(world.inspect());
  const replay = createReplay(run);
  replay.seek(count);
  expect(replay.world.inspect()).toEqual(bought);
  replay.seek(0);
  replay.seek(count);
  const branch = replay.continueGame();
  expect(branch.execute(purchase)).toEqual({ ok: true });
  expect(branch.inspect()).toEqual(bought);
  expect(branch.execute({ ...sale, requestId: 'branch-sell' }).ok).toBe(true);
  expect(replayRecording(branch.recording()).inspect()).toEqual(branch.inspect());
  expect(JSON.stringify(content)).toBe(original);
  world.reset();
  expect(world.inspect().commerce!.inventory).toEqual({});
  expect(world.inspect().commerce!.stock['merchant']['spring-water']).toBe(30);
  world.execute({ requestId: 'talk-after-reset', type: 'interact', target: 'merchant' });
  const pending = trade('buy', 1),
    beforeClock = world.recording();
  clockFails = true;
  expect(() => world.execute(pending)).toThrow('clock failure');
  expect(world.recording()).toEqual(beforeClock);
  clockFails = false;
  expect(world.execute(pending)).toEqual({ ok: true });
});

test('trade validation rejects unavailable goods, insufficient balances, quantities and stale sessions without partial updates', async () => {
  const content = await pack();
  content.scenes[0].anchors.entrance = [20, 7];
  content.story.shops!['merchant'].offers[0].stock = 99;
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load(content.scenes, content.story, content.npcs);
  world.execute({ requestId: 'talk', type: 'interact', target: 'merchant' });
  let id = 0;
  const command = {
    type: 'buy',
    target: 'merchant',
    item: 'spring-water',
    quantity: 1,
    revision: world.inspect().interactionRevision,
  };
  for (const change of [
    { quantity: 100 },
    { type: 'sell' },
    { item: 'missing' },
    { target: 'missing' },
    { item: 'amber-reserve', quantity: 15 },
    { quantity: 0 },
    { quantity: -1 },
    { quantity: 100 },
    { quantity: 1.5 },
    { buySeconds: 0 },
    { revision: 0 },
  ]) {
    const before = world.inspect();
    expect(world.execute({ ...command, ...change, requestId: String(id++) }).ok).toBe(false);
    expect(world.inspect()).toEqual(before);
  }
  world.execute({ requestId: 'leave', type: 'closeDialogue' });
  const before = world.inspect();
  expect(
    world.execute({ ...command, requestId: 'closed', revision: before.interactionRevision }).ok,
  ).toBe(false);
  expect(world.inspect()).toEqual(before);
  expect(replayRecording(world.recording()).inspect()).toEqual(world.inspect());
});

test('item and shop JSON is strict and old content keeps its original state shape', async () => {
  const content = await pack();
  for (const change of [
    (c: typeof content) => c.story.items!.push(c.story.items![0]),
    (c: typeof content) => (c.story.items![0].image = 'https://example.com/image.png'),
    (c: typeof content) => (c.story.shops!['merchant'].offers[0].item = 'missing'),
    (c: typeof content) =>
      c.story.shops!['merchant'].offers.push(c.story.shops!['merchant'].offers[0]),
    (c: typeof content) =>
      (c.story.shops!['merchant'].offers[0].sellSeconds =
        c.story.shops!['merchant'].offers[0].buySeconds + 1),
    (c: typeof content) => (c.story.shops!['merchant'].offers[0].buySeconds = -1),
    (c: typeof content) => (c.story.shops!['merchant'].offers[0].stock = 10000),
    (c: typeof content) => delete c.story.interactions['merchant'],
  ]) {
    const copy = structuredClone(content);
    change(copy);
    expect(() => loadContent(copy.scenes, copy.story, copy.npcs)).toThrow();
  }
  const special = structuredClone(content);
  special.scenes[0].anchors.entrance = [20, 7];
  special.story.items![0].id = 'toString';
  special.story.shops!['merchant'].offers[0].item = 'toString';
  const safe = new MemoryWorld(
    () => 1,
    () => 0,
  );
  safe.load(special.scenes, special.story, special.npcs);
  safe.execute({ requestId: 'talk', type: 'interact', target: 'merchant' });
  expect(safe.inventoryView()[0].quantity).toBe(0);
  expect(
    safe.execute({
      requestId: 'buy',
      type: 'buy',
      target: 'merchant',
      item: 'toString',
      quantity: 1,
      revision: safe.inspect().interactionRevision,
    }).ok,
  ).toBe(true);
  expect(safe.inventoryView()[0].quantity).toBe(1);
  expect(replayRecording(safe.recording()).inspect()).toEqual(safe.inspect());
  for (const interaction of Object.values(content.story.interactions))
    for (const choice of interaction.choices)
      choice.effects = choice.effects.filter((e) => e.op !== 'give_item');
  content.story.tasks?.forEach((t) => delete t.trigger);
  delete content.story.items;
  delete content.story.shops;
  const old = new MemoryWorld(
    () => 1,
    () => 0,
  );
  old.load(content.scenes, content.story, content.npcs);
  expect(old.inspect()).not.toHaveProperty('commerce');
  expect(replayRecording(old.recording()).inspect()).toEqual(old.inspect());
});

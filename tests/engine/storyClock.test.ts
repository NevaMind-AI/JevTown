import { MemoryWorld } from '../../prototype/world';
import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';

/**
 * The two clocks, and the conversion between them.
 *
 * docs/13 §3.2: `draft.time` belongs to the engine and `storyTime` to the fiction. What is under
 * test is that one conversion serves every path — living through time, waiting, and an author's
 * cut — because three places used to compute it separately and one of them was wrong.
 */

const BATCH = { realSecondsPerTick: 30, gameSecondsPerTick: 600, idlePauseSeconds: 60 };

const build = (clock: unknown, scenes: unknown[] = [room, corridor], extra: object = {}) => {
  const world = new MemoryWorld(
    () => 1,
    () => 0,
  );
  world.load(scenes, { ...story, ...extra, clock });
  return world;
};

describe('the fiction clock', () => {
  test('a wait charges simulation time at the rate living through it would', () => {
    // docs/13 §3.8: `waitUntil` derived its own rate and fell back to 1000ms per story second
    // whenever the batch clock was absent, so under `rate` a wait cost 20× what living cost.
    for (const [label, clock, msPerStorySecond] of [
      ['batch 30s/600s', BATCH, 50],
      ['rate 20', { rate: 20 }, 50],
      ['rate 4', { rate: 4 }, 250],
      ['no story clock', undefined, 1000],
    ] as const) {
      const living = build(clock);
      const before = living.inspect();
      // Live through 10 story seconds and see what it cost in simulation time.
      const livedMs = 10 * msPerStorySecond;
      living.advance(livedMs);
      if (clock) {
        expect([label, living.gameTime() - before.storyTime]).toEqual([label, 10]);
      }

      const waiting = build(clock);
      const start = waiting.inspect();
      waiting.execute({ requestId: 'w', type: 'waitUntil', time: start.storyTime + 3600 });
      const spent = waiting.inspect().time - start.time;
      expect([label, spent]).toEqual([label, 3600 * msPerStorySecond]);
    }
  });

  test('the batch clock is arithmetically unchanged, so old recordings still replay', () => {
    // The helper must be a refactor for the shipped clock, not a behaviour change: `replay.step()`
    // throws on any state mismatch, so a different number here breaks every saved run.
    const world = build(BATCH);
    const start = world.inspect();
    world.advance(15_000);
    world.execute({ requestId: 'w', type: 'waitUntil', time: start.storyTime + 6 * 3600 });
    expect(world.inspect()).toMatchObject({
      time: 1_080_000,
      storyTime: start.storyTime + 6 * 3600,
      balance: start.balance - 6 * 3600,
    });
  });

  test('a cut moves the fiction and spends neither simulation time nor life', () => {
    // docs/13 §3.4: `advanceStoryTime` and `nextScene` are an author cutting, not a character
    // waiting. That split is deliberate and this pins it.
    const cut = build(BATCH);
    const before = cut.inspect();
    cut.execute({ requestId: 'c', type: 'advanceStoryTime', seconds: 3600 });
    expect(cut.inspect()).toMatchObject({
      time: before.time,
      storyTime: before.storyTime + 3600,
      balance: before.balance,
    });

    const waited = build(BATCH);
    waited.execute({ requestId: 'w', type: 'waitUntil', time: before.storyTime + 3600 });
    expect(waited.inspect().time).toBe(180_000);
    expect(waited.inspect().balance).toBe(before.balance - 3600);
  });
});

describe('a cut and the deadlines it crosses', () => {
  // docs/13 §3.4 first claimed a cut left schedules behind. It does not: `execute` runs the
  // schedule pass after every command (`prototype/world.ts`, end of the dispatch block), so a
  // fiction-keyed deadline already fires on a cut. These pin that, because it is the thing the
  // chapter got wrong and the cheapest thing to get wrong again.
  //
  // No shipped content defines a schedule, so the fixture is built here.
  const scheduled = () => {
    const scene = structuredClone(room) as any;
    scene.entities.find((e: any) => e.id === 'n07').movable = true;
    return build(BATCH, [scene, corridor], {
      schedules: {
        n07: { scene: 'room', sleepAt: 72_000, wakeAt: 25_200, entrance: [9, 5], home: [5, 5] },
      },
    });
  };

  test('the fixture starts awake and on duty, before any clock moves', () => {
    // 18:00 start, asleep from 20:00 to 07:00.
    const world = scheduled();
    expect(world.inspect().storyTime).toBe(64_800);
    expect(world.inspect().schedules?.n07).toBe('active');
  });

  test('an authored cut past the sleep boundary moves the schedule, spending no simulation time', () => {
    const world = scheduled();
    world.execute({ requestId: 'c', type: 'advanceStoryTime', seconds: 3 * 3600 }); // 18:00 -> 21:00
    expect(world.inspect()).toMatchObject({ time: 0, storyTime: 75_600 });
    expect(world.inspect().schedules?.n07).toBe('leaving');
  });

  test('living through the same boundary reaches the same phase', () => {
    // The two routes agree, which is what says the deadline is keyed to the fiction clock and not
    // to how the fiction got there.
    const world = scheduled();
    // Three fiction hours at 50ms per story second, in the 60s bites `validAdvance` allows.
    for (let i = 0; i < 9; i++) expect(world.advance(60_000).ok).toBe(true);
    expect(world.inspect().storyTime).toBe(75_600);
    expect(world.inspect().schedules?.n07).not.toBe('active');
  });
});

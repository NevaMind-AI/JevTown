import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';
import { MemoryWorld } from '../../prototype/world';
import type { WorldEntities } from '../../prototype/content';

/**
 * The one deadlock reservation cannot resolve on its own (docs/13 §2.7): two walkers each
 * standing on the other's next tile. Neither can re-route — in a corridor there is nowhere to
 * re-route to — so without a rule they refuse each other forever.
 *
 * It is built from two authored `move_entity` paths, and that is not incidental. A routed
 * destination cannot produce it: `moveEntity` computes against live occupancy and live
 * reservations, so it never hands out a path through somebody. An authored path is the vector,
 * because an author writes tiles, not a route.
 *
 * `wa` stands at (5, 6) and `wb` at (5, 7); the choice sends each onto the other's tile.
 */
const STEP_MS = 1000;

function crossing(paths: { wa: number[][]; wb: number[][] }) {
  const scenes = [structuredClone(room), structuredClone(corridor)];
  (scenes[0] as { anchors: Record<string, number[]> }).anchors = {
    ...scenes[0].anchors,
    post_a: [5, 6],
    post_b: [5, 7],
  };
  const authored = structuredClone(story) as typeof story & { interactions: any };
  authored.interactions.n07.choices.push({
    id: 'pass',
    text: 'Pass',
    effects: [
      { op: 'move_entity', entity: 'wa', path: paths.wa },
      { op: 'move_entity', entity: 'wb', path: paths.wb },
    ],
  });
  const actor = (id: string, character: string, anchor: string) => ({
    id,
    kind: 'actor',
    mobile: true,
    character,
    scene: 'room',
    spawn: { anchor },
  });
  const w = new MemoryWorld();
  w.load(scenes, authored, undefined, {
    entities: [actor('wa', 'f6', 'post_a'), actor('wb', 'f3', 'post_b')],
  } as WorldEntities);
  let id = 0;
  const send = (c: object) => w.execute({ requestId: String(id++), ...c });
  expect(send({ type: 'teleport', sceneId: 'room', x: 4, y: 5 }).ok).toBe(true);
  expect(send({ type: 'interact', target: 'n07' }).ok).toBe(true);
  expect(
    send({ type: 'choose', choice: 'pass', revision: w.inspect().interactionRevision }).ok,
  ).toBe(true);
  return w;
}

const headOn = () => crossing({ wa: [[5, 7]], wb: [[5, 6]] });
const places = (w: MemoryWorld) =>
  Object.values(w.inspect().entities).map((e) => `${e.sceneId} ${e.position}`);

describe('head-on deadlock', () => {
  test('the pair swaps rather than refusing each other forever', () => {
    const w = headOn();
    // Both reserved in the same call, before a single tick has passed.
    const before = w.inspect().entities;
    expect(before.wa.moving?.target).toEqual({ x: 5, y: 7 });
    expect(before.wb.moving?.target).toEqual({ x: 5, y: 6 });
    w.advance(STEP_MS);
    const after = w.inspect().entities;
    expect(after.wa.position).toEqual([5, 7]);
    expect(after.wb.position).toEqual([5, 6]);
  });

  test('no tile is doubly occupied, before or after', () => {
    const w = headOn();
    for (let i = 0; i < 3; i++) {
      w.advance(STEP_MS);
      expect(new Set(places(w)).size).toBe(places(w).length);
    }
  });

  test('it replays: the same swap, with no draw from a PRNG', () => {
    const run = () => {
      const w = headOn();
      w.advance(STEP_MS);
      return w.inspect().entities;
    };
    expect(run()).toEqual(run());
  });

  test('only a mutual step swaps: a walker facing a stationary one waits', () => {
    // `wb` is sent nowhere, so `wa` has nothing to swap with and holds its ground.
    const w = crossing({ wa: [[5, 7]], wb: [[5, 8]] });
    const { entities } = w.inspect();
    expect(entities.wb.moving?.target).toEqual({ x: 5, y: 8 });
    // wa is refused: wb has not vacated yet and is not stepping onto wa's tile.
    expect(entities.wa.moving).toBeNull();
    expect(entities.wa.path).toEqual([[5, 7]]);
    // Three steps, not two: entities are stepped in order, so `wa` is asked before `wb` has
    // vacated, and only the tick after that does its retry reserve the tile it then walks.
    for (let i = 0; i < 3; i++) w.advance(STEP_MS);
    expect(w.inspect().entities.wa.position).toEqual([5, 7]);
    expect(w.inspect().entities.wb.position).toEqual([5, 8]);
  });
});

describe('routed destinations never produce one', () => {
  function twoWalkers() {
    const scenes = [structuredClone(room), structuredClone(corridor)];
    (scenes[0] as { anchors: Record<string, number[]> }).anchors = {
      ...scenes[0].anchors,
      post_a: [7, 3],
      post_b: [8, 3],
    };
    const w = new MemoryWorld();
    w.load(scenes, story, undefined, {
      entities: [
        {
          id: 'wa',
          kind: 'actor',
          mobile: true,
          character: 'f6',
          scene: 'room',
          spawn: { anchor: 'post_a' },
        },
        {
          id: 'wb',
          kind: 'actor',
          mobile: true,
          character: 'f3',
          scene: 'room',
          spawn: { anchor: 'post_b' },
        },
      ],
    } as WorldEntities);
    return w;
  }

  test('a destination on an occupied tile is refused at routing time', () => {
    const w = twoWalkers();
    expect(w.execute({ requestId: 'a', type: 'moveEntity', entity: 'wa', x: 8, y: 3 })).toEqual({
      ok: false,
      error: 'No route toward that tile',
    });
  });

  test('two walkers wanting one third tile: one gets it, deterministically', () => {
    const w = twoWalkers();
    w.execute({ requestId: 'a', type: 'moveEntity', entity: 'wa', x: 7, y: 4 });
    w.execute({ requestId: 'b', type: 'moveEntity', entity: 'wb', x: 7, y: 4 });
    w.advance(STEP_MS);
    const { entities } = w.inspect();
    const arrived = [entities.wa, entities.wb].filter(
      (e) => e.position[0] === 7 && e.position[1] === 4,
    );
    expect(arrived).toHaveLength(1);
  });
});

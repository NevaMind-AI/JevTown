import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';
import { MemoryWorld } from '../../prototype/world';
import type { WorldEntities } from '../../prototype/content';

/**
 * The three commands an agent's intent arrives as (docs/13 §2): approach, wander, stop. Each is
 * resolved in-world, against live occupancy, and recorded as the intent rather than as a tile.
 *
 * `room` is 12x10 with a solid border; n07 at (5, 5), the exit door at (10, 5), anchors `start`
 * (3, 5, where the player stands) and `from_corridor` (9, 5). Both of those are arrival anchors.
 */
const STEP_MS = 1000;

function world(extraAnchors: Record<string, number[]> = {}) {
  const scenes = [structuredClone(room), structuredClone(corridor)];
  (scenes[0] as { anchors: Record<string, number[]> }).anchors = {
    ...scenes[0].anchors,
    post_a: [2, 2],
    post_b: [8, 7],
    bench: [7, 2],
    ...extraAnchors,
  };
  const actor = (id: string, character: string, anchor: string) => ({
    id,
    kind: 'actor',
    mobile: true,
    character,
    scene: 'room',
    spawn: { anchor },
  });
  const w = new MemoryWorld();
  w.load(scenes, story, undefined, {
    entities: [actor('ash', 'f4', 'post_a'), actor('milo', 'f6', 'post_b')],
  } as WorldEntities);
  return w;
}

let n = 0;
const send = (w: MemoryWorld, command: object) => w.execute({ requestId: `r${n++}`, ...command });
const walk = (w: MemoryWorld, steps: number) => {
  for (let i = 0; i < steps; i++) w.advance(STEP_MS);
};
const manhattan = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

describe('approachEntity', () => {
  test('walks to a tile beside the target and stops there', () => {
    const w = world();
    expect(send(w, { type: 'approachEntity', entity: 'ash', target: 'n07' })).toEqual({ ok: true });
    walk(w, 12);
    const ash = w.inspect().entities.ash;
    expect(manhattan(ash.position, [5, 5])).toBe(1);
    expect(ash.path).toEqual([]);
  });

  test('picks the nearest free side, measured from where it is', () => {
    const w = world();
    send(w, { type: 'approachEntity', entity: 'ash', target: 'n07' });
    // From (2, 2) the nearest neighbour of (5, 5) is (4, 5) or (5, 4); both are 5 away and
    // the tie breaks by tile, x first.
    expect(w.inspect().entities.ash.path.at(-1)).toEqual([4, 5]);
  });

  test('already beside the target is a success with nothing to do', () => {
    const w = world({ post_a: [5, 4] });
    expect(send(w, { type: 'approachEntity', entity: 'ash', target: 'n07' })).toEqual({ ok: true });
    expect(w.inspect().entities.ash.path).toEqual([]);
  });

  test('a target that has moved is approached where it is now, not where it was placed', () => {
    const w = world();
    send(w, { type: 'moveEntity', entity: 'milo', x: 8, y: 3 });
    walk(w, 6);
    expect(w.inspect().entities.milo.position).toEqual([8, 3]);
    send(w, { type: 'approachEntity', entity: 'ash', target: 'milo' });
    walk(w, 12);
    expect(manhattan(w.inspect().entities.ash.position, [8, 3])).toBe(1);
  });

  test('refuses a target it cannot reach', () => {
    const w = world();
    expect(send(w, { type: 'approachEntity', entity: 'ash', target: 'nobody' })).toEqual({
      ok: false,
      error: 'Unknown target',
    });
    expect(send(w, { type: 'approachEntity', entity: 'ash', target: 'corridor.return' })).toEqual({
      ok: false,
      error: 'Target is in another scene',
    });
  });
});

describe('wanderEntity', () => {
  test('walks onto a free place', () => {
    const w = world();
    expect(send(w, { type: 'wanderEntity', entity: 'ash', anchor: 'bench' })).toEqual({ ok: true });
    walk(w, 8);
    expect(w.inspect().entities.ash.position).toEqual([7, 2]);
  });

  test('never stops on an arrival anchor: it lands beside it', () => {
    const w = world();
    send(w, { type: 'wanderEntity', entity: 'milo', anchor: 'from_corridor' });
    walk(w, 8);
    const milo = w.inspect().entities.milo.position;
    expect(milo).not.toEqual([9, 5]);
    expect(manhattan(milo, [9, 5])).toBe(1);
  });

  test('an occupied place yields the nearest free tile by walking', () => {
    const w = world({ bench: [8, 7] });
    // milo is standing on `bench`.
    send(w, { type: 'wanderEntity', entity: 'ash', anchor: 'bench' });
    walk(w, 14);
    const ash = w.inspect().entities.ash.position;
    expect(ash).not.toEqual([8, 7]);
    expect(manhattan(ash, [8, 7])).toBe(1);
  });

  test('an unknown place is refused', () => {
    expect(send(world(), { type: 'wanderEntity', entity: 'ash', anchor: 'nowhere' })).toEqual({
      ok: false,
      error: 'Unknown place',
    });
  });
});

describe('stopEntity', () => {
  test('stops after the step in flight, never mid-tile', () => {
    const w = world();
    send(w, { type: 'wanderEntity', entity: 'ash', anchor: 'bench' });
    const step = w.inspect().entities.ash.moving!;
    expect(send(w, { type: 'stopEntity', entity: 'ash' })).toEqual({ ok: true });
    expect(w.inspect().entities.ash.path).toEqual([[step.target.x, step.target.y]]);
    walk(w, 4);
    expect(w.inspect().entities.ash.position).toEqual([step.target.x, step.target.y]);
  });

  test('stopping something standing still is harmless', () => {
    const w = world();
    expect(send(w, { type: 'stopEntity', entity: 'ash' })).toEqual({ ok: true });
    expect(w.inspect().entities.ash.path).toEqual([]);
  });
});

test('each is whitelisted by its exact shape', () => {
  const w = world();
  for (const bad of [
    { type: 'approachEntity', entity: 'ash' },
    { type: 'approachEntity', entity: 'ash', target: 'n07', x: 1 },
    { type: 'wanderEntity', entity: 'ash', anchor: 5 },
    { type: 'stopEntity', entity: '' },
  ])
    expect(w.execute({ requestId: `bad${n++}`, ...bad }).ok).toBe(false);
});

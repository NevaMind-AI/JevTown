import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';
import { loadContent, type WorldEntities } from '../../prototype/content';
import { MemoryWorld } from '../../prototype/world';

/**
 * The world file's entities, resolved onto the scenes that own the ground (docs/13 §2 J).
 *
 * `room` is 12x10 with a solid border, n07 at (5, 5), the exit door at (10, 5), and anchors
 * `start` (3, 5) and `from_corridor` (9, 5).
 */
const scenes = () => [structuredClone(room), structuredClone(corridor)];

const ACTOR = {
  id: 'ash',
  kind: 'actor' as const,
  mobile: true,
  name: 'Ash',
  character: 'f4',
  scene: 'room',
  spawn: { anchor: 'bar' },
};
const PROP = {
  id: 'notice-board',
  kind: 'prop' as const,
  name: 'Notice board',
  sprite: 'board',
  scene: 'room',
  anchor: 'bar',
};

/** An anchor authored to be placed on rather than arrived at. */
function withAnchor(list: ReturnType<typeof scenes>, anchor: number[] = [7, 3]) {
  (list[0] as { anchors: Record<string, number[]> }).anchors = {
    ...list[0].anchors,
    bar: anchor,
  };
  return list;
}
const world = (...entities: unknown[]): WorldEntities => ({ entities }) as WorldEntities;
const sprites = { board: { image: 'assets/low-deck/door-tag-317.png' } };

describe('placement', () => {
  test('a mobile actor becomes an ordinary scene entity at its spawn anchor', () => {
    const content = loadContent(withAnchor(scenes()), story, undefined, world(ACTOR));
    const placed = content.scenes[0].entities.find((e) => e.id === 'ash')!;
    expect(placed).toMatchObject({
      id: 'ash',
      name: 'Ash',
      position: [7, 3],
      character: 'f4',
      movable: true,
    });
  });

  test('and therefore exists in the runtime state, with no other wiring', () => {
    const w = new MemoryWorld();
    w.load(withAnchor(scenes()), story, undefined, world(ACTOR));
    const actor = w.inspect().entities.ash;
    expect(actor).toMatchObject({ sceneId: 'room', position: [7, 3], path: [], moving: null });
    expect(actor.appearance).toEqual({ character: 'f4' });
  });

  test('and can be walked by the command that moves anything else', () => {
    const w = new MemoryWorld();
    w.load(withAnchor(scenes()), story, undefined, world(ACTOR));
    expect(w.execute({ requestId: 'a', type: 'moveEntity', entity: 'ash', x: 7, y: 5 })).toEqual({
      ok: true,
    });
    for (let i = 0; i < 2; i++) w.advance(1000);
    expect(w.inspect().entities.ash.position).toEqual([7, 5]);
  });

  test('a prop is drawn from the story sprite vocabulary', () => {
    const content = loadContent(
      withAnchor(scenes()),
      { ...story, sprites },
      undefined,
      world(PROP),
    );
    expect(content.scenes[0].entities.find((e) => e.id === 'notice-board')).toMatchObject({
      character: 'sprite',
      sprite: { image: 'assets/low-deck/door-tag-317.png' },
      position: [7, 3],
    });
  });

  test('a prop that does not block is passable, and does not wall off its tile', () => {
    const passable = { ...PROP, physics: { blocks_movement: false } };
    const content = loadContent(
      withAnchor(scenes()),
      { ...story, sprites },
      undefined,
      world(passable),
    );
    expect(content.scenes[0].entities.find((e) => e.id === 'notice-board')).toMatchObject({
      passable: true,
    });
  });

  test('a blocking prop is not passable', () => {
    const blocking = { ...PROP, physics: { blocks_movement: true } };
    const content = loadContent(
      withAnchor(scenes()),
      { ...story, sprites },
      undefined,
      world(blocking),
    );
    const placed = content.scenes[0].entities.find((e) => e.id === 'notice-board')!;
    expect(placed.passable).toBeUndefined();
    expect(placed.movable).toBeUndefined();
  });

  test('a rect anchor places into its first free tile, not onto an occupant', () => {
    // (5, 5) is n07; the rect covers (5, 5) and (5, 6).
    const content = loadContent(withAnchor(scenes(), [5, 5, 1, 2]), story, undefined, world(ACTOR));
    expect(content.scenes[0].entities.find((e) => e.id === 'ash')!.position).toEqual([5, 6]);
  });

  test('it is idempotent, because a recording embeds the content it resolved', () => {
    const resolved = loadContent(withAnchor(scenes()), story, undefined, world(ACTOR));
    const again = loadContent(resolved.scenes, resolved.story, undefined, world(ACTOR));
    expect(again.scenes[0].entities.filter((e) => e.id === 'ash')).toHaveLength(1);
  });

  test('a replay reaches the same scenes without the world file', () => {
    const resolved = loadContent(withAnchor(scenes()), story, undefined, world(ACTOR));
    const replayed = loadContent(structuredClone(resolved.scenes), resolved.story);
    expect(replayed.scenes[0].entities.map((e) => e.id)).toEqual(
      resolved.scenes[0].entities.map((e) => e.id),
    );
  });

  test('what it refuses', () => {
    const load = (entity: unknown, anchor?: number[]) => () =>
      loadContent(withAnchor(scenes(), anchor), { ...story, sprites }, undefined, world(entity));
    expect(load({ ...ACTOR, scene: 'nowhere' })).toThrow('Unknown placement scene');
    expect(load({ ...ACTOR, spawn: { anchor: 'nowhere' } })).toThrow('Unknown placement anchor');
    expect(load({ ...ACTOR, spawn: undefined })).toThrow('needs an anchor');
    expect(load({ ...ACTOR, character: 'f9' })).toThrow('nothing to draw');
    expect(load({ ...PROP, sprite: 'no-such-art' })).toThrow('nothing to draw');
    // n07's tile, and nothing else in the 1x1 anchor.
    expect(load(ACTOR, [5, 5])).toThrow('has no free tile');
    expect(load({ ...ACTOR, id: 'n07' })).not.toThrow();
  });

  test('an id the scenes already use is left alone rather than duplicated', () => {
    const content = loadContent(
      withAnchor(scenes()),
      story,
      undefined,
      world({ ...ACTOR, id: 'n07' }),
    );
    const n07 = content.scenes[0].entities.filter((e) => e.id === 'n07');
    expect(n07).toHaveLength(1);
    expect(n07[0].position).toEqual([5, 5]);
  });
});

describe('a passable entity occupies its tile without blocking it', () => {
  const passableBoard = {
    ...PROP,
    anchor: 'bar',
    physics: { blocks_movement: false },
  };

  test('a route goes through it', () => {
    const w = new MemoryWorld();
    // (5, 6) sits between n07 and the room's south side; the board stands on it.
    w.load(withAnchor(scenes(), [5, 6]), { ...story, sprites }, undefined, world(passableBoard));
    expect(w.execute({ requestId: 'a', type: 'moveEntity', entity: 'n07', x: 5, y: 7 })).toEqual({
      ok: true,
    });
    expect(w.inspect().entities.n07.path).toEqual([
      [5, 6],
      [5, 7],
    ]);
  });

  test('and the player walks onto it', () => {
    const w = new MemoryWorld();
    // The player starts at (3, 5); put the board one step east.
    w.load(withAnchor(scenes(), [4, 5]), { ...story, sprites }, undefined, world(passableBoard));
    expect(w.execute({ requestId: 'a', type: 'move', dx: 1, dy: 0 })).toEqual({ ok: true });
  });

  test('a blocking one stops both', () => {
    const w = new MemoryWorld();
    const blocking = { ...PROP, physics: { blocks_movement: true } };
    w.load(withAnchor(scenes(), [4, 5]), { ...story, sprites }, undefined, world(blocking));
    expect(w.execute({ requestId: 'a', type: 'move', dx: 1, dy: 0 }).ok).toBe(false);
  });
});

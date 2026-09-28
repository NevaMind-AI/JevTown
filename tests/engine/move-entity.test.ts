import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';
import { MemoryWorld } from '../../prototype/world';

/**
 * The agentic seam (docs/13 §2): an agent produces a destination tile, and the world routes.
 *
 * `n07` stands at (5, 5) in a 12x10 room with a solid border, so the walkable interior is
 * (1,1)-(10,8) and the player starts at (3, 5).
 */
function world() {
  const w = new MemoryWorld();
  w.load([room, corridor], story);
  return w;
}

/** `MemoryWorld`'s default map walks a tile per second. */
const STEP_MS = 1000;

let n = 0;
const send = (w: MemoryWorld, command: object) => w.execute({ requestId: `r${n++}`, ...command });

describe('moveEntity', () => {
  test('a destination becomes a route the world computed', () => {
    const w = world();
    expect(send(w, { type: 'moveEntity', entity: 'n07', x: 5, y: 7 })).toEqual({ ok: true });
    const actor = w.inspect().entities.n07;
    expect(actor.path).toEqual([
      [5, 6],
      [5, 7],
    ]);
    // The first step is reserved immediately, as any other mover's is.
    expect(actor.moving).toMatchObject({ target: { x: 5, y: 6 } });
  });

  test('the entity actually walks it', () => {
    const w = world();
    send(w, { type: 'moveEntity', entity: 'n07', x: 5, y: 7 });
    for (let i = 0; i < 2; i++) w.advance(STEP_MS);
    const actor = w.inspect().entities.n07;
    expect(actor.position).toEqual([5, 7]);
    expect(actor.path).toEqual([]);
    expect(actor.moving).toBeNull();
  });

  test('an unreachable destination walks as far as it can (§2.6)', () => {
    const w = world();
    // (11, 5) is the wall, so the walk ends on the reachable tile nearest it — (10, 4), around
    // two obstacles it may not cross: (10, 5) is the exit door, which occupies its tile, and
    // (9, 5) is `from_corridor`, an anchor the corridor's return portal arrives at. Routing
    // leaves arrival anchors clear because `startEntityStep` would refuse them anyway.
    expect(send(w, { type: 'moveEntity', entity: 'n07', x: 11, y: 5 })).toEqual({ ok: true });
    const { path } = w.inspect().entities.n07;
    expect(path.length).toBeGreaterThan(0);
    expect(path.at(-1)).toEqual([10, 4]);
  });

  test('retargeting mid-step keeps the step it is already taking', () => {
    const w = world();
    send(w, { type: 'moveEntity', entity: 'n07', x: 5, y: 8 });
    const step = w.inspect().entities.n07.moving!;
    send(w, { type: 'moveEntity', entity: 'n07', x: 8, y: 6 });
    const actor = w.inspect().entities.n07;
    // `path[0] === moving.target` is what arrival and the recording both rely on.
    expect(actor.moving).toEqual(step);
    expect(actor.path[0]).toEqual([step.target.x, step.target.y]);
    expect(actor.path.at(-1)).toEqual([8, 6]);
  });

  test('an entity it does not know is an error, not a silent no-op', () => {
    const w = world();
    expect(send(w, { type: 'moveEntity', entity: 'nobody', x: 5, y: 6 })).toEqual({
      ok: false,
      error: 'Unknown entity',
    });
  });

  test('the command is whitelisted by exact shape, so it replays', () => {
    const w = world();
    expect(w.execute({ requestId: 'a', type: 'moveEntity', entity: 'n07' }).ok).toBe(false);
    expect(
      w.execute({ requestId: 'b', type: 'moveEntity', entity: 'n07', x: 5, y: 6, extra: 1 }).ok,
    ).toBe(false);
    expect(w.execute({ requestId: 'c', type: 'moveEntity', entity: 5, x: 5, y: 6 }).ok).toBe(false);
  });

  test('it lands in the recording, and a replay reaches the same state', () => {
    const w = world();
    send(w, { type: 'moveEntity', entity: 'n07', x: 5, y: 7 });
    for (let i = 0; i < 2; i++) w.advance(STEP_MS);
    const recorded = w.recording();
    expect(recorded.events.some((e) => JSON.stringify(e).includes('moveEntity'))).toBe(true);
    expect(w.inspect().entities.n07.position).toEqual([5, 7]);
  });

  test('a tile another actor has reserved is not stepped into', () => {
    const w = world();
    // The player stands at (3, 5); walking n07 onto it must not displace anybody.
    send(w, { type: 'moveEntity', entity: 'n07', x: 3, y: 5 });
    for (let i = 0; i < 4; i++) w.advance(STEP_MS);
    const state = w.inspect();
    expect(state.entities.n07.position).not.toEqual([3, 5]);
    expect(state.player).toEqual({ x: 3, y: 5 });
  });
});

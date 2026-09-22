import { readFileSync } from 'node:fs';
import { loadPackage } from '../../prototype/package';
import { MemoryWorld } from '../../prototype/world';

test('immutable package preserves NPC identity and replays identical state', async () => {
  const read = (p: string) => JSON.parse(readFileSync(`content/fixtures/route/${p}`, 'utf8'));
  const manifest = read('manifest.json');
  const files: Record<string, unknown> = {};
  for (const path of [...manifest.scenes, ...manifest.stories]) files[path] = read(path);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  const originalFiles = JSON.stringify(files);
  freeze(manifest);
  freeze(files);
  const content = await loadPackage(manifest, async (p) => files[p]);
  freeze(content);
  const create = () => {
    const w = new MemoryWorld(
      () => 1,
      () => 0,
    );
    w.load(content.scenes, content.story, content.npcs);
    return w;
  };
  const world = create();
  let id = 0;
  const send = (command: object) =>
    expect(world.execute({ requestId: String(id++), ...command }).ok).toBe(true);
  send({ type: 'move', dx: 1, dy: 0 });
  world.advance(1000);
  send({ type: 'interact', target: 'n07' });
  send({ type: 'choose', choice: 'permit', revision: world.inspect().interactionRevision });
  world.advance(500);
  expect(world.inspect().entities.n07.moving).not.toBeNull();
  const midpoint = world.inspect();
  world.advance(500);
  for (let i = 0; i < 3; i++) world.advance(1000);
  expect(world.inspect().entities.n07.sceneId).toBe('corridor');
  expect(world.scene('room')!.entities.some((e) => e.id === 'n07')).toBe(false);
  expect(world.scene('corridor')!.entities.filter((e) => e.id === 'n07')).toHaveLength(1);
  expect(
    content.scenes.find((s) => s.id === 'room')!.entities.find((e) => e.id === 'n07')!.position,
  ).toEqual([5, 5]);
  const independentRun = create();
  expect(independentRun.inspect().entities.n07.sceneId).toBe('room');
  for (let i = 0; i < 6; i++) {
    send({ type: 'move', dx: 1, dy: 0 });
    world.advance(1000);
  }
  send({ type: 'move', dx: 1, dy: 0 });
  world.advance(1000);
  send({ type: 'interact', target: 'n07' });
  send({ type: 'choose', choice: 'reunion', revision: world.inspect().interactionRevision });
  expect(world.inspect().vars.met_again).toBe(true);
  const replay = create();
  for (const event of world.history()) {
    const c = event.cause;
    expect(c.type === 'advance' ? replay.advance(c.ms) : replay.execute(c)).toEqual(event.result);
    expect(replay.inspect()).toEqual(event.state);
  }
  expect(replay.inspect()).toEqual(world.inspect());
  expect(midpoint.entities.n07.moving).not.toBeNull();
  expect(JSON.stringify(files)).toBe(originalFiles);
  // Re-entering the birth scene must not recreate an NPC who has left it.
  send({ type: 'move', dx: -1, dy: 0 });
  world.advance(1000);
  send({ type: 'move', dx: -1, dy: 0 });
  expect(world.inspect().sceneId).toBe('room');
  expect(world.scene()!.entities.some((e) => e.id === 'n07')).toBe(false);
  expect(JSON.stringify(files)).toBe(originalFiles);
});

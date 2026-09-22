import { readFileSync } from 'node:fs';
import { loadPackage } from '../../prototype/package';
import { MemoryWorld } from '../../prototype/world';

const read = async (path: string) =>
  JSON.parse(readFileSync(`content/fixtures/route/${path}`, 'utf8'));

test('movement permission is declared by the entity, independent of its appearance', async () => {
  const manifest = await read('manifest.json');
  for (const movable of [true, false, undefined, 'yes']) {
    const loading = loadPackage(manifest, async (path) => {
      const data = await read(path);
      if (path === 'scenes/room.json') {
        const npc = data.entities.find((e: { id: string }) => e.id === 'n07');
        npc.character = 'book';
        if (movable === undefined) delete npc.movable;
        else npc.movable = movable;
      }
      return data;
    });
    if (movable === true) {
      const pack = await loading;
      const world = new MemoryWorld();
      world.load(pack.scenes, pack.story, pack.npcs);
      world.execute({ requestId: 'm', type: 'move', dx: 1, dy: 0 });
      world.advance(1000);
      world.execute({ requestId: 'i', type: 'interact', target: 'n07' });
      expect(
        world.execute({
          requestId: 'p',
          type: 'choose',
          choice: 'permit',
          revision: world.inspect().interactionRevision,
        }).ok,
      ).toBe(true);
      world.advance(1000);
      expect(world.inspect().entities.n07.position).toEqual([6, 5]);
    } else await expect(loading).rejects.toThrow();
  }
});

test('manifest loads scenes with entities and multiple stories into independent runtime state', async () => {
  const manifest = await read('manifest.json');
  const pack = await loadPackage(manifest, read);
  expect(pack.story.tasks).toHaveLength(3);
  const world = new MemoryWorld();
  world.load(pack.scenes, pack.story, pack.npcs);
  expect(world.scene()?.entities.find((e) => e.id === 'n07')?.position).toEqual([5, 5]);
  world.execute({ requestId: 'move', type: 'move', dx: 1, dy: 0 });
  world.advance(1000);
  world.execute({ requestId: 'talk', type: 'interact', target: 'n07' });
  expect(world.taskViews().find((t) => t.id === 'learn_movement')!.completed).toEqual([]);
  expect(world.taskViews().find((t) => t.id === 'learn_interaction')!.completed).toEqual(['talk']);
  expect(world.taskViews().find((t) => t.id === 'follow_black')!.completed).toEqual([]);
  world.execute({
    requestId: 'permit',
    type: 'choose',
    choice: 'permit',
    revision: world.inspect().interactionRevision,
  });
  expect(world.taskViews().find((t) => t.id === 'follow_black')!.completed).toEqual(['permit']);
  const snapshot = world.inspect();
  snapshot.entities.n07.position[0] = 8;
  expect(world.inspect().entities.n07.position).toEqual([5, 5]);
  pack.scenes[0].entities.find((e) => e.id === 'n07')!.position[0] = 7;
  expect(world.scene()?.entities.find((e) => e.id === 'n07')?.position).toEqual([5, 5]);
  world.reset();
  expect(world.inspect().entities.n07.position).toEqual([5, 5]);
  // Optional object interaction shares the story flow without changing task progress.
  world.execute({ requestId: 'north', type: 'move', dx: 0, dy: -1 });
  world.advance(1000);
  const beforeBook = world.taskViews();
  expect(world.execute({ requestId: 'book', type: 'interact', target: 'room.book' }).ok).toBe(true);
  expect(world.inspect().npc.reply).toContain('纸页');
  expect(world.taskViews()).toEqual(beforeBook);
  expect(
    world.execute({
      requestId: 'close-book',
      type: 'choose',
      choice: 'close',
      revision: world.inspect().interactionRevision,
    }).ok,
  ).toBe(true);
  expect(world.inspect().dialogue).toBe(false);
  expect(world.execute({ requestId: 'read-again', type: 'interact', target: 'room.book' }).ok).toBe(
    true,
  );
  await expect(loadPackage({ ...manifest, scenes: ['../secret.json'] }, read)).rejects.toThrow();
  await expect(
    loadPackage(manifest, async (path) => {
      const data = await read(path);
      if (path === 'stories/onboarding.json') data.vars = { has_pass: true };
      return data;
    }),
  ).rejects.toThrow('Conflicting story');
  await expect(
    loadPackage(manifest, async (path) => {
      const data = await read(path);
      if (path === 'scenes/corridor.json') data.entities[0].id = 'n07';
      return data;
    }),
  ).rejects.toThrow();
  await expect(
    loadPackage(manifest, async (path) => {
      const data = await read(path);
      if (path === 'scenes/room.json') data.entities[1].portal.scene = 'missing';
      return data;
    }),
  ).rejects.toThrow();
});

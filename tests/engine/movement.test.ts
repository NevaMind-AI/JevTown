import { readFileSync } from 'node:fs';
import { loadPackage } from '../../prototype/package';
import { MemoryWorld } from '../../prototype/world';

test('story movement progresses, waits for player, deduplicates and resets', async () => {
  const read = async (p: string) => JSON.parse(readFileSync(`content/fixtures/route/${p}`, 'utf8'));
  const pack = await loadPackage(await read('manifest.json'), read);
  pack.story.interactions.n07.choices.push({
    id: 'walk',
    text: 'Walk',
    effects: [
      {
        op: 'move_entity',
        entity: 'n07',
        path: [
          [5, 6],
          [6, 6],
          [6, 5],
          [5, 5],
        ],
      },
    ],
  });
  const w = new MemoryWorld();
  w.load(pack.scenes, pack.story, pack.npcs);
  let id = 0;
  const send = (c: object) => w.execute({ requestId: String(id++), ...c });
  send({ type: 'move', dx: 1, dy: 0 });
  w.advance(1000);
  send({ type: 'interact', target: 'n07' });
  const choice = {
    requestId: 'walk',
    type: 'choose',
    choice: 'walk',
    revision: w.inspect().interactionRevision,
  };
  expect(w.execute(choice).ok).toBe(true);
  expect(w.execute(choice).ok).toBe(true);
  expect(w.inspect().entities.n07.path).toHaveLength(4);
  expect(send({ type: 'interact', target: 'n07' }).ok).toBe(false);
  expect(w.inspect().entities.n07.moving?.target).toEqual({ x: 5, y: 6 });
  w.advance(500);
  expect(w.inspect().entities.n07.moving!.arrivesAt - w.inspect().time).toBe(500);
  w.advance(499);
  expect(w.inspect().entities.n07.position).toEqual([5, 5]);
  w.advance(1);
  expect(w.inspect().entities.n07.position).toEqual([5, 6]);
  // Player occupies the final waypoint while the NPC continues its route.
  send({ type: 'move', dx: 1, dy: 0 });
  w.advance(1000);
  w.advance(1000);
  w.advance(1000);
  expect(w.inspect().entities.n07.position).toEqual([6, 5]);
  expect(w.inspect().entities.n07.moving).toBeNull();
  send({ type: 'move', dx: -1, dy: 0 });
  w.advance(1000);
  expect(w.inspect().entities.n07.moving?.target).toEqual({ x: 5, y: 5 });
  w.advance(1000);
  expect(w.inspect().entities.n07.position).toEqual([5, 5]);
  expect(w.inspect().entities.n07.path).toEqual([]);
  expect(pack.scenes[0].entities.find((e) => e.id === 'n07')!.position).toEqual([5, 5]);
  w.reset();
  expect(w.inspect().entities.n07.path).toEqual([]);
  await expect(
    loadPackage(await read('manifest.json'), async (p) => {
      const d = await read(p);
      if (p === 'stories/arrival.json') d.interactions.n07.choices[0].effects[1].entity = 'missing';
      return d;
    }),
  ).rejects.toThrow('Invalid moving entity');
});

test('permit sends N-07 through the portal and player follows to reunite', async () => {
  const read = async (p: string) => JSON.parse(readFileSync(`content/fixtures/route/${p}`, 'utf8'));
  const pack = await loadPackage(await read('manifest.json'), read);
  const w = new MemoryWorld();
  w.load(pack.scenes, pack.story, pack.npcs);
  let id = 0;
  const send = (c: object) => {
    const r = w.execute({ requestId: String(id++), ...c });
    expect(r.ok).toBe(true);
  };
  send({ type: 'move', dx: 1, dy: 0 });
  w.advance(1000);
  send({ type: 'interact', target: 'n07' });
  send({ type: 'choose', choice: 'permit', revision: w.inspect().interactionRevision });
  for (let i = 0; i < 4; i++) w.advance(1000);
  expect(w.inspect().entities.n07.sceneId).toBe('corridor');
  expect(w.scene()!.entities.some((e) => e.id === 'n07')).toBe(false);
  for (let i = 0; i < 6; i++) {
    send({ type: 'move', dx: 1, dy: 0 });
    w.advance(1000);
  }
  expect(w.inspect().sceneId).toBe('corridor');
  send({ type: 'move', dx: 1, dy: 0 });
  w.advance(1000);
  send({ type: 'interact', target: 'n07' });
  send({ type: 'choose', choice: 'reunion', revision: w.inspect().interactionRevision });
  expect(w.inspect().vars.met_again).toBe(true);
  expect(w.taskViews().find((t) => t.id === 'follow_black')!.completed).toEqual([
    'permit',
    'follow',
  ]);
});

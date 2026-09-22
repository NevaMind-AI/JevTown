import { readFileSync } from 'node:fs';
import { loadPackage } from '../../prototype/package';
import { MemoryWorld } from '../../prototype/world';
import { visualPlacement } from '../../prototype/assets';
import { mapBlocked, portalAt } from '../../prototype/content';

const read = async (path: string) =>
  JSON.parse(
    readFileSync(
      path.startsWith('maps/')
        ? `src/content/remaining-time/${path}`
        : `public/content/remaining-time/${path}`,
      'utf8',
    ),
  );

test('room NPC feet align with their occupied tile, including reserved arrival tiles', async () => {
  const content = await loadPackage(await read('manifest.json'), read);
  const world = new MemoryWorld();
  world.load(content.scenes, content.story, content.npcs);
  const npcs = content.scenes
    .flatMap((scene) => scene.entities)
    .filter((entity) => entity.sprite?.image.startsWith('assets/room-npcs/'));
  expect(npcs.length).toBeGreaterThan(0);
  for (const npc of npcs) {
    const actor = world.getEntity(npc.id)!;
    const [x, y] = actor.state.position;
    const placement = visualPlacement(actor.sprite!, [x * 32, y * 32], 0);
    expect({ id: npc.id, x: placement.x, y: placement.y }).toEqual({
      id: npc.id,
      x: x * 32 + 16,
      y: y * 32 + 16,
    });
  }
  const corridor = content.scenes.find((scene) => scene.id === 'low-deck')!;
  const resident = world.getEntity('resident-door')!;
  expect(resident.state.position).not.toEqual(corridor.anchors['from-enter-rhea']);
});

test('all room NPC menus are reachable, range-gated and turn the actors toward each other', async () => {
  const content = await loadPackage(await read('manifest.json'), read);
  let checked = 0;
  for (const scene of content.scenes) {
    const npcs = scene.entities.filter((e) => e.sprite?.image.startsWith('assets/room-npcs/'));
    if (!npcs.length) continue;
    const occupied = new Set(scene.entities.filter((e) => !e.portal).map((e) => e.position.join()));
    const queue = [scene.anchors.start];
    const seen = new Set([queue[0].join()]);
    for (let i = 0; i < queue.length; i++) {
      const [x, y] = queue[i];
      for (const point of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (
          seen.has(point.join()) ||
          occupied.has(point.join()) ||
          mapBlocked(scene.map, point[0], point[1]) ||
          portalAt(scene, point[0], point[1])
        )
          continue;
        seen.add(point.join());
        queue.push(point);
      }
    }
    for (const npc of npcs) {
      const distance = (point: number[]) =>
        Math.abs(point[0] - npc.position[0]) + Math.abs(point[1] - npc.position[1]);
      const near = queue.find((p) => distance(p) === 1);
      const far = queue.find((p) => distance(p) >= 3);
      expect({ id: npc.id, reachable: !!near && !!far }).toEqual({ id: npc.id, reachable: true });
      for (const start of [near!, far!]) {
        const world = new MemoryWorld();
        world.load(
          content.scenes.map((s) =>
            s.id === scene.id ? { ...s, anchors: { ...s.anchors, check: start } } : s,
          ),
          { ...content.story, start: { scene: scene.id, anchor: 'check' } },
          content.npcs,
        );
        const inRange = start === near;
        expect(world.nearby().some((e) => e.id === npc.id)).toBe(inRange);
        expect(world.execute({ requestId: 'talk', type: 'interact', target: npc.id }).ok).toBe(
          inRange,
        );
        if (inRange) {
          const state = world.inspect();
          const orientation =
            npc.position[0] > start[0]
              ? 0
              : npc.position[0] < start[0]
                ? 180
                : npc.position[1] > start[1]
                  ? 90
                  : 270;
          expect(state.activeEntity).toBe(npc.id);
          expect(state.orientation).toBe(orientation);
          expect(state.entities[npc.id].orientation).toBe((orientation + 180) % 360);
          expect(world.execute({ requestId: 'close', type: 'closeDialogue' }).ok).toBe(true);
          expect(world.inspect().dialogue).toBe(false);
        }
      }
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

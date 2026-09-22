import { Scene, mapBlocked, mapEdgeBlocked } from './content.js';

const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
const neighbors = ([x, y]: number[]) => [
  [x - 1, y],
  [x + 1, y],
  [x, y - 1],
  [x, y + 1],
];
const fixedBlocked = (scene: Scene, p: number[]) =>
  mapBlocked(scene.map, p[0], p[1]) ||
  scene.entities.some((e) => !e.movable && !e.portal && same(e.position, p));

// Bounded 64x64 grid; callers may reserve dynamic obstacle tiles.
export function npcPath(
  scene: Scene,
  start: number[],
  goals: number[][],
  blocked: number[][] = [],
): number[][] | null {
  const targets = new Set(goals.filter((p) => !fixedBlocked(scene, p)).map((p) => p.join()));
  const queue = [start],
    parents = new Map<string, number[] | null>([[start.join(), null]]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (targets.has(p.join())) {
      const path: number[][] = [];
      let cursor = p;
      while (parents.get(cursor.join())) {
        path.unshift(cursor);
        cursor = parents.get(cursor.join())!;
      }
      return path;
    }
    for (const n of neighbors(p))
      if (
        !parents.has(n.join()) &&
        !fixedBlocked(scene, n) &&
        !mapEdgeBlocked(scene.map, p, n) &&
        !blocked.some((p) => same(p, n))
      ) {
        parents.set(n.join(), p);
        queue.push(n);
      }
  }
  return null;
}

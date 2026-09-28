import { Scene, anchorTiles, mapBlocked, mapEdgeBlocked } from './content.js';

const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
const neighbors = ([x, y]: number[]) => [
  [x - 1, y],
  [x + 1, y],
  [x, y - 1],
  [x, y + 1],
];
const fixedBlocked = (scene: Scene, p: number[]) =>
  mapBlocked(scene.map, p[0], p[1]) ||
  scene.entities.some((e) => !e.movable && !e.portal && !e.passable && same(e.position, p));

/**
 * A search budget (docs/13 §2.6, `MAX_PATHFINDS_PER_STEP`'s sibling).
 *
 * 64x64 is the authored maximum scene, so this is the whole grid: it never bites a legal map,
 * and exists so a malformed one cannot spend a frame in here.
 */
const MAX_SEARCH_TILES = 4096;

export type PathOptions = {
  /**
   * On an unreachable goal, walk as far toward it as the search can get instead of standing
   * still (docs/13 §2.6, taken from the engine's `bestCandidate`). Off by default, because
   * `loadContent` uses a null return to mean "this schedule is unroutable" at authoring time,
   * and a partial path would hide exactly the defect that check exists to find.
   */
  partial?: boolean;
};

// Bounded 64x64 grid; callers may reserve dynamic obstacle tiles.
export function npcPath(
  scene: Scene,
  start: number[],
  goals: number[][],
  blocked: number[][] = [],
  options: PathOptions = {},
): number[][] | null {
  const targets = new Set(goals.filter((p) => !fixedBlocked(scene, p)).map((p) => p.join()));
  // Standing on a goal and merely heading toward one are different questions. A blocked goal can
  // never be arrived at, but `partial` is about getting as close as the map allows, so it keeps
  // the blocked tiles as something to measure against.
  const reference = options.partial ? goals : [...targets].map((k) => k.split(',').map(Number));
  if (!reference.length || (!targets.size && !options.partial)) return null;
  const toGoal = (p: number[]) =>
    Math.min(...reference.map((g) => Math.abs(g[0] - p[0]) + Math.abs(g[1] - p[1])));

  const queue = [start],
    parents = new Map<string, number[] | null>([[start.join(), null]]);
  const trace = (cursor: number[]) => {
    const path: number[][] = [];
    while (parents.get(cursor.join())) {
      path.unshift(cursor);
      cursor = parents.get(cursor.join())!;
    }
    return path;
  };
  let best = start,
    bestDistance = toGoal(start);
  for (let i = 0; i < queue.length && i < MAX_SEARCH_TILES; i++) {
    const p = queue[i];
    if (targets.has(p.join())) return trace(p);
    const distance = toGoal(p);
    if (distance < bestDistance) {
      best = p;
      bestDistance = distance;
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
  if (!options.partial) return null;
  const partial = trace(best);
  return partial.length ? partial : null;
}

/**
 * The free tiles orthogonally adjacent to a footprint — where an actor stands to act on what
 * occupies it (docs/13 §2).
 *
 * A one-tile entity has four of these and a rect has its perimeter, which is the same rule
 * rather than two: "adjacent to any tile it covers, and not a tile it covers".
 *
 * Ordered nearest-first from `from`, then by tile, so a caller that takes the first one is
 * making a choice a replay makes again. Nothing here draws from a PRNG.
 */
export function footprintApproachTiles(
  scene: Scene,
  footprint: number[][],
  blocked: number[][] = [],
  from?: number[],
): number[][] {
  const covered = new Set(footprint.map((p) => p.join()));
  const seen = new Set<string>();
  const tiles: number[][] = [];
  for (const tile of footprint)
    for (const n of neighbors(tile)) {
      const key = n.join();
      if (covered.has(key) || seen.has(key)) continue;
      seen.add(key);
      if (fixedBlocked(scene, n) || blocked.some((p) => same(p, n))) continue;
      tiles.push(n);
    }
  const origin = from ?? footprint[0] ?? [0, 0];
  const distance = (p: number[]) => Math.abs(p[0] - origin[0]) + Math.abs(p[1] - origin[1]);
  return tiles.sort((a, b) => distance(a) - distance(b) || a[0] - b[0] || a[1] - b[1]);
}

/**
 * Where to stand to interact with an entity.
 *
 * The candidate set is the authored one and not a rule of its own: `nearby()` admits a
 * Manhattan-1 tile **or** one of the entity's `interactionOffsets`, so this is that union. An
 * entity with offsets keeps them *in addition to* its neighbours, exactly as `nearby()` reads.
 */
export function approachTiles(
  scene: Scene,
  targetId: string,
  blocked: number[][] = [],
  from?: number[],
): number[][] {
  const target = scene.entities.find((e) => e.id === targetId);
  if (!target) return [];
  const [ex, ey] = target.position;
  const tiles = footprintApproachTiles(scene, [target.position], blocked, from);
  const seen = new Set(tiles.map((p) => p.join()));
  for (const [dx, dy] of target.interactionOffsets ?? []) {
    const tile = [ex + dx, ey + dy];
    if (seen.has(tile.join()) || fixedBlocked(scene, tile) || blocked.some((p) => same(p, tile)))
      continue;
    seen.add(tile.join());
    tiles.push(tile);
  }
  const origin = from ?? [ex, ey];
  const distance = (p: number[]) => Math.abs(p[0] - origin[0]) + Math.abs(p[1] - origin[1]);
  return tiles.sort((a, b) => distance(a) - distance(b) || a[0] - b[0] || a[1] - b[1]);
}

/** Where to stand to act on whatever an anchor's rect covers. */
export function anchorApproachTiles(
  scene: Scene,
  anchor: number[],
  blocked: number[][] = [],
  from?: number[],
): number[][] {
  return footprintApproachTiles(scene, anchorTiles(anchor), blocked, from);
}

/**
 * The nearest free tile to an anchor, for wandering (docs/13 §2).
 *
 * Nearest by BFS rather than by straight-line distance, so the tile it returns is one the actor
 * can actually walk to: a tile two steps away through a door beats one across a wall. The
 * anchor's own tiles are candidates, and a rect anchor is searched from all of them at once.
 */
export function nearestFreeTile(
  scene: Scene,
  anchor: number[],
  blocked: number[][] = [],
): number[] | null {
  const queue = anchorTiles(anchor).filter((p) => !fixedBlocked(scene, p));
  if (!queue.length) return null;
  const seen = new Set(queue.map((p) => p.join()));
  for (let i = 0; i < queue.length && i < MAX_SEARCH_TILES; i++) {
    const p = queue[i];
    if (!blocked.some((q) => same(q, p))) return p;
    for (const n of neighbors(p)) {
      const key = n.join();
      if (seen.has(key) || fixedBlocked(scene, n) || mapEdgeBlocked(scene.map, p, n)) continue;
      seen.add(key);
      queue.push(n);
    }
  }
  return null;
}

import { mapBlocked, type Scene } from '../../prototype/content';
import type { MapContext, SceneContext } from '../../engine/aiTown/worldFile';
import type { Anchor, CollisionLayer, SerializedWorldMap } from '../../engine/aiTown/worldMap';

/**
 * A `MemoryWorld` scene, read as ground the agentic world can stand on (docs/13 §2).
 *
 * The map is the init side's and stays the init side's: 26 authored scenes, each with its own
 * collision, portals and anchors. The agentic world has no map of its own — it places its
 * entities on anchors these scenes define. So the whole of the coordinate merge, on this side,
 * is a translation, and this module is it.
 *
 * `engine/createWorld.ts` was written for exactly this: it takes a `MapContext` and a collision
 * layer as arguments rather than reading a map module, because "`dev`'s per-scene JSON and the
 * agentic branch's generated module are two different sources for it". This is the first source
 * showing up. The adapter lives here rather than in `engine/` because the engine may not import
 * `prototype/` (`.eslintrc.cjs`: dependencies point inward).
 *
 * Two shape differences do the damage if they are not stated:
 *
 * 1. **The layers are transposed.** `mapBlocked` reads `collision[y][x]` as `'#'` characters;
 *    `WorldMap.blockedStatic` reads `collision[x][y]` as booleans. Everything here produces the
 *    engine's spelling, and `sceneCollision` is the only place the flip happens.
 * 2. **A scene with no `collision` is not an open field.** `mapBlocked`'s fallback blocks the
 *    border and nothing else, so it must be asked rather than reimplemented — which is why this
 *    calls it per tile instead of copying the array.
 */

/** The engine's collision layer for a scene: `[x][y]`, booleans, border rule applied. */
export function sceneCollision(scene: Scene): CollisionLayer {
  const { width, height } = scene.map;
  const collision: CollisionLayer = [];
  for (let x = 0; x < width; x++) {
    collision[x] = [];
    for (let y = 0; y < height; y++) {
      collision[x][y] = mapBlocked(scene.map, x, y);
    }
  }
  return collision;
}

/**
 * Scene anchors are points; engine anchors are rectangles. `[x, y]` is the 1x1 rect at that
 * tile, and `[x, y, w, h]` is the rect spelled out — a widening the array shape absorbs, since
 * every existing reader destructures the first two entries and stops.
 *
 * `description` is empty because the scene format has nowhere to put one yet. It is what the
 * model reads when it picks somewhere to wander (docs/07 §4), so it is worth authoring before
 * `wander` runs against this ground — but nothing reads it today and an empty string is honest.
 */
export function sceneAnchor(id: string, position: number[]): Anchor {
  const [x, y, w = 1, h = 1] = position;
  return { id, x, y, w, h, description: '' };
}

/** Sorted by id: iteration order is observable, and docs/05 §10 requires it to be deterministic. */
export function sceneAnchors(scene: Scene): Map<string, Anchor> {
  return new Map(
    Object.entries(scene.anchors)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, position]) => [id, sceneAnchor(id, position)]),
  );
}

/** One scene as the engine reads ground: bounds, anchors, and what blocks. */
export function sceneContext(scene: Scene): SceneContext {
  const collision = sceneCollision(scene);
  return {
    width: scene.map.width,
    height: scene.map.height,
    anchors: sceneAnchors(scene),
    // Out of bounds is blocked, matching `mapBlocked` rather than `blockedStatic`'s `?? false`.
    // A world file naming a tile off the edge should fail validation, not pass it.
    blocked: (x, y) => collision[x]?.[y] ?? true,
  };
}

/** The scene-keyed registry, sorted by scene id for the same reason anchors are. */
export function sceneRegistry(scenes: Scene[]): Map<string, SceneContext> {
  return new Map(
    [...scenes]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((scene) => [scene.id, sceneContext(scene)]),
  );
}

/**
 * The whole scene set as one `MapContext`.
 *
 * `defaultScene` is the story's start scene, and it is what an entity that names no scene of its
 * own is placed in. It has to be named rather than inferred: anchor ids are scene-local — `start`
 * appears in all 26 scenes and `from-return` in 20 — so "which scene" is never recoverable from
 * an anchor id, and a world file that omits it is placing entities by coin flip.
 */
export function sceneMapContext(
  scenes: Scene[],
  characters: Iterable<string>,
  defaultScene: string,
): MapContext {
  const registry = sceneRegistry(scenes);
  const start = registry.get(defaultScene);
  if (!start) {
    throw new Error(`Unknown default scene "${defaultScene}"`);
  }
  return { ...start, characters: new Set(characters), scenes: registry, defaultScene };
}

/**
 * One registry entry, in the shape `Game` stores a map in.
 *
 * The render half is empty on purpose. `SerializedWorldMap` carries tile layers because stock AI
 * Town draws them with `PixiStaticMap`; here `LocalGame` draws the scene from the scene's own
 * `map.render`, and nothing in `engine/` or `agent/` reads a tile layer — only `width`, `height`,
 * `collision` and the anchors. Filling these with plausible-looking tiles would be inventing a
 * second, wrong copy of the map's appearance.
 */
export function sceneWorldMap(scene: Scene): SerializedWorldMap {
  return {
    width: scene.map.width,
    height: scene.map.height,
    tileSetUrl: '',
    tileSetDimX: 0,
    tileSetDimY: 0,
    tileDim: TILE_PX,
    bgTiles: [],
    objectTiles: [],
    animatedSprites: [],
    collision: sceneCollision(scene),
    anchors: [...sceneAnchors(scene).values()],
  };
}

/** The scene format's tile size, fixed: art positions are validated against `width * 32`. */
export const TILE_PX = 32;

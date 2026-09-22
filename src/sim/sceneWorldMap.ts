import { Scene, SceneMap, mapBlocked } from '../../prototype/content';
import { sceneMap } from '../../prototype/map';
import { Anchor, CollisionLayer, SerializedWorldMap } from '../../engine/aiTown/worldMap';

/**
 * A `dev` scene, read as an agentic map.
 *
 * docs/11 §9 F1 asks whether the two world models merge or sit side by side, and this module
 * answers neither: it adapts one direction only. A scene's map is already a grid of the right
 * shape -- `prototype/map.ts`'s `sceneMap` emits exactly the tile fields `SerializedWorldMap`
 * declares -- so the whole of the gap is two things the agentic engine needs and `dev`'s format
 * does not carry:
 *
 *   - **Collision in the engine's orientation.** A scene stores it as `height` strings of `width`
 *     characters, indexed `[y][x]`; `CollisionLayer` is `[x][y]`. Nothing but a transpose.
 *   - **Described places.** `Scene.anchors` is `Record<id, [x, y]>` -- a bare point, with no
 *     extent and no prose. `Anchor` carries `w`, `h` and a `description`, and the description is
 *     load-bearing: `buildManifest` publishes it as the world's `places` and `parseDecision`
 *     rejects a `wander` anchor that is not among them, so an undescribed anchor is a place no
 *     agent can ever choose to walk to.
 *
 * This is deliberately not the merge. The scene stays the authority on its own art and its own
 * entities; what leaves here is a map, and only the parts of one an agent needs to walk and to
 * name where it is going.
 */

/** A place agents can be told about, and sent to. */
export interface PlaceSpec {
  /**
   * Omitted to reuse the scene's own anchor of the same id; required for a place the scene does
   * not already name. Tile coordinates.
   */
  x?: number;
  y?: number;
  /** Tiles covered. Defaults to a single tile, which is what a scene anchor is. */
  w?: number;
  h?: number;
  /** What the model is told is here. Never optional -- see the note above. */
  description: string;
}

/** `[y][x]` strings of `.`/`#` to the engine's `[x][y]` booleans. */
export function sceneCollision(map: SceneMap): CollisionLayer {
  return Array.from({ length: map.width }, (_, x) =>
    Array.from({ length: map.height }, (_, y) => mapBlocked(map, x, y)),
  );
}

/**
 * Resolve authored places against the scene's anchors.
 *
 * Sorted by id, because docs/05 §10 requires anchor iteration order to be deterministic and
 * `WorldMap` sorts on the way in besides.
 */
export function sceneAnchors(scene: Scene, places: Record<string, PlaceSpec>): Anchor[] {
  return Object.entries(places)
    .map(([id, spec]) => {
      const inherited = scene.anchors[id];
      const x = spec.x ?? inherited?.[0];
      const y = spec.y ?? inherited?.[1];
      if (x === undefined || y === undefined) {
        throw new Error(
          `Place "${id}" gives no position and scene "${scene.id}" has no anchor by that name`,
        );
      }
      return { id, x, y, w: spec.w ?? 1, h: spec.h ?? 1, description: spec.description };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The scene as a world map.
 *
 * The tile layers come along even for a scene that draws itself with art instead (`map.art`,
 * which every `remaining-time` room uses): `tileDim` is what the renderer multiplies positions by
 * and what `Player` reads, so the tile fields are not optional just because nobody paints them.
 */
export function sceneWorldMap(scene: Scene, anchors: Anchor[]): SerializedWorldMap {
  return {
    ...sceneMap(scene),
    collision: sceneCollision(scene.map),
    anchors,
  };
}

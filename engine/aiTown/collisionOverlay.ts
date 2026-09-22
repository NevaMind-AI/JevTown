import { Point } from '../util/types';

/**
 * The dynamic half of collision: tiles blocked by an entity whose `physics.blocks_movement`
 * is currently true. The static half lives in `WorldMap.collision`.
 *
 * This is read on every A* expansion and every position update, synchronously, inside a 16 ms
 * tick, so it is an index rather than a scan over entities (docs/07-map-entity-split.md §5.3).
 *
 * It is derived from world-document state: rebuilt when `Game` loads, mutated when an entity's
 * physics changes, and never persisted. It has no replay implications.
 *
 * Nothing populates it yet — entities arrive with A4 (docs/08 §4).
 */
export class CollisionOverlay {
  // tile key -> number of blocking entities covering it, so overlapping footprints uncover
  // correctly when one of them opens.
  private counts: Map<number, number> = new Map();

  constructor(private width: number) {}

  private key(x: number, y: number): number {
    return y * this.width + x;
  }

  blocked(x: number, y: number): boolean {
    return this.counts.has(this.key(x, y));
  }

  add(tiles: Point[]) {
    for (const { x, y } of tiles) {
      const key = this.key(x, y);
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
  }

  remove(tiles: Point[]) {
    for (const { x, y } of tiles) {
      const key = this.key(x, y);
      const count = this.counts.get(key);
      if (count === undefined) {
        continue;
      }
      if (count <= 1) {
        this.counts.delete(key);
      } else {
        this.counts.set(key, count - 1);
      }
    }
  }

  clear() {
    this.counts.clear();
  }
}

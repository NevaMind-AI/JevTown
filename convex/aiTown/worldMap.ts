import { Infer, ObjectType, v } from 'convex/values';

// `layer[position.x][position.y]` is the tileIndex or -1 if empty.
const tileLayer = v.array(v.array(v.number()));
export type TileLayer = Infer<typeof tileLayer>;

// `collision[position.x][position.y]` is true if the tile is solid. Separate from the object
// layers so "drawn above the ground" and "solid" stop being the same statement.
// See docs/07-map-entity-split.md §5.1.
const collisionLayer = v.array(v.array(v.boolean()));
export type CollisionLayer = Infer<typeof collisionLayer>;

const animatedSprite = {
  x: v.number(),
  y: v.number(),
  w: v.number(),
  h: v.number(),
  layer: v.number(),
  sheet: v.string(),
  animation: v.string(),
};
export type AnimatedSprite = ObjectType<typeof animatedSprite>;

// A named rectangle in tile space. The world file addresses places by anchor id and never
// contains raw tile coordinates; `description` is what the writer agent reads.
// See docs/07-map-entity-split.md §4.
const anchor = {
  id: v.string(),
  x: v.number(),
  y: v.number(),
  w: v.number(),
  h: v.number(),
  description: v.string(),
};
export type Anchor = ObjectType<typeof anchor>;

export const serializedWorldMap = {
  width: v.number(),
  height: v.number(),

  tileSetUrl: v.string(),
  //  Width & height of tileset image, px.
  tileSetDimX: v.number(),
  tileSetDimY: v.number(),

  // Tile size in pixels (assume square)
  tileDim: v.number(),
  bgTiles: v.array(v.array(v.array(v.number()))),
  objectTiles: v.array(tileLayer),
  animatedSprites: v.array(v.object(animatedSprite)),

  // Optional so maps generated before docs/07 keep loading: when `collision` is absent it's
  // derived from the object layers, and a map with no anchors simply has nowhere to anchor
  // entities. Both are always written back out.
  collision: v.optional(collisionLayer),
  anchors: v.optional(v.array(v.object(anchor))),
};
export type SerializedWorldMap = ObjectType<typeof serializedWorldMap>;

export class WorldMap {
  width: number;
  height: number;

  tileSetUrl: string;
  tileSetDimX: number;
  tileSetDimY: number;

  tileDim: number;

  bgTiles: TileLayer[];
  objectTiles: TileLayer[];
  animatedSprites: AnimatedSprite[];

  collision: CollisionLayer;
  anchors: Map<string, Anchor>;

  constructor(serialized: SerializedWorldMap) {
    this.width = serialized.width;
    this.height = serialized.height;
    this.tileSetUrl = serialized.tileSetUrl;
    this.tileSetDimX = serialized.tileSetDimX;
    this.tileSetDimY = serialized.tileSetDimY;
    this.tileDim = serialized.tileDim;
    this.bgTiles = serialized.bgTiles;
    this.objectTiles = serialized.objectTiles;
    this.animatedSprites = serialized.animatedSprites;
    this.collision =
      serialized.collision ?? deriveCollision(serialized.objectTiles, this.width, this.height);
    this.anchors = new Map(
      [...(serialized.anchors ?? [])]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((a) => [a.id, a]),
    );
  }

  // True if the static map blocks this tile. Entity physics is a separate source, tracked by
  // the dynamic overlay on `Game` (docs/07 §5.3).
  blockedStatic(x: number, y: number): boolean {
    return this.collision[x]?.[y] ?? false;
  }

  anchor(id: string): Anchor | undefined {
    return this.anchors.get(id);
  }

  // Every tile an anchor covers, clipped to the map.
  anchorTiles(id: string): { x: number; y: number }[] {
    const found = this.anchor(id);
    if (!found) {
      return [];
    }
    const tiles = [];
    for (let x = found.x; x < Math.min(found.x + found.w, this.width); x++) {
      for (let y = found.y; y < Math.min(found.y + found.h, this.height); y++) {
        tiles.push({ x, y });
      }
    }
    return tiles;
  }

  /**
   * Tiles adjacent to an anchor's rect — where an agent stands to act on what is anchored there.
   * An anchor is a rectangle, so a 3x2 gate has ten places you could stand (docs/09 §6).
   */
  approachTiles(id: string): { x: number; y: number }[] {
    const found = this.anchor(id);
    if (!found) {
      return [];
    }
    const tiles = [];
    for (let x = found.x - 1; x <= found.x + found.w; x++) {
      for (let y = found.y - 1; y <= found.y + found.h; y++) {
        const insideRect =
          x >= found.x && x < found.x + found.w && y >= found.y && y < found.y + found.h;
        if (insideRect || x < 0 || y < 0 || x >= this.width || y >= this.height) {
          continue;
        }
        tiles.push({ x, y });
      }
    }
    return tiles;
  }

  serialize(): SerializedWorldMap {
    return {
      width: this.width,
      height: this.height,
      tileSetUrl: this.tileSetUrl,
      tileSetDimX: this.tileSetDimX,
      tileSetDimY: this.tileSetDimY,
      tileDim: this.tileDim,
      bgTiles: this.bgTiles,
      objectTiles: this.objectTiles,
      animatedSprites: this.animatedSprites,
      collision: this.collision,
      anchors: [...this.anchors.values()],
    };
  }
}

// The pre-docs/07 rule: any non-empty object tile is solid. Retained so unmigrated maps —
// `data/gentle.js` included — behave exactly as they did before.
function deriveCollision(objectTiles: TileLayer[], width: number, height: number): CollisionLayer {
  const collision: CollisionLayer = [];
  for (let x = 0; x < width; x++) {
    collision[x] = [];
    for (let y = 0; y < height; y++) {
      collision[x][y] = objectTiles.some((layer) => layer[x]?.[y] !== undefined && layer[x][y] !== -1);
    }
  }
  return collision;
}

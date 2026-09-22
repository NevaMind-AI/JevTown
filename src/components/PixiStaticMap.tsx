import { PixiComponent, applyDefaultProps } from '@pixi/react';
import * as PIXI from 'pixi.js';
import type { AnimatedSprite, MapRender, TileMap } from '../../prototype/mapData';

/**
 * The rendering subset of a world map.
 *
 * Two callers pass a map here: `PixiGame` hands over the `WorldMap` class, and `LocalGame` builds
 * a plain object from scene content. Both carry these nine fields identically. They disagree about
 * `collision` and `anchors` -- the class holds a resolved layer and a `Map`, the scene object holds
 * the serialized optional forms -- and neither renderer reads either one, so the prop asks only for
 * what it draws.
 */
export type RenderableMap = Pick<
  WorldMap,
  | 'width'
  | 'height'
  | 'tileSetUrl'
  | 'tileSetDimX'
  | 'tileSetDimY'
  | 'tileDim'
  | 'bgTiles'
  | 'objectTiles'
  | 'animatedSprites'
>;

export const PixiStaticMap = PixiComponent('StaticMap', {
  create: (props: {
<<<<<<< HEAD
    map: TileMap & { animationSheets?: MapRender['animationSheets'] };
=======
    map: RenderableMap & { animationSheets?: MapRender['animationSheets'] };
>>>>>>> 2937c94 (🔀 merge: bring feat/agentic onto dev (phase 1))
    assetBase?: string;
    [k: string]: any;
  }) => {
    const map = props.map;
    const base = (props.assetBase ?? import.meta.env.BASE_URL).replace(/\/$/, '');
    const assetUrl = (path: string) =>
      path.startsWith('assets/') ? `${base}/${path}` : path.replace('/ai-town', base);
    const numxtiles = Math.floor(map.tileSetDimX / map.tileDim);
    const numytiles = Math.floor(map.tileSetDimY / map.tileDim);
    const bt = PIXI.BaseTexture.from(assetUrl(map.tileSetUrl), {
      scaleMode: PIXI.SCALE_MODES.NEAREST,
    });

    const tiles = [];
    for (let x = 0; x < numxtiles; x++) {
      for (let y = 0; y < numytiles; y++) {
        tiles[x + y * numxtiles] = new PIXI.Texture(
          bt,
          new PIXI.Rectangle(x * map.tileDim, y * map.tileDim, map.tileDim, map.tileDim),
        );
      }
    }
    const screenxtiles = map.bgTiles[0].length;
    const screenytiles = map.bgTiles[0][0].length;

    const container = new PIXI.Container();
    const allLayers = [...map.bgTiles, ...map.objectTiles];

    // blit bg & object layers of map onto canvas
    for (let i = 0; i < screenxtiles * screenytiles; i++) {
      const x = i % screenxtiles;
      const y = Math.floor(i / screenxtiles);
      const xPx = x * map.tileDim;
      const yPx = y * map.tileDim;

      // Add all layers of backgrounds.
      for (const layer of allLayers) {
        const tileIndex = layer[x][y];
        // Some layers may not have tiles at this location.
        if (tileIndex === -1) continue;
        const ctile = new PIXI.Sprite(tiles[tileIndex]);
        ctile.x = xPx;
        ctile.y = yPx;
        container.addChild(ctile);
      }
    }

    // TODO: Add layers.
    const spritesBySheet = new Map<string, AnimatedSprite[]>();
    for (const sprite of map.animatedSprites) {
      const sheet = sprite.sheet;
      if (!spritesBySheet.has(sheet)) {
        spritesBySheet.set(sheet, []);
      }
      spritesBySheet.get(sheet)!.push(sprite);
    }
    const animations: MapRender['animationSheets'] = map.animationSheets ?? {};
    for (const [sheet, sprites] of spritesBySheet.entries()) {
      const animation = animations[sheet];
      if (!animation) {
        console.error('Could not find animation', sheet);
        continue;
      }
      const { spritesheet, image } = animation;
      const texture = PIXI.BaseTexture.from(assetUrl(image), {
        scaleMode: PIXI.SCALE_MODES.NEAREST,
      });
      const spriteSheet = new PIXI.Spritesheet(texture, spritesheet);
      spriteSheet.parse().then(() => {
        for (const sprite of sprites) {
          const pixiAnimation = spriteSheet.animations[sprite.animation];
          if (!pixiAnimation) {
            console.error('Failed to load animation', sprite);
            continue;
          }
          const pixiSprite = new PIXI.AnimatedSprite(pixiAnimation);
          pixiSprite.animationSpeed = 0.1;
          pixiSprite.autoUpdate = true;
          pixiSprite.x = sprite.x;
          pixiSprite.y = sprite.y;
          pixiSprite.width = sprite.w;
          pixiSprite.height = sprite.h;
          container.addChild(pixiSprite);
          pixiSprite.play();
        }
      });
    }

    container.x = 0;
    container.y = 0;

    // Set the hit area manually to ensure `pointerdown` events are delivered to this container.
    container.interactive = true;
    container.hitArea = new PIXI.Rectangle(
      0,
      0,
      screenxtiles * map.tileDim,
      screenytiles * map.tileDim,
    );

    return container;
  },

  applyProps: (instance, oldProps, newProps) => {
    applyDefaultProps(instance, oldProps, newProps);
  },
});

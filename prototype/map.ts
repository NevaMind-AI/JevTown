import { columnMajorLayers } from './mapData';
import { mapBlocked, type Scene } from './content';

export const localRoom = {
  width: 5,
  height: 5,
  objectTiles: [] as number[][][],
  spawn: { x: 1, y: 1 },
  npc: { x: 3, y: 1 },
  stepMs: 160,
};

export function sceneMap(scene: Scene) {
  if (scene.map.render) {
    const { matrixOrder, ...render } = scene.map.render;
    return {
      ...render,
      width: scene.map.width,
      height: scene.map.height,
      bgTiles: matrixOrder === 'yx' ? columnMajorLayers(render.bgTiles) : render.bgTiles,
      objectTiles:
        matrixOrder === 'yx' ? columnMajorLayers(render.objectTiles) : render.objectTiles,
    };
  }
  const { width, height, floorTile, wallTile } = scene.map;
  const layer = (tile: (x: number, y: number) => number) =>
    Array.from({ length: width }, (_, x) => Array.from({ length: height }, (_, y) => tile(x, y)));
  return {
    width,
    height,
    tileSetUrl: '/ai-town/assets/gentle-obj.png',
    tileSetDimX: 1440,
    tileSetDimY: 1024,
    tileDim: 32,
    bgTiles: [layer(() => floorTile!)],
    objectTiles: [layer((x, y) => (mapBlocked(scene.map, x, y) ? wallTile! : -1))],
    animatedSprites: [],
  };
}

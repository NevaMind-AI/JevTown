import type { ISpritesheetData } from 'pixi.js';

export type AnimatedSprite = {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  sheet: string;
  animation: string;
};

export type TileMap = {
  width: number;
  height: number;
  tileSetUrl: string;
  tileSetDimX: number;
  tileSetDimY: number;
  tileDim: number;
  // Renderer layers use column-major order: layer[x][y].
  bgTiles: number[][][];
  objectTiles: number[][][];
  animatedSprites: AnimatedSprite[];
};

export type MapRender = Omit<TileMap, 'width' | 'height'> & {
  matrixOrder?: 'yx'; // Absent only in recordings made before row-major map authoring.
  animationSheets: Record<
    string,
    {
      image: string;
      spritesheet: ISpritesheetData & {
        meta: ISpritesheetData['meta'] & { size: { w: number; h: number } };
      };
    }
  >;
};

// The shared renderer uses columns; authored maps use rows.
export function columnMajorLayers(rows: number[][][]): number[][][] {
  return rows.map((layer) => layer[0].map((_, x) => layer.map((row) => row[x])));
}

// Map data is embedded in Content after package loading, including animation frames.
export function validateMapRender(raw: unknown, width: number, height: number): void {
  const fail = () => {
    throw new Error('Invalid map render data');
  };
  const record = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
  const fields = (v: any, required: string[], optional: string[] = []) => {
    if (
      !record(v) ||
      required.some((k) => !Object.hasOwn(v, k)) ||
      Object.keys(v).some((k) => ![...required, ...optional].includes(k))
    )
      fail();
  };
  const integer = (v: any, min: number, max: number) => {
    if (!Number.isSafeInteger(v) || v < min || v > max) fail();
  };
  const image = (v: any) => {
    if (typeof v !== 'string' || !/^assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.png$/.test(v))
      fail();
  };
  const m: any = raw;
  fields(
    m,
    [
      'tileSetUrl',
      'tileSetDimX',
      'tileSetDimY',
      'tileDim',
      'bgTiles',
      'objectTiles',
      'animatedSprites',
      'animationSheets',
    ],
    ['matrixOrder'],
  );
  if (m.matrixOrder !== undefined && m.matrixOrder !== 'yx') fail();
  const rows = m.matrixOrder === 'yx';
  image(m.tileSetUrl);
  if (m.tileDim !== 32) fail();
  for (const n of [m.tileSetDimX, m.tileSetDimY]) {
    integer(n, 32, 8192);
    if (n % 32) fail();
  }
  const tiles = (m.tileSetDimX * m.tileSetDimY) / 1024;
  for (const layers of [m.bgTiles, m.objectTiles]) {
    if (!Array.isArray(layers) || layers.length > 8) fail();
    for (const layer of layers) {
      if (!Array.isArray(layer) || layer.length !== (rows ? height : width)) fail();
      for (const line of layer) {
        if (!Array.isArray(line) || line.length !== (rows ? width : height)) fail();
        for (const tile of line) integer(tile, -1, tiles - 1);
      }
    }
  }
  if (!m.bgTiles.length || !record(m.animationSheets) || Object.keys(m.animationSheets).length > 32)
    fail();
  for (const [id, value] of Object.entries(m.animationSheets)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id))
      fail();
    const sheet: any = value;
    fields(sheet, ['image', 'spritesheet']);
    image(sheet.image);
    const data = sheet.spritesheet;
    fields(data, ['frames', 'animations', 'meta']);
    if (!record(data.frames) || !record(data.animations)) fail();
    const names = Object.keys(data.frames);
    if (
      [...names, ...Object.keys(data.animations)].some(
        (name) =>
          !name || name.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(name),
      )
    )
      fail();
    if (!names.length || names.length > 1024 || Object.keys(data.animations).length > 100) fail();
    fields(data.meta, ['size', 'scale'], ['image', 'format', 'app', 'version']);
    fields(data.meta.size, ['w', 'h']);
    integer(data.meta.size.w, 1, 8192);
    integer(data.meta.size.h, 1, 8192);
    if (data.meta.scale !== '1') fail();
    for (const frame of Object.values(data.frames) as any[]) {
      fields(frame, ['frame'], ['rotated', 'trimmed', 'spriteSourceSize', 'sourceSize']);
      fields(frame.frame, ['x', 'y', 'w', 'h']);
      const f = frame.frame;
      integer(f.x, 0, data.meta.size.w - 1);
      integer(f.y, 0, data.meta.size.h - 1);
      integer(f.w, 1, data.meta.size.w - f.x);
      integer(f.h, 1, data.meta.size.h - f.y);
      for (const key of ['rotated', 'trimmed'])
        if (frame[key] !== undefined && typeof frame[key] !== 'boolean') fail();
      if (frame.sourceSize !== undefined) {
        fields(frame.sourceSize, ['w', 'h']);
        integer(frame.sourceSize.w, 1, 8192);
        integer(frame.sourceSize.h, 1, 8192);
      }
      if (frame.spriteSourceSize !== undefined) {
        fields(frame.spriteSourceSize, ['x', 'y', 'w', 'h']);
        for (const key of ['x', 'y', 'w', 'h']) integer(frame.spriteSourceSize[key], 0, 8192);
      }
      if (frame.trimmed && (!frame.sourceSize || !frame.spriteSourceSize)) fail();
    }
    for (const frames of Object.values(data.animations)) {
      if (
        !Array.isArray(frames) ||
        !frames.length ||
        frames.length > 1024 ||
        frames.some((name) => typeof name !== 'string' || !Object.hasOwn(data.frames, name))
      )
        fail();
    }
  }
  if (!Array.isArray(m.animatedSprites) || m.animatedSprites.length > 256) fail();
  for (const sprite of m.animatedSprites) {
    fields(sprite, ['x', 'y', 'w', 'h', 'layer', 'sheet', 'animation']);
    integer(sprite.x, 0, width * 32 - 1);
    integer(sprite.y, 0, height * 32 - 1);
    integer(sprite.w, 1, width * 32);
    integer(sprite.h, 1, height * 32);
    integer(sprite.layer, 0, 15);
    if (
      typeof sprite.sheet !== 'string' ||
      !Object.hasOwn(m.animationSheets, sprite.sheet) ||
      typeof sprite.animation !== 'string' ||
      !Object.hasOwn(m.animationSheets[sprite.sheet].spritesheet.animations, sprite.animation)
    )
      fail();
  }
}

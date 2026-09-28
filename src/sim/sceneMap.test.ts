import { readFileSync } from 'node:fs';
import { loadPackage } from '../../prototype/package';
import { mapBlocked, type Scene } from '../../prototype/content';
import { WorldMap } from '../../engine/aiTown/worldMap';
import { validateWorldFile, type WorldFile } from '../../engine/aiTown/worldFile';
import {
  sceneAnchors,
  sceneCollision,
  sceneContext,
  sceneMapContext,
  sceneRegistry,
  sceneWorldMap,
} from './sceneMap';

/**
 * The shipped scene set, read the way `LocalGame` reads it: maps come from `src/content`, which
 * the app resolves through `import.meta.glob`, and everything else from `public/content`.
 */
const read = async (path: string) =>
  JSON.parse(
    readFileSync(
      path.startsWith('maps/')
        ? `src/content/remaining-time/${path}`
        : `public/content/remaining-time/${path}`,
      'utf8',
    ),
  );

let scenes: Scene[];
let startScene: string;

beforeAll(async () => {
  const manifest = await read('manifest.json');
  const pack = await loadPackage(manifest, read);
  scenes = pack.scenes;
  startScene = pack.story.start.scene;
});

describe('scene collision', () => {
  test('every tile of every shipped scene agrees with mapBlocked, transposed', () => {
    expect(scenes.length).toBe(26);
    for (const scene of scenes) {
      const collision = sceneCollision(scene);
      expect(collision.length).toBe(scene.map.width);
      for (let x = 0; x < scene.map.width; x++) {
        expect(collision[x].length).toBe(scene.map.height);
        for (let y = 0; y < scene.map.height; y++) {
          expect(collision[x][y]).toBe(mapBlocked(scene.map, x, y));
        }
      }
    }
  });

  test('a scene with no collision layer keeps the border rule rather than reading as open', () => {
    const scene = {
      id: 'bare',
      map: { width: 4, height: 3 },
      anchors: {},
      entities: [],
    } as unknown as Scene;
    const collision = sceneCollision(scene);
    expect(collision[0][0]).toBe(true);
    expect(collision[1][1]).toBe(false);
    expect(collision[3][2]).toBe(true);
  });

  test('out of bounds is blocked, so a world file naming a tile off the edge fails', () => {
    const ground = sceneContext(scenes[0]);
    expect(ground.blocked(-1, 0)).toBe(true);
    expect(ground.blocked(ground.width, 0)).toBe(true);
    expect(ground.blocked(0, ground.height)).toBe(true);
  });
});

describe('scene anchors', () => {
  test('a point anchor becomes the 1x1 rect at that tile', () => {
    const scene = { anchors: { start: [8, 12] } } as unknown as Scene;
    expect(sceneAnchors(scene).get('start')).toEqual({
      id: 'start',
      x: 8,
      y: 12,
      w: 1,
      h: 1,
      description: '',
    });
  });

  test('a four-entry anchor is read as the rect it spells out', () => {
    const scene = { anchors: { bar: [3, 4, 2, 5] } } as unknown as Scene;
    expect(sceneAnchors(scene).get('bar')).toMatchObject({ x: 3, y: 4, w: 2, h: 5 });
  });

  test('anchors come out sorted by id', () => {
    const scene = { anchors: { zed: [1, 1], alpha: [2, 2], mid: [3, 3] } } as unknown as Scene;
    expect([...sceneAnchors(scene).keys()]).toEqual(['alpha', 'mid', 'zed']);
  });

  test('every shipped anchor lands on a walkable tile', () => {
    for (const scene of scenes) {
      for (const [id, anchor] of sceneAnchors(scene)) {
        expect([scene.id, id, mapBlocked(scene.map, anchor.x, anchor.y)]).toEqual([
          scene.id,
          id,
          false,
        ]);
      }
    }
  });
});

describe('the registry', () => {
  test('holds every scene, keyed by id and sorted', () => {
    const registry = sceneRegistry(scenes);
    expect(registry.size).toBe(scenes.length);
    expect([...registry.keys()]).toEqual([...registry.keys()].sort());
    expect(registry.get('low-deck')?.anchors.get('start')).toMatchObject({ x: 8, y: 12 });
  });

  test('anchor ids really are scene-local, which is why the registry is keyed', () => {
    const registry = sceneRegistry(scenes);
    const withStart = [...registry.values()].filter((ground) => ground.anchors.has('start'));
    expect(withStart.length).toBe(26);
  });

  test('the map context mirrors its default scene', () => {
    const context = sceneMapContext(scenes, ['f1'], startScene);
    const start = sceneRegistry(scenes).get(startScene)!;
    expect(context.defaultScene).toBe(startScene);
    expect(context.width).toBe(start.width);
    expect(context.height).toBe(start.height);
    expect([...context.anchors.keys()]).toEqual([...start.anchors.keys()]);
    expect(context.scenes?.size).toBe(26);
  });

  test('an unknown default scene is refused rather than silently placing nothing', () => {
    expect(() => sceneMapContext(scenes, [], 'no-such-scene')).toThrow('no-such-scene');
  });
});

describe('the engine reads the scene as a map', () => {
  test('WorldMap over a scene blocks exactly what mapBlocked blocks', () => {
    const scene = scenes.find((s) => s.id === 'low-deck')!;
    const map = new WorldMap(sceneWorldMap(scene));
    expect(map.width).toBe(scene.map.width);
    for (let x = 0; x < map.width; x++) {
      for (let y = 0; y < map.height; y++) {
        expect(map.blockedStatic(x, y)).toBe(mapBlocked(scene.map, x, y));
      }
    }
  });

  test('anchorTiles and approachTiles work over a scene anchor', () => {
    const scene = scenes.find((s) => s.id === 'low-deck')!;
    const map = new WorldMap(sceneWorldMap(scene));
    expect(map.anchorTiles('start')).toEqual([{ x: 8, y: 12 }]);
    expect(map.approachTiles('start')).toEqual(
      expect.arrayContaining([
        { x: 7, y: 12 },
        { x: 9, y: 12 },
      ]),
    );
  });
});

describe('a world file validated against real ground', () => {
  const entity = (overrides: Record<string, unknown>) => ({
    id: 'ash-agent',
    kind: 'actor' as const,
    mobile: true,
    character: 'f1',
    description: 'A dock hand who has read every notice on the deck twice and believes none.',
    initial_state: 'state: wary\n\nShe is waiting for someone who is late.',
    ...overrides,
  });
  const file = (entities: unknown[]): WorldFile =>
    ({ format_version: 'a1.0', world_rules: 'A deck.', entities }) as WorldFile;

  test('an entity placed in a named scene resolves that scene’s anchor', () => {
    const context = sceneMapContext(scenes, ['f1'], startScene);
    const result = validateWorldFile(
      file([entity({ scene: 'low-deck', spawn: { anchor: 'from-duct-b' } })]),
      context,
    );
    expect(result.errors).toEqual([]);
  });

  test('an anchor from the wrong scene is caught, and the message says which scene', () => {
    const context = sceneMapContext(scenes, ['f1'], startScene);
    const result = validateWorldFile(
      file([entity({ scene: 'unit-404', spawn: { anchor: 'from-duct-b' } })]),
      context,
    );
    expect(result.errors).toEqual([
      'entity "ash-agent": unknown anchor "from-duct-b" in scene "unit-404"',
    ]);
  });

  test('an unknown scene is an error, not a fallback to the default', () => {
    const context = sceneMapContext(scenes, ['f1'], startScene);
    const result = validateWorldFile(
      file([entity({ scene: 'low-dekc', spawn: { anchor: 'start' } })]),
      context,
    );
    expect(result.errors).toContain('entity "ash-agent": unknown scene "low-dekc"');
  });

  test('an entity naming no scene is placed in the default one', () => {
    const context = sceneMapContext(scenes, ['f1'], startScene);
    const result = validateWorldFile(file([entity({ spawn: { anchor: 'start' } })]), context);
    expect(result.errors).toEqual([]);
  });

  test('two scenes claiming the same tile do not read as a stack', () => {
    const context = sceneMapContext(scenes, ['f1'], startScene);
    const prop = (id: string, scene: string) => ({
      id,
      kind: 'prop' as const,
      scene,
      anchor: 'start',
      description: 'A notice board nobody has updated since the refit, and everybody still reads.',
    });
    const result = validateWorldFile(
      file([prop('board-a', 'low-deck'), prop('board-b', 'unit-404')]),
      context,
    );
    expect(result.warnings.filter((w) => w.includes('stack'))).toEqual([]);
  });
});

describe('the sprite vocabulary', () => {
  test('an unknown sprite is refused when the host declares a vocabulary', () => {
    const context = sceneMapContext(scenes, ['f1'], startScene);
    const prop = {
      id: 'well',
      kind: 'prop' as const,
      scene: 'low-deck',
      anchor: 'start',
      sprite: 'wishing-well',
      description: 'A well that has not held water since the refit, and still takes coins.',
    };
    const file = (entities: unknown[]) =>
      ({ format_version: 'a1.0', world_rules: 'A deck.', entities }) as WorldFile;

    expect(validateWorldFile(file([prop]), context).errors).toEqual([]);
    expect(
      validateWorldFile(file([prop]), { ...context, sprites: new Set(['wishing-well']) }).errors,
    ).toEqual([]);
    expect(
      validateWorldFile(file([prop]), { ...context, sprites: new Set(['other']) }).errors,
    ).toEqual(['entity "well": unknown sprite "wishing-well"']);
  });
});

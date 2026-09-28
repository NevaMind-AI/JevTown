import { loadContent, Content } from './content.js';

function keys(value: any, required: string[], optional: string[] = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => ![...required, ...optional].includes(k))
  )
    throw new Error('Invalid package fields');
}
export type Package = Content;

// The manifest is the only entry point. The reader can be fetch or an in-memory test map.
export async function loadPackage(
  manifest: unknown,
  read: (path: string) => Promise<unknown>,
): Promise<Package> {
  const m: any = manifest;
  keys(m, ['schema_version', 'content_version', 'scenes', 'stories', 'start'], ['npcs', 'world']);
  if (m.schema_version !== '1.0' || typeof m.content_version !== 'string')
    throw new Error('Unsupported package version');
  const paths = (value: any): string[] => {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > 100 ||
      value.some(
        (p) => typeof p !== 'string' || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json$/.test(p),
      ) ||
      new Set(value).size !== value.length
    )
      throw new Error('Invalid package paths');
    return value;
  };
  const [rawScenes, stories] = await Promise.all(
    [paths(m.scenes), paths(m.stories)].map((list) => Promise.all(list.map(read))),
  );
  const scenes = await Promise.all(
    rawScenes.map(async (raw) => {
      const scene: any = structuredClone(raw);
      if (scene?.map?.source !== undefined) {
        keys(scene.map, ['source']);
        scene.map = structuredClone(await read(paths([scene.map.source])[0]));
      }
      const sheets = scene?.map?.render?.animationSheets;
      if (sheets !== undefined) {
        if (
          !sheets ||
          typeof sheets !== 'object' ||
          Array.isArray(sheets) ||
          Object.keys(sheets).length > 32
        )
          throw new Error('Invalid map animation sheets');
        await Promise.all(
          Object.values(sheets).map(async (value: any) => {
            keys(value, ['image', 'spritesheet']);
            if (typeof value.spritesheet === 'string')
              value.spritesheet = structuredClone(await read(paths([value.spritesheet])[0]));
          }),
        );
      }
      return scene;
    }),
  );
  const combined: any = {
    schema_version: '1.0',
    content_version: m.content_version,
    start: m.start,
    vars: {},
    interactions: {},
    tasks: [],
  };
  const storyIds = new Set();
  for (const raw of stories) {
    const story: any = raw;
    keys(
      story,
      ['schema_version', 'content_version', 'id', 'vars', 'interactions'],
      ['tasks', 'items', 'shops', 'clues', 'clock', 'schedules', 'sprites'],
    );
    if (
      story.schema_version !== '1.0' ||
      typeof story.content_version !== 'string' ||
      typeof story.id !== 'string' ||
      storyIds.has(story.id)
    )
      throw new Error('Invalid story version/id');
    storyIds.add(story.id);
    for (const field of ['vars', 'interactions', 'shops', 'schedules', 'sprites']) {
      if (field !== 'vars' && field !== 'interactions') {
        if (story[field] === undefined) continue;
        combined[field] ??= {};
      }
      if (!story[field] || typeof story[field] !== 'object' || Array.isArray(story[field]))
        throw new Error('Invalid story section');
      for (const [key, value] of Object.entries(story[field])) {
        if (
          ['__proto__', 'constructor', 'prototype'].includes(key) ||
          Object.hasOwn(combined[field], key)
        )
          throw new Error(`Conflicting story ${field}: ${key}`);
        combined[field][key] = value;
      }
    }

    if (story.clock !== undefined) {
      if (combined.clock !== undefined) throw new Error('Conflicting clock settings');
      combined.clock = story.clock;
    }

    if (story.items !== undefined) {
      if (!Array.isArray(story.items)) throw new Error('Invalid items');
      (combined.items ??= []).push(...story.items);
    }
    if (story.clues !== undefined) {
      if (!Array.isArray(story.clues)) throw new Error('Invalid clues');
      (combined.clues ??= []).push(...story.clues);
    }
    if (story.tasks !== undefined && !Array.isArray(story.tasks)) throw new Error('Invalid tasks');
    combined.tasks.push(...(story.tasks ?? []));
  }
  const npcs: Record<string, any> | undefined = m.npcs === undefined ? undefined : {};
  if (npcs) {
    for (const raw of await Promise.all(paths(m.npcs).map(read))) {
      const npc: any = raw;
      keys(
        npc,
        ['schema_version', 'content_version', 'id', 'name', 'character', 'abilities'],
        ['image'],
      );
      if (
        npc.schema_version !== '1.0' ||
        typeof npc.content_version !== 'string' ||
        typeof npc.id !== 'string' ||
        ['__proto__', 'constructor', 'prototype'].includes(npc.id) ||
        Object.hasOwn(npcs, npc.id)
      )
        throw new Error('Invalid or duplicate NPC definition');
      const { schema_version, content_version, ...definition } = npc;
      npcs[npc.id] = definition;
    }
  }
  /**
   * The agentic world file, when the package ships one (docs/13 §2 J).
   *
   * One path rather than a list: a package describes one world, and two files claiming the same
   * entity id would have no rule to resolve it by. `loadContent` places its entities onto the
   * scenes; `engine/aiTown/worldFile.ts` validates everything else about it.
   */
  let world: any;
  if (m.world !== undefined) {
    world = await read(paths([m.world])[0]);
    keys(world, ['format_version', 'entities'], ['meta', 'world_rules', 'world_state', 'god']);
    if (!Array.isArray(world.entities)) throw new Error('Invalid world entities');
  }
  // The whole file, not just its entities: placement reads `entities`, and the agentic world
  // (`createAgenticWorld`) reads the rest from the same object — one file, read twice.
  return loadContent(scenes, combined, npcs, world);
}

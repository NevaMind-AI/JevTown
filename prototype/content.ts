import { abilityFields, abilitySettings, type Npc } from './abilities.js';
import { validateMapRender, type MapRender } from './mapData.js';
import type { NpcSchedule } from './schedules.js';
import { npcPath } from './pathfinding.js';
import { validateVisual, Visual } from './assets.js';
import { factFields, TaskCondition } from './taskFacts.js';
export type Entity = {
  id: string;
  name: string;
  position: number[];
  character: string;
  sprite?: Visual;
  seatedOn?: string;
  seat?: { table?: string; orientation: number; depth: number; playerSprite: Visual };
  interactionOffsets?: number[][];
  movable?: boolean;
  portal?: { scene: string; anchor: string };
  portalTiles?: number[][];
};
export type SceneMap = {
  width: number;
  height: number;
  floorTile?: number;
  wallTile?: number;
  render?: MapRender;
  showTiles?: boolean;
  playerScale?: number;
  collision?: string[];
  blockedEdges?: number[][];
  art?: (Visual & { position: number[]; depth: number })[];
};
export function mapBlocked(map: SceneMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  return map.collision
    ? map.collision[y][x] === '#'
    : x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1;
}
export function mapEdgeBlocked(map: SceneMap, from: number[], to: number[]): boolean {
  return (
    map.blockedEdges?.some(
      ([ax, ay, bx, by]) =>
        (from[0] === ax && from[1] === ay && to[0] === bx && to[1] === by) ||
        (from[0] === bx && from[1] === by && to[0] === ax && to[1] === ay),
    ) ?? false
  );
}
export type Scene = {
  schema_version: string;
  content_version: string;
  id: string;
  name: string;
  map: SceneMap;
  anchors: Record<string, number[]>;
  entities: Entity[];
};
export function portalAt(scene: Scene, x: number, y: number) {
  return scene.entities.find(
    (entity) =>
      entity.portal &&
      (entity.portalTiles ?? [entity.position]).some(([px, py]) => px === x && py === y),
  );
}
export type Condition = { var: string; equals: boolean } | { task: string; step: string };
export const RELIC_SLOTS = 31;
export type RelicClue = { id: string; slot: number; text: string; source: string };
export type Sleep =
  | { op: 'sleep'; selectHours: true }
  | { op: 'sleep'; seconds: number }
  | { op: 'sleep'; nextDayAt: number };
export type Choice = {
  id: string;
  text: string;
  topic?: string;
  opens?: string;
  when?: Condition;
  effects: (
    | Sleep
    | { op: 'set'; var: string; value: boolean }
    | { op: 'pay_time'; seconds: number }
    | { op: 'grant_clue'; clue: string }
    | { op: 'give_item' | 'pickup_item' | 'take_item'; item: string; quantity: number }
    | { op: 'travel' }
    | { op: 'move_entity'; entity: string; path: number[][]; via?: string; arrival?: string }
  )[];
};
export type Task = {
  trigger?: { var: string; equals: boolean };
  id: string;
  title: string;
  background?: string;
  description: string;
  completion?: { background: string; description: string };
  steps: {
    id: string;
    text: string;
    background?: string;
    description?: string;
    marker?: '!' | '?';
    condition: TaskCondition;
  }[];
};
export type Item = {
  id: string;
  name: string;
  image: string;
  category: string;
  quality: string;
  description: string;
  kind?: 'relic';
  initiallyOwned?: boolean;
  slot?: number;
  effectDescription?: string;
};
export type Shop = {
  name: string;
  restock?: { intervalSeconds: number };
  offers: { item: string; buySeconds: number; sellSeconds: number; stock: number }[];
};
export type DialogueText = {
  text: string;
  variants?: string[];
  replies?: { when: Condition; text: string; variants?: string[] }[];
};
export type Story = {
  // schedules/shops are retained for legacy content only.
  schedules?: Record<string, NpcSchedule>;
  clock?: {
    rate?: number;
    realSecondsPerTick?: number;
    gameSecondsPerTick?: number;
    idlePauseSeconds?: number;
    initialBalanceSeconds?: number;
    startTimeSeconds?: number;
  };
  clues?: RelicClue[];
  items?: Item[];
  shops?: Record<string, Shop>;
  tasks?: Task[];
  schema_version: string;
  content_version: string;
  start: { scene: string; anchor: string };
  vars: Record<string, boolean>;
  interactions: Record<
    string,
    DialogueText & { firstText?: string; topics?: Record<string, DialogueText>; choices: Choice[] }
  >;
};
export type Content = { scenes: Scene[]; story: Story; npcs?: Record<string, Npc> };

// Strict, bounded demo contract. Unknown keys fail instead of being silently ignored.
export function loadContent(rawScenes: unknown[], rawStory: unknown, rawNpcs?: unknown): Content {
  const object = (v: any, required: string[], optional: string[] = []) => {
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      required.some((k) => !Object.hasOwn(v, k)) ||
      Object.keys(v).some((k) => ![...required, ...optional].includes(k))
    )
      throw new Error('Invalid content fields');
  };
  const text = (v: any) => {
    if (
      typeof v !== 'string' ||
      !v.trim() ||
      v.length > 4000 ||
      ['__proto__', 'constructor', 'prototype'].includes(v)
    )
      throw new Error('Invalid content text/id');
  };
  const list = (v: any) => {
    if (!Array.isArray(v) || v.length > 100) throw new Error('Invalid content list');
  };
  const version = (v: any) => {
    if (v.schema_version !== '1.0') throw new Error('Unsupported schema_version');
    text(v.content_version);
  };
  const ref = (v: any) => {
    object(v, ['scene', 'anchor']);
    text(v.scene);
    text(v.anchor);
  };
  const authoredStory: any = structuredClone(rawStory);
  const npcs: any = rawNpcs === undefined ? undefined : structuredClone(rawNpcs);
  const scenes: any[] = structuredClone(rawScenes);
  list(scenes);
  if (npcs !== undefined) {
    if (!npcs || typeof npcs !== 'object' || Array.isArray(npcs))
      throw new Error('Invalid NPC definitions');
    list(Object.keys(npcs));
    for (const [id, value] of Object.entries(npcs)) {
      const npc: any = value;
      text(id);
      object(npc, ['id', 'name', 'character', 'abilities'], ['image']);
      text(npc.name);
      if (npc.id !== id || (!/^f[1-8]$/.test(npc.character) && npc.character !== 'sprite'))
        throw new Error('Invalid NPC identity');
      if (npc.image !== undefined) validateVisual({ image: npc.image });
      object(npc.abilities, [], ['movement', 'dialogue', 'shop', 'schedule']);
      for (const flag of ['movement', 'dialogue'])
        if (npc.abilities[flag] !== undefined && npc.abilities[flag] !== true)
          throw new Error('Invalid NPC ability flag');
      for (const key of ['shop', 'schedule']) {
        const config = npc.abilities[key];
        if (
          config !== undefined &&
          (!config || typeof config !== 'object' || Array.isArray(config))
        )
          throw new Error('Invalid NPC ability configuration');
      }
      if (authoredStory?.interactions?.[id] && !npc.abilities.dialogue)
        throw new Error('NPC interaction requires dialogue ability');
    }
    for (const field of abilityFields)
      if (Object.hasOwn(authoredStory, field)) throw new Error('Abilities belong to NPCs');
    for (const scene of scenes) {
      list(scene.entities);
      for (const entity of scene.entities) {
        const npc = Object.hasOwn(npcs, entity?.id) ? npcs[entity.id] : undefined;
        if (!npc) continue;
        if (entity.portal || entity.seat) throw new Error('Invalid NPC placement');
        for (const [key, value] of Object.entries({
          name: npc.name,
          character: npc.character,
          movable: !!npc.abilities.movement,
        })) {
          if (entity[key] !== undefined && entity[key] !== value)
            throw new Error('Conflicting NPC placement');
          entity[key] = value;
        }
      }
    }
  }
  const story: any =
    npcs === undefined ? authoredStory : { ...authoredStory, ...abilitySettings({ npcs }) };
  if (!scenes.length) throw new Error('No scenes');
  object(
    story,
    ['schema_version', 'content_version', 'start', 'vars', 'interactions'],
    ['tasks', 'items', 'shops', 'clues', 'clock', 'schedules'],
  );
  version(story);
  ref(story.start);
  if (story.clock !== undefined) {
    const c = story.clock,
      batch = Object.hasOwn(c, 'realSecondsPerTick');
    object(c, batch ? ['realSecondsPerTick', 'gameSecondsPerTick', 'idlePauseSeconds'] : ['rate'], [
      'initialBalanceSeconds',
      'startTimeSeconds',
    ]);
    if (batch) {
      for (const key of ['realSecondsPerTick', 'idlePauseSeconds'])
        if (!Number.isSafeInteger(c[key]) || c[key] < 1 || c[key] > 3600)
          throw new Error('Invalid clock interval');
      if (
        !Number.isSafeInteger(c.gameSecondsPerTick) ||
        c.gameSecondsPerTick < 1 ||
        c.gameSecondsPerTick > 86400
      )
        throw new Error('Invalid clock quantum');
    } else if (!Number.isSafeInteger(c.rate) || c.rate < 0 || c.rate > 3600)
      throw new Error('Invalid story clock rate');
    for (const key of ['initialBalanceSeconds', 'startTimeSeconds'])
      if (
        c[key] !== undefined &&
        (!Number.isSafeInteger(c[key]) ||
          c[key] < 0 ||
          (key === 'startTimeSeconds' && c[key] > 604800))
      )
        throw new Error('Invalid clock initial value');
  }
  if (!story.vars || typeof story.vars !== 'object' || Array.isArray(story.vars))
    throw new Error('Invalid vars');
  for (const [key, value] of Object.entries(story.vars)) {
    text(key);
    if (typeof value !== 'boolean') throw new Error('Only boolean vars supported');
  }
  const conditions: Condition[] = [];
  const condition = (c: any) => {
    if (c && Object.hasOwn(c, 'task')) {
      object(c, ['task', 'step']);
      text(c.task);
      text(c.step);
    } else {
      object(c, ['var', 'equals']);
      if (!Object.hasOwn(story.vars, c.var) || typeof c.equals !== 'boolean')
        throw new Error('Invalid condition');
    }
    conditions.push(c);
  };
  const variants = (v: any) => {
    if (v === undefined) return;
    list(v);
    if (!v.length) throw new Error('Empty dialogue variants');
    v.forEach(text);
  };
  if (
    !story.interactions ||
    typeof story.interactions !== 'object' ||
    Array.isArray(story.interactions)
  )
    throw new Error('Invalid interactions');
  for (const [id, value] of Object.entries(story.interactions)) {
    text(id);
    const interaction: any = value;
    object(interaction, ['text', 'choices'], ['replies', 'topics', 'firstText', 'variants']);
    text(interaction.text);
    list(interaction.choices);
    if (interaction.firstText !== undefined) text(interaction.firstText);
    variants(interaction.variants);
    if (interaction.topics !== undefined) {
      if (
        !interaction.topics ||
        typeof interaction.topics !== 'object' ||
        Array.isArray(interaction.topics)
      )
        throw new Error('Invalid dialogue topics');
      list(Object.keys(interaction.topics));
      for (const [key, topic] of Object.entries(interaction.topics) as [string, any][]) {
        text(key);
        if (key === 'root') throw new Error('Reserved dialogue topic');
        object(topic, ['text'], ['replies', 'variants']);
        text(topic.text);
        variants(topic.variants);
        if (topic.replies !== undefined) {
          list(topic.replies);
          for (const reply of topic.replies) {
            object(reply, ['when', 'text'], ['variants']);
            text(reply.text);
            variants(reply.variants);
            condition(reply.when);
          }
        }
      }
    }
    if (interaction.replies !== undefined) {
      list(interaction.replies);
      for (const reply of interaction.replies) {
        object(reply, ['when', 'text'], ['variants']);
        text(reply.text);
        variants(reply.variants);
        condition(reply.when);
      }
    }
    const ids = new Set();
    for (const choice of interaction.choices) {
      object(choice, ['id', 'text', 'effects'], ['when', 'topic', 'opens']);
      text(choice.id);
      text(choice.text);
      for (const field of ['topic', 'opens'])
        if (choice[field] !== undefined) {
          text(choice[field]);
          if (
            !(field === 'opens' && choice[field] === 'root') &&
            !Object.hasOwn(interaction.topics ?? {}, choice[field])
          )
            throw new Error('Unknown dialogue topic');
        }
      if (ids.has(choice.id)) throw new Error('Duplicate choice');
      ids.add(choice.id);
      if (choice.when !== undefined) condition(choice.when);
      list(choice.effects);
      if (choice.opens !== undefined && choice.effects.length)
        throw new Error('Topic navigation cannot apply effects');
      if (choice.topic !== undefined && choice.effects.some((e: any) => e.op === 'travel'))
        throw new Error('Portal choices cannot belong to topics');
      for (const effect of choice.effects) {
        if (effect.op === 'set') {
          object(effect, ['op', 'var', 'value']);
          if (!Object.hasOwn(story.vars, effect.var) || typeof effect.value !== 'boolean')
            throw new Error('Invalid variable write');
        } else if (effect.op === 'pay_time') {
          object(effect, ['op', 'seconds']);
          if (!Number.isSafeInteger(effect.seconds) || effect.seconds < 0)
            throw new Error('Invalid payment');
        } else if (effect.op === 'grant_clue') {
          object(effect, ['op', 'clue']);
          text(effect.clue);
        } else if (['give_item', 'pickup_item', 'take_item'].includes(effect.op)) {
          object(effect, ['op', 'item', 'quantity']);
          text(effect.item);
          if (!Number.isInteger(effect.quantity) || effect.quantity < 1 || effect.quantity > 99)
            throw new Error('Invalid gift quantity');
        } else if (effect.op === 'move_entity') {
          object(effect, ['op', 'entity', 'path'], ['via', 'arrival']);
          text(effect.entity);
          list(effect.path);
          if (effect.via !== undefined) {
            text(effect.via);
            text(effect.arrival);
          } else if (effect.arrival !== undefined) throw new Error('Arrival requires portal');
          if (
            !effect.path.length ||
            effect.path.some(
              (p: any) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isInteger),
            )
          )
            throw new Error('Invalid movement path');
        } else if (effect.op === 'sleep') {
          const key = Object.hasOwn(effect, 'selectHours')
            ? 'selectHours'
            : Object.hasOwn(effect, 'seconds')
              ? 'seconds'
              : 'nextDayAt';
          object(effect, ['op', key]);
          if (key === 'selectHours') {
            if (effect.selectHours !== true) throw new Error('Invalid sleep hour selection');
          } else if (
            !Number.isSafeInteger(effect[key]) ||
            effect[key] < (key === 'seconds' ? 1 : 0) ||
            effect[key] > (key === 'seconds' ? 86400 : 86399)
          )
            throw new Error('Invalid sleep duration');
          if (choice.effects.length !== 1) throw new Error('Sleep must be the only choice effect');
        } else if (effect.op === 'travel') object(effect, ['op']);
        else throw new Error('Unsupported effect');
      }
      if (choice.effects.filter((e: any) => e.op === 'travel').length > 1)
        throw new Error('Multiple travel effects');
    }
  }
  const sceneIds = new Set(),
    entityIds = new Set();
  for (const scene of scenes) {
    object(
      scene,
      ['schema_version', 'content_version', 'id', 'name', 'map', 'anchors', 'entities'],
      [],
    );
    version(scene);
    text(scene.id);
    text(scene.name);
    if (sceneIds.has(scene.id)) throw new Error('Duplicate scene');
    sceneIds.add(scene.id);
    object(
      scene.map,
      scene.map.render === undefined
        ? ['width', 'height', 'floorTile', 'wallTile']
        : ['width', 'height', 'render', 'showTiles', 'collision'],
      ['collision', 'blockedEdges', 'art', 'playerScale'],
    );
    if (
      scene.map.playerScale !== undefined &&
      (!Number.isFinite(scene.map.playerScale) ||
        scene.map.playerScale < 1 ||
        scene.map.playerScale > 3)
    )
      throw new Error('Invalid player scale');
    for (const key of ['width', 'height'])
      if (!Number.isInteger(scene.map[key]) || scene.map[key] < 5 || scene.map[key] > 64)
        throw new Error('Invalid map dimensions');
    if (scene.map.render !== undefined) {
      if (typeof scene.map.showTiles !== 'boolean' || !Array.isArray(scene.map.collision))
        throw new Error('Invalid map render configuration');
      validateMapRender(scene.map.render, scene.map.width, scene.map.height);
    }
    for (const key of scene.map.render === undefined ? ['floorTile', 'wallTile'] : [])
      if (!Number.isInteger(scene.map[key]) || scene.map[key] < 0 || scene.map[key] >= 1440)
        throw new Error('Invalid tile');
    if (
      scene.map.collision !== undefined &&
      (!Array.isArray(scene.map.collision) ||
        scene.map.collision.length !== scene.map.height ||
        scene.map.collision.some(
          (row: unknown) =>
            typeof row !== 'string' || row.length !== scene.map.width || !/^[.#]+$/.test(row),
        ))
    )
      throw new Error('Invalid collision grid');
    if (scene.map.blockedEdges !== undefined) {
      list(scene.map.blockedEdges);
      for (const edge of scene.map.blockedEdges) {
        if (!Array.isArray(edge) || edge.length !== 4 || !edge.every(Number.isInteger))
          throw new Error('Invalid blocked edge');
        const [ax, ay, bx, by] = edge;
        if (
          Math.abs(ax - bx) + Math.abs(ay - by) !== 1 ||
          ax < 0 ||
          bx < 0 ||
          ay < 0 ||
          by < 0 ||
          ax >= scene.map.width ||
          bx >= scene.map.width ||
          ay >= scene.map.height ||
          by >= scene.map.height
        )
          throw new Error('Invalid blocked edge');
      }
    }
    if (scene.map.art !== undefined) {
      list(scene.map.art);
      for (const art of scene.map.art) {
        object(art, ['image', 'position', 'depth'], ['size', 'anchor', 'offset']);
        validateVisual(art);
        if (
          !Array.isArray(art.position) ||
          art.position.length !== 2 ||
          !art.position.every(Number.isInteger) ||
          art.position[0] < 0 ||
          art.position[1] < 0 ||
          art.position[0] >= scene.map.width * 32 ||
          art.position[1] >= scene.map.height * 32 ||
          !Number.isInteger(art.depth) ||
          art.depth < -1 ||
          art.depth > scene.map.height * 32
        )
          throw new Error('Invalid art placement');
      }
    }
    const position = (v: any) => {
      if (
        !Array.isArray(v) ||
        v.length !== 2 ||
        !v.every(Number.isInteger) ||
        mapBlocked(scene.map, v[0], v[1])
      )
        throw new Error('Position must be on walkable interior');
    };
    if (!scene.anchors || typeof scene.anchors !== 'object' || Array.isArray(scene.anchors))
      throw new Error('Invalid anchors');
    for (const [id, pos] of Object.entries(scene.anchors)) {
      text(id);
      position(pos);
    }
    list(scene.entities);
    const occupied = new Set();
    for (const entity of scene.entities) {
      object(
        entity,
        ['id', 'name', 'position', 'character'],
        ['portal', 'portalTiles', 'movable', 'sprite', 'interactionOffsets', 'seat', 'seatedOn'],
      );
      if (entity.interactionOffsets !== undefined) {
        list(entity.interactionOffsets);
        if (
          entity.portal ||
          entity.interactionOffsets.some(
            (p: any) =>
              !Array.isArray(p) ||
              p.length !== 2 ||
              !p.every(Number.isInteger) ||
              Math.abs(p[0]) + Math.abs(p[1]) < 1 ||
              Math.abs(p[0]) + Math.abs(p[1]) > 4,
          )
        )
          throw new Error('Invalid interaction offsets');
      }
      if (entity.sprite !== undefined) {
        object(entity.sprite, ['image'], ['size', 'anchor', 'offset']);
        validateVisual(entity.sprite);
      }
      if (entity.character === 'sprite' && !entity.sprite)
        throw new Error('Sprite visual required');
      if (entity.movable !== undefined && typeof entity.movable !== 'boolean')
        throw new Error('Invalid movable property');
      if (entity.portal && entity.movable) throw new Error('Movable portals are not supported');
      text(entity.id);
      text(entity.name);
      text(entity.character);
      if (entity.seat !== undefined) {
        object(entity.seat, ['orientation', 'depth', 'playerSprite'], ['table']);
        if (entity.seat.table !== undefined) text(entity.seat.table);
        if (
          entity.portal ||
          entity.movable ||
          entity.character !== 'sprite' ||
          ![0, 90, 180, 270].includes(entity.seat.orientation) ||
          !Number.isInteger(entity.seat.depth) ||
          entity.seat.depth < 0 ||
          entity.seat.depth >= scene.map.height * 32
        )
          throw new Error('Invalid seat');
        object(entity.seat.playerSprite, ['image'], ['size', 'anchor', 'offset']);
        validateVisual(entity.seat.playerSprite);
        const p = entity.position;
        if (
          !Array.isArray(p) ||
          p.length !== 2 ||
          !p.every(Number.isInteger) ||
          p[0] < 1 ||
          p[1] < 1 ||
          p[0] >= scene.map.width - 1 ||
          p[1] >= scene.map.height - 1
        )
          throw new Error('Invalid seat position');
      } else if (entity.seatedOn !== undefined) {
        text(entity.seatedOn);
        const chair = scene.entities.find((e: any) => e?.id === entity.seatedOn);
        if (
          entity.movable ||
          entity.portal ||
          entity.character !== 'sprite' ||
          !chair?.seat ||
          !Array.isArray(entity.position) ||
          entity.position.length !== 2 ||
          !entity.position.every(Number.isInteger) ||
          entity.position.join() !== chair.position?.join()
        )
          throw new Error('Invalid seated guest');
      } else position(entity.position);
      if (
        !/^f[1-8]$/.test(entity.character) &&
        entity.character !== 'sprite' &&
        entity.character !== 'book' &&
        !(entity.character === 'door' && entity.portal)
      )
        throw new Error('Invalid character');
      const same = scene.entities.filter(
        (e: any) => Array.isArray(e?.position) && e.position.join() === entity.position.join(),
      );
      const seatPair =
        same.length === 2 &&
        same.some((e: any) => e.seat && same.some((g: any) => g !== e && g.seatedOn === e.id));
      if (entity.seat && entity.seatedOn !== undefined) throw new Error('Seat cannot be a guest');
      if (entityIds.has(entity.id) || (occupied.has(entity.position.join()) && !seatPair))
        throw new Error('Duplicate entity/position');
      entityIds.add(entity.id);
      occupied.add(entity.position.join());
      if (entity.portalTiles !== undefined) {
        list(entity.portalTiles);
        if (
          !entity.portal ||
          !entity.portalTiles.some(
            (p: any) => Array.isArray(p) && p.join() === entity.position.join(),
          )
        )
          throw new Error('Invalid portal tiles');
        const tiles = new Set<string>();
        for (const tile of entity.portalTiles) {
          position(tile);
          const key = tile.join();
          if (tiles.has(key) || (key !== entity.position.join() && occupied.has(key)))
            throw new Error('Overlapping portal tiles');
          tiles.add(key);
          occupied.add(key);
        }
      }
      if (entity.portal) {
        ref(entity.portal);
        const choices = story.interactions[entity.id]?.choices;
        if (
          !choices ||
          choices.length !== 1 ||
          !choices[0].effects.some((e: any) => e.op === 'travel')
        )
          throw new Error('Portal requires one travel choice');
      }
      if (entity.seat && Object.hasOwn(story.interactions, entity.id))
        throw new Error('Seats use built-in interaction');
      if (
        !entity.portal &&
        story.interactions[entity.id]?.choices.some((c: any) =>
          c.effects.some((e: any) => e.op === 'travel'),
        )
      )
        throw new Error('Travel requires portal');
    }
    for (const pos of Object.values(scene.anchors) as number[][])
      if (occupied.has(pos.join())) throw new Error('Anchor is occupied');
  }
  const itemIds = new Set<string>();
  if (story.items !== undefined) {
    list(story.items);
    for (const item of story.items) {
      object(
        item,
        ['id', 'name', 'image', 'category', 'quality', 'description'],
        ['kind', 'effectDescription', 'slot', 'initiallyOwned'],
      );
      if (
        item.initiallyOwned !== undefined &&
        (item.kind !== 'relic' || typeof item.initiallyOwned !== 'boolean')
      )
        throw new Error('Invalid initial relic ownership');
      if (
        item.slot !== undefined &&
        (item.kind !== 'relic' ||
          !Number.isInteger(item.slot) ||
          item.slot < 1 ||
          item.slot > RELIC_SLOTS)
      )
        throw new Error('Invalid relic slot');
      if (item.kind !== undefined && item.kind !== 'relic') throw new Error('Invalid item kind');
      if (item.effectDescription !== undefined) {
        if (item.kind !== 'relic') throw new Error('Effects require a relic');
        text(item.effectDescription);
      }
      for (const key of ['id', 'name', 'category', 'quality', 'description']) text(item[key]);
      validateVisual({ image: item.image });
      if (itemIds.has(item.id)) throw new Error('Duplicate item');
      itemIds.add(item.id);
    }
  }
  const relicSlots = new Set<number>();
  for (const [i, item] of (story.items ?? [])
    .filter((item: Item) => item.kind === 'relic')
    .entries()) {
    const slot = item.slot ?? i + 1;
    if (slot > RELIC_SLOTS || relicSlots.has(slot))
      throw new Error('Duplicate or unavailable relic slot');
    relicSlots.add(slot);
  }
  const clueIds = new Set<string>();
  if (story.clues !== undefined) {
    list(story.clues);
    for (const clue of story.clues) {
      object(clue, ['id', 'slot', 'text', 'source']);
      text(clue.id);
      text(clue.text);
      text(clue.source);
      if (
        clueIds.has(clue.id) ||
        !Number.isInteger(clue.slot) ||
        clue.slot < 1 ||
        clue.slot > RELIC_SLOTS
      )
        throw new Error('Invalid relic clue');
      clueIds.add(clue.id);
    }
  }
  if (story.shops !== undefined) {
    if (
      !story.shops ||
      typeof story.shops !== 'object' ||
      Array.isArray(story.shops) ||
      Object.keys(story.shops).length > 100
    )
      throw new Error('Invalid shops');
    for (const [id, value] of Object.entries(story.shops)) {
      const shop: any = value;
      text(id);
      object(shop, ['name', 'offers'], ['restock']);
      text(shop.name);
      list(shop.offers);
      if (shop.restock !== undefined) {
        object(shop.restock, ['intervalSeconds']);
        if (
          !Number.isSafeInteger(shop.restock.intervalSeconds) ||
          shop.restock.intervalSeconds < 1 ||
          shop.restock.intervalSeconds > 604800
        )
          throw new Error('Invalid restock interval');
      }
      const entity = scenes.flatMap((s) => s.entities).find((e) => e.id === id);
      if (
        !entity ||
        entity.portal ||
        entity.seat ||
        !Object.hasOwn(story.interactions, id) ||
        !shop.offers.length
      )
        throw new Error('Shop requires an interactive entity');
      const offered = new Set();
      for (const offer of shop.offers) {
        object(offer, ['item', 'buySeconds', 'sellSeconds', 'stock']);
        if (!itemIds.has(offer.item) || offered.has(offer.item))
          throw new Error('Invalid shop item');
        offered.add(offer.item);
        if (
          !Number.isSafeInteger(offer.buySeconds) ||
          offer.buySeconds < 1 ||
          offer.buySeconds > 604800 ||
          !Number.isSafeInteger(offer.sellSeconds) ||
          offer.sellSeconds < 0 ||
          offer.sellSeconds > offer.buySeconds ||
          !Number.isInteger(offer.stock) ||
          offer.stock < 0 ||
          offer.stock > 9999
        )
          throw new Error('Invalid shop price or stock');
      }
    }
  }
  if (story.schedules !== undefined) {
    if (!story.schedules || typeof story.schedules !== 'object' || Array.isArray(story.schedules))
      throw new Error('Invalid NPC schedules');
    list(Object.keys(story.schedules));
    for (const [id, value] of Object.entries(story.schedules)) {
      text(id);
      const schedule = value as NpcSchedule;
      object(schedule, ['scene', 'sleepAt', 'wakeAt', 'entrance', 'home']);
      text(schedule.scene);
      if (
        ![schedule.sleepAt, schedule.wakeAt].every(
          (n) => Number.isInteger(n) && n >= 0 && n < 86400,
        ) ||
        schedule.sleepAt === schedule.wakeAt
      )
        throw new Error('Invalid NPC schedule hours');
      const scene = scenes.find((s) => s.id === schedule.scene),
        entity = scene?.entities.find((e: Entity) => e.id === id);
      if (
        !scene ||
        !entityIds.has(id) ||
        !entity?.movable ||
        entity.portal ||
        entity.seat ||
        entity.seatedOn
      )
        throw new Error('Schedule requires a movable NPC in its scene');
      for (const p of [schedule.entrance, schedule.home])
        if (
          !Array.isArray(p) ||
          p.length !== 2 ||
          !p.every(Number.isInteger) ||
          mapBlocked(scene.map, p[0], p[1]) ||
          scene.entities.some((e: Entity) => e.id !== id && e.position.join() === p.join())
        )
          throw new Error('Invalid NPC schedule position');
      if (schedule.entrance.join() === schedule.home.join())
        throw new Error('Schedule home must differ from entrance');
      const start = entity.position;
      if (
        npcPath(scene, start, [schedule.entrance]) === null ||
        npcPath(scene, schedule.entrance, [schedule.home]) === null
      )
        throw new Error('NPC schedule route unavailable');
    }
  }
  for (const id of Object.keys(story.interactions))
    if (!entityIds.has(id)) throw new Error('Interaction references unknown entity');
  for (const interaction of Object.values(story.interactions) as any[])
    for (const choice of interaction.choices)
      for (const effect of choice.effects) {
        if (effect.op === 'grant_clue' && !clueIds.has(effect.clue))
          throw new Error('Unknown relic clue');
        if (
          ['give_item', 'pickup_item', 'take_item'].includes(effect.op) &&
          !itemIds.has(effect.item)
        )
          throw new Error('Unknown inventory item');
        if (effect.op === 'pickup_item') {
          const target = scenes
            .flatMap((s) => s.entities)
            .find((e: Entity) => story.interactions[e.id] === interaction);
          if (
            !target ||
            target.character !== 'sprite' ||
            target.movable ||
            target.portal ||
            target.seat ||
            target.seatedOn ||
            npcs?.[target.id] ||
            story.schedules?.[target.id]
          )
            throw new Error('Pickup requires a fixed sprite object');
        }
        if (effect.op !== 'move_entity') continue;
        if (story.schedules?.[effect.entity] && effect.via)
          throw new Error('Scheduled NPC routes must stay in their configured scene');
        const scene = scenes.find((s) => s.entities.some((e: any) => e.id === effect.entity));
        const target = scene?.entities.find((e: any) => e.id === effect.entity);
        if (!target || target.movable !== true) throw new Error('Invalid moving entity');
        if (effect.via) {
          const door = scene.entities.find((e: any) => e.id === effect.via);
          const destination = scenes.find((s) => s.id === door?.portal?.scene);
          const last = effect.path.at(-1);
          if (
            !door?.portal ||
            !destination ||
            !Object.hasOwn(destination.anchors, effect.arrival) ||
            Math.abs(last[0] - door.position[0]) + Math.abs(last[1] - door.position[1]) !== 1
          )
            throw new Error('Invalid NPC portal route');
        }
        for (const [i, p] of effect.path.entries()) {
          if (
            mapBlocked(scene.map, p[0], p[1]) ||
            (i &&
              (Math.abs(p[0] - effect.path[i - 1][0]) + Math.abs(p[1] - effect.path[i - 1][1]) !==
                1 ||
                mapEdgeBlocked(scene.map, effect.path[i - 1], p)))
          )
            throw new Error('Invalid movement path');
        }
      }
  if (story.tasks !== undefined) {
    list(story.tasks);
    const taskIds = new Set();
    for (const task of story.tasks) {
      object(
        task,
        ['id', 'title', 'description', 'steps'],
        ['trigger', 'background', 'completion'],
      );
      text(task.id);
      text(task.title);
      text(task.description);
      if (task.completion !== undefined) {
        object(task.completion, ['background', 'description']);
        text(task.completion.background);
        text(task.completion.description);
      }
      if (task.background !== undefined) text(task.background);
      if (task.trigger !== undefined) {
        object(task.trigger, ['var', 'equals']);
        condition(task.trigger);
      }
      if (taskIds.has(task.id)) throw new Error('Duplicate task');
      taskIds.add(task.id);
      list(task.steps);
      if (!task.steps.length) throw new Error('Task needs steps');
      const stepIds = new Set();
      for (const step of task.steps) {
        object(step, ['id', 'text', 'condition'], ['background', 'description', 'marker']);
        if (
          step.marker !== undefined &&
          (!['!', '?'].includes(step.marker) || !entityIds.has(step.condition?.where?.entityId))
        )
          throw new Error('Task marker requires an entity target');
        text(step.id);
        text(step.text);
        for (const key of ['background', 'description'])
          if (step[key] !== undefined) text(step[key]);
        if (stepIds.has(step.id)) throw new Error('Duplicate task step');
        stepIds.add(step.id);
        const c = step.condition;
        object(c, ['event', 'count'], ['where', 'collect', 'items']);
        if (
          !Object.hasOwn(factFields, c.event) ||
          !Number.isInteger(c.count) ||
          c.count < 1 ||
          c.count > 1000
        )
          throw new Error('Invalid task condition');
        const fields = factFields[c.event as keyof typeof factFields] as readonly string[];
        const checkValue = (field: string, value: unknown) => {
          text(value);
          if (field === 'entityId' && !entityIds.has(value)) throw new Error('Invalid task entity');
          if (field === 'sceneId' && !sceneIds.has(value)) throw new Error('Invalid task scene');
          if (field === 'direction' && !['up', 'down', 'left', 'right'].includes(value as string))
            throw new Error('Invalid task direction');
        };
        if (c.where !== undefined) {
          if (!c.where || typeof c.where !== 'object' || Array.isArray(c.where))
            throw new Error('Invalid fact filter');
          for (const [key, value] of Object.entries(c.where)) {
            if (!fields.includes(key)) throw new Error('Unknown fact field');
            checkValue(key, value);
          }
        }
        if (c.collect !== undefined && !fields.includes(c.collect))
          throw new Error('Unknown collection field');
        if (c.items !== undefined) {
          if (!c.collect) throw new Error('Items require collect');
          list(c.items);
          if (c.items.length < c.count) throw new Error('Insufficient task items');
          const values = new Set();
          for (const item of c.items) {
            object(item, ['value', 'label']);
            checkValue(c.collect, item.value);
            text(item.label);
            if (values.has(item.value)) throw new Error('Duplicate task item');
            values.add(item.value);
          }
        }
      }
    }
  }
  for (const c of conditions)
    if (
      'task' in c &&
      !story.tasks?.some((t: Task) => t.id === c.task && t.steps.some((s) => s.id === c.step))
    )
      throw new Error('Unknown task step condition');
  const destination = (r: any) => {
    const scene = scenes.find((s) => s.id === r.scene);
    if (!scene || !Object.hasOwn(scene.anchors, r.anchor)) throw new Error('Invalid destination');
  };
  destination(story.start);
  for (const scene of scenes)
    for (const entity of scene.entities) if (entity.portal) destination(entity.portal);
  if (npcs !== undefined) {
    for (const id of Object.keys(npcs))
      if (!entityIds.has(id)) throw new Error('NPC has no initial placement');
    return { scenes, story: authoredStory, npcs };
  }
  return { scenes, story };
}

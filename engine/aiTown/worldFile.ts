import { WORLD_STATE_ID, STATE_WORD_BUDGET } from '../prose/contract';
import { budgetedText, wordCount } from '../prose/stateDocument';

/** docs/13 §1.8 item E: `world_state` is the field; `common_knowledge` is what it used to be. */
export function worldStateOf(file: WorldFile): string | undefined {
  return file.world_state ?? file.common_knowledge;
}

/**
 * The `a1.0` world file, its validation rules, and the load-time repairs docs/07 §5.2 requires.
 *
 * Validation is much smaller than the typed branch's (docs/05 §11: ~20 of `04`'s 24 rules have
 * nothing to check here) because there is no schema to repair prose against. What is left is ids,
 * anchors, characters, tier consistency, and occupancy — everything the *map* can contradict.
 *
 * Note the case boundary: the file speaks `blocks_movement` / `initial_state`, matching docs/05,
 * and the engine speaks `blocksMovement` / `initialState`. Conversion happens here and nowhere
 * else.
 */

export interface WorldFileEntity {
  id: string;
  kind: 'actor' | 'prop';
  mobile?: boolean;
  name?: string;
  character?: string;
  sprite?: string;
  spawn?: { anchor: string };
  anchor?: string;
  /**
   * Which scene this entity is placed in (docs/13 §2). Optional: a one-map world has nowhere
   * else to put it, and a scene world falls back to `MapContext.defaultScene`.
   */
  scene?: string;
  description?: string;
  behavior?: string;
  initial_state?: string;
  initial_memory?: string[];
  physics?: { blocks_movement?: boolean };
}

export interface WorldFile {
  format_version: string;
  meta?: { id?: string; title?: string; description?: string; authored_by?: string; seed?: number };
  world_rules?: string;
  /**
   * The world's state document at load (docs/05 §5.3, docs/13 §1.4). Authored once and thereafter
   * rewritten by the god and by agents — unlike `world_rules`, which never changes.
   */
  world_state?: string;
  /** What `world_state` was called before docs/13 §1.4. Read, never written. */
  common_knowledge?: string;
  entities: WorldFileEntity[];
  god?: {
    persona?: string;
    hidden_rules?: string;
    max_transcript_turns?: number;
    gate?: { enabled?: boolean };
  };
}

/** One scene's ground: its bounds, the anchors authored in it, and what the static map blocks. */
export interface SceneContext {
  anchors: Map<string, { x: number; y: number; w: number; h: number }>;
  width: number;
  height: number;
  /** Static map collision, before any load-time subtraction. */
  blocked: (x: number, y: number) => boolean;
}

/**
 * The ground a world file is validated against.
 *
 * A world with one map is the flat case, and is what it always was. A world standing on
 * `MemoryWorld`'s scenes (docs/13 §2) fills `scenes` as well: an entity's `scene` then says
 * which one it is placed in, and the flat fields mirror `defaultScene`, which is what an entity
 * naming no scene of its own gets.
 *
 * The registry is not decoration. Anchor ids are scene-local — `start` is authored in all 26
 * scenes and `from-return` in 20 — so an anchor id alone does not name a place, and a file that
 * leaves the scene out is placing its entities by coin flip.
 */
export interface MapContext extends SceneContext {
  characters: Set<string>;
  /**
   * Named prop art the content knows (docs/13 §2), the `character` vocabulary's counterpart for
   * entities that are not drawn as people. Absent means "this host declares none", and the
   * sprite check is skipped rather than failing every prop.
   */
  sprites?: Set<string>;
  scenes?: Map<string, SceneContext>;
  defaultScene?: string;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const SHORT_PROSE = 40;

function anchorOf(entity: WorldFileEntity): string | undefined {
  return entity.kind === 'actor' && entity.mobile ? entity.spawn?.anchor : entity.anchor;
}

export function validateWorldFile(file: WorldFile, map: MapContext): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (file.format_version !== 'a1.0') {
    // docs/05 §12 rule 1: a `2.0` file is refused, never migrated.
    errors.push(`format_version is "${file.format_version}", expected "a1.0"`);
  }
  if (!Array.isArray(file.entities)) {
    errors.push('entities is not an array');
    return { errors, warnings };
  }
  if (file.world_rules !== undefined && file.world_rules.trim() === '') {
    warnings.push('world_rules is empty');
  }
  if (file.world_state !== undefined && file.common_knowledge !== undefined) {
    errors.push('world_state and common_knowledge are the same field; write only world_state');
  }
  // docs/05 §5.3: the same budget every state document gets, checked at authoring time as
  // `initial_state` is, since nothing at runtime will re-ask on the author's behalf. The record
  // blocks are excluded here as they are at runtime (docs/13 §1.7), so an authored world with a
  // long task list is not rejected for prose it does not have.
  const authoredWorldState = worldStateOf(file);
  if (
    authoredWorldState !== undefined &&
    wordCount(budgetedText(authoredWorldState)) > STATE_WORD_BUDGET
  ) {
    errors.push(`world_state is over ${STATE_WORD_BUDGET} words`);
  }

  const seen = new Set<string>();
  // Tile -> the entities whose anchor covers it, for the occupancy rules. Keyed by scene too:
  // two scenes both have a tile (4, 7), and they are not the same place.
  const occupancy = new Map<string, string[]>();

  /** Which scene's ground an entity stands on, or the complaint to make instead of guessing. */
  const groundOf = (
    entity: WorldFileEntity,
  ): { id?: string; ground?: SceneContext; error?: string } => {
    if (!map.scenes) {
      return entity.scene
        ? { error: `names scene "${entity.scene}", but this world stands on one unnamed map` }
        : { ground: map };
    }
    const id = entity.scene ?? map.defaultScene;
    if (!id) {
      return { error: 'needs a scene: this world has several and declares no default' };
    }
    const ground = map.scenes.get(id);
    return ground ? { id, ground } : { error: `unknown scene "${id}"` };
  };

  for (const entity of file.entities) {
    const where = `entity "${entity.id ?? '(no id)'}"`;
    if (!entity.id) {
      errors.push(`${where}: missing id`);
      continue;
    }
    if (seen.has(entity.id)) {
      errors.push(`${where}: duplicate id`);
    }
    if (entity.id === WORLD_STATE_ID) {
      // The reserved key of docs/05 §5.3. An entity holding it would share a row namespace with
      // the world-state document and the two would overwrite each other's versions.
      errors.push(`${where}: "${WORLD_STATE_ID}" is reserved for the world's state document`);
    }
    seen.add(entity.id);

    if (entity.kind !== 'actor' && entity.kind !== 'prop') {
      errors.push(`${where}: kind is "${String(entity.kind)}", expected "actor" or "prop"`);
      continue;
    }
    // docs/05 §12 rule 5.
    if (entity.kind === 'actor' && typeof entity.mobile !== 'boolean') {
      errors.push(`${where}: actors must declare mobile`);
    }
    if (entity.kind === 'prop' && entity.mobile !== undefined) {
      errors.push(`${where}: props must not declare mobile`);
    }

    // docs/07 §8 rule 8, the split enforced: an entity with neither state nor description is
    // decoration, and decoration belongs in the map.
    if (!entity.initial_state && !entity.description) {
      errors.push(
        `${where}: has neither initial_state nor description, so it is decoration — put it in the map, not the world file`,
      );
    }
    // docs/05 §12 rule 9.
    if (entity.initial_memory?.length && !entity.initial_state) {
      errors.push(`${where}: initial_memory requires initial_state`);
    }
    // docs/05 §12 rule 8. Only the memory half survives the `persona`/`description` merge: a prop
    // is described like anything else, but a thing that remembers is a fixed actor, not a prop.
    if (entity.kind === 'prop' && entity.initial_memory?.length) {
      errors.push(`${where}: props have no initial_memory`);
    }

    if (entity.kind === 'actor' && entity.mobile) {
      if (!entity.character) {
        errors.push(`${where}: a mobile actor needs a character`);
      } else if (!map.characters.has(entity.character)) {
        errors.push(`${where}: unknown character "${entity.character}"`);
      }
      if (!entity.spawn?.anchor) {
        // Softer than docs/05 §12 rule 6: without a spawn anchor the actor falls back to the
        // original whole-map placement, which is a worse world but a working one.
        warnings.push(`${where}: no spawn anchor, falling back to a random free tile`);
      }
    } else {
      if (!entity.anchor) {
        errors.push(`${where}: a fixed entity needs an anchor`);
      }
      if (entity.kind === 'actor' && !entity.sprite) {
        warnings.push(`${where}: a fixed actor with no sprite will not render`);
      }
      if (entity.sprite && map.sprites && !map.sprites.has(entity.sprite)) {
        // Symmetric with an unknown character: the content owns the vocabulary, and a name
        // outside it draws nothing at all rather than drawing the wrong thing.
        errors.push(`${where}: unknown sprite "${entity.sprite}"`);
      }
    }

    const { id: sceneId, ground, error: sceneError } = groundOf(entity);
    if (sceneError) {
      errors.push(`${where}: ${sceneError}`);
    }
    const inScene = sceneId ? ` in scene "${sceneId}"` : '';

    const anchorId = anchorOf(entity);
    if (anchorId && ground) {
      const anchor = ground.anchors.get(anchorId);
      if (!anchor) {
        // docs/07 §8 rule 1.
        errors.push(`${where}: unknown anchor "${anchorId}"${inScene}`);
      } else {
        if (
          anchor.x < 0 ||
          anchor.y < 0 ||
          anchor.x + anchor.w > ground.width ||
          anchor.y + anchor.h > ground.height
        ) {
          errors.push(`${where}: anchor "${anchorId}"${inScene} falls outside the map`);
        }
        const isFixed = !(entity.kind === 'actor' && entity.mobile);
        if (isFixed) {
          for (let x = anchor.x; x < anchor.x + anchor.w; x++) {
            for (let y = anchor.y; y < anchor.y + anchor.h; y++) {
              const key = sceneId ? `${sceneId} ${x},${y}` : `${x},${y}`;
              occupancy.set(key, [...(occupancy.get(key) ?? []), entity.id]);
            }
          }
        } else {
          // docs/07 §8 rule 5: a spawn anchor with no free tile cannot place its actor.
          let free = false;
          for (let x = anchor.x; x < anchor.x + anchor.w && !free; x++) {
            for (let y = anchor.y; y < anchor.y + anchor.h && !free; y++) {
              if (!ground.blocked(x, y)) {
                free = true;
              }
            }
          }
          if (!free) {
            errors.push(`${where}: spawn anchor "${anchorId}"${inScene} has no free tile`);
          }
        }
      }
    }

    if (entity.initial_state && wordCount(entity.initial_state) > STATE_WORD_BUDGET) {
      errors.push(`${where}: initial_state is over the ${STATE_WORD_BUDGET}-word budget`);
    }
    if (entity.description && entity.description.length < SHORT_PROSE) {
      // docs/05 §12 rule 13: a one-word description is almost always an authoring slip.
      warnings.push(`${where}: description is very short`);
    }
  }

  // docs/07 §8 rule 4.
  for (const [tile, ids] of occupancy) {
    if (ids.length > 1) {
      warnings.push(`tile ${tile} is claimed by ${ids.join(', ')} — they will stack`);
    }
  }

  if (file.god) {
    if (file.god.persona !== undefined && file.god.persona.trim() === '') {
      errors.push('god.persona is empty');
    }
    if (file.god.max_transcript_turns !== undefined && file.god.max_transcript_turns < 4) {
      errors.push('god.max_transcript_turns must be at least 4');
    }
  }

  return { errors, warnings };
}

/**
 * docs/07 §5.2: a story prop drawn as solid in the map can never open, because the static layer
 * keeps blocking whatever the entity's physics says. Rather than trusting a map author to
 * remember, the loader clears the static bits under every fixed entity's anchor and says so.
 *
 * The visual tile stays; only the collision bit is cleared.
 */
export function subtractEntityAnchors(
  collision: boolean[][],
  file: WorldFile,
  map: MapContext,
  sceneId?: string,
): { collision: boolean[][]; warnings: string[] } {
  const warnings: string[] = [];
  const result = collision.map((column) => [...column]);
  // One collision layer belongs to one scene, so only that scene's entities may punch holes in
  // it. Without the filter a door in `low-kitchen` opens a hole at the same tile in `low-deck`.
  const scene = sceneId ?? map.defaultScene;
  for (const entity of file.entities) {
    if (entity.kind === 'actor' && entity.mobile) {
      continue;
    }
    if (map.scenes && (entity.scene ?? map.defaultScene) !== scene) {
      continue;
    }
    const ground = map.scenes ? map.scenes.get(scene!) : map;
    const anchor = entity.anchor ? ground?.anchors.get(entity.anchor) : undefined;
    if (!anchor) {
      continue;
    }
    let cleared = 0;
    for (let x = anchor.x; x < anchor.x + anchor.w; x++) {
      for (let y = anchor.y; y < anchor.y + anchor.h; y++) {
        if (result[x]?.[y]) {
          result[x][y] = false;
          cleared += 1;
        }
      }
    }
    if (cleared > 0) {
      warnings.push(
        `cleared ${cleared} static collision tile(s) under "${entity.anchor}" for entity "${entity.id}"; its own physics is now the only authority there`,
      );
    }
  }
  return { collision: result, warnings };
}

/** Convert one file entity into `createEntity` input args. The only place case is translated. */
export function createEntityArgs(entity: WorldFileEntity) {
  return {
    kind: entity.kind,
    mobile: entity.kind === 'actor' ? !!entity.mobile : false,
    name: entity.name,
    character: entity.character,
    sprite: entity.sprite,
    anchor: anchorOf(entity),
    scene: entity.scene,
    description: entity.description,
    behavior: entity.behavior,
    initialState: entity.initial_state,
    blocksMovement: entity.physics?.blocks_movement ?? false,
  };
}

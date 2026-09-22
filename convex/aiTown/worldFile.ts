import { COMMON_KNOWLEDGE_ID, STATE_WORD_BUDGET } from '../prose/contract';
import { wordCount } from '../prose/stateDocument';

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
   * The world's common knowledge at load (docs/05 §5.3). Authored once and thereafter the god's
   * to rewrite — unlike `world_rules`, which never changes.
   */
  common_knowledge?: string;
  entities: WorldFileEntity[];
  god?: {
    persona?: string;
    hidden_rules?: string;
    max_transcript_turns?: number;
    gate?: { enabled?: boolean };
  };
}

export interface MapContext {
  anchors: Map<string, { x: number; y: number; w: number; h: number }>;
  characters: Set<string>;
  width: number;
  height: number;
  /** Static map collision, before any load-time subtraction. */
  blocked: (x: number, y: number) => boolean;
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
  // docs/05 §5.3: the same budget every state document gets, checked at authoring time as
  // `initial_state` is, since nothing at runtime will re-ask on the author's behalf.
  if (file.common_knowledge !== undefined && wordCount(file.common_knowledge) > STATE_WORD_BUDGET) {
    errors.push(`common_knowledge is over ${STATE_WORD_BUDGET} words`);
  }

  const seen = new Set<string>();
  // Tile -> the entities whose anchor covers it, for the occupancy rules.
  const occupancy = new Map<string, string[]>();

  for (const entity of file.entities) {
    const where = `entity "${entity.id ?? '(no id)'}"`;
    if (!entity.id) {
      errors.push(`${where}: missing id`);
      continue;
    }
    if (seen.has(entity.id)) {
      errors.push(`${where}: duplicate id`);
    }
    if (entity.id === COMMON_KNOWLEDGE_ID) {
      // The reserved key of docs/05 §5.3. An entity holding it would share a row namespace with
      // common knowledge and the two would overwrite each other's versions.
      errors.push(
        `${where}: "${COMMON_KNOWLEDGE_ID}" is reserved for the world's common knowledge`,
      );
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
    }

    const anchorId = anchorOf(entity);
    if (anchorId) {
      const anchor = map.anchors.get(anchorId);
      if (!anchor) {
        // docs/07 §8 rule 1.
        errors.push(`${where}: unknown anchor "${anchorId}"`);
      } else {
        if (
          anchor.x < 0 ||
          anchor.y < 0 ||
          anchor.x + anchor.w > map.width ||
          anchor.y + anchor.h > map.height
        ) {
          errors.push(`${where}: anchor "${anchorId}" falls outside the map`);
        }
        const isFixed = !(entity.kind === 'actor' && entity.mobile);
        if (isFixed) {
          for (let x = anchor.x; x < anchor.x + anchor.w; x++) {
            for (let y = anchor.y; y < anchor.y + anchor.h; y++) {
              const key = `${x},${y}`;
              occupancy.set(key, [...(occupancy.get(key) ?? []), entity.id]);
            }
          }
        } else {
          // docs/07 §8 rule 5: a spawn anchor with no free tile cannot place its actor.
          let free = false;
          for (let x = anchor.x; x < anchor.x + anchor.w && !free; x++) {
            for (let y = anchor.y; y < anchor.y + anchor.h && !free; y++) {
              if (!map.blocked(x, y)) {
                free = true;
              }
            }
          }
          if (!free) {
            errors.push(`${where}: spawn anchor "${anchorId}" has no free tile`);
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
): { collision: boolean[][]; warnings: string[] } {
  const warnings: string[] = [];
  const result = collision.map((column) => [...column]);
  for (const entity of file.entities) {
    if (entity.kind === 'actor' && entity.mobile) {
      continue;
    }
    const anchor = entity.anchor ? map.anchors.get(entity.anchor) : undefined;
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
    description: entity.description,
    behavior: entity.behavior,
    initialState: entity.initial_state,
    blocksMovement: entity.physics?.blocks_movement ?? false,
  };
}

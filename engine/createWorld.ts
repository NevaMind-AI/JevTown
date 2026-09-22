import { Rng } from './util/rng';
import { SerializedWorld } from './aiTown/world';
import {
  MapContext,
  WorldFile,
  createEntityArgs,
  subtractEntityAnchors,
  validateWorldFile,
} from './aiTown/worldFile';
import { CollisionLayer } from './aiTown/worldMap';

/**
 * Turning an authored world file into a world, with no host involved.
 *
 * This was the interesting half of `convex/init.ts`: the half that decides what a world *is* when
 * it starts, as opposed to which rows that takes. It returns a plan rather than performing it, so
 * the same function serves a Convex mutation, the browser that now creates worlds under
 * docs/11 §1, and a test that wants a world without either.
 *
 * What it deliberately does not do is read a map module. `mapContext` and the static collision
 * layer are arguments, because docs/07 §6.1 makes the map a compiler input and `dev`'s per-scene
 * JSON and the agentic branch's generated module are two different sources for it.
 */

export interface WorldPlan {
  /** The fields a brand-new world document starts with. */
  world: Pick<
    SerializedWorld,
    | 'nextId'
    | 'seed'
    | 'rng'
    | 'conversations'
    | 'players'
    | 'agents'
    | 'entities'
    | 'commonKnowledgeVersion'
  >;
  /** World-level prose the prompt layer reads. Written once, like the map (docs/05 §2, §7). */
  description: {
    worldRules: string;
    godPersona?: string;
    godHiddenRules?: string;
    maxTranscriptTurns?: number;
    godGateEnabled: boolean;
  };
  /**
   * Authored common knowledge, installed at creation rather than through an input.
   *
   * docs/05 §5.3: it is configuration the world is built from, not something that happened in it,
   * and seeding it through an input would give a document whose whole guarantee is one writer a
   * second one. `undefined` when the file declares none.
   */
  commonKnowledge?: string;
  /** The map's collision with every fixed entity's anchor subtracted (docs/07 §5.2). */
  collision: CollisionLayer;
  /** One `createEntity` input per entity in the file, in file order. */
  entityInputs: ReturnType<typeof createEntityArgs>[];
  warnings: string[];
}

export interface CreateWorldOptions {
  /**
   * Caps how many mobile actors are created, for the smaller worlds the old `numAgents` argument
   * produced. Fixed entities are never capped: a world missing its doors is not a smaller world,
   * it is a broken one.
   */
  maxMobileActors?: number;
  /**
   * The seed, when the file declares none. Recorded on the world so a run is reproducible from it
   * plus the input log (docs/05 §10). The caller supplies it because picking one is a clock read,
   * and this module may not make those.
   */
  fallbackSeed: number;
}

export function createWorldPlan(
  worldFile: WorldFile,
  mapContext: MapContext,
  staticCollision: CollisionLayer,
  options: CreateWorldOptions,
): WorldPlan {
  const { errors, warnings } = validateWorldFile(worldFile, mapContext);
  if (errors.length > 0) {
    // docs/07 §8: errors block loading. Booting a different world than the one that was authored
    // is worse than not booting.
    throw new Error(`World file is invalid:\n  ${errors.join('\n  ')}`);
  }

  const subtracted = subtractEntityAnchors(staticCollision, worldFile, mapContext);
  const seed = worldFile.meta?.seed ?? options.fallbackSeed;
  const commonKnowledge = worldFile.common_knowledge?.trim() || undefined;

  const entityInputs = [];
  let mobileCreated = 0;
  for (const entity of worldFile.entities ?? []) {
    const isMobileActor = entity.kind === 'actor' && entity.mobile;
    if (
      isMobileActor &&
      options.maxMobileActors !== undefined &&
      mobileCreated >= options.maxMobileActors
    ) {
      continue;
    }
    if (isMobileActor) {
      mobileCreated += 1;
    }
    entityInputs.push(createEntityArgs(entity));
  }

  return {
    world: {
      nextId: 0,
      seed,
      rng: Rng.fromSeed(seed).serialize(),
      conversations: [],
      players: [],
      agents: [],
      entities: [],
      commonKnowledgeVersion: commonKnowledge ? 1 : 0,
    },
    description: {
      worldRules: worldFile.world_rules ?? '',
      godPersona: worldFile.god?.persona,
      godHiddenRules: worldFile.god?.hidden_rules,
      maxTranscriptTurns: worldFile.god?.max_transcript_turns,
      godGateEnabled: worldFile.god?.gate?.enabled ?? true,
    },
    commonKnowledge,
    collision: subtracted.collision,
    entityInputs,
    warnings: [...warnings, ...subtracted.warnings],
  };
}

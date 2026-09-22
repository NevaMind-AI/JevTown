import * as gentle from '../../data/gentle';
import worldFileJson from '../../data/world.json';
import { characters } from '../../data/characters';
import { Game } from '../../engine/aiTown/game';
import { MapContext, WorldFile } from '../../engine/aiTown/worldFile';
import { CollisionLayer, SerializedWorldMap } from '../../engine/aiTown/worldMap';
import { createWorldPlan } from '../../engine/createWorld';
import { COMMON_KNOWLEDGE_ID } from '../../engine/prose/contract';
import { InMemoryAgentStore } from '../../agent/store/memoryStore';
import { AgenticRuntime, AgenticRuntimeOptions } from './agenticRuntime';

/**
 * Stand up the agentic world in the tab.
 *
 * This is `convex/init.ts` without the database: the decisions it made about what a world *is*
 * are in `engine/createWorld.ts`, and what is left here is feeding it a map and handing the
 * result to a runtime.
 *
 * Which map is now the caller's business. It used to be `data/gentle.js` and nothing else --
 * the map `data/world.json` was authored against -- and that pairing is still the default, so a
 * caller that passes nothing gets exactly the world it got before. What changed is that
 * `createWorldPlan` was always map-agnostic by construction (see its header: "what it
 * deliberately does not do is read a map module"), and this function was the one place that
 * forgot. A `WorldSource` is now the argument it should always have been, which is what lets a
 * `dev` scene stand in without touching the engine (`sceneWorldMap.ts`).
 */

const mapModule = gentle as typeof gentle & {
  collision?: boolean[][];
  anchors?: Record<string, { x: number; y: number; w: number; h: number; description: string }>;
};

/** A map and the world authored against it, which only ever make sense as a pair. */
export interface WorldSource {
  worldFile: WorldFile;
  /** Anchors and collision already resolved: this is what the world is built and drawn from. */
  map: SerializedWorldMap;
  /** Character names a mobile actor may declare. Validation rejects anything else. */
  characters: Set<string>;
}

/** Static collision, derived from the object layers for a map that predates docs/07 §5.1. */
function gentleCollision(): CollisionLayer {
  return (
    mapModule.collision ??
    Array.from({ length: gentle.mapwidth }, (_, x) =>
      Array.from({ length: gentle.mapheight }, (_, y) =>
        gentle.objmap.some((layer: number[][]) => (layer[x]?.[y] ?? -1) !== -1),
      ),
    )
  );
}

/**
 * Anchors are stored sorted by id: iteration order is observable, and docs/05 §10 requires it to
 * be deterministic.
 */
function serializeAnchors() {
  return Object.entries(mapModule.anchors ?? {})
    .map(([id, anchor]) => ({ id, ...anchor }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The original pairing: `data/world.json` over `data/gentle.js`. */
export function gentleWorldSource(): WorldSource {
  return {
    worldFile: worldFileJson as WorldFile,
    map: {
      width: gentle.mapwidth,
      height: gentle.mapheight,
      tileSetUrl: gentle.tilesetpath,
      tileSetDimX: gentle.tilesetpxw,
      tileSetDimY: gentle.tilesetpxh,
      tileDim: gentle.tiledim,
      bgTiles: gentle.bgtiles,
      objectTiles: gentle.objmap,
      animatedSprites: gentle.animatedsprites,
      collision: gentleCollision(),
      anchors: serializeAnchors(),
    },
    characters: new Set(characters.map((c) => c.name)),
  };
}

function mapContext(source: WorldSource, collision: CollisionLayer): MapContext {
  return {
    anchors: new Map((source.map.anchors ?? []).map((anchor) => [anchor.id, anchor])),
    characters: source.characters,
    width: source.map.width,
    height: source.map.height,
    blocked: (x, y) => collision[x]?.[y] ?? false,
  };
}

export interface CreateAgenticWorldOptions {
  /** The map and the world file authored against it. Defaults to the gentle pairing. */
  source?: WorldSource;
  worldId?: string;
  /**
   * Game time the world starts at. Defaults to the wall clock, which is what the Convex engine
   * row did — and which also keeps it away from zero, where `runTicks`'s falsy start-of-step test
   * would skip the first interval.
   */
  startTime?: number;
  godEnabled?: boolean;
  /** Caps mobile actors, for a smaller world. Fixed entities are never capped. */
  maxMobileActors?: number;
  /** Stubbed in tests, so the loop can be driven without a model. */
  runOperation?: AgenticRuntimeOptions['runOperation'];
  runGod?: AgenticRuntimeOptions['runGod'];
}

export function createAgenticWorld(options: CreateAgenticWorldOptions = {}): AgenticRuntime {
  const source = options.source ?? gentleWorldSource();
  const worldFile = source.worldFile;
  const collision = source.map.collision ?? [];
  const context = mapContext(source, collision);
  const startTime = options.startTime ?? Date.now();
  const plan = createWorldPlan(worldFile, context, collision, {
    maxMobileActors: options.maxMobileActors,
    // Only reached for a world file with no `meta.seed`; `data/world.json` declares one, so this
    // world is reproducible from its file plus its log.
    fallbackSeed: startTime >>> 0,
  });
  for (const warning of plan.warnings) {
    console.warn(`World file: ${warning}`);
  }

  const game = new Game(options.worldId ?? worldFile.meta?.id ?? 'world', {
    world: {
      ...plan.world,
      conversations: [],
      players: [],
      agents: [],
      entities: [],
    },
    playerDescriptions: [],
    agentDescriptions: [],
    entityDescriptions: [],
    // The plan's collision, not the source's: fixed entities have had their anchors subtracted
    // out of it (docs/07 §5.2), and drawing or pathing on the unsubtracted one would keep a door
    // solid after its entity opened.
    worldMap: { ...source.map, collision: plan.collision },
  });

  const store = new InMemoryAgentStore();
  if (plan.commonKnowledge) {
    // Installed at creation rather than through an input, for the reason docs/05 §5.3 gives: it
    // is configuration the world is built from, and it has exactly one writer.
    store.appendEntityState(COMMON_KNOWLEDGE_ID, 1, plan.commonKnowledge);
  }

  const runtime = new AgenticRuntime({
    game,
    store,
    description: plan.description,
    startTime,
    godEnabled: options.godEnabled ?? !!plan.description.godPersona,
    runOperation: options.runOperation,
    runGod: options.runGod,
  });

  // The world's population arrives as inputs, so creating a world is itself in the log and a
  // replay rebuilds it the same way (docs/05 §9).
  for (const args of plan.entityInputs) {
    runtime.send('createEntity', args as never);
  }
  return runtime;
}

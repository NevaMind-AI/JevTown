import * as gentle from '../../data/gentle';
import worldFileJson from '../../data/world.json';
import { characters } from '../../data/characters';
import { Game } from '../../engine/aiTown/game';
import { MapContext, WorldFile } from '../../engine/aiTown/worldFile';
import { CollisionLayer } from '../../engine/aiTown/worldMap';
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
 * The map is still `data/gentle.js`, which is the one `data/world.json` was authored against —
 * its anchors are the places the world file puts entities. Sharing a map with `MemoryWorld`'s
 * scenes is the remaining piece of docs/11 §9 F1 and needs anchors authored into `dev`'s
 * per-scene JSON; until then the two worlds tick on one clock but stand on different ground.
 */

const mapModule = gentle as typeof gentle & {
  collision?: boolean[][];
  anchors?: Record<string, { x: number; y: number; w: number; h: number; description: string }>;
};

const worldFile = worldFileJson as WorldFile;

/** Static collision, derived from the object layers for a map that predates docs/07 §5.1. */
function staticCollision(): CollisionLayer {
  return (
    mapModule.collision ??
    Array.from({ length: gentle.mapwidth }, (_, x) =>
      Array.from({ length: gentle.mapheight }, (_, y) =>
        gentle.objmap.some((layer: number[][]) => (layer[x]?.[y] ?? -1) !== -1),
      ),
    )
  );
}

function mapContext(collision: CollisionLayer): MapContext {
  return {
    anchors: new Map(Object.entries(mapModule.anchors ?? {})),
    characters: new Set(characters.map((c) => c.name)),
    width: gentle.mapwidth,
    height: gentle.mapheight,
    blocked: (x, y) => collision[x]?.[y] ?? false,
  };
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

export interface CreateAgenticWorldOptions {
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
  const collision = staticCollision();
  const context = mapContext(collision);
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
    worldMap: {
      width: gentle.mapwidth,
      height: gentle.mapheight,
      tileSetUrl: gentle.tilesetpath,
      tileSetDimX: gentle.tilesetpxw,
      tileSetDimY: gentle.tilesetpxh,
      tileDim: gentle.tiledim,
      bgTiles: gentle.bgtiles,
      objectTiles: gentle.objmap,
      animatedSprites: gentle.animatedsprites,
      collision: plan.collision,
      anchors: serializeAnchors(),
    },
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

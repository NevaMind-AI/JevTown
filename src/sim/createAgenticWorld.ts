import { characters } from '../../data/characters';
import { Game } from '../../engine/aiTown/game';
import { WorldFile } from '../../engine/aiTown/worldFile';
import { createWorldPlan } from '../../engine/createWorld';
import { WORLD_STATE_ID } from '../../engine/prose/contract';
import { InMemoryAgentStore } from '../../agent/store/memoryStore';
import type { Content } from '../../prototype/content';
import { AgenticRuntime, AgenticRuntimeOptions } from './agenticRuntime';
import { sceneCollision, sceneMapContext, sceneWorldMap } from './sceneMap';

/**
 * Stand up the agentic world in the tab.
 *
 * This is `convex/init.ts` without the database: the decisions it made about what a world *is*
 * are in `engine/createWorld.ts`, and what is left here is feeding it ground and handing the
 * result to a runtime.
 *
 * The ground is the content package's scenes (docs/13 §2) — the same ones `MemoryWorld` walks —
 * and the world file is the package's too, the one `loadContent` already resolved onto those
 * scenes as placements. One file, read twice: once for where things stand, once for who they are.
 * The agentic world owns no map of its own, and `data/gentle` is no longer anybody's ground.
 */

export interface CreateAgenticWorldOptions {
  /**
   * The loaded content package: its scenes are the ground and its `world` is the world file.
   * `loadPackage` produces exactly this.
   */
  content: Content;
  worldId?: string;
  /**
   * Game time the world starts at. Defaults to the wall clock, which is what the Convex engine
   * row did. A real session passes `MemoryWorld`'s `draft.time`, which is what makes the two
   * worlds share one stamp (docs/13 §3.2).
   */
  startTime?: number;
  godEnabled?: boolean;
  /** Caps mobile actors, for a smaller world. Fixed entities are never capped. */
  maxMobileActors?: number;
  /** Stubbed in tests, so the loop can be driven without a model. */
  runOperation?: AgenticRuntimeOptions['runOperation'];
  runGod?: AgenticRuntimeOptions['runGod'];
  /** The host's fiction clock, in story seconds (docs/13 §3.3). */
  storyTime?: AgenticRuntimeOptions['storyTime'];
}

/** The package's world file, if it ships one. A package without one has no agents in it. */
export function worldFileOf(content: Content): WorldFile | undefined {
  // `loadContent` types this by what placement reads; the whole file rides along, and
  // `validateWorldFile` below is the authority on the rest of it.
  return content.world as WorldFile | undefined;
}

export function createAgenticWorld(options: CreateAgenticWorldOptions): AgenticRuntime {
  const { content } = options;
  const worldFile = worldFileOf(content);
  if (!worldFile) {
    throw new Error('This content package ships no world file, so it has no agents to run');
  }
  const startScene = content.story.start.scene;
  const context = {
    ...sceneMapContext(
      content.scenes,
      characters.map((c) => c.name),
      startScene,
    ),
    // The content owns the art vocabulary; a name outside it draws nothing (docs/13 §2).
    sprites: new Set(Object.keys(content.story.sprites ?? {})),
  };
  const startTime = options.startTime ?? Date.now();
  // The engine walks nothing any more, so the collision this plan subtracts under fixed entities
  // serves no mover. It is passed because the plan still validates against it; the maps the game
  // stands on come straight from the scenes below.
  const plan = createWorldPlan(
    worldFile,
    context,
    sceneCollision(content.scenes.find((s) => s.id === startScene)!),
    {
      maxMobileActors: options.maxMobileActors,
      // Only reached for a world file with no `meta.seed`.
      fallbackSeed: startTime >>> 0,
    },
  );
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
    // Derived here, never persisted: the scenes are content the client already holds.
    scenes: content.scenes.map((scene) => ({ scene: scene.id, map: sceneWorldMap(scene) })),
    defaultScene: startScene,
  });

  const store = new InMemoryAgentStore();
  if (plan.worldState) {
    // Installed at creation rather than through an input, for the reason docs/05 §5.3 gives: it
    // is configuration the world is built from, and it has exactly one writer.
    store.appendEntityState(WORLD_STATE_ID, 1, plan.worldState);
  }

  const runtime = new AgenticRuntime({
    game,
    store,
    description: plan.description,
    startTime,
    godEnabled: options.godEnabled ?? !!plan.description.godPersona,
    runOperation: options.runOperation,
    runGod: options.runGod,
    storyTime: options.storyTime,
  });

  // The world's population arrives as inputs, so creating a world is itself in the log and a
  // replay rebuilds it the same way (docs/05 §9).
  for (const args of plan.entityInputs) {
    runtime.send('createEntity', args as never);
  }
  return runtime;
}

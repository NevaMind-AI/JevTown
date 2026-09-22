import { ConvexError, v } from 'convex/values';
import {
  ActionCtx,
  DatabaseReader,
  MutationCtx,
  internalAction,
  mutation,
  query,
} from '../_generated/server';
import { insertInput } from './insertInput';
import { Game } from '../../engine/aiTown/game';
import { runTicks } from '../../engine/runtime';
import { internal } from '../_generated/api';
import { sleep } from '../../engine/util/sleep';
import { Doc, Id } from '../_generated/dataModel';
import { ENGINE_ACTION_DURATION } from '../../engine/constants';

export async function createEngine(ctx: MutationCtx) {
  const now = Date.now();
  const engineId = await ctx.db.insert('engines', {
    currentTime: now,
    generationNumber: 0,
    running: true,
  });
  return engineId;
}

async function loadWorldStatus(db: DatabaseReader, worldId: Id<'worlds'>) {
  const worldStatus = await db
    .query('worldStatus')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .unique();
  if (!worldStatus) {
    throw new Error(`No engine found for world ${worldId}`);
  }
  return worldStatus;
}

export async function startEngine(ctx: MutationCtx, worldId: Id<'worlds'>) {
  const { engineId } = await loadWorldStatus(ctx.db, worldId);
  const engine = await ctx.db.get(engineId);
  if (!engine) {
    throw new Error(`Invalid engine ID: ${engineId}`);
  }
  if (engine.running) {
    throw new Error(`Engine ${engineId} isn't currently stopped`);
  }
  const now = Date.now();
  const generationNumber = engine.generationNumber + 1;
  await ctx.db.patch(engineId, {
    // Forcibly advance time to the present. This does mean we'll skip
    // simulating the time the engine was stopped, but we don't want
    // to have to simulate a potentially large stopped window and send
    // it down to clients.
    lastStepTs: engine.currentTime,
    currentTime: now,
    running: true,
    generationNumber,
  });
  await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
    worldId: worldId,
    generationNumber,
    maxDuration: ENGINE_ACTION_DURATION,
  });
}

export async function kickEngine(ctx: MutationCtx, worldId: Id<'worlds'>) {
  const { engineId } = await loadWorldStatus(ctx.db, worldId);
  const engine = await ctx.db.get(engineId);
  if (!engine) {
    throw new Error(`Invalid engine ID: ${engineId}`);
  }
  if (!engine.running) {
    throw new Error(`Engine ${engineId} isn't currently running`);
  }
  const generationNumber = engine.generationNumber + 1;
  await ctx.db.patch(engineId, { generationNumber });
  await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
    worldId: worldId,
    generationNumber,
    maxDuration: ENGINE_ACTION_DURATION,
  });
}

export async function stopEngine(ctx: MutationCtx, worldId: Id<'worlds'>) {
  const { engineId } = await loadWorldStatus(ctx.db, worldId);
  const engine = await ctx.db.get(engineId);
  if (!engine) {
    throw new Error(`Invalid engine ID: ${engineId}`);
  }
  if (!engine.running) {
    throw new Error(`Engine ${engineId} isn't currently running`);
  }
  await ctx.db.patch(engineId, { running: false });
}

/**
 * One step: read the pending inputs, run the ticks, commit.
 *
 * This was `AbstractGame.runStep`. The loop itself is now `engine/runtime.ts:runTicks`, which has
 * no `ctx`; what is left here is the three host calls it used to make inline — load, save, and the
 * engine row bookkeeping that `AbstractGame` kept on the game object.
 */
async function runOneStep(
  ctx: ActionCtx,
  game: Game,
  engineState: Doc<'engines'>,
  worldId: Id<'worlds'>,
  now: number,
): Promise<Doc<'engines'>> {
  const inputDocs = await ctx.runQuery(internal.engine.engineStore.loadInputs, {
    engineId: engineState._id,
    processedInputNumber: engineState.processedInputNumber,
    max: game.maxInputsPerStep,
  });

  const result = runTicks(game, {
    previousCurrentTime: engineState.currentTime,
    now,
    inputs: inputDocs.map((input) => ({
      number: input.number,
      name: input.name,
      args: input.args,
      received: input.received,
    })),
    processedInputNumber: engineState.processedInputNumber,
  });

  // `runTicks` identifies inputs by `number`, which is the only identity the simulation has.
  // Document ids are this layer's business, so the mapping back happens here.
  const idByNumber = new Map(inputDocs.map((input) => [input.number, input._id]));
  const completedInputs = result.completedInputs.map((completed) => ({
    inputId: idByNumber.get(completed.number)!,
    returnValue: completed.returnValue,
  }));

  const next: Doc<'engines'> = {
    ...engineState,
    lastStepTs: engineState.currentTime,
    currentTime: result.currentTs,
    generationNumber: engineState.generationNumber + 1,
    processedInputNumber: result.processedInputNumber,
  };
  const { _id, _creationTime, ...engine } = next;
  await ctx.runMutation(internal.aiTown.gameStore.saveWorld, {
    engineId: engineState._id,
    engineUpdate: {
      engine,
      completedInputs,
      expectedGenerationNumber: engineState.generationNumber,
    },
    worldId,
    worldDiff: game.takeDiff(),
  });

  console.debug(
    `Simulated from ${result.startTs} to ${result.currentTs} (${
      result.currentTs - result.startTs
    }ms)`,
  );
  return next;
}

export const runStep = internalAction({
  args: {
    worldId: v.id('worlds'),
    generationNumber: v.number(),
    maxDuration: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      const { engine, gameState } = await ctx.runQuery(internal.aiTown.gameStore.loadWorld, {
        worldId: args.worldId,
        generationNumber: args.generationNumber,
      });
      const game = new Game(args.worldId, gameState);
      let engineState = engine;

      let now = Date.now();
      const deadline = now + args.maxDuration;
      while (now < deadline) {
        engineState = await runOneStep(ctx, game, engineState, args.worldId, now);
        const sleepUntil = Math.min(now + game.stepDuration, deadline);
        await sleep(sleepUntil - now);
        now = Date.now();
      }
      await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
        worldId: args.worldId,
        generationNumber: engineState.generationNumber,
        maxDuration: args.maxDuration,
      });
    } catch (e: unknown) {
      if (e instanceof ConvexError) {
        if (e.data.kind === 'engineNotRunning') {
          console.debug(`Engine is not running: ${e.message}`);
          return;
        }
        if (e.data.kind === 'generationNumber') {
          console.debug(`Generation number mismatch: ${e.message}`);
          return;
        }
      }
      throw e;
    }
  },
});

export const sendInput = mutation({
  args: {
    worldId: v.id('worlds'),
    name: v.string(),
    args: v.any(),
  },
  handler: async (ctx, args) => {
    return await insertInput(ctx, args.worldId, args.name as any, args.args);
  },
});

export const inputStatus = query({
  args: {
    inputId: v.id('inputs'),
  },
  handler: async (ctx, args) => {
    const input = await ctx.db.get(args.inputId);
    if (!input) {
      throw new Error(`Invalid input ID: ${args.inputId}`);
    }
    return input.returnValue ?? null;
  },
});

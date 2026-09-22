import { v } from 'convex/values';
import { Doc, Id } from '../_generated/dataModel';
import { DatabaseReader, MutationCtx, internalMutation, internalQuery } from '../_generated/server';
import { GameState, gameStateDiff, GameStateDiff } from '../../engine/aiTown/game';
import { EngineUpdate, applyEngineUpdate, engineUpdate, loadEngine } from '../engine/engineStore';
import { runAgentOperation } from './agentDriver';
import { appendAudit, appendEntityState, readBlob } from '../prose/store';

/**
 * The storage half of `engine/aiTown/game.ts`.
 *
 * `Game` used to carry `load` and `saveDiff` as static methods, which is what made the simulation
 * un-runnable outside Convex. They are ordinary functions over a database here, and the engine no
 * longer knows they exist. Under docs/11 §1 the frontend keeps the world in memory and ships
 * `takeDiff()`'s output in a batch instead, and this module goes away.
 */

export async function loadGameState(
  db: DatabaseReader,
  worldId: Id<'worlds'>,
  generationNumber: number,
): Promise<{ engine: Doc<'engines'>; gameState: GameState }> {
  const worldDoc = await db.get(worldId);
  if (!worldDoc) {
    throw new Error(`No world found with id ${worldId}`);
  }
  const worldStatus = await db
    .query('worldStatus')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .unique();
  if (!worldStatus) {
    throw new Error(`No engine found for world ${worldId}`);
  }
  const engine = await loadEngine(db, worldStatus.engineId, generationNumber);
  const playerDescriptionsDocs = await db
    .query('playerDescriptions')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .collect();
  const agentDescriptionsDocs = await db
    .query('agentDescriptions')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .collect();
  const entityDescriptionsDocs = await db
    .query('entityDescriptions')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .collect();
  const worldMapDoc = await db
    .query('maps')
    .withIndex('worldId', (q) => q.eq('worldId', worldId))
    .unique();
  if (!worldMapDoc) {
    throw new Error(`No map found for world ${worldId}`);
  }
  // Discard the system fields from the world state.
  const { _id, _creationTime, ...world } = worldDoc;
  const playerDescriptions = playerDescriptionsDocs
    // Discard player descriptions for players that no longer exist.
    .filter((d) => !!world.players.find((p) => p.id === d.playerId))
    .map(({ _id, _creationTime, worldId: _, ...doc }) => doc);
  const agentDescriptions = agentDescriptionsDocs
    .filter((a) => !!world.agents.find((p) => p.id === a.agentId))
    .map(({ _id, _creationTime, worldId: _, ...doc }) => doc);
  const entityDescriptions = entityDescriptionsDocs
    .filter((e) => !!world.entities?.find((entity) => entity.id === e.entityId))
    .map(({ _id, _creationTime, worldId: _, ...doc }) => doc);
  const {
    _id: _mapId,
    _creationTime: _mapCreationTime,
    worldId: _mapWorldId,
    ...worldMap
  } = worldMapDoc;
  return {
    engine,
    gameState: {
      world,
      playerDescriptions,
      agentDescriptions,
      entityDescriptions,
      worldMap,
    },
  };
}

export async function saveDiff(ctx: MutationCtx, worldId: Id<'worlds'>, diff: GameStateDiff) {
  const existingWorld = await ctx.db.get(worldId);
  if (!existingWorld) {
    throw new Error(`No world found with id ${worldId}`);
  }
  const newWorld = diff.world;
  // Archive newly deleted players, conversations, and agents.
  for (const player of existingWorld.players) {
    if (!newWorld.players.some((p) => p.id === player.id)) {
      await ctx.db.insert('archivedPlayers', { worldId, ...player });
    }
  }
  for (const conversation of existingWorld.conversations) {
    if (!newWorld.conversations.some((c) => c.id === conversation.id)) {
      const participants = conversation.participants.map((p) => p.playerId);
      const archivedConversation = {
        worldId,
        id: conversation.id,
        created: conversation.created,
        creator: conversation.creator,
        ended: Date.now(),
        lastMessage: conversation.lastMessage,
        numMessages: conversation.numMessages,
        participants,
      };
      await ctx.db.insert('archivedConversations', archivedConversation);
      for (let i = 0; i < participants.length; i++) {
        for (let j = 0; j < participants.length; j++) {
          if (i == j) {
            continue;
          }
          const player1 = participants[i];
          const player2 = participants[j];
          await ctx.db.insert('participatedTogether', {
            worldId,
            conversationId: conversation.id,
            player1,
            player2,
            ended: Date.now(),
          });
        }
      }
    }
  }
  for (const conversation of existingWorld.agents) {
    if (!newWorld.agents.some((a) => a.id === conversation.id)) {
      await ctx.db.insert('archivedAgents', { worldId, ...conversation });
    }
  }
  // Update the world state.
  await ctx.db.replace(worldId, newWorld);

  // Perform the prose writes the input handlers queued. This is the mutation that applies the
  // inputs, which is where docs/05 §9.3 puts the audit.
  for (const write of diff.proseWrites ?? []) {
    const previous = await ctx.db
      .query('entityState')
      .withIndex('byEntity', (q) => q.eq('worldId', worldId).eq('entityId', write.entityId))
      .order('desc')
      .first();
    const before =
      previous?.state ?? (previous?.stateRef ? await readBlob(ctx.db, previous.stateRef) : '');

    if (write.version !== undefined && (write.state !== undefined || write.stateRef)) {
      await appendEntityState(
        ctx.db,
        worldId,
        write.entityId,
        write.version,
        write.stateRef ? { stateRef: write.stateRef } : { state: write.state! },
        Date.now(),
      );
      await appendAudit(ctx.db, {
        worldId,
        entityId: write.entityId,
        field: 'state',
        source: write.source,
        before: before ?? '',
        after: write.state ?? `(blob ${write.stateRef})`,
        reason: write.reason,
        inputNumber: write.inputNumber,
        batchId: write.batchId,
        tags: write.tags,
      });
    }
    if (write.physicsAfter) {
      await appendAudit(ctx.db, {
        worldId,
        entityId: write.entityId,
        field: 'physics',
        source: write.source,
        before: JSON.stringify(write.physicsBefore ?? {}),
        after: JSON.stringify(write.physicsAfter),
        reason: write.reason,
        inputNumber: write.inputNumber,
        batchId: write.batchId,
      });
    }
    if (write.memory && write.memory.length > 0) {
      // Recorded only. Embedding and storage stay action-side: `memories` requires an
      // `embeddingId` that a mutation cannot produce. The log has the content, which is what
      // docs/05 §9.1 actually requires.
      await appendAudit(ctx.db, {
        worldId,
        entityId: write.entityId,
        field: 'memory',
        source: write.source,
        before: '',
        after: write.memory.join('\n'),
        reason: write.reason,
        inputNumber: write.inputNumber,
        batchId: write.batchId,
      });
    }
  }

  // Update the larger description tables if they changed.
  const { playerDescriptions, agentDescriptions, entityDescriptions, worldMap } = diff;
  if (playerDescriptions) {
    for (const description of playerDescriptions) {
      const existing = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('playerId', description.playerId))
        .unique();
      if (existing) {
        await ctx.db.replace(existing._id, { worldId, ...description });
      } else {
        await ctx.db.insert('playerDescriptions', { worldId, ...description });
      }
    }
  }
  if (agentDescriptions) {
    for (const description of agentDescriptions) {
      const existing = await ctx.db
        .query('agentDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('agentId', description.agentId))
        .unique();
      if (existing) {
        await ctx.db.replace(existing._id, { worldId, ...description });
      } else {
        await ctx.db.insert('agentDescriptions', { worldId, ...description });
      }
    }
  }
  if (entityDescriptions) {
    for (const description of entityDescriptions) {
      const existing = await ctx.db
        .query('entityDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', worldId).eq('entityId', description.entityId))
        .unique();
      if (existing) {
        await ctx.db.replace(existing._id, { worldId, ...description });
      } else {
        await ctx.db.insert('entityDescriptions', { worldId, ...description });
      }
    }
  }
  if (worldMap) {
    const existing = await ctx.db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', worldId))
      .unique();
    if (existing) {
      await ctx.db.replace(existing._id, { worldId, ...worldMap });
    } else {
      await ctx.db.insert('maps', { worldId, ...worldMap });
    }
  }
  // Start the desired agent operations.
  for (const operation of diff.agentOperations) {
    await runAgentOperation(ctx, operation.name, operation.args);
  }
}

export const loadWorld = internalQuery({
  args: {
    worldId: v.id('worlds'),
    generationNumber: v.number(),
  },
  handler: async (ctx, args) => {
    return await loadGameState(ctx.db, args.worldId, args.generationNumber);
  },
});

export const saveWorld = internalMutation({
  args: {
    engineId: v.id('engines'),
    engineUpdate,
    worldId: v.id('worlds'),
    worldDiff: gameStateDiff,
  },
  handler: async (ctx, args) => {
    await applyEngineUpdate(ctx, args.engineId, args.engineUpdate as EngineUpdate);
    await saveDiff(ctx, args.worldId, args.worldDiff);
  },
});

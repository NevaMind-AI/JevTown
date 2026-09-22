import { Infer, v } from 'convex/values';
import { Doc, Id } from '../_generated/dataModel';
import {
  ActionCtx,
  DatabaseReader,
  MutationCtx,
  internalMutation,
  internalQuery,
} from '../_generated/server';
import { World, serializedWorld } from './world';
import { CollisionOverlay } from './collisionOverlay';
import { WorldMap, serializedWorldMap } from './worldMap';
import { PlayerDescription, serializedPlayerDescription } from './playerDescription';
import { Location, locationFields, playerLocation } from './location';
import { runAgentOperation } from './agent';
import { GameId, IdTypes, allocGameId } from './ids';
import { InputArgs, InputNames, inputs } from './inputs';
import {
  AbstractGame,
  EngineUpdate,
  applyEngineUpdate,
  engineUpdate,
  loadEngine,
} from '../engine/abstractGame';
import { internal } from '../_generated/api';
import { HistoricalObject } from '../engine/historicalObject';
import { AgentDescription, serializedAgentDescription } from './agentDescription';
import { EntityDescription, serializedEntityDescription } from './entityDescription';
import { parseMap, serializeMap } from '../util/object';
import { Entity, EntityPhysics, entityPhysics } from './entity';
import { appendAudit, appendEntityState, readBlob } from '../prose/store';

const gameState = v.object({
  world: v.object(serializedWorld),
  playerDescriptions: v.array(v.object(serializedPlayerDescription)),
  agentDescriptions: v.array(v.object(serializedAgentDescription)),
  entityDescriptions: v.array(v.object(serializedEntityDescription)),
  worldMap: v.object(serializedWorldMap),
});
type GameState = Infer<typeof gameState>;

/**
 * A prose write on its way to the database.
 *
 * Input handlers cannot write: `inputHandler`'s signature is `(game, now, args) => Return` —
 * synchronous, no `ctx`. So a handler updates the world document (including the entity's
 * `stateVersion`, which it allocates) and queues the prose here; `saveDiff` performs the writes
 * in the same mutation that commits the step (docs/05 §9.3, docs/08 §4 A3).
 *
 * `before` for the audit is deliberately absent: the engine never reads prose (docs/05 §1), so
 * `saveDiff` looks up the previous document itself.
 */
export const proseWrite = v.object({
  entityId: v.string(),
  // The version the handler allocated. `saveDiff` writes the row at exactly this number.
  version: v.optional(v.number()),
  state: v.optional(v.string()),
  stateRef: v.optional(v.string()),
  // Carried so the log and the audit have the content. Embedding and storage stay action-side,
  // because `memories` requires an `embeddingId` a mutation cannot produce.
  memory: v.optional(v.array(v.string())),
  physicsBefore: v.optional(v.object(entityPhysics)),
  physicsAfter: v.optional(v.object(entityPhysics)),
  source: v.union(v.literal('self'), v.literal('interaction'), v.literal('god')),
  reason: v.string(),
  batchId: v.optional(v.string()),
  tags: v.optional(v.any()),
  inputNumber: v.number(),
});
export type ProseWrite = Infer<typeof proseWrite>;

const gameStateDiff = v.object({
  world: v.object(serializedWorld),
  playerDescriptions: v.optional(v.array(v.object(serializedPlayerDescription))),
  agentDescriptions: v.optional(v.array(v.object(serializedAgentDescription))),
  entityDescriptions: v.optional(v.array(v.object(serializedEntityDescription))),
  worldMap: v.optional(v.object(serializedWorldMap)),
  agentOperations: v.array(v.object({ name: v.string(), args: v.any() })),
  proseWrites: v.optional(v.array(proseWrite)),
});
type GameStateDiff = Infer<typeof gameStateDiff>;

export class Game extends AbstractGame {
  tickDuration = 16;
  stepDuration = 1000;
  maxTicksPerStep = 600;
  maxInputsPerStep = 32;

  world: World;

  historicalLocations: Map<GameId<'players'>, HistoricalObject<Location>>;

  descriptionsModified: boolean;
  worldMap: WorldMap;
  // Derived from entity physics, rebuilt on load, never persisted. See docs/07 §5.3.
  collisionOverlay: CollisionOverlay;
  playerDescriptions: Map<GameId<'players'>, PlayerDescription>;
  agentDescriptions: Map<GameId<'agents'>, AgentDescription>;
  entityDescriptions: Map<GameId<'entities'>, EntityDescription>;

  pendingOperations: Array<{ name: string; args: any }> = [];
  pendingProseWrites: ProseWrite[] = [];

  /** The input number currently being applied, so a handler can stamp its audit rows. */
  currentInputNumber = -1;

  numPathfinds: number;

  constructor(
    engine: Doc<'engines'>,
    public worldId: Id<'worlds'>,
    state: GameState,
  ) {
    super(engine);

    this.world = new World(state.world);
    delete this.world.historicalLocations;

    this.descriptionsModified = false;
    this.worldMap = new WorldMap(state.worldMap);
    this.collisionOverlay = new CollisionOverlay(this.worldMap.width);
    this.rebuildCollisionOverlay();
    this.agentDescriptions = parseMap(state.agentDescriptions, AgentDescription, (a) => a.agentId);
    this.playerDescriptions = parseMap(
      state.playerDescriptions,
      PlayerDescription,
      (p) => p.playerId,
    );
    this.entityDescriptions = parseMap(
      state.entityDescriptions,
      EntityDescription,
      (e) => e.entityId,
    );

    this.historicalLocations = new Map();

    this.numPathfinds = 0;
  }

  static async load(
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
    // Discard the system fields and historicalLocations from the world state.
    const { _id, _creationTime, historicalLocations: _, ...world } = worldDoc;
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

  /** Rebuilt from entity physics on load, and after any change to it. Never persisted. */
  rebuildCollisionOverlay() {
    this.collisionOverlay.clear();
    for (const entity of this.world.sortedEntities()) {
      if (entity.physics.blocksMovement) {
        this.collisionOverlay.add(this.worldMap.anchorTiles(entity.anchor));
      }
    }
  }

  setEntityPhysics(entity: Entity, physics: EntityPhysics) {
    const tiles = this.worldMap.anchorTiles(entity.anchor);
    if (entity.physics.blocksMovement && !physics.blocksMovement) {
      this.collisionOverlay.remove(tiles);
    } else if (!entity.physics.blocksMovement && physics.blocksMovement) {
      this.collisionOverlay.add(tiles);
    }
    entity.physics = { ...physics };
  }

  queueProseWrite(write: Omit<ProseWrite, 'inputNumber'>) {
    this.pendingProseWrites.push({ ...write, inputNumber: this.currentInputNumber });
  }

  allocId<T extends IdTypes>(idType: T): GameId<T> {
    const id = allocGameId(idType, this.world.nextId);
    this.world.nextId += 1;
    return id;
  }

  scheduleOperation(name: string, args: unknown) {
    this.pendingOperations.push({ name, args });
  }

  handleInput<Name extends InputNames>(
    now: number,
    name: Name,
    args: InputArgs<Name>,
    inputNumber = -1,
  ) {
    const handler = inputs[name]?.handler;
    if (!handler) {
      throw new Error(`Invalid input: ${name}`);
    }
    this.currentInputNumber = inputNumber;
    try {
      return handler(this, now, args as any);
    } finally {
      this.currentInputNumber = -1;
    }
  }

  // The simulation's only source of randomness. See convex/util/rng.ts.
  get rng() {
    return this.world.rng;
  }

  beginStep(_now: number) {
    // Store the current location of all players in the history tracking buffer.
    this.historicalLocations.clear();
    for (const player of this.world.sortedPlayers()) {
      this.historicalLocations.set(
        player.id,
        new HistoricalObject(locationFields, playerLocation(player)),
      );
    }
    this.numPathfinds = 0;
  }

  tick(now: number) {
    // Sorted once per tick: every loop below can mutate the world, and they must all see the same
    // deterministic order (docs/05 §10).
    const players = this.world.sortedPlayers();
    for (const player of players) {
      player.tick(this, now);
    }
    for (const player of players) {
      player.tickPathfinding(this, now);
    }
    for (const player of players) {
      player.tickPosition(this, now);
    }
    for (const conversation of this.world.sortedConversations()) {
      conversation.tick(this, now);
    }
    for (const agent of this.world.sortedAgents()) {
      agent.tick(this, now);
    }

    // Save each player's location into the history buffer at the end of
    // each tick.
    for (const player of this.world.sortedPlayers()) {
      let historicalObject = this.historicalLocations.get(player.id);
      if (!historicalObject) {
        historicalObject = new HistoricalObject(locationFields, playerLocation(player));
        this.historicalLocations.set(player.id, historicalObject);
      }
      historicalObject.update(now, playerLocation(player));
    }
  }

  async saveStep(ctx: ActionCtx, engineUpdate: EngineUpdate): Promise<void> {
    const diff = this.takeDiff();
    await ctx.runMutation(internal.aiTown.game.saveWorld, {
      engineId: this.engine._id,
      engineUpdate,
      worldId: this.worldId,
      worldDiff: diff,
    });
  }

  takeDiff(): GameStateDiff {
    const historicalLocations = [];
    let bufferSize = 0;
    for (const [id, historicalObject] of this.historicalLocations.entries()) {
      const buffer = historicalObject.pack();
      if (!buffer) {
        continue;
      }
      historicalLocations.push({ playerId: id, location: buffer });
      bufferSize += buffer.byteLength;
    }
    if (bufferSize > 0) {
      console.debug(
        `Packed ${Object.entries(historicalLocations).length} history buffers in ${(
          bufferSize / 1024
        ).toFixed(2)}KiB.`,
      );
    }
    this.historicalLocations.clear();

    const result: GameStateDiff = {
      world: { ...this.world.serialize(), historicalLocations },
      agentOperations: this.pendingOperations,
      proseWrites: this.pendingProseWrites.length > 0 ? this.pendingProseWrites : undefined,
    };
    this.pendingOperations = [];
    this.pendingProseWrites = [];
    if (this.descriptionsModified) {
      result.playerDescriptions = serializeMap(this.playerDescriptions);
      result.agentDescriptions = serializeMap(this.agentDescriptions);
      result.entityDescriptions = serializeMap(this.entityDescriptions);
      result.worldMap = this.worldMap.serialize();
      this.descriptionsModified = false;
    }
    return result;
  }

  static async saveDiff(ctx: MutationCtx, worldId: Id<'worlds'>, diff: GameStateDiff) {
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
          .withIndex('worldId', (q) =>
            q.eq('worldId', worldId).eq('playerId', description.playerId),
          )
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
          .withIndex('worldId', (q) =>
            q.eq('worldId', worldId).eq('entityId', description.entityId),
          )
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
}

export const loadWorld = internalQuery({
  args: {
    worldId: v.id('worlds'),
    generationNumber: v.number(),
  },
  handler: async (ctx, args) => {
    return await Game.load(ctx.db, args.worldId, args.generationNumber);
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
    await applyEngineUpdate(ctx, args.engineId, args.engineUpdate);
    await Game.saveDiff(ctx, args.worldId, args.worldDiff);
  },
});

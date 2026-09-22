import { Infer, v } from '../util/validators';
import { World, serializedWorld } from './world';
import { CollisionOverlay } from './collisionOverlay';
import { WorldMap, serializedWorldMap } from './worldMap';
import { PlayerDescription, serializedPlayerDescription } from './playerDescription';
import { GameId, IdTypes, allocGameId } from './ids';
import { InputArgs, InputNames, inputs } from './inputs';
import { AgentDescription, serializedAgentDescription } from './agentDescription';
import { EntityDescription, serializedEntityDescription } from './entityDescription';
import { parseMap, serializeMap } from '../util/object';
import { Entity, EntityPhysics, entityPhysics } from './entity';

export const gameState = v.object({
  world: v.object(serializedWorld),
  playerDescriptions: v.array(v.object(serializedPlayerDescription)),
  agentDescriptions: v.array(v.object(serializedAgentDescription)),
  entityDescriptions: v.array(v.object(serializedEntityDescription)),
  worldMap: v.object(serializedWorldMap),
});
export type GameState = Infer<typeof gameState>;

/**
 * A prose write on its way to storage.
 *
 * Input handlers cannot write: `inputHandler`'s signature is `(game, now, args) => Return` —
 * synchronous, no host. So a handler updates the world document (including the entity's
 * `stateVersion`, which it allocates) and queues the prose here; whoever drains the game performs
 * the writes when it commits the step (docs/05 §9.3, docs/08 §4 A3).
 *
 * `before` for the audit is deliberately absent: the engine never reads prose (docs/05 §1), so
 * the writer looks up the previous document itself.
 */
export const proseWrite = v.object({
  entityId: v.string(),
  // The version the handler allocated. The write lands at exactly this number.
  version: v.optional(v.number()),
  state: v.optional(v.string()),
  stateRef: v.optional(v.string()),
  // Carried so the log and the audit have the content. Embedding and storage stay outside the
  // engine, because `memories` requires an embedding the simulation cannot produce.
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

export const gameStateDiff = v.object({
  world: v.object(serializedWorld),
  playerDescriptions: v.optional(v.array(v.object(serializedPlayerDescription))),
  agentDescriptions: v.optional(v.array(v.object(serializedAgentDescription))),
  entityDescriptions: v.optional(v.array(v.object(serializedEntityDescription))),
  worldMap: v.optional(v.object(serializedWorldMap)),
  agentOperations: v.array(v.object({ name: v.string(), args: v.any() })),
  proseWrites: v.optional(v.array(proseWrite)),
});
export type GameStateDiff = Infer<typeof gameStateDiff>;

/**
 * The simulation, in memory.
 *
 * This class owns world state and the rules that advance it, and nothing else. It does not load,
 * does not save, does not schedule, and does not know what time it is — every one of those was a
 * `ctx` call and all of them now live with whoever drives the game. See `engine/runtime.ts` for
 * the loop and docs/11 §4.1 for why the split is the whole point.
 *
 * Everything the simulation wants done for it leaves through the two queues below and is collected
 * by `takeDiff`. Nothing in here is asynchronous.
 */
export class Game {
  tickDuration = 16;
  stepDuration = 1000;
  maxTicksPerStep = 600;
  maxInputsPerStep = 32;

  world: World;

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
    public worldId: string,
    state: GameState,
  ) {
    this.world = new World(state.world);

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

    this.numPathfinds = 0;
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

  // The simulation's only source of randomness. See engine/util/rng.ts.
  get rng() {
    return this.world.rng;
  }

  beginStep(_now: number) {
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
  }

  /**
   * Everything that happened since the last call: the world, the descriptions if they moved, and
   * the two queues. The caller decides what to do with it — write it to a database, ship it in a
   * batch, or assert on it in a replay test.
   */
  takeDiff(): GameStateDiff {
    const result: GameStateDiff = {
      world: this.world.serialize(),
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
}

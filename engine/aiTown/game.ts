import { Infer, v } from '../util/validators';
import { World, serializedWorld } from './world';
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
  /**
   * The ground, one map per scene (docs/13 §2). Derived by the host from the content it loaded
   * and never persisted: it is the scenes, and the client already holds those.
   */
  scenes: v.optional(v.array(v.object({ scene: v.string(), map: v.object(serializedWorldMap) }))),
  /** Where anything that names no scene stands. Required alongside `scenes`. */
  defaultScene: v.optional(v.string()),
  /** A world on one unnamed map — a test, or the stock format. Read only when `scenes` is absent. */
  worldMap: v.optional(v.object(serializedWorldMap)),
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
  // `record` is a write to the world's record by an entity rather than the god (docs/13 §4).
  source: v.union(
    v.literal('self'),
    v.literal('interaction'),
    v.literal('god'),
    v.literal('record'),
  ),
  // Which entity wrote it, where the entity being written is not the writer. Set for `record`
  // writes, whose `entityId` is always `__world__` and so says nothing about who moved a line.
  writtenBy: v.optional(v.string()),
  reason: v.string(),
  batchId: v.optional(v.string()),
  tags: v.optional(v.any()),
  inputNumber: v.number(),
});
export type ProseWrite = Infer<typeof proseWrite>;

/**
 * Where an agent wants its body to go, in the language of the side that owns the ground
 * (docs/13 §2).
 *
 * The engine no longer moves anything. It says what an agent wants and the host carries it to
 * `MemoryWorld`, which resolves it against who is standing where — something the engine cannot
 * know and should not guess. Ids are authored ids (`sourceId`), because those are the only ones
 * the map-owning side has.
 */
export const bodyMove = v.union(
  v.object({ kind: v.literal('approach'), body: v.string(), target: v.string() }),
  v.object({ kind: v.literal('wander'), body: v.string(), anchor: v.string() }),
  v.object({ kind: v.literal('stop'), body: v.string() }),
);
export type BodyMove = Infer<typeof bodyMove>;

export const gameStateDiff = v.object({
  world: v.object(serializedWorld),
  playerDescriptions: v.optional(v.array(v.object(serializedPlayerDescription))),
  agentDescriptions: v.optional(v.array(v.object(serializedAgentDescription))),
  entityDescriptions: v.optional(v.array(v.object(serializedEntityDescription))),
  agentOperations: v.array(v.object({ name: v.string(), args: v.any() })),
  proseWrites: v.optional(v.array(proseWrite)),
  bodyMoves: v.optional(v.array(bodyMove)),
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
  /** The scene registry (docs/13 §2). One entry, keyed `''`, for a world on a single map. */
  maps: Map<string, WorldMap>;
  defaultScene: string;
  playerDescriptions: Map<GameId<'players'>, PlayerDescription>;
  agentDescriptions: Map<GameId<'agents'>, AgentDescription>;
  entityDescriptions: Map<GameId<'entities'>, EntityDescription>;

  pendingOperations: Array<{ name: string; args: any }> = [];
  pendingProseWrites: ProseWrite[] = [];
  pendingMoves: BodyMove[] = [];

  /** The input number currently being applied, so a handler can stamp its audit rows. */
  currentInputNumber = -1;

  constructor(
    public worldId: string,
    state: GameState,
  ) {
    this.world = new World(state.world);

    this.descriptionsModified = false;
    if (state.scenes?.length) {
      this.maps = new Map(state.scenes.map(({ scene, map }) => [scene, new WorldMap(map)]));
      this.defaultScene = state.defaultScene ?? state.scenes[0].scene;
    } else if (state.worldMap) {
      this.maps = new Map([['', new WorldMap(state.worldMap)]]);
      this.defaultScene = '';
    } else {
      throw new Error('A game needs ground: a scene registry or a single map');
    }
    if (!this.maps.has(this.defaultScene)) {
      throw new Error(`The default scene "${this.defaultScene}" has no map`);
    }
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
  }

  /** The map a scene stands on. Anything that names no scene stands on the default one. */
  mapFor(scene?: string): WorldMap {
    const map = this.maps.get(scene ?? this.defaultScene);
    if (!map) {
      throw new Error(`No map for scene "${scene}"`);
    }
    return map;
  }

  /** Which scene something is in, with the default filled in. The one way to compare two. */
  sceneOf(thing: { scene?: string }): string {
    return thing.scene ?? this.defaultScene;
  }

  /**
   * Record a physics change.
   *
   * Collision itself is no longer the engine's (docs/13 §2): nothing here walks, so there is
   * nothing for a blocking entity to block. The value is kept, because prose writes it and the
   * audit reads it. Carrying a change across to the ground the scenes own is not done yet.
   */
  setEntityPhysics(entity: Entity, physics: EntityPhysics) {
    entity.physics = { ...physics };
  }

  /** Ask the host to move a body (docs/13 §2). Drained by `takeDiff`. */
  queueMove(move: BodyMove) {
    this.pendingMoves.push(move);
  }

  /**
   * Stop a body after its step in flight, which is the only place a tile walker can stop. A body
   * the world file did not create has no counterpart to stop, and nothing here moves it anyway.
   */
  stopBody(body: { sourceId?: string }) {
    if (body.sourceId !== undefined) this.queueMove({ kind: 'stop', body: body.sourceId });
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

  tick(now: number) {
    // Sorted once per tick: every loop below can mutate the world, and they must all see the same
    // deterministic order (docs/05 §10). There is no movement pass: bodies are moved by the world
    // that owns the ground and arrive here through `syncBodies` (docs/13 §2).
    for (const player of this.world.sortedPlayers()) {
      player.tick(this, now);
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
      bodyMoves: this.pendingMoves.length > 0 ? this.pendingMoves : undefined,
    };
    this.pendingOperations = [];
    this.pendingProseWrites = [];
    this.pendingMoves = [];
    if (this.descriptionsModified) {
      result.playerDescriptions = serializeMap(this.playerDescriptions);
      result.agentDescriptions = serializeMap(this.agentDescriptions);
      result.entityDescriptions = serializeMap(this.entityDescriptions);
      this.descriptionsModified = false;
    }
    return result;
  }
}

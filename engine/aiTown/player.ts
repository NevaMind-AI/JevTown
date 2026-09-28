import { Infer, ObjectType, v } from '../util/validators';
import { Point, Vector, point, vector } from '../util/types';
import { GameId, parseGameId } from './ids';
import { playerId } from './ids';
import { HUMAN_IDLE_TOO_LONG, MAX_HUMAN_PLAYERS } from '../constants';
import { Game } from './game';
import { inputHandler } from './inputHandler';
import { characters } from '../../data/characters';
import { PlayerDescription } from './playerDescription';

export const activity = v.object({
  description: v.string(),
  emoji: v.optional(v.string()),
  until: v.number(),
});
export type Activity = Infer<typeof activity>;

export const serializedPlayer = {
  id: playerId,
  human: v.optional(v.string()),
  activity: v.optional(activity),

  // The last time they did something.
  lastInput: v.number(),

  position: point,
  // Which scene the position is in (docs/13 §2). Optional while a world may stand on one unnamed
  // map; a scene world writes it with every position, and the two are one address.
  scene: v.optional(v.string()),
  /** The id the world file gave this actor, when it came from one (docs/13 §2). */
  sourceId: v.optional(v.string()),
  facing: vector,
  // Whether the body is walking, as a unit rate: 1 while the map-owning side has it on a path, 0
  // otherwise (docs/13 §2). The engine no longer knows how fast anything moves, only whether.
  speed: v.number(),

  // Points at the current row in `entityState` for tier (a) actors. Absent for humans, who write
  // no prose state (docs/05 §13 A5 leaves that open).
  stateVersion: v.optional(v.number()),
};
export type SerializedPlayer = ObjectType<typeof serializedPlayer>;

export class Player {
  id: GameId<'players'>;
  human?: string;
  activity?: Activity;

  lastInput: number;

  position: Point;
  scene?: string;
  sourceId?: string;
  facing: Vector;
  speed: number;
  stateVersion?: number;

  constructor(serialized: SerializedPlayer) {
    const { id, human, activity, lastInput, position, facing, speed } = serialized;
    this.stateVersion = serialized.stateVersion;
    this.id = parseGameId('players', id);
    this.human = human;
    this.activity = activity;
    this.lastInput = lastInput;
    this.position = position;
    this.scene = serialized.scene;
    this.sourceId = serialized.sourceId;
    this.facing = facing;
    this.speed = speed;
  }

  tick(game: Game, now: number) {
    if (this.human && this.lastInput < now - HUMAN_IDLE_TOO_LONG) {
      this.leave(game, now);
    }
  }

  static join(
    game: Game,
    now: number,
    name: string,
    character: string,
    description: string,
    tokenIdentifier?: string,
    spawnAnchor?: string,
    spawnScene?: string,
    sourceId?: string,
  ) {
    if (tokenIdentifier) {
      let numHumans = 0;
      for (const player of game.world.players.values()) {
        if (player.human) {
          numHumans++;
        }
        if (player.human === tokenIdentifier) {
          throw new Error(`You are already in this game!`);
        }
      }
      if (numHumans >= MAX_HUMAN_PLAYERS) {
        throw new Error(`Only ${MAX_HUMAN_PLAYERS} human players allowed at once.`);
      }
    }
    // An anchor narrows the search to a named place (docs/07 §4.2), swept in tile order so the
    // choice is the one `MemoryWorld` makes when it places the same entity: the first free tile.
    // It matters little — the first `syncBodies` overwrites it — but a body that starts where its
    // counterpart stands has nothing to reconcile. Without an anchor this is the original
    // whole-map sample from the seeded PRNG.
    const map = game.mapFor(spawnScene);
    const scene = spawnScene ?? game.defaultScene;
    const taken = (tile: Point) =>
      map.blockedStatic(tile.x, tile.y) ||
      [...game.world.players.values()].some(
        (p) => game.sceneOf(p) === scene && p.position.x === tile.x && p.position.y === tile.y,
      );
    let position: Point | undefined;
    if (spawnAnchor) {
      const tile = map.anchorTiles(spawnAnchor).find((t) => !taken(t));
      position = tile && { ...tile };
    } else {
      for (let attempt = 0; attempt < 10 && !position; attempt++) {
        const tile = { x: game.rng.int(map.width), y: game.rng.int(map.height) };
        if (!taken(tile)) position = tile;
      }
    }
    if (!position) {
      throw new Error(
        `Failed to find a free position${spawnAnchor ? ` in anchor ${spawnAnchor}` : ''}!`,
      );
    }
    const facingOptions = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
    ];
    const facing = game.rng.pick(facingOptions);
    if (!characters.find((c) => c.name === character)) {
      throw new Error(`Invalid character: ${character}`);
    }
    const playerId = game.allocId('players');
    game.world.players.set(
      playerId,
      new Player({
        id: playerId,
        human: tokenIdentifier,
        lastInput: now,
        position,
        ...(spawnScene !== undefined ? { scene: spawnScene } : {}),
        ...(sourceId !== undefined ? { sourceId } : {}),
        facing,
        speed: 0,
      }),
    );
    game.playerDescriptions.set(
      playerId,
      new PlayerDescription({
        playerId,
        character,
        description,
        name,
      }),
    );
    game.descriptionsModified = true;
    return playerId;
  }

  leave(game: Game, now: number) {
    // Stop our conversation if we're leaving the game.
    const conversation = [...game.world.conversations.values()].find((c) =>
      c.participants.has(this.id),
    );
    if (conversation) {
      conversation.stop(game, now);
    }
    game.world.players.delete(this.id);
  }

  serialize(): SerializedPlayer {
    const { id, human, activity, lastInput, position, facing, speed, stateVersion } = this;
    return {
      id,
      human,
      activity,
      lastInput,
      position,
      ...(this.scene !== undefined ? { scene: this.scene } : {}),
      ...(this.sourceId !== undefined ? { sourceId: this.sourceId } : {}),
      facing,
      speed,
      stateVersion,
    };
  }
}

export const playerInputs = {
  join: inputHandler({
    args: {
      name: v.string(),
      character: v.string(),
      description: v.string(),
      tokenIdentifier: v.optional(v.string()),
    },
    handler: (game, now, args) => {
      Player.join(game, now, args.name, args.character, args.description, args.tokenIdentifier);
      return null;
    },
  }),
  leave: inputHandler({
    args: { playerId },
    handler: (game, now, args) => {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) {
        throw new Error(`Invalid player ID ${playerId}`);
      }
      player.leave(game, now);
      return null;
    },
  }),
  /**
   * Where the bodies are, as the world that owns the ground reports it (docs/13 §2).
   *
   * The engine stopped moving anything; `MemoryWorld` walks every body and this carries the
   * result in. An input rather than a write from outside, so a replay of this log puts every body
   * where it was — positions are part of what decides who is close enough to talk. The host sends
   * only bodies that changed, which is most frames none of them.
   */
  syncBodies: inputHandler({
    args: {
      bodies: v.array(
        v.object({
          sourceId: v.string(),
          scene: v.string(),
          x: v.number(),
          y: v.number(),
          walking: v.boolean(),
          facing: vector,
        }),
      ),
    },
    handler: (game, now, args) => {
      const bySource = new Map<string, Player>();
      for (const player of game.world.players.values()) {
        if (player.sourceId !== undefined) bySource.set(player.sourceId, player);
      }
      for (const body of args.bodies) {
        const player = bySource.get(body.sourceId);
        if (!player) continue;
        player.position = { x: body.x, y: body.y };
        player.scene = body.scene;
        player.facing = { dx: body.facing.dx, dy: body.facing.dy };
        player.speed = body.walking ? 1 : 0;
      }
      return null;
    },
  }),
};

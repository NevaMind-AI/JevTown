import { ObjectType, v } from 'convex/values';
import { GameId, parseGameId, entityId } from './ids';
import { Point } from '../util/types';
import type { Game } from './game';

/**
 * A fixed entity: tier (b) a fixed actor, or tier (c) a passive prop.
 *
 * They share one collection because docs/05 §3.1 (as amended by docs/08 §7 D3) found that the
 * runtime splits on **mobility** during approach and on **agency** during dialogue. (b) and (c)
 * are identical while being approached — both are anchored things you walk to — and differ only
 * once the interaction begins, where (b) takes turns and (c) is one-shot. `kind` carries that
 * second distinction; nothing about targeting or approach reads it.
 *
 * Tier (a), the mobile actor, stays a `Player` + `Agent` pair. It is the only tier that can be
 * invited, walk toward you, or initiate.
 */

export const entityPhysics = {
  // Read by `blocked()` on every pathfinding expansion and position tick.
  blocksMovement: v.boolean(),
  // Gates whether an agent may target this entity at all. Derived at load as `true` iff the
  // entity has state (docs/05 §4.3); authors never write it.
  interactable: v.boolean(),
};
export type EntityPhysics = ObjectType<typeof entityPhysics>;

/**
 * A physics change, as a patch rather than a whole value.
 *
 * What moves physics now is the `<blocked/>` / `<unblocked/>` tag in a state document, and a tag
 * only ever speaks about `blocksMovement`. A required-both-keys object would force whoever sent
 * it to read `interactable` and echo it back across a model call, which is a race with any other
 * write in between. A patch says only what it knows.
 */
export const entityPhysicsPatch = {
  blocksMovement: v.optional(v.boolean()),
  interactable: v.optional(v.boolean()),
};
export type EntityPhysicsPatch = ObjectType<typeof entityPhysicsPatch>;

export const serializedEntity = {
  id: entityId,
  kind: v.union(v.literal('actor'), v.literal('prop')),
  name: v.optional(v.string()),
  sprite: v.optional(v.string()),
  // A named rectangle owned by the map (docs/07 §4). Never raw tile coordinates.
  anchor: v.string(),
  physics: v.object(entityPhysics),
  // Points at the current row in `entityState`. The prose itself never enters the world
  // document, which is rewritten in full every step (docs/05 §8).
  stateVersion: v.number(),
};
export type SerializedEntity = ObjectType<typeof serializedEntity>;

export class Entity {
  id: GameId<'entities'>;
  kind: 'actor' | 'prop';
  name?: string;
  sprite?: string;
  anchor: string;
  physics: EntityPhysics;
  stateVersion: number;

  constructor(serialized: SerializedEntity) {
    this.id = parseGameId('entities', serialized.id);
    this.kind = serialized.kind;
    this.name = serialized.name;
    this.sprite = serialized.sprite;
    this.anchor = serialized.anchor;
    this.physics = { ...serialized.physics };
    this.stateVersion = serialized.stateVersion;
  }

  /** The tiles this entity occupies — its whole anchor rect, which is how a 3x2 gate works. */
  tiles(game: Game): Point[] {
    return game.worldMap.anchorTiles(this.anchor);
  }

  serialize(): SerializedEntity {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      sprite: this.sprite,
      anchor: this.anchor,
      physics: { ...this.physics },
      stateVersion: this.stateVersion,
    };
  }
}

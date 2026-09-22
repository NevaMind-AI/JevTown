import { ObjectType, v } from '../util/validators';
import { GameId, entityId, parseGameId } from './ids';

/**
 * The prompt-facing half of a fixed entity, kept out of the world document for the same reason
 * player and agent descriptions are: it is larger than the tick loop's state and it changes
 * rarely (docs/05 §8).
 */
export class EntityDescription {
  entityId: GameId<'entities'>;
  kind: 'actor' | 'prop';
  name?: string;
  /** Stable identity, for a fixed actor and a prop alike. Immutable (docs/05 §4.2). */
  description: string;
  /** An extension of `description`, appended to it in prompts (docs/05 §4.2). */
  behavior?: string;

  constructor(serialized: SerializedEntityDescription) {
    this.entityId = parseGameId('entities', serialized.entityId);
    this.kind = serialized.kind;
    this.name = serialized.name;
    this.description = serialized.description;
    this.behavior = serialized.behavior;
  }

  serialize(): SerializedEntityDescription {
    const { entityId, kind, name, description, behavior } = this;
    return { entityId, kind, name, description, behavior };
  }
}

export const serializedEntityDescription = {
  entityId,
  kind: v.union(v.literal('actor'), v.literal('prop')),
  name: v.optional(v.string()),
  description: v.string(),
  behavior: v.optional(v.string()),
};
export type SerializedEntityDescription = ObjectType<typeof serializedEntityDescription>;

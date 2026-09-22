import { ObjectType, v } from '../util/validators';
import { GameId, agentId, parseGameId } from './ids';

export class AgentDescription {
  agentId: GameId<'agents'>;
  identity: string;
  /** An extension of `identity`, appended to it in prompts (docs/05 §4.2). */
  behavior?: string;

  constructor(serialized: SerializedAgentDescription) {
    const { agentId, identity, behavior } = serialized;
    this.agentId = parseGameId('agents', agentId);
    this.identity = identity;
    this.behavior = behavior;
  }

  serialize(): SerializedAgentDescription {
    const { agentId, identity, behavior } = this;
    return { agentId, identity, behavior };
  }
}

export const serializedAgentDescription = {
  agentId,
  identity: v.string(),
  behavior: v.optional(v.string()),
};
export type SerializedAgentDescription = ObjectType<typeof serializedAgentDescription>;

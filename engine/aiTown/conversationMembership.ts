import { ObjectType, v } from '../util/validators';
import { GameId, parseGameId, playerId } from './ids';

export const serializedConversationMembership = {
  playerId,
  invited: v.number(),
  /**
   * A conversation only exists between two actors already standing next to each other
   * (docs/13 §2), so there is one membership state. `invited` and `walkingOver` were the states
   * of a conversation that existed before its participants had met; the approach now happens
   * first and the conversation is what arrival produces.
   */
  status: v.union(
    v.object({ kind: v.literal('participating'), started: v.number() }),
    // Read, never written: worlds serialized before the flip. See the constructor.
    v.object({ kind: v.literal('invited') }),
    v.object({ kind: v.literal('walkingOver') }),
  ),
};
export type SerializedConversationMembership = ObjectType<typeof serializedConversationMembership>;

export class ConversationMembership {
  playerId: GameId<'players'>;
  invited: number;
  status: { kind: 'participating'; started: number };

  constructor(serialized: SerializedConversationMembership) {
    const { playerId, invited, status } = serialized;
    this.playerId = parseGameId('players', playerId);
    this.invited = invited;
    // A world serialized before the flip may hold either of the two states that no longer
    // exist. Both meant "on the way", and a reloaded world has no way to resume a walk, so they
    // read as the state the pair would have reached: talking, from the moment they were invited.
    this.status =
      status.kind === 'participating' ? status : { kind: 'participating', started: invited };
  }

  serialize(): SerializedConversationMembership {
    const { playerId, invited, status } = this;
    return {
      playerId,
      invited,
      status,
    };
  }
}

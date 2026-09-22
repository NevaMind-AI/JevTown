import { Game } from '../../engine/aiTown/game';
import { SerializedPlayer } from '../../engine/aiTown/player';
import { SerializedAgent } from '../../engine/aiTown/agent';
import { SerializedConversation } from '../../engine/aiTown/conversation';
import { SerializedEntity } from '../../engine/aiTown/entity';
import { SerializedPlayerDescription } from '../../engine/aiTown/playerDescription';
import { SerializedAgentDescription } from '../../engine/aiTown/agentDescription';
import { SerializedEntityDescription } from '../../engine/aiTown/entityDescription';
import { WorldDescription, WorldReader } from '../../agent/ports';

/**
 * `WorldReader` over the live `Game`.
 *
 * This is the whole of what Convex needed five tables and a `runQuery` for. Under docs/11 §1 the
 * process asking is the process simulating, so every answer is a lookup in an object it already
 * has — which is why the interface is synchronous.
 *
 * Reads serialize rather than handing out engine objects. That costs a shallow copy on a path
 * taken once per model call, not once per tick, and it buys the guarantee that matters: the agent
 * layer cannot reach into the simulation and change it. Model output re-enters as an input or not
 * at all (docs/05 §9).
 */
export class GameWorldReader implements WorldReader {
  constructor(
    private game: Game,
    private description: WorldDescription,
  ) {}

  get worldId(): string {
    return this.game.worldId;
  }

  players(): SerializedPlayer[] {
    return this.game.world.sortedPlayers().map((player) => player.serialize());
  }

  agents(): SerializedAgent[] {
    return this.game.world.sortedAgents().map((agent) => agent.serialize());
  }

  conversations(): SerializedConversation[] {
    return this.game.world.sortedConversations().map((conversation) => conversation.serialize());
  }

  entities(): SerializedEntity[] {
    return this.game.world.sortedEntities().map((entity) => entity.serialize());
  }

  player(playerId: string): SerializedPlayer | undefined {
    return this.game.world.players.get(playerId as never)?.serialize();
  }

  conversation(conversationId: string): SerializedConversation | undefined {
    return this.game.world.conversations.get(conversationId as never)?.serialize();
  }

  entity(entityId: string): SerializedEntity | undefined {
    return this.game.world.entities.get(entityId as never)?.serialize();
  }

  agentForPlayer(playerId: string): SerializedAgent | undefined {
    return this.game.world
      .sortedAgents()
      .find((agent) => agent.playerId === playerId)
      ?.serialize();
  }

  playerDescription(playerId: string): SerializedPlayerDescription | undefined {
    return this.game.playerDescriptions.get(playerId as never)?.serialize();
  }

  agentDescription(agentId: string): SerializedAgentDescription | undefined {
    return this.game.agentDescriptions.get(agentId as never)?.serialize();
  }

  entityDescription(entityId: string): SerializedEntityDescription | undefined {
    return this.game.entityDescriptions.get(entityId as never)?.serialize();
  }

  worldDescription(): WorldDescription {
    return this.description;
  }
}

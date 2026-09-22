import { GameId } from '../../engine/aiTown/ids.ts';
import { AgentDescription } from '../../engine/aiTown/agentDescription.ts';
import { EntityDescription } from '../../engine/aiTown/entityDescription.ts';
import { PlayerDescription } from '../../engine/aiTown/playerDescription.ts';
import { World } from '../../engine/aiTown/world.ts';
import { WorldMap } from '../../engine/aiTown/worldMap.ts';
import { Id } from '../../convex/_generated/dataModel';
import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { parseMap } from '../../engine/util/object.ts';

export type ServerGame = {
  world: World;
  playerDescriptions: Map<GameId<'players'>, PlayerDescription>;
  agentDescriptions: Map<GameId<'agents'>, AgentDescription>;
  entityDescriptions: Map<GameId<'entities'>, EntityDescription>;
  worldMap: WorldMap;
};

// TODO: This hook reparses the game state (even if we're not rerunning the query)
// when used in multiple components. Move this to a context to only parse it once.
export function useServerGame(worldId: Id<'worlds'> | undefined): ServerGame | undefined {
  const worldState = useQuery(api.world.worldState, worldId ? { worldId } : 'skip');
  const descriptions = useQuery(api.world.gameDescriptions, worldId ? { worldId } : 'skip');
  const game = useMemo(() => {
    if (!worldState || !descriptions) {
      return undefined;
    }
    return {
      world: new World(worldState.world),
      agentDescriptions: parseMap(
        descriptions.agentDescriptions,
        AgentDescription,
        (p) => p.agentId,
      ),
      playerDescriptions: parseMap(
        descriptions.playerDescriptions,
        PlayerDescription,
        (p) => p.playerId,
      ),
      entityDescriptions: parseMap(
        descriptions.entityDescriptions,
        EntityDescription,
        (e) => e.entityId,
      ),
      worldMap: new WorldMap(descriptions.worldMap),
    };
  }, [worldState, descriptions]);
  return game;
}

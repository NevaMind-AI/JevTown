import { GameId } from '../../engine/aiTown/ids.ts';
import { AgentDescription } from '../../engine/aiTown/agentDescription.ts';
import { EntityDescription } from '../../engine/aiTown/entityDescription.ts';
import { PlayerDescription } from '../../engine/aiTown/playerDescription.ts';
import { World } from '../../engine/aiTown/world.ts';
import { WorldMap } from '../../engine/aiTown/worldMap.ts';

/**
 * The parsed world a component renders.
 *
 * Was `ServerGame`, assembled by two `useQuery` subscriptions that asked a Convex deployment what
 * the world looked like. Nothing asks anyone now: under docs/11 §1 the browser is running the
 * simulation, so this is a view of the `Game` the same tab is already ticking. Phase 4 publishes
 * it from `LocalGame`'s loop; the shape is unchanged, which is why the renderers did not have to
 * move.
 */
export type GameSnapshot = {
  world: World;
  playerDescriptions: Map<GameId<'players'>, PlayerDescription>;
  agentDescriptions: Map<GameId<'agents'>, AgentDescription>;
  entityDescriptions: Map<GameId<'entities'>, EntityDescription>;
  worldMap: WorldMap;
};

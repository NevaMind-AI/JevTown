import { AgentContext } from './ports';
import { WORLD_STATE_ID } from '../engine/prose/contract';
import type { ProseContext } from './purposes/sections';

// The sections moved to `agent/purposes/sections.ts` so the server can render them too
// (docs/14 §3.2). Re-exported for what already imports them from here.
export {
  currentStateSection,
  describe,
  identitySection,
  physicsSection,
  stateWritingSystemPrompt,
  worldRecordSection,
  worldRulesSection,
  worldStateSection,
} from './purposes/sections';
export type { ProseContext };

/**
 * Everything a state-writing prompt needs about one entity, and the sections that assemble it.
 *
 * Two rules from docs/05 §6.4 as amended are enforced by what this deliberately does *not*
 * return: an entity never sees another entity's prose state, and `world_rules` is not filtered
 * per actor — rules an actor must not know live in `god.hidden_rules`, which no actor prompt
 * ever reads.
 */

/** A `ProseContext` for one entity of this world: everything a prompt says about it. */
export interface PromptContext extends ProseContext {
  entityId: string;
}

/**
 * Assemble one entity's prompt context.
 *
 * Was a Convex `internalQuery` reading five tables. Four of those five live in the world document
 * the caller is already holding, so they are synchronous reads now; only the prose tier is still
 * a real fetch.
 */
export async function promptContextFor(
  ctx: AgentContext,
  entityId: string,
): Promise<PromptContext | null> {
  const worldRules = ctx.world.worldDescription().worldRules;
  const state = await ctx.store.readEntityState(entityId);
  const worldState = await ctx.store.readEntityState(WORLD_STATE_ID);

  if (entityId.startsWith('p:')) {
    const playerDescription = ctx.world.playerDescription(entityId);
    if (!playerDescription) {
      return null;
    }
    const agent = ctx.world.agentForPlayer(entityId);
    const agentDescription = agent ? ctx.world.agentDescription(agent.id) : undefined;
    return {
      entityId,
      tier: 'actor',
      name: playerDescription.name,
      description: agentDescription?.identity ?? playerDescription.description,
      behavior: agentDescription?.behavior,
      state,
      worldRules,
      worldState,
    };
  }

  const entity = ctx.world.entity(entityId);
  const entityDescription = ctx.world.entityDescription(entityId);
  if (!entityDescription) {
    return null;
  }
  return {
    entityId,
    tier: entityDescription.kind,
    name: entityDescription.name ?? 'It',
    description: entityDescription.description,
    behavior: entityDescription.behavior,
    state,
    physics: entity?.physics,
    worldRules,
    worldState,
  };
}

/** The agent driving a player, if it has one. */
export function agentIdForPlayer(ctx: AgentContext, playerId: string): string | undefined {
  return ctx.world.agentForPlayer(playerId)?.id;
}

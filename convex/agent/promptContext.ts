import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { readEntityState } from '../prose/store';
import { COMMON_KNOWLEDGE_ID, EntityTier, stateContractFor } from '../../engine/prose/contract';

/**
 * Everything a state-writing prompt needs about one entity, and the sections that assemble it.
 *
 * Two rules from docs/05 §6.4 as amended are enforced by what this deliberately does *not*
 * return: an entity never sees another entity's prose state, and `world_rules` is not filtered
 * per actor — rules an actor must not know live in `god.hidden_rules`, which no actor prompt
 * ever reads.
 */

export interface PromptContext {
  entityId: string;
  tier: EntityTier;
  name: string;
  /** Stable identity, for an actor and a prop alike. Never rewritten at runtime (docs/05 §4.2). */
  description: string;
  /** An extension of `description`, appended to it wherever it is injected (docs/05 §4.2). */
  behavior?: string;
  /** The current state document, or undefined for an entity that has never written one. */
  state?: string;
  /** Current physics, for fixed entities. Absent for tier (a), which has none of its own. */
  physics?: { blocksMovement: boolean; interactable: boolean };
  worldRules: string;
  /**
   * What everyone in this world knows (docs/05 §5.3). Unlike every other piece of prose here it
   * is not about this entity at all, and unlike `worldRules` it changes — the god rewrites it.
   */
  commonKnowledge?: string;
}

export const queryPromptContext = internalQuery({
  args: { worldId: v.id('worlds'), entityId: v.string() },
  handler: async (ctx, args): Promise<PromptContext | null> => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const worldDescription = await ctx.db
      .query('worldDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    const worldRules = worldDescription?.worldRules ?? '';
    const state = await readEntityState(ctx.db, args.worldId, args.entityId);
    const commonKnowledge = await readEntityState(ctx.db, args.worldId, COMMON_KNOWLEDGE_ID);

    if (args.entityId.startsWith('p:')) {
      const playerDescription = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.entityId))
        .first();
      if (!playerDescription) {
        return null;
      }
      const agent = world.agents.find((a) => a.playerId === args.entityId);
      const agentDescription = agent
        ? await ctx.db
            .query('agentDescriptions')
            .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', agent.id))
            .first()
        : undefined;
      return {
        entityId: args.entityId,
        tier: 'actor',
        name: playerDescription.name,
        description: agentDescription?.identity ?? playerDescription.description,
        behavior: agentDescription?.behavior,
        state,
        worldRules,
        commonKnowledge,
      };
    }

    const entity = world.entities?.find((e) => e.id === args.entityId);
    const entityDescription = await ctx.db
      .query('entityDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('entityId', args.entityId))
      .first();
    if (!entityDescription) {
      return null;
    }
    return {
      entityId: args.entityId,
      tier: entityDescription.kind,
      name: entityDescription.name ?? 'It',
      description: entityDescription.description,
      behavior: entityDescription.behavior,
      state,
      physics: entity?.physics,
      worldRules,
      commonKnowledge,
    };
  },
});

export const queryAgentForPlayer = internalQuery({
  args: { worldId: v.id('worlds'), playerId: v.string() },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    const agent = world?.agents.find((a) => a.playerId === args.playerId);
    return agent ? { agentId: agent.id } : null;
  },
});

/**
 * The immutable prose an entity is described by, wherever it is injected — its own prompt or
 * someone else's.
 *
 * `behavior` is an extension of `description`, not a separate kind of thing, so it is appended
 * rather than labelled (docs/05 §4.2). They are two fields only so that a writer agent can
 * produce them separately and an ablation can drop one; nothing downstream tells them apart.
 */
export function describe(context: { description: string; behavior?: string }): string {
  return context.behavior ? `${context.description}\n${context.behavior}` : context.description;
}

/**
 * The identity block: who this is. Never includes another entity's state.
 *
 * There is no vocabulary line and no goal line. An entity's legal states are whatever its
 * description implies (docs/05 §5.1), and what it wants is the intention section of its own state
 * document, which is mutable and which the entity itself rewrites — unlike the standing `plan`
 * this used to carry, which the format never declared and nothing could ever update.
 */
export function identitySection(context: PromptContext): string[] {
  return [`You are ${context.name}.`, `About you: ${describe(context)}`];
}

/** Verbatim, to every actor. Filtering is not a thing this format does (docs/05 §2 as amended). */
export function worldRulesSection(context: PromptContext): string[] {
  if (!context.worldRules.trim()) {
    return [];
  }
  return ['How this world works, which is true for everyone in it:', context.worldRules];
}

/**
 * What everyone in this world knows, verbatim and unfiltered, exactly as `world_rules` is.
 *
 * This is a deliberate exception to docs/05 §6.4: an actor cannot see another entity's state and
 * learns it only by interacting, but it reads this without having learned anything. What keeps
 * that honest is not a filter here — filtering would need a knowledge model this format does not
 * have — but the scope rule the writer obeys: only what every inhabitant would already know goes
 * in. Anything some actors must not know belongs in `god.hidden_rules`, which no actor prompt
 * ever reads, or nowhere at all.
 *
 * Placed immediately after the world's rules and before anything about this entity, so a god
 * write invalidates only the part of the prompt that was per-entity and changing anyway — the
 * cached prefix through the system text and `world_rules` survives it.
 */
export function commonKnowledgeSection(context: PromptContext): string[] {
  if (!context.commonKnowledge?.trim()) {
    return [];
  }
  return ['What everyone here knows to be true right now:', context.commonKnowledge];
}

/**
 * What this entity's physics currently is, in plain language — the ground truth from the world
 * document, which is what the tag in its own last document is supposed to agree with.
 *
 * This is the engine re-stamping the truth on every prompt rather than trusting the model to have
 * carried it forward correctly. Observed in a live run before there were tags: the Voice in the
 * Well, authored as solid, wrote itself walkable on its first state update and the collision
 * overlay dutifully cleared its tiles. Nothing here says how to report a change — that is the
 * contract's job, and whether this entity may report one at all is its `behavior`'s.
 */
export function physicsSection(context: PromptContext): string[] {
  if (!context.physics) {
    return [];
  }
  return [
    context.physics.blocksMovement
      ? 'Right now you are solid: nobody can walk through the space you occupy.'
      : 'Right now you are not solid: people can walk through the space you occupy.',
  ];
}

export function currentStateSection(context: PromptContext): string[] {
  if (!context.state) {
    return ['You have not written down your state before. This will be the first time.'];
  }
  return ['Your state right now:', context.state];
}

/** The full system prompt for a call that rewrites this entity's own state. */
export function stateWritingSystemPrompt(context: PromptContext, envelope: string): string {
  return [
    ...identitySection(context),
    '',
    ...worldRulesSection(context),
    '',
    ...commonKnowledgeSection(context),
    '',
    ...currentStateSection(context),
    '',
    ...physicsSection(context),
    '',
    stateContractFor(context.tier),
    '',
    envelope,
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}

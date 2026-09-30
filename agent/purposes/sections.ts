import {
  WORLD_RECORD_CONTRACT,
  stateContractFor,
  type EntityTier,
} from '../../engine/prose/contract.ts';
import { isRecord, optionalText, text } from './types.ts';

/**
 * Prompt sections more than one purpose renders.
 *
 * Moved here from `agent/promptContext.ts`, which re-exports them, so that the server can import
 * them (docs/14 §3.2). They take plain fields rather than a whole `PromptContext`: a purpose gets
 * its fields from the vars the tab sent, not from a context it could assemble itself.
 */

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

/** Verbatim, to every actor. Filtering is not a thing this format does (docs/05 §2 as amended). */
export function worldRulesSection(context: { worldRules: string }): string[] {
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
export function worldStateSection(context: { worldState?: string }): string[] {
  if (!context.worldState?.trim()) {
    return [];
  }
  return ['How this world stands right now:', context.worldState];
}

/**
 * Everything a prompt says about one entity: `PromptContext` without the id, which a prompt never
 * shows (`agent/promptContext.ts` adds it back).
 */
export interface ProseContext {
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
   * How this world stands right now (docs/05 §5.3, docs/13 §1.4). Unlike every other piece of
   * prose here it is not about this entity at all, and unlike `worldRules` it changes.
   */
  worldState?: string;
}

/**
 * The identity block: who this is. Never includes another entity's state.
 *
 * There is no vocabulary line and no goal line. An entity's legal states are whatever its
 * description implies (docs/05 §5.1), and what it wants is the intention section of its own state
 * document, which is mutable and which the entity itself rewrites — unlike the standing `plan`
 * this used to carry, which the format never declared and nothing could ever update.
 */
export function identitySection(context: ProseContext): string[] {
  return [`You are ${context.name}.`, `About you: ${describe(context)}`];
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
export function physicsSection(context: ProseContext): string[] {
  if (!context.physics) {
    return [];
  }
  return [
    context.physics.blocksMovement
      ? 'Right now you are solid: nobody can walk through the space you occupy.'
      : 'Right now you are not solid: people can walk through the space you occupy.',
  ];
}

export function currentStateSection(context: ProseContext): string[] {
  if (!context.state) {
    return ['You have not written down your state before. This will be the first time.'];
  }
  return ['Your state right now:', context.state];
}

/**
 * How to write the world's record (docs/13 §4), shown to every entity that writes state.
 *
 * Shown to every one of them on purpose, for now. The alternative was to gate it on a world-file
 * flag, the way the physics tag is effectively gated by an entity's own `behavior` — and that is
 * probably where this ends up, once there is a run's worth of evidence about whether an entity with
 * no business here writes anyway. Until then the guard is textual: the contract's first rule is
 * that writing nothing is the normal case, and what would make this entity write something lives in
 * its own `description` and `behavior`, which is a fact about a world rather than about the engine.
 *
 * Gating it later is a condition on this one line.
 */
export function worldRecordSection(_context: ProseContext): string[] {
  return [WORLD_RECORD_CONTRACT];
}

/** The full system prompt for a call that rewrites this entity's own state. */
export function stateWritingSystemPrompt(context: ProseContext, envelope: string): string {
  return [
    ...identitySection(context),
    '',
    ...worldRulesSection(context),
    '',
    ...worldStateSection(context),
    '',
    ...currentStateSection(context),
    '',
    ...physicsSection(context),
    '',
    stateContractFor(context.tier),
    '',
    ...worldRecordSection(context),
    '',
    envelope,
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}

// ---------------------------------------------------------------- checking vars

/** Well above anything the game writes; the state budget alone is 1000 words. */
export const PROSE_CHARS = 20_000;
export const NAME_CHARS = 200;

/** A `ProseContext` a client sent, checked and rebuilt. */
export function proseContext(value: unknown, what: string): ProseContext {
  if (!isRecord(value)) throw new Error(`${what} must be an object`);
  if (value.tier !== 'actor' && value.tier !== 'prop') {
    throw new Error(`${what}.tier must be actor or prop`);
  }
  const context: ProseContext = {
    tier: value.tier,
    name: text(value.name, `${what}.name`, NAME_CHARS),
    description: text(value.description, `${what}.description`, PROSE_CHARS),
    worldRules: text(value.worldRules, `${what}.worldRules`, PROSE_CHARS),
  };
  const behavior = optionalText(value.behavior, `${what}.behavior`, PROSE_CHARS);
  if (behavior !== undefined) context.behavior = behavior;
  const state = optionalText(value.state, `${what}.state`, PROSE_CHARS);
  if (state !== undefined) context.state = state;
  const worldState = optionalText(value.worldState, `${what}.worldState`, PROSE_CHARS);
  if (worldState !== undefined) context.worldState = worldState;
  if (value.physics !== undefined && value.physics !== null) {
    const physics = value.physics;
    if (
      !isRecord(physics) ||
      typeof physics.blocksMovement !== 'boolean' ||
      typeof physics.interactable !== 'boolean'
    ) {
      throw new Error(`${what}.physics needs blocksMovement and interactable`);
    }
    context.physics = {
      blocksMovement: physics.blocksMovement,
      interactable: physics.interactable,
    };
  }
  return context;
}

/**
 * The fields of a `ProseContext` and nothing else.
 *
 * What a call site sends. A `PromptContext` also carries the entity id, which no prompt shows and
 * the server has no use for.
 */
export function proseOf(context: ProseContext): ProseContext {
  const { tier, name, description, behavior, state, physics, worldRules, worldState } = context;
  return { tier, name, description, behavior, state, physics, worldRules, worldState };
}

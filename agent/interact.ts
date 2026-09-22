import { LLMMessage, chatCompletion } from './model/client';
import { GameId } from '../engine/aiTown/ids';
import { MAX_INTERACTION_TURNS } from '../engine/constants';
import { ENVELOPE_INSTRUCTION, TARGET_ENVELOPE_INSTRUCTION } from '../engine/prose/contract';
import { parseEnvelope } from '../engine/prose/envelope';
import { parseStateDocument } from '../engine/prose/stateDocument';
import {
  PromptContext,
  commonKnowledgeSection,
  describe,
  promptContextFor,
  stateWritingSystemPrompt,
  worldRulesSection,
} from './promptContext';
import { AgentContext } from './ports';
import { StateUpdateOutcome, requestStateUpdate, sendStateUpdate } from './stateUpdate';
import { Tracer } from './model/tracing';

/**
 * What happens when an agent reaches something it decided to approach (docs/09 §6).
 *
 * The whole exchange runs inside one operation rather than as a tick-driven lifecycle. A fixed
 * entity cannot walk away and cannot be interrupted, so there is nothing for the engine to
 * arbitrate between turns — which means no new world-document structure, no new participant
 * statuses, and no invite/walkingOver states that would have to be no-ops for something that does
 * not move.
 *
 * The cost of that choice, stated plainly: the exchange is not interruptible and lands all at
 * once rather than turn by turn. For a fixed target that is a fair trade; it would not be for a
 * conversation between two people, which is why tier (a) keeps `Conversation`.
 */

/**
 * docs/05 §6.2, actor → prop. One-way and one call: the acting agent writes both its own state
 * and the prop's, because the prop makes no call of its own and has no memory to write.
 *
 * This is where a locked door becomes an open one, and it is the reason physics rides alongside
 * the prose — the same call that decides Alice forces the door must tell the pathfinder it no
 * longer blocks.
 */
async function interactWithProp(
  ctx: AgentContext,
  actor: PromptContext,
  target: PromptContext,
  intent: string,
) {
  const system = [
    stateWritingSystemPrompt(actor, ''),
    '',
    // `behavior` rides along with the description here as it does everywhere else, and it has to:
    // a prop writes no state of its own, so any rule about how this thing behaves is only ever
    // read by the actor acting on it (docs/05 §6.2).
    `In front of you: ${target.name}. ${describe(target)}`,
    ...(target.state ? ['Its state right now:', target.state] : []),
    ...(target.physics
      ? [
          target.physics.blocksMovement
            ? 'Right now it is solid: nobody can get past it.'
            : 'Right now it is not solid: people can get past it.',
        ]
      : []),
    '',
    TARGET_ENVELOPE_INSTRUCTION,
  ].join('\n');

  // One call, one trace -- a prop makes no call of its own, so there is no exchange to group.
  const tracer = await Tracer.standalone({
    worldId: ctx.world.worldId,
    key: `interaction:${ctx.world.worldId}:${crypto.randomUUID()}`,
    name: `${actor.name} → ${target.name}`,
    tags: ['interaction', 'prop'],
    metadata: { actorId: actor.entityId, targetId: target.entityId, intent },
  });
  const { content } = await chatCompletion({
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: intent
          ? `You came here meaning to: ${intent}. Do it, and write what you and it are like afterwards.`
          : `Act on it, and write what you and it are like afterwards.`,
      },
    ],
    max_tokens: 1200,
    trace: tracer.generation('interaction.prop', { targetId: target.entityId }),
  });
  await tracer.close({ input: intent, output: content });

  const parsed = parseEnvelope(content);
  const selfDocument = parsed.self.state
    ? parseStateDocument(parsed.self.state).conformance
    : undefined;
  await sendStateUpdate(ctx, actor.entityId, {
    update: parsed.self,
    state: parsed.self.state,
    conformance: selfDocument,
    reasks: 0,
    fellBack: false,
    problems: [...parsed.problems, ...parsed.self.problems],
  });

  if (!parsed.target) {
    console.warn(`Interaction with ${target.entityId} produced no target update`);
    return;
  }
  const targetConformance = parsed.target.state
    ? parseStateDocument(parsed.target.state).conformance
    : undefined;
  await ctx.inputs.send('entityUpdateTarget', {
    actorId: actor.entityId,
    entityId: target.entityId,
    state: parsed.target.state,
    reason: parsed.target.reason,
    tags: {
      ...(targetConformance ?? {}),
      problems: parsed.target.problems,
    },
  });
}

/**
 * docs/05 §6.1 across two sides, where one of them cannot move. The turns alternate inside this
 * action; on conclusion each side makes its own single call that emits state, physics, memory and
 * reason together.
 */
async function interactWithFixedActor(
  ctx: AgentContext,
  actor: PromptContext,
  target: PromptContext,
  intent: string,
) {
  const interactionId = crypto.randomUUID();
  const transcript: { speaker: 'actor' | 'target'; text: string }[] = [];
  // The whole exchange runs in this one action, so the wrapper span is a real measured span and
  // every turn below leaves in a single export when it closes.
  const tracer = await Tracer.forInteraction({
    worldId: ctx.world.worldId,
    interactionId,
    name: `${actor.name} ↔ ${target.name}`,
    metadata: { actorId: actor.entityId, targetId: target.entityId, intent },
  });

  // World-level prose goes through the shared sections rather than an inlined variant. This was
  // the one prompt that phrased `world_rules` in its own words, which meant it was also the one
  // prompt that would have silently missed common knowledge (docs/05 §5.3).
  const turnPrompt = (speaker: PromptContext, other: PromptContext) =>
    [
      `You are ${speaker.name}. ${describe(speaker)}`,
      ...(speaker.state ? [speaker.state] : []),
      ...worldRulesSection(speaker),
      ...commonKnowledgeSection(speaker),
      `You are speaking with ${other.name}.`,
      'Say one thing. Keep it under 200 characters. Reply with the words you say and nothing else.',
    ].join('\n');

  for (let turn = 0; turn < MAX_INTERACTION_TURNS; turn++) {
    const speakerIsActor = turn % 2 === 0;
    const speaker = speakerIsActor ? actor : target;
    const other = speakerIsActor ? target : actor;
    const messages: LLMMessage[] = [
      { role: 'system', content: turnPrompt(speaker, other) },
      ...(turn === 0 && intent
        ? [{ role: 'user' as const, content: `You came here meaning to: ${intent}.` }]
        : []),
      ...transcript.map((entry) => ({
        role: 'user' as const,
        content: `${entry.speaker === 'actor' ? actor.name : target.name}: ${entry.text}`,
      })),
      { role: 'user' as const, content: `${speaker.name}:` },
    ];
    const { content } = await chatCompletion({
      messages,
      max_tokens: 200,
      trace: tracer.generation(`interaction.turn.${turn}`, {
        speaker: speaker.name,
        listener: other.name,
        turn,
      }),
    });
    const text = content.trim();
    transcript.push({ speaker: speakerIsActor ? 'actor' : 'target', text });
    await ctx.store.recordInteractionTurn({
      interactionId,
      actorId: actor.entityId,
      targetId: target.entityId,
      speaker: speakerIsActor ? 'actor' : 'target',
      text,
    });
  }

  for (const side of [actor, target]) {
    const other = side === actor ? target : actor;
    const system = stateWritingSystemPrompt(side, ENVELOPE_INSTRUCTION);
    let attempt = 0;
    const outcome = await requestStateUpdate({
      ask: async (retryHint) => {
        const { content } = await chatCompletion({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `You just spoke with ${other.name}. It went like this.` },
            ...transcript.map((entry) => ({
              role: 'user' as const,
              content: `${entry.speaker === 'actor' ? actor.name : target.name}: ${entry.text}`,
            })),
            {
              role: 'user',
              content: retryHint ?? 'Rewrite your state now that the exchange is over.',
            },
          ],
          max_tokens: 1200,
          // Re-asks get their own span, so a trace shows how many attempts the envelope took.
          trace: tracer.generation(
            attempt === 0 ? 'interaction.state' : `interaction.state.reask.${attempt}`,
            { entityId: side.entityId, tier: side.tier, attempt },
          ),
        });
        attempt++;
        return content;
      },
    });
    await sendStateUpdate(ctx, side.entityId, outcome);
  }

  await tracer.close({
    input: intent,
    output: transcript,
    metadata: { turns: transcript.length },
  });
}

export async function interactWithEntity(
  ctx: AgentContext,
  playerId: GameId<'players'>,
  targetId: string,
  intent: string,
): Promise<void> {
  const actor = await promptContextFor(ctx, playerId);
  const target = await promptContextFor(ctx, targetId);
  if (!actor || !target) {
    console.warn(`Interaction ${playerId} -> ${targetId} is missing context`);
    return;
  }
  if (target.tier === 'prop') {
    await interactWithProp(ctx, actor, target, intent);
  } else {
    await interactWithFixedActor(ctx, actor, target, intent);
  }
}

export type { StateUpdateOutcome };

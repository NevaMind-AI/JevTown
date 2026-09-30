import { runPurpose } from './model/client';
import { GameId } from '../engine/aiTown/ids';
import { MAX_INTERACTION_TURNS } from '../engine/constants';
import { parseStateDocument } from '../engine/prose/stateDocument';
import { PromptContext, promptContextFor } from './promptContext';
import { proseOf } from './purposes/sections';
import { AgentContext } from './ports';
import { StateUpdateOutcome, sendStateUpdate } from './stateUpdate';
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
 *
 * The prompt and the envelope's parsing are the server's (`interaction.prop`, docs/14 §3.2).
 */
async function interactWithProp(
  ctx: AgentContext,
  actor: PromptContext,
  target: PromptContext,
  intent: string,
) {
  // One call, one trace -- a prop makes no call of its own, so there is no exchange to group.
  const tracer = await Tracer.standalone({
    worldId: ctx.world.worldId,
    key: `interaction:${ctx.world.worldId}:${crypto.randomUUID()}`,
    name: `${actor.name} → ${target.name}`,
    tags: ['interaction', 'prop'],
    metadata: { actorId: actor.entityId, targetId: target.entityId, intent },
  });
  const { result: parsed } = await runPurpose(
    'interaction.prop',
    { actor: proseOf(actor), target: proseOf(target), intent },
    tracer.generation('interaction.prop', { targetId: target.entityId }),
  );
  await tracer.close({ input: intent, output: parsed });

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

/** One line of a two-sided exchange with a fixed actor, as every later prompt reads it back. */
export interface ExchangeLine {
  name: string;
  text: string;
  /** Who said it, in `recordInteractionTurn`'s terms: the visitor, or the fixed actor. */
  speaker: 'actor' | 'target';
}

/**
 * One turn: `speaker` says one thing to `otherName`, given everything said so far. The prompt is
 * the server's (`interaction.turn`, docs/14 §3.2).
 *
 * `intent` is what the agent came for, and only ever given on the exchange's first turn.
 */
async function speakTurn(
  speaker: PromptContext,
  otherName: string,
  transcript: ExchangeLine[],
  intent: string | undefined,
  trace: ReturnType<Tracer['generation']>,
): Promise<string> {
  const { result } = await runPurpose(
    'interaction.turn',
    {
      speaker: proseOf(speaker),
      otherName,
      transcript: transcript.map(({ name, text }) => ({ name, text })),
      intent,
    },
    trace,
  );
  return result;
}

/**
 * docs/05 §6.1's conclusion for one side: a single call that emits state, physics, memory and
 * reason together, re-asked once if the state runs over budget. The call, the re-ask and the
 * parsing run on the server (`interaction.state`); a re-ask gets its own span there, named
 * `interaction.state.reask.<n>`.
 */
async function writeStateAfterExchange(
  ctx: AgentContext,
  side: PromptContext,
  otherName: string,
  transcript: ExchangeLine[],
  tracer: Tracer,
) {
  const { result: outcome } = await runPurpose(
    'interaction.state',
    {
      self: proseOf(side),
      otherName,
      transcript: transcript.map(({ name, text }) => ({ name, text })),
    },
    tracer.generation('interaction.state', {
      entityId: side.entityId,
      tier: side.tier,
      attempt: 0,
    }),
  );
  await sendStateUpdate(ctx, side.entityId, outcome);
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
  const transcript: ExchangeLine[] = [];
  // The whole exchange runs in this one action, so the wrapper span is a real measured span and
  // every turn below leaves in a single export when it closes.
  const tracer = await Tracer.forInteraction({
    worldId: ctx.world.worldId,
    interactionId,
    name: `${actor.name} ↔ ${target.name}`,
    metadata: { actorId: actor.entityId, targetId: target.entityId, intent },
  });

  for (let turn = 0; turn < MAX_INTERACTION_TURNS; turn++) {
    const speakerIsActor = turn % 2 === 0;
    const speaker = speakerIsActor ? actor : target;
    const other = speakerIsActor ? target : actor;
    const text = await speakTurn(
      speaker,
      other.name,
      transcript,
      turn === 0 && intent ? intent : undefined,
      tracer.generation(`interaction.turn.${turn}`, {
        speaker: speaker.name,
        listener: other.name,
        turn,
      }),
    );
    const line: ExchangeLine = {
      name: speaker.name,
      text,
      speaker: speakerIsActor ? 'actor' : 'target',
    };
    transcript.push(line);
    await ctx.store.recordInteractionTurn({
      interactionId,
      actorId: actor.entityId,
      targetId: target.entityId,
      speaker: line.speaker,
      text,
    });
  }

  for (const side of [actor, target]) {
    await writeStateAfterExchange(
      ctx,
      side,
      (side === actor ? target : actor).name,
      transcript,
      tracer,
    );
  }

  await tracer.close({
    input: intent,
    output: transcript,
    metadata: { turns: transcript.length },
  });
}

/**
 * The human's side of docs/05 §6.3, with a fixed actor (tier b).
 *
 * The same exchange an agent has with a fixed actor, turned inside out: an agent's runs start to
 * finish inside one operation, because both sides are models; here one side is a person, so the
 * fixed actor answers one line at a time as the person types, and concludes when they leave.
 * Nothing about the fixed actor changes to allow it — no `Player`, no `Conversation` — which is
 * what keeps `08` §7 D3's split whole.
 *
 * On conclusion only the fixed actor writes state and memory. The human side writes nothing,
 * exactly as in a human's conversation with a mobile agent (§6.3).
 */
export class HumanExchange {
  readonly lines: ExchangeLine[] = [];

  private constructor(
    private readonly interactionId: string,
    private readonly ctx: AgentContext,
    private readonly target: PromptContext,
    private readonly human: { id: string; name: string },
    private readonly tracer: Tracer,
  ) {}

  static async open(
    ctx: AgentContext,
    targetId: string,
    human: { id: string; name: string },
  ): Promise<HumanExchange> {
    const target = await promptContextFor(ctx, targetId);
    if (!target || target.tier !== 'actor') {
      throw new Error(`${targetId} is not a fixed actor anybody can talk to`);
    }
    const interactionId = crypto.randomUUID();
    return new HumanExchange(
      interactionId,
      ctx,
      target,
      human,
      await Tracer.forInteraction({
        worldId: ctx.world.worldId,
        interactionId,
        name: `${human.name} ↔ ${target.name}`,
        metadata: { actorId: human.id, targetId, human: true },
      }),
    );
  }

  get partnerName(): string {
    return this.target.name;
  }

  /** The human says a line; the fixed actor answers it. The line is visible before the answer. */
  async reply(text: string): Promise<string> {
    await this.record({ name: this.human.name, text, speaker: 'actor' });
    const turn = this.lines.length;
    const answer = await speakTurn(
      this.target,
      this.human.name,
      this.lines,
      undefined,
      this.tracer.generation(`interaction.turn.${turn}`, {
        speaker: this.target.name,
        listener: this.human.name,
        turn,
      }),
    );
    await this.record({ name: this.target.name, text: answer, speaker: 'target' });
    return answer;
  }

  /** The fixed actor writes what the exchange left it with. Nothing to write if nobody spoke. */
  async conclude(): Promise<void> {
    if (this.lines.length) {
      await writeStateAfterExchange(
        this.ctx,
        this.target,
        this.human.name,
        this.lines,
        this.tracer,
      );
    }
    await this.tracer.close({ output: this.lines, metadata: { turns: this.lines.length } });
  }

  private async record(line: ExchangeLine) {
    this.lines.push(line);
    await this.ctx.store.recordInteractionTurn({
      interactionId: this.interactionId,
      actorId: this.human.id,
      targetId: this.target.entityId,
      speaker: line.speaker,
      text: line.text,
    });
  }
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

import { runPurpose } from './model/client';
import { WORLD_STATE_ID } from '../engine/prose/contract';
import { Tracer } from './model/tracing';
import { AgentContext } from './ports';
import { mysteryGiftEnabled } from './config';
import { renderBatch, type GateVerdict } from './purposes/god';
import { deciderOf } from './purposes/types';

// The rules, the prompts and the readers of both answers live in `agent/purposes/god.ts`, where
// the server renders and reads them (docs/14 §3.2). Re-exported for what already imports them.
export {
  MYSTERY_GIFT_INSTRUCTION,
  MYSTERY_GIFT_NAME,
  parseGate,
  parseVerdict,
  renderBatch,
} from './purposes/god';
export type { CommonKnowledgeWrite, GateVerdict, GodWrite } from './purposes/god';

/**
 * The overseer of docs/05 §7. Invisible, never rendered, no position, no entry in
 * `world.players` — one function over the audit trail and its own transcript.
 *
 * **v1 runs on a placeholder rule (docs/08 §7 D7).** The god's real shape is
 * *state + rule → judgement, and a fix if they conflict*, and that shape holds whatever the rule
 * is. Until a world file carries a story worth overseeing, the rule it judges against is the
 * §5.1 format contract rather than `world_rules` + `hidden_rules`. Only the rule text changes
 * when a story exists; the pipeline below does not.
 *
 * Two constraints keep the placeholder honest rather than turning the god into a formatter with a
 * transcript. Conformance is judged in the **gate**, so the intervention still fires rarely and
 * its hit rate stays an informative cost signal. And the god is not the first line of repair:
 * the state-writing action's re-ask has already run, so the god only ever sees what survived one
 * attempt (docs/05 §5.1).
 */

// ======================================================================================
// TEMPORARY PROBE — the mystery gift. Delete this block, the call sites marked `MYSTERY GIFT`
// in `godStep`, and the ones in `agent/purposes/god.ts` (its text, and the `mysteryGift` var) to
// remove it entirely; nothing else references it.
// ======================================================================================

/**
 * Off unless `GOD_MYSTERY_GIFT` is `1` in the environment, so turning the probe on or off is a
 * config change rather than a redeploy.
 *
 * What it probes: whether the god can read an `<items>` block, find one line in it, and add one
 * to a number — the smallest thing that has to work before anything that moves real objects
 * between entities can. It writes a gift whose name means nothing, precisely so that a correct
 * result cannot come from the model reasoning about what the item *is*. Nobody is told about the
 * gift: not the entity, not the writer agents, not the batch. Only the parser sees it, in
 * `stateDocument.items`, where `parseItems` will read the count back.
 *
 * One entity per batch, not all of them. A gift to every entity would write every entity's state
 * on every god step, which both floods the audit and makes the next batch enormous — the probe
 * would then be measuring its own load.
 */
export const MYSTERY_GIFT_ENABLED = mysteryGiftEnabled();

// ---------------------------------------------------------------- reading the world

export function loadGodConfig(ctx: AgentContext) {
  const description = ctx.world.worldDescription();
  if (!description.godPersona) {
    return null;
  }
  return {
    persona: description.godPersona,
    hiddenRules: description.godHiddenRules ?? '',
    worldRules: description.worldRules,
    maxTranscriptTurns: description.maxTranscriptTurns ?? 40,
    gateEnabled: description.godGateEnabled ?? true,
  };
}

/**
 * The state writes the god has not yet looked at, and the transcript that conditions it.
 *
 * The watermark is the highest `throughInputNumber` any past batch recorded, so a batch is never
 * judged twice even if the transcript is later compacted.
 */
export async function loadGodBatch(ctx: AgentContext, maxTranscriptTurns: number) {
  const transcript = await ctx.store.godTranscript(maxTranscriptTurns);
  const watermark = transcript.reduce(
    (max, row) => Math.max(max, row.throughInputNumber ?? -1),
    -1,
  );
  const audits = await ctx.store.auditsAfter(watermark);
  // The god judges against the right variant of the contract only if it is told which one
  // applies. Anything with a player id is tier (a); everything else declares its kind.
  const events = [];
  // Common knowledge is written through the same audit path as an entity's state, so without
  // this filter the god's own write would come back as evidence in its next batch — a document
  // with no `entityDescriptions` row, labelled a prop by the fallback below, judged against a
  // contract it was never written to, and rewritten. It is the god's output, not its input.
  for (const audit of audits.filter((a) => a.field === 'state' && a.entityId !== WORLD_STATE_ID)) {
    events.push({
      entityId: audit.entityId,
      tier: audit.entityId.startsWith('p:')
        ? ('actor' as const)
        : (ctx.world.entityDescription(audit.entityId)?.kind ?? ('prop' as const)),
      inputNumber: audit.inputNumber,
      reason: audit.reason,
      state: audit.after,
      source: audit.source,
    });
  }
  const worldState = await ctx.store.readEntityState(WORLD_STATE_ID);
  return {
    worldState,
    events: events.sort((a, b) => a.inputNumber - b.inputNumber),
    transcript: transcript.reverse().map((row) => ({ role: row.role, content: row.content })),
    seq: transcript.length ? Math.max(...transcript.map((r) => r.seq)) : 0,
  };
}

export async function loadEntityStates(ctx: AgentContext, entityIds: string[]) {
  const states: Record<string, string> = {};
  for (const entityId of entityIds) {
    const state = await ctx.store.readEntityState(entityId);
    if (state) {
      states[entityId] = state;
    }
  }
  return states;
}

// ---------------------------------------------------------------- the loop

export async function godStep(ctx: AgentContext) {
  const config = loadGodConfig(ctx);
  if (!config) {
    return;
  }
  const batch = await loadGodBatch(ctx, config.maxTranscriptTurns);
  if (batch.events.length === 0) {
    return;
  }

  const batchId = crypto.randomUUID();
  const through = Math.max(...batch.events.map((event) => event.inputNumber));
  const summary = renderBatch(batch.events);
  // The god never joins a conversation's trace. It judges what several exchanges left behind,
  // so attaching it to any one of them would be a lie about what it looked at -- and its cost
  // is a signal in its own right, which is easier to read when it is not buried in a dialogue.
  const tracer = await Tracer.standalone({
    worldId: ctx.world.worldId,
    key: `god:${ctx.world.worldId}:${batchId}`,
    name: 'god',
    tags: ['god'],
    metadata: { batchId, throughInputNumber: through, events: batch.events.length },
  });
  // The formed batch is recorded before it is judged, so a verdict can always be traced to
  // exactly the evidence that produced it (docs/05 §7.4).
  await ctx.store.appendGodTranscript({
    role: 'event',
    content: summary,
    batchId,
    throughInputNumber: through,
  });

  // Stage one, the gate. Which kind of model answers it is the server's setting
  // (`GOD_GATE_DECIDER`, docs/14 §3.2); the verdict has the same shape either way.
  let gate: GateVerdict = { intervene: true, why: 'The gate is disabled for this world.' };
  // Which documents stage two should be shown. Only the Jev gate can say: a chat gate returns one
  // boolean for the whole batch, so under it this stays undefined and stage two sees everything,
  // exactly as before.
  let flagged: string[] | undefined;
  let gateProblems: string[] = [];
  // Which decider answered, for the trace (docs/12 §2): the two are only comparable if a run is
  // never ambiguous about which one it was. Known only once the gate has run.
  let gateBy: 'llm' | 'jev' | undefined;
  // MYSTERY GIFT: the probe needs stage two on every batch, and the gate exists to skip stage
  // two on most of them. While the probe is on it stands down, and the hit rate it reports is
  // meaningless for the duration -- which is the honest reason to keep the probe short-lived.
  if (MYSTERY_GIFT_ENABLED) {
    gate = { intervene: true, why: 'The mystery-gift probe is on; the gate stood down.' };
  } else if (config.gateEnabled) {
    const { result, provider } = await runPurpose(
      'god.gate',
      {
        persona: config.persona,
        worldState: batch.worldState,
        documents: batch.events.map(({ entityId, tier, reason, state }) => ({
          entityId,
          tier,
          reason,
          state,
        })),
      },
      tracer.generation('god.gate'),
    );
    gate = { intervene: result.intervene, why: result.why };
    flagged = result.flagged;
    gateProblems = result.problems;
    gateBy = deciderOf(provider);
  }
  const gateTags = gateBy ? [`gate:${gateBy}`] : [];

  if (!gate.intervene) {
    await ctx.store.appendGodTranscript({
      role: 'verdict',
      content: `No intervention. ${gate.why}`,
      batchId,
      throughInputNumber: through,
    });
    // The common path, and the one whose cost the gate exists to keep small. Close here so it
    // still shows up as a trace -- a god that mostly declines to act is only legible if the
    // declining is recorded too.
    await tracer.close({
      input: summary,
      output: gate,
      tags: gateTags,
      metadata: {
        intervened: false,
        gateEnabled: config.gateEnabled,
        gate: gateBy ?? 'none',
        ...(gateProblems.length ? { gateProblems } : {}),
      },
    });
    return;
  }

  // Stage two: full transcript, current states, the rule. Only reached when the gate fires.
  //
  // `entityIds` is what the god may write to -- the whole batch, unchanged (docs/05 §7.6). `focus`
  // is what it is shown. They are deliberately different: narrowing the batch to what the Jev gate
  // flagged would turn a gate false negative into a document nothing can ever fix, whereas
  // narrowing only the evidence makes the expensive call smaller and leaves the scope rule alone.
  // When only common knowledge is stale, `focus` is empty and no document is sent at all.
  const entityIds = [...new Set(batch.events.map((event) => event.entityId))];
  const focus = flagged ?? entityIds;
  const states = await loadEntityStates(ctx, focus);
  const { result: verdict } = await runPurpose(
    'god.intervention',
    {
      persona: config.persona,
      transcript: batch.transcript,
      gateWhy: gate.why,
      focus: focus.map((entityId) => ({ entityId, state: states[entityId] })),
      legalIds: entityIds,
      worldState: batch.worldState,
      mysteryGift: MYSTERY_GIFT_ENABLED,
    },
    tracer.generation('god.intervention', {
      entityIds: focus,
      gateReason: gate.why,
      // MYSTERY GIFT: without this the probe's runs are indistinguishable from real ones.
      ...(MYSTERY_GIFT_ENABLED ? { mysteryGift: true } : {}),
    }),
  );

  const { writes, world, problems } = verdict;
  if (writes.length === 0 && !world) {
    await ctx.store.appendGodTranscript({
      role: 'verdict',
      content: `Gate fired but the intervention changed nothing. ${problems.join('; ')}`,
      batchId,
      throughInputNumber: through,
    });
    // A gate that fired for nothing is the expensive miss, so it is flagged rather than merely
    // recorded -- that is the hit rate the gate is supposed to be judged on.
    await tracer.close({
      input: summary,
      output: { gate, writes, world, problems },
      tags: gateTags,
      metadata: {
        intervened: true,
        writes: 0,
        worldState: false,
        problems,
        gate: gateBy ?? 'none',
        ...(gateProblems.length ? { gateProblems } : {}),
      },
      level: 'ERROR',
      statusMessage: `Gate fired but changed nothing. ${problems.join('; ')}`,
    });
    return;
  }

  await ctx.inputs.send('godVerdict', { batchId, writes, ...(world ? { world } : {}) });
  // The transcript says which of the god's two jobs this verdict did, because the next call
  // reads it back as context and "rewrote nothing, updated common knowledge" is a different
  // thing to have done than "rewrote three documents".
  const did = [
    writes.length > 0 ? `Rewrote ${writes.map((w) => w.entityId).join(', ')}.` : undefined,
    world ? `Updated common knowledge: ${world.reason}` : undefined,
  ].filter(Boolean);
  await ctx.store.appendGodTranscript({
    role: 'verdict',
    content: `${did.join(' ')} ${gate.why}`,
    batchId,
    throughInputNumber: through,
  });
  await tracer.close({
    input: summary,
    output: { gate, writes, world },
    tags: gateTags,
    metadata: {
      intervened: true,
      writes: writes.length,
      worldState: !!world,
      gate: gateBy ?? 'none',
      ...(gateProblems.length ? { gateProblems } : {}),
    },
  });
}

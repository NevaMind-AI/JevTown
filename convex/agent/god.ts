import { v } from 'convex/values';
import { Id } from '../_generated/dataModel';
import { ActionCtx, internalAction, internalMutation, internalQuery } from '../_generated/server';
import { api, internal } from '../_generated/api';
import { chatCompletion } from '../util/llm';
import { extractJsonObject } from '../../engine/prose/envelope';
import {
  BOTH_TIERS_STATE_CONTRACT,
  COMMON_KNOWLEDGE_CONTRACT,
  COMMON_KNOWLEDGE_ID,
} from '../../engine/prose/contract';
import { readEntityState } from '../prose/store';
import { Tracer } from './tracing';

/**
 * The overseer of docs/05 §7. Invisible, never rendered, no position, no entry in
 * `world.players` — a Convex action plus two tables.
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

const selfInternal = internal.agent.god;

/**
 * The placeholder rule (docs/08 §7 D7).
 *
 * Deliberately free of example nouns. The first live run had "a door, a board, a well" here, and
 * the god duly stripped the intention section out of the Voice in the Well — which is a fixed
 * *actor*, tier (b), and is supposed to have one. The rule was wrong, the god applied it
 * correctly, and the lesson generalises: an example in a rule is a rule, and it will be followed
 * over the abstraction it was meant to illustrate.
 *
 * The distinction is capability, and the batch now says which each entity is, so the god never
 * has to infer it from a name.
 */
const FORMAT_RULE = `${BOTH_TIERS_STATE_CONTRACT}

Each document below is labelled with which kind of entity wrote it. Judge it against that
variant, and never against the other one.`;

/**
 * The god's second job (docs/05 §5.3): keeping the world's common knowledge current.
 *
 * It is stated to the gate as well as to the intervention, because otherwise common knowledge
 * would only ever be revisited on the batches where a *document* broke the format rule — two
 * unrelated things sharing one trigger, and the rarer one deciding for both. The gate stays one
 * cheap call with no transcript; it just now has two reasons to fire instead of one, and its `why`
 * says which.
 */
const COMMON_KNOWLEDGE_RULE = `${COMMON_KNOWLEDGE_CONTRACT}

You are the only writer of this document. Nobody else can add to it and nothing else keeps it
current, so if something has become true that everyone should know and it is not written there,
only you can put it there.`;

// ======================================================================================
// TEMPORARY PROBE — the mystery gift. Delete this block and the three call sites marked
// `MYSTERY GIFT` in `godStep` to remove it entirely; nothing else references it.
// ======================================================================================

/**
 * Off unless the Convex env var `GOD_MYSTERY_GIFT` is `1`, so turning the probe on or off is
 * `npx convex env set GOD_MYSTERY_GIFT 1` (and `... 0` to stop) rather than a redeploy.
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
export const MYSTERY_GIFT_ENABLED = process.env.GOD_MYSTERY_GIFT === '1';

/** The item line the god must produce, exactly as `SHARED_RULES` spells items. */
export const MYSTERY_GIFT_NAME = 'a mystery gift';

export const MYSTERY_GIFT_INSTRUCTION = `One more thing, and it applies whether or not any document breaks the rule.

Choose exactly ONE entity from the batch — one, however many are listed — and give it a mystery
gift. In that one entity's document:

- If it already has an <items> block with a "${MYSTERY_GIFT_NAME}" line, add exactly one to that
  line's count and change nothing else about the block.
- If it has an <items> block without that line, add the line \`"${MYSTERY_GIFT_NAME}" = 1\` to it.
- If it has no <items> block at all, add one at the very end of the document — below the tag if
  there is one — holding only that one line.

Change nothing else in that document — not the state line, not the paragraph, not the intention.
Do not mention the gift in the paragraph: it is not something the entity has noticed. Do not give
a gift to any other entity in the batch.

Return that entity in "writes" like any other, with its full document and the reason
"${MYSTERY_GIFT_NAME}". If you are also fixing documents that break the rule, return those too; if
one of them is the entity you chose, one write carries both changes.`;

// ---------------------------------------------------------------- reading the world

export const loadGodConfig = internalQuery({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const description = await ctx.db
      .query('worldDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    if (!description?.godPersona) {
      return null;
    }
    return {
      persona: description.godPersona,
      hiddenRules: description.godHiddenRules ?? '',
      worldRules: description.worldRules,
      maxTranscriptTurns: description.maxTranscriptTurns ?? 40,
      gateEnabled: description.godGateEnabled ?? true,
    };
  },
});

/**
 * The state writes the god has not yet looked at, and the transcript that conditions it.
 *
 * The watermark is the highest `throughInputNumber` any past batch recorded, so a batch is never
 * judged twice even if the transcript is later compacted.
 */
export const loadGodBatch = internalQuery({
  args: { worldId: v.id('worlds'), maxTranscriptTurns: v.number() },
  handler: async (ctx, args) => {
    const transcript = await ctx.db
      .query('godTranscript')
      .withIndex('bySeq', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(args.maxTranscriptTurns);
    const watermark = transcript.reduce(
      (max, row) => Math.max(max, row.throughInputNumber ?? -1),
      -1,
    );
    const audits = await ctx.db
      .query('stateAudit')
      .withIndex('byInput', (q) => q.eq('worldId', args.worldId).gt('inputNumber', watermark))
      .collect();
    // The god judges against the right variant of the contract only if it is told which one
    // applies. Anything with a player id is tier (a); everything else declares its kind.
    const entityDescriptions = await ctx.db
      .query('entityDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    const kinds = new Map(entityDescriptions.map((d) => [d.entityId, d.kind]));
    const events = [];
    // Common knowledge is written through the same audit path as an entity's state, so without
    // this filter the god's own write would come back as evidence in its next batch — a document
    // with no `entityDescriptions` row, labelled a prop by the fallback below, judged against a
    // contract it was never written to, and rewritten. It is the god's output, not its input.
    for (const audit of audits.filter(
      (a) => a.field === 'state' && a.entityId !== COMMON_KNOWLEDGE_ID,
    )) {
      events.push({
        entityId: audit.entityId,
        tier: audit.entityId.startsWith('p:')
          ? ('actor' as const)
          : (kinds.get(audit.entityId) ?? ('prop' as const)),
        inputNumber: audit.inputNumber,
        reason: audit.reason,
        state: audit.after,
        source: audit.source,
      });
    }
    const commonKnowledge = await readEntityState(ctx.db, args.worldId, COMMON_KNOWLEDGE_ID);
    return {
      commonKnowledge,
      events: events.sort((a, b) => a.inputNumber - b.inputNumber),
      transcript: transcript.reverse().map((row) => ({ role: row.role, content: row.content })),
      seq: transcript.length ? Math.max(...transcript.map((r) => r.seq)) : 0,
    };
  },
});

export const loadEntityStates = internalQuery({
  args: { worldId: v.id('worlds'), entityIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const states: Record<string, string> = {};
    for (const entityId of args.entityIds) {
      const state = await readEntityState(ctx.db, args.worldId, entityId);
      if (state) {
        states[entityId] = state;
      }
    }
    return states;
  },
});

export const appendTranscript = internalMutation({
  args: {
    worldId: v.id('worlds'),
    role: v.union(v.literal('event'), v.literal('verdict')),
    content: v.string(),
    batchId: v.optional(v.string()),
    inputNumber: v.optional(v.number()),
    throughInputNumber: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query('godTranscript')
      .withIndex('bySeq', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .first();
    await ctx.db.insert('godTranscript', { ...args, seq: (latest?.seq ?? 0) + 1 });
  },
});

// ---------------------------------------------------------------- the two stages

export interface GateVerdict {
  intervene: boolean;
  why: string;
}

/** Never throws. A gate that cannot be read does not intervene — the safe direction. */
export function parseGate(raw: string): GateVerdict {
  const value = extractJsonObject(raw);
  if (typeof value !== 'object' || value === null) {
    return { intervene: false, why: 'The gate returned nothing readable.' };
  }
  const object = value as Record<string, unknown>;
  return {
    intervene: object.intervene === true,
    why: typeof object.why === 'string' ? object.why : '',
  };
}

/**
 * One labelled block per write, separated by a rule.
 *
 * The state document is fenced rather than run on from the labels. Both the labels and the
 * document are prose, and without a delimiter the god has to guess where one ends and the other
 * begins — a document whose first line reads like a label is exactly the case the gate should be
 * judging, not tripping over.
 */
export function renderBatch(
  events: { entityId: string; tier: 'actor' | 'prop'; reason: string; state: string }[],
): string {
  return events
    .map((event) =>
      [
        `[${event.entityId}]`,
        `Kind: ${event.tier === 'actor' ? 'an entity that acts' : 'an entity that does not act'}`,
        `Reason for the write: ${event.reason}`,
        'Current state:',
        '```',
        event.state,
        '```',
      ].join('\n'),
    )
    .join('\n\n---\n\n');
}

export interface GodWrite {
  entityId: string;
  state?: string;
  reason: string;
}

export interface CommonKnowledgeWrite {
  state: string;
  reason: string;
}

export function parseVerdict(
  raw: string,
  legalIds: Set<string>,
): {
  writes: GodWrite[];
  world?: CommonKnowledgeWrite;
  problems: string[];
} {
  const problems: string[] = [];
  const value = extractJsonObject(raw);
  if (typeof value !== 'object' || value === null) {
    return { writes: [], problems: ['no JSON object found'] };
  }
  // docs/05 §5.3. Read before `writes` is validated, because the two are independent: a verdict
  // that only updates common knowledge is a real verdict, and a malformed `writes` must not
  // discard it.
  const world = parseCommonKnowledgeWrite((value as Record<string, unknown>).world, problems);
  const writesValue = (value as Record<string, unknown>).writes;
  if (!Array.isArray(writesValue)) {
    return { writes: [], world, problems: [...problems, 'writes is not an array'] };
  }
  const writes: GodWrite[] = [];
  for (const entry of writesValue) {
    if (typeof entry !== 'object' || entry === null) {
      problems.push('dropped a write that was not an object');
      continue;
    }
    const write = entry as Record<string, unknown>;
    const entityId = typeof write.entityId === 'string' ? write.entityId : undefined;
    if (!entityId || !legalIds.has(entityId)) {
      // The god may only touch what was in its own batch. It is the largest threat to
      // debuggability in this design (docs/05 §7.6); it does not also get to reach sideways.
      problems.push(`dropped a write to "${String(write.entityId)}", which was not in the batch`);
      continue;
    }
    const reason = typeof write.reason === 'string' ? write.reason : '';
    if (!reason) {
      problems.push(`write to ${entityId} has no reason`);
    }
    writes.push({
      entityId,
      state: typeof write.state === 'string' && write.state.trim() !== '' ? write.state : undefined,
      reason: reason || 'The god gave no reason.',
    });
  }
  return { writes, world, problems };
}

/**
 * The common-knowledge half of a verdict, which is scoped by the contract rather than by a batch.
 *
 * `legalIds` has no counterpart here: the god may only rewrite entities that were in its own batch
 * (docs/05 §7.6), but common knowledge is a single document with one writer, so there is nothing
 * to scope it against. What bounds it is the scope rule in the contract, and that is a prompt
 * rule, not something this can check.
 */
function parseCommonKnowledgeWrite(
  value: unknown,
  problems: string[],
): CommonKnowledgeWrite | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object') {
    problems.push('dropped a common-knowledge write that was not an object');
    return undefined;
  }
  const write = value as Record<string, unknown>;
  const state = typeof write.state === 'string' ? write.state.trim() : '';
  if (!state) {
    problems.push('dropped a common-knowledge write with no state');
    return undefined;
  }
  const reason = typeof write.reason === 'string' ? write.reason : '';
  if (!reason) {
    problems.push('the common-knowledge write has no reason');
  }
  return { state, reason: reason || 'The god gave no reason.' };
}

// ---------------------------------------------------------------- the loop

export const godStep = internalAction({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    const config = await ctx.runQuery(selfInternal.loadGodConfig, { worldId: args.worldId });
    if (!config) {
      return;
    }
    const batch = await ctx.runQuery(selfInternal.loadGodBatch, {
      worldId: args.worldId,
      maxTranscriptTurns: config.maxTranscriptTurns,
    });
    if (batch.events.length === 0) {
      return;
    }

    const batchId = crypto.randomUUID();
    const through = Math.max(...batch.events.map((event) => event.inputNumber));
    const summary = renderBatch(batch.events);
    // docs/05 §5.3. Both stages see the current document: the gate so it can notice the world has
    // moved past what is written there, the intervention so it rewrites rather than reinvents.
    const commonKnowledgeNow = [
      'What everyone in this world currently knows, as it is written now:',
      batch.commonKnowledge?.trim()
        ? batch.commonKnowledge
        : '(nothing has been written there yet)',
    ].join('\n');
    // The god never joins a conversation's trace. It judges what several exchanges left behind,
    // so attaching it to any one of them would be a lie about what it looked at -- and its cost
    // is a signal in its own right, which is easier to read when it is not buried in a dialogue.
    const tracer = await Tracer.standalone({
      worldId: args.worldId,
      key: `god:${args.worldId}:${batchId}`,
      name: 'god',
      tags: ['god'],
      metadata: { batchId, throughInputNumber: through, events: batch.events.length },
    });
    // The formed batch is recorded before it is judged, so a verdict can always be traced to
    // exactly the evidence that produced it (docs/05 §7.4).
    await ctx.runMutation(selfInternal.appendTranscript, {
      worldId: args.worldId,
      role: 'event',
      content: summary,
      batchId,
      throughInputNumber: through,
    });

    // Stage one: small prompt, the batch summary only, no transcript. This is what makes the god
    // affordable, and it is why it exists in the first version rather than as an optimisation
    // (docs/05 §7.5).
    let gate: GateVerdict = { intervene: true, why: 'The gate is disabled for this world.' };
    // MYSTERY GIFT: the probe needs stage two on every batch, and the gate exists to skip stage
    // two on most of them. While the probe is on it stands down, and the hit rate it reports is
    // meaningless for the duration -- which is the honest reason to keep the probe short-lived.
    if (MYSTERY_GIFT_ENABLED) {
      gate = { intervene: true, why: 'The mystery-gift probe is on; the gate stood down.' };
    } else if (config.gateEnabled) {
      const { content } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: [
              config.persona,
              '',
              'You are checking two things about what just happened in this world.',
              '',
              'One: whether these state documents follow the rule below.',
              '',
              FORMAT_RULE,
              '',
              'Two: whether anything in them has become true that everyone in this world should',
              'know, and is not written in the common knowledge below yet.',
              '',
              COMMON_KNOWLEDGE_RULE,
              '',
              'Reply with one JSON object: { "intervene": true|false, "why": "<one sentence>" }.',
              'Say true if a document breaks the rule badly enough that it should be rewritten, or',
              'if common knowledge needs updating. Say which of the two in "why".',
            ].join('\n'),
          },
          { role: 'user', content: `${summary}\n\n---\n\n${commonKnowledgeNow}` },
        ],
        max_tokens: 200,
        trace: tracer.generation('god.gate'),
      });
      gate = parseGate(content);
    }

    if (!gate.intervene) {
      await ctx.runMutation(selfInternal.appendTranscript, {
        worldId: args.worldId,
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
        metadata: { intervened: false, gateEnabled: config.gateEnabled },
      });
      return;
    }

    // Stage two: full transcript, current states, the rule. Only reached when the gate fires.
    const entityIds = [...new Set(batch.events.map((event) => event.entityId))];
    const states = await ctx.runQuery(selfInternal.loadEntityStates, {
      worldId: args.worldId,
      entityIds,
    });
    const { content } = await chatCompletion({
      messages: [
        {
          role: 'system',
          content: [
            config.persona,
            '',
            FORMAT_RULE,
            '',
            COMMON_KNOWLEDGE_RULE,
            '',
            'Rewrite only the documents that break the rule. Leave the meaning alone — you are',
            'fixing the shape, not the story. Separately, rewrite common knowledge only if',
            'something everyone should know has become true and is missing from it; write the',
            'whole document out, not a diff, and leave it out entirely if it is already correct.',
            'Reply with one JSON object:',
            '{ "writes": [ { "entityId": "...", "state": "<the corrected document>", "reason": "<one sentence>" } ],',
            '  "world": { "state": "<the whole common-knowledge document>", "reason": "<one sentence>" } }',
            // MYSTERY GIFT: the probe always writes, so the escape hatch would contradict it.
            ...(MYSTERY_GIFT_ENABLED
              ? ['', MYSTERY_GIFT_INSTRUCTION]
              : [
                  'Return an empty writes array and no "world" if nothing needs changing after all.',
                ]),
          ].join('\n'),
        },
        ...batch.transcript.map((row) => ({
          role: 'user' as const,
          content: `[${row.role}] ${row.content}`,
        })),
        {
          role: 'user',
          content: [
            `The gate flagged this: ${gate.why}`,
            '',
            'Current state of the entities involved:',
            ...entityIds.map((id) => `[${id}]\n${states[id] ?? '(none)'}`),
            '',
            commonKnowledgeNow,
          ].join('\n'),
        },
      ],
      max_tokens: 1500,
      trace: tracer.generation('god.intervention', {
        entityIds,
        gateReason: gate.why,
        // MYSTERY GIFT: without this the probe's runs are indistinguishable from real ones.
        ...(MYSTERY_GIFT_ENABLED ? { mysteryGift: true } : {}),
      }),
    });

    const { writes, world, problems } = parseVerdict(content, new Set(entityIds));
    if (writes.length === 0 && !world) {
      await ctx.runMutation(selfInternal.appendTranscript, {
        worldId: args.worldId,
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
        metadata: { intervened: true, writes: 0, commonKnowledge: false, problems },
        level: 'ERROR',
        statusMessage: `Gate fired but changed nothing. ${problems.join('; ')}`,
      });
      return;
    }

    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'godVerdict',
      args: { batchId, writes, ...(world ? { world } : {}) },
    });
    // The transcript says which of the god's two jobs this verdict did, because the next call
    // reads it back as context and "rewrote nothing, updated common knowledge" is a different
    // thing to have done than "rewrote three documents".
    const did = [
      writes.length > 0 ? `Rewrote ${writes.map((w) => w.entityId).join(', ')}.` : undefined,
      world ? `Updated common knowledge: ${world.reason}` : undefined,
    ].filter(Boolean);
    await ctx.runMutation(selfInternal.appendTranscript, {
      worldId: args.worldId,
      role: 'verdict',
      content: `${did.join(' ')} ${gate.why}`,
      batchId,
      throughInputNumber: through,
    });
    await tracer.close({
      input: summary,
      output: { gate, writes, world },
      metadata: { intervened: true, writes: writes.length, commonKnowledge: !!world },
    });
  },
});

/**
 * Serial by construction — one transcript, one queue (docs/05 §7.5). The cron drives one step per
 * world per interval rather than reacting to each write, which is what keeps the god from being
 * in the path of every state update.
 */
export const godTick = internalAction({
  args: {},
  handler: async (ctx: ActionCtx) => {
    const worlds: Id<'worlds'>[] = await ctx.runQuery(internal.agent.god.runningWorlds, {});
    for (const worldId of worlds) {
      await ctx.runAction(selfInternal.godStep, { worldId });
    }
  },
});

export const runningWorlds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const statuses = await ctx.db
      .query('worldStatus')
      .filter((q) => q.eq(q.field('status'), 'running'))
      .collect();
    return statuses.map((status) => status.worldId);
  },
});

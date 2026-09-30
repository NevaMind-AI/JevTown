import { BOTH_TIERS_STATE_CONTRACT, WORLD_STATE_CONTRACT } from '../../engine/prose/contract.ts';
import { extractJsonObject } from '../../engine/prose/envelope.ts';
import { gateFromAnswers, jevGateRequest, type GateDocument } from './gateJev.ts';
import { NAME_CHARS, PROSE_CHARS } from './sections.ts';
import { isRecord, list, optionalText, text, type Purpose } from './types.ts';

/**
 * The god's two model calls (docs/05 §7): the stage-one gate and the stage-two intervention.
 *
 * The rules, the prompts and the readers of both answers moved here from `agent/god.ts` so the
 * server can render and read them (docs/14 §3.2). What the god looks at, and what it does with a
 * verdict, stays there. The gate has two variants, a chat gate and a System One gate
 * (`./gateJev.ts`), and the server setting `GOD_GATE_DECIDER` picks one.
 */

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
const WORLD_STATE_RULE = `${WORLD_STATE_CONTRACT}

You are not the only writer of this document; the people in this world write to it too, and the
record blocks are usually theirs. What you write is merged into what is already there, so write
only what you are changing: the paragraph when something has become true that everyone should know
and it is not written there, and a record line when you know that line is wrong. Everything you
leave out keeps standing on its own.`;

// MYSTERY GIFT: the probe's text (see `agent/god.ts`, where it is switched on).

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

// ---------------------------------------------------------------- the purposes

/** docs/05 §5.3. Both stages see the current document, stated even when it is empty. */
export function worldStateNow(worldState: string | undefined): string {
  return [
    "The world's state, as it is written now:",
    worldState?.trim() ? worldState : '(nothing has been written there yet)',
  ].join('\n');
}

// A batch's documents and the god's transcript are whole state documents, so the bounds are
// generous; what really bounds them is the request body limit.
const MAX_DOCUMENTS = 256;
const MAX_TRANSCRIPT_ROWS = 400;
const ROW_CHARS = 200_000;
const WHY_CHARS = 4_000;

const documents = (value: unknown) =>
  list(value, 'documents', MAX_DOCUMENTS, (entry, what): GateDocument => {
    if (!isRecord(entry) || (entry.tier !== 'actor' && entry.tier !== 'prop')) {
      throw new Error(`${what} needs a tier of actor or prop`);
    }
    return {
      entityId: text(entry.entityId, `${what}.entityId`, NAME_CHARS),
      tier: entry.tier,
      reason: text(entry.reason, `${what}.reason`, WHY_CHARS),
      state: text(entry.state, `${what}.state`, PROSE_CHARS),
    };
  });

export interface GateVars {
  persona: string;
  worldState?: string;
  documents: GateDocument[];
}

/**
 * What either gate answers, in one shape. `flagged` is present only when the gate can name the
 * documents that broke (the System One gate); stage two then sees only those.
 */
export interface GateResult extends GateVerdict {
  flagged?: string[];
  problems: string[];
}

export const godGate: Purpose<GateVars, GateResult> = {
  setting: 'GOD_GATE_DECIDER',
  vars(input) {
    if (!isRecord(input)) throw new Error('vars must be an object');
    const vars: GateVars = {
      persona: text(input.persona, 'persona', PROSE_CHARS),
      documents: documents(input.documents),
    };
    const worldState = optionalText(input.worldState, 'worldState', PROSE_CHARS);
    if (worldState !== undefined) vars.worldState = worldState;
    return vars;
  },
  variants: {
    // Stage one: small prompt, the batch summary only, no transcript. This is what makes the god
    // affordable, and it is why it exists in the first version rather than as an optimisation
    // (docs/05 §7.5).
    chat: {
      kind: 'chat',
      render: ({ persona, worldState, documents }) => ({
        messages: [
          {
            role: 'system',
            content: [
              persona,
              '',
              'You are checking two things about what just happened in this world.',
              '',
              'One: whether these state documents follow the rule below.',
              '',
              FORMAT_RULE,
              '',
              'Two: whether anything in them has become true that everyone in this world should',
              "know, and is not written in the world's paragraph below yet — or whether a line in",
              'its record blocks is now wrong.',
              '',
              WORLD_STATE_RULE,
              '',
              'Reply with one JSON object: { "intervene": true|false, "why": "<one sentence>" }.',
              'Say true if a document breaks the rule badly enough that it should be rewritten, or',
              'if the world state needs updating. Say which of the two in "why".',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `${renderBatch(documents)}\n\n---\n\n${worldStateNow(worldState)}`,
          },
        ],
        max_tokens: 200,
      }),
      parse: (content) => ({ ...parseGate(content), problems: [] }),
    },
    // The typed gate of docs/12 §11. Same evidence, same verdict out -- what differs is that there
    // is no JSON to dig out of prose, the two questions no longer share one boolean, and the
    // answer names the documents rather than describing them.
    systemone: {
      kind: 'systemone',
      render: (vars) => {
        const { state, questions } = jevGateRequest(vars);
        return { state, questions };
      },
      parse: (answers, vars) => {
        const reading = gateFromAnswers(answers, jevGateRequest(vars));
        return {
          intervene: reading.intervene,
          why: reading.why,
          flagged: reading.flagged,
          problems: reading.problems,
        };
      },
    },
  },
};

export interface InterventionVars {
  persona: string;
  /** The god's transcript, oldest first, as `loadGodBatch` reads it back. */
  transcript: { role: string; content: string }[];
  /** Why the gate fired. */
  gateWhy: string;
  /** The documents stage two is shown, with their current state where there is one. */
  focus: { entityId: string; state?: string }[];
  /** Everything in the batch: what the god may write to (docs/05 §7.6). */
  legalIds: string[];
  worldState?: string;
  /** The temporary probe of docs/08 §7 D7. */
  mysteryGift: boolean;
}

export type InterventionResult = ReturnType<typeof parseVerdict>;

/** Stage two: full transcript, current states, the rule. Only reached when the gate fires. */
export const godIntervention: Purpose<InterventionVars, InterventionResult> = {
  vars(input) {
    if (!isRecord(input)) throw new Error('vars must be an object');
    const vars: InterventionVars = {
      persona: text(input.persona, 'persona', PROSE_CHARS),
      transcript: list(input.transcript, 'transcript', MAX_TRANSCRIPT_ROWS, (row, what) => {
        if (!isRecord(row)) throw new Error(`${what} must be an object`);
        return {
          role: text(row.role, `${what}.role`, NAME_CHARS),
          content: text(row.content, `${what}.content`, ROW_CHARS),
        };
      }),
      gateWhy: text(input.gateWhy, 'gateWhy', WHY_CHARS),
      focus: list(input.focus, 'focus', MAX_DOCUMENTS, (entry, what) => {
        if (!isRecord(entry)) throw new Error(`${what} must be an object`);
        const state = optionalText(entry.state, `${what}.state`, PROSE_CHARS);
        return {
          entityId: text(entry.entityId, `${what}.entityId`, NAME_CHARS),
          ...(state !== undefined ? { state } : {}),
        };
      }),
      legalIds: list(input.legalIds, 'legalIds', MAX_DOCUMENTS, (id, what) =>
        text(id, what, NAME_CHARS),
      ),
      mysteryGift: input.mysteryGift === true,
    };
    const worldState = optionalText(input.worldState, 'worldState', PROSE_CHARS);
    if (worldState !== undefined) vars.worldState = worldState;
    return vars;
  },
  variants: {
    chat: {
      kind: 'chat',
      render: ({ persona, transcript, gateWhy, focus, worldState, mysteryGift }) => ({
        messages: [
          {
            role: 'system',
            content: [
              persona,
              '',
              FORMAT_RULE,
              '',
              WORLD_STATE_RULE,
              '',
              'Rewrite only the documents that break the rule. Leave the meaning alone — you are',
              "fixing the shape, not the story. Separately, change the world's state only if",
              'something everyone should know has become true and is missing from its paragraph, or a',
              'line in its record blocks is wrong. Send only the parts you are changing — the whole',
              'paragraph if you change it, and only the record lines you are correcting — and leave',
              '"world" out entirely if nothing there needs changing.',
              'Reply with one JSON object:',
              '{ "writes": [ { "entityId": "...", "state": "<the corrected document>", "reason": "<one sentence>" } ],',
              '  "world": { "state": "<only the parts of the world state you are changing>", "reason": "<one sentence>" } }',
              // MYSTERY GIFT: the probe always writes, so the escape hatch would contradict it.
              ...(mysteryGift
                ? ['', MYSTERY_GIFT_INSTRUCTION]
                : [
                    'Return an empty writes array and no "world" if nothing needs changing after all.',
                  ]),
            ].join('\n'),
          },
          ...transcript.map((row) => ({
            role: 'user' as const,
            content: `[${row.role}] ${row.content}`,
          })),
          {
            role: 'user',
            content: [
              `The gate flagged this: ${gateWhy}`,
              '',
              focus.length
                ? 'Current state of the entities involved:'
                : 'No document was flagged; only common knowledge needs attention.',
              ...focus.map((entry) => `[${entry.entityId}]\n${entry.state ?? '(none)'}`),
              '',
              worldStateNow(worldState),
            ].join('\n'),
          },
        ],
        max_tokens: 1500,
      }),
      parse: (content, { legalIds }) => parseVerdict(content, new Set(legalIds)),
    },
  },
};

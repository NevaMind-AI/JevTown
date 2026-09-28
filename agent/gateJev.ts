import { BOTH_TIERS_STATE_CONTRACT, WORLD_STATE_CONTRACT } from '../engine/prose/contract';
import { SystemOneAnswers, SystemOneQuestions } from './model/client';

/**
 * The god's stage-one gate (docs/05 §7.5), asked of a System One model instead of a chat model.
 *
 * Of the four model calls this codebase makes, the gate is the one a System One model fits best —
 * better than the action decision docs/12 was written for. The action decision paid for its typed
 * answer by giving up four prose fields (docs/12 §3); the gate gives up one, `why`, which was
 * already the kind of field docs/12 synthesizes from numbers. Everything else about the gate is a
 * yes/no judgement over evidence, which is the shape a noul has.
 *
 * Three things get better rather than merely cheaper:
 *
 *   - `parseGate`'s failure direction stops being silent. A chat gate that returns something
 *     unreadable does not intervene, which is the safe direction and also indistinguishable from a
 *     god with nothing to do. There is nothing here to parse.
 *   - The two questions stop sharing one boolean. `god.ts` names this as a compromise — two
 *     unrelated things on one trigger, the rarer one deciding for both — and two nouls end it.
 *   - The gate learns *which* documents broke, which the chat gate cannot say. Stage two is then
 *     shown those documents instead of the whole batch, so the fan-out shrinks the expensive call
 *     and not just the cheap one.
 *
 * As in `decideJev.ts`, everything in this file is pure: building the request and reading the
 * answers are separable from making the call, so the whole mapping is testable without a model.
 * The call itself stays in `godStep`, next to the chat call it is an alternative to.
 */

// ---------------------------------------------------------------- policy

/**
 * What the gate's sensitivity used to be: tone in a prompt, and the word "badly" in
 * "breaks the rule badly enough that it should be rewritten". Here it is two numbers.
 *
 * They are separate constants rather than one shared threshold because the two questions have
 * different costs when they are wrong. A false positive on format spends one intervention that
 * rewrites nothing; a false positive on world state rewrites a document everybody reads
 * (`WORLD_STATE_PROSE_RULES`). They will want to move independently, so they start apart.
 */
export const FORMAT_BREAK_THRESHOLD = 0.5;
export const KNOWLEDGE_STALE_THRESHOLD = 0.5;

// ---------------------------------------------------------------- the request

/** One state write the god has not looked at yet — the same shape `renderBatch` takes. */
export interface GateDocument {
  entityId: string;
  tier: 'actor' | 'prop';
  reason: string;
  state: string;
}

export interface JevGateRequest {
  state: Record<string, string>;
  questions: SystemOneQuestions;
  /** Question id → the entity whose document that question judges. Sent to nothing. */
  documents: Record<string, string>;
}

/** The `the_world_right_now` field, which is stated even when it is empty. */
const NOTHING_WRITTEN = '(nothing has been written there yet)';

/**
 * The state field a question points at. Positional, never the entity id.
 *
 * An id is the one thing `decideJev.ts` learned never to put in front of this model: it means
 * nothing, so a model asked to reason about `p:2` is being asked to reason about noise. The
 * question says which field it judges and the tier it judges it against; the mapping back to an
 * entity lives in `documents` and never leaves this process.
 */
function documentKey(index: number): string {
  return `document_${index + 1}`;
}

function kindWords(tier: 'actor' | 'prop'): string {
  return tier === 'actor' ? 'an entity that acts' : 'an entity that does not act';
}

/**
 * One question per document, rather than one noul over the batch.
 *
 * The flat alternative — a single "does anything here break the rule" — is less code and throws
 * away the reason to do this at all. It asks the model to run a per-document check internally and
 * OR the results, over a batch whose documents are judged against *different* variants of the
 * contract, and it returns a number that cannot say which document it was about. The fan-out costs
 * nothing extra: Jev ingests the state once and evaluates every question against it in parallel
 * (docs/12 §5), so the questions cost a few tokens each and no latency.
 */
export function jevGateRequest(args: {
  persona: string;
  worldState: string | undefined;
  documents: GateDocument[];
}): JevGateRequest {
  const state: Record<string, string> = {
    who_you_are: args.persona,
    // `BOTH_TIERS_STATE_CONTRACT` rather than `god.ts`'s `FORMAT_RULE`. The rule is the same one;
    // what is dropped is its trailing paragraph ("each document below is labelled..."), which
    // exists only because the chat gate puts every document in one prompt and has to tell them
    // apart. Here each question judges one document and names its variant, so the paragraph would
    // be instructing the model to do something the request shape already did.
    how_documents_must_be_written: BOTH_TIERS_STATE_CONTRACT,
    what_the_world_state_is_for: WORLD_STATE_CONTRACT,
    the_world_right_now: args.worldState?.trim() ? args.worldState : NOTHING_WRITTEN,
  };

  const questions: SystemOneQuestions = {};
  const documents: Record<string, string> = {};
  args.documents.forEach((document, index) => {
    const key = documentKey(index);
    // The same evidence the chat gate's batch carries, minus the id: what wrote it, why it was
    // written, and the document itself.
    state[key] = [
      `Written by ${kindWords(document.tier)}.`,
      `Reason for the write: ${document.reason}`,
      '',
      document.state,
    ].join('\n');
    const id = `format_${index + 1}`;
    questions[id] = {
      type: 'noul',
      instructions:
        `The document in \`${key}\` was written by ${kindWords(document.tier)}. Judged against ` +
        `that variant of the shape in \`how_documents_must_be_written\`, and never against the ` +
        `other one, it breaks the rule badly enough that it should be rewritten.`,
    };
    documents[id] = document.entityId;
  });

  // One question, two ways to be stale: the paragraph missing something everyone should know, and
  // a record line that is now wrong. They could be asked separately — docs/12 §11's argument
  // against one boolean for two questions applies — but the answer here feeds one decision (send
  // stage two the document), so splitting would buy a measurement nobody reads yet. Split it when
  // the two get different thresholds, which is the same moment they get different costs.
  questions.knowledge = {
    type: 'noul',
    instructions:
      'The world state in `the_world_right_now` is out of date, judged against ' +
      '`what_the_world_state_is_for`: either something in these documents has become true that ' +
      'everyone in this world should know and its paragraph does not say so, or a line in its ' +
      '<tasks> or <player_items> block no longer matches what these documents show.',
  };

  return { state, questions, documents };
}

// ---------------------------------------------------------------- the answers

function noul(answers: SystemOneAnswers, id: string): number | undefined {
  const answer = answers?.[id];
  return answer?.type === 'noul' && typeof answer.noul === 'number' ? answer.noul : undefined;
}

function n(value: number | undefined): string {
  return value === undefined ? '?' : value.toFixed(2);
}

export interface JevGateReading {
  intervene: boolean;
  /** Stands in for the sentence a chat gate writes. Structurally a `GateVerdict['why']`. */
  why: string;
  /** The entities whose documents cleared the threshold, in batch order, deduplicated. */
  flagged: string[];
  knowledgeStale: boolean;
  problems: string[];
}

/**
 * Compose one verdict out of the answers. Never throws.
 *
 * `why` is synthesized from the numbers, the way `decideJev.ts` synthesizes `reason` and for the
 * same reason: there is no prose, and the distribution is more informative than a sentence anyway.
 * It has one consumer the decision's `reason` does not — `godStep` feeds it into stage two, whose
 * prompt asked the gate to "say which of the two in `why`". Two labelled numbers say which more
 * exactly than a sentence picking one of them ever did.
 */
export function gateFromAnswers(
  answers: SystemOneAnswers,
  request: JevGateRequest,
): JevGateReading {
  const problems: string[] = [];
  if (typeof answers !== 'object' || answers === null) {
    // The same direction `parseGate` takes: a gate that cannot be read does not intervene. It
    // should be unreachable — `systemOne` throws on a response without an `answers` object — but
    // the stance is cheap to keep and the alternative is a god that acts on nothing.
    return {
      intervene: false,
      why: 'The gate returned no answers.',
      flagged: [],
      knowledgeStale: false,
      problems: ['no answers'],
    };
  }

  const readings: { entityId: string; noul: number }[] = [];
  for (const [id, entityId] of Object.entries(request.documents)) {
    const value = noul(answers, id);
    if (value === undefined) {
      problems.push(`no readable answer for ${id} (${entityId})`);
      continue;
    }
    readings.push({ entityId, noul: value });
  }

  const broke = readings.filter((reading) => reading.noul >= FORMAT_BREAK_THRESHOLD);
  const flagged = [...new Set(broke.map((reading) => reading.entityId))];

  const knowledge = noul(answers, 'knowledge');
  if (knowledge === undefined) {
    problems.push('no readable answer for knowledge');
  }
  const knowledgeStale = knowledge !== undefined && knowledge >= KNOWLEDGE_STALE_THRESHOLD;

  return {
    intervene: flagged.length > 0 || knowledgeStale,
    why: [documentsWhy(readings, broke), `knowledge ${n(knowledge)}`].join(' · '),
    flagged,
    knowledgeStale,
    problems,
  };
}

/**
 * The document half of `why`.
 *
 * When nothing cleared the threshold the highest number is reported anyway, because that is the
 * one a threshold gets tuned against: "clear (highest 0.47)" and "clear (highest 0.02)" are the
 * difference between a gate that is nearly firing and one that is nowhere near it, and a bare
 * "clear" cannot tell them apart in the transcript afterwards.
 */
function documentsWhy(
  readings: { entityId: string; noul: number }[],
  broke: { entityId: string; noul: number }[],
): string {
  if (readings.length === 0) {
    return 'documents unreadable';
  }
  if (broke.length > 0) {
    return `documents ${broke.map((r) => `${r.entityId} ${n(r.noul)}`).join(', ')}`;
  }
  const highest = readings.reduce((max, r) => (r.noul > max.noul ? r : max));
  return `documents clear (highest ${highest.entityId} ${n(highest.noul)})`;
}

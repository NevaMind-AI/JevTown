import type {
  DecisionManifest,
  ManifestPlace,
  ManifestTarget,
} from '../../engine/aiTown/manifest.ts';
import { decisionSystemPrompt, parseDecision, type Decision } from './decide.ts';
import { decisionFromAnswers, jevDecisionRequest } from './decideJev.ts';
import { NAME_CHARS, PROSE_CHARS, proseContext, type ProseContext } from './sections.ts';
import { isRecord, list, optionalText, text, type Purpose } from './types.ts';

/**
 * What an agent does next (docs/05 §6.4, docs/09 §3-§4), as one purpose with two answers.
 *
 * The chat decider (`./decide.ts`) and the Jev decider (`./decideJev.ts`) take the same manifest
 * and return the same `Decision`, which is what made them comparable behind a flag (docs/12 §1).
 * The flag is the server's now, `ACTION_DECIDER`: the tab asks for a decision and does not choose
 * which kind of model makes it.
 */

export interface DecideVars {
  context: ProseContext;
  manifest: DecisionManifest;
}

export interface DecideResult {
  decision: Decision;
  problems: string[];
}

/** The engine builds the manifest from what is near, so it is short; these are generous. */
const MAX_OPTIONS = 64;
const DISTANCES = new Set(['close', 'nearby', 'far']);

function manifestTarget(value: unknown, what: string): ManifestTarget {
  if (!isRecord(value) || !DISTANCES.has(value.distance as string)) {
    throw new Error(`${what} needs a distance of close, nearby or far`);
  }
  const target: ManifestTarget = {
    id: text(value.id, `${what}.id`, NAME_CHARS),
    name: text(value.name, `${what}.name`, NAME_CHARS),
    what: text(value.what, `${what}.what`, NAME_CHARS),
    distance: value.distance as ManifestTarget['distance'],
  };
  const where = optionalText(value.where, `${what}.where`, NAME_CHARS);
  if (where !== undefined) target.where = where;
  const description = optionalText(value.description, `${what}.description`, PROSE_CHARS);
  if (description !== undefined) target.description = description;
  return target;
}

function manifestPlace(value: unknown, what: string): ManifestPlace {
  if (!isRecord(value)) throw new Error(`${what} must be an object`);
  return {
    id: text(value.id, `${what}.id`, NAME_CHARS),
    description: text(value.description, `${what}.description`, PROSE_CHARS),
  };
}

export const agentDecide: Purpose<DecideVars, DecideResult> = {
  setting: 'ACTION_DECIDER',
  vars(input) {
    if (!isRecord(input) || !isRecord(input.manifest)) {
      throw new Error('vars needs a context and a manifest');
    }
    return {
      context: proseContext(input.context, 'context'),
      manifest: {
        targets: list(input.manifest.targets, 'manifest.targets', MAX_OPTIONS, manifestTarget),
        places: list(input.manifest.places, 'manifest.places', MAX_OPTIONS, manifestPlace),
      },
    };
  },
  variants: {
    chat: {
      kind: 'chat',
      render: ({ context, manifest }) => ({
        messages: [
          { role: 'system', content: decisionSystemPrompt(context, manifest) },
          { role: 'user', content: 'What do you do next?' },
        ],
        max_tokens: 400,
      }),
      parse: (content, { manifest }) => parseDecision(content, manifest),
    },
    // No prose comes back from this one (docs/12 §2): no intent, description, emoji or reason
    // beyond what the numbers say.
    systemone: {
      kind: 'systemone',
      render: ({ context, manifest }) => {
        const { state, questions } = jevDecisionRequest(context, manifest);
        return { state, questions };
      },
      parse: (answers, { context, manifest }) =>
        decisionFromAnswers(answers, jevDecisionRequest(context, manifest)),
    },
  },
};

import { DecisionManifest, ManifestPlace, ManifestTarget } from '../engine/aiTown/manifest';
import { Decision, idleFallback } from './decide';
import { SystemOneAnswers, SystemOneQuestions } from './model/client';
import { PromptContext, describe } from './promptContext';
import { suppressIdleAfter } from './config';

/**
 * The same decision as `decide.ts`, asked of a System One model instead of a chat model.
 *
 * Jev does not generate text. It takes a `state` and a map of typed questions and returns one
 * typed answer per question, each with calibrated probabilities. That is a close fit for what
 * docs/09 §1 already established — **the engine filters the option set; the model chooses within
 * it** — and it closes the gap that principle could not: with a Choice question the answer *is*
 * one of the options the engine sent, so an out-of-manifest target is no longer a failure mode
 * that has to be caught (`decide.ts:37-40`). It cannot be expressed.
 *
 * What it costs is every piece of prose the decision used to carry. Jev writes no `intent`, no
 * `description`, no `emoji` and no `reason`. docs/12 records which of those were dropped, which
 * were enumerated, and what the alternatives were; the short version is that `intent` is gone
 * (docs/12 §2 option c) and `idle` picks between two hard-coded durations rather than naming one
 * (docs/12 §3).
 *
 * The shape here mirrors `decide.ts` deliberately: building the request and reading the answers are
 * separable from making the call, which is what lets the whole mapping be tested without a model —
 * and the call itself stays in `operations.ts`, next to the chat-model call it is an alternative
 * to. The one impurity is the idle duration's jitter, and its source is injectable for that
 * reason.
 */

// ---------------------------------------------------------------- policy

/**
 * The two idle durations, and the descriptions that stand in for the prose the model used to
 * write. `IDLE_SHORT_MS` is centred exactly on `MIN_DECISION_INTERVAL` on purpose: a short idle
 * means "ask me again as soon as you are allowed to", and the engine floor is what "as soon as"
 * means. Each is a centre rather than the duration itself — see the spread below.
 */
export const IDLE_SHORT_MS = 5_000;
export const IDLE_LONG_MS = 30_000;

/**
 * How far either side of the nominal duration the actual one may fall: a short idle is uniform on
 * [4s, 6s] and a long one on [25s, 35s].
 *
 * Two hard-coded durations meant every agent that picked the same option looked again on the same
 * tick, and a room of five idling agents decided in lockstep — visibly so, and a burst of model
 * calls the `MIN_DECISION_INTERVAL` floor spreads no further than one interval. The spread is
 * cosmetic in intent and cheap: the option the model chose still decides which of the two
 * durations it is, and the policy still owns what they mean.
 *
 * A short idle can now come back under `MIN_DECISION_INTERVAL` (docs/12 §4 wanted them equal). The
 * floor is what actually gates the next decision, so a 4s idle means the same thing 5s did — ask
 * again as soon as allowed — and the engine, not this number, still owns "as soon as".
 */
const IDLE_SHORT_SPREAD_MS = 1_000;
const IDLE_LONG_SPREAD_MS = 5_000;

const IDLE_OPTIONS: Record<
  string,
  { durationMs: number; spreadMs: number; description: string; criterion: string }
> = {
  'pause for a moment': {
    durationMs: IDLE_SHORT_MS,
    spreadMs: IDLE_SHORT_SPREAD_MS,
    description: 'pausing',
    criterion: 'Something around you could change within seconds, and you want to see it change.',
  },
  'stay put for a while': {
    durationMs: IDLE_LONG_MS,
    spreadMs: IDLE_LONG_SPREAD_MS,
    description: 'standing still',
    criterion: 'Nothing around you is about to change. There is no reason to look again soon.',
  },
};

/** Uniform on [centre - spread, centre + spread], to the millisecond. */
function jitter(centre: number, spread: number, random: () => number): number {
  return Math.round(centre + (random() * 2 - 1) * spread);
}

const DEFAULT_IDLE_OPTION = 'stay put for a while';

/**
 * Where the composition thresholds live, which is the point of the fan-out shape (docs/12 §3).
 *
 * The chat decider's pacing policy was distributed across a prompt and hoped for. Here it is four
 * numbers in one place: two gates that decide *whether* to act, and a floor below which a Choice
 * is a coin toss between options the model cannot tell apart and is not worth committing to.
 */
export const SEEK_THRESHOLD = 0.5;
export const ROAM_THRESHOLD = 0.5;
export const CHOICE_CONFIDENCE_FLOOR = 0.2;

/**
 * Standing still is the last branch of the policy, so an agent the model never quite wants to move
 * can sit on it indefinitely: the gates are fixed, and nothing in the request tells Jev that this
 * is the ninth idle in a row. `SUPPRESS_IDLE_AFTER=x` makes the *composition* remember instead.
 *
 * `idleWeight(n)` is the weight idle keeps after `n` consecutive idles — 1 through the first `x`,
 * then `e^-((n - x) / x)`, so it halves about every 0.7x idles after that and never reaches zero.
 * Both gates are multiplied by it, which lowers the bar for seeking and roaming rather than
 * raising one for idling: idle has no number of its own to suppress, it is what happens when
 * nothing else clears. The confidence floor is left alone — it answers *which* target, not
 * *whether*, and a coin toss between two people is still a coin toss on the tenth idle.
 *
 * The decay shape is a knob, not a finding. What matters is that it is gradual (an agent that
 * genuinely has nothing to do still mostly stands still) and unbounded (one that has nothing to do
 * for long enough eventually moves anyway).
 *
 * Nothing rescues the degenerate case: with no targets and no places the request asks neither
 * question, so there is no gate to lower and the agent idles on. That is correct — there is
 * nowhere to go.
 */
export function idleWeight(streak: number, after = suppressIdleAfter()): number {
  if (after === undefined || streak <= after) {
    return 1;
  }
  return Math.exp(-(streak - after) / after);
}

// ---------------------------------------------------------------- the request

export interface JevDecisionRequest {
  state: Record<string, string>;
  questions: SystemOneQuestions;
  /** Choice option label → manifest target id. Option labels are sent; manifest ids are not. */
  targets: Record<string, string>;
  /** Choice option label → anchor id. */
  places: Record<string, string>;
}

/**
 * Jev's own advice, followed: a Choice question's *option keys* are sent to the model and used in
 * inference, unlike the question ids, which are not. So the options are phrased as the moves they
 * are — "talk to Bob", "go to the Mill door" — and never as `p:2`, which would be an option the
 * model can only pick at random. The label is mapped back to the id in `decisionFromAnswers`.
 */
function targetLabel(target: ManifestTarget): string {
  return target.what === 'a person' ? `talk to ${target.name}` : `go to ${target.name}`;
}

/** Anchor ids are `snake_case` and readable once they are not; `mill_yard` is "the mill yard". */
function anchorWords(id: string): string {
  return id.replace(/_/g, ' ');
}

function placeLabel(place: ManifestPlace): string {
  return `walk to the ${anchorWords(place.id)}`;
}

/** Same prose the chat decider's list carried, minus the id: identity, distance, nothing mutable. */
function targetCriterion(target: ManifestTarget): string {
  const parts = [`${target.what}, ${target.distance}`];
  if (target.where) {
    // Humanized to match the place labels: a target "at the mill yard" and the option "walk to the
    // mill yard" should be recognizably the same place to the model reading both.
    parts.push(`at the ${anchorWords(target.where)}`);
  }
  if (target.description) {
    parts.push(`— ${target.description}`);
  }
  return parts.join(' ');
}

/**
 * Two people called Bob would otherwise collide into one option and silently lose one of them, so
 * a repeated label is numbered. Nothing in the world prevents duplicate names.
 */
function unique(label: string, taken: Record<string, unknown>): string {
  if (!(label in taken)) {
    return label;
  }
  for (let n = 2; ; n++) {
    const candidate = `${label} (${n})`;
    if (!(candidate in taken)) {
      return candidate;
    }
  }
}

/**
 * The state, as an object rather than a system prompt.
 *
 * Jev accepts a string, object or array of text, and an object is what the docs recommend: each
 * part keeps a name, so a question can point at one by name. The sections are the same ones
 * `decisionSystemPrompt` assembles — and, as there, another entity's prose state is not among them
 * (docs/05 §6.4).
 */
export function decisionState(context: PromptContext): Record<string, string> {
  const state: Record<string, string> = {
    you: `${context.name}. ${describe(context)}`,
  };
  if (context.worldRules.trim()) {
    state.how_this_world_works = context.worldRules;
  }
  if (context.commonKnowledge?.trim()) {
    state.what_everyone_here_knows = context.commonKnowledge;
  }
  if (context.state) {
    state.your_state_right_now = context.state;
  }
  return state;
}

/**
 * The fan-out of docs/12 §3: one request, five questions, composed in code.
 *
 * Jev ingests the state once and evaluates every question against it in parallel, so asking five
 * costs one round trip and a few tokens per question. A question whose option set is empty is
 * omitted rather than sent empty — there is no such thing as a Choice with nothing to choose
 * between, and the composition below reads a missing answer as "no".
 */
export function jevDecisionRequest(
  context: PromptContext,
  manifest: DecisionManifest,
): JevDecisionRequest {
  const targets: Record<string, string> = {};
  const targetCriteria: Record<string, string> = {};
  for (const target of manifest.targets) {
    const label = unique(targetLabel(target), targets);
    targets[label] = target.id;
    targetCriteria[label] = targetCriterion(target);
  }

  const places: Record<string, string> = {};
  const placeCriteria: Record<string, string> = {};
  for (const place of manifest.places) {
    const label = unique(placeLabel(place), places);
    places[label] = place.id;
    placeCriteria[label] = place.description;
  }

  const questions: SystemOneQuestions = {};
  if (Object.keys(targets).length > 0) {
    questions.seek = {
      type: 'noul',
      instructions:
        'Right now is a moment to go to somebody or something, rather than to stay where you are.',
    };
    questions.target = {
      type: 'choice',
      instructions: 'Of these, the one worth going to right now',
      criteria: targetCriteria,
    };
  }
  if (Object.keys(places).length > 0) {
    questions.roam = {
      type: 'noul',
      instructions:
        'If you are not going to anybody or anything, walking somewhere else is better than staying put.',
    };
    questions.place = {
      type: 'choice',
      instructions: 'Of these places, the one worth walking to for no particular reason',
      criteria: placeCriteria,
    };
  }
  questions.idle_length = {
    type: 'choice',
    instructions: 'If you stay where you are, how long before it is worth looking around again',
    criteria: Object.fromEntries(
      Object.entries(IDLE_OPTIONS).map(([label, option]) => [label, option.criterion]),
    ),
  };

  return { state: decisionState(context), questions, targets, places };
}

// ---------------------------------------------------------------- the answers

function noul(answers: SystemOneAnswers, id: string): number | undefined {
  const answer = answers?.[id];
  return answer?.type === 'noul' && typeof answer.noul === 'number' ? answer.noul : undefined;
}

type Chosen = { label: string; probability?: number; confidence?: number };

/**
 * Read one Choice answer, or nothing.
 *
 * `undefined` covers three cases that behave identically: the question was not asked, the answer
 * came back the wrong shape, or the model named an option that was not sent. The last is the one
 * worth naming — it is the only way a Choice can hand back something illegal, and treating it as
 * no answer keeps `decide.ts`'s stance that an out-of-manifest choice is not a legal move to
 * validate later.
 */
function choice(
  answers: SystemOneAnswers,
  id: string,
  legal: Record<string, unknown>,
  problems: string[],
): Chosen | undefined {
  const answer = answers?.[id];
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string') {
    return undefined;
  }
  if (!(answer.choice in legal)) {
    problems.push(`${id} answered "${answer.choice}", which was not one of the options`);
    return undefined;
  }
  return {
    label: answer.choice,
    probability: answer.probabilities?.[answer.choice],
    confidence: answer.confidence,
  };
}

function committed(chosen: Chosen | undefined, id: string, problems: string[]): boolean {
  if (!chosen) {
    return false;
  }
  if (chosen.confidence !== undefined && chosen.confidence < CHOICE_CONFIDENCE_FLOOR) {
    problems.push(
      `${id} chose "${chosen.label}" at confidence ${chosen.confidence.toFixed(2)}, under the floor`,
    );
    return false;
  }
  return true;
}

function n(value: number | undefined): string {
  return value === undefined ? '?' : value.toFixed(2);
}

/**
 * The `reason` field, rebuilt from numbers.
 *
 * Jev writes no prose, so there is no self-narrated reason to record — and in exchange there is
 * something the chat decider never gave: the actual distribution the choice came from. A reason
 * that reads `seek 0.83 · talk to Bob p=0.62 c=0.70` is less charming and more true.
 */
function reasonFor(parts: string[]): string {
  return parts.join(' · ');
}

/** What the composition knows that the answers do not. */
export interface DecisionOptions {
  /** Consecutive idles before this decision, from the engine. Feeds `idleWeight`. */
  idleStreak?: number;
  /** The only nondeterminism here, injectable so the mapping stays testable without a model. */
  random?: () => number;
}

/**
 * Compose one decision out of the answers. Never throws, and never returns a target or anchor the
 * manifest did not contain.
 *
 * The order is the policy: seek someone out, else wander, else stand still. Each gate can fall
 * through to the next, so a low-confidence target does not become an idle when there was a place
 * worth walking to. Both gates are scaled by `idleWeight`, which is the one thing here that
 * depends on decisions other than this one.
 */
export function decisionFromAnswers(
  answers: SystemOneAnswers,
  request: JevDecisionRequest,
  options: DecisionOptions = {},
): { decision: Decision; problems: string[] } {
  const problems: string[] = [];
  if (typeof answers !== 'object' || answers === null) {
    return { decision: idleFallback('The model returned no answers.'), problems: ['no answers'] };
  }

  const random = options.random ?? Math.random;
  // Both gates move together: an agent that has been standing still is readier to go somewhere,
  // and no more particular about which of the two ways it does it.
  const weight = idleWeight(options.idleStreak ?? 0);
  const suppression = weight < 1 ? [`idle x${n(weight)}`] : [];

  const seek = noul(answers, 'seek');
  const target = choice(answers, 'target', request.targets, problems);
  if (
    seek !== undefined &&
    seek >= SEEK_THRESHOLD * weight &&
    committed(target, 'target', problems)
  ) {
    return {
      decision: {
        action: 'approach',
        target: request.targets[target!.label],
        // docs/12 §2 option (c). `interactWithEntity` already has a branch for an empty intent,
        // so nothing downstream needs to change to accept one.
        intent: '',
        reason: reasonFor([
          `seek ${n(seek)}`,
          ...suppression,
          `${target!.label} p=${n(target!.probability)} c=${n(target!.confidence)}`,
        ]),
      },
      problems,
    };
  }

  const roam = noul(answers, 'roam');
  const place = choice(answers, 'place', request.places, problems);
  if (
    roam !== undefined &&
    roam >= ROAM_THRESHOLD * weight &&
    committed(place, 'place', problems)
  ) {
    return {
      decision: {
        action: 'wander',
        anchor: request.places[place!.label],
        reason: reasonFor([
          `seek ${n(seek)}`,
          `roam ${n(roam)}`,
          ...suppression,
          `${place!.label} p=${n(place!.probability)} c=${n(place!.confidence)}`,
        ]),
      },
      problems,
    };
  }

  const length = choice(answers, 'idle_length', IDLE_OPTIONS, problems);
  const option = IDLE_OPTIONS[length?.label ?? DEFAULT_IDLE_OPTION];
  return {
    decision: {
      action: 'idle',
      durationMs: jitter(option.durationMs, option.spreadMs, random),
      description: option.description,
      // No emoji. Jev cannot write one and this branch will not invent one (docs/12 §2).
      reason: reasonFor([
        `seek ${n(seek)}`,
        `roam ${n(roam)}`,
        ...suppression,
        `${length?.label ?? `${DEFAULT_IDLE_OPTION} (default)`}`,
      ]),
    },
    problems,
  };
}

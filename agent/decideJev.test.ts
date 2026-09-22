import {
  CHOICE_CONFIDENCE_FLOOR,
  IDLE_LONG_MS,
  IDLE_SHORT_MS,
  decisionFromAnswers,
  idleWeight,
  jevDecisionRequest,
} from './decideJev';
import { DecisionManifest } from '../engine/aiTown/manifest';
import { SystemOneAnswers } from './model/client';
import { PromptContext } from './promptContext';

const MANIFEST: DecisionManifest = {
  targets: [
    { id: 'p:2', name: 'Bob', what: 'a person', distance: 'close' },
    {
      id: 'e:1',
      name: 'Mill door',
      what: 'a thing you can act on',
      description: 'A heavy oak door.',
      distance: 'nearby',
      where: 'mill_yard',
    },
  ],
  places: [{ id: 'mill_yard', description: 'The packed-dirt yard beside the mill.' }],
};

const ALICE: PromptContext = {
  entityId: 'p:1',
  tier: 'actor',
  name: 'Alice',
  description: 'A cautious millwright.',
  state: 'state: uneasy\n\nThe mill runs hot.\n\nShe means to ask.',
  worldRules: 'Nobody can leave this town.',
};

/** A `choice` answer as the API returns one. */
const chose = (choice: string, confidence = 0.8, probability = 0.8) => ({
  type: 'choice' as const,
  choice,
  confidence,
  probabilities: { [choice]: probability },
});

describe('jevDecisionRequest', () => {
  test('phrases options as moves, never as ids', () => {
    const request = jevDecisionRequest(ALICE, MANIFEST);
    const target = request.questions.target as { criteria: Record<string, string> };

    expect(Object.keys(target.criteria)).toEqual(['talk to Bob', 'go to Mill door']);
    expect(request.targets).toEqual({ 'talk to Bob': 'p:2', 'go to Mill door': 'e:1' });
    // The manifest ids are the mapping, not the prompt: an id must never reach the model as an
    // option it is asked to pick between.
    expect(JSON.stringify(target.criteria)).not.toContain('p:2');
    expect(JSON.stringify(target.criteria)).not.toContain('e:1');
  });

  test('carries the manifest prose and the state, and never another entity state', () => {
    const request = jevDecisionRequest(ALICE, MANIFEST);
    const target = request.questions.target as { criteria: Record<string, string> };
    const place = request.questions.place as { criteria: Record<string, string> };

    expect(target.criteria['talk to Bob']).toBe('a person, close');
    expect(target.criteria['go to Mill door']).toBe(
      'a thing you can act on, nearby at the mill yard — A heavy oak door.',
    );
    expect(place.criteria['walk to the mill yard']).toContain('packed-dirt yard');
    expect(request.state.you).toContain('A cautious millwright.');
    expect(request.state.how_this_world_works).toBe('Nobody can leave this town.');
    expect(request.state.your_state_right_now).toContain('The mill runs hot.');
  });

  test('numbers a repeated name rather than losing one of them', () => {
    const request = jevDecisionRequest(ALICE, {
      targets: [
        { id: 'p:2', name: 'Bob', what: 'a person', distance: 'close' },
        { id: 'p:3', name: 'Bob', what: 'a person', distance: 'far' },
      ],
      places: [],
    });

    expect(request.targets).toEqual({ 'talk to Bob': 'p:2', 'talk to Bob (2)': 'p:3' });
  });

  test('omits a question that would have no options, and always asks the idle length', () => {
    const empty = jevDecisionRequest(ALICE, { targets: [], places: [] });

    expect(Object.keys(empty.questions)).toEqual(['idle_length']);

    const noPlaces = jevDecisionRequest(ALICE, { targets: MANIFEST.targets, places: [] });
    expect(Object.keys(noPlaces.questions).sort()).toEqual(['idle_length', 'seek', 'target']);
  });
});

describe('decisionFromAnswers', () => {
  const request = jevDecisionRequest(ALICE, MANIFEST);
  /** Idle durations are jittered; 0.5 is the middle of the range, so the nominal value comes back. */
  const unjittered = { random: () => 0.5 };

  test('approaches when seek clears the gate', () => {
    const { decision, problems } = decisionFromAnswers(
      {
        seek: { type: 'noul', noul: 0.83 },
        target: chose('talk to Bob', 0.7, 0.62),
        roam: { type: 'noul', noul: 0.9 },
        place: chose('walk to the mill yard'),
        idle_length: chose('pause for a moment'),
      },
      request,
    );

    expect(decision).toEqual({
      action: 'approach',
      target: 'p:2',
      // docs/12 §2 option (c): no intent, and nothing invents one.
      intent: '',
      reason: 'seek 0.83 · talk to Bob p=0.62 c=0.70',
    });
    expect(problems).toEqual([]);
  });

  test('wanders when seek says no but roam says yes', () => {
    const { decision } = decisionFromAnswers(
      {
        seek: { type: 'noul', noul: 0.2 },
        target: chose('talk to Bob'),
        roam: { type: 'noul', noul: 0.77 },
        place: chose('walk to the mill yard', 1, 1),
        idle_length: chose('pause for a moment'),
      },
      request,
    );

    expect(decision).toMatchObject({ action: 'wander', anchor: 'mill_yard' });
  });

  test('a target the model was not offered is not a legal move to validate later', () => {
    const { decision, problems } = decisionFromAnswers(
      {
        seek: { type: 'noul', noul: 1 },
        target: chose('talk to Carol'),
        roam: { type: 'noul', noul: 0 },
        idle_length: chose('stay put for a while'),
      },
      request,
      unjittered,
    );

    expect(decision).toMatchObject({ action: 'idle', durationMs: IDLE_LONG_MS });
    expect(problems.join(' ')).toContain('was not one of the options');
  });

  test('a coin-toss choice falls through to the next gate instead of committing', () => {
    const { decision, problems } = decisionFromAnswers(
      {
        seek: { type: 'noul', noul: 0.9 },
        target: chose('talk to Bob', CHOICE_CONFIDENCE_FLOOR - 0.01, 0.34),
        roam: { type: 'noul', noul: 0.9 },
        place: chose('walk to the mill yard', 0.9, 0.9),
        idle_length: chose('pause for a moment'),
      },
      request,
    );

    // Not an idle: a target it cannot pick between does not mean there was nowhere to walk.
    expect(decision).toMatchObject({ action: 'wander', anchor: 'mill_yard' });
    expect(problems.join(' ')).toContain('under the floor');
  });

  test('idles at the length it chose, with a description and no emoji', () => {
    const { decision } = decisionFromAnswers(
      {
        seek: { type: 'noul', noul: 0 },
        roam: { type: 'noul', noul: 0 },
        idle_length: chose('pause for a moment'),
      },
      request,
      unjittered,
    );

    expect(decision).toEqual({
      action: 'idle',
      durationMs: IDLE_SHORT_MS,
      description: 'pausing',
      reason: 'seek 0.00 · roam 0.00 · pause for a moment',
    });
    expect(decision).not.toHaveProperty('emoji');
  });

  test('never throws, and idles on anything unusable', () => {
    const rubbish: unknown[] = [
      {},
      null,
      undefined,
      { seek: { type: 'noul', noul: 1 } },
      { seek: { type: 'score', score: 1 }, target: chose('talk to Bob') },
      { target: { type: 'choice' }, idle_length: { type: 'choice', choice: 'nonsense' } },
    ];
    for (const answers of rubbish) {
      expect(() => decisionFromAnswers(answers as SystemOneAnswers, request)).not.toThrow();
      const { decision } = decisionFromAnswers(answers as SystemOneAnswers, request);
      expect(decision.action).toBe('idle');
      expect(decision.reason).not.toBe('');
    }
  });

  test('defaults to the long idle when the length question was not answered', () => {
    const { decision } = decisionFromAnswers({} as SystemOneAnswers, request, unjittered);

    expect(decision).toMatchObject({ action: 'idle', durationMs: IDLE_LONG_MS });
  });

  test('spreads each idle duration over its range, so a room does not decide in lockstep', () => {
    const idleFor = (random: () => number, label: string) =>
      (
        decisionFromAnswers(
          {
            seek: { type: 'noul', noul: 0 },
            roam: { type: 'noul', noul: 0 },
            idle_length: chose(label),
          },
          request,
          { random },
        ).decision as { durationMs: number }
      ).durationMs;

    expect(idleFor(() => 0, 'pause for a moment')).toBe(4_000);
    expect(idleFor(() => 1, 'pause for a moment')).toBe(6_000);
    expect(idleFor(() => 0, 'stay put for a while')).toBe(25_000);
    expect(idleFor(() => 1, 'stay put for a while')).toBe(35_000);
  });

  test('a long idle streak lowers the gates rather than inventing an urge to move', () => {
    const settled = {
      seek: { type: 'noul' as const, noul: 0.3 },
      target: chose('talk to Bob'),
      roam: { type: 'noul' as const, noul: 0.1 },
      place: chose('walk to the mill yard'),
      idle_length: chose('stay put for a while'),
    };

    // SUPPRESS_IDLE_AFTER unset: the gates stand where they are and 0.3 is not enough.
    expect(decisionFromAnswers(settled, request, { idleStreak: 40 }).decision.action).toBe('idle');

    process.env.SUPPRESS_IDLE_AFTER = '3';
    try {
      expect(decisionFromAnswers(settled, request, { idleStreak: 3 }).decision.action).toBe('idle');
      // e^-(6-3)/3 = 0.37, so the seek gate is 0.18 and a 0.3 answer now clears it.
      const { decision } = decisionFromAnswers(settled, request, { idleStreak: 6 });
      expect(decision).toMatchObject({ action: 'approach', target: 'p:2' });
      expect(decision.reason).toContain('idle x0.37');
    } finally {
      delete process.env.SUPPRESS_IDLE_AFTER;
    }
  });
});

describe('idleWeight', () => {
  test('is 1 until the streak passes the flag, then decays without reaching zero', () => {
    expect(idleWeight(9, undefined)).toBe(1);
    expect(idleWeight(4, 4)).toBe(1);
    expect(idleWeight(8, 4)).toBeCloseTo(Math.exp(-1), 5);
    expect(idleWeight(100, 4)).toBeGreaterThan(0);
  });
});

import { DEFAULT_IDLE_MS, decisionSystemPrompt, parseDecision } from './decide';
import { DecisionManifest } from '../engine/aiTown/manifest';
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

describe('parseDecision', () => {
  test('reads an approach', () => {
    const { decision } = parseDecision(
      JSON.stringify({ action: 'approach', target: 'p:2', intent: 'Ask about the mill.', reason: 'He knows.' }),
      MANIFEST,
    );

    expect(decision).toEqual({
      action: 'approach',
      target: 'p:2',
      intent: 'Ask about the mill.',
      reason: 'He knows.',
    });
  });

  test('reads a wander and an idle', () => {
    expect(
      parseDecision(JSON.stringify({ action: 'wander', anchor: 'mill_yard', reason: 'Restless.' }), MANIFEST)
        .decision,
    ).toEqual({ action: 'wander', anchor: 'mill_yard', reason: 'Restless.' });

    expect(
      parseDecision(
        JSON.stringify({
          action: 'idle',
          duration_ms: 45000,
          description: 'checking the gears',
          emoji: '⚙️',
          reason: 'Waiting.',
        }),
        MANIFEST,
      ).decision,
    ).toEqual({
      action: 'idle',
      durationMs: 45000,
      description: 'checking the gears',
      emoji: '⚙️',
      reason: 'Waiting.',
    });
  });

  test('a target outside the manifest is a parse failure, not something to validate later', () => {
    const { decision, problems } = parseDecision(
      JSON.stringify({ action: 'approach', target: 'p:99', intent: 'Hi.', reason: 'Why not.' }),
      MANIFEST,
    );

    expect(decision.action).toBe('idle');
    expect(problems.join(' ')).toContain('not in the manifest');
  });

  test('an anchor outside the manifest falls back too', () => {
    const { decision } = parseDecision(
      JSON.stringify({ action: 'wander', anchor: 'atlantis', reason: 'Curious.' }),
      MANIFEST,
    );

    expect(decision.action).toBe('idle');
  });

  test('an unknown action falls back to idling', () => {
    const { decision, problems } = parseDecision(
      JSON.stringify({ action: 'fly', reason: 'Felt like it.' }),
      MANIFEST,
    );

    expect(decision).toMatchObject({ action: 'idle', durationMs: DEFAULT_IDLE_MS });
    expect(problems.join(' ')).toContain('unknown action "fly"');
  });

  test('an absurd idle duration is clamped rather than honoured', () => {
    const { decision } = parseDecision(
      JSON.stringify({ action: 'idle', duration_ms: 999_999_999, reason: 'Forever.' }),
      MANIFEST,
    );

    expect(decision).toMatchObject({ action: 'idle', durationMs: 300_000 });
  });

  test('a missing reason is recorded but does not discard the choice', () => {
    const { decision, problems } = parseDecision(
      JSON.stringify({ action: 'wander', anchor: 'mill_yard' }),
      MANIFEST,
    );

    expect(decision.action).toBe('wander');
    expect(problems).toContain('reason missing');
  });

  test('never throws, and idles on anything unusable', () => {
    for (const input of ['', 'I refuse.', '{', 'null', '[1]']) {
      expect(() => parseDecision(input, MANIFEST)).not.toThrow();
      expect(parseDecision(input, MANIFEST).decision.action).toBe('idle');
    }
  });
});

describe('decisionSystemPrompt', () => {
  test('lists the targets and places, and never their state', () => {
    const prompt = decisionSystemPrompt(ALICE, MANIFEST);

    expect(prompt).toContain('p:2 — Bob, a person, close');
    expect(prompt).toContain('A heavy oak door.');
    expect(prompt).toContain('mill_yard — The packed-dirt yard');
    expect(prompt).toContain('Nobody can leave this town.');
    // The speaker's own state is in; nothing describes another entity's state.
    expect(prompt).toContain('The mill runs hot.');
    expect(prompt).not.toContain('kind:');
    expect(prompt).not.toContain('mobile');
  });

  test('says so plainly when there is nothing to go to', () => {
    const prompt = decisionSystemPrompt(ALICE, { targets: [], places: [] });

    expect(prompt).toContain('There is nobody and nothing you can go to right now.');
  });
});

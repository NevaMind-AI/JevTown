import {
  PromptContext,
  commonKnowledgeSection,
  currentStateSection,
  identitySection,
  stateWritingSystemPrompt,
  worldRulesSection,
} from './promptContext';
import { ENVELOPE_INSTRUCTION } from '../prose/contract';

const ALICE: PromptContext = {
  entityId: 'p:1',
  tier: 'actor',
  name: 'Alice',
  description: 'A cautious millwright.',
  behavior: 'She measures people before she trusts them, and never forgives a lie.',
  state: 'state: uneasy\n\nThe mill runs hot.\n\nShe means to ask.',
  worldRules: 'Nobody in this town can leave it.',
};

describe('prompt sections', () => {
  test('identity names the entity, its description and its behavior, and nothing else', () => {
    const lines = identitySection(ALICE);

    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('You are Alice.');
    expect(lines.join('\n')).toContain('A cautious millwright.');
    expect(lines.join('\n')).toContain('never forgives a lie');
  });

  test('behavior is appended to the description rather than labelled separately', () => {
    expect(identitySection(ALICE)[1]).toBe(
      'About you: A cautious millwright.\nShe measures people before she trusts them, and never forgives a lie.',
    );
    expect(identitySection({ ...ALICE, behavior: undefined })[1]).toBe(
      'About you: A cautious millwright.',
    );
  });

  test('no goal line and no vocabulary line are ever offered', () => {
    const door: PromptContext = {
      entityId: 'e:1',
      tier: 'prop',
      name: 'Mill door',
      description: 'A heavy oak door.',
      worldRules: '',
    };
    const lines = identitySection(door).join('\n');

    expect(lines).not.toContain('What you want');
    expect(lines).not.toContain('The states you can be in');
  });

  test('world rules are omitted entirely when the world declares none', () => {
    expect(worldRulesSection({ ...ALICE, worldRules: '   ' })).toEqual([]);
    expect(worldRulesSection(ALICE).join(' ')).toContain('Nobody in this town can leave it.');
  });

  test('an entity with no state yet is told so rather than shown an empty section', () => {
    expect(currentStateSection({ ...ALICE, state: undefined }).join(' ')).toContain(
      'have not written down your state before',
    );
  });
});

describe('stateWritingSystemPrompt', () => {
  test('carries identity, rules, current state, the contract, and the envelope', () => {
    const prompt = stateWritingSystemPrompt(ALICE, ENVELOPE_INSTRUCTION);

    expect(prompt).toContain('You are Alice.');
    expect(prompt).toContain('Nobody in this town can leave it.');
    expect(prompt).toContain('The mill runs hot.');
    expect(prompt).toContain('state: <one word or short phrase>');
    expect(prompt).toContain('"reason" is required');
  });

  test('an actor is told to write an intention and a prop is told not to', () => {
    const actor = stateWritingSystemPrompt(ALICE, ENVELOPE_INSTRUCTION);
    const prop = stateWritingSystemPrompt({ ...ALICE, tier: 'prop' }, ENVELOPE_INSTRUCTION);

    expect(actor).toContain('what you mean to do next');
    expect(prop).toContain('It is a thing; it has a condition, not a plan.');
    expect(prop).not.toContain('The last part is your intention');
  });
});

describe('common knowledge (docs/05 §5.3)', () => {
  const KNOWN = 'state: uneasy\n\nA boat went out last week and has not come back.';

  test('goes in verbatim, labelled as what everyone knows', () => {
    const lines = commonKnowledgeSection({ ...ALICE, commonKnowledge: KNOWN });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('everyone here knows');
    expect(lines[1]).toBe(KNOWN);
  });

  test('a world that has none contributes nothing, as empty world rules do', () => {
    expect(commonKnowledgeSection(ALICE)).toEqual([]);
    expect(commonKnowledgeSection({ ...ALICE, commonKnowledge: '   ' })).toEqual([]);
  });

  test('sits after the world rules and before anything about this entity', () => {
    const prompt = stateWritingSystemPrompt(
      { ...ALICE, commonKnowledge: KNOWN },
      ENVELOPE_INSTRUCTION,
    );

    // The static prefix a god write must not invalidate comes first; everything after it was
    // per-entity and changing anyway.
    expect(prompt.indexOf('Nobody in this town can leave it.')).toBeLessThan(
      prompt.indexOf('A boat went out last week'),
    );
    expect(prompt.indexOf('A boat went out last week')).toBeLessThan(
      prompt.indexOf('The mill runs hot.'),
    );
  });
});

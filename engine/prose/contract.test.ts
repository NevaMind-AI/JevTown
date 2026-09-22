import { ACTOR_STATE_CONTRACT, COMMON_KNOWLEDGE_CONTRACT, PROP_STATE_CONTRACT } from './contract';

describe('the common-knowledge contract (docs/05 §5.3)', () => {
  test('has no bracketed blocks — the world occupies no tiles and carries nothing', () => {
    expect(COMMON_KNOWLEDGE_CONTRACT).not.toContain('<blocked/>');
    expect(COMMON_KNOWLEDGE_CONTRACT).not.toContain('<items>');
    // Both are still offered to the entities that can actually use them.
    expect(ACTOR_STATE_CONTRACT).toContain('<blocked/>');
    expect(PROP_STATE_CONTRACT).toContain('<items>');
  });

  test('never points at a description, because the world has none', () => {
    // A rule that says "its own description" to a subject that has none does not read as
    // inapplicable to a model; it reads as a referent to go and find.
    expect(COMMON_KNOWLEDGE_CONTRACT).not.toContain('description');
    expect(ACTOR_STATE_CONTRACT).toContain('its own description');
  });

  test('does not ask for an intention — the world has a condition, not a plan', () => {
    expect(COMMON_KNOWLEDGE_CONTRACT).not.toContain('what you mean to do next');
  });

  test('carries the scope rule, which is the whole of what keeps it from leaking omniscience', () => {
    expect(COMMON_KNOWLEDGE_CONTRACT).toContain('everyone in this world would already know');
    expect(COMMON_KNOWLEDGE_CONTRACT).toContain('secret');
  });
});

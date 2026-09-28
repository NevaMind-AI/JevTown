import { ACTOR_STATE_CONTRACT, WORLD_STATE_CONTRACT, PROP_STATE_CONTRACT } from './contract';

describe('the world-state contract (docs/05 §5.3, docs/13 §1.4)', () => {
  test('has no bracketed blocks — the world occupies no tiles and carries nothing', () => {
    expect(WORLD_STATE_CONTRACT).not.toContain('<blocked/>');
    expect(WORLD_STATE_CONTRACT).not.toContain('<items>');
    // Both are still offered to the entities that can actually use them.
    expect(ACTOR_STATE_CONTRACT).toContain('<blocked/>');
    expect(PROP_STATE_CONTRACT).toContain('<items>');
  });

  test('states the record blocks in the shape, so a rewrite cannot fold them away', () => {
    // docs/13 §1.4: a writer told the shape is "a head-state and one paragraph" normalises
    // anything else back into prose, which is how task state would be lost silently.
    expect(WORLD_STATE_CONTRACT).toContain('<tasks>');
    expect(WORLD_STATE_CONTRACT).toContain('<player_items>');
  });

  test('exempts the record blocks from the rules written for the paragraph', () => {
    // The scope rule below is scoped to the paragraph, not the document: every clause of it
    // would otherwise forbid an unfinished task or the player's pockets (docs/13 §1.4).
    expect(WORLD_STATE_CONTRACT).toContain('the rules about the paragraph above do not apply');
  });

  test('says the blocks merge, and that leaving a line out is not how you remove it', () => {
    // docs/13 §4. Under merge the destructive reading of "leave it out" is the one a writer will
    // reach for by accident, so the contract has to close it explicitly.
    expect(WORLD_STATE_CONTRACT).toContain('merge line by line');
    expect(WORLD_STATE_CONTRACT).toContain('Leaving a line out never removes it');
    expect(WORLD_STATE_CONTRACT).toContain('with a count of 0');
  });

  test('warns that an invented id adds a line rather than correcting one', () => {
    // The silent failure merge creates: a near-miss key is inert, and the stale line stands.
    expect(WORLD_STATE_CONTRACT).toContain('adds a line that nothing reads');
  });

  test('never points at a description, because the world has none', () => {
    // A rule that says "its own description" to a subject that has none does not read as
    // inapplicable to a model; it reads as a referent to go and find.
    expect(WORLD_STATE_CONTRACT).not.toContain('description');
    expect(ACTOR_STATE_CONTRACT).toContain('its own description');
  });

  test('does not ask for an intention — the world has a condition, not a plan', () => {
    expect(WORLD_STATE_CONTRACT).not.toContain('what you mean to do next');
  });

  test('carries the scope rule, which is the whole of what keeps it from leaking omniscience', () => {
    expect(WORLD_STATE_CONTRACT).toContain('everyone in this world would already know');
    expect(WORLD_STATE_CONTRACT).toContain('secret');
  });

  test('the budget is stated against the paragraph, not the document', () => {
    expect(WORLD_STATE_CONTRACT).toContain('the record blocks do not count toward it');
  });
});

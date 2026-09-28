import { parseStateDocument } from './stateDocument';
import { foldWorldState, renderWorldState } from './worldState';

const FIRST = `state: ordinary

The river is low and the ferry is running short days.

<tasks>
s01-door-tag = observe
settle-in = done
</tasks>

<player_items>
coin = 40
</player_items>`;

describe('folding the world-state version chain (docs/13 §4)', () => {
  test('one version folds to itself', () => {
    const fold = foldWorldState([FIRST]);

    expect(fold.tasks).toEqual({ 's01-door-tag': 'observe', 'settle-in': 'done' });
    expect(fold.playerItems).toEqual({ coin: 40 });
    expect(fold.prose).toContain('The river is low');
  });

  test('a patch touching one line leaves every other line standing', () => {
    const patch = '<tasks>\ns01-door-tag = ask_ash\n</tasks>';
    const fold = foldWorldState([FIRST, patch]);

    expect(fold.tasks).toEqual({ 's01-door-tag': 'ask_ash', 'settle-in': 'done' });
    expect(fold.playerItems).toEqual({ coin: 40 });
    // The patch said nothing about the prose, so the prose is the prose that was there.
    expect(fold.prose).toContain('The river is low');
  });

  test('patches to different lines commute — neither writer loses the other', () => {
    const grantsAnItem = '<player_items>\n"door tag" = 1\n</player_items>';
    const movesATask = '<tasks>\ns01-door-tag = store\n</tasks>';

    const oneOrder = foldWorldState([FIRST, grantsAnItem, movesATask]);
    const theOther = foldWorldState([FIRST, movesATask, grantsAnItem]);

    expect(oneOrder).toEqual(theOther);
    expect(oneOrder.tasks['s01-door-tag']).toBe('store');
    expect(oneOrder.playerItems).toEqual({ coin: 40, 'door tag': 1 });
  });

  test('the same line twice is last-write-wins, which is a real conflict and not an artefact', () => {
    const fold = foldWorldState([
      FIRST,
      '<tasks>\ns01-door-tag = ask_ash\n</tasks>',
      '<tasks>\ns01-door-tag = store\n</tasks>',
    ]);

    expect(fold.tasks['s01-door-tag']).toBe('store');
  });

  test('prose is replaced whole by a writer that writes any, and kept by one that writes none', () => {
    const fold = foldWorldState([FIRST, 'state: uneasy\n\nThe boat has come back.']);

    expect(fold.prose).toContain('The boat has come back');
    expect(fold.prose).not.toContain('The river is low');
    expect(fold.tasks['settle-in']).toBe('done');
  });

  test('leaving a line out never removes it; a count of 0 is how a thing is gone', () => {
    const fold = foldWorldState([FIRST, '<player_items>\ncoin = 0\n</player_items>']);

    expect(fold.playerItems).toEqual({ coin: 0 });
  });

  test('an empty block is a no-op, not an assertion that the record is empty', () => {
    const fold = foldWorldState([FIRST, '<tasks>\n</tasks>']);

    expect(fold.tasks).toEqual({ 's01-door-tag': 'observe', 'settle-in': 'done' });
  });

  test('the composed document parses back to what it was composed from', () => {
    const fold = foldWorldState([FIRST, '<tasks>\ns01-door-tag = ask_ash\n</tasks>']);
    const { document } = parseStateDocument(fold.document);

    expect(document.tasks).toEqual(fold.tasks);
    expect(document.playerItems).toEqual(fold.playerItems);
    expect(document.headState).toBe('ordinary');
  });

  test('a name with spaces survives the round trip', () => {
    const rendered = renderWorldState({ prose: '', tasks: {}, playerItems: { 'a brass key': 2 } });

    expect(parseStateDocument(rendered).document.playerItems).toEqual({ 'a brass key': 2 });
  });

  test('no versions at all is an empty document, not a throw', () => {
    expect(foldWorldState([]).document).toBe('');
  });
});

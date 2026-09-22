import { parseStateDocument, physicsPatchFrom, truncateWords, wordCount } from './stateDocument';

const WELL_FORMED = `state: uneasy

The mill has been running hot for three days and nobody will tell her why. She has not
spoken to the stranger yet.

She means to corner the miller before the next shift and ask him directly.`;

describe('parseStateDocument', () => {
  test('reads the head-state and counts the blocks of a well-formed document', () => {
    const { document, conformance } = parseStateDocument(WELL_FORMED);

    expect(document.headState).toBe('uneasy');
    expect(document.fields).toEqual({});
    expect(document.raw).toBe(WELL_FORMED);
    expect(conformance.headState).toBe('matched');
    expect(conformance.headStateToken).toBe('uneasy');
    expect(conformance.blockCount).toBe(3);
  });

  test('reads typed lines after the head-state', () => {
    const { document, conformance } = parseStateDocument(
      `state: wary\ntrust_player: true\ndebt_owed: 40 coin\n\nShe is counting.\n\nShe will collect.`,
    );

    expect(document.headState).toBe('wary');
    expect(document.fields).toEqual({ trust_player: 'true', debt_owed: '40 coin' });
    expect(conformance.fieldCount).toBe(2);
  });

  test('a `name: value` line below the head block is prose, not a field', () => {
    const { document } = parseStateDocument(`state: wary\n\nShe is counting: slowly, and twice.`);

    expect(document.fields).toEqual({});
  });

  test('the body is never split into sections, whatever the tier would have wanted', () => {
    const raw = `state: tired\n\nOne.\n\nTwo.\n\nThree.\n\nShe will sleep.`;
    const { document, conformance } = parseStateDocument(raw);

    expect(document.raw).toBe(raw);
    expect(conformance.blockCount).toBe(5);
  });
});

describe('parseStateDocument tolerates malformed documents', () => {
  test('a missing head-state keeps the whole document', () => {
    const raw = `She is furious about the mill.\n\nShe will confront him.`;
    const { document, conformance } = parseStateDocument(raw);

    expect(conformance.headState).toBe('missing');
    expect(conformance.headStateToken).toBeUndefined();
    expect(document.headState).toBeUndefined();
    expect(document.raw).toBe(raw);
  });

  test('an empty head-state value is malformed, not missing', () => {
    const { document, conformance } = parseStateDocument(`state:\n\nA paragraph.`);

    expect(conformance.headState).toBe('malformed');
    expect(document.headState).toBeUndefined();
  });

  test('an invented head-state token is accepted — the engine has no vocabulary', () => {
    const { document, conformance } = parseStateDocument(
      `state: absolutely beside herself\n\nA paragraph.\n\nAn intention.`,
    );

    expect(document.headState).toBe('absolutely beside herself');
    expect(conformance.headState).toBe('matched');
    expect(conformance.headStateToken).toBe('absolutely beside herself');
  });

  test('a stray line in the header block is kept in the document rather than dropped', () => {
    const raw = `state: wary\nthis line has no colon\n\nA paragraph.\n\nAn intention.`;
    const { document } = parseStateDocument(raw);

    expect(document.fields).toEqual({});
    expect(document.raw).toContain('this line has no colon');
    expect(document.raw).toBe(raw);
  });

  test('a document with no structure at all is still a document', () => {
    const raw = 'she is fine i guess';
    const { document, conformance } = parseStateDocument(raw);

    expect(document.raw).toBe(raw);
    expect(conformance.headState).toBe('missing');
    expect(conformance.blockCount).toBe(1);
  });

  test('never throws, whatever it is handed', () => {
    const inputs = ['', '   ', '\n\n\n', 'state:', '{"state":"json"}', 'state: a\nb: \n\n\n', '::::'];
    for (const input of inputs) {
      expect(() => parseStateDocument(input)).not.toThrow();
    }
  });

  test('an empty document parses to an empty conformance record', () => {
    const { conformance } = parseStateDocument('');

    expect(conformance).toMatchObject({
      headState: 'missing',
      blockCount: 0,
      fieldCount: 0,
      wordCount: 0,
      overBudget: false,
    });
  });
});

describe('budgets', () => {
  test('wordCount ignores surrounding whitespace', () => {
    expect(wordCount('  one   two\nthree  ')).toBe(3);
    expect(wordCount('   ')).toBe(0);
  });

  test('overBudget fires only past the budget', () => {
    const long = new Array(1001).fill('word').join(' ');
    expect(parseStateDocument(long).conformance.overBudget).toBe(true);
    const short = new Array(1000).fill('word').join(' ');
    expect(parseStateDocument(short).conformance.overBudget).toBe(false);
  });

  test('truncateWords cuts on a word boundary and reports it', () => {
    expect(truncateWords('one two three four', 2)).toEqual({ text: 'one two', truncated: true });
    expect(truncateWords('one two', 5)).toEqual({ text: 'one two', truncated: false });
    expect(truncateWords('', 5)).toEqual({ text: '', truncated: false });
  });
});

describe('the physics tag', () => {
  const patch = (raw: string) => physicsPatchFrom(parseStateDocument(raw).document);

  test('reads either tag, wherever in the document it sits', () => {
    expect(patch('state: shut\n<blocked/>\n\nThe bar is set.')).toEqual({ blocksMovement: true });
    expect(patch('state: open\n\nThe bar is splintered.\n\n<unblocked/>')).toEqual({
      blocksMovement: false,
    });
  });

  test('tolerates the near misses a model actually writes', () => {
    expect(patch('state: shut\n< blocked />')).toEqual({ blocksMovement: true });
    expect(patch('state: shut\n<BLOCKED/>')).toEqual({ blocksMovement: true });
    expect(patch('state: shut\n<blocked>')).toEqual({ blocksMovement: true });
  });

  test('no tag asserts nothing, so the entity keeps what it had', () => {
    const { document, conformance } = parseStateDocument('state: calm\n\nNothing much.');

    expect(conformance.physicsTag).toBe('absent');
    expect(document.physicsTag).toBeUndefined();
    expect(physicsPatchFrom(document)).toEqual({});
  });

  test('both tags at once assert nothing either — never a guessed default', () => {
    const raw = 'state: confused\n<blocked/>\n<unblocked/>\n\nIt is unclear.';
    const { document, conformance } = parseStateDocument(raw);

    expect(conformance.physicsTag).toBe('conflicting');
    expect(physicsPatchFrom(document)).toEqual({});
  });

  test('the same tag twice is still one assertion', () => {
    expect(patch('state: shut\n<blocked/>\n\nStill shut. <blocked/>')).toEqual({
      blocksMovement: true,
    });
  });
});

describe('the items block', () => {
  test('reads quoted names and counts', () => {
    const { document, conformance } = parseStateDocument(
      'state: carrying\n<items>\n"a brass key" = 1\n"coin" = 40\n</items>\n\nShe is loaded down.',
    );

    expect(document.items).toEqual({ 'a brass key': 1, coin: 40 });
    expect(conformance.itemCount).toBe(2);
  });

  test('tolerates missing quotes and loose spacing', () => {
    const { document } = parseStateDocument('state: x\n<items>\nrope=2\n  "a lamp"   =   1\n</items>');

    expect(document.items).toEqual({ rope: 2, 'a lamp': 1 });
  });

  test('an unparseable line is skipped rather than throwing', () => {
    const { document } = parseStateDocument('state: x\n<items>\nsome prose about rope\n"rope" = 2\n</items>');

    expect(document.items).toEqual({ rope: 2 });
  });

  test('no block at all is undefined, not an empty inventory', () => {
    const { document, conformance } = parseStateDocument('state: x\n\nNothing much.');

    expect(document.items).toBeUndefined();
    expect(conformance.itemCount).toBe(0);
  });

  test('an empty block is an empty inventory, which is a real answer', () => {
    const { document } = parseStateDocument('state: x\n<items>\n</items>');

    expect(document.items).toEqual({});
  });
});

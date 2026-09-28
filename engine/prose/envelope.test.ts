import { extractJsonObject, parseEnvelope } from './envelope';

describe('extractJsonObject', () => {
  test('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  test('reads an object out of a fenced block', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nHope that helps.')).toEqual({
      a: 1,
    });
  });

  test('stops at the matching brace, not the last one in the string', () => {
    expect(extractJsonObject('{"a":1} and then some prose with a } in it')).toEqual({ a: 1 });
  });

  test('is not confused by braces inside strings', () => {
    expect(extractJsonObject('{"a":"a } brace","b":2}')).toEqual({ a: 'a } brace', b: 2 });
  });

  test('returns undefined rather than throwing on junk', () => {
    for (const input of ['', 'no json here', '{', '{"a":', '}{']) {
      expect(() => extractJsonObject(input)).not.toThrow();
      expect(extractJsonObject(input)).toBeUndefined();
    }
  });
});

describe('parseEnvelope', () => {
  test('parses the §6.1 self-update shape', () => {
    const { self } = parseEnvelope(
      JSON.stringify({
        state: 'state: wary\n\nShe is counting.\n\nShe will collect.',
        memory: ['I told the miller I knew.'],
        reason: 'She learned the mill runs hot at night.',
        tags: { beat: 3 },
      }),
    );

    expect(self.state).toContain('state: wary');
    expect(self.memory).toHaveLength(1);
    expect(self.reason).toContain('runs hot');
    expect(self.tags).toEqual({ beat: 3 });
    expect(self.problems).toEqual([]);
  });

  test('parses the §6.2 nested self/target shape', () => {
    const parsed = parseEnvelope(
      JSON.stringify({
        self: { state: 'state: winded', reason: 'She forced it.' },
        target: { state: 'state: open\n<unblocked/>', reason: 'The bar splintered.' },
      }),
    );

    expect(parsed.target).toBeDefined();
    expect(parsed.target!.state).toContain('<unblocked/>');
    expect(parsed.self.state).toContain('winded');
  });

  test('a leftover JSON physics field is recorded and ignored, not honoured', () => {
    const { self } = parseEnvelope(
      JSON.stringify({ state: 'x', physics: { blocks_movement: false }, reason: 'r' }),
    );

    expect(self.problems.join(' ')).toContain('no longer read');
    // The prose still lands: a stale field does not discard the state document.
    expect(self.state).toBe('x');
  });

  test('a missing state is reported, not invented', () => {
    const { self } = parseEnvelope(JSON.stringify({ reason: 'nothing changed' }));

    expect(self.state).toBeUndefined();
    expect(self.problems).toEqual([]);
  });

  test('an empty state string is treated as absent', () => {
    const { self } = parseEnvelope(JSON.stringify({ state: '   ', reason: 'r' }));

    expect(self.state).toBeUndefined();
    expect(self.problems.join(' ')).toContain('keeping the previous document');
  });

  test('memory and reason truncate rather than fail', () => {
    const longMemory = new Array(100).fill('word').join(' ');
    const longReason = new Array(100).fill('word').join(' ');
    const { self } = parseEnvelope(
      JSON.stringify({ state: 'x', memory: [longMemory], reason: longReason }),
    );

    expect(self.memory[0].split(' ')).toHaveLength(60);
    expect(self.reason.split(' ')).toHaveLength(40);
    expect(self.problems).toEqual(
      expect.arrayContaining(['truncated a memory entry to budget', 'truncated reason to budget']),
    );
  });

  test('a missing reason is recorded — it is the only trace this branch has', () => {
    const { self } = parseEnvelope(JSON.stringify({ state: 'x' }));

    expect(self.problems).toContain('reason missing');
  });

  test('non-string memory entries are dropped, not fatal', () => {
    const { self } = parseEnvelope(
      JSON.stringify({ state: 'x', memory: ['ok', 7, null], reason: 'r' }),
    );

    expect(self.memory).toEqual(['ok']);
    expect(self.problems).toContain('dropped a non-string memory entry');
  });

  test('never throws, and reports when there was no JSON at all', () => {
    for (const input of ['', 'I refuse.', '{', 'null', '[1,2,3]']) {
      expect(() => parseEnvelope(input)).not.toThrow();
    }
    expect(parseEnvelope('I refuse.').self.problems).toContain(
      'no JSON object found in the response',
    );
  });
});

describe('a world-record patch in the envelope (docs/13 §4)', () => {
  test('rides alongside the state document and keeps only its record lines', () => {
    const { self } = parseEnvelope(
      JSON.stringify({
        state: 'state: pleased\n\nI handed the tag over.',
        reason: 'the player brought me the tag',
        world: '<tasks>\ns01-door-tag = store\n</tasks>',
      }),
    );

    expect(self.world).toContain('s01-door-tag = store');
    expect(self.problems).toEqual([]);
  });

  test('prose in the patch is dropped and recorded — the paragraph is the god’s', () => {
    const { self } = parseEnvelope(
      JSON.stringify({
        reason: 'r',
        world:
          'state: uneasy\n\nThe whole town is talking.\n\n<player_items>\n"door tag" = 1\n</player_items>',
      }),
    );

    expect(self.world).toBe('<player_items>\n"door tag" = 1\n</player_items>');
    expect(self.problems).toContain(
      'world patch carried prose, which was dropped — the record blocks were kept',
    );
  });

  test('a patch with no record lines is ignored rather than written', () => {
    const { self } = parseEnvelope(
      JSON.stringify({ reason: 'r', world: 'Nothing much happened.' }),
    );

    expect(self.world).toBeUndefined();
    expect(self.problems).toContain('world patch had no record lines, ignored');
  });

  test('absent is the normal case and says nothing', () => {
    const { self } = parseEnvelope(JSON.stringify({ state: 'state: x\n\nfine', reason: 'r' }));

    expect(self.world).toBeUndefined();
    expect(self.problems).toEqual([]);
  });

  test('a patch under "target" is ignored, because one call writes one record', () => {
    const { self, target } = parseEnvelope(
      JSON.stringify({
        self: { state: 'state: a\n\nmine', reason: 'r' },
        target: { state: 'state: b\n\ntheirs', reason: 'r', world: '<tasks>\nt = s\n</tasks>' },
      }),
    );

    expect(target?.world).toBeUndefined();
    expect(target?.problems).toContain('world patch under "target" ignored; write it in "self"');
    expect(self.world).toBeUndefined();
  });
});

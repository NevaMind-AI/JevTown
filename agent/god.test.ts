import { parseGate, parseVerdict, renderBatch } from './god';

describe('parseGate', () => {
  test('reads a verdict either way', () => {
    expect(parseGate('{"intervene": true, "why": "One document has no head-state."}')).toEqual({
      intervene: true,
      why: 'One document has no head-state.',
    });
    expect(parseGate('{"intervene": false, "why": "All fine."}').intervene).toBe(false);
  });

  test('an unreadable gate does not intervene — the safe direction', () => {
    for (const input of ['', 'I am not sure.', '{', 'null']) {
      expect(() => parseGate(input)).not.toThrow();
      expect(parseGate(input).intervene).toBe(false);
    }
  });

  test('anything but a literal true is false', () => {
    expect(parseGate('{"intervene": "yes"}').intervene).toBe(false);
    expect(parseGate('{"intervene": 1}').intervene).toBe(false);
  });
});

describe('parseVerdict', () => {
  const legal = new Set(['e:1', 'p:2']);

  test('reads writes for entities that were in the batch', () => {
    const { writes, problems } = parseVerdict(
      JSON.stringify({
        writes: [
          { entityId: 'e:1', state: 'state: open\n\nIt is open.', reason: 'Missing head-state.' },
        ],
      }),
      legal,
    );

    expect(writes).toEqual([
      { entityId: 'e:1', state: 'state: open\n\nIt is open.', reason: 'Missing head-state.' },
    ]);
    expect(problems).toEqual([]);
  });

  test('the god may not reach outside its own batch', () => {
    const { writes, problems } = parseVerdict(
      JSON.stringify({ writes: [{ entityId: 'e:99', state: 'x', reason: 'Because.' }] }),
      legal,
    );

    expect(writes).toEqual([]);
    expect(problems.join(' ')).toContain('was not in the batch');
  });

  test('a write with no reason is kept but flagged — reason is the only trace there is', () => {
    const { writes, problems } = parseVerdict(
      JSON.stringify({ writes: [{ entityId: 'p:2', state: 'state: calm\n\nFine.' }] }),
      legal,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].reason).toBe('The god gave no reason.');
    expect(problems.join(' ')).toContain('no reason');
  });

  test('never throws, and returns nothing on junk', () => {
    for (const input of ['', 'no', '{"writes": 3}', '{}']) {
      expect(() => parseVerdict(input, legal)).not.toThrow();
      expect(parseVerdict(input, legal).writes).toEqual([]);
      expect(parseVerdict(input, legal).world).toBeUndefined();
    }
  });
});

describe('parseVerdict — common knowledge (docs/05 §5.3)', () => {
  const legal = new Set(['e:1']);

  test('reads a common-knowledge write alongside the entity writes', () => {
    const { writes, world } = parseVerdict(
      JSON.stringify({
        writes: [{ entityId: 'e:1', state: 'state: open\n\nIt is open.', reason: 'Shape.' }],
        world: { state: 'state: uneasy\n\nA stranger is in town.', reason: 'Everyone saw him.' },
      }),
      legal,
    );

    expect(writes).toHaveLength(1);
    expect(world).toEqual({
      state: 'state: uneasy\n\nA stranger is in town.',
      reason: 'Everyone saw him.',
    });
  });

  test('it is not scoped by the batch — there is one document and one writer', () => {
    const { world } = parseVerdict(
      JSON.stringify({ writes: [], world: { state: 'state: quiet\n\nAll is well.', reason: 'x' } }),
      new Set<string>(),
    );

    expect(world?.state).toBe('state: quiet\n\nAll is well.');
  });

  test('a verdict that only updates common knowledge survives a malformed writes array', () => {
    const { writes, world, problems } = parseVerdict(
      JSON.stringify({
        writes: 'nope',
        world: { state: 'state: quiet\n\nAll is well.', reason: 'x' },
      }),
      legal,
    );

    expect(writes).toEqual([]);
    expect(world?.reason).toBe('x');
    expect(problems.join(' ')).toContain('writes is not an array');
  });

  test('an empty or absent document is dropped rather than written blank', () => {
    for (const value of [undefined, null, 'text', {}, { state: '   ', reason: 'x' }]) {
      const { world } = parseVerdict(JSON.stringify({ writes: [], world: value }), legal);
      expect(world).toBeUndefined();
    }
  });

  test('a write with no reason is kept but flagged, as an entity write is', () => {
    const { world, problems } = parseVerdict(
      JSON.stringify({ writes: [], world: { state: 'state: quiet\n\nAll is well.' } }),
      legal,
    );

    expect(world?.reason).toBe('The god gave no reason.');
    expect(problems.join(' ')).toContain('no reason');
  });
});

describe('renderBatch', () => {
  test('labels which variant of the contract each document should be judged against', () => {
    const rendered = renderBatch([
      {
        entityId: 'e:1',
        tier: 'prop',
        reason: 'Alice forced it.',
        state: 'state: open\n\nSplintered.',
      },
      {
        entityId: 'p:2',
        tier: 'actor',
        reason: 'She was surprised.',
        state: 'state: shaken\n\nBreathing hard.',
      },
    ]);

    expect(rendered).toContain(
      ['[e:1]', 'Kind: an entity that does not act', 'Reason for the write: Alice forced it.'].join(
        '\n',
      ),
    );
    expect(rendered).toContain(
      ['[p:2]', 'Kind: an entity that acts', 'Reason for the write: She was surprised.'].join('\n'),
    );
    expect(rendered).toContain('---');
  });

  test('fences each state document so its prose cannot be read as a label', () => {
    const rendered = renderBatch([
      {
        entityId: 'p:2',
        tier: 'actor',
        reason: 'She was surprised.',
        state: 'state: shaken\n\nBreathing hard.',
      },
    ]);

    expect(rendered).toContain('Current state:\n```\nstate: shaken\n\nBreathing hard.\n```');
  });
});

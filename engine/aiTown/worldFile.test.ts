import {
  MapContext,
  WorldFile,
  createEntityArgs,
  subtractEntityAnchors,
  validateWorldFile,
} from './worldFile';
import { STATE_WORD_BUDGET } from '../prose/contract';
import worldFileJson from '../../data/world.json';
import * as gentle from '../../data/gentle';
import { characters } from '../../data/characters';

function context(overrides: Partial<MapContext> = {}): MapContext {
  return {
    anchors: new Map([
      ['yard', { x: 2, y: 2, w: 2, h: 2 }],
      ['door', { x: 5, y: 5, w: 1, h: 1 }],
      ['walled', { x: 8, y: 8, w: 1, h: 1 }],
    ]),
    characters: new Set(['f1', 'f2']),
    width: 16,
    height: 16,
    blocked: (x, y) => x === 8 && y === 8,
    ...overrides,
  };
}

const ACTOR = {
  id: 'alice',
  kind: 'actor' as const,
  mobile: true,
  character: 'f1',
  spawn: { anchor: 'yard' },
  description: 'A cautious millwright who measures people before she trusts them.',
  initial_state: 'state: uneasy\n\nSomething is wrong at the mill.\n\nShe means to ask.',
};

function file(entities: any[], rest: Partial<WorldFile> = {}): WorldFile {
  return { format_version: 'a1.0', world_rules: 'A river town.', entities, ...rest };
}

describe('validateWorldFile', () => {
  test('a well-formed file passes clean', () => {
    const result = validateWorldFile(file([ACTOR]), context());

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('rejects the wrong format version rather than migrating', () => {
    const result = validateWorldFile(file([ACTOR], { format_version: '2.0' }), context());

    expect(result.errors.join(' ')).toContain('format_version');
  });

  test('rejects duplicate ids', () => {
    const result = validateWorldFile(file([ACTOR, { ...ACTOR }]), context());

    expect(result.errors.join(' ')).toContain('duplicate id');
  });

  test('rejects an unknown anchor', () => {
    const result = validateWorldFile(file([{ ...ACTOR, spawn: { anchor: 'nowhere' } }]), context());

    expect(result.errors.join(' ')).toContain('unknown anchor "nowhere"');
  });

  test('rejects an unknown character', () => {
    const result = validateWorldFile(file([{ ...ACTOR, character: 'f9' }]), context());

    expect(result.errors.join(' ')).toContain('unknown character "f9"');
  });

  test('rejects an entity with neither state nor description — that is decoration', () => {
    const result = validateWorldFile(
      file([{ id: 'oak', kind: 'prop', anchor: 'yard', sprite: 'oak' }]),
      context(),
    );

    expect(result.errors.join(' ')).toContain('decoration');
  });

  test('a prop may be described, but may not remember', () => {
    const described = validateWorldFile(
      file([
        {
          id: 'door',
          kind: 'prop',
          anchor: 'door',
          initial_state: 'state: locked\n\nBarred.',
          description: 'A heavy oak door, banded in iron, set into the mill\u2019s north face.',
        },
      ]),
      context(),
    );
    expect(described.errors).toEqual([]);

    const remembering = validateWorldFile(
      file([
        {
          id: 'door',
          kind: 'prop',
          anchor: 'door',
          initial_state: 'state: locked\n\nBarred.',
          description: 'A heavy oak door, banded in iron, set into the mill\u2019s north face.',
          initial_memory: ['Someone forced me once.'],
        },
      ]),
      context(),
    );
    expect(remembering.errors.join(' ')).toContain('props have no initial_memory');
  });

  test('rejects initial_memory without initial_state', () => {
    const { initial_state: _initial_state, ...stateless } = ACTOR;
    const result = validateWorldFile(
      file([{ ...stateless, initial_memory: ['I remember.'] }]),
      context(),
    );

    expect(result.errors.join(' ')).toContain('initial_memory requires initial_state');
  });

  test('requires mobile on actors and forbids it on props', () => {
    const { mobile: _mobile, ...noMobile } = ACTOR;
    expect(validateWorldFile(file([noMobile]), context()).errors.join(' ')).toContain(
      'must declare mobile',
    );
    const result = validateWorldFile(
      file([
        {
          id: 'd',
          kind: 'prop',
          mobile: false,
          anchor: 'door',
          initial_state: 'state: locked\n\nBarred.',
        },
      ]),
      context(),
    );
    expect(result.errors.join(' ')).toContain('must not declare mobile');
  });

  test('rejects a spawn anchor with no free tile', () => {
    const result = validateWorldFile(file([{ ...ACTOR, spawn: { anchor: 'walled' } }]), context());

    expect(result.errors.join(' ')).toContain('has no free tile');
  });

  test('a fixed entity may sit on a blocked tile — the loader clears it', () => {
    const result = validateWorldFile(
      file([
        { id: 'gate', kind: 'prop', anchor: 'walled', initial_state: 'state: shut\n\nIt is shut.' },
      ]),
      context(),
    );

    expect(result.errors).toEqual([]);
  });

  test('warns rather than fails when a mobile actor has no spawn anchor', () => {
    const { spawn: _spawn, ...noSpawn } = ACTOR;
    const result = validateWorldFile(file([noSpawn]), context());

    expect(result.errors).toEqual([]);
    expect(result.warnings.join(' ')).toContain('no spawn anchor');
  });

  test('warns when two fixed entities claim the same tile', () => {
    const prop = (id: string) => ({
      id,
      kind: 'prop' as const,
      anchor: 'door',
      initial_state: 'state: there\n\nIt is there.',
    });
    const result = validateWorldFile(file([prop('a'), prop('b')]), context());

    expect(result.errors).toEqual([]);
    expect(result.warnings.join(' ')).toContain('will stack');
  });

  test('rejects an over-budget initial_state', () => {
    const long = `state: verbose\n\n${new Array(1200).fill('word').join(' ')}\n\nShe goes on.`;
    const result = validateWorldFile(file([{ ...ACTOR, initial_state: long }]), context());

    expect(result.errors.join(' ')).toContain('over the 1000-word budget');
  });
});

describe('common knowledge (docs/05 §5.3)', () => {
  test('the reserved id cannot be taken by an entity', () => {
    const { errors } = validateWorldFile(file([{ ...ACTOR, id: '__world__' }]), context());

    expect(errors.join(' ')).toContain('reserved for the world');
  });

  test('it gets the same word budget every state document gets', () => {
    const { errors } = validateWorldFile(
      file([ACTOR], { common_knowledge: 'word '.repeat(STATE_WORD_BUDGET + 1) }),
      context(),
    );

    expect(errors.join(' ')).toContain('common_knowledge is over');
  });

  test('a world with none is fine — most worlds start with nothing to know', () => {
    const { errors } = validateWorldFile(file([ACTOR]), context());

    expect(errors.join(' ')).not.toContain('common_knowledge');
  });
});

describe('subtractEntityAnchors', () => {
  test('clears static collision under a fixed entity and says so', () => {
    const collision: boolean[][] = Array.from({ length: 16 }, () =>
      new Array<boolean>(16).fill(false),
    );
    collision[8][8] = true;
    const result = subtractEntityAnchors(
      collision,
      file([{ id: 'gate', kind: 'prop', anchor: 'walled', initial_state: 'state: shut\n\nShut.' }]),
      context(),
    );

    expect(result.collision[8][8]).toBe(false);
    expect(result.warnings.join(' ')).toContain('gate');
    // The input is not mutated: the caller may still need the map's own collision.
    expect(collision[8][8]).toBe(true);
  });

  test('leaves the spawn anchors of mobile actors alone', () => {
    const collision: boolean[][] = Array.from({ length: 16 }, () =>
      new Array<boolean>(16).fill(true),
    );
    const result = subtractEntityAnchors(collision, file([ACTOR]), context());

    expect(result.collision[2][2]).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe('createEntityArgs', () => {
  test('translates the file case boundary', () => {
    const args = createEntityArgs({
      id: 'door',
      kind: 'prop',
      anchor: 'door',
      description: 'A heavy oak door.',
      initial_state: 'state: locked\n\nBarred.',
      physics: { blocks_movement: true },
    });

    expect(args).toMatchObject({
      kind: 'prop',
      mobile: false,
      anchor: 'door',
      initialState: 'state: locked\n\nBarred.',
      blocksMovement: true,
    });
  });
});

describe('the shipped example world', () => {
  test('validates clean against the shipped map', () => {
    const result = validateWorldFile(worldFileJson as WorldFile, {
      anchors: new Map(Object.entries(gentle.anchors)),
      characters: new Set(characters.map((c) => c.name)),
      width: gentle.mapwidth,
      height: gentle.mapheight,
      blocked: (x, y) => gentle.objmap.some((layer) => (layer[x]?.[y] ?? -1) !== -1),
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('exercises all three tiers', () => {
    const entities = (worldFileJson as WorldFile).entities;
    expect(entities.some((e) => e.kind === 'actor' && e.mobile)).toBe(true);
    expect(entities.some((e) => e.kind === 'actor' && !e.mobile)).toBe(true);
    expect(entities.some((e) => e.kind === 'prop')).toBe(true);
  });
});

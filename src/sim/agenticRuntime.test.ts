import { jest } from '@jest/globals';
import { InMemoryAgentStore } from '../../agent/store/memoryStore';
import { createAgenticWorld } from './createAgenticWorld';
import { fixtureContent } from '../../tests/fixtures/agenticWorld';

/**
 * The loop, driven without a model.
 *
 * `runOperation` is injectable for exactly this: every agent operation ends in a model call, so
 * the only way to exercise the runtime is to replace the operation with something that reports
 * back the way a real one does — through the input queue. What is under test is the part that has
 * to be right regardless of what the model says: the world advances, an operation the simulation
 * asked for actually runs, its result re-enters as an input, and time is consumed rather than
 * simulated when nobody is watching.
 */

const T0 = 1_700_000_000_000;

describe('AgenticRuntime', () => {
  test('creates the authored world from its file, through the log', () => {
    const runtime = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
    });
    // Entities arrive as inputs, so nothing exists until the first tick applies them.
    expect(runtime.game.world.entities.size + runtime.game.world.players.size).toBe(0);
    expect(runtime.events().length).toBeGreaterThan(0);
    expect(runtime.events().every((e) => e.name === 'createEntity')).toBe(true);

    runtime.advance(160);
    const populated = runtime.game.world.entities.size + runtime.game.world.players.size;
    expect(populated).toBe(runtime.events().length);
  });

  test('assigns idx and game time itself, in order', () => {
    const runtime = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
    });
    runtime.advance(160);
    const idxs = runtime.events().map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
    expect(runtime.events().every((e) => e.gameTime >= T0)).toBe(true);
    expect(runtime.events().every((e) => e.wallTime > 0)).toBe(true);
  });

  test('advances game time by what it is given, and only by that', () => {
    const runtime = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
    });
    runtime.advance(160);
    const after = runtime.time;
    expect(after).toBeGreaterThan(T0);
    expect(after).toBeLessThanOrEqual(T0 + 160);

    // docs/11 §4.5: elapsed real time is consumed unconditionally and simulated conditionally.
    // A caller that skips `advance` while hidden leaves game time exactly where it was, so the
    // gap is discarded rather than replayed as a burst of model calls on wake.
    runtime.advance(0);
    runtime.advance(-5_000_000);
    expect(runtime.time).toBe(after);
  });

  test('advances by the whole span asked for, rather than clamping at one step', () => {
    // docs/13 §3.1: `runTicks` simulates at most maxTicksPerStep * tickDuration -- 9,616ms at the
    // shipped 600x16 -- so taking its result as the new clock without looping moved a seven-day
    // fast-forward by 9.6 seconds and dropped the rest, silently. A night's sleep at the shipped
    // 20x is 1,080,000ms of game time, which is the case this has to survive (docs/13 §3.4).
    const runtime = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
    });
    const sleep = 6 * 3600 * 50; // six fiction hours, at 50ms of game time per story second
    runtime.advance(sleep);
    expect(runtime.time).toBeGreaterThanOrEqual(T0 + sleep);
    // Still bounded by one tick of overshoot, not running away.
    expect(runtime.time).toBeLessThan(T0 + sleep + 16);
  });

  test('stamps story time on the log when the host has a story clock, and omits it otherwise', () => {
    // docs/13 §3.3: story time is stamped rather than derived, because §3.1 shows two worlds at
    // the same game time holding different story times.
    let story = 64_800;
    const withClock = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
      storyTime: () => story,
    });
    expect(withClock.events().every((e) => e.storyTime === 64_800)).toBe(true);

    // An authored cut moves the fiction with no simulation time passing at all (docs/13 §3.4), so
    // the next event carries the new story time on the same game time.
    story = 68_400;
    const before = withClock.time;
    withClock.send('createEntity', { name: 'late' } as never);
    const last = withClock.events().at(-1)!;
    expect(last.storyTime).toBe(68_400);
    expect(last.gameTime).toBe(before);

    const without = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
    });
    expect(without.events().every((e) => e.storyTime === undefined)).toBe(true);
  });

  test('a world may start at game time zero', () => {
    // `MemoryWorld` starts at 0 and docs/13 §3.2 seeds the agentic clock from it. The falsy
    // start-of-step test this replaces sent such a world to `now` and dropped the first interval.
    const runtime = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: 0,
      godEnabled: false,
    });
    runtime.advance(160);
    expect(runtime.time).toBeGreaterThan(0);
    expect(runtime.time).toBeLessThanOrEqual(160);
  });

  test('runs the operations the simulation asks for, and takes their result back as input', async () => {
    const ran: string[] = [];
    const runtime = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
      runOperation: async (ctx, name, args) => {
        ran.push(name);
        // A real operation ends here too: never by writing world state, always by sending an
        // input (docs/05 §9).
        if (name === 'agentDecide') {
          await ctx.inputs.send('agentDecideAction', {
            agentId: args.agentId,
            operationId: args.operationId,
            action: 'idle',
            durationMs: 5000,
            description: 'stub',
            emoji: '🧪',
            reason: 'stubbed',
            problems: [],
          } as never);
        }
      },
    });

    // Long enough for the agents to get past their first decision gate.
    for (let i = 0; i < 80; i++) {
      runtime.advance(160);
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ran).toContain('agentDecide');
    const decisions = runtime.events().filter((e) => e.name === 'agentDecideAction');
    expect(decisions.length).toBeGreaterThan(0);
  });

  test('an operation that throws is contained, and the world keeps ticking', async () => {
    const runtime = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
      runOperation: async () => {
        throw new Error('model unreachable');
      },
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 80; i++) {
      runtime.advance(160);
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.time).toBeGreaterThan(T0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a world and its memories come back together from one snapshot', async () => {
    const runtime = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
    });
    runtime.advance(160);
    await runtime.store.insertMemory({
      playerId: 'p:1' as never,
      description: 'The well was cold.',
      importance: 4,
      lastAccess: T0,
      data: { type: 'conversation', conversationId: 'c:1' as never, playerIds: [] },
      embedding: [1, 0],
    });
    const saved = JSON.parse(JSON.stringify(runtime.snapshot()));
    const populated = runtime.game.world.entities.size + runtime.game.world.players.size;

    // A world rebuilt from its file, then restored: the same entities standing in the same
    // places, and the same memories behind them. Memory and state travel in one document on
    // purpose — a world restored without its memories is a different world.
    const fresh = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
    });
    fresh.restore(saved);
    expect(fresh.game.world.entities.size + fresh.game.world.players.size).toBe(populated);
    expect(fresh.time).toBe(runtime.time);
    expect((await fresh.store.recentMemories('p:1', 5))[0].description).toBe('The well was cold.');
  });

  test('the store survives a round trip, so memory is saved the way state is', async () => {
    const store = new InMemoryAgentStore();
    store.appendEntityState('e:1', 1, 'A door. It is shut.');
    await store.insertMemory({
      playerId: 'p:1' as never,
      description: 'I met someone at the well.',
      importance: 7,
      lastAccess: T0,
      data: { type: 'conversation', conversationId: 'c:1' as never, playerIds: [] },
      embedding: [0.1, 0.9],
    });
    await store.appendGodTranscript({ role: 'event', content: 'something happened' });

    const restored = InMemoryAgentStore.restore(JSON.parse(JSON.stringify(store.snapshot())));
    expect(await restored.readEntityState('e:1')).toBe('A door. It is shut.');
    expect((await restored.recentMemories('p:1', 10))[0].description).toBe(
      'I met someone at the well.',
    );
    expect((await restored.godTranscript(10))[0].content).toBe('something happened');
    // The ranking is the agent layer's, but the candidate search is the store's.
    const hits = await restored.searchMemories('p:1', [0.1, 0.9], 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });
});

describe("an entity's patch to the world's record (docs/13 §4)", () => {
  /** The world file ships a paragraph, so `__world__` already has a version before any patch. */
  const started = () => {
    const runtime = createAgenticWorld({
      content: fixtureContent(),
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
    });
    runtime.advance(160);
    // An actor keeps its prose under its player id (`applyStateUpdate`), so a state write from one
    // has to be addressed that way — the entity name is not an id anything holds.
    const [first, second] = [...runtime.game.world.players.keys()];
    return { runtime, first, second };
  };

  test('merges into the record and leaves the authored paragraph standing', () => {
    const { runtime, first } = started();
    const before = runtime.store.readEntityStateSync('__world__') ?? '';
    expect(before).toContain('The river is low');

    runtime.send('entityUpdateState', {
      entityId: first,
      state: 'state: excited\n\nI told someone at last.',
      reason: 'the conversation ended',
      world: '<tasks>\ns01-door-tag = ask_ash\n</tasks>',
    });
    runtime.advance(160);

    const after = runtime.store.readEntityStateSync('__world__') ?? '';
    // The patch said nothing about the paragraph, so the paragraph is the one that was there.
    expect(after).toContain('The river is low');
    expect(after).toContain('s01-door-tag = ask_ash');
  });

  test('two entities patching different lines do not lose each other', () => {
    const { runtime, first, second } = started();
    runtime.send('entityUpdateState', {
      entityId: first,
      reason: 'r',
      world: '<tasks>\ns01-door-tag = ask_ash\n</tasks>',
    });
    runtime.send('entityUpdateState', {
      entityId: second,
      reason: 'r',
      world: '<player_items>\n"door tag" = 1\n</player_items>',
    });
    runtime.advance(160);

    const after = runtime.store.readEntityStateSync('__world__') ?? '';
    expect(after).toContain('s01-door-tag = ask_ash');
    expect(after).toContain('"door tag" = 1');
  });

  test('the audit says which entity moved the line, since the document is the world’s', () => {
    const { runtime, first } = started();
    runtime.send('entityUpdateState', {
      entityId: first,
      reason: 'the player brought me the tag',
      world: '<tasks>\ns01-door-tag = store\n</tasks>',
    });
    runtime.advance(160);

    const row = runtime.store
      .snapshot()
      .audits.filter((audit) => audit.entityId === '__world__')
      .at(-1);
    expect(row?.source).toBe('record');
    expect(row?.writtenBy).toBe(first);
  });

  test('a patch that is only prose writes nothing at all', () => {
    const { runtime, first } = started();
    const versionsBefore = runtime.store
      .snapshot()
      .entityState.find(([id]) => id === '__world__')?.[1].length;

    runtime.send('entityUpdateState', {
      entityId: first,
      reason: 'r',
      world: 'state: uneasy\n\nThe whole town is talking about it.',
    });
    runtime.advance(160);

    const versionsAfter = runtime.store
      .snapshot()
      .entityState.find(([id]) => id === '__world__')?.[1].length;
    // §4.2 leaves the paragraph to the god, and a version allocated for nothing is worse than a
    // write that never happened.
    expect(versionsAfter).toBe(versionsBefore);
  });
});

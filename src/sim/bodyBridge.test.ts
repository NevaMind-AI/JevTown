import { MemoryWorld } from '../../prototype/world';
import { fixtureContent } from '../../tests/fixtures/agenticWorld';
import { AgenticRuntime } from './agenticRuntime';
import { BodyBridge, GroundWorld } from './bodyBridge';
import { createAgenticWorld } from './createAgenticWorld';

/**
 * Both worlds, one frame loop, the way `LocalGame` drives them (docs/13 §2): positions in,
 * the agentic step, intents out, then the ground steps.
 *
 * The stubbed model has one opinion — Lucky walks over to Stella — and everyone else idles, so
 * what is under test is the plumbing rather than what a model says.
 */
const T0 = 1_700_000_000_000;
const FRAME_MS = 160;

function bothWorlds() {
  const content = fixtureContent();
  const ground = new MemoryWorld();
  ground.load(content.scenes, content.story, content.npcs, content.world);

  let runtime!: AgenticRuntime;
  const sourceOf = (playerId: string) =>
    runtime.game.world.players.get(playerId as never)?.sourceId;
  runtime = createAgenticWorld({
    content,
    worldId: 'w',
    startTime: T0,
    godEnabled: false,
    runOperation: async (ctx, name, args) => {
      if (name !== 'agentDecide') return;
      const stella = (args.manifest.targets as { id: string }[]).find(
        (t) => sourceOf(t.id) === 'stella',
      );
      const decision =
        sourceOf(args.playerId) === 'lucky' && stella
          ? { action: 'approach', target: stella.id, intent: 'the river', reason: 'stub' }
          : { action: 'idle', durationMs: 300_000, description: 'waiting', reason: 'stub' };
      await ctx.inputs.send('agentDecideAction', {
        agentId: args.agentId,
        operationId: args.operationId,
        ...decision,
      } as never);
    },
  });
  let n = 0;
  const bridge = new BodyBridge(runtime, ground, () => `bridge-${n++}`);

  const frame = async () => {
    bridge.syncIn();
    runtime.advance(FRAME_MS);
    await Promise.resolve();
    bridge.applyMoves();
    ground.advance(FRAME_MS);
  };
  return { ground, runtime, bridge, frame };
}

const manhattan = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

describe('the two worlds, bridged', () => {
  test('a decision walks a body on the ground, and arrival starts a conversation', async () => {
    const { ground, runtime, frame } = bothWorlds();
    const start = ground.inspect().entities.lucky.position;
    let talking = false;
    for (let i = 0; i < 400 && !talking; i++) {
      await frame();
      talking = runtime.game.world.conversations.size > 0;
    }
    expect(talking).toBe(true);
    const { lucky, stella } = ground.inspect().entities;
    expect(lucky.position).not.toEqual(start);
    expect(manhattan(lucky.position, stella.position)).toBe(1);

    const [conversation] = runtime.game.world.conversations.values();
    const members = [...conversation.participants.keys()].map(
      (id) => runtime.game.world.players.get(id)?.sourceId,
    );
    expect(members.sort()).toEqual(['lucky', 'stella']);
  });

  test('the walk is on the ground’s record, as an intent', async () => {
    const { ground, runtime, frame } = bothWorlds();
    for (let i = 0; i < 400 && runtime.game.world.conversations.size === 0; i++) await frame();
    const recorded = JSON.stringify(ground.recording().events);
    expect(recorded).toContain('"type":"approachEntity"');
    expect(recorded).toContain('"entity":"lucky"');
    expect(recorded).toContain('"target":"stella"');
  });

  test('and the engine learned where everybody is from its own log', async () => {
    const { runtime, frame } = bothWorlds();
    for (let i = 0; i < 400 && runtime.game.world.conversations.size === 0; i++) await frame();
    const syncs = runtime.events().filter((e) => e.name === 'syncBodies');
    expect(syncs.length).toBeGreaterThan(0);
  });
});

describe('BodyBridge', () => {
  test('a still world sends nothing after the first frame', () => {
    const { runtime, bridge } = bothWorlds();
    runtime.advance(FRAME_MS);
    bridge.syncIn();
    const after = runtime.events().filter((e) => e.name === 'syncBodies').length;
    bridge.syncIn();
    bridge.syncIn();
    expect(runtime.events().filter((e) => e.name === 'syncBodies').length).toBe(after);
  });

  test('the first sync carries every body the world file created', () => {
    const { runtime, bridge } = bothWorlds();
    runtime.advance(FRAME_MS);
    bridge.syncIn();
    const [sync] = runtime.events().filter((e) => e.name === 'syncBodies');
    const ids = (sync.args as { bodies: { sourceId: string }[] }).bodies.map((b) => b.sourceId);
    expect(ids.sort()).toEqual(['alice', 'bob', 'lucky', 'pete', 'stella']);
  });

  test('a move the ground refuses comes back as bodyMoveFailed', () => {
    const content = fixtureContent();
    const runtime = createAgenticWorld({
      content,
      worldId: 'w',
      startTime: T0,
      godEnabled: false,
      runOperation: async () => {},
    });
    const refusing: GroundWorld = {
      inspect: () => ({ entities: {} }),
      execute: () => ({ ok: false, error: 'Nowhere free beside the target' }),
    };
    runtime.game.queueMove({ kind: 'approach', body: 'lucky', target: 'stella' });
    runtime.advance(FRAME_MS);
    new BodyBridge(runtime, refusing, () => 'x').applyMoves();
    const failed = runtime.events().find((e) => e.name === 'bodyMoveFailed');
    expect(failed?.args).toEqual({
      body: 'lucky',
      kind: 'approach',
      reason: 'Nowhere free beside the target',
    });
  });
});

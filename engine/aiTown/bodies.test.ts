import { createAgenticWorld } from '../../src/sim/createAgenticWorld';
import { fixtureContent } from '../../tests/fixtures/agenticWorld';
import { buildManifest } from './manifest';
import type { Player } from './player';

/**
 * The engine's side of bodies (docs/13 §2): it moves nothing, is told where bodies are, and says
 * where agents want them to go.
 */
const T0 = 1_700_000_000_000;

function world() {
  const runtime = createAgenticWorld({
    content: fixtureContent(),
    worldId: 'w',
    startTime: T0,
    godEnabled: false,
    runOperation: async () => {},
  });
  runtime.advance(160);
  const bySource = (id: string) =>
    runtime.game.world.sortedPlayers().find((p) => p.sourceId === id) as Player;
  const agentOf = (player: Player) =>
    [...runtime.game.world.agents.values()].find((a) => a.playerId === player.id)!;
  return { runtime, game: runtime.game, bySource, agentOf };
}

describe('the ground', () => {
  test('is the content package’s scenes, one map each', () => {
    const { game } = world();
    expect([...game.maps.keys()].sort()).toEqual(['corridor', 'room']);
    expect(game.defaultScene).toBe('room');
    expect(game.mapFor('room').anchor('crossroads')).toMatchObject({ x: 6, y: 3 });
  });

  test('bodies are created where their counterparts are placed', () => {
    const { bySource } = world();
    expect(bySource('lucky').position).toEqual({ x: 2, y: 2 });
    expect(bySource('stella').position).toEqual({ x: 6, y: 3 });
  });

  test('the engine moves nobody on its own', () => {
    const { runtime, bySource } = world();
    const before = bySource('lucky').position;
    for (let i = 0; i < 50; i++) runtime.advance(160);
    expect(bySource('lucky').position).toEqual(before);
  });
});

describe('syncBodies', () => {
  test('puts a body where the ground says it is', () => {
    const { runtime, bySource } = world();
    runtime.send('syncBodies', {
      bodies: [
        {
          sourceId: 'lucky',
          scene: 'corridor',
          x: 4,
          y: 3,
          walking: true,
          facing: { dx: -1, dy: 0 },
        },
      ],
    });
    runtime.advance(160);
    const lucky = bySource('lucky');
    expect(lucky.position).toEqual({ x: 4, y: 3 });
    expect(lucky.scene).toBe('corridor');
    expect(lucky.facing).toEqual({ dx: -1, dy: 0 });
    expect(lucky.speed).toBe(1);
  });

  test('a body nobody has is ignored rather than refused', () => {
    const { runtime } = world();
    runtime.send('syncBodies', {
      bodies: [
        { sourceId: 'ghost', scene: 'room', x: 1, y: 1, walking: false, facing: { dx: 1, dy: 0 } },
      ],
    });
    expect(() => runtime.advance(160)).not.toThrow();
  });
});

describe('an agent’s decision leaves as an intent', () => {
  test('approach queues an approach by authored id, and waits for arrival', () => {
    const { runtime, game, bySource, agentOf } = world();
    const lucky = bySource('lucky');
    const agent = agentOf(lucky);
    agent.inProgressOperation = { name: 'agentDecide', operationId: 'op', started: runtime.time };
    runtime.send('agentDecideAction', {
      agentId: agent.id,
      operationId: 'op',
      action: 'approach',
      target: bySource('stella').id,
      intent: 'ask about the river',
      reason: 'test',
    });
    runtime.advance(160);
    expect(runtime.takeMoves()).toEqual([{ kind: 'approach', body: 'lucky', target: 'stella' }]);
    expect(agent.pendingInteraction?.targetId).toBe(bySource('stella').id);
    expect(game.world.conversations.size).toBe(0);
  });

  test('wander queues the place, not a tile', () => {
    const { runtime, bySource, agentOf } = world();
    const agent = agentOf(bySource('lucky'));
    agent.inProgressOperation = { name: 'agentDecide', operationId: 'op', started: runtime.time };
    runtime.send('agentDecideAction', {
      agentId: agent.id,
      operationId: 'op',
      action: 'wander',
      anchor: 'crossroads',
      reason: 'test',
    });
    runtime.advance(160);
    expect(runtime.takeMoves()).toEqual([{ kind: 'wander', body: 'lucky', anchor: 'crossroads' }]);
  });

  test('a place this scene does not have is not asked for', () => {
    const { runtime, bySource, agentOf } = world();
    const agent = agentOf(bySource('lucky'));
    agent.inProgressOperation = { name: 'agentDecide', operationId: 'op', started: runtime.time };
    runtime.send('agentDecideAction', {
      agentId: agent.id,
      operationId: 'op',
      action: 'wander',
      anchor: 'entrance', // the corridor's
      reason: 'test',
    });
    runtime.advance(160);
    expect(runtime.takeMoves()).toEqual([]);
  });

  test('a move that could not start clears the approach, so the agent decides again', () => {
    const { runtime, bySource, agentOf } = world();
    const agent = agentOf(bySource('lucky'));
    agent.pendingInteraction = {
      targetId: bySource('stella').id,
      intent: '',
      startedWalking: runtime.time,
    };
    runtime.send('bodyMoveFailed', {
      body: 'lucky',
      kind: 'approach',
      reason: 'Nowhere free beside the target',
    });
    runtime.advance(160);
    expect(agent.pendingInteraction).toBeUndefined();
  });

  test('arrival starts the conversation, and asks both bodies to stop', () => {
    const { runtime, game, bySource, agentOf } = world();
    const lucky = bySource('lucky');
    const stella = bySource('stella');
    const agent = agentOf(lucky);
    agent.inProgressOperation = { name: 'agentDecide', operationId: 'op', started: runtime.time };
    runtime.send('agentDecideAction', {
      agentId: agent.id,
      operationId: 'op',
      action: 'approach',
      target: stella.id,
      intent: '',
      reason: 'test',
    });
    runtime.advance(160);
    runtime.takeMoves();
    // The ground reports lucky beside stella, at (6, 3).
    runtime.send('syncBodies', {
      bodies: [
        { sourceId: 'lucky', scene: 'room', x: 5, y: 3, walking: false, facing: { dx: 1, dy: 0 } },
      ],
    });
    runtime.advance(160);
    expect(game.world.conversations.size).toBe(1);
    expect(agent.pendingInteraction).toBeUndefined();
    expect(runtime.takeMoves()).toEqual(
      expect.arrayContaining([
        { kind: 'stop', body: 'lucky' },
        { kind: 'stop', body: 'stella' },
      ]),
    );
  });
});

describe('the manifest', () => {
  test('offers only what shares the agent’s scene', () => {
    const { runtime, game, bySource, agentOf } = world();
    runtime.send('syncBodies', {
      bodies: [
        {
          sourceId: 'stella',
          scene: 'corridor',
          x: 4,
          y: 3,
          walking: false,
          facing: { dx: 1, dy: 0 },
        },
      ],
    });
    runtime.advance(160);
    const lucky = bySource('lucky');
    const manifest = buildManifest(game, runtime.time, agentOf(lucky), lucky);
    const names = manifest.targets.map((t) => t.name);
    expect(names).not.toContain('Stella');
    expect(names).toContain('Bob');
    expect(manifest.places.map((p) => p.id)).toContain('crossroads');
    expect(manifest.places.map((p) => p.id)).not.toContain('entrance');
  });
});

import { createAgenticWorld } from '../../src/sim/createAgenticWorld';
import { Conversation } from './conversation';
import { ConversationMembership } from './conversationMembership';
import type { Game } from './game';
import type { Player } from './player';
import { World } from './world';
import worldFile from '../../data/world.json';

const T0 = 1_700_000_000_000;

/** A populated world, then two mobile actors out of it. */
function twoActors(): { game: Game; a: Player; b: Player } {
  const runtime = createAgenticWorld({ worldId: 'w', startTime: T0, godEnabled: false });
  runtime.advance(160);
  const game = runtime.game;
  const [a, b] = game.world.sortedPlayers();
  expect(a && b).toBeTruthy();
  return { game, a, b };
}

describe('a conversation is what arrival produces (docs/13 §2)', () => {
  test('two actors standing apart cannot start one', () => {
    const { game, a, b } = twoActors();
    a.position = { x: 2, y: 2 };
    b.position = { x: 20, y: 20 };
    const result = Conversation.start(game, T0, a, b);
    expect(result.conversationId).toBeUndefined();
    expect(result.error).toMatch(/too far/);
    expect(game.world.conversations.size).toBe(0);
  });

  test('adjacent, it starts, and both are talking from the first tick', () => {
    const { game, a, b } = twoActors();
    a.position = { x: 5, y: 5 };
    b.position = { x: 6, y: 5 };
    const { conversationId, error } = Conversation.start(game, T0, a, b);
    expect(error).toBeUndefined();
    const conversation = game.world.conversations.get(conversationId!)!;
    expect([...conversation.participants.values()].map((m) => m.status.kind)).toEqual([
      'participating',
      'participating',
    ]);
    expect([...conversation.participants.values()].every((m) => m.status.started === T0)).toBe(
      true,
    );
  });

  test('they face each other once, with nothing left to orient them later', () => {
    const { game, a, b } = twoActors();
    a.position = { x: 5, y: 5 };
    b.position = { x: 6, y: 5 };
    Conversation.start(game, T0, a, b);
    expect(a.facing).toEqual({ dx: 1, dy: 0 });
    expect(b.facing).toEqual({ dx: -1, dy: 0 });
  });

  test('starting one stops both walkers, so neither wanders out of it', () => {
    const { game, a, b } = twoActors();
    a.position = { x: 5, y: 5 };
    b.position = { x: 6, y: 5 };
    a.pathfinding = { destination: { x: 9, y: 9 }, started: T0, state: { kind: 'needsPath' } };
    Conversation.start(game, T0, a, b);
    expect(a.pathfinding).toBeUndefined();
    expect(b.pathfinding).toBeUndefined();
  });

  test('the engine no longer walks anybody on a conversation tick', () => {
    expect('tick' in Conversation.prototype).toBe(false);
  });
});

describe('the typing lock expires when it is read', () => {
  const conversation = () =>
    new Conversation({
      id: 'c:0',
      creator: 'p:0',
      created: T0,
      numMessages: 0,
      participants: [],
    });

  test('a live lock is held', () => {
    const c = conversation();
    c.isTyping = { playerId: 'p:0' as never, messageUuid: 'u', since: T0 };
    expect(c.activeTyping(T0 + 1_000)?.messageUuid).toBe('u');
  });

  test('a lock left behind by a dead model call is not', () => {
    const c = conversation();
    c.isTyping = { playerId: 'p:0' as never, messageUuid: 'u', since: T0 };
    expect(c.activeTyping(T0 + 60_000)).toBeUndefined();
  });

  test('and the other participant can then take it', () => {
    const c = conversation();
    c.isTyping = { playerId: 'p:0' as never, messageUuid: 'u', since: T0 };
    c.setIsTyping(T0 + 60_000, { id: 'p:2' } as Player, 'v');
    expect(c.isTyping?.playerId).toBe('p:2');
  });

  test('a live lock still belongs to whoever holds it', () => {
    const c = conversation();
    c.isTyping = { playerId: 'p:0' as never, messageUuid: 'u', since: T0 };
    expect(() => c.setIsTyping(T0 + 1_000, { id: 'p:2' } as Player, 'v')).toThrow('already typing');
  });
});

describe('membership states that no longer exist', () => {
  test('a world saved mid-walk reads as one where the pair already met', () => {
    for (const kind of ['invited', 'walkingOver'] as const) {
      const member = new ConversationMembership({
        playerId: 'p:0',
        invited: T0,
        status: { kind } as never,
      });
      expect(member.status).toEqual({ kind: 'participating', started: T0 });
    }
  });

  test('a current membership is read unchanged', () => {
    const member = new ConversationMembership({
      playerId: 'p:0',
      invited: T0,
      status: { kind: 'participating', started: T0 + 5 },
    });
    expect(member.status).toEqual({ kind: 'participating', started: T0 + 5 });
  });
});

describe('the authored id survives into the engine (docs/13 §2)', () => {
  test('every body created from the world file carries the id the file gave it', () => {
    const runtime = createAgenticWorld({ worldId: 'w', startTime: T0, godEnabled: false });
    runtime.advance(160);
    const authored = worldFile.entities.map((e) => e.id).sort();
    const carried = [
      ...runtime.game.world.sortedPlayers().map((p) => p.sourceId),
      ...runtime.game.world.sortedEntities().map((e) => e.sourceId),
    ]
      .filter((id): id is string => id !== undefined)
      .sort();
    expect(carried).toEqual(authored);
  });

  test('it survives a round trip through serialization', () => {
    const runtime = createAgenticWorld({ worldId: 'w', startTime: T0, godEnabled: false });
    runtime.advance(160);
    const before = runtime.game.world.sortedPlayers().map((p) => p.sourceId);
    const after = new World(runtime.game.world.serialize()).sortedPlayers().map((p) => p.sourceId);
    expect(after).toEqual(before);
    expect(after.every((id) => typeof id === 'string')).toBe(true);
  });
});

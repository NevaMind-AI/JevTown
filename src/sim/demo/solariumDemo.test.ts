import { jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { loadPackage } from '../../../prototype/package';
import { Scene, mapBlocked } from '../../../prototype/content';
import { createAgenticWorld } from '../createAgenticWorld';
import { solariumWorldSource, SOLARIUM_SCENE_ID, SOLARIUM_PLACES } from './solariumWorld';

/**
 * The solarium demo, driven without a model.
 *
 * What is under test is the join, not the agent layer: `src/sim/agenticRuntime.test.ts` already
 * covers the loop over `data/gentle.js`, so everything new here is whether a `dev` scene can
 * stand in for that map. Three things have to hold, and each has a way of being quietly wrong:
 *
 *   - The world **builds**. `validateWorldFile` is strict about anchors and characters, and a
 *     transposed collision grid would not fail validation -- it would place five agents inside
 *     walls and look like a pathfinding bug an hour later.
 *   - Agents **move**. A destination they can reach means the collision layer is oriented the way
 *     the engine reads it.
 *   - A conversation **runs to a message**. That is the whole chain -- decide, invite, accept,
 *     walk into range, take the typing lock, send -- and it is the thing a one-shot demo exists
 *     to show.
 *
 * The model is stubbed exactly as the sibling suite stubs it: an operation never writes world
 * state, it sends an input, so a stub that sends the same inputs drives the same simulation.
 */

const T0 = 1_700_000_000_000;

/**
 * The content package, off disk.
 *
 * `loadScene.ts` is the browser's version of this and cannot be reused: it resolves maps through
 * `import.meta.glob`, which only exists under Vite. The split it works around is real, though --
 * scenes and stories are served from `public/`, maps are bundled from `src/` -- so this tries
 * both, which is the same rule by other means.
 */
async function loadSolarium(): Promise<Scene> {
  const read = async (relative: string) => {
    for (const base of ['public/content/remaining-time', 'src/content/remaining-time']) {
      try {
        return JSON.parse(await readFile(`${base}/${relative}`, 'utf8'));
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    throw new Error(`Not found in either content root: ${relative}`);
  };
  const content = await loadPackage(await read('manifest.json'), read);
  const scene = content.scenes.find((candidate) => candidate.id === SOLARIUM_SCENE_ID);
  if (!scene) throw new Error(`No ${SOLARIUM_SCENE_ID} scene in the package`);
  return scene;
}

describe('the solarium demo world', () => {
  let scene: Scene;
  beforeAll(async () => {
    scene = await loadSolarium();
  });

  test('every authored place is a walkable tile inside the map', () => {
    for (const [id, spec] of Object.entries(SOLARIUM_PLACES)) {
      const x = spec.x ?? scene.anchors[id][0];
      const y = spec.y ?? scene.anchors[id][1];
      expect({ id, blocked: mapBlocked(scene.map, x, y) }).toEqual({ id, blocked: false });
    }
  });

  test('builds five agents and two props out of the world file', () => {
    const runtime = createAgenticWorld({
      source: solariumWorldSource(scene),
      worldId: 'solarium-demo',
      startTime: T0,
      godEnabled: false,
    });
    runtime.advance(160);
    expect(runtime.game.world.players.size).toBe(5);
    expect(runtime.game.world.agents.size).toBe(5);
    expect(runtime.game.world.entities.size).toBe(2);
    // A prop is only offered as a target when it has state to learn (`initialPhysics`), which is
    // the reason both props in the file declare one.
    expect(runtime.game.world.sortedEntities().every((e) => e.physics.interactable)).toBe(true);
  });

  test('places every agent on a free tile, in the room and not in a wall', () => {
    const runtime = createAgenticWorld({
      source: solariumWorldSource(scene),
      worldId: 'solarium-demo',
      startTime: T0,
      godEnabled: false,
    });
    runtime.advance(160);
    for (const player of runtime.game.world.sortedPlayers()) {
      const { x, y } = player.position;
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
      expect(mapBlocked(scene.map, x, y)).toBe(false);
    }
  });

  test('the god never runs, because the demo world does not have one', () => {
    const runGod = jest.fn(async () => {});
    const runtime = createAgenticWorld({
      source: solariumWorldSource(scene),
      worldId: 'solarium-demo',
      startTime: T0,
      runGod,
    });
    // Well past GOD_INTERVAL, which is 30s of game time.
    for (let i = 0; i < 400; i++) runtime.advance(160);
    expect(runGod).not.toHaveBeenCalled();
  });

  test('agents decide, walk, and carry a conversation as far as a delivered message', async () => {
    const spoken: string[] = [];
    const runtime = createAgenticWorld({
      source: solariumWorldSource(scene),
      worldId: 'solarium-demo',
      startTime: T0,
      godEnabled: false,
      runOperation: async (ctx, name, args) => {
        switch (name) {
          case 'agentDecide': {
            // Stand in for the model by taking the first person on offer. The manifest is the
            // engine's own filtered option set, so choosing out of it is exactly what a real
            // decision does -- minus the judgement.
            const someone = args.manifest.targets.find((t: any) => t.what === 'a person');
            await ctx.inputs.send('agentDecideAction', {
              agentId: args.agentId,
              operationId: args.operationId,
              ...(someone
                ? { action: 'approach', target: someone.id, intent: 'say hello' }
                : { action: 'wander', anchor: 'central-hall' }),
              reason: 'stubbed',
              problems: [],
            } as never);
            return;
          }
          case 'agentGenerateMessage': {
            const text = `stub ${args.type} from ${args.playerId}`;
            spoken.push(text);
            await ctx.store.insertMessage({
              conversationId: args.conversationId,
              messageUuid: args.messageUuid,
              author: args.playerId,
              text,
              createdAt: Date.now(),
            });
            await ctx.inputs.send('agentFinishSendingMessage', {
              conversationId: args.conversationId,
              agentId: args.agentId,
              timestamp: Date.now(),
              leaveConversation: args.type === 'leave',
              operationId: args.operationId,
            } as never);
            return;
          }
          case 'agentRememberConversation':
            await ctx.inputs.send('finishRememberConversation', {
              agentId: args.agentId,
              operationId: args.operationId,
            } as never);
            return;
          default:
            return;
        }
      },
    });

    const startPositions = new Map<string, string>();
    runtime.advance(160);
    for (const player of runtime.game.world.sortedPlayers()) {
      startPositions.set(player.id, `${player.position.x},${player.position.y}`);
    }

    // Long enough to cover MIN_DECISION_INTERVAL, the walk into CONVERSATION_DISTANCE, and the
    // typing round trip; it exits as soon as the thing it is waiting for has happened.
    // Conversations are watched inside the loop rather than after it: `Conversation.start` runs
    // inside the input handler rather than sending an input of its own, so a conversation that
    // begins and ends leaves nothing in the log to find afterwards.
    let sawConversation = false;
    for (let i = 0; i < 3000 && spoken.length === 0; i++) {
      runtime.advance(160);
      sawConversation ||= runtime.game.world.conversations.size > 0;
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    const moved = runtime.game.world
      .sortedPlayers()
      .filter((p) => startPositions.get(p.id) !== `${p.position.x},${p.position.y}`);
    expect(moved.length).toBeGreaterThan(0);
    expect(runtime.events().some((e) => e.name === 'agentDecideAction')).toBe(true);
    expect(sawConversation).toBe(true);
    expect(spoken.length).toBeGreaterThan(0);
  }, 30_000);
});

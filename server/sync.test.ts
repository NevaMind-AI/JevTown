import { spawn, ChildProcess } from 'node:child_process';
import { createAgenticWorld } from '../src/sim/createAgenticWorld';
import { MemoryOutbox, SyncClient } from '../src/sim/syncClient';
import type { BatchRequest } from './protocol';

/**
 * The four things docs/11 §4 promises, against a real database.
 *
 * Skipped unless `DATABASE_URL` is set, so `npm test` stays green on a machine with no Postgres.
 * Bring one up with `docker compose up -d postgres` and re-run; the acceptance criteria for this
 * phase are exactly the tests below, and none of them is meaningful against a fake.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.SYNC_TEST_PORT) || 3399;
const BASE = `http://127.0.0.1:${PORT}/worlds`;
const T0 = 1_700_000_000_000;

let server: ChildProcess | undefined;

async function startServer() {
  server = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
    env: { ...process.env, MODEL_PROXY_PORT: String(PORT), DATABASE_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not report storage ready')), 20000);
    server!.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Storage ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server!.stderr!.on('data', (chunk: Buffer) => console.error(chunk.toString()));
  });
}

/** A world, its runtime, and a client pointed at the server. */
async function session(
  worldId: string,
  options: { sessionId?: string; outbox?: MemoryOutbox } = {},
) {
  await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: worldId, name: worldId }),
  });
  const runtime = createAgenticWorld({
    worldId,
    startTime: T0,
    godEnabled: false,
    // These tests are about storage, not about what a model says. A no-op operation also keeps
    // them from reaching a real provider by accident.
    runOperation: async () => {},
  });
  const sync = new SyncClient({
    worldId,
    runtime,
    baseUrl: BASE,
    sessionId: options.sessionId,
    outbox: options.outbox,
  });
  return { runtime, sync };
}

async function countEvents(worldId: string) {
  const response = await fetch(`${BASE}/${worldId}/events?from=0&to=999999`);
  const { events } = (await response.json()) as { events: unknown[] };
  return events.length;
}

const suite = DATABASE_URL ? describe : describe.skip;

suite('storage, against a real database', () => {
  beforeAll(async () => {
    await startServer();
  }, 30000);

  afterAll(() => {
    server?.kill();
  });

  test('killing the tab mid-batch loses that batch and nothing before it', async () => {
    const worldId = `kill-${Date.now()}`;
    const first = await session(worldId, { sessionId: 'tab-1' });
    await first.sync.start();
    first.runtime.advance(160);
    const acknowledged = await first.sync.flush();
    expect(acknowledged?.ok).toBe(true);
    const storedVersion = first.sync.version;
    const storedEvents = await countEvents(worldId);
    expect(storedEvents).toBeGreaterThan(0);

    // The tab dies here: more happens locally, and the batch carrying it never reaches anyone.
    // Its outbox dies with it, which is what "at most the last batch" means.
    first.runtime.advance(160);
    first.runtime.send('createEntity', { kind: 'prop', id: 'ghost' } as never);

    const resumed = await session(worldId, { sessionId: 'tab-2' });
    const bootstrapped = await resumed.sync.bootstrap();
    expect(bootstrapped).not.toBeNull();
    expect(bootstrapped!.state!.version).toBe(storedVersion);
    expect(await countEvents(worldId)).toBe(storedEvents);
  }, 30000);

  test('two tabs cannot both write: the loser goes read-only and the log stays one history', async () => {
    const worldId = `two-tabs-${Date.now()}`;
    const a = await session(worldId, { sessionId: 'tab-A' });
    await a.sync.start();
    a.runtime.advance(160);
    expect((await a.sync.flush())?.ok).toBe(true);

    const reasons: string[] = [];
    const b = await session(worldId, { sessionId: 'tab-B' });
    b.sync = new SyncClient({
      worldId,
      runtime: b.runtime,
      baseUrl: BASE,
      sessionId: 'tab-B',
      onReadOnly: (reason) => reasons.push(reason),
    });
    // B takes the lease, which is what reopening a world after a crash looks like.
    await b.sync.start();

    // A keeps playing, unaware. Its next batch is the one that must not land.
    a.runtime.advance(160);
    a.runtime.send('createEntity', { kind: 'prop', id: 'from-tab-a' } as never);
    const rejected = await a.sync.flush();
    expect(rejected?.ok).toBe(false);
    expect(reasons.length).toBe(0); // B is fine; it is A that was told.
    expect(a.sync.isReadOnly).toBe(true);

    const events = await fetch(`${BASE}/${worldId}/events?from=0&to=999999`);
    const { events: rows } = (await events.json()) as { events: { idx: number }[] };
    const idxs = rows.map((row) => row.idx);
    expect(new Set(idxs).size).toBe(idxs.length);
    expect(idxs).toEqual([...idxs].sort((x, y) => x - y));
  }, 30000);

  test('a batch retried after a timeout is a no-op, not a duplication', async () => {
    const worldId = `retry-${Date.now()}`;
    const sent: BatchRequest[] = [];
    const runtimeWorld = await session(worldId, { sessionId: 'tab-R' });
    const sync = new SyncClient({
      worldId,
      runtime: runtimeWorld.runtime,
      baseUrl: BASE,
      sessionId: 'tab-R',
      // Capture what the client sends, so the retry is byte-identical to the original — which is
      // the case a network timeout actually produces.
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/batches')) {
          sent.push(JSON.parse(String(init?.body)) as BatchRequest);
        }
        return await fetch(input as never, init as never);
      },
    });
    await sync.start();
    runtimeWorld.runtime.advance(160);
    expect((await sync.flush())?.ok).toBe(true);

    const before = await countEvents(worldId);
    const replay = await fetch(`${BASE}/${worldId}/batches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sent[sent.length - 1]),
    });
    const body = (await replay.json()) as { ok: boolean; duplicate?: boolean };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(true);
    expect(await countEvents(worldId)).toBe(before);
  }, 30000);

  test('bootstrap alone restores a world, with its memories', async () => {
    const worldId = `restore-${Date.now()}`;
    const original = await session(worldId, { sessionId: 'tab-O' });
    await original.sync.start();
    original.runtime.advance(160);
    await original.runtime.store.insertMemory({
      playerId: 'p:1' as never,
      description: 'The mill yard smelled of rain.',
      importance: 6,
      lastAccess: T0,
      data: { type: 'conversation', conversationId: 'c:1' as never, playerIds: [] },
      embedding: [0.2, 0.4, 0.6],
    });
    original.runtime.store.appendEntityState('e:door', 1, 'A door. Shut, and swollen with damp.');
    expect((await original.sync.flush())?.ok).toBe(true);
    const populated = original.runtime.game.world.entities.size;

    // Nothing local survives: a different machine, or the same one with its storage cleared.
    const fresh = await session(worldId, { sessionId: 'tab-F' });
    const bootstrapped = await fresh.sync.bootstrap();
    expect(bootstrapped).not.toBeNull();
    // `world_state` holds the runtime snapshot minus the store; the store is its own tables.
    // Resume recombines them, which is the shape the client always writes.
    const worldHalf = bootstrapped!.state!.state as Record<string, unknown>;
    fresh.runtime.restore({ ...worldHalf, store: bootstrapped!.store } as never);

    expect(fresh.runtime.game.world.entities.size).toBe(populated);
    expect(await fresh.runtime.store.readEntityState('e:door')).toBe(
      'A door. Shut, and swollen with damp.',
    );
    const memories = await fresh.runtime.store.recentMemories('p:1', 5);
    expect(memories[0].description).toBe('The mill yard smelled of rain.');
    expect(memories[0].embedding).toEqual([0.2, 0.4, 0.6]);
  }, 30000);
});

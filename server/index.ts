import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { parse as parseEnv } from 'dotenv';
import { chatCompletion, fetchEmbeddingBatch, detectMismatchedLLMProvider } from './model/llm.ts';
import { systemOne, type SystemOneRequest } from './model/jev.ts';
import { recordObservation } from './model/langfuse.ts';
import type { TraceEntry } from '../agent/model/trace.ts';
import { databaseUrl, migrate } from './db/index.ts';
import {
  bearerToken,
  clientAddress,
  configureIdentity,
  LOCAL_OWNER,
  mintToken,
  verifyToken,
  WindowCounter,
} from './identity.ts';
import type { CreateWorldRequest, IdentityResponse } from './protocol.ts';
import {
  applyBatch,
  bootstrap,
  callsInWindow,
  claimSession,
  countWorlds,
  createWorld,
  listWorlds,
  newWorldId,
  ownsWorld,
  pruneIdleWorlds,
  readEmbeddings,
  readEvents,
  recordLlmCall,
  sha256,
  writeEmbeddings,
} from './worlds.ts';

/**
 * The key-holding model proxy.
 *
 * Under docs/11 §1 the browser owns the simulation, which means the browser is what wants to call
 * a model — and a browser is the last place a provider key belongs. This process holds the key,
 * picks the provider, retries, and exports traces to Langfuse. The tab talks to it over three
 * endpoints and never sees a credential.
 *
 * It also holds the spend limits of docs/11 §4.4. That is not a nicety: the client now drives the
 * bill, a bug in the decision loop can spend real money before anyone notices, and a limit that
 * lives in code the client can edit is not a limit. There are two: a crude process lifetime call
 * cap, and a per-owner quota read off `llm_calls`.
 *
 * One process serves both setups of docs/14 §4. Without `HOSTED` it is the permissive local
 * server: every request belongs to one owner and no token is checked. With `HOSTED=1` it serves
 * many anonymous players: a token is required, worlds belong to whoever created them, and world
 * ids are the server's to choose (docs/14 §1, §2).
 */

/** Load `.env.local` into the process, without clobbering anything already set. */
function loadEnv() {
  try {
    for (const [key, value] of Object.entries(parseEnv(readFileSync('.env.local', 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No `.env.local` is a normal state; the provider check below is what reports a real problem.
  }
}
// Before the settings below read the environment, or `.env.local` could not set them.
loadEnv();

const PORT = Number(process.env.MODEL_PROXY_PORT) || 3001;

/** Many anonymous players rather than one trusted developer (docs/14 §4.2). */
const HOSTED = Boolean(process.env.HOSTED) && process.env.HOSTED !== '0';

/**
 * How many model calls this process will serve before it refuses.
 *
 * Sized to be generous for a play session and fatal for a runaway loop. Restarting the proxy
 * resets it, which is the right friction: someone has to notice. On a hosted server one abuser can
 * exhaust it for everyone, so there it is only a circuit breaker, sized well above normal traffic
 * (docs/14 §2.4).
 */
const CALL_CAP = Number(process.env.MODEL_PROXY_CALL_CAP) || 2000;

/** Per-owner quota (docs/14 §2.4), over a trailing window. Off when no database is configured. */
const OWNER_QUOTA = Number(process.env.MODEL_OWNER_QUOTA) || 1000;
const QUOTA_WINDOW_MS = Number(process.env.MODEL_QUOTA_WINDOW_MS) || 60 * 60 * 1000;

/**
 * Model calls per address over the same window. Hosted only: the backstop for an owner quota that
 * minting a fresh token dodges (docs/14 §1.4, §2.4).
 */
const addressQuota = new WindowCounter(
  Number(process.env.MODEL_ADDRESS_QUOTA) || 3000,
  QUOTA_WINDOW_MS,
);

/** New identities per address per hour. Hosted only; minting is the weak point (docs/14 §1.4). */
const mintLimit = new WindowCounter(Number(process.env.IDENTITY_MINT_LIMIT) || 20, 60 * 60 * 1000);

/** Storage bounds on a hosted server (docs/14 §2.5). A local one keeps the 8 MB body limit. */
const MAX_WORLDS_PER_OWNER = Number(process.env.MAX_WORLDS_PER_OWNER) || 20;
const MAX_WORLD_DEFINITION_BYTES = Number(process.env.MAX_WORLD_DEFINITION_BYTES) || 1024 * 1024;
const MAX_BATCH_BYTES = Number(process.env.MAX_BATCH_BYTES) || 2 * 1024 * 1024;
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/** Delete worlds with no batch in this many days (docs/14 §2.5). Off unless set. */
const WORLD_IDLE_DAYS = Number(process.env.WORLD_IDLE_DAYS) || 0;

let callsServed = 0;

let storageReady = false;

/** A failure the client caused, answered with its own status rather than as an upstream 502. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(request: IncomingMessage, maxBytes = BODY_LIMIT_BYTES): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // A prompt carries whole transcripts, so the default is generous; it is here so a malformed
    // or hostile request cannot exhaust memory.
    if (size > maxBytes) throw new HttpError(413, `Request body over ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not JSON');
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    // Vite proxies `/llm` in development, so same-origin is the normal case. This covers a
    // separately served frontend without making the proxy interesting to anyone else.
    'Access-Control-Allow-Origin': process.env.MODEL_PROXY_ORIGIN ?? '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  response.end(text);
}

/**
 * Who a request belongs to (docs/14 §1.2).
 *
 * `undefined` only on a hosted server, for a request without a token it minted. A local server
 * does not look: every request is `local`, so a new browser loses nothing (docs/14 §4.4).
 */
function ownerOf(request: IncomingMessage): string | undefined {
  if (!HOSTED) return LOCAL_OWNER;
  return verifyToken(bearerToken(request));
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'OPTIONS') return send(response, 204, {});

  if (url.pathname === '/identity') return handleIdentity(request, response);

  const owner = ownerOf(request);
  if (!owner) {
    return send(response, 401, {
      error: 'A valid identity token is required. POST /identity for one.',
    });
  }

  if (url.pathname.startsWith('/worlds')) {
    return await handleWorlds(request, response, url, owner);
  }

  const path = url.pathname.replace(/^\/llm/, '');
  if (request.method !== 'POST') return send(response, 405, { error: 'POST only' });

  // The trace endpoint is free: it writes observability, never a model call, and counting it
  // against the cap would make a well-traced run look expensive.
  if (path === '/trace') {
    const { entries } = (await readJson(request)) as { entries: TraceEntry[] };
    for (const entry of entries ?? []) {
      await recordObservation(entry.trace, entry.observation);
    }
    return send(response, 200, { ok: true });
  }

  // A hosted server with no database cannot count anyone's calls, and serving them uncounted
  // would make it a free proxy. A local one keeps working on the process cap alone.
  if (HOSTED && !storageReady) {
    return send(response, 503, { error: 'Storage is unavailable, so model calls are refused.' });
  }
  if (HOSTED && !addressQuota.take(clientAddress(request))) {
    return send(response, 429, { error: 'Too many model calls from this address. Slow down.' });
  }
  if (callsServed >= CALL_CAP) {
    return send(response, 429, {
      error: `Model call cap of ${CALL_CAP} reached for this proxy process. Restart it, or raise MODEL_PROXY_CALL_CAP, once you know why.`,
    });
  }
  callsServed += 1;

  if (path === '/chat') {
    const body = await readJson(request);
    const quota = await overQuota(owner);
    if (quota) return send(response, 429, { error: quota });
    const started = Date.now();
    const result = await chatCompletion({ ...body, stream: false });
    await logCall({
      ownerId: owner,
      worldId: body.worldId,
      purpose: body.trace?.name,
      model: body.model,
      promptTokens: result.usage?.input,
      completionTokens: result.usage?.output,
      latencyMs: Date.now() - started,
      traceId: body.trace?.traceId,
    });
    return send(response, 200, result);
  }

  // The other kind of model call (docs/12 §5). It counts against the same cap and the same quota,
  // which is deliberately blunt: both are denominated in calls, and a System One call costs about
  // two thousandths of what a chat completion does. Raise `MODEL_PROXY_CALL_CAP` for a long run
  // with the Jev decider rather than exempting it -- a runaway loop is still a runaway loop.
  if (path === '/systemone') {
    // Typed on the way in, as `/embed` is: the route forwards a body it has not read, so the one
    // field it does read -- the world to attribute -- is worth naming.
    const body = (await readJson(request)) as SystemOneRequest & { worldId?: string };
    const quota = await overQuota(owner);
    if (quota) return send(response, 429, { error: quota });
    const started = Date.now();
    const result = await systemOne(body);
    await logCall({
      ownerId: owner,
      worldId: body.worldId,
      purpose: body.trace?.name,
      // What answered, not what was asked for: an alias hides the version.
      model: result.model,
      promptTokens: result.usage?.input,
      completionTokens: result.usage?.output,
      latencyMs: Date.now() - started,
      traceId: body.trace?.traceId,
    });
    return send(response, 200, result);
  }

  if (path === '/embed') {
    const { texts, worldId } = (await readJson(request)) as { texts: string[]; worldId?: string };
    const quota = await overQuota(owner);
    if (quota) return send(response, 429, { error: quota });
    const started = Date.now();
    const { embeddings, fetched } = await embedCached(texts);
    // A request the cache answered whole cost nothing, so it is not a call to count.
    if (fetched) {
      await logCall({ ownerId: owner, worldId, purpose: 'embed', latencyMs: Date.now() - started });
    }
    return send(response, 200, { embeddings, ms: Date.now() - started });
  }

  return send(response, 404, { error: `Unknown endpoint ${path}` });
}

/**
 * `POST /identity`: a token for a browser that has none (docs/14 §1.2).
 *
 * A local server mints them too, so the client never has to know which kind it is talking to. It
 * just never checks them.
 */
function handleIdentity(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== 'POST') return send(response, 405, { error: 'POST only' });
  if (HOSTED && !mintLimit.take(clientAddress(request))) {
    return send(response, 429, { error: 'Too many new identities from this address.' });
  }
  const body: IdentityResponse = { token: mintToken() };
  return send(response, 200, body);
}

/**
 * The per-owner quota.
 *
 * Returns a message when the owner is over, `undefined` when it is not or when there is no
 * database to ask. A missing database means no quota rather than no calls: a local proxy has to
 * keep working for anyone running without storage, and the process cap still applies. A hosted
 * one refuses model calls before it gets here.
 */
async function overQuota(owner: string): Promise<string | undefined> {
  if (!storageReady) return undefined;
  const used = await callsInWindow(owner, QUOTA_WINDOW_MS);
  if (used < OWNER_QUOTA) return undefined;
  return `You have made ${used} model calls in the last ${Math.round(
    QUOTA_WINDOW_MS / 60000,
  )} minutes, at or over the quota of ${OWNER_QUOTA}.`;
}

/** Best-effort: a spend record that cannot be written must not fail the call it describes. */
async function logCall(call: Parameters<typeof recordLlmCall>[0]) {
  if (!storageReady) return;
  try {
    await recordLlmCall(call);
  } catch (error) {
    console.error('Could not record an llm_calls row:', error);
  }
}

/**
 * Embeddings, through the shared cache (docs/14 §2.2).
 *
 * The cache is shared between players and the first write for a key wins, so the server is its
 * only writer and writes only vectors it fetched itself. Hits are free, which is why the cache is
 * worth sharing at all.
 */
async function embedCached(texts: string[]): Promise<{ embeddings: number[][]; fetched: number }> {
  if (!storageReady) {
    const { embeddings } = await fetchEmbeddingBatch(texts);
    return { embeddings, fetched: texts.length };
  }
  const hashes = texts.map((text) => sha256(text));
  const known = await readEmbeddings(hashes);
  const missing = hashes.flatMap((hash, index) => (known.has(hash) ? [] : [index]));
  if (missing.length) {
    const { embeddings } = await fetchEmbeddingBatch(missing.map((index) => texts[index]));
    const fresh = missing.map((index, n) => ({ textHash: hashes[index], embedding: embeddings[n] }));
    for (const entry of fresh) known.set(entry.textHash, entry.embedding);
    try {
      await writeEmbeddings(fresh);
    } catch (error) {
      // The vectors are good; only the saving failed, so the call still succeeds.
      console.error('Could not write the embeddings cache:', error);
    }
  }
  return { embeddings: hashes.map((hash) => known.get(hash)!), fetched: missing.length };
}

/**
 * Whether `owner` may touch `worldId` (docs/14 §2.1).
 *
 * Checked once, before every per-world route: every table under a world cascades from it, so
 * owning the world is owning its rows. A local server has one owner, so it always passes.
 */
async function authorizeWorld(owner: string, worldId: string): Promise<boolean> {
  return !HOSTED || (await ownsWorld(owner, worldId));
}

/** The storage routes. Whole-batch or nothing, and never a simulation step (docs/11 §4.1). */
async function handleWorlds(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  owner: string,
) {
  if (!storageReady) {
    return send(response, 503, { error: 'No DATABASE_URL is configured; storage is disabled.' });
  }
  const segments = url.pathname.split('/').filter(Boolean); // worlds[, :id[, action]]
  const method = request.method ?? 'GET';

  if (segments.length === 1 && method === 'GET') {
    return send(response, 200, { worlds: await listWorlds(owner) });
  }
  if (segments.length === 1 && method === 'POST') {
    const body = (await readJson(
      request,
      HOSTED ? MAX_WORLD_DEFINITION_BYTES : undefined,
    )) as CreateWorldRequest | null;
    if (HOSTED && (await countWorlds(owner)) >= MAX_WORLDS_PER_OWNER) {
      return send(response, 403, { error: `At most ${MAX_WORLDS_PER_OWNER} worlds per player.` });
    }
    // Hosted, the id is always ours: a client-chosen one could squat on a name or collide with
    // another player's world (docs/14 §2.3). Local, the client's is kept, so a pinned
    // `VITE_SYNC_WORLD_ID` stays pinned (§4.4).
    const id = HOSTED ? newWorldId() : body?.id || newWorldId();
    return send(
      response,
      200,
      await createWorld({ id, ownerId: owner, name: body?.name, definition: body?.definition }),
    );
  }

  const worldId = segments[1];
  if (!worldId) return send(response, 404, { error: 'Unknown storage route' });
  const action = segments[2];

  // 404 rather than 403, so another player's world ids cannot be probed.
  if (!(await authorizeWorld(owner, worldId))) {
    return send(response, 404, { error: `No world ${worldId}` });
  }

  if (action === 'bootstrap' && method === 'GET') {
    const result = await bootstrap(worldId);
    if (!result) return send(response, 404, { error: `No world ${worldId}` });
    return send(response, 200, result);
  }
  if (action === 'session' && method === 'POST') {
    const body = await readJson(request);
    const result = await claimSession(worldId, body);
    return send(response, result.ok ? 200 : 409, result);
  }
  if (action === 'batches' && method === 'POST') {
    // A batch carries the whole world document, so this is the state size cap of §2.5.
    const body = await readJson(request, HOSTED ? MAX_BATCH_BYTES : undefined);
    const result = await applyBatch(worldId, body);
    return send(response, result.ok ? 200 : 409, result);
  }
  if (action === 'events' && method === 'GET') {
    const from = Number(url.searchParams.get('from') ?? 0);
    const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER);
    return send(response, 200, { events: await readEvents(worldId, from, to) });
  }
  return send(response, 404, { error: 'Unknown storage route' });
}

if (HOSTED && !process.env.IDENTITY_SECRET) {
  // Without a fixed key every restart would invalidate every player's token, and with it every
  // world they own. That is not "occasional loss"; refuse to start instead.
  console.error('HOSTED=1 needs IDENTITY_SECRET, the key that signs identity tokens.');
  process.exit(1);
}
configureIdentity(process.env.IDENTITY_SECRET);

try {
  detectMismatchedLLMProvider();
} catch (error) {
  console.error(`Model proxy: ${(error as Error).message}`);
}

async function openStorage() {
  if (!databaseUrl()) {
    console.log('No DATABASE_URL; running as a model proxy only.');
    if (HOSTED) console.error('A hosted server without storage refuses every model call.');
    return;
  }
  try {
    await migrate();
    storageReady = true;
    console.log('Storage ready.');
  } catch (error) {
    // A proxy that cannot reach its database is still a proxy. The storage routes answer 503
    // until it can, which is a better failure than refusing to start.
    console.error(`Storage unavailable: ${(error as Error).message}`);
    return;
  }
  if (WORLD_IDLE_DAYS > 0) {
    const prune = () =>
      pruneIdleWorlds(WORLD_IDLE_DAYS)
        .then((count) => count && console.log(`Deleted ${count} idle worlds.`))
        .catch((error) => console.error('Idle world cleanup failed:', error));
    void prune();
    setInterval(prune, 6 * 60 * 60 * 1000).unref();
  }
}
void openStorage();

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    if (error instanceof HttpError) return send(response, error.status, { error: error.message });
    const message = error instanceof Error ? error.message : String(error);
    console.error('Model proxy error:', message);
    // Never leak a key through an upstream error body.
    send(response, 502, { error: 'Upstream model call failed. See the proxy log.' });
  });
}).listen(PORT, () => {
  console.log(
    `Model proxy on http://127.0.0.1:${PORT} (${HOSTED ? 'hosted' : 'local'}, cap ${CALL_CAP} calls)`,
  );
});

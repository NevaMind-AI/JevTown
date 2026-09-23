import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { parse as parseEnv } from 'dotenv';
import { chatCompletion, fetchEmbeddingBatch, detectMismatchedLLMProvider } from './model/llm.ts';
import { systemOne, type SystemOneRequest } from './model/jev.ts';
import { recordObservation } from './model/langfuse.ts';
import type { TraceEntry } from '../agent/model/trace.ts';
import { databaseUrl, migrate } from './db/index.ts';
import {
  applyBatch,
  bootstrap,
  callsInWindow,
  claimSession,
  createWorld,
  readEvents,
  recordLlmCall,
} from './worlds.ts';

/**
 * The key-holding model proxy.
 *
 * Under docs/11 §1 the browser owns the simulation, which means the browser is what wants to call
 * a model — and a browser is the last place a provider key belongs. This process holds the key,
 * picks the provider, retries, and exports traces to Langfuse. The tab talks to it over three
 * endpoints and never sees a credential.
 *
 * It also holds the spend limit of docs/11 §4.4. That is not a nicety: the client now drives the
 * bill, a bug in the decision loop can spend real money before anyone notices, and a limit that
 * lives in code the client can edit is not a limit. This one is deliberately crude — a process
 * lifetime call cap — and phase 5 replaces it with a per-world quota read off `llm_calls`.
 */

const PORT = Number(process.env.MODEL_PROXY_PORT) || 3001;

/**
 * How many model calls this process will serve before it refuses.
 *
 * Sized to be generous for a play session and fatal for a runaway loop. Restarting the proxy
 * resets it, which is the right friction: someone has to notice.
 */
const CALL_CAP = Number(process.env.MODEL_PROXY_CALL_CAP) || 2000;

/** Per-world quota (docs/11 §4.4), over a trailing window. Off when no database is configured. */
const WORLD_QUOTA = Number(process.env.MODEL_WORLD_QUOTA) || 1000;
const WORLD_QUOTA_WINDOW_MS = Number(process.env.MODEL_WORLD_QUOTA_WINDOW_MS) || 60 * 60 * 1000;

let callsServed = 0;

let storageReady = false;

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

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // A prompt carries whole transcripts, so this is generous; it is here so a malformed or
    // hostile request cannot exhaust memory.
    if (size > 8 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    // Vite proxies `/llm` in development, so same-origin is the normal case. This covers a
    // separately served frontend without making the proxy interesting to anyone else.
    'Access-Control-Allow-Origin': process.env.MODEL_PROXY_ORIGIN ?? '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(text);
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'OPTIONS') return send(response, 204, {});

  if (url.pathname.startsWith('/worlds')) {
    return await handleWorlds(request, response, url);
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

  if (callsServed >= CALL_CAP) {
    return send(response, 429, {
      error: `Model call cap of ${CALL_CAP} reached for this proxy process. Restart it, or raise MODEL_PROXY_CALL_CAP, once you know why.`,
    });
  }
  callsServed += 1;

  if (path === '/chat') {
    const body = await readJson(request);
    const quota = await overQuota(body.worldId);
    if (quota) return send(response, 429, { error: quota });
    const started = Date.now();
    const result = await chatCompletion({ ...body, stream: false });
    await logCall({
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
    // field it does read -- the world to bill -- is worth naming.
    const body = (await readJson(request)) as SystemOneRequest & { worldId?: string };
    const quota = await overQuota(body.worldId);
    if (quota) return send(response, 429, { error: quota });
    const started = Date.now();
    const result = await systemOne(body);
    await logCall({
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
    const quota = await overQuota(worldId);
    if (quota) return send(response, 429, { error: quota });
    const started = Date.now();
    const { embeddings, ms } = await fetchEmbeddingBatch(texts);
    await logCall({ worldId, purpose: 'embed', latencyMs: Date.now() - started });
    return send(response, 200, { embeddings, ms });
  }

  return send(response, 404, { error: `Unknown endpoint ${path}` });
}

/**
 * The per-world quota.
 *
 * Returns a message when the world is over, `undefined` when it is not or when there is no
 * database to ask. A missing database means no quota rather than no calls: the proxy has to keep
 * working for anyone running without storage, and the process cap still applies.
 */
async function overQuota(worldId: string | undefined): Promise<string | undefined> {
  if (!storageReady || !worldId) return undefined;
  const used = await callsInWindow(worldId, WORLD_QUOTA_WINDOW_MS);
  if (used < WORLD_QUOTA) return undefined;
  return `World ${worldId} has used ${used} model calls in the last ${Math.round(
    WORLD_QUOTA_WINDOW_MS / 60000,
  )} minutes, at or over its quota of ${WORLD_QUOTA}.`;
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

/** The storage routes. Whole-batch or nothing, and never a simulation step (docs/11 §4.1). */
async function handleWorlds(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (!storageReady) {
    return send(response, 503, { error: 'No DATABASE_URL is configured; storage is disabled.' });
  }
  const segments = url.pathname.split('/').filter(Boolean); // worlds[, :id[, action]]
  const method = request.method ?? 'GET';

  if (segments.length === 1 && method === 'POST') {
    const body = await readJson(request);
    if (!body?.id) return send(response, 400, { error: 'A world needs an id' });
    return send(response, 200, await createWorld(body));
  }

  const worldId = segments[1];
  if (!worldId) return send(response, 404, { error: 'Unknown storage route' });
  const action = segments[2];

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
    const body = await readJson(request);
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

loadEnv();
try {
  detectMismatchedLLMProvider();
} catch (error) {
  console.error(`Model proxy: ${(error as Error).message}`);
}

async function openStorage() {
  if (!databaseUrl()) {
    console.log('No DATABASE_URL; running as a model proxy only.');
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
  }
}
void openStorage();

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Model proxy error:', message);
    // Never leak a key through an upstream error body.
    send(response, 502, { error: 'Upstream model call failed. See the proxy log.' });
  });
}).listen(PORT, () => {
  console.log(`Model proxy on http://127.0.0.1:${PORT} (cap ${CALL_CAP} calls)`);
});

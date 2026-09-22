import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { parse as parseEnv } from 'dotenv';
import { chatCompletion, fetchEmbeddingBatch, detectMismatchedLLMProvider } from './model/llm.ts';
import { recordObservation } from './model/langfuse.ts';
import type { TraceEntry } from '../agent/model/trace.ts';

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

let callsServed = 0;

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
  const path = (request.url ?? '').split('?')[0].replace(/^\/llm/, '');

  if (request.method === 'OPTIONS') return send(response, 204, {});
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
    const result = await chatCompletion({ ...body, stream: false });
    return send(response, 200, result);
  }

  if (path === '/embed') {
    const { texts } = (await readJson(request)) as { texts: string[] };
    const { embeddings, ms } = await fetchEmbeddingBatch(texts);
    return send(response, 200, { embeddings, ms });
  }

  return send(response, 404, { error: `Unknown endpoint ${path}` });
}

loadEnv();
try {
  detectMismatchedLLMProvider();
} catch (error) {
  console.error(`Model proxy: ${(error as Error).message}`);
}

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

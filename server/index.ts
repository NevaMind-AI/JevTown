import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { parse as parseEnv } from 'dotenv';
import { chatCompletion, fetchEmbeddingBatch, detectMismatchedLLMProvider } from './model/llm.ts';
import { systemOne } from './model/jev.ts';
import { recordObservation } from './model/langfuse.ts';
import { embedTexts, HttpError, purposeRequest, traceEntries } from './model/requests.ts';
import { chatCost, embedCost, systemOneCost } from './model/pricing.ts';
import type { LLMUsage } from './model/llm.ts';
import type { ChatTrace } from '../agent/model/trace.ts';
import type { Purpose, PurposeResponse } from '../agent/purposes/index.ts';
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
import type {
  CreateWorldRequest,
  IdentityResponse,
  LlmCallRecord,
  ModelCallLease,
} from './protocol.ts';
import {
  applyBatch,
  bootstrap,
  claimSession,
  countWorlds,
  createWorld,
  holdsLease,
  knownTraceIds,
  listWorlds,
  newWorldId,
  ownsWorld,
  pruneIdleWorlds,
  readEmbeddings,
  readEvents,
  recordLlmCall,
  sha256,
  spentByEveryone,
  spentInWindow,
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
 * lives in code the client can edit is not a limit. With a database, spend is recorded per call in
 * estimated dollars, and read back as a per-owner budget and a global daily circuit breaker
 * (docs/14 §3.6). Without one, nothing is recorded, and a crude process lifetime call cap is all
 * that bounds it.
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
 * How many model calls this process will serve before it refuses, when it has no database.
 *
 * Without one, no call's cost is recorded, so this is the only limit. Sized to be generous for a
 * play session and fatal for a runaway loop. Restarting the proxy resets it, which is the right
 * friction: someone has to notice. With a database the budgets below replace it: a process
 * lifetime cap on a shared server is a lever one abuser could pull for everyone (docs/14 §2.4).
 */
const CALL_CAP = Number(process.env.MODEL_PROXY_CALL_CAP) || 2000;

/**
 * Spend limits in estimated US dollars (docs/14 §3.6; prices in `server/model/pricing.ts`).
 *
 * Per owner over a trailing window, so a runaway loop in one world, or one player's many worlds,
 * stops there. Per address over the same window on a hosted server, as the backstop for an owner
 * budget that minting a fresh token dodges (§1.4). And across everyone over a day, the circuit
 * breaker that keeps a bug or an attack from reaching the provider's hard limit first.
 */
const OWNER_BUDGET_USD = Number(process.env.MODEL_OWNER_BUDGET_USD) || 0.5;
const ADDRESS_BUDGET_USD = Number(process.env.MODEL_ADDRESS_BUDGET_USD) || 2;
const BUDGET_WINDOW_MS = Number(process.env.MODEL_BUDGET_WINDOW_MS) || 60 * 60 * 1000;
const DAILY_BUDGET_USD = Number(process.env.MODEL_DAILY_BUDGET_USD) || 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const addressSpend = new WindowCounter(ADDRESS_BUDGET_USD, BUDGET_WINDOW_MS);

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

/**
 * The origin a browser may call from (docs/14 §3.7).
 *
 * `MODEL_PROXY_ORIGIN` is a comma-separated list, and the request's own origin is echoed when it
 * is on it. This binds browsers only, never scripts: it stops another website from spending our
 * budget through its visitors. Unset, any origin may, which suits local play.
 */
function allowedOrigin(response: ServerResponse): string {
  const allowed = (process.env.MODEL_PROXY_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!allowed.length) return '*';
  const origin = response.req?.headers.origin;
  return origin && allowed.includes(origin) ? origin : allowed[0];
}

function send(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    // Vite proxies these routes in development, so same-origin is the normal case. This covers a
    // separately served frontend, such as `play:remote` against the hosted server.
    'Access-Control-Allow-Origin': allowedOrigin(response),
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-World-Id, X-Session-Id, X-Generation',
    Vary: 'Origin',
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

/** The lease a model call says it holds (docs/14 §3.3), from its headers. */
function leaseOf(request: IncomingMessage): ModelCallLease | undefined {
  const header = (name: string) => {
    const value = request.headers[name];
    return typeof value === 'string' && value ? value : undefined;
  };
  const worldId = header('x-world-id');
  const sessionId = header('x-session-id');
  const generation = Number(header('x-generation'));
  if (!worldId || !sessionId || !Number.isInteger(generation)) return undefined;
  return { worldId, sessionId, generation };
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

  // Free: it writes observability, never a model call, and counting it against a budget would
  // make a well-traced run look expensive. Bound instead (§3.5).
  if (path === '/trace') return await handleTrace(request, response, owner);

  // Every model call is a purpose now (docs/14 §3.2). The free-form `/chat` and `/systemone`
  // routes are gone: a client can name what it wants and send what it knows, never a prompt.
  if (path !== '/purpose' && path !== '/embed') {
    return send(response, 404, { error: `Unknown endpoint ${path}` });
  }
  const refusal = await refuseModelCall(request, owner);
  if (refusal) return send(response, refusal.status, { error: refusal.error });

  const raw = await readJson(request);
  const address = clientAddress(request);
  // The lease names the world a call bills to. A local call without one may still name it in the
  // body.
  const worldId =
    leaseOf(request)?.worldId ?? (typeof raw?.worldId === 'string' ? raw.worldId : undefined);

  if (path === '/purpose') return await runPurpose(response, raw, owner, address, worldId);

  const started = Date.now();
  const texts = embedTexts(raw);
  const { embeddings, fetched, tokens, fetchedChars } = await embedCached(texts);
  // A request the cache answered whole cost nothing, so there is nothing to charge.
  if (fetched) {
    await charge(address, {
      ownerId: owner,
      worldId,
      purpose: 'embed',
      promptTokens: tokens,
      latencyMs: Date.now() - started,
      costUsd: embedCost(tokens, fetchedChars),
    });
  }
  return send(response, 200, { embeddings, ms: Date.now() - started });
}

/**
 * The variant a purpose runs as (docs/14 §3.2).
 *
 * When a purpose has both, its server setting chooses: `jev` or `systemone` for System One,
 * anything else for chat. The tab has no say, and the result has the same shape either way. The
 * `VITE_` name is read too, because that is where `.env.local` has kept these settings since the
 * tab used to choose, and this server reads `.env.local`.
 */
function variantOf(purpose: Purpose<unknown, unknown>) {
  const wanted = purpose.setting
    ? (process.env[purpose.setting] ?? process.env[`VITE_${purpose.setting}`])
    : undefined;
  const kind = wanted === 'jev' || wanted === 'systemone' ? 'systemone' : 'chat';
  return purpose.variants[kind] ?? purpose.variants.chat ?? purpose.variants.systemone;
}

/**
 * The trace for one completion of a purpose. A re-ask gets a span of its own, named after the
 * first, so a trace shows how many attempts a state write took.
 */
function attemptTrace(trace: ChatTrace | undefined, attempt: number): ChatTrace | undefined {
  if (!trace || attempt === 0) return trace;
  return {
    ...trace,
    name: `${trace.name}.reask.${attempt}`,
    metadata: { ...trace.metadata, attempt },
  };
}

/**
 * `POST /llm/purpose`: render, call, charge, then read the answer.
 *
 * Every completion is charged as it returns, before its answer is read, so an answer that will
 * not parse still counts against the budget it spent. One that will not parse is a 502 naming the
 * purpose, so the tab can tell a bad answer from a failed call.
 */
async function runPurpose(
  response: ServerResponse,
  raw: unknown,
  owner: string,
  address: string,
  worldId: string | undefined,
) {
  const { name, purpose, vars, trace } = purposeRequest(raw);
  const variant = variantOf(purpose);
  if (!variant) throw new Error(`Purpose ${name} has no variant`);
  const started = Date.now();
  const call = { ownerId: owner, worldId, purpose: name };
  const read = <T>(parse: () => T): T => {
    try {
      return parse();
    } catch (error) {
      throw new HttpError(
        502,
        `The answer to ${name} could not be read: ${(error as Error).message}`,
      );
    }
  };

  if (variant.kind === 'chat') {
    // Named once narrowed, so the closure below keeps the narrowing.
    const chat = variant;
    const usage: LLMUsage = {};
    let attempt = 0;
    const ask = async (retryHint?: string) => {
      const request = chat.render(vars, retryHint);
      const asked = Date.now();
      const traced = attemptTrace(trace, attempt++);
      const completion = await chatCompletion({ ...request, trace: traced, stream: false });
      const promptChars = request.messages.reduce(
        (sum, message) => sum + message.content.length,
        0,
      );
      await charge(address, {
        ...call,
        traceId: traced?.traceId,
        promptTokens: completion.usage?.input,
        completionTokens: completion.usage?.output,
        latencyMs: Date.now() - asked,
        costUsd: chatCost(completion.usage, promptChars, completion.content.length),
      });
      for (const key of ['input', 'output', 'total'] as const) {
        const value = completion.usage?.[key];
        if (value !== undefined) usage[key] = (usage[key] ?? 0) + value;
      }
      return completion.content;
    };
    let result: unknown;
    const { converse, parse } = chat;
    if (converse) {
      result = await converse(ask, vars);
    } else if (parse) {
      const content = await ask();
      result = read(() => parse(content, vars));
    } else {
      throw new Error(`Purpose ${name} has a chat variant that reads nothing`);
    }
    const body: PurposeResponse<unknown> = {
      result,
      provider: 'chat',
      usage,
      ms: Date.now() - started,
    };
    return send(response, 200, body);
  }

  // Same budgets, but priced as what it is: about two thousandths of a chat completion.
  const request = variant.render(vars);
  const answer = await systemOne({ ...request, trace });
  await charge(address, {
    ...call,
    traceId: trace?.traceId,
    // What answered, not what was asked for: an alias hides the version.
    model: answer.model,
    promptTokens: answer.usage?.input,
    completionTokens: answer.usage?.output,
    latencyMs: Date.now() - started,
    costUsd: systemOneCost(answer.usage, JSON.stringify(request).length),
  });
  const body: PurposeResponse<unknown> = {
    result: read(() => variant.parse(answer.answers, vars)),
    provider: 'systemone',
    model: answer.model,
    usage: answer.usage,
    ms: Date.now() - started,
  };
  return send(response, 200, body);
}

/**
 * Why a model call is refused, or `undefined` when it may go ahead.
 *
 * In order of what is cheapest to check. A hosted server needs its database, since it could not
 * count the call otherwise, and a lease on the world the call is for (docs/14 §3.3). Then the
 * limits: the process cap when nothing is recorded, the budgets when spend is.
 */
async function refuseModelCall(
  request: IncomingMessage,
  owner: string,
): Promise<{ status: number; error: string } | undefined> {
  if (HOSTED) {
    if (!storageReady) {
      return { status: 503, error: 'Storage is unavailable, so model calls are refused.' };
    }
    if (addressSpend.over(clientAddress(request))) {
      return { status: 429, error: 'This address has reached its model budget. Try again later.' };
    }
    const lease = leaseOf(request);
    if (!lease || !(await holdsLease(owner, lease))) {
      return {
        status: 409,
        error: "This tab does not hold its world's lease, so it cannot call a model.",
      };
    }
  }

  if (!storageReady) {
    if (callsServed >= CALL_CAP) {
      return {
        status: 429,
        error: `Model call cap of ${CALL_CAP} reached for this proxy process. Restart it, or raise MODEL_PROXY_CALL_CAP, once you know why.`,
      };
    }
    callsServed += 1;
    return undefined;
  }

  if ((await dailySpend()) >= DAILY_BUDGET_USD) {
    console.error(`Daily model budget of $${DAILY_BUDGET_USD} reached; refusing model calls.`);
    return { status: 503, error: 'The server has reached its daily model budget.' };
  }
  const spent = await spentInWindow(owner, BUDGET_WINDOW_MS);
  if (spent >= OWNER_BUDGET_USD) {
    return {
      status: 429,
      error: `You have spent about $${spent.toFixed(2)} on model calls in the last ${Math.round(
        BUDGET_WINDOW_MS / 60000,
      )} minutes, at or over the budget of $${OWNER_BUDGET_USD}.`,
    };
  }
  return undefined;
}

/**
 * Everyone's spend over the last day, read at most every fifteen seconds.
 *
 * Summing a day of `llm_calls` on every call would be the most expensive query the server runs.
 * Between reads, `charge` adds each call's cost, so the figure only lags other instances.
 */
let daily = { readAt: 0, spent: 0 };
async function dailySpend(): Promise<number> {
  if (Date.now() - daily.readAt > 15_000) {
    daily = { readAt: Date.now(), spent: await spentByEveryone(DAY_MS) };
  }
  return daily.spent;
}

/** Record a call and count its cost against every limit that reads spend. */
async function charge(address: string, call: LlmCallRecord) {
  const cost = call.costUsd ?? 0;
  if (HOSTED) addressSpend.add(address, cost);
  daily.spent += cost;
  await logCall(call);
}

/**
 * `POST /llm/trace`: observations the tab built but cannot export itself.
 *
 * On a hosted server an entry is exported only into a trace that one of this owner's own model
 * calls used in the last hour (docs/14 §3.5). Anything else is dropped without an error, since
 * tracing is best-effort on both sides. `llm_calls` already records the trace id, so no new id
 * has to be issued.
 */
async function handleTrace(request: IncomingMessage, response: ServerResponse, owner: string) {
  const entries = traceEntries(await readJson(request, 1024 * 1024));
  let accepted = entries;
  if (HOSTED) {
    const ids = [...new Set(entries.map((entry) => entry.trace.traceId))];
    const known = storageReady
      ? await knownTraceIds(owner, ids, 60 * 60 * 1000)
      : new Set<string>();
    accepted = entries.filter((entry) => known.has(entry.trace.traceId));
  }
  for (const entry of accepted) {
    await recordObservation(entry.trace, entry.observation);
  }
  return send(response, 200, { ok: true, accepted: accepted.length });
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
async function embedCached(texts: string[]): Promise<{
  embeddings: number[][];
  /** How many texts went to the provider, their characters, and the tokens it billed if it said. */
  fetched: number;
  fetchedChars: number;
  tokens?: number;
}> {
  const charsOf = (list: string[]) => list.reduce((sum, text) => sum + text.length, 0);
  if (!storageReady) {
    const result = await fetchEmbeddingBatch(texts);
    return {
      embeddings: result.embeddings,
      fetched: texts.length,
      fetchedChars: charsOf(texts),
      tokens: result.ollama ? undefined : result.usage,
    };
  }
  const hashes = texts.map((text) => sha256(text));
  const known = await readEmbeddings(hashes);
  const missing = hashes.flatMap((hash, index) => (known.has(hash) ? [] : [index]));
  let tokens: number | undefined;
  if (missing.length) {
    const result = await fetchEmbeddingBatch(missing.map((index) => texts[index]));
    const { embeddings } = result;
    tokens = result.ollama ? undefined : result.usage;
    const fresh = missing.map((index, n) => ({
      textHash: hashes[index],
      embedding: embeddings[n],
    }));
    for (const entry of fresh) known.set(entry.textHash, entry.embedding);
    try {
      await writeEmbeddings(fresh);
    } catch (error) {
      // The vectors are good; only the saving failed, so the call still succeeds.
      console.error('Could not write the embeddings cache:', error);
    }
  }
  return {
    embeddings: hashes.map((hash) => known.get(hash)!),
    fetched: missing.length,
    fetchedChars: charsOf(missing.map((index) => texts[index])),
    tokens,
  };
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
if (HOSTED && !process.env.MODEL_PROXY_ORIGIN) {
  console.warn('HOSTED=1 without MODEL_PROXY_ORIGIN: any website may call this server (§3.7).');
}

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
  console.log(`Model proxy on http://127.0.0.1:${PORT} (${HOSTED ? 'hosted' : 'local'})`);
});

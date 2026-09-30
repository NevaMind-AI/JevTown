import { ChatTrace, TraceEntry } from './trace';
import type { PurposeName, PurposeResponse, ResultOf, VarsOf } from '../purposes/index.ts';

/**
 * The browser's model client.
 *
 * Under docs/11 §1 the simulation runs in the tab, so the tab is what wants to call a model — and
 * the tab is the last place a provider key should be. Everything here posts to the local proxy in
 * `server/`, which holds the key, picks the provider, retries, and exports the trace. The proxy
 * is also where the spend limit of docs/11 §4.4 lives, because a client that can be edited is not
 * a client that can enforce one.
 *
 * Model calls go by purpose (docs/14 §3.2): the tab names what it wants and sends what it knows,
 * and never a prompt. There is no free-form chat or System One call left to make.
 */

export type LLMUsage = { input?: number; output?: number; total?: number };

/** Where the proxy lives. Same origin in production; Vite proxies it in development. */
const BASE = (import.meta as any).env?.VITE_MODEL_PROXY_URL ?? '/llm';

class ModelProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelProxyError';
  }
}

let http: typeof fetch = (input, init) => fetch(input, init);

/**
 * Send the proxy's requests through the app's fetch, which attaches the player's token
 * (docs/14 §1.2).
 *
 * Injected rather than imported: the identity lives in the app, and the agent layer has no
 * business knowing where a token comes from or whether the server checks it.
 */
export function setModelProxyFetch(fetchImpl: typeof fetch) {
  http = fetchImpl;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await http(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ModelProxyError(
      response.status,
      `Model proxy ${path} failed (${response.status}): ${text}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * A model call by purpose: its name and its vars, never a prompt (docs/14 §3.2).
 *
 * The server renders the request from a template registered under `agent/purposes/`, picks which
 * kind of model answers, and parses the answer. What comes back is the purpose's result, already
 * in its final shape. `provider` says which kind answered, for logging only.
 */
export async function runPurpose<P extends PurposeName>(
  purpose: P,
  vars: VarsOf<P>,
  trace?: ChatTrace,
): Promise<PurposeResponse<ResultOf<P>>> {
  return await post<PurposeResponse<ResultOf<P>>>('/purpose', { purpose, vars, trace });
}

// ---------------------------------------------------------------- System One

/**
 * The shape of the other kind of model call: a typed decision rather than text (docs/12).
 *
 * A System One model takes a `state` and a map of named questions and answers each one with a
 * typed, calibrated value. It has no messages, no completion and no streaming. The tab never
 * makes one itself any more; these are the types the System One variants of `agent/purposes/`
 * render and read, on the server.
 */

export type SystemOneQuestion =
  | { type: 'noul'; instructions: string; criteria?: unknown }
  /** `criteria` maps each option to its description. Both are sent to the model. */
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  /** `criteria` is an ordered list of level descriptions, low end first. Two to ten of them. */
  | { type: 'score'; instructions: string; criteria: string[] };

export type SystemOneQuestions = Record<string, SystemOneQuestion>;

export type SystemOneAnswer =
  /** A probability that the statement is true. Carries no `confidence` of its own. */
  | { type: 'noul'; noul: number; confidence?: number }
  | {
      type: 'choice';
      choice: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    }
  | {
      type: 'score';
      score: number;
      confidence?: number;
      legend?: Record<string, string>;
      probabilities?: Record<string, number>;
    };

export type SystemOneAnswers = Record<string, SystemOneAnswer>;

export async function fetchEmbeddingBatch(
  texts: string[],
): Promise<{ embeddings: number[][]; ms: number }> {
  return await post<{ embeddings: number[][]; ms: number }>('/embed', { texts });
}

export async function fetchEmbedding(text: string): Promise<{ embedding: number[]; ms: number }> {
  const { embeddings, ...stats } = await fetchEmbeddingBatch([text]);
  return { embedding: embeddings[0], ...stats };
}

/**
 * Ship observations the tab built but cannot export itself.
 *
 * Best-effort by design, exactly as the Langfuse exporter always was: a tracing backend must
 * never be able to fail a tick, so a rejected or unreachable proxy is logged and dropped.
 */
export async function recordTrace(entries: TraceEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    await post<{ ok: true }>('/trace', { entries });
  } catch (error) {
    console.debug('Dropped a trace export:', error);
  }
}

export type { ChatTrace };

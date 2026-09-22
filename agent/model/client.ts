import { ChatTrace, TraceEntry } from './trace';

/**
 * The browser's model client.
 *
 * Under docs/11 §1 the simulation runs in the tab, so the tab is what wants to call a model — and
 * the tab is the last place a provider key should be. Everything here posts to the local proxy in
 * `server/`, which holds the key, picks the provider, retries, and exports the trace. The proxy
 * is also where the spend limit of docs/11 §4.4 lives, because a client that can be edited is not
 * a client that can enforce one.
 *
 * The shape deliberately matches what `server/model/llm.ts` exported, so the agent layer did not
 * have to change when the boundary moved.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LLMUsage = { input?: number; output?: number; total?: number };

export interface ChatCompletionBody {
  messages: LLMMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
  stop?: string | string[];
  trace?: ChatTrace;
}

export interface ChatCompletionResult {
  content: string;
  retries: number;
  ms: number;
  usage?: LLMUsage;
}

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

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
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

export async function chatCompletion(body: ChatCompletionBody): Promise<ChatCompletionResult> {
  return await post<ChatCompletionResult>('/chat', body);
}

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

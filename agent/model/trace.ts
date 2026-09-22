/**
 * Trace identity and shape, shared by the browser that builds observations and the proxy that
 * exports them.
 *
 * This half of the old `langfuse.ts` has no keys and no network: it hashes ids and describes what
 * an observation looks like. It lives on the client side of the boundary because that is where
 * traces are *structured* — a conversation's trace id is the conversation's id, and only the
 * agent layer knows that. The export, the config and the OTLP encoding stay in `server/model`,
 * because those need credentials.
 */

// ---------------------------------------------------------------- ids

const HEX = '0123456789abcdef';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

/**
 * A stable OTLP trace id (16 bytes / 32 hex chars) for a logical unit of work.
 *
 * This is what makes a conversation span across calls. A tier-(a) conversation turn is its own
 * operation, so there is no in-memory parent to hang children off and nothing shared between
 * turns but the conversation id itself. Hashing that id gives every turn the same trace id with
 * zero coordination and nothing to persist.
 */
export async function traceIdForKey(key: string): Promise<string> {
  return (await sha256Hex(key)).slice(0, 32);
}

/** A stable OTLP span id (8 bytes / 16 hex chars) for a logical unit of work. */
export async function spanIdForKey(key: string): Promise<string> {
  // Offset into a different part of the digest than `traceIdForKey` so a span id is never a
  // prefix of its own trace id -- purely cosmetic, but it makes the two easy to tell apart when
  // reading logs.
  return (await sha256Hex(key)).slice(32, 48);
}

export function randomSpanId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export function randomTraceId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

// ---------------------------------------------------------------- shape

export type ObservationLevel = 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';

export type ObservationType =
  | 'span'
  | 'generation'
  | 'event'
  | 'embedding'
  | 'agent'
  | 'tool'
  | 'chain';

/** Where an observation hangs: which trace, and under which parent (if any). */
export type TraceRef = {
  traceId: string;
  /** Omit to make this observation a root of its trace. Langfuse tolerates several roots. */
  parentSpanId?: string;
  /** Names the *trace*, not the observation. Set it on the spans that should title the trace. */
  traceName?: string;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  traceMetadata?: Record<string, unknown>;
};

export type Observation = {
  name: string;
  /** Force a specific span id -- used when the span must be re-emitted and merged across calls. */
  spanId?: string;
  type?: ObservationType;
  /** Epoch ms. */
  startTime: number;
  /** Epoch ms. */
  endTime: number;
  input?: unknown;
  output?: unknown;
  model?: string;
  modelParameters?: Record<string, unknown>;
  usage?: { input?: number; output?: number; total?: number };
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  statusMessage?: string;
};

/** One observation with the trace it belongs to. What travels to the proxy. */
export type TraceEntry = { trace: TraceRef; observation: Observation };

/**
 * Where a completion belongs in a trace.
 *
 * Optional everywhere, and omitting it is a no-op — which is what lets call sites be wired one at
 * a time instead of all at once.
 */
export type ChatTrace = TraceRef & {
  /** Name of the generation observation, e.g. `'conversation.start'`. */
  name: string;
  metadata?: Record<string, unknown>;
};

// Langfuse observability, hand-rolled against the OTLP/HTTP JSON endpoint.
//
// No SDK, and that is deliberate rather than stylistic. Every `chatCompletion` in this repo runs
// in Convex's default V8 isolate -- there is no `"use node"` anywhere in `convex/` -- and neither
// Langfuse SDK survives there:
//
//   - v4/v5 (`@langfuse/tracing` + `@langfuse/otel`) is built on the OpenTelemetry *Node* SDK. It
//     needs `async_hooks`/`AsyncLocalStorage` to propagate context and a Node span processor to
//     export. The isolate has neither.
//   - v3 (`langfuse`) is fetch-based, but flushes on a background timer and on process exit --
//     exactly the model Convex actions don't have, since nothing runs after a handler returns. It
//     also targets `/api/public/ingestion`, which Langfuse Cloud sunsets on 2026-11-16.
//
// What is left is one `fetch` to the OTLP endpoint, which Langfuse accepts as HTTP/JSON. That
// also keeps `convex/util/llm.ts` honest about its opening line.
//
// Everything here is best-effort. If the keys are unset we never build a span; if the export
// fails we log and move on. A tracing backend must never be able to fail a sim tick.

const OTLP_PATH = '/api/public/otel/v1/traces';

// Attribute values above this are truncated. Prompts in this codebase carry whole transcripts and
// memory dumps; an unbounded body would eventually trip the collector's request size limit.
// Read per call rather than captured at module load, like `langfuseConfig()` -- a Convex isolate is
// long-lived and reuses modules across invocations.
function maxAttributeChars(): number {
  return Number(process.env.LANGFUSE_MAX_ATTRIBUTE_CHARS) || 120_000;
}

export type LangfuseConfig = {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  environment: string;
  release?: string;
};

/**
 * Resolved config, or `null` when tracing is off.
 *
 * `null` is the normal state for anyone who hasn't set the keys, so every caller treats it as
 * "skip" rather than an error. Note that Convex functions read the *deployment's* env store, so
 * these have to be pushed with `npm run env:push` (see `scripts/push-convex-env.mjs`) -- a key
 * sitting only in `.env.local` is invisible here.
 */
export function langfuseConfig(): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;
  const baseUrl = (process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com').replace(
    /\/+$/,
    '',
  );
  return {
    baseUrl,
    publicKey,
    secretKey,
    environment: process.env.LANGFUSE_ENVIRONMENT ?? 'default',
    release: process.env.LANGFUSE_RELEASE,
  };
}

export function langfuseEnabled(): boolean {
  return langfuseConfig() !== null;
}

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
 * This is what makes a conversation span across processes. A tier-(a) conversation turn is its own
 * `agentGenerateMessage` action invocation, so there is no in-memory parent to hang children off
 * and nothing shared between turns but the conversation id itself. Hashing that id gives every
 * turn the same trace id with zero coordination and nothing to persist.
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

// ---------------------------------------------------------------- span construction

type AttributeValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { arrayValue: { values: AttributeValue[] } };

type Attribute = { key: string; value: AttributeValue };

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status?: { code: number; message?: string };
};

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

function str(key: string, value: string): Attribute {
  const limit = maxAttributeChars();
  return {
    key,
    value: {
      stringValue:
        value.length > limit
          ? value.slice(0, limit) + `…[truncated from ${value.length} chars]`
          : value,
    },
  };
}

// Langfuse reads input/output as JSON strings. Messages arrays serialize verbatim, which is what
// gets the full system prompt into the UI without any extra plumbing at the call sites.
function json(value: unknown): string {
  try {
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

function unixNano(ms: number): string {
  return String(Math.max(0, Math.round(ms))) + '000000';
}

// `langfuse.*.metadata.*` values are strings, so nested objects are stringified rather than
// flattened further.
function metadataAttributes(prefix: string, metadata: Record<string, unknown>): Attribute[] {
  const out: Attribute[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    out.push(str(`${prefix}.${key}`, typeof value === 'string' ? value : json(value)));
  }
  return out;
}

export function buildSpan(
  config: LangfuseConfig,
  trace: TraceRef,
  observation: Observation,
): OtlpSpan {
  const attributes: Attribute[] = [
    str('langfuse.observation.type', observation.type ?? 'span'),
    str('langfuse.environment', config.environment),
  ];
  if (config.release) attributes.push(str('langfuse.release', config.release));
  if (trace.traceName) attributes.push(str('langfuse.trace.name', trace.traceName));
  if (trace.sessionId) attributes.push(str('langfuse.session.id', trace.sessionId));
  if (trace.userId) attributes.push(str('langfuse.user.id', trace.userId));
  if (trace.tags?.length) {
    attributes.push({
      key: 'langfuse.trace.tags',
      value: { arrayValue: { values: trace.tags.map((tag) => ({ stringValue: tag })) } },
    });
  }
  if (trace.traceMetadata) {
    attributes.push(...metadataAttributes('langfuse.trace.metadata', trace.traceMetadata));
  }
  if (observation.input !== undefined) {
    attributes.push(str('langfuse.observation.input', json(observation.input)));
  }
  if (observation.output !== undefined) {
    attributes.push(str('langfuse.observation.output', json(observation.output)));
  }
  if (observation.model) {
    attributes.push(str('langfuse.observation.model.name', observation.model));
  }
  if (observation.modelParameters) {
    attributes.push(
      str('langfuse.observation.model.parameters', json(observation.modelParameters)),
    );
  }
  if (observation.usage) {
    const usage: Record<string, number> = {};
    if (observation.usage.input !== undefined) usage.input = observation.usage.input;
    if (observation.usage.output !== undefined) usage.output = observation.usage.output;
    if (observation.usage.total !== undefined) usage.total = observation.usage.total;
    if (Object.keys(usage).length) {
      attributes.push(str('langfuse.observation.usage_details', json(usage)));
    }
  }
  if (observation.metadata) {
    attributes.push(...metadataAttributes('langfuse.observation.metadata', observation.metadata));
  }
  if (observation.level) {
    attributes.push(str('langfuse.observation.level', observation.level));
  }
  if (observation.statusMessage) {
    attributes.push(str('langfuse.observation.status_message', observation.statusMessage));
  }
  return {
    traceId: trace.traceId,
    spanId: observation.spanId ?? randomSpanId(),
    ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
    name: observation.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: unixNano(observation.startTime),
    endTimeUnixNano: unixNano(observation.endTime),
    attributes,
    ...(observation.level === 'ERROR'
      ? { status: { code: 2, message: observation.statusMessage } }
      : {}),
  };
}

// ---------------------------------------------------------------- export

// The API keys are ASCII, so a 12-line encoder beats depending on `btoa` being present in whatever
// the isolate exposes this month.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Ascii(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i);
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    out += Number.isNaN(b) ? '=' : B64[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    out += Number.isNaN(c) ? '=' : B64[c & 63];
  }
  return out;
}

async function exportSpans(config: LangfuseConfig, spans: OtlpSpan[]): Promise<void> {
  if (spans.length === 0) return;
  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'ai-town' } },
            { key: 'deployment.environment.name', value: { stringValue: config.environment } },
          ],
        },
        scopeSpans: [{ scope: { name: 'ai-town' }, spans }],
      },
    ],
  };
  const response = await fetch(config.baseUrl + OTLP_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + base64Ascii(`${config.publicKey}:${config.secretKey}`),
      // Opts into v4 real-time ingestion rather than the legacy batch path.
      'x-langfuse-ingestion-version': '4',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Langfuse OTLP export failed with ${response.status}: ${await response.text()}`,
    );
  }
}

/**
 * Accumulates spans and ships them in one request.
 *
 * Convex runs nothing after an action handler returns, so there is no background flush to lean on
 * -- the export has to be awaited inside the handler. Batching is how that stays cheap: the
 * agent-to-agent loop in `agent/interact.ts` produces a dozen spans and pays for one round trip.
 *
 * A batch that is never flushed simply never reports. That is the intended failure mode.
 */
export class LangfuseBatch {
  private readonly config: LangfuseConfig | null;
  private spans: OtlpSpan[] = [];

  constructor() {
    this.config = langfuseConfig();
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  add(trace: TraceRef, observation: Observation): void {
    if (!this.config) return;
    try {
      this.spans.push(buildSpan(this.config, trace, observation));
    } catch (error) {
      console.warn('Langfuse: dropping a span it could not build', error);
    }
  }

  async flush(): Promise<void> {
    if (!this.config || this.spans.length === 0) return;
    const pending = this.spans;
    this.spans = [];
    try {
      await exportSpans(this.config, pending);
    } catch (error) {
      // Observability is never allowed to fail the thing it observes.
      console.warn('Langfuse: export failed, dropping spans', error);
    }
  }
}

/** Ship a single observation immediately. Equivalent to a one-span batch. */
export async function recordObservation(trace: TraceRef, observation: Observation): Promise<void> {
  const batch = new LangfuseBatch();
  if (!batch.enabled) return;
  batch.add(trace, observation);
  await batch.flush();
}

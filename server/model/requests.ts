import type { ChatTrace, TraceEntry } from '../../agent/model/trace.ts';
import { purposeNamed, type Purpose } from '../../agent/purposes/index.ts';

/**
 * What the model endpoints accept (docs/14 §3).
 *
 * The backend cannot tell our frontend from a script that read its source (§3.0), so it narrows
 * what any caller can ask for instead. A model call is a purpose (§3.2): a registered name, and
 * vars that purpose checks for itself. There is no route left that takes a prompt, a model name or
 * a token limit from the client, which is what §3.1 and §3.4 were guarding on the free-form routes
 * before they closed. What is left here is the embedding and trace bounds, and the purpose lookup.
 *
 * The limits are read when a request arrives, not when the module loads, because
 * `server/index.ts` loads `.env.local` after its imports have run.
 */

/** A failure the client caused, answered with its own status rather than as an upstream 502. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function bad(message: string): never {
  throw new HttpError(400, message);
}

function setting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') bad(`${what} must be a string`);
  if (value.length > max) bad(`${what} is over ${max} characters`);
  return value;
}

/** A trace is ours and never reaches the provider; a malformed one is dropped, not refused. */
function traceOf(value: unknown): ChatTrace | undefined {
  if (!isRecord(value) || typeof value.traceId !== 'string' || typeof value.name !== 'string') {
    return undefined;
  }
  if (JSON.stringify(value).length > setting('MAX_TRACE_CHARS', 16_000)) return undefined;
  return value as ChatTrace;
}

// ---------------------------------------------------------------- purpose

export interface PurposeInput {
  name: string;
  purpose: Purpose<unknown, unknown>;
  vars: unknown;
  trace?: ChatTrace;
}

/**
 * A purpose call (docs/14 §3.2): a registered name and vars that purpose accepts.
 *
 * The purpose checks its own vars, which is tighter than any generic limit: it knows what its
 * text is for and how long it should be.
 */
export function purposeRequest(body: unknown): PurposeInput {
  if (!isRecord(body) || typeof body.purpose !== 'string') bad('purpose must be a string');
  const purpose = purposeNamed(body.purpose);
  if (!purpose) bad(`Unknown purpose ${body.purpose}`);
  let vars: unknown;
  try {
    vars = purpose.vars(body.vars);
  } catch (error) {
    bad(`vars for ${body.purpose}: ${(error as Error).message}`);
  }
  const request: PurposeInput = { name: body.purpose, purpose, vars };
  const trace = traceOf(body.trace);
  if (trace) request.trace = trace;
  return request;
}

// ---------------------------------------------------------------- embed

/** The texts of an embed request, bounded in number and length (§3.1). */
export function embedTexts(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.texts) || body.texts.length === 0) {
    bad('texts must be a non-empty array');
  }
  const maxTexts = setting('MAX_EMBED_TEXTS', 64);
  if (body.texts.length > maxTexts) bad(`At most ${maxTexts} texts per request`);
  const maxChars = setting('MAX_EMBED_CHARS', 8_000);
  return body.texts.map((value, index) => text(value, `texts[${index}]`, maxChars));
}

// ---------------------------------------------------------------- trace

/** The entries of a trace export, bounded in number (§3.5). The body size is capped on read. */
export function traceEntries(body: unknown): TraceEntry[] {
  if (!isRecord(body) || !Array.isArray(body.entries)) bad('entries must be an array');
  const maxEntries = setting('MAX_TRACE_ENTRIES', 200);
  if (body.entries.length > maxEntries) bad(`At most ${maxEntries} trace entries per request`);
  return body.entries.filter(
    (entry): entry is TraceEntry =>
      isRecord(entry) &&
      isRecord(entry.trace) &&
      typeof entry.trace.traceId === 'string' &&
      isRecord(entry.observation),
  );
}

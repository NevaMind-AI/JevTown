import { MEMORY_WORD_BUDGET, REASON_WORD_BUDGET } from './contract';
import { truncateWords } from './stateDocument';

/**
 * The state-update envelope of docs/05 §6.1, and its nested §6.2 variant.
 *
 * Nothing here throws. Nothing here carries physics either, any more: the projection the tick
 * loop reads is the `<blocked/>` / `<unblocked/>` tag inside the state document itself, derived
 * where the document is applied (`aiTown/entityInputs.ts`). One text, one source of truth — a
 * JSON field beside the prose was a second one, and the two could disagree.
 */

export interface EnvelopeUpdate {
  /** Absent when the model emitted no state; the caller keeps the previous document. */
  state?: string;
  memory: string[];
  reason: string;
  tags: Record<string, unknown>;
  /** Truncations and shape complaints, recorded for the audit rather than raised. */
  problems: string[];
}

export interface ParsedEnvelope {
  self: EnvelopeUpdate;
  /** Present for the §6.2 actor→prop shape, where one call updates both sides. */
  target?: EnvelopeUpdate;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pull the first JSON object out of model output, which routinely arrives wrapped in a fenced
 * block or a sentence of preamble. Returns undefined rather than throwing.
 */
export function extractJsonObject(raw: string): unknown {
  if (!raw) {
    return undefined;
  }
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(raw);
  const candidates = [fenced?.[1], raw].filter((text): text is string => !!text);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start === -1) {
      continue;
    }
    // Scan for the matching brace rather than trusting the last `}` in the string, which may
    // belong to prose after the object.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const char = candidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

function parseUpdate(value: unknown): EnvelopeUpdate {
  const problems: string[] = [];
  if (!isRecord(value)) {
    return { memory: [], reason: '', tags: {}, problems: ['update is not an object'] };
  }

  let state: string | undefined;
  if (typeof value.state === 'string' && value.state.trim() !== '') {
    state = value.state;
  } else if (value.state !== undefined) {
    problems.push('state is not a non-empty string, keeping the previous document');
  }

  if (value.physics !== undefined) {
    // A model still emitting the old JSON projection. Recorded rather than honoured: the tag in
    // the document is the only thing that moves physics now.
    problems.push('envelope carried a "physics" field, which is no longer read');
  }

  // Memory and reason truncate rather than re-ask (docs/05 §5.1 as amended).
  const memory: string[] = [];
  const rawMemory = Array.isArray(value.memory) ? value.memory : [];
  if (value.memory !== undefined && !Array.isArray(value.memory)) {
    problems.push('memory is not an array, ignored');
  }
  for (const entry of rawMemory) {
    if (typeof entry !== 'string') {
      problems.push('dropped a non-string memory entry');
      continue;
    }
    const { text, truncated } = truncateWords(entry, MEMORY_WORD_BUDGET);
    if (truncated) {
      problems.push('truncated a memory entry to budget');
    }
    if (text.trim() !== '') {
      memory.push(text);
    }
  }

  let reason = typeof value.reason === 'string' ? value.reason : '';
  if (reason === '') {
    // docs/05 §9.2 makes `reason` mandatory on every write. Missing is a real defect — it is the
    // only trace this branch has (§9.3) — but not one worth discarding a state update over.
    problems.push('reason missing');
  }
  const truncatedReason = truncateWords(reason, REASON_WORD_BUDGET);
  if (truncatedReason.truncated) {
    problems.push('truncated reason to budget');
  }
  reason = truncatedReason.text;

  const tags = isRecord(value.tags) ? value.tags : {};
  if (value.tags !== undefined && !isRecord(value.tags)) {
    problems.push('tags is not an object, ignored');
  }

  return { state, memory, reason, tags, problems };
}

export function parseEnvelope(raw: string): ParsedEnvelope {
  const value = extractJsonObject(raw);
  if (value === undefined) {
    return {
      self: {
        memory: [],
        reason: '',
        tags: {},
        problems: ['no JSON object found in the response'],
      },
      problems: ['no JSON object found in the response'],
    };
  }
  if (isRecord(value) && (value.self !== undefined || value.target !== undefined)) {
    // The §6.2 shape: one call updates the acting agent and the prop it acted on.
    return {
      self: parseUpdate(value.self),
      target: value.target === undefined ? undefined : parseUpdate(value.target),
      problems: [],
    };
  }
  return { self: parseUpdate(value), problems: [] };
}

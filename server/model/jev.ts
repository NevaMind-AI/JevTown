import { recordObservation } from './langfuse.ts';
import { retryWithBackoff } from './llm.ts';
import type { ChatTrace, Observation } from '../../agent/model/trace.ts';
import type { SystemOneAnswers, SystemOneQuestions, LLMUsage } from '../../agent/model/client.ts';

/**
 * The System One provider (docs/12 §5).
 *
 * Deliberately not part of `getLLMConfig`. That function resolves two axes — a chat endpoint and an
 * embedding endpoint — and both speak the OpenAI wire format, which is what makes `LLMProvider` a
 * meaningful union. Jev speaks neither: no messages, no choices, no streaming, a different path.
 * Folding it in would mean a provider whose every branch is an exception, so it gets its own config
 * and its own file, following the `LLM_EMBEDDING_API_URL` precedent of a second independent axis.
 */

export interface JevConfig {
  /** No trailing slash. */
  url: string;
  apiKey: string | undefined;
  model: string;
}

export function getJevConfig(): JevConfig {
  return {
    url: (process.env.JEV_API_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, ''),
    apiKey: process.env.JEV_API_KEY,
    // Pinned, not `jev-latest`. An alias moves when a release ships, and a world one can replay is
    // worth more here than one that silently gets a newer model's judgment.
    model: process.env.JEV_MODEL ?? 'jev-1.13.0',
  };
}

export interface SystemOneRequest {
  state: unknown;
  questions: SystemOneQuestions;
  model?: string;
  trace?: ChatTrace;
}

export interface SystemOneResponse {
  answers: SystemOneAnswers;
  model?: string;
  usage?: LLMUsage;
  retries: number;
  ms: number;
}

/** Output tokens are free and `usage` names its fields differently; normalize to ours. */
export function normalizeUsage(usage: unknown): LLMUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const { input_tokens: input, output_tokens: output } = usage as Record<string, unknown>;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;
  return {
    input: typeof input === 'number' ? input : undefined,
    output: typeof output === 'number' ? output : undefined,
    total: typeof input === 'number' && typeof output === 'number' ? input + output : undefined,
  };
}

export async function systemOne(body: SystemOneRequest): Promise<SystemOneResponse> {
  const config = getJevConfig();
  // `trace` is ours, not the provider's. Split it off before anything serializes it onto the wire.
  const { trace, ...rest } = body;
  const request = { ...rest, model: rest.model ?? config.model };
  const startTime = Date.now();
  try {
    const { result, retries, ms } = await retryWithBackoff(async () => {
      const response = await fetch(config.url + '/v1/systemone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}),
        },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const error = await response.text();
        console.error({ error });
        throw {
          retry: response.status === 429 || response.status >= 500,
          error: new Error(`System One call failed with code ${response.status}: ${error}`),
        };
      }
      const json = (await response.json()) as {
        answers?: SystemOneAnswers;
        model?: string;
        usage?: unknown;
      };
      if (typeof json.answers !== 'object' || json.answers === null) {
        throw new Error('Unexpected System One result: ' + JSON.stringify(json));
      }
      return { answers: json.answers, model: json.model, usage: normalizeUsage(json.usage) };
    });

    await report(trace, {
      request,
      answers: result.answers,
      model: result.model ?? request.model,
      usage: result.usage,
      startTime,
      retries,
      ms,
    });
    return { ...result, retries, ms };
  } catch (error) {
    // A failed call is worth a span too: a trace that simply stops has no explanation in it.
    await report(trace, { request, model: request.model, startTime, error });
    throw error;
  }
}

/**
 * A generation observation for a call with no messages and no completion.
 *
 * The questions are the interesting half of the input, so they go in `input` alongside the state,
 * and the typed answers — probabilities included — are the output. Langfuse will report zero cost
 * for a model it does not know, which is accurate enough: input is billed at $42 per billion
 * tokens, so a decision is worth about two hundredths of a cent.
 */
async function report(
  trace: ChatTrace | undefined,
  details: {
    request: { state: unknown; questions: SystemOneQuestions; model: string };
    answers?: SystemOneAnswers;
    model?: string;
    usage?: LLMUsage;
    startTime: number;
    retries?: number;
    ms?: number;
    error?: unknown;
  },
) {
  if (!trace) return;
  const { name, metadata, ...ref } = trace;
  const observation: Observation = {
    name,
    type: 'generation',
    startTime: details.startTime,
    endTime: Date.now(),
    input: { state: details.request.state, questions: details.request.questions },
    output: details.error ? undefined : details.answers,
    model: details.model,
    usage: details.usage,
    metadata: {
      ...metadata,
      ...(details.retries !== undefined ? { retries: details.retries } : {}),
      ...(details.ms !== undefined ? { providerMs: details.ms } : {}),
    },
    ...(details.error
      ? {
          level: 'ERROR' as const,
          statusMessage:
            details.error instanceof Error ? details.error.message : String(details.error),
        }
      : {}),
  };
  await recordObservation(ref, observation);
}

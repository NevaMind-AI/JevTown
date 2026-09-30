import type { ChatTrace } from '../model/trace.ts';
import type { LLMUsage, SystemOneAnswers, SystemOneQuestions } from '../model/client.ts';

/**
 * A purpose: one kind of model call the game makes, named rather than written out (docs/14 §3.2).
 *
 * The tab sends a purpose's name and its `vars`. The server checks the vars, renders the request,
 * calls the model, parses the answer and returns the result. The tab never sends a prompt, so the
 * model endpoints stop being a general-purpose LLM with our key attached.
 *
 * Everything under `agent/purposes/` is imported by the server as well as the tab, and the server
 * runs with type stripping and no build step (docs/14 §4.3). So these files import only each
 * other, with explicit `.ts` extensions, and use no TypeScript that needs compiling: no enums, no
 * parameter properties, no namespaces.
 */

/** A chat completion: the request it renders, and what its text means. */
export interface ChatVariant<Vars, Result> {
  kind: 'chat';
  /** `retryHint` is set only when `converse` asks again, and says why. */
  render(
    vars: Vars,
    retryHint?: string,
  ): {
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    max_tokens: number;
    temperature?: number;
    stop?: string[];
  };
  /**
   * The text, read into the result, against the vars it answers. Throws when there is nothing to
   * read. A variant has this or `converse`, never both.
   */
  parse?(content: string, vars: Vars): Result;
  /**
   * For a purpose that may ask more than once, as a state write re-asks a document that ran over
   * its budget. `ask` runs one completion of `render(vars, retryHint)` and returns its text; the
   * server charges and traces each one. The re-ask loop and its hint stay the server's, so a
   * client can neither skip the budget nor write the hint.
   */
  converse?(ask: (retryHint?: string) => Promise<string>, vars: Vars): Promise<Result>;
}

/** A typed decision (docs/12): the questions it asks, and what the answers mean. */
export interface SystemOneVariant<Vars, Result> {
  kind: 'systemone';
  render(vars: Vars): { state: unknown; questions: SystemOneQuestions };
  parse(answers: SystemOneAnswers, vars: Vars): Result;
}

export interface Purpose<Vars, Result> {
  /**
   * The client's vars, checked and rebuilt. Throws with a message fit for a 400 on anything else.
   * The bounds here replace the generic prompt limits: a purpose knows what its text should be.
   */
  vars(input: unknown): Vars;
  /**
   * One way of answering per kind of model. The tab cannot choose between them. When there is
   * more than one, the server setting named by `setting` does, and the result has the same shape
   * either way.
   */
  variants: { chat?: ChatVariant<Vars, Result>; systemone?: SystemOneVariant<Vars, Result> };
  setting?: string;
}

/** `POST /llm/purpose`. */
export interface PurposeRequest {
  purpose: string;
  vars: unknown;
  trace?: ChatTrace;
}

export interface PurposeResponse<Result> {
  result: Result;
  /**
   * Which variant answered. The tab may log or show it, but never branches on it: the result is
   * already parsed, and its shape does not depend on the provider.
   */
  provider: 'chat' | 'systemone';
  model?: string;
  usage?: LLMUsage;
  ms: number;
}

/**
 * A provider, in the words the traces already used for the two deciders (docs/12 §2): `llm` for a
 * chat model and `jev` for System One. For a tag or a metadata field, never for a branch.
 */
export function deciderOf(provider: PurposeResponse<unknown>['provider']): 'llm' | 'jev' {
  return provider === 'systemone' ? 'jev' : 'llm';
}

// ---------------------------------------------------------------- checking vars

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${what} must be a string`);
  if (value.length > max) throw new Error(`${what} is over ${max} characters`);
  return value;
}

/** An optional string: absent, or within `max`. */
export function optionalText(value: unknown, what: string, max: number): string | undefined {
  return value === undefined || value === null ? undefined : text(value, what, max);
}

/** An array of at most `max` items, each checked by `item`. */
export function list<T>(
  value: unknown,
  what: string,
  max: number,
  item: (value: unknown, what: string) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${what} must be an array`);
  if (value.length > max) throw new Error(`${what} has more than ${max} items`);
  return value.map((entry, index) => item(entry, `${what}[${index}]`));
}

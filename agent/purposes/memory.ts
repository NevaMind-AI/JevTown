import { history, historyMessages, type Line } from './conversation.ts';
import { NAME_CHARS } from './sections.ts';
import { isRecord, list, text, type Purpose } from './types.ts';

/**
 * Memory for agents without prose state (docs/07 §6.3): summarising a finished conversation, and
 * reflecting on many memories at once. The prompts are the ones `agent/memory.ts` built in the
 * tab, moved unchanged.
 */

// ---------------------------------------------------------------- summarising a conversation

export interface RememberVars {
  speaker: string;
  listener: string;
  history: Line[];
}

export const conversationRemember: Purpose<RememberVars, string> = {
  vars(input) {
    if (!isRecord(input)) throw new Error('vars must be an object');
    return {
      speaker: text(input.speaker, 'speaker', NAME_CHARS),
      listener: text(input.listener, 'listener', NAME_CHARS),
      history: history(input.history),
    };
  },
  variants: {
    chat: {
      kind: 'chat',
      render: ({ speaker, listener, history: lines }) => ({
        messages: [
          {
            role: 'user',
            content: `You are ${speaker}, and you just finished a conversation with ${listener}. I would
      like you to summarize the conversation from ${speaker}'s perspective, using first-person pronouns like
      "I," and add if you liked or disliked this interaction.`,
          },
          ...historyMessages({ speaker, listener }, lines),
          { role: 'user', content: 'Summary:' },
        ],
        max_tokens: 500,
      }),
      parse: (content) => content,
    },
  },
};

// ---------------------------------------------------------------- reflecting

export interface ReflectVars {
  name: string;
  /** Memory descriptions, numbered in this order as the model reads them. */
  statements: string[];
}

export interface Insight {
  insight: string;
  /** Indexes into `statements`. */
  statementIds: number[];
}

/** `agent/memory.ts` reads back the latest 100. */
const MAX_STATEMENTS = 100;
const STATEMENT_CHARS = 8_000;

/**
 * The reflection's JSON, checked rather than cast.
 *
 * The tab used to cast the parsed answer and find out it was wrong when an index missed; here an
 * answer that is not an array of insights over the statements it was given is not an answer.
 */
export function parseInsights(content: string, statements: string[]): Insight[] {
  const value: unknown = JSON.parse(content);
  if (!Array.isArray(value)) throw new Error('the reflection is not an array');
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.insight !== 'string' || !Array.isArray(item.statementIds)) {
      throw new Error(`insight ${index} needs insight and statementIds`);
    }
    for (const id of item.statementIds) {
      if (!Number.isInteger(id) || id < 0 || id >= statements.length) {
        throw new Error(`insight ${index} cites statement ${String(id)}, which was not given`);
      }
    }
    return { insight: item.insight, statementIds: item.statementIds as number[] };
  });
}

export const memoryReflect: Purpose<ReflectVars, Insight[]> = {
  vars(input) {
    if (!isRecord(input)) throw new Error('vars must be an object');
    return {
      name: text(input.name, 'name', NAME_CHARS),
      statements: list(input.statements, 'statements', MAX_STATEMENTS, (value, what) =>
        text(value, what, STATEMENT_CHARS),
      ),
    };
  },
  variants: {
    chat: {
      kind: 'chat',
      render: ({ name, statements }) => {
        const prompt = [
          '[no prose]',
          '[Output only JSON]',
          `You are ${name}, statements about you:`,
        ];
        statements.forEach((statement, idx) => {
          prompt.push(`Statement ${idx}: ${statement}`);
        });
        prompt.push('What 3 high-level insights can you infer from the above statements?');
        prompt.push(
          'Return in JSON format, where the key is a list of input statements that contributed to your insights and value is your insight. Make the response parseable by Typescript JSON.parse() function. DO NOT escape characters or include "\n" or white space in response.',
        );
        prompt.push(
          'Example: [{insight: "...", statementIds: [1,2]}, {insight: "...", statementIds: [1]}, ...]',
        );
        return {
          messages: [{ role: 'user', content: prompt.join('\n') }],
          // The tab sent no limit here, so it has had the server's cap of 1500 since §3.1.
          max_tokens: 1500,
        };
      },
      parse: (content, { statements }) => parseInsights(content, statements),
    },
  },
};

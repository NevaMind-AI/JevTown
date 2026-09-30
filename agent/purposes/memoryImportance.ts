import { isRecord, text, type Purpose } from './types.ts';

/**
 * How poignant a memory is, 0 to 9.
 *
 * Importance only ranks memories against each other, so the rating is one digit and the call is
 * the cheapest the game makes. The prompt is the one `agent/memory.ts` has always sent.
 */

export interface ImportanceVars {
  description: string;
}

// A 0-9 rating is a single token of content, but a budget of exactly 1 leaves no room for
// anything the model puts *around* it -- a leading newline, `**7**`, a chat template's preamble.
// Worse, our gateway answers a truncated completion with a fatal 400 rather than the standard
// `finish_reason: "length"`, so overrunning by one token loses the whole action. Small enough to
// stay cheap, generous enough that the digit always fits.
const IMPORTANCE_MAX_TOKENS = 16;

// Importance only ranks memories against each other. A rating we could not get or could not read
// is worth a mid-scale guess -- never worth losing the memory it belongs to.
export const DEFAULT_IMPORTANCE = 5;

/** Longer than any memory the game writes: a conversation summary is capped at 500 tokens. */
const MAX_DESCRIPTION_CHARS = 8_000;

// The prompt asks for a bare digit and that is usually what comes back, but a wrapper like
// `**7**` or `Rating: 7` still carries one. A long answer is a different matter: it tends to
// restate the prompt ("on a scale of 0 to 9..."), whose first number is not the rating -- so it
// is not trusted to contain one at all.
export function parseImportance(raw: string): number {
  const trimmed = raw.trim();
  const found = /^\d+$/.test(trimmed)
    ? trimmed
    : trimmed.length <= 32
      ? trimmed.match(/\d+/)?.[0]
      : undefined;
  if (found === undefined) {
    console.debug('Could not parse memory importance from: ', raw);
    return DEFAULT_IMPORTANCE;
  }
  // The scale is 0-9; a model that answers "10" still gets clamped onto it.
  return Math.min(9, Math.max(0, Number(found)));
}

export const memoryImportance: Purpose<ImportanceVars, number> = {
  vars(input) {
    if (!isRecord(input)) throw new Error('vars must be an object');
    return { description: text(input.description, 'description', MAX_DESCRIPTION_CHARS) };
  },
  variants: {
    chat: {
      kind: 'chat',
      render: ({ description }) => ({
        messages: [
          {
            role: 'user',
            content: `On the scale of 0 to 9, where 0 is purely mundane (e.g., brushing teeth, making bed) and 9 is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory.
      Memory: ${description}
      Answer on a scale of 0 to 9. Respond with number only, e.g. "5"`,
          },
        ],
        temperature: 1,
        max_tokens: IMPORTANCE_MAX_TOKENS,
      }),
      parse: parseImportance,
    },
  },
};

import type { LLMUsage } from './llm.ts';

/**
 * What a model call is estimated to cost, in US dollars (docs/14 §3.6).
 *
 * Budgets are denominated in money rather than calls, because a call count misprices both kinds of
 * call: a System One decision costs about two thousandths of a chat completion (docs/12 §8). One
 * price per axis is enough because the server pins the model on each axis (§3.1).
 *
 * The defaults are placeholders in the right range, not anyone's price list. Set them to the
 * provider's. A call whose provider reports no usage is estimated at four characters per token, so
 * a provider that omits usage cannot make calls free.
 *
 * Prices are USD per million tokens, read per call so `.env.local` can set them.
 */

function price(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const tokensIn = (chars: number) => Math.ceil(chars / 4);

export function chatCost(usage: LLMUsage | undefined, promptChars: number, outputChars: number) {
  const input = usage?.input ?? tokensIn(promptChars);
  const output = usage?.output ?? tokensIn(outputChars);
  return (input * price('CHAT_PRICE_INPUT', 0.15) + output * price('CHAT_PRICE_OUTPUT', 0.6)) / 1e6;
}

export function embedCost(tokens: number | undefined, chars: number) {
  return ((tokens ?? tokensIn(chars)) * price('EMBED_PRICE', 0.02)) / 1e6;
}

/** Jev bills input only: $42 per billion tokens (`server/model/jev.ts`). */
export function systemOneCost(usage: LLMUsage | undefined, requestChars: number) {
  return ((usage?.input ?? tokensIn(requestChars)) * price('SYSTEMONE_PRICE_INPUT', 0.042)) / 1e6;
}

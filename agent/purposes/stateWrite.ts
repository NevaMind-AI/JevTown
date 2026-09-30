import {
  ENVELOPE_INSTRUCTION,
  STATE_REASK_LIMIT,
  STATE_WORD_BUDGET,
} from '../../engine/prose/contract.ts';
import { parseEnvelope, type EnvelopeUpdate } from '../../engine/prose/envelope.ts';
import {
  parseStateDocument,
  type Conformance,
  type StateDocument,
} from '../../engine/prose/stateDocument.ts';
import { history, historyMessages, type Line } from './conversation.ts';
import {
  NAME_CHARS,
  proseContext,
  stateWritingSystemPrompt,
  type ProseContext,
} from './sections.ts';
import { isRecord, list, text, type ChatVariant, type Purpose } from './types.ts';

/**
 * State writes: one call that emits an entity's rewritten state, its memories and its reason
 * (docs/05 §6.1), re-asked once if the state runs over budget.
 *
 * Two purposes write this way: `conversation.state` after a conversation between players, and
 * `interaction.state` after an exchange with a fixed actor (`./interaction.ts`). Both answer with
 * a `StateUpdateOutcome`, parsed and budget-checked on the server.
 */

export interface StateUpdateOutcome {
  update: EnvelopeUpdate;
  document?: StateDocument;
  conformance?: Conformance;
  /** Present only when the update survived: the document to write. */
  state?: string;
  reasks: number;
  /** True when the update was discarded and the entity keeps its previous document. */
  fellBack: boolean;
  problems: string[];
}

/**
 * The re-ask loop of docs/08 §7 D2, as a pure function over an `ask` callback.
 *
 * It runs on the server now, inside a purpose's `converse` (docs/14 §3.2), so the hint it re-asks
 * with is the server's text and a client cannot skip the budget. It never lived in an input
 * handler, because a handler can reject or truncate but never re-ask. Length is the only thing worth
 * re-asking over — a missing section, an invented head-state or a document with no structure at
 * all are tolerated and recorded, because what an entity does with a malformed state document is
 * an observation rather than a bug (docs/05 §5.1 as amended).
 *
 * Taking `ask` as a parameter is what makes the loop testable without a model.
 */
export async function requestStateUpdate(opts: {
  ask: (retryHint?: string) => Promise<string>;
  reaskLimit?: number;
}): Promise<StateUpdateOutcome> {
  const limit = opts.reaskLimit ?? STATE_REASK_LIMIT;
  let reasks = 0;
  let raw = await opts.ask();
  let parsed = parseEnvelope(raw);
  let problems = [...parsed.problems, ...parsed.self.problems];

  for (;;) {
    const state = parsed.self.state;
    if (state === undefined) {
      // No state in the envelope. Nothing to fall back *from* — the entity simply keeps what it
      // had, and physics and memory in the same envelope still apply.
      return { update: parsed.self, reasks, fellBack: false, problems };
    }
    const { document, conformance } = parseStateDocument(state);
    conformance.reasks = reasks;
    if (!conformance.overBudget) {
      return {
        update: parsed.self,
        document,
        conformance,
        state,
        reasks,
        fellBack: false,
        problems,
      };
    }
    if (reasks >= limit) {
      conformance.fellBack = true;
      problems = [...problems, `still over ${STATE_WORD_BUDGET} words after ${reasks} re-ask(s)`];
      return {
        update: { ...parsed.self, state: undefined },
        document,
        conformance,
        reasks,
        fellBack: true,
        problems,
      };
    }
    reasks += 1;
    raw = await opts.ask(
      `That was ${conformance.budgetWordCount} words of prose, over the ${STATE_WORD_BUDGET}-word limit. Send the same state document again, shorter, keeping every section. The record blocks do not count toward the limit and must come back unchanged.`,
    );
    parsed = parseEnvelope(raw);
    problems = [...problems, ...parsed.problems, ...parsed.self.problems];
  }
}

/** A line of an exchange, as a state-writing prompt reads it back: `Name: text`. */
export interface SaidLine {
  name: string;
  text: string;
}

const LINE_CHARS = 2_000;
const MAX_LINES = 64;

export const saidLines = (value: unknown, what: string) =>
  list(value, what, MAX_LINES, (line, where): SaidLine => {
    if (!isRecord(line)) throw new Error(`${where} must be an object`);
    return {
      name: text(line.name, `${where}.name`, NAME_CHARS),
      text: text(line.text, `${where}.text`, LINE_CHARS),
    };
  });

/**
 * A state-writing chat variant: render with the hint when there is one, and let the re-ask loop
 * read the answers.
 */
export function stateWrite<Vars>(
  render: (vars: Vars, retryHint?: string) => ReturnType<ChatVariant<Vars, never>['render']>,
): ChatVariant<Vars, StateUpdateOutcome> {
  return {
    kind: 'chat',
    render,
    converse: (ask) => requestStateUpdate({ ask }),
  };
}

// ---------------------------------------------------------------- after a conversation

export interface ConversationStateVars {
  self: ProseContext;
  /** The two players' names, as the transcript labels their lines. */
  speaker: string;
  listener: string;
  history: Line[];
}

export const conversationState: Purpose<ConversationStateVars, StateUpdateOutcome> = {
  vars(input) {
    if (!isRecord(input)) throw new Error('vars must be an object');
    return {
      self: proseContext(input.self, 'self'),
      speaker: text(input.speaker, 'speaker', NAME_CHARS),
      listener: text(input.listener, 'listener', NAME_CHARS),
      history: history(input.history),
    };
  },
  variants: {
    chat: stateWrite<ConversationStateVars>((vars, retryHint) => ({
      messages: [
        { role: 'system', content: stateWritingSystemPrompt(vars.self, ENVELOPE_INSTRUCTION) },
        {
          role: 'user',
          content: `You just finished a conversation with ${vars.listener}. It went like this.`,
        },
        ...historyMessages(vars, vars.history),
        {
          role: 'user',
          content:
            retryHint ??
            `Rewrite your state now that the conversation is over, and say what you will remember.`,
        },
      ],
      max_tokens: 1200,
    })),
  },
};

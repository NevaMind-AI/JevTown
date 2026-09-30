import { ENVELOPE_INSTRUCTION, TARGET_ENVELOPE_INSTRUCTION } from '../../engine/prose/contract.ts';
import { parseEnvelope, type ParsedEnvelope } from '../../engine/prose/envelope.ts';
import {
  NAME_CHARS,
  describe,
  proseContext,
  stateWritingSystemPrompt,
  worldRulesSection,
  worldStateSection,
  type ProseContext,
} from './sections.ts';
import { saidLines, stateWrite, type SaidLine, type StateUpdateOutcome } from './stateWrite.ts';
import { isRecord, optionalText, text, type Purpose } from './types.ts';

/**
 * An agent's exchange with a fixed entity (docs/09 §6): acting on a prop, or talking with a fixed
 * actor and then writing state. The prompts are the ones `agent/interact.ts` built in the tab,
 * moved unchanged; the exchange itself, and what it records, stays there.
 */

/** What the agent came to do. It wrote this itself, in its decision. */
const INTENT_CHARS = 2_000;

// ---------------------------------------------------------------- actor → prop

export interface PropVars {
  actor: ProseContext;
  target: ProseContext;
  intent: string;
}

/**
 * docs/05 §6.2, actor → prop. One-way and one call: the acting agent writes both its own state
 * and the prop's, because the prop makes no call of its own and has no memory to write. The
 * answer is the parsed envelope, with both sides in it.
 */
export const interactionProp: Purpose<PropVars, ParsedEnvelope> = {
  vars(input) {
    if (!isRecord(input)) throw new Error('vars must be an object');
    return {
      actor: proseContext(input.actor, 'actor'),
      target: proseContext(input.target, 'target'),
      intent: text(input.intent, 'intent', INTENT_CHARS),
    };
  },
  variants: {
    chat: {
      kind: 'chat',
      render: ({ actor, target, intent }) => ({
        messages: [
          {
            role: 'system',
            content: [
              stateWritingSystemPrompt(actor, ''),
              '',
              // `behavior` rides along with the description here as it does everywhere else, and
              // it has to: a prop writes no state of its own, so any rule about how this thing
              // behaves is only ever read by the actor acting on it (docs/05 §6.2).
              `In front of you: ${target.name}. ${describe(target)}`,
              ...(target.state ? ['Its state right now:', target.state] : []),
              ...(target.physics
                ? [
                    target.physics.blocksMovement
                      ? 'Right now it is solid: nobody can get past it.'
                      : 'Right now it is not solid: people can get past it.',
                  ]
                : []),
              '',
              TARGET_ENVELOPE_INSTRUCTION,
            ].join('\n'),
          },
          {
            role: 'user',
            content: intent
              ? `You came here meaning to: ${intent}. Do it, and write what you and it are like afterwards.`
              : `Act on it, and write what you and it are like afterwards.`,
          },
        ],
        max_tokens: 1200,
      }),
      parse: (content) => parseEnvelope(content),
    },
  },
};

// ---------------------------------------------------------------- a turn with a fixed actor

export interface TurnVars {
  speaker: ProseContext;
  otherName: string;
  transcript: SaidLine[];
  /** Only on the exchange's first turn, and only when the agent came with an intent. */
  intent?: string;
}

/**
 * One turn: `speaker` says one thing to `otherName`, given everything said so far.
 *
 * World-level prose goes through the shared sections rather than an inlined variant. This was the
 * one prompt that phrased `world_rules` in its own words, which meant it was also the one prompt
 * that would have silently missed common knowledge (docs/05 §5.3).
 */
export const interactionTurn: Purpose<TurnVars, string> = {
  vars(input) {
    if (!isRecord(input)) throw new Error('vars must be an object');
    const vars: TurnVars = {
      speaker: proseContext(input.speaker, 'speaker'),
      otherName: text(input.otherName, 'otherName', NAME_CHARS),
      transcript: saidLines(input.transcript, 'transcript'),
    };
    const intent = optionalText(input.intent, 'intent', INTENT_CHARS);
    if (intent) vars.intent = intent;
    return vars;
  },
  variants: {
    chat: {
      kind: 'chat',
      render: ({ speaker, otherName, transcript, intent }) => ({
        messages: [
          {
            role: 'system',
            content: [
              `You are ${speaker.name}. ${describe(speaker)}`,
              ...(speaker.state ? [speaker.state] : []),
              ...worldRulesSection(speaker),
              ...worldStateSection(speaker),
              `You are speaking with ${otherName}.`,
              'Say one thing. Keep it under 200 characters. Reply with the words you say and nothing else.',
            ].join('\n'),
          },
          ...(intent
            ? [{ role: 'user' as const, content: `You came here meaning to: ${intent}.` }]
            : []),
          ...transcript.map((line) => ({
            role: 'user' as const,
            content: `${line.name}: ${line.text}`,
          })),
          { role: 'user', content: `${speaker.name}:` },
        ],
        max_tokens: 200,
      }),
      parse: (content) => content.trim(),
    },
  },
};

// ---------------------------------------------------------------- state after the exchange

export interface InteractionStateVars {
  self: ProseContext;
  otherName: string;
  transcript: SaidLine[];
}

/**
 * docs/05 §6.1's conclusion for one side: a single call that emits state, physics, memory and
 * reason together, re-asked once if the state runs over budget.
 */
export const interactionState: Purpose<InteractionStateVars, StateUpdateOutcome> = {
  vars(input) {
    if (!isRecord(input)) throw new Error('vars must be an object');
    return {
      self: proseContext(input.self, 'self'),
      otherName: text(input.otherName, 'otherName', NAME_CHARS),
      transcript: saidLines(input.transcript, 'transcript'),
    };
  },
  variants: {
    chat: stateWrite<InteractionStateVars>((vars, retryHint) => ({
      messages: [
        { role: 'system', content: stateWritingSystemPrompt(vars.self, ENVELOPE_INSTRUCTION) },
        { role: 'user', content: `You just spoke with ${vars.otherName}. It went like this.` },
        ...vars.transcript.map((line) => ({
          role: 'user' as const,
          content: `${line.name}: ${line.text}`,
        })),
        {
          role: 'user',
          content: retryHint ?? 'Rewrite your state now that the exchange is over.',
        },
      ],
      max_tokens: 1200,
    })),
  },
};

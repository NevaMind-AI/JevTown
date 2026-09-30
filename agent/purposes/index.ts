import { agentDecide } from './agentDecide.ts';
import { conversationContinue, conversationLeave, conversationStart } from './conversation.ts';
import { godGate, godIntervention } from './god.ts';
import { interactionProp, interactionState, interactionTurn } from './interaction.ts';
import { conversationRemember, memoryReflect } from './memory.ts';
import { memoryImportance } from './memoryImportance.ts';
import { conversationState } from './stateWrite.ts';
import type { Purpose } from './types.ts';

/**
 * Every model call the game makes, by name (docs/14 §3.2).
 *
 * The names are the ones the traces already used for these calls, so a Langfuse query written
 * before the move still finds them.
 */
export const purposes = {
  'agent.decide': agentDecide,
  'conversation.start': conversationStart,
  'conversation.continue': conversationContinue,
  'conversation.leave': conversationLeave,
  'conversation.remember': conversationRemember,
  'conversation.state': conversationState,
  'god.gate': godGate,
  'god.intervention': godIntervention,
  'interaction.prop': interactionProp,
  'interaction.turn': interactionTurn,
  'interaction.state': interactionState,
  'memory.importance': memoryImportance,
  'memory.reflect': memoryReflect,
};

export type Purposes = typeof purposes;
export type PurposeName = keyof Purposes;
export type VarsOf<P extends PurposeName> = Purposes[P] extends Purpose<infer V, any> ? V : never;
export type ResultOf<P extends PurposeName> = Purposes[P] extends Purpose<any, infer R> ? R : never;

export function purposeNamed(name: string): Purpose<unknown, unknown> | undefined {
  return Object.prototype.hasOwnProperty.call(purposes, name)
    ? (purposes[name as PurposeName] as unknown as Purpose<unknown, unknown>)
    : undefined;
}

export type { Purpose, PurposeRequest, PurposeResponse } from './types.ts';

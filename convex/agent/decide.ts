import { DecisionManifest } from '../aiTown/manifest';
import { extractJsonObject } from '../prose/envelope';
import {
  PromptContext,
  commonKnowledgeSection,
  identitySection,
  worldRulesSection,
} from './promptContext';

/**
 * The target-selection call of docs/05 §6.4, specified by docs/09 §3-§4.
 *
 * The single largest behavioural change from stock AI Town: `agentDoSomething` chose among three
 * branches with `Math.random()` and a uniform random tile. Here it is a model call — but one the
 * engine has already constrained, because the manifest it is handed contains only legal options
 * (docs/09 §1).
 */

export type Decision =
  | { action: 'approach'; target: string; intent: string; reason: string }
  | { action: 'wander'; anchor: string; reason: string }
  | { action: 'idle'; durationMs: number; description: string; emoji?: string; reason: string };

export const DEFAULT_IDLE_MS = 30_000;
const MAX_IDLE_MS = 5 * 60_000;

/** What an agent does when the model gives nothing usable: stand still briefly and try again. */
export function idleFallback(reason: string): Decision {
  return { action: 'idle', durationMs: DEFAULT_IDLE_MS, description: 'thinking', reason };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Never throws, and never returns a choice outside the manifest. An out-of-manifest target is a
 * parse failure rather than something to validate later: the engine already decided what was
 * legal, so a model naming something else has not made a legal move that needs checking.
 */
export function parseDecision(
  raw: string,
  manifest: DecisionManifest,
): { decision: Decision; problems: string[] } {
  const problems: string[] = [];
  const value = extractJsonObject(raw);
  if (typeof value !== 'object' || value === null) {
    return {
      decision: idleFallback('The model returned nothing usable.'),
      problems: ['no JSON object found'],
    };
  }
  const object = value as Record<string, unknown>;
  const reason = asString(object.reason) ?? '';
  if (!reason) {
    problems.push('reason missing');
  }

  switch (object.action) {
    case 'approach': {
      const target = asString(object.target);
      if (!target || !manifest.targets.some((t) => t.id === target)) {
        problems.push(`approach target "${String(object.target)}" is not in the manifest`);
        return {
          decision: idleFallback(reason || 'Chose something that was not there.'),
          problems,
        };
      }
      return {
        decision: {
          action: 'approach',
          target,
          intent: asString(object.intent) ?? '',
          reason,
        },
        problems,
      };
    }
    case 'wander': {
      const anchor = asString(object.anchor);
      if (!anchor || !manifest.places.some((p) => p.id === anchor)) {
        problems.push(`wander anchor "${String(object.anchor)}" is not in the manifest`);
        return {
          decision: idleFallback(reason || 'Chose to go somewhere that was not there.'),
          problems,
        };
      }
      return { decision: { action: 'wander', anchor, reason }, problems };
    }
    case 'idle': {
      const raw = typeof object.duration_ms === 'number' ? object.duration_ms : DEFAULT_IDLE_MS;
      const durationMs = Math.min(Math.max(raw, 0), MAX_IDLE_MS);
      return {
        decision: {
          action: 'idle',
          durationMs,
          description: asString(object.description) ?? 'standing still',
          emoji: asString(object.emoji),
          reason,
        },
        problems,
      };
    }
    default:
      problems.push(`unknown action "${String(object.action)}"`);
      return { decision: idleFallback(reason || 'The model chose nothing.'), problems };
  }
}

function describeTargets(manifest: DecisionManifest): string[] {
  if (manifest.targets.length === 0) {
    return ['There is nobody and nothing you can go to right now.'];
  }
  const lines = ['You can go to any of these:'];
  for (const target of manifest.targets) {
    const parts = [`- ${target.id} — ${target.name}, ${target.what}, ${target.distance}`];
    if (target.where) {
      parts.push(`at ${target.where}`);
    }
    if (target.description) {
      parts.push(`— ${target.description}`);
    }
    lines.push(parts.join(' '));
  }
  return lines;
}

function describePlaces(manifest: DecisionManifest): string[] {
  if (manifest.places.length === 0) {
    return [];
  }
  return [
    'Places you can walk to for no particular reason:',
    ...manifest.places.map((place) => `- ${place.id} — ${place.description}`),
  ];
}

export const DECISION_INSTRUCTION = `Choose one thing to do, and reply with one JSON object and nothing else:

{ "action": "approach", "target": "<id from the list>", "intent": "<what you want from them, in your own words>", "reason": "<why, one sentence>" }
{ "action": "wander",   "anchor": "<place id>", "reason": "<why, one sentence>" }
{ "action": "idle",     "duration_ms": 60000, "description": "<what you are doing, a few words>", "emoji": "<one emoji>", "reason": "<why, one sentence>" }

Only use an id that appears in the lists above. "reason" is always required.`;

export function decisionSystemPrompt(context: PromptContext, manifest: DecisionManifest): string {
  return [
    ...identitySection(context),
    '',
    ...worldRulesSection(context),
    '',
    ...commonKnowledgeSection(context),
    '',
    ...(context.state ? ['Your state right now:', context.state] : []),
    '',
    ...describeTargets(manifest),
    '',
    ...describePlaces(manifest),
    '',
    DECISION_INSTRUCTION,
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}

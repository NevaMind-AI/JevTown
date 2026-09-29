import { useEffect, useRef, useState } from 'react';
import { Container, Text } from '@pixi/react';
import { StoredMessage } from '../../agent/ports';
import { AgenticRuntime } from '../sim/agenticRuntime';
import SpeechBubble from './SpeechBubble';

/**
 * What is drawn over an agent's head: the line it just said to another agent, and 💭 while it is
 * waiting on a model to decide what to do next.
 *
 * Both are keyed by `sourceId`, the authored id `MemoryWorld` draws the body under — the agentic
 * world has no bodies of its own to hang them on (docs/13 §2).
 */

/**
 * How long a line stays up, in game time — messages are stamped in it (docs/13 §3.1), so a bubble
 * holds still while the game is paused. Eight seconds keeps both halves of an exchange legible
 * without leaving stale text over someone who has walked off (the solarium demo's number).
 */
const BUBBLE_MS = 8_000;
/** A bubble is a glance, not a transcript. The debug panel has the whole thing. */
const BUBBLE_CHARS = 110;

/**
 * The latest line of each agent in a conversation with another agent, by `sourceId`.
 *
 * A conversation with the human is left out: its lines are already in the chat box, and a bubble
 * would say them twice. `listMessages` is async, so it is polled, and each conversation is read
 * once per line, keyed on `lastMessage.timestamp`.
 */
export function useAgentSpeech(runtime: AgenticRuntime | undefined): Map<string, string> {
  const [latest, setLatest] = useState<Record<string, StoredMessage>>({});
  const fetched = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!runtime) return;
    const timer = window.setInterval(() => {
      for (const conversation of runtime.game.world.conversations.values()) {
        const stamp = conversation.lastMessage?.timestamp ?? 0;
        if (!stamp || fetched.current[conversation.id] === stamp) continue;
        if (
          [...conversation.participants.keys()].some(
            (id) => runtime.game.world.players.get(id)?.human,
          )
        )
          continue;
        fetched.current[conversation.id] = stamp;
        void runtime.store.listMessages(conversation.id).then((list) => {
          const last = list[list.length - 1];
          if (last) setLatest((previous) => ({ ...previous, [conversation.id]: last }));
        });
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [runtime]);

  const spoken = new Map<string, string>();
  if (!runtime) return spoken;
  for (const message of Object.values(latest)) {
    if (runtime.time - message.createdAt > BUBBLE_MS) continue;
    const source = runtime.game.world.players.get(message.author)?.sourceId;
    if (source === undefined) continue;
    spoken.set(
      source,
      message.text.length > BUBBLE_CHARS ? `${message.text.slice(0, BUBBLE_CHARS)}…` : message.text,
    );
  }
  return spoken;
}

/**
 * Agents whose action decision is out at a model — Jev or the chat model, whichever
 * `ACTION_DECIDER` names — by `sourceId`.
 *
 * Read live off the engine: `agentDecide` is the operation, and it leaves `inProgressOperation`
 * the tick its answer re-enters the world as `agentDecideAction`, or when `ACTION_TIMEOUT` gives
 * up on it. Conversation turns are operations too, and are deliberately not counted.
 */
export function thinkingBodies(runtime: AgenticRuntime | undefined): Set<string> {
  const thinking = new Set<string>();
  if (!runtime) return thinking;
  for (const agent of runtime.game.world.agents.values()) {
    if (agent.inProgressOperation?.name !== 'agentDecide') continue;
    const source = runtime.game.world.players.get(agent.playerId)?.sourceId;
    if (source !== undefined) thinking.add(source);
  }
  return thinking;
}

/**
 * Roughly the top of a room NPC's head above its tile's top edge, in world pixels. The sheets
 * are 64px frames anchored 60px down at the foot, so the head sits about a tile above.
 */
const HEAD_LIFT = 30;

/** `x`, `y` are the body's tile, interpolated, in tiles. */
export function AgentOverhead({
  x,
  y,
  text,
  thinking,
}: {
  x: number;
  y: number;
  text?: string;
  thinking: boolean;
}) {
  const px = x * 32 + 16;
  const py = y * 32 - HEAD_LIFT;
  return (
    <>
      {thinking && (
        <Container x={px + 14} y={py} zIndex={10000} eventMode="none">
          <Text text="💭" scale={0.8} anchor={{ x: 0.5, y: 1 }} />
        </Container>
      )}
      {text && <SpeechBubble text={text} x={px} y={py} />}
    </>
  );
}

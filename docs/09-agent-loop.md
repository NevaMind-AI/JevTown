# The Agent Loop

`resolves docs/08 §7 D4` · `specifies A6`

`05` §6.4 replaces `agentDoSomething`'s internals with a model call and says nothing about the
state machine around it. This document specifies that machine: which of today's gates survive,
what the decision call sees, what it emits, and how an `approach` becomes an interaction with
any of the three targetable tiers.

---

## 1. The governing principle

**The engine filters the option set; the model chooses within it.**

The same principle as the anchor manifest (`07` §4.3). Do not instruct a model not to do
illegal things — do not let illegal things into the manifest. An agent that may not start a
conversation right now simply sees no people in its manifest.

This is worth stating because the alternative is tempting and worse: pass everything, describe
the rules in the prompt, and validate the answer. That costs prompt tokens on every call,
produces a validation branch for every rule, and fails open when the model ignores an
instruction — which under `05` §5.1's deliberately weak enforcement it is explicitly allowed
to do.

---

## 2. Today's gates, and which survive

`Agent.tick` (`convex/aiTown/agent.ts:52-130`) and `agentDoSomething`
(`convex/aiTown/agentOperations.ts:93-171`) together gate the decision on eight things. They
split cleanly into engine invariants and behavioural policy.

| Gate | Today | Verdict |
|---|---|---|
| `inProgressOperation` + `ACTION_TIMEOUT` | tick | **hard** — one operation at a time is an engine invariant |
| in a conversation | tick | **hard** — an agent mid-conversation must not be off deciding to wander |
| `toRemember` | tick | **hard**, and it moves — see §7 |
| `player.pathfinding` | tick + action | **hard** — arriving is engine business; the model decides again on arrival |
| `doingActivity` (`player.activity.until`) | tick | **soft** — the model sets the duration |
| `lastInviteAttempt` + `CONVERSATION_COOLDOWN` | action | **hard, by filtering** — recently-attempted targets leave the manifest |
| `lastConversation` + `CONVERSATION_COOLDOWN` | action | **hard, by filtering** — people leave the manifest entirely during the cooldown |
| `recentActivity` + `ACTIVITY_COOLDOWN` | action | **deleted** — it exists to stop the random picker looping between activity and wander; a model choosing with intent does not need it |
| `INVITE_ACCEPT_PROBABILITY` roll | tick | **kept for v1** — see §9 |

The pattern: **engine invariants stay as gates, behavioural policy becomes model output, and
cooldowns become manifest filters.** A cooldown expressed as a filter cannot be violated, needs
no prompt text, and needs no validation branch.

---

## 3. What the decision call sees

```
system
+ the state_contract (05 §5.1)
+ persona + states vocabulary
+ own current state document
+ retrieved memory
+ world_rules, verbatim
+ the manifest
```

The manifest, per `05` §6.4 as amended:

```
People nearby:
  - alice  (a person)        — close,   in the mill yard
Things you can interact with:
  - hearth_oracle (someone who does not move) — far, in the great hall
  - mill_door (a door)  "A heavy oak door, banded in iron."  — close, at the mill entrance
Places you can go:
  - mill_yard      — The packed-dirt yard on the mill's south face.
  - great_hall     — ...
```

Three rules about its contents:

**No state.** Identity, tier, a prop's immutable `description`, and location — never `state`,
`memory`, or `physics` (`05` §6.4). An agent learns state from interacting, not from looking.

**Distance as a band, not a number.** "Close" and "far", not `4.7 tiles`. Exact figures invite
arithmetic the model is bad at, and a band is what a person would actually perceive. The
pathfinder computes the route; the model never needs the number.

**Tiers are described, not labelled.** "A person", "someone who does not move", "a door" — not
`kind: actor, mobile: false`. The taxonomy is an engine concept; leaking it into the prompt
invites the model to reason about the schema instead of the world.

Everything the engine excluded — targets in a conversation, targets under cooldown, the agent
itself, entities with `interactable: false` — is simply absent.

---

## 4. What it emits

Extending `05` §6.4's three actions:

```json
{ "action": "approach", "target": "<entity id>", "intent": "<prose>", "reason": "..." }
{ "action": "wander",   "anchor": "<anchor id>", "reason": "..." }
{ "action": "idle",     "duration_ms": 60000, "description": "reading a book", "emoji": "📖", "reason": "..." }
```

`idle` gains `description` and `emoji` so it maps onto `player.activity`
(`convex/aiTown/player.ts:38-42`) directly. That deletes the `ACTIVITIES` table and its random
pick, and it means an idling agent is doing something its persona would plausibly do rather
than something from a fixed list of eight.

`intent` is the first turn of the interaction if the target is an actor, and the instruction if
it is a prop. It is what makes the approach mean something by the time the agent arrives.

`reason` is mandatory on all three, per `05` §9.2.

---

## 5. The loop

```
Agent.tick
  │
  ├─ inProgressOperation and not timed out ──────────────▶ wait
  ├─ toRemember ────────────────────────────────────────▶ agentRememberConversation   (§7)
  ├─ in a conversation ─────────────────────────────────▶ existing conversation logic
  ├─ pendingInteraction ────────────────────────────────▶ §6
  ├─ doing an activity, or walking ─────────────────────▶ wait
  ├─ decided within MIN_DECISION_INTERVAL ──────────────▶ wait                        (§10)
  └─ otherwise ─────────────────────────────────────────▶ agentDecide
                                                              │
                                        one model call, in an action
                                                              │
                                                    agentDecideAction input
```

`agentDecide` replaces `agentDoSomething`; `agentDecideAction` replaces `finishDoSomething`.
The decision runs in an action and re-enters through an input, so it is replay-safe by
construction and adds no nondeterminism source (`05` §6.4, §10).

The input handler:

| Action | Effect |
|---|---|
| `wander` | `movePlayer(game, now, player, freeTileIn(anchor))` |
| `idle` | `player.activity = { description, emoji, until: now + duration_ms }` |
| `approach` | validate the target is still legal; set `agent.pendingInteraction`; `movePlayer` to an approach tile |

---

## 6. Approach → interaction

New agent state:

```ts
pendingInteraction?: {
  targetId: string;
  intent: string;
  startedWalking: number;
}
```

On each subsequent tick, with `pendingInteraction` set:

1. **Target gone or no longer legal** — cleared, and the agent decides again next tick.
2. **`now > startedWalking + APPROACH_TIMEOUT`** — cleared, decide again. The target may have
   walked away, or the path may be blocked by something that is not moving.
3. **Within `INTERACTION_DISTANCE` of the target** — dispatch by tier:

| Target | Dispatch |
|---|---|
| (a) mobile actor | `Conversation.start(game, now, player, invitee)` — the existing invite path, unchanged. Set `lastInviteAttempt`. |
| (b) fixed actor | An alternating exchange, then each side writes its own state (`05` §6.1). |
| (c) prop | One model call emitting `05` §6.2's nested envelope, which writes both sides. |

**Two corrections from building it (A6).**

*Tier (a) needs no `pendingInteraction` at all.* The input handler calls `Conversation.start`
immediately, because `Conversation` already owns walking toward a target that is itself walking —
that is exactly what its `invited` / `walkingOver` statuses are for. Adding an approach state on
top would duplicate it and then have to stay in sync with it. `pendingInteraction` exists only for
fixed targets, which is the case `Conversation` cannot express.

*Tier (b)'s exchange runs inside one operation, not as a tick-driven lifecycle.* A fixed entity
cannot walk away and cannot be interrupted, so there is nothing for the engine to arbitrate
between turns: no `Interaction` structure in the world document, no participant statuses, no
invite states that would have to be no-ops for something that does not move. The engine sees one
operation start and finish. The cost is real and worth stating — the exchange is not
interruptible and lands all at once rather than turn by turn — but that is a fair trade for a
target that cannot leave, and it is not a trade tier (a) could make, which is why tier (a) keeps
`Conversation`.

Turns are stored in an `interactionTurns` table rather than in `messages`, for the reason `05`
§7.3 gives about the god: `messages` requires a `conversationId` and an `author` that is a player
id, and a fixed entity is neither.

`INTERACTION_DISTANCE` parallels the existing `CONVERSATION_DISTANCE = 1.3`
(`convex/constants.ts:13`).

**The approach tile.** For a mobile target the destination is the target's position, as today.
For a fixed target it is the nearest free tile adjacent to the anchor rect — a helper on
`WorldMap` built on A1's anchors, since an anchor is a rectangle and a 3×2 portcullis has ten
tiles you could stand at.

This is where `05` §3.1's two axes show up in code: steps 1–3 are identical for (b) and (c) —
that is the mobility axis — and only the dispatch row differs, which is the agency axis.

---

## 7. `toRemember` moves before the decision

Today the do-something branch comes **first** and returns; `toRemember` is checked after
(`convex/aiTown/agent.ts:78-93`). An agent that just left a conversation therefore decides its
next action *before* writing what it learned, and remembers only on some later tick when the
decision gate happens to be closed.

Under stock AI Town that is harmless — the engine never reads memory. Under this branch it is a
bug, because `05` §9.1 is explicit that prose state and memory feed back into engine-visible
behaviour through §6.4. Deciding before remembering means deciding on stale memory, and the
staleness is exactly the conversation most likely to be relevant.

**Move the `toRemember` check above the decision branch.** One-line reordering, and it is the
kind of thing that is invisible until an agent walks away from a conversation and immediately
tries to start the same one again.

---

## 8. Stale decisions must not throw

The decision is made in an action against a snapshot of the world, and the world moves during
the model call. By the time `agentDecideAction` lands, the chosen target may be in a
conversation, may have walked away, or may not exist.

`finishDoSomething` today **throws** when the invitee is missing
(`convex/aiTown/agentInputs.ts:60-63`). Stock AI Town gets away with it because
`findConversationCandidate` runs in a query milliseconds before the input; a model call takes
seconds, and this will fire regularly.

The handler must instead: log, leave the operation cleared, and let the next tick decide again.
A throw marks the input errored — and since the operation was already cleared by then, the
agent is fine, but the error rate becomes noise that hides real failures. Validate before
calling `Conversation.start`, which throws on its own if the invitee is already occupied.

---

## 9. The invite-accept roll stays, for now

When an agent is invited, `Agent.tick` accepts humans unconditionally and rolls
`INVITE_ACCEPT_PROBABILITY` for other agents (`convex/aiTown/agent.ts:114`, now seeded — A0).

Under the branch's thesis this should be a model decision: whether Alice talks to Bob right now
is a story judgement, and a 0.8 coin flip is exactly the kind of arbitrary rule `05` exists to
remove.

**Keep the roll in v1 anyway.** It doubles the decision calls in the busiest part of the loop —
every invite would cost a call on the receiving side, and invites are the most frequent decision
in a populated world. The roll is seeded and therefore replayable, so it costs nothing in
determinism. Revisit when A6's cost numbers exist, since this is the single largest lever on
them.

---

## 10. Cost, and the decision floor

The decision call replaces a branch that cost nothing. Rough shape: with the activity/wander
cycle at tens of seconds, an idle agent decides once or twice a minute, so N agents standing
around cost ~2N calls per minute before anyone talks to anyone.

`idle`'s `duration_ms` is the model's own throttle — it can buy itself time. But a model that
always picks a 5-second idle will burn the budget, and nothing in the prompt reliably stops it.

**Add `MIN_DECISION_INTERVAL` as a hard gate** (§2's table, last row of the loop). It is the one
policy the model must not own, because the failure mode is unbounded and self-reinforcing. Set
it well below the natural cadence — a few seconds — so it never binds in normal operation and
only catches the pathological case.

---

## 11. What gets deleted

- `findConversationCandidate` (`convex/aiTown/agent.ts:335-360`), and with it the upstream bug
  `05` §6.4 documents: it pushes the initiating player's own position onto every candidate, so
  its sort-by-distance is a no-op and it returns whichever player is first in `Map` order.
- `wanderDestination` (`convex/aiTown/agentOperations.ts:179-184`) — a uniform random tile,
  replaced by an anchor choice.
- The `ACTIVITIES` table and its random pick (`convex/constants.ts:67`).
- `ACTIVITY_COOLDOWN`.

Both remaining `Math.random()` calls in `agentOperations.ts` that are not jitter disappear with
them, which closes out the last two rows of `05` §10's table.

---

## 12. Open questions

**E1. Interruption.** An agent walking toward a target re-decides only on arrival or timeout.
It cannot notice something more interesting halfway. Adding that means a decision call per tick
window while walking, which §10 says is the expensive direction. Probably correct to leave, but
it should be a decision.

**E2. Two-participant conversations.** `Conversation` is a two-participant structure
(`convex/aiTown/conversation.ts:29`) and nothing here changes that. A group scene is not
expressible.

**E3. What a fixed actor does when nobody is there.** A tier (b) actor runs inference but never
initiates (`05` §3.3). It therefore has no loop at all — it is purely reactive. If a world wants
a statue that hails passers-by, that needs the entity-to-entity proximity signal `05` §3.3 and
`07` §11 both defer.

**E4. Human targets.** A human appears in the manifest like any other person and the model may
approach them; humans already accept unconditionally. Unchanged from today, but untested under
model-chosen targeting, where an agent may fixate on the only human in the world.

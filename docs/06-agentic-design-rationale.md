# Agentic Branch — Design Rationale and Discussion

Companion to `05-agentic-world-format.md`, in the same relation that
`02-design-rationale.md` holds to `01`/`04`: the spec says *what*, this says *why*, and
flags what we have not decided.

This document is written for people, not for a loader. It is the one to read first if you
are joining, or if you are the author of `04` and want to know what changed under you and
what did not.

---

## 1. The document map

| Doc | What it is | Branch | Status |
|---|---|---|---|
| `01-world-format-spec.md` | Original typed world format, `1.0` | typed | superseded by `04`, retained as reference |
| `02-design-rationale.md` | Why the typed design looks the way it does | typed, but §9 is **shared** | live, with corrections in §5 below |
| `03-implementation-plan.md` | 11 units, dependency-ordered | typed; U0/U1 are **shared** | live |
| `04-world-format-spec-v2.md` | Typed world format, `2.0`, trimmed for the first demo | typed | live |
| `05-agentic-world-format.md` | All-natural-language world format, `a1.0` | agentic | live |
| `06` (this) | Why the agentic branch exists and how the two relate | both | live |
| `07-map-entity-split.md` | The map/world-file boundary, anchors, collision | **both** | live; amends `04` §6.4 and `05` §3 |
| `08-agentic-implementation-plan.md` | 10 units, dependency-ordered, plus the decision log | agentic | live; §7 amends `05` §2, §5.1, §7, §13 |
| `09-agent-loop.md` | The agent decision loop: gates, manifest, approach → interaction | agentic | live; specifies A6 |

`02` §9 — "Why AI Town, and what that gives us for replay" — is the **only** section of the
typed rationale that both branches depend on equally. It is also the section with factual
errors, corrected in §5.

---

## 2. Why there are two branches

They answer different questions.

**The typed branch (`04`) asks:** *can we build a research platform whose worlds are
machine-generatable, statically validatable, and exactly replayable?* Its bet is that
closure — closed operator sets, closed effect vocabularies, a declared fact namespace — is
what makes a writer agent reliable and a world file analysable. Everything in `02` §1–§4
follows from that bet.

**The agentic branch (`05`) asks:** *what happens if the story layer has no schema at all?*
Its bet is that the closure buys less than it costs, that a model with good prose state and
good memory produces more interesting worlds than a model filling in a JSON schema, and that
the replay guarantee survives anyway.

Both bets can be right. They are not competing implementations of one design; they are two
experiments, and the platform is the thing that lets us run them.

**Neither is chosen.** §7 sets out what would decide it.

---

## 3. What the two branches share

More than the documents suggest — roughly the whole engineering substrate. This matters for
planning: two people are not building two systems.

| Shared | Where |
|---|---|
| Entity model: one array, `kind` discriminator, `anchor`/`spawn`, inert tier derived | `04` §6, `05` §3–§4 |
| Map interface: named anchors, never raw coordinates; `origin` provenance | `04` §6.4, `05` §4.2 |
| Determinism prerequisites: seeded PRNG, fixed iteration order, snapshots | `03` U0/U1, `05` §10 |
| The input log as the single authoritative record of every mutation | `02` §9, `04` §4, `05` §9 |
| Retention policy: nothing is vacuumed | `05` §9.6, `convex/crons.ts` |
| Prop interaction path (agent acts on a non-agent entity) | `04` §8.3 `inspect`, `05` §6.2 |
| Non-mobile agent as a `Player`+`Agent` pair | `05` §3.1 |
| Human player model — already implemented upstream | `05` §6.3 |

The divergence is `world.json` and the prompt layer. Everything below that line is common
work and should be built once.

---

## 4. The three decisions that took the most argument

### 4.1 `kind` splits on agency; mobility is a flag

The candidate designs were `kind + interaction` — giving `(actor, active)`, `(prop, active)`,
`(prop, passive)`, `(prop, none)` — and `kind + mobile`.

`kind + interaction` was rejected for one decisive reason and two supporting ones. The
decisive one is that `Conversation` (`convex/aiTown/conversation.ts:29,53`) is a
two-participant structure keyed by `GameId<'players'>`. A fixed agent that holds a real
two-sided dialogue must occupy a participant slot. As `(prop, active)` it cannot without
rewriting the conversation model; as `actor` with `mobile: false` it drops into the existing
machinery with no changes at all. **The engine had already drawn the line where we wanted
it.**

The supporting reasons: `(prop, active)` contradicts `04` §6.1's own definition of `prop`
("no pathfinding, no agent loop"), so choosing it would have required rewriting that section
anyway; and the schema delta across the agency axis is six blocks (`persona`, prose state,
memory, prompt config, turn budget, classifier) against two fields across the mobility axis,
so agency is where a `oneOf` should carve.

`04` §6.1's stated rationale — that the engine's real question is "does this need a
pathfinder and an agent tick" — is right in form and wrong in its assumption that those two
travel together. A fixed agent needs the tick and not the pathfinder. **If the typed branch
ever wants a talking statue, it should take this change too**; it is compatible with
everything else in `04`.

What was *not* changed: `04` §6.1's argument against an `interactable` field. Interactivity
stays derived from the presence of content. `05`'s runtime `physics.interactable` is a
different thing — a mutable runtime value, derived at load, never authored.

### 4.2 Prose is the model's state; a two-field projection is the engine's

The first version of this branch proposed replacing `entity.<id>.state` with prose outright.
That does not work, and the reason is not philosophical.

The tick loop runs at 16 ms and calls `blocked()` on every pathfinding expansion
(`convex/aiTown/movement.ts:172`). It is synchronous and cannot call a model. So a locked
door that becomes unlocked has to be typed, no matter how the story layer represents it.
Everything the tick loop touches — collision, whether an entity may be targeted at all — is
a hard typed floor.

The floor turns out to be **two booleans**. That is small enough that "everything in natural
language" remains an honest description of the story layer: the typed bits are physics, not
story, and they were never the thing anyone wanted in prose.

The rule that keeps them consistent is that **the same model call emits both**. Never a
prose call and a separate physics call — that is how a door ends up described as splintered
open while still blocking the pathfinder.

This also produced the storage architecture of `05` §8, which is the most useful structural
consequence in either document. The world document is `replace()`d in full every step. Prose
must therefore never live in it — and because of the typed floor, it never has to. Prose
lives in its own tables; the world document carries a version integer. That falls out of the
constraint rather than being designed around it.

### 4.3 The god agent gets authority, and pays for it in traceability

A god that can rewrite any entity's state is the most powerful construct in either branch,
and it is the single largest threat to the thing `02` §8 calls the instrument of this
platform: being able to answer "why did that happen."

The typed branch answers that with the condition trace — every evaluation records which
leaves were true. The agentic branch has no conditions and therefore no trace. Its
replacement is the mandatory `reason` string on every write plus the audit table
(`05` §9.3). That is a weaker instrument — it is only as honest as the model writing it —
and it is why `reason` is required rather than optional, and why the god's writes carry a
`batchId` linking them to the exact evidence that produced them.

Three constraints came out of this discussion and all three are in the spec: god writes
apply last in a step (§7.6); the batch is recorded as formed rather than re-derived (§7.4);
and the transcript lives in its own table because it is a rebuildable cache, not replay
state (§7.3).

The two-stage gate (§7.5) is a cost decision, not a correctness one, but it belongs in v1:
the god's answer is "do nothing" in the overwhelming majority of cases, it is serial by
construction, and retrofitting a gate means re-tuning a prompt already tuned against full
context.

---

## 5. Corrections to `02-design-rationale.md`

These are factual, verified against the code, and affect both branches.

### 5.1 §9 — "What an agent said is in the input log" is false

`02` §9 reads:

> **LLM nondeterminism is already captured.** LLM calls happen in Convex actions outside the
> engine and re-enter only through inputs. What an agent said is in the input log; we replay
> it without calling any model.

The first two sentences are correct. The third is not.

- `insertMemory` (`convex/agent/memory.ts:273`) is an `internalMutation` called directly from
  the `agentRememberConversation` action, writing straight to `memories` and
  `memoryEmbeddings`. The only input is `finishRememberConversation`, whose args are
  `{agentId, operationId}` — no content.
- `agentSendMessage` (`convex/aiTown/agent.ts`) inserts into `messages`, then sends
  `agentFinishSendingMessage` with args
  `{agentId, conversationId, timestamp, operationId, leaveConversation}` — no text, not even
  the `messageUuid`.

What is actually true: **engine state is replayable from the input log; content is not in
it.** Message text and memory content live in side tables. Stock AI Town gets away with this
because its state machine never reads message text, only timestamps and counts.

The typed branch mostly gets away with it too, since typed state changes *are* inputs. The
agentic branch does not, because prose state feeds back into behaviour — hence `05` §9.2,
which routes every content mutation through an input. `args: v.any()`
(`convex/engine/schema.ts:17`) means no migration is needed to do it.

### 5.2 The nondeterminism table is missing step-boundary placement

`02` §9's table lists five sources, all inside the tick path. It omits one in the step path:
`runStep(ctx, now)` takes wall-clock `now` (`convex/aiTown/main.ts:103`), and `now`
determines how many ticks fall in each step. Two things key off boundaries rather than
ticks — `beginStep()`, which resets the historical-location buffers
(`convex/aiTown/game.ts:165-175`), and, in the typed branch, the 1 Hz condition evaluation
that `02` §7 mandates. Feed a different `now` on replay and the boundaries move, so
conditions evaluate at different simulated times even with a seeded PRNG.

Fix, cheap now and awkward later: have the snapshots `02` §9 already calls for record each
step's `(lastStepTs, currentTime)` pair, and drive replay from those.

### 5.3 The shipped configuration destroys replay data

`convex/crons.ts` shipped with `inputs`, `memories` and `memoryEmbeddings` in
`TablesToVacuum`, running daily against a two-week `VACUUM_MAX_AGE`. The file's own comment
said it: *"Inputs aren't useful unless you're trying to replay history."*

`TablesToVacuum` is now empty, with a comment explaining why. This applies to both branches
and should have been the first change made after `02` was written.

### 5.4 There is an OCC hotspot on the input path

`engineInsertInput` (`convex/engine/abstractGame.ts:129-145`) allocates each input number
with `.order('desc').first()` on a single index — a serialization point. The codebase already
hits it (`convex/aiTown/agentOperations.ts:147-149`: *"We hit a lot of OCC errors on sending
inputs in this file"*, mitigated with random jitter). Both branches increase input volume
several-fold, the agentic branch more so. This should be load-tested before content work,
not discovered in a demo.

### 5.5 An upstream bug worth knowing about

`findConversationCandidate` (`convex/aiTown/agent.ts:337-362`) pushes the *initiating*
player's own position onto every candidate, so its documented "sort by distance and take the
nearest" is a no-op and it returns whichever player comes first in `Map` insertion order.

Two consequences. Agents do not, today, approach the nearest person — they approach an
arbitrary one. And the `Map`-order dependence is exactly the invisible replay divergence
`02` §7 warns about, live in the code. The agentic branch replaces this function entirely
(`05` §6.4); the typed branch should fix it.

### 5.6 What `02` got right and is worth restating

The framing that survived every part of this review: *simulation time is a pure simulated
timeline; wall clock only decides when a step stops.* It is more true than the document
claims. There is no tick-number-to-wall-clock conversion anywhere in the system, because
`currentTime` **is** epoch milliseconds, advanced in 16 ms increments and clamped so it can
never run past `Date.now()` (`convex/engine/abstractGame.ts:29-31, 70-73`). The client's
smooth rendering is a separate rate-adjusted playback clock running deliberately 0.25–1.25 s
behind (`src/hooks/useHistoricalTime.ts`), not a second source of truth.

Also right, and load-bearing for the agentic branch specifically: inputs bind to ticks by
comparing against persisted `received` timestamps, so an asynchronous model verdict landing
at an unpredictable wall-clock moment still replays exactly. The god agent's hardest-looking
problem was solved by AI Town before we arrived.

---

## 6. The claim that removing structure makes replay *easier*

This is counterintuitive enough to state on its own.

`02` §7 argues determinism is a design constraint, and builds an apparatus for it:
step-boundary evaluation at 1 Hz, fixed iteration order, entities and rules sorted by id, no
reliance on incidental `Map` ordering. That apparatus exists to make **the condition
evaluator** deterministic.

The agentic branch has no condition evaluator. Deleting it deletes that entire class of
divergence. What remains is the five inherited RNG sites, step-boundary placement (§5.2),
and one discipline: every model-originated mutation is an input. All model nondeterminism is
concentrated in Convex actions, which is exactly where AI Town already puts it and already
replays it.

So the agentic branch's determinism surface is **strictly smaller** than the typed branch's.
Whatever else is uncertain about it, this is not the risk.

---

## 7. How we expect to decide between the branches

Not by argument. Three measurements, in order of how early they can be taken.

**M1 — Does prose state stay stable?** (`05` A1.) Run one actor through ~100 synthetic
interactions; diff its state document at each step. If it drifts into an unstructured essay
despite an immutable `persona` and an enforced character budget, the agentic branch fails at
its foundation and nothing downstream is worth building. This is cheap and should be run in
the first week.

**M2 — Does the typed branch's classifier hold?** (`02` Q3, `03` U7.) The outcome classifier
is the typed branch's equivalent single point of failure: a misclassification silently sends
the story down the wrong branch. `03` already front-loads it for the same reason. Measure it
on real transcripts.

**M3 — What does a world cost per hour, per branch?** (`02` Q8, `05` A3.) Neither branch has
a number. The agentic branch's is higher and its god is serial. If the answer rules out
twenty actors, that constrains both designs and possibly the research programme.

A plausible outcome is that neither wins outright: the typed spine survives for progression
that must be reliable, and prose state and memory replace `vars` for everything an author
would otherwise have to enumerate. `05` §11's table is the list of what would have to be
reconciled to build that hybrid, and the shared substrate of §3 is what makes it possible to
decide late.

---

## 8. Open questions specific to this branch

Detailed in `05` §13. Summarised here for readers who will not open the spec:

- **A1.** Does prose state stay stable over a long run? *The central bet. Measure first.*
- **A2.** Is one god enough authority, or does the world need ordered phases?
- **A3.** What does the god cost at scale, given it is serial?
- **A4.** Two agents' prose states can contradict each other and nothing detects it. Is that
  acceptable, or a bug?
- **A5.** Does anyone maintain prose state *about the human player*, and is it per-agent or
  shared?
- **A6.** `inputs` now grows without bound. When does that need snapshot-plus-truncate?
- **A7.** Do `mobile` and `initiates` need to split?

And two that belong to both branches:

- **`02` Q1 (scope).** Per-player vs world state. The agentic branch inherits this as A5 and
  has not answered it either.
- **`02` Q6 (versioning).** A recorded experiment references a world file. With two
  incompatible formats in play, pinning the loader version per recorded run stops being
  optional.

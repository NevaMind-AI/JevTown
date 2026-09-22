# Design Rationale and Open Questions

Companion to `01-world-format-spec.md`. This document explains *why* the format looks the
way it does, and flags what we have not yet decided. Read this before critiquing the spec —
several fields that look over-engineered exist to prevent a specific, known failure.

## Context

We are building a **research playground** that happens to be a game. The game is the
platform, not the goal. That pushes three requirements that a normal game would not have:

- **Reproducibility.** We must be able to replay a run to exactly the same state.
- **Total decoupling.** Swapping the world must require zero code changes, so experiments
  vary the world file and nothing else.
- **Agent-generatable worlds.** A writer agent must be able to author a valid world by
  filling in a schema.

We are building on **AI Town** (`a16z-infra/ai-town`). The reasoning for that choice, and
what it means for replay, is in §9.

---

## 1. Conditions read a declared fact namespace, not engine state

**Decision.** Conditions never touch engine internals. They read a flat namespace
(`vars.*`, `npc.<id>.state`, `episode.elapsed_ms`, …) populated by a versioned adapter.

**Why.** The obvious design — dotted paths into live world state — silently couples every
world file to our internal TypeScript shapes. Two consequences we want to avoid:

- The writer agent's prompt becomes a dump of our engine schema, which is large, unstable,
  and full of things it must not touch.
- Any engine refactor invalidates every world file ever written, including recorded
  experiment configurations.

The namespace is the *entire* coupling surface between world files and the engine. It is
small, documented, and versioned independently of the engine.

**Bonus.** Time conditions need no special syntax. `episode.elapsed_ms` is just another
readable fact, so `at_least`-style timeouts fall out of the general grammar for free.

## 2. One leaf form, closed operator set, no arithmetic

**Decision.** The only leaf is `{"var": path, "op": op, "value": literal}`, with seven
operators and no computation.

**Why.** Two reasons, both about machines rather than humans:

- **Named keys beat positional tuples for generation.** `[">", "x", 5]` is compact, but
  LLMs make position errors on tuples, and there is no room to add optional fields later
  without a breaking change.
- **The moment conditions can compute, they stop being statically analyzable.** We want to
  answer "which variables does this condition read?" mechanically, for validation, for
  dirty-flag optimization later, and for the condition inspector (§8). Arithmetic in
  conditions kills all three. Arithmetic belongs in effects (`inc_var`), where it is
  explicit and ordered.

We considered adopting **JsonLogic**, which solves the surface problem and already exists.
We rejected it: it is deliberately permissive, its operator set is much larger than we
want, and permissiveness is exactly what makes constrained generation and validation hard.
Worth reading **Ink** and **Yarn Spinner** for narrative semantics prior art, but both are
text DSLs, which are harder to generate under constraint and harder to statically analyze
than a closed JSON schema.

## 3. Conditions read state; effects project history into flags

**Decision.** Conditions may only read *current* state. Anything historical is reified as
a variable by an effect at the moment it happens.

"This conversation may only trigger if that conversation has happened" becomes: the first
conversation's transition sets `vars.conv_intro_done = true`; the second conversation's
condition reads that flag.

**Why.** The alternative — letting conditions query an event history — makes evaluation
cost unbounded (every evaluation is a scan), and makes replay fragile, because the answer
depends on how much history happens to be retained. The flag approach is O(1), and the
flag is part of world state, so it is captured by snapshots and replay automatically.

This is the standard RPG quest-variable pattern. It costs one line of authoring per
historical fact and removes a whole category of problems.

## 4. Effects are a closed vocabulary

**Decision.** ~9 enumerated effect operations. No script strings, no arbitrary state
patches.

**Why.** In the first sketch of this design, effects were an afterthought described as
"other changes to be made in the world." They carry as much weight as conditions and need
the same discipline. A closed vocabulary is what makes effects:

- **validatable** — we can check every write against the declared variable type;
- **generatable** — the writer agent can be constrained to the enum via JSON Schema;
- **replay-safe** — every effect is applied as an engine input, so the existing input log
  captures the entire story layer with no additional logging.

That last point is the one that would be expensive to retrofit. An escape hatch that let
world files run arbitrary logic would break replay for every world that used it.

`emit_event` is included deliberately: it has no gameplay effect and exists so authors can
instrument a world for analysis without inventing a side channel.

## 5. The outcome contract — the part that actually matters

**Decision.** Every NPC state declares a closed set of `outcomes`. Every conversation, in
any mode, terminates by emitting exactly one of them. Agentic conversations get a second,
cheap, constrained LLM call that classifies the transcript into one of the declared
outcomes.

**Why.** This is the single most important idea in the design, and it is not obvious.

A scripted NPC produces structured branch outcomes, so conditions can read them. An
agentic NPC produces free text. **Our condition system cannot read free text.** Without a
bridge, agentic NPCs talk beautifully and are narratively inert — they can never advance
the plot, which defeats the point of having a story layer at all.

The classifier call is the whole bridge. It is small (one constrained call per
conversation, `enum` over a handful of declared values), and nothing in the story system
works without it. It should be built early, not late.

Two consequences:

- `__abandoned` must be a reserved implicit outcome. Players walk away mid-conversation,
  disconnect, and hit turn limits, and every one of those must still produce an outcome or
  the NPC deadlocks in its current state.
- Validation warns when a declared outcome has no matching transition, because that is a
  conversation the player can complete that changes nothing.

**Guided mode** (authored beats, generated prose) is in the spec because we expect to want
it. Pure-scripted wastes the model; pure-agentic is too loose to carry an authored story.
Most shipped LLM-narrative systems converge on the middle.

## 6. FSM as the spine, rules inside states, episodes as a second layer

**Decision.** Three-part structure: coarse states per NPC, a priority-ordered rule list
within each state, and an episode layer that can override NPC states.

**Why flat FSM alone fails.** A pure FSM forces a new state for every behavioral
variation, and the graph explodes combinatorially. Worse for our purposes, a writer agent
generating content into an FSM must produce a *valid connected graph* — it must reason
about reachability and dead ends. Generating an append-only rule list is far more reliable.

**Why not full HSM.** We will immediately want "the mill is burning, so everyone reacts
regardless of their individual state." That is the only hierarchy we could concretely
justify, and `npc_overrides` on episodes gives us exactly two levels for a fraction of the
complexity of a real hierarchical state machine. If we later find we need three levels, we
will have real evidence rather than speculation.

The result: states are story beats, rules are behavior, episodes are global authority.

## 7. Determinism is a design constraint, not an implementation detail

**Decision.** Conditions are evaluated at **step boundaries (1 Hz)**, never per tick, in a
fixed iteration order (NPCs and rules sorted by id). Effect order within a step is
declaration order, with last-write-wins on conflicts.

**Why.** AI Town's engine runs 60 ticks/s batched into 1 step/s, with a `beginStep` hook
already available. With dozens of NPCs and a handful of rules each, per-step evaluation is
trivially cheap and the ordering is obvious to reason about. Per-tick evaluation buys
nothing and makes ordering bugs 60× more likely to be timing-dependent.

The iteration order requirement is free if we decide it now and painful to retrofit: any
reliance on incidental `Map` ordering becomes an invisible replay divergence. We should
also add an event-driven dirty-flag path **only** if profiling demands it — the condition
grammar was kept analyzable (§2) so that this optimization stays available.

## 8. What will actually hurt: debuggability

**Decision.** Build a **condition trace** from day one. Every evaluation records which
leaves were true and false.

**Why.** The technical risk in this design is low. The *ergonomic* risk is high. Condition
systems rot the moment nobody can answer "why didn't that fire?" — and with LLM-driven
NPCs in the loop, the space of "why" is much larger than in a normal game.

This composes with the replay system into something genuinely valuable: scrub to any
moment of a recorded run and see exactly why the episode did not shift. For a research
platform that is not a debugging luxury, it is an instrument. It is cheap if designed in
now and expensive to bolt on later.

## 9. Why AI Town, and what that gives us for replay

We evaluated building on AI Town versus starting from Phaser/Colyseus or a heavier engine.
The deciding question was: *which is harder to rebuild — a tilemap renderer, or a
deterministic replayable simulation architecture?*

AI Town has a weak version of the former and a strong version of the latter. From reading
`convex/engine/abstractGame.ts`:

- Simulation time is `lastStepTs + tickDuration` — a **pure simulated timeline**. Wall
  clock only decides when a step stops, never what a tick computes.
- Inputs bind to ticks by comparing against persisted `received` timestamps, so the
  input→tick assignment is a pure function of recorded data and replays identically.
- The `inputs` table is already an append-only, monotonically numbered log with arguments
  *and* return values.
- `runStep(ctx, now)` takes `now` as a parameter, so an alternate driver can feed synthetic
  time and fast-forward headless without touching the engine.
- **LLM nondeterminism is already captured.** LLM calls happen in Convex actions outside
  the engine and re-enter only through inputs. What an agent said is in the input log; we
  replay it without calling any model.

The remaining gap to exact replay is small and fully enumerated — every nondeterminism
source inside the tick path:

| Location | Source |
|---|---|
| `convex/aiTown/agent.ts:114` | `Math.random()` invite-accept roll |
| `convex/aiTown/player.ts:154` | pathfinding backoff jitter |
| `convex/aiTown/player.ts:193-194` | random spawn position |
| `convex/aiTown/player.ts:211` | random initial facing |
| `convex/aiTown/agent.ts:174,195,222` | `crypto.randomUUID()` ×3 |

Route these through a seeded PRNG whose state lives in the world document and replay
works. Separately, the engine currently `replace()`s the world document each step, so
there is no state history; we add periodic snapshots to an append-only table for scrubbing
without replaying from tick 0.

**This is why the story layer must apply its effects as engine inputs (§4).** Do that, and
the entire story system is replayable for free. Any story state kept outside that boundary
is state we have to log separately and keep consistent by hand.

Known costs we accepted: the tile renderer instantiates one sprite per tile with no
culling and will need replacing (contained change, `@pixi/tilemap`); input latency is
~1.5 s by design; and heavy parallel headless experimentation is a poor fit for
JS + Convex — though the real ceiling there is LLM latency, which no engine choice fixes.

---

## Open questions

Ordered roughly by how much they would cost to get wrong.

**Q1. Is story state per-player or global?**
AI Town supports up to 8 humans in a world. If two players share a world, is
`trust_alice` per-player, and is episode progression global? The spec proposes an explicit
`scope` field per variable (`world` | `player`) with no default, but we have not decided
whether **episodes** can be per-player. Global episodes are far simpler and probably right
for research runs; per-player episodes are what a normal game would want. *We should
decide this before writing the evaluator, because it changes the shape of runtime state.*

**Q2. What happens when a player goes off-script in scripted mode?**
Scripted conversations assume the player picks from offered choices. If we allow free text
input to a scripted NPC, do we ignore it, map it to the nearest choice with a classifier,
or forbid free text in scripted mode entirely? Forbidding is simplest and probably right
for v1, but it makes scripted NPCs feel obviously different from agentic ones.

**Q3. How reliable is the outcome classifier, and what happens when it is wrong?**
A misclassification silently sends the story down the wrong branch. Options: log
confidence and flag low-confidence classifications for review; require the model to be
able to answer `__unclear` and treat that as `__abandoned`; or have the agentic
conversation itself declare its outcome as it ends rather than classifying after the fact.
We should measure this on real transcripts before committing.

**Q4. How much story state should be visible to agentic NPCs?**
An NPC whose prompt includes the full variable table will leak plot. An NPC with no story
context will contradict it. We need an explicit per-state declaration of which facts enter
the prompt — this is not yet in the spec and probably should be.

**Q5. Does the episode layer's authority go far enough — or too far?**
`npc_overrides` currently supports `force_state` and `disable_states`. Do episodes also
need to override conversation prompts, inject rules, or change personas? Each addition
makes episodes more powerful and NPC definitions less self-contained.

**Q6. World file versioning and migration.**
Recorded experiments reference a world file. When the format changes, do we migrate old
files, pin the loader version per recorded run, or freeze world files as immutable
artifacts alongside their replay logs? The last is most defensible for research but needs
storage design.

**Q7. Authoring tooling for humans.**
The format is designed for agent generation. Humans on the team will still need to read
and patch worlds. Do we need a visual editor, or is a good validator with clear error
messages plus the condition inspector sufficient? We suspect the latter for a while.

**Q8. Cost model.**
One classifier call per conversation, plus real-time generation, across N agents and M
concurrent runs. We have not estimated this. It should be sized before we commit to
agentic mode as the default rather than guided mode.

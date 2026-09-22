# Agentic Branch — Implementation Plan

Companion to `05-agentic-world-format.md`, `06-agentic-design-rationale.md` and
`07-map-entity-split.md`, in the same relation `03-implementation-plan.md` holds to `01`/`04`.
`09-agent-loop.md` spins out of §7 D4 and specifies A6.

`03` decomposes the **typed** branch into 11 units. Most of them have no counterpart here —
`05` §11 removes the constructs they implement. This document is the agentic equivalent:
10 units, dependency-ordered, with the blocking decisions called out separately because
several of them are not yet answerable from the specs.

**Three sequencing principles**, the first two inherited from `03`:

1. **Determinism first.** Replay must exist before prose state, not after.
2. **Prove the risky bet early.** `03` front-loads the outcome classifier because its
   feasibility was unvalidated. Here the unvalidated bet is prose-state stability
   (`05` §13 A1), and it is cheaper to test — it needs no engine at all.
3. **Branch-neutral substrate first.** `06` §7 has not chosen between the branches. Work
   that is correct under both (`07`, determinism, replay) can land now and is not wasted by
   either outcome. Work that is correct only under `a1.0` should wait behind A2.

---

## 1. What survives from `03`

| `03` unit | Here | Why |
|---|---|---|
| U0 Determinism prerequisites | **A0**, unchanged | Shared substrate (`06` §3) |
| U1 Snapshot + replay driver | **A9**, unchanged in shape | Shared substrate |
| U2 Fact namespace + adapter | gone | No typed facts (`05` §11) |
| U3 Condition evaluator | gone | No conditions |
| U4 Effect applier | gone | Four input handlers instead (`05` §9.2), folded into A3 |
| U5 World file loader + validator | **A4**, much smaller | ~20 of 24 validation rules have nothing to check (`05` §11) |
| U6 NPC state machine runtime | gone | Behaviour is prompt-elicited |
| U7 Outcome contract + classifier | gone | Folded into the state-update call (`05` §6.1) |
| U8 Scripted conversation player | gone | No authored dialogue (`05` §11) |
| U9 Episode layer | **A7**, as the god | Model rather than table (`05` §7) |
| U10 Condition trace + inspector | **A3**, as the audit table | `reason` strings rather than traces (`05` §9.3) |
| U11 Agent generation + repair loop | **A2/A5**, as prompts + evals | No schema to repair against (`05` §12) |

The net: the typed branch's weight is in *pure functions* (U3, U4, U5 are all marked pure in
`03`). This branch has almost none. Its weight is in prompts, storage, and the engine seams
they touch — which is harder to unit-test and is why A2 and the eval harness are not
optional extras.

---

## 2. Unit inventory

| # | Unit | Depends on | Pure? | Size | Blocked by |
|---|---|---|---|---|---|
| A0 | Determinism prerequisites | — | no | S | — |
| A1 | Map substrate: collision, anchors | — | mostly | S | — |
| A2 | Prose-drift spike (offline) | — | n/a | S | — |
| A3 | Prose storage (parser, contract, tables) | A0 | mostly | M | — |
| A4 | Entity model, loader, three input handlers | A1, A3 | mostly | M | — |
| A5 | Prompt layer | A3 | no | M | — |
| A6 | The agent loop (decide, approach, interact) | A4, A5 | no | M | — (`09`) |
| A7 | God agent | A5, A6 | no | M | — |
| A8 | Client: entities and prose state | A4 | no | M | — |
| A9 | Snapshot + replay driver | A0, A3 | no | M | — |
| A10 | Common knowledge (docs/05 §5.3) | A5, A7 | mostly | S | — |

`S` ≈ a few days, `M` ≈ one to two weeks, for one engineer — same scale as `03`.

---

## 3. Phase 0 — unblocked, start here

Nothing in this phase depends on an undecided question, and A0/A1 are correct under both
branches.

### A0. Determinism prerequisites — **implemented**
Identical in scope to `03` U0; `05` §10 enumerates the sources. Landed:

- **`convex/util/rng.ts`** — a seeded PRNG (sfc32 through splitmix32) whose whole state is four
  uint32s, so it round-trips through Convex's float64 numbers exactly. `seed` and `rng` live on
  the world document (`serializedWorld`), both optional so existing worlds load; `init` records
  the seed at world creation. A4 replaces that with `meta.seed` (`05` §2). Unit-tested for
  stream reproducibility, serialization round-trip, range, uniformity, and UUID shape.
- Every engine-side draw now goes through `game.rng`: the invite-accept roll
  (`agent.ts:114`), pathfinding backoff (`player.ts:154`), spawn position and facing
  (`player.ts:193-194,211`), and the three `crypto.randomUUID()` message ids
  (`agent.ts:174,195,222`).
- **Iteration order is canonical.** `World` gained `sortedPlayers` / `sortedAgents` /
  `sortedConversations`, ordered by allocation number rather than lexicographically
  (`ids.ts:compareGameIds`, since `p:10` must sort after `p:9`). Used in `Game.tick`,
  `beginStep`, `playerConversation`, and the `otherFreePlayers` manifest — and in
  `World.serialize()`, so the stored document is canonical too.
- **Step boundaries are recorded.** New `steps` table, one row per committed step, written in
  `applyEngineUpdate` alongside the engine replace.

Two corrections to `05` §10 worth carrying forward:

**The exposure is worse than "inherited `Math.random()`" suggests.** `tick()` runs inside a
Convex *action* (`abstractGame.runStep` takes an `ActionCtx`). Convex makes `Math.random()`
deterministic in queries and mutations, and only across retries of one execution — neither
property applies here. Every draw the simulation made was genuinely unseeded.

**`Map` iteration order was not actually a divergence source, and should still be sorted.**
`parseMap` preserves the order of the serialized array and `serialize()` writes it back, so
insertion order already replayed identically from the same input log. The reason to sort is
A9: a snapshot restore reconstructs state *without* replaying the history that produced the
ordering. Sorting makes order a function of state rather than of history, which is the
property snapshots need and replay-from-log does not.

Deliberately **not** changed: the `Math.random()` calls in `agentOperations.ts`. The activity
and wander-destination choices travel to the engine as input args, so the log records them and
replay reproduces them without redrawing — and `05` §6.4 replaces both in A6. The
`sleep(Math.random() * 1000)` calls are jitter against the OCC hotspot (`05` §9.7) and affect
only arrival time, which the persisted `received` timestamp already pins. Call sites are
commented so they don't get "fixed" later.

**Known limit:** nothing verifies replay yet — that is A9. And a world created before this
unit has no recorded seed, so its history is not reproducible; it gets a legacy seed and is
deterministic only from its next load onward.

`TablesToVacuum` is empty (`05` §9.6), already on `main`.

Do not defer the rest of this. Every unit after A3 writes replayable state.

### A1. Map substrate — **implemented**
`07` §9 steps 1–3. Landed:

- `data/convertMap.js` emits `collision` (boolean, `[x][y]`) from a designated Tiled tile
  layer, and `anchors` from a Tiled object layer, with `description` read from a custom
  property. Tile layers are now filtered by `layer.type`, so object layers no longer crash
  the converter.
- `convex/aiTown/worldMap.ts` carries optional `collision` and `anchors` through
  `serializedWorldMap`, and `WorldMap` **derives `collision` from `objectTiles` when absent**
  — `data/gentle.js` keeps working unmigrated (`07` §5.1).
- `convex/aiTown/movement.ts` reads the collision bitmap instead of scanning `objectTiles`,
  and consults a dynamic overlay.
- `CollisionOverlay` (`07` §5.3) exists on `Game`, is O(1), is rebuilt on load and never
  persisted. **It is empty until A4** — nothing writes entity physics yet. That is the seam
  A4 drops into.
- `convex/init.ts` passes both new fields into the `maps` row.

Deliberately **not** in A1: the load-time subtraction of static collision under mutable
anchors (`07` §5.2) and anchor-scoped spawn. Both need entities; both are A4.

### A2. Prose-drift spike — **deferred, replaced by instrumentation (D6)**
`05` §13 A1 is still the central bet, and it is still untested. What changed is that answering
it no longer has to come first:

- D1's structured state document is a different bet from the undifferentiated prose this spike
  was designed against. A labelled section survives blurring that free prose does not.
- The A3 parser writes a conformance record — sections present, whether line one matched, word
  count, retry count — into `stateAudit.tags` on every state write. Drift analysis becomes a
  query over a real run rather than a harness plus a synthetic one.

So the work moves into A3 and costs almost nothing there. **Define the query when A3 lands**,
not later: sections-present rate over time, word-count trend per entity, retry rate, and how
often the head-state token is one the entity's `states` field actually offers.

If the query says prose drifts anyway, the fallback is unchanged — tune the prompt, and if that
fails, the typed branch is the answer.

## 4. Phase 1 — storage and loading

### A3. Prose storage — **implemented**
Everything in the prose tier that does not touch the entity model. Landed under `convex/prose/`:

- **`contract.ts`** — the `state_contract` in code, which is what D1 actually means: both
  variants of the format instruction (actor with an intention section, prop without), the word
  budgets, the re-ask limit, and the blob threshold. Engine-owned, versioned with the engine,
  and the writer agent never sees a knob for it.
- **`stateDocument.ts`** — the parser. Head-state line, typed fields, detail paragraph,
  intention section, plus the `Conformance` record that D6 depends on. **It never throws**: a
  missing head-state, an empty `state:`, an invented token, a stray line, a document with no
  structure at all — each is parsed best-effort and recorded. Content is never dropped; a line
  that does not fit a section lands in `detail`.
- **`envelope.ts`** — the `05` §6.1 envelope and its §6.2 nested variant, with a JSON extractor
  that survives fenced blocks, trailing prose, and braces inside strings. `physics` is the only
  hard-checked field: a non-boolean is `malformed` and leaves `physics` undefined so the caller
  keeps the previous value. **Never coerced, never defaulted** — guessing `blocks_movement:
  false` opens doors nobody opened. Memory and reason truncate to budget and record it.
- **`schema.ts`** — `entityState`, `stateAudit`, `blobs`, `godTranscript`, wired into
  `convex/schema.ts`. `stateAudit` carries bounded `before`/`after` excerpts with truncation
  flags rather than whole documents, since it is derived and the authoritative copies are
  `entityState` and the log.
- **`store.ts`** — append/read helpers over the database, plus content-addressed blob storage.
  `hashContent` uses Web Crypto and is therefore action-side, which is the right place: an
  oversized payload is detected before the input is sent.

34 tests, most of them about tolerating malformed input, since that is the behaviour D1 asks for
and the behaviour most likely to be quietly "fixed" later.

#### The four input handlers moved to A4

`05` §9.2 lists `entityUpdateState`, `entityUpdateTarget`, `agentDecideAction` and `godVerdict`
as A3 work. They are not, and the reason is structural: **an input handler cannot write to the
database.** `inputHandler`'s signature is `(game, now, args) => Return`
(`convex/aiTown/inputHandler.ts:5`) — synchronous, no `ctx`, no `db`. Handlers mutate the
in-memory `Game`; the database write happens later in `saveWorld`, from the diff that `takeDiff`
produces, which is how `playerDescriptions` already works (`convex/aiTown/game.ts:241-245`).

So the shape a prose write actually takes is: the handler updates in-memory entity state and
marks it dirty → `takeDiff` includes it → `saveWorld` calls `appendEntityState` and
`appendAudit`. All three steps need the entity collection in the world document, which is A4.
`05` §9.3 already says the audit is "written by the same mutation that applies" the input; the
nuance worth recording is that the mutation is `saveWorld`, not the handler.

One thing this makes easy rather than hard: the engine never has to resolve a blob. The tick
loop reads only `physics` and `stateVersion` (`05` §1), so an oversized document travels as a
hash from the action all the way into `entityState` without anything in between needing the
prose.

### A4. Entity model + `world.json` loader — **implemented**

- **`entity.ts`** — one `Entity` class for tiers (b) and (c), in one `entities` collection on the
  world document, with `kind` carrying the only distinction that matters and nothing about
  targeting or approach reading it (D3). Physics is `{ blocksMovement, interactable }`;
  `interactable` is derived at load from having state, never authored (`05` §4.3).
- **`entityInputs.ts`** — `createEntity`, `entityUpdateState`, `entityUpdateTarget`, `godVerdict`.
  `createEntity` handles all three tiers: mobile actors still become a `Player` + `Agent` pair,
  fixed entities land in `entities`. It carries its content rather than a `descriptionIndex`, so
  the log stays self-contained (`07` §6.2).
- **`worldFile.ts`** — the `a1.0` types, validation (`07` §8 plus the `05` §12 rules that still
  have something to check), the load-time collision subtraction, and the one place the file's
  `blocks_movement` / `initial_state` becomes the engine's `blocksMovement` / `initialState`.
- **`data/world.json`** — the example world (D5), adapted from `Descriptions`: five mobile
  actors, one fixed actor, two props, every `initial_state` written in the §5.1 format with a
  per-entity `states` vocabulary. It is validated against the real map in the test suite, which
  is the check that keeps it honest as either side changes.
- **`init.ts`** — validates, subtracts, seeds from `meta.seed`, and emits one `createEntity` per
  entity. `--useDescriptions` forces the old path, which still works as the control (`07` §6.3).
- Anchor-scoped spawn in `Player.join`, with a sweep after ten failed random draws so a 1×1
  anchor is not a coin flip.
- The `CollisionOverlay` A1 left empty is now populated: rebuilt from entity physics on load, and
  maintained incrementally by `Game.setEntityPhysics` as a door opens or shuts.

#### How a prose write reaches the database

The mechanism A3 predicted, now concrete. A handler cannot write, so it does three things:
updates the world document, **allocates the next `stateVersion`** on the entity, and queues a
`ProseWrite` through `game.queueProseWrite`. `takeDiff` carries the queue; `Game.saveDiff` calls
A3's `appendEntityState` and `appendAudit` in the mutation that commits the step.

Two consequences worth recording:

**The version counter lives in the world document**, not in a query against `entityState`. That
keeps one authority for version numbers and avoids a read-modify-write on the commit path. It
also means `Player` gained a `stateVersion` field: tier (a)'s prose is keyed by player id — the
id everything else already references — so a player needs the same counter an entity has. Humans
never get one (`05` §13 A5 is still open).

**`before` is never supplied by the handler.** The engine does not read prose (`05` §1), so
`saveDiff` looks up the previous document itself. This is what keeps the typed floor intact under
a feature that is entirely about prose.

#### What A4 deliberately left

- **`agentDecideAction`** — the fourth handler of `05` §9.2 goes to A6, with the loop it drives.
  Applying an `approach` sets a `pendingInteraction` that nothing would yet consume; a handler
  that writes dead state is worse than a missing handler.
- **Memory storage.** `memories` requires an `embeddingId` a mutation cannot produce, so the
  input carries the memory text — which is what `05` §9.1 actually requires of the log — and the
  audit records it. Embedding stays action-side, in A5, where it already lives.
- **Rendering.** Nothing draws an entity yet; that is A8. `data/world.json` loads and its props
  block movement, but they are invisible.

#### A note on `data/gentle.js`

It gained a hand-authored `anchors` block. The map predates `07` and cannot be re-exported from
Tiled here, so the eight rects were chosen programmatically from tiles that are free in `objmap`
— every one is guaranteed placeable — and the names and descriptions are placeholders. A map
author would name them from what is actually drawn there, and the descriptions are what the
writer agent reads (`07` §4.3).

### A5. Prompt layer — **implemented**
The branch's real weight, and the first unit whose output is prose rather than structure.

- **`agent/promptContext.ts`** — one query returning everything a state-writing prompt needs for
  one entity, and the section builders that assemble it. Two of D1's rules are enforced by what it
  does *not* return: an entity never sees another entity's prose state, and `world_rules` goes in
  verbatim with no per-actor filter. `god.hidden_rules` is never loaded here at all, which is the
  structural reason filtering is unnecessary.
- **`prose/contract.ts`** — gained `ENVELOPE_INSTRUCTION` and `TARGET_ENVELOPE_INSTRUCTION`, so
  every piece of engine-owned prompt text lives in one file alongside the format it describes.
- **`agent/stateUpdate.ts`** — `requestStateUpdate`, the D2 re-ask loop, written as a pure
  function over an injected `ask` callback. That is what makes the branch's most important
  control flow testable without a model, and it is where the "mutations cannot call models"
  constraint is discharged. Plus `updateStateAfterConversation`, the `05` §6.1 single call that
  replaces the summarise-only call `memory.rememberConversation` was making.
- **Conversation prompts** now carry the speaker's own state, its head-state vocabulary, and
  `world_rules`. One-sided by construction: the other party's state is never in the prompt.
- **Storage the prompts need, which A4 dropped** — see below.
- 22 tests, most of them on the re-ask loop's branches and the prompt sections.

#### What "one re-ask" actually means

Length is the only thing worth re-asking over. A missing section, an invented head-state, a
document with no structure at all — all accepted on the first response, recorded in the
conformance record, and passed through. Over budget gets exactly one re-ask with the word count
in the hint; still over budget keeps the previous document and marks `fellBack`. A malformed
`physics` projection does **not** discard the prose that came with it: the state lands and the
entity keeps its previous physics.

The conformance record rides to `stateAudit.tags` on every write, which is D6's query.

#### A gap A4 left, closed here

A4's `createEntity` stored only what `serializedEntity` carries — id, kind, name, sprite, anchor,
physics, version — and silently dropped `persona`, `description` and `states` for fixed entities.
Nothing noticed, because nothing read them until there was a prompt. A5 adds
`entityDescriptions` (mirroring `playerDescriptions`), `states` on `agentDescriptions`, and
`worldDescriptions` for `world_rules` and the god's configuration.

#### The control is still a control

`agentRememberConversation` branches on whether the agent has prose state. An agent created from
`data/characters.ts` has none and stays on the original summarise-and-embed path, so the stock
behaviour is unchanged and remains a usable baseline (`07` §6.3). Only world-file entities take
the `05` §6.1 path.

#### What A5 left

- **The `05` §6.2 prop interaction.** `TARGET_ENVELOPE_INSTRUCTION` exists and nothing calls it:
  the call needs something to schedule it, which is A6 (`09` §6).
- **God prompts** — A7.
- **A memory type for prop interactions** (`05` §5.2). The conversation path reuses the existing
  `conversation` type; the new type arrives with the writer that needs it.

#### A defect the first live run found

`stateWritingSystemPrompt` told an entity its persona, its state and the contract, and then asked
it to emit a physics projection — without ever telling it what its physics currently *was*. The
envelope's "omit it if neither changed" is unanswerable under those conditions, so the model
guessed, and a model's guess for `blocks_movement` is `false`.

Observed: the Voice in the Well, authored solid, wrote itself walkable on its first state update,
and the collision overlay dutifully cleared its tiles. Nothing errored; the well just quietly
stopped being an obstacle.

The prompt now states current physics in plain language, for an entity writing its own state and
for an actor writing a prop's. Worth noting *how* this was found: not by a test, but by reading
`stateAudit`'s physics rows, which exist precisely so "how did this entity get here" has an
answer (`05` §9.3).

#### An open question this surfaced

An agent's conversation prompt still contains the *other* agent's persona
(`agent/conversation.ts:agentPrompts`), which is stock AI Town behaviour. D1's visibility rule
covers state, not identity, and `05` does not address it — but "Alice knows Bob's persona without
having met him" is the same kind of omniscience, and it is now the only one left. Left as it was
rather than changed silently.

## 5. Phase 2 — runtime

### A6. The agent loop — **implemented**
Specified by `09-agent-loop.md`. This is the unit that makes the world run on decisions rather
than dice.

- **`aiTown/manifest.ts`** — what an agent may aim at, built engine-side each time it decides.
  The governing principle of `09` §1 in code: cooldowns are **filters**, not prompt rules, so a
  target the agent may not approach is simply absent. No state in the manifest, distance as a
  band rather than a number, tiers described in prose rather than labelled with schema words.
- **`agent/decide.ts`** — the `05` §6.4 call. `parseDecision` never throws and never returns a
  choice outside the manifest: an out-of-manifest target is a *parse failure*, not something to
  validate downstream, because the engine already decided what was legal. Anything unusable
  becomes a short idle.
- **`agent/interact.ts`** — the `05` §6.2 prop call, which is where a locked door becomes an open
  one, and the tier (b) exchange.
- **`Agent.tick`** — restructured per `09` §5: remember, then conversation, then an approach in
  flight, then the decision. `agentDecide` replaces `agentDoSomething`; `agentDecideAction`
  replaces `finishDoSomething`.
- **Deleted** (`09` §11): `findConversationCandidate` and the upstream bug it carried,
  `wanderDestination`'s uniform random tile, the `ACTIVITIES` table, and `ACTIVITY_COOLDOWN`. An
  idling agent now does something its persona would plausibly do, because the model that chose to
  idle also wrote the description and the emoji.
- `MIN_DECISION_INTERVAL` is the one piece of pacing the model does not own (`09` §10). The
  invite-accept roll stays for v1 (`09` §9) — seeded, so it costs nothing in determinism.

#### The bug `09` §7 predicted

`toRemember` was checked *after* the decision branch, so an agent leaving a conversation chose
its next action before writing down what it had just learned. Harmless in stock AI Town, where
the engine never reads memory; a real bug here, where memory feeds target selection (`05` §9.1).
Moved above the decision.

#### Two corrections to `09` §6, recorded there

Tier (a) turned out to need no approach state at all — `Conversation` already owns walking toward
a moving target, so the handler starts one immediately and `pendingInteraction` exists only for
fixed targets. And tier (b)'s exchange runs inside one operation rather than as a tick-driven
lifecycle, because a fixed entity cannot walk away or be interrupted; the trade is that it lands
all at once instead of turn by turn.

#### What A6 left

- **Turn-by-turn visibility** for tier (b). The exchange is atomic from the engine's side, so a
  viewer sees the outcome rather than the conversation. `interactionTurns` has the content when
  something wants to render it (A8).
- **Interruption** (`09` §12 E1) — an agent walking to a target re-decides only on arrival or
  timeout.
- **The other's persona is still in conversation prompts**, the omniscience A5 flagged.

### A7. God agent — **implemented**, on the placeholder rule of §7 D7

- **`agent/god.ts`** — the two-stage gate, the transcript, batch formation, and the verdict, all
  as `05` §7 specifies. `godStep` runs one batch per world per tick; `godTick` is driven by a cron
  every 30s rather than by each state write, which is what keeps a **serial** component out of the
  path of every update (`05` §7.5).
- **The watermark lives on the transcript's own rows.** Each `event` row records the
  `throughInputNumber` it consumed, so a batch is never judged twice even if the transcript is
  later compacted — and there is no separate mutable counter to fall out of sync.
- **The formed batch is recorded before it is judged** (`05` §7.4), so a verdict can always be
  traced to exactly the evidence that produced it.
- **The god may only write to entities that were in its own batch.** `parseVerdict` drops
  anything else. It is already the largest threat to this design's debuggability (`05` §7.6); it
  does not also get to reach sideways.
- An unreadable gate does **not** intervene. The safe direction for a component whose failure mode
  is rewriting things nobody asked it to rewrite.
- 8 tests on the parsers, plus a live run against the local deployment.

#### What the first live run found

The gate fired on its first batch and the intervention rewrote the Voice in the Well, on the
grounds that "the well is a non-acting thing" and should not have an intention section. The well
is a fixed **actor** — tier (b) — and is supposed to have one.

The god was not wrong; the rule was. `FORMAT_RULE` illustrated the prop variant with "a door, a
board, a well", and the batch summary gave the god nothing but entity ids, so it inferred the tier
from a name and applied the rule exactly as written.

Both halves are fixed: the rule states the distinction as capability with no example nouns, and
the batch now labels each document with which variant it should be judged against. The general
lesson is worth keeping: **an example in a rule is a rule**, and a model will follow it over the
abstraction it was meant to illustrate. That will matter more, not less, when the placeholder rule
is replaced by `world_rules`.

#### Still a placeholder

The rule is the §5.1 format contract, not the story (D7). Swapping it means changing the rule text
that goes into the gate and the intervention; the transcript, batching, watermark, verdict input
and step-boundary ordering do not change. `hidden_rules` is stored and loaded but not yet in the
prompt, because a format rule has no secrets — it goes in with `world_rules` when the story does.

## 6. Phase 3 — client and replay

### A8. Client: entities and prose state — **implemented**

- **`Entity.tsx`** — a marker drawn over each fixed entity's anchor rect, with its name and a
  click target. Solid entities read differently from ones you can walk past, which is the one
  physics fact a viewer needs.
- **`StateDocument.tsx`** — renders a state document as the three parts it is written in. Parsing
  here is as forgiving as the engine's, and for the same reason: a document with a missing section
  or an invented head-state should *look* malformed rather than disappear.
- **`EntityDetails.tsx`** — what the thing is, what state it is in, and the last exchange it took
  part in. Its immutable `description` and its mutable state are shown as different things,
  because they are (`05` §4.2).
- **`PlayerDetails`** gained the same state document, so tier (a)'s prose is visible too.
- Server side: `gameDescriptions` carries `entityDescriptions`, plus two new queries —
  `world.entityState` and `world.recentInteraction`.

#### Prose is its own subscription

`entityState` is a separate query rather than part of `gameDescriptions`, because prose is not in
the world document (`05` §8), it changes on its own cadence, and only the selected entity's is
ever needed. `stateVersion` in the world document is what makes that cheap — it is the change
signal, carried at one integer per entity per step.

#### There is still no prop art

`data/gentle.js` predates entities and its `sprite` names — "well", "door_closed", "board" — have
no tileset behind them. An entity is therefore drawn as a marker over the ground it occupies
rather than as a picture of itself. That is honest about what the world actually knows, and it
gives the thing a click target; `Entity.tsx` is where a sprite goes when one exists.

#### Z-ordering, which `07` §10 left open

Entities draw above the flattened map layers and below players, so a character walking past a
door is in front of it. Recorded in `07` §10.

### A9. Snapshot + replay driver
Identical in shape to `03` U1, and now also the retention answer for `05` §13 A6 — `inputs`
grows without bound and is never vacuumed. Drive replay from the recorded step boundaries
A0 persists.

### A10. Common knowledge — **implemented**, on D8

- **`prose/contract.ts`** — `COMMON_KNOWLEDGE_ID`, and the contract itself: the §5.1 document in
  the prop variant, minus the bracketed tail, plus the scope rule. The rule list was split into
  named pieces so this variant can take the shape rules without the two that name an entity's
  `description` — a subject that has none does not read a rule about one as inapplicable, it reads
  it as a referent to go and find (the lesson of A7's first live run, applied to pronouns).
- **`aiTown/world.ts`** — `commonKnowledgeVersion`, the same integer `stateVersion` is, on the
  world rather than on an entity because common knowledge is not one.
- **`aiTown/entityInputs.ts`** — `godVerdict` gains an optional `world`; `entityUpdateState` and
  `entityUpdateTarget` refuse the reserved id, so the one-writer rule holds for a caller written
  later that never read this file.
- **`agent/promptContext.ts`** — `commonKnowledgeSection`, placed after `world_rules` and before
  anything per-entity, so a god write invalidates only the part of the prompt that was changing
  anyway and the cached prefix survives.
- **`agent/god.ts`** — both prompts gained the rule and the current document; `parseVerdict` gained
  the `world` half; `loadGodBatch` filters the god's own write back out of its next batch, which it
  would otherwise read as evidence and rewrite.
- **`init.ts` / `worldFile.ts` / `data/world.json`** — `common_knowledge` authored at top level,
  budget-checked at load, installed at world creation beside `world_rules` and the map rather than
  through an input.
- 15 tests across the verdict parser, the contract text, the prompt section and the loader.

#### The funnel had one leak, and it is closed

`worldRulesSection` is the single path world-level prose takes into an actor prompt — except that
`interact.ts`'s fixed-actor turn prompt inlined its own phrasing of `world_rules`. It was therefore
the one site that would have silently missed common knowledge. It now goes through the sections
like everything else. A second copy of a prompt fragment is a site that will be missed by the next
thing added to the first copy, and this is the second time that has been true in this branch.

#### What A10 left

- **No client rendering.** `api.world.commonKnowledge` exists and nothing subscribes to it. It is
  the natural companion to A8's `StateDocument`, and a world document nobody can read is harder to
  debug than one that is on screen.
- **No engine events** (`05` §13 A8), which is D8's deliberate v1 position rather than an omission.

---

## 7. Decisions — resolved

All but one are now decided. Each entry records the decision and what it changed in the specs.

**D1. The prompts and the `state_contract`. — Decided.**
Per-entity persona, goal and head-state vocabulary are the writer agent's output; until the
writer exists they are copied or drafted by hand (see D5). The decision that matters is the
contract, and it has three parts:

- **The `state_contract` leaves `world.json`** and becomes engine configuration. A writer able
  to rewrite the contract could emit one the parser cannot enforce, with nothing able to detect
  the disagreement. `05` §2 and §5.1 amended.
- **The state document gains structure**: a head-state line, optional typed lines, a prose
  paragraph, and — for actors only — an intention section. Props get the same format without
  the intention section. `05` §5.1 replaced.
- **`world_rules` is not filtered per actor.** It goes verbatim to every actor. Rules an actor
  must not know go in `god.hidden_rules`, which no actor prompt ever sees — structural rather
  than algorithmic. `05` §2 and §7 amended.

Two consequences recorded rather than resolved. The head-state line **is** a typed field by
another name, authored per entity and read by the god; `05` §2 and §9.4 now say so, and the
rule is that nothing in the tick loop may branch on it. And the manifest an agent sees before
approaching carries identity, not state — so an agent cannot perceive visible state, which is
a world rule with real limits (`05` §6.4).

**D2. Where `on_overflow` runs. — Decided: in the action.**
Mutations cannot call models, so the input handler stays a hard backstop that can reject or
truncate, and the single re-ask lives in the action before the input is sent. `state` gets one
re-ask then falls back to the previous document; `memory` and `reason` truncate with no re-ask.
The budget is loose — on the order of a thousand words — because a tight cap on a structured
document truncates the intention section, which is the part the next decision reads. `05` §5.1
amended.

Enforcement is otherwise deliberately weak: length is the only hard restriction on prose. A
missing section, an invented head-state, a broken boolean are tolerated and recorded, because
what an entity does with a malformed state document is an observation. Two consequences for A3
and A5: **the parser must never throw**, and **`physics` is the one exception** — a malformed
projection keeps the previous physics rather than falling back to a default, since the tick
loop reads it and guessing `blocks_movement: false` opens doors nobody opened.

**D3. Tier (c) props at runtime. — Decided: homogeneous targeting, split lifecycles.**
The set an actor may aim at is (a) + (b) + (c) — one manifest, one id space, no tier
distinction in choosing a target. (b) and (c) share one `entities` collection with anchors and
prose state; (b) additionally carries what it needs to run inference.

This surfaced a correction to `05` §3.1, now recorded there: the runtime splits on **mobility**
during approach and on **agency** during dialogue, so `04` §6.1 and `05` §3.1 were each right
about one phase. The practical consequence is that the dialogue lifecycle stays split — a
two-sided `Conversation` and a one-shot `Interaction` — because forcing a fixed target through
`invited` / `walkingOver` leaves more dead state than a second lifecycle is code.

**D4. Model-chosen actions and the tick gates. — Specified in `09-agent-loop.md`.**
The only one that needed a design rather than a decision.

**D5. A golden `world.json`. — Decided: fake one.**
Adapted from the existing `Descriptions`, `world_rules` empty, no real story. The goal is a
runnable framework, not a good world. It is A4's loader fixture and A5's few-shot.

**D6. The drift spike. — Decided: deferred, instrumented instead.**
A2 comes off the critical path. Two reasons it is defensible rather than merely convenient.
D1's structured format is a different and better-behaved bet than the undifferentiated prose
A2 was designed to test; and the parser now writes a conformance record — sections present,
word count, retry count — into `stateAudit.tags` on every write, which turns the drift question
into a **query over production data** answerable at any point rather than a harness that has to
be built and a run that has to be scheduled. `05` §13 A1 amended. The question stays open;
answering it no longer blocks.

Related, and already settled by `05` §11: the agentic branch needs no explicit `outcome`. The
`04` §8 outcome contract bridged free text to typed branching, and with the transition itself
agentic and the conversation in context there is nothing to bridge. The one wrinkle is D1's
head-state, which is a branch point in waiting.

**D7. The god in v1. — Decided: ship it, on a placeholder rule.**
The god's shape is *state + rule → judgement, and a fix if they conflict*, and that shape holds
whatever the rule is. Until a world file carries a story, the rule is the §5.1 format contract.
The pipeline — gate, transcript, batch formation, step-boundary application — is built as
specified, and only the rule text is swapped later.

Two constraints keep it a simulation of the real thing rather than a formatter with a
transcript. Conformance checking goes **in the gate**, not the intervention, so the
intervention still fires rarely and its hit rate is still an informative cost signal. And the
god is not the first line of repair: D2's re-ask has already run, so the god only ever sees
what survived one attempt. A god firing on most writes means the gate is in the wrong place.
`05` §7 amended.

**D8. A shared world state. — Decided: one prose document, god-written, reserved key.**
Per-entity prose answers *what is this entity like*; nothing answered *what is true in this world
now*, and `world_rules` is the wrong place to look — it is immutable, and about how the world works
rather than what has happened in it. `05` §5.3 adds **common knowledge**: one prose document, read
by every actor, written only by the god.

Three choices carry it, and each is the rejection of an easier one.

**Storage reuses `entityState` under a reserved id, but never `world.entities`.** `05` §7.3
refuses to put the god's transcript in `messages` for four reasons — validated branded ids, a
renderer, a scanner one join from agent memory, a shape that does not fit — and none of them hold
for `entityState`, whose `entityId` is an unvalidated string already mixing two namespaces. So the
reserved key inherits versioning, the audit table, the blob path and the client's change signal.
A pseudo-*entity* was the tempting version of the same idea and is the one to refuse:
`world.entities` is iterated by the manifest, the collision overlay, the targeting set and the
client, so it would have bought four exclusion checks and a fifth for whoever adds the next
iteration. The rule worth carrying forward: **reuse the derived storage, never reuse the engine's
collections.**

**The write rides in `godVerdict`, not a new input.** One judgement, one `batchId`, one atomic
step-boundary application (`05` §7.6). A separate input could tear against the entity writes formed
from the same evidence. The two halves parse independently, so a malformed `writes` array cannot
discard a good world write.

**The gate gets a second question rather than the god getting a third stage** (`05` §7.7).
Leaving common knowledge to the intervention alone would have coupled it to the format gate's hit
rate, so it would go stale except on the batches where something else happened to be malformed.
The cost is that the gate's hit rate now mixes two causes; the `why` string and a `commonKnowledge`
flag on the trace are what keep it readable.

Two things deliberately left, both recorded rather than resolved. **What may go in is a prompt
rule, not a checkable one** — the entity half of a verdict is scoped structurally by the batch, the
world half only by the contract's scope rule, and that asymmetry is real. And **the god still sees
only concluded interactions**, so an engine event nobody notices never reaches common knowledge
(`05` §13 A8). Given this branch's scope rule that is arguably correct rather than merely cheap:
the world learns things because someone noticed them, which is `05` §6.4 holding rather than being
worked around.

---

## 8. Recommended order

```
week 1     A1 ✓  A0 ✓
week 2-3   A3 ✓ storage, parser, contract, conformance record ← A2 lives in here now
week 3-5   A4 ✓ entity model, loader, example world
week 4-6   A5 ✓ prompt layer, re-ask loop, prose-aware prompts
week 6-8   A6 ✓ agent loop (docs/09)
week 8+    A7 ✓ god (placeholder rule)  A8 ✓ client  A10 ✓ common knowledge  · A9 replay remains
```

Every decision but D4 is resolved (§7), and D4 is specified in `09-agent-loop.md`, so nothing
below is waiting on an answer. A9 can be done by a second engineer in parallel throughout; it
touches almost none of the same files.

The one thing that would reorder this: if A3's conformance query shows drift early, A5 grows
and everything after it slips.

---

## 9. Risks

**Drift is now discovered in production rather than before building.** That is the deliberate
trade in D6, and its cost is that the discovery lands after A5 exists rather than before. The
conformance record is what keeps the discovery early *within* a run; nothing keeps it early
across the plan.

**The prompt layer is one large untestable unit.** `03`'s typed units are pure functions with
unit tests; A5 has none of that. Mitigation is the eval harness (D6), which is why it is a
blocking decision rather than tooling.

**The OCC hotspot.** `05` §9.7: `engineInsertInput` allocates input numbers with a
`.order('desc').first()` on a single index, and `agentOperations.ts:147-149` already
mitigates with random jitter. A3 and A6 multiply input traffic several-fold. Load-test at
the end of A3, before A6 makes it worse.

**Cost.** `05` §6.4 replaces a `Math.random()` branch with a model call per agent per
decision, and A7 adds a gate call per interaction. Nobody has put a number on this
(`05` §13 A3). Size it during A6, not after.

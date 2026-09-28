# Unifying the Two World Models

`resolves docs/11 F1` · `verified against vandoger-merge-agentic@7832831`

`11` §3 names domain-model unification as the largest open question in the merge and leaves it as a
single line: two state trees, two command vocabularies, they have to become one. That is true and it
is not one question. It is five, they are independent, and they resolve on different grounds.

This document is the enumeration. One chapter per conflict, each filled as it is settled. §1, §2, §3
and §4 are settled. The rest state the question precisely and wait — a stated question being the
part of an empty chapter worth writing down.

| §   | conflict                                | status                  |
| --- | --------------------------------------- | ----------------------- |
| 1   | Tasks: who owns progress                | **settled**             |
| 2   | Movement, coordinates and occupancy     | **settled**             |
| 3   | Time: fast-forward, idle pause, cadence | **settled**             |
| 4   | Write authority on world state          | **settled**             |
| 5   | Code-driven state change                | open — §1 depends on it |

---

## 0. The rule that decides these

Stated once, because it decides more than one chapter: **this project is an experiment in how far a
world driven purely by natural language can go, not a release-quality game.** Where the two sides
disagree about who owns a piece of state, prose wins — including where a typed structure would be
more robust. A conflict here is resolved by asking what the experiment is for, not by asking which
side is sounder.

Two consequences follow, and both matter more than the rule itself.

**Knowingly worse engineering is a result, not a defect** — but only if it is recorded as such.
Every chapter that takes the prose side against the sound side carries a subsection saying so and
naming what the sound side would have bought. §1.6 is the first. A deviation nobody wrote down is
indistinguishable later from an oversight, and the whole value of the experiment is in knowing which
departures cost what.

**The premise decides ownership, not correctness.** A prose document the engine silently reverts, a
rewrite path that breaks replay, a parser that turns a model's malformed line into a crash — none of
these are natural-language ambition. They are ordinary bugs wearing its clothes. Prose owning a
value never licenses losing it.

---

## 1. Tasks

### 1.1 The conflict

The init side's tasks are typed and engine-owned. `state.tasks` holds
`{activated, completed[], steps: Record<string, {count, values}>}`; progress advances only through
`progressTasks`, which matches authored conditions against four fact kinds — `choice.confirmed`,
`interaction.started`, `movement.completed`, `scene.entered` (`prototype/taskFacts.ts:1-6`). Every
step in the shipped S01 investigation matches on `{entityId, choiceId}`, so progress is keyed to
authored choice identifiers.

The agentic side has no task concept at all. Its nearest equivalent is a prose document that a model
writes and every prompt reads back.

Merged as-is, an agentic NPC could only advance a task by emitting an authored `choiceId` — which
makes the model's vocabulary a function of the content file, and is the coupling §0 exists to
refuse.

### 1.2 The decision

**Task progress moves to prose. Task definition stays in the world definition.**

1. **Progress** is a `<tasks>` block in the world-state document (`__world__`), alongside a
   `<player_items>` block for what the player carries. §1.4 is that document.
2. **Definition** — id, title, ordered steps, each step's target entity, its text, its `!`/`?`
   marker — stays authored, loaded once, read-only at runtime. No model writes it.
3. **Granularity** is one status token per task. `condition.collect`, distinct-value counting and
   the per-step `StepProgress` record are given up.

### 1.3 The token names the step, not the task

A task's target changes as it advances, and only by advancing: each step carries exactly one
authored `where.entityId`, fixed at load. `s01-door-tag` runs through six of them
(`low-deck.door-tag-317` → `ash` → `unit-404.old-record` → `n07` → the tag again →
`unit-404.cabinet`).

So the definition supplies the target for a given step, and prose supplies which step is current.
Which means the status token must name **the step**:

```
<tasks>
s01-door-tag = ask_ash
</tasks>
```

not `= accepted`. It is one token either way and still carries no counter, so this costs nothing
against §1.2's third part. What it buys is `taskGuidance` (`src/lib/taskGuidance.ts`): given a
current step it finds the scene holding that step's target, BFSs the portal graph from where the
player is, and plants the gold marker on the exit door along the route. Given only `accepted` it has
nothing to route to and the waypoint system is deleted rather than kept.

Reserved values beyond a step id: `done`, and whatever §5 settles on for failure. An unrecognised
token renders as _in progress, target unknown_ — never as failure. See §1.7.

**Spelling.** Reuse `<items>`' shape rather than inventing one: a block found anywhere in the
document, `name = value` lines inside (`engine/prose/stateDocument.ts:90-91`, `parseItems`). A
`<tasks>` parser is a near-copy of that function. Note that `name: value` lines are read as fields
only inside the head block, so a colon spelling outside it silently parses as prose.

### 1.4 The document this lands in, and why its name is a hazard

The document is renamed **world state**. It is the world's counterpart to an entity's state
document, and it carries three parts:

| part              | written by          | what it is                                      |
| ----------------- | ------------------- | ----------------------------------------------- |
| a prose paragraph | mainly the god      | free form: what is true in this world right now |
| `<tasks>`         | agents, and the god | §1.3's status lines                             |
| `<player_items>`  | agents, and the god | `<items>`' shape, for what the player carries   |

`<player_items>` is filed here rather than in a player-state document of its own. That a player
document should exist eventually is likely; it is not this chapter.

The rename is not cosmetic, and this is the finding: **"common knowledge" is not only an identifier.
It is instruction text, it reaches the model on every write and on every gate call, and read
literally it forbids most of what the two blocks are for.**

`COMMON_KNOWLEDGE_RULES` (`engine/prose/contract.ts:249-260`) ships inside
`COMMON_KNOWLEDGE_CONTRACT`, which is injected into the god's write prompt and into the Jev gate's
state as `what_common_knowledge_is_for` (`agent/gateJev.ts:102`). Four of its lines are now wrong:

| the contract says                                                                                            | against the new document                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Nothing here is secret, and nothing here is in doubt. If a fact is not yet settled, leave it out and wait." | an in-progress task is definitionally unsettled, so a compliant writer withholds `= ask_ash` until the task finishes — the one moment the line stops being useful |
| "anything only the people present could know does NOT go here"                                               | a precise description of the player's inventory                                                                                                                   |
| "a fact that stops mattering should be dropped rather than kept forever"                                     | invites deleting completed task lines on rewrite                                                                                                                  |
| the stated shape is a head-state and **one paragraph** (`contract.ts:237`)                                   | blocks are not in it, so a rewrite folds them back into prose                                                                                                     |

Two more break under §4. `agent/god.ts:56-60` tells the god _"You are the only writer of this
document. Nobody else can add to it"_ — false once agents write, and misleading about whether to
preserve what it finds. And the gate's only knowledge question fires on "something everyone in this
world should know has become true" (`agent/gateJev.ts:130-135`), so a stale task or item line never
triggers a refresh: the last resort cannot notice the thing it is the last resort for.

**The fix is to scope the rule, not to delete it.** The "everyone would already know" clause is the
one documented exception to docs/05 §6.4 — an actor learns another entity's state only by
interacting — and `contract.ts:240-246` says so in as many words: _"a deliberate exception… only
safe while what goes in is restricted to what every inhabitant would already know anyway."_ Delete
it and every actor silently learns everything. Keep it whole and the blocks are blocked. So it
attaches to **the prose part only**, and the blocks get a rule the contract currently has no
equivalent of:

> The `<tasks>` and `<player_items>` blocks are records, not narration, and they merge line by line.
> Write only the lines you are changing. Every line you do not write stays exactly as it is. Leaving
> a line out never removes it — to say the player no longer has something, write it with a count of
> 0; a task's line is never removed.

(As first drafted this rule said the opposite — copy every line through, restate both blocks every
time — which is right under whole-document writes and does not survive fifty tasks. §4 replaces it.)

The rest is naming, and it reaches the model too: Jev takes its state as an object precisely so a
question can point at a part **by name** (docs/12 §3), which puts `what_everyone_here_knows`
(`agent/decideJev.ts:141`, `agent/gateJev.ts:103`) in front of the model on every decision and every
gate call. It, `what_common_knowledge_is_for`, and the two reader headers
(`agent/promptContext.ts:140`, `agent/god.ts:331`) rename with the concept.

The stored id needs no change — it is already `__world__` (`contract.ts:229`). The world-file field
`common_knowledge` (`engine/aiTown/worldFile.ts:37`) is authored-facing, so renaming it to
`world_state` is a format change; accept both spellings and it costs nothing.

### 1.5 What this deletes

| deleted or demoted                                  | why it existed                            |
| --------------------------------------------------- | ----------------------------------------- |
| `collectFact` and the `Fact` plumbing               | typed progress from typed events          |
| `progressTasks` call sites (5)                      | same                                      |
| `condition.collect`, `condition.items`, `count > 1` | distinct-value progress, given up in §1.2 |
| `StepProgress` in `taskViews()` and the TaskBoard   | per-step counts, given up in §1.2         |

Kept and unchanged: task definitions in story files, `taskGuidance`, TaskBoard's list and staged
background/description, the `!`/`?` markers.

`activateTasks` — trigger conditions that activate a task from world `vars` with no player act — is
not deleted here. It is §5's question.

### 1.6 Recorded deviation: this is the branch docs/05 §9.4 warned against

`engine/prose/stateDocument.ts:44-49` parses `<items>` and then deliberately reads nothing from it:
_"The moment something branches on it, this branch has reinvented `vars` (docs/05 §9.4)."_ §1.2 is
that branch, taken on purpose under §0.

What the warning was about, so the cost stays legible: the failure mode is not that prose is hard to
parse. It is that once the engine branches on a prose field, the model's freedom in that field is
silently bounded by what the branch expects, and prose becomes a schema with no validator and no
error. The typed alternative would have bought exactly one thing — a task state that cannot be
mistyped into non-existence — and that is what we are spending.

The mitigation, which is not optional: **the engine never refuses an act because the block said
something it did not recognise, and the UI never renders an unparsed token as failure.** An
unrecognised status is _unknown_, the task stays listed, and the run continues. Unparseable prose
must degrade the view, never the world.

### 1.7 Consequences accepted

**Latency.** The god writes world state only after forming a batch, at `GOD_INTERVAL = 30_000` game
ms, and only when the gate fires. Today `progressTasks` runs inside the command that caused it and
the board updates in the same frame. Accepted, because the god is the last resort here and not the
main path: the intended writer is the agent in the conversation — the door tag is itself an agentic
prop. That makes §4 a dependency of this chapter rather than an adjacent concern.

**Scope.** Writing progress to `__world__` means every entity knows how far the player has got
without having learned it — a widening of the one documented back door in the prose tier. §1.4
resolves this by scoping the "everyone would already know" clause to the prose part rather than
accepting the widening: the blocks are records the engine keeps in the world's document, not things
the world is asserted to know. What remains open is only whether `<player_items>` eventually moves
to a player-state document of its own, which changes nothing about the parser or the contract.

**Budget.** Prose documents have a 1,000-word budget, and an over-budget update falls back to the
_previous document whole_ rather than truncating (`agent/stateUpdate.ts:57-70`). A task block
competes with narrative prose for that budget, and one overrun reverts task state invisibly. This is
a §1.6-class bug, not a tolerable cost: the blocks are extracted before the budget check, so a long
paragraph can never revert them. **Fixed — §1.8 item B.** Under §4 the fallback is narrower still:
what it reverts is one patch, not the document.

**Replay.** Task state leaves the input log and becomes a prose-tier document with its own version
counter. Reconstructing "what was the task state at idx N" stops being a fold over inputs.

### 1.8 What is unblocked now

None of these wait on §3, §4 or §5. They are ordered so that the typed path is still running when
the prose path first carries weight.

| #   | work                                                     | why it can start                                                                                                                                                                                                         |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | `<tasks>` and `<player_items>` parsers                   | near-copy of `parseItems`/`ITEM_LINE` (`stateDocument.ts:90-119`), with tests to copy at `stateDocument.test.ts:172-197`. Add block counts to `Conformance` beside `itemCount`, so drift is queryable from the first run |
| B   | extract the blocks **before** the budget check           | §1.7's budget bug. Independent of every open chapter                                                                                                                                                                     |
| C   | the rename and the contract split of §1.4                | prompt and naming work only                                                                                                                                                                                              |
| D   | flip the reader, keep the typed writer                   | TaskBoard and `taskGuidance` read the step id from the parsed block while `progressTasks` still writes it                                                                                                                |
| E   | `world_state` in the world file, both spellings accepted | rides with C                                                                                                                                                                                                             |
| F   | lift the single-writer throw (`entityInputs.ts:31-32`)   | the throw is one line; the two-writer race behind it is §4                                                                                                                                                               |

**D is the one worth not skipping.** While both paths run, the typed one is a reference
implementation for the prose one, and every disagreement between "what `progressTasks` computed" and
"what the model wrote" is a free measurement of the §0 premise — does a model hold `= ask_ash`
stable across a dozen rewrites under a word budget? Nobody knows. That instrument disappears the
moment §1.5's deletions land, so the deletions go after D has run, not before.

Blocked, and left alone: an agentic entity driving a task (needs §2's shared identity), and a
`failed` status (§5). Agent writes racing god writes was on this list; §4 settled it, and the
mechanism — patch writes folded at read — is in `engine/prose/worldState.ts`.

Already in place, not to be redone: docs/11 §4.2's lint rule exists as the `engine/` ban in
`.eslintrc.cjs`, and §4.5's invariant has a test at `src/sim/agenticRuntime.test.ts:48`.

---

## 2. Movement, coordinates and occupancy

### 2.1 The conflict is narrower than it was stated

The earlier draft of this chapter called `engine/aiTown` continuous and the init side discrete. Read
against the code, that overstates it. **Both sides are integer lattices for collision and for
destinations.** The engine enforces it with a throw:

```ts
if (Math.floor(destination.x) !== destination.x || Math.floor(destination.y) !== destination.y) {
  throw new Error(`Non-integral destination: ${JSON.stringify(destination)}`);
}
```

(`engine/aiTown/movement.ts:31-33`). Static collision floors before every lookup and indexes a
boolean grid — `blockedStatic(Math.floor(x), Math.floor(y))`, `this.collision[x]?.[y]`
(`movement.ts:180-186`, `worldMap.ts:98-100`) — structurally the same 0/1 matrix as the init side's
`map.collision[y][x] === '#'` (`prototype/content.ts:32-37`). `findRoute` expands only `±1` lattice
neighbours; its fractional branch exists _solely_ to snap a fractional position back onto the grid,
and says so in its own comment (`movement.ts:65-90`). Every agent destination is floored before it
arrives: `approachDestination` returns `{x: Math.floor(…), y: Math.floor(…)}` or an integer approach
tile (`agentInputs.ts:28-42`).

There is no nav-mesh, no sub-tile static geometry and no continuous steering on either side. What
actually differs is narrower, and it is five things:

|                          | init side                                                                                 | `engine/aiTown`                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| position in stored state | always integral; `draft.player = draft.moving.target` (`world.ts:1222`)                   | fractional; `this.position = position` written every `TICK = 16` ms (`player.ts:169`) |
| where the float lives    | render lerp only (`src/components/LocalGame.tsx:771-783`)                                 | simulation, then render                                                               |
| actor-vs-actor collision | exact tile equality **plus target reservation** (`world.ts:1119-1139`)                    | disc, `distance < COLLISION_THRESHOLD` = 0.75 (`movement.ts:176`)                     |
| speed                    | fixed `stepMs` per tile — shipped value 160 ms, i.e. 6.25 tiles/s (`prototype/map.ts:11`) | `movementSpeed = 0.75` tiles/s (`data/characters.ts:113`)                             |
| map unit                 | 26 scenes, each with its own collision, `blockedEdges`, anchors, portals                  | one `worldMap`                                                                        |

The speed row is its own conflict and easy to miss inside the coordinate argument: the two movers
differ by 8.3×, and that is a content decision, not an engine one.

### 2.2 The decision

**The integer lattice is the authority. Continuous position is derived for display and never
stored.**

1. **Position is `(sceneId, x, y)`** with `x`, `y` integral. `sceneId` is a component of the
   coordinate, not a container around it.
2. **In-flight movement is an edge, not a point.** State holds
   `{from, target, startedAt, durationMs}` — the init side's `moving` record
   (`prototype/entities.ts:19`) generalised to a path. `pathPosition`
   (`engine/util/geometry.ts:26-56`) stops being a state mutation and becomes a view function, which
   is what `LocalGame` already does for both player and NPCs (`LocalGame.tsx:771-783`, `1293-1301`).
3. **Tile reservation is kept, and therefore imposed on agent movement.** The 0.75 disc and its
   randomized backoff go.

### 2.3 Why the lattice wins — and why §0 does not decide it

State the exception first: **§0 is silent here.** No prose, no model authorship, nothing a natural-
language premise has an opinion about. This chapter is decided on engineering grounds alone, and it
is the only one so far that is.

Four reasons, in descending order of how much they cost to ignore:

**Exact-integer adjacency is load-bearing outside movement code.** `nearby()` gates every
interaction on `Math.abs(dx) + Math.abs(dy) === 1` or an exact `interactionOffsets` match
(`world.ts:254-264`). `move_entity` refuses a path whose first step is not exactly Manhattan-1 from
the actor (`world.ts:1030-1035`). Under fractional positions these do not degrade gracefully — they
stop firing, and the game becomes one where you cannot talk to anybody.

**The integer contract runs through the content format, not just the runtime.** Entity positions,
anchors, art positions, `interactionOffsets`, `portalTiles` and `blockedEdges` are all
`Number.isInteger`-validated at load (`content.ts:450-596`). `blockedEdges` is the sharp one: it
blocks the seam between two named tiles, `[ax, ay, bx, by]` (`content.ts:38-47`), and has no meaning
for an actor standing at `x = 3.4`. `engine/aiTown` has no equivalent concept, so a float actor
walks through authored seams silently — a content-authoring guarantee lost with no error.

**Soft collision imports a randomized retry loop.** When two discs overlap the engine parks the path
for `game.rng.random() * PATHFINDING_BACKOFF` (`player.ts:159-166`). Seeded, but order-sensitive,
and `prototype/replay.ts` and `entityRecording.ts` reconstruct state by exact reproduction. `11`
§3's warning about cross-runtime float divergence applies to the positions themselves.

**Cost of the change, both directions.** Going float means rewriting the content validators, finding
a replacement for `blockedEdges`, a new determinism story for replay, and per-tick position churn in
whatever `11` settles on for storage. Going integer means the engine keeps a contract it already
asserts in `movePlayer`. Nothing in the agentic layer — the agent loop, conversations, the god,
world state — reads a position at sub-tile resolution.

### 2.4 What `sceneId` becomes

It becomes part of the coordinate. Search is unchanged _within_ a scene; crossing scenes is the
portal BFS that `taskGuidance` already runs to plant waypoints (§1.3). The engine's `blocked()`
gains the scene filter the init side's `startEntityStep` already has — `e.sceneId === actor.sceneId`
(`world.ts:1119-1127`) — and `blockedWithPositions` takes one scene's `WorldMap` rather than the
world's.

An empty `sceneId` stays what it already means: offstage, position being only the last simulation
coordinate (`prototype/entities.ts:13-14`), which is the state `schedules.ts` drives an NPC through
as `leaving` → `away` → `returning`. Whether an offstage agent still thinks is §3's cadence
question, not this one.

### 2.5 The occupancy invariant, and the exception it already has

The invariant is **one walking actor per tile**, enforced at both ends of every step:
`startEntityStep` refuses a tile another actor occupies _or is merely moving toward_, and separately
refuses the player's position, the player's move target and the player's seat-exit tile
(`world.ts:1119-1139`).

The earlier draft named `seatUnavailable()` as a dependant of this invariant. It is not — it keys on
`activity.seatedOn` and the chair's `table` id, never on tiles (`world.ts:270-283`). Seating is in
fact the invariant's standing **exception**: sitting sets
`draft.player = { x: entity.position[0], y: entity.position[1] }` (`world.ts:768-769`), and the
content validator _requires_ a seated guest's position to equal its chair's (`content.ts:594-598`).
So a seated actor and its chair share a tile by design. The real dependants are `nearby()` and
`move_entity`, per §2.3.

Worth keeping straight, because "one actor per tile" is the thing agent movement must be made to
respect, and it is narrower than it sounds.

### 2.6 What to take from `engine/aiTown` anyway

The coordinate model does not come across. Three things should:

| take                                                                       | why                                                                                                                                          | where                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `bestCandidate` partial-path fallback                                      | `npcPath` returns `null` on an unreachable goal and the caller gets nothing; the engine walks as far as it can and reports a new destination | `movement.ts:128-151`                 |
| `PATHFINDING_TIMEOUT` and the `needsPath`/`waiting`/`moving` state machine | a blocked agent retries instead of standing still forever                                                                                    | `player.ts:96-141`, `constants.ts:11` |
| `MAX_PATHFINDS_PER_STEP = 16`                                              | a per-step search budget; the init side has none because it has at most a handful of scripted movers                                         | `player.ts:120-124`                   |

**Not A\*.** On an unweighted lattice of at most 64×64 (`content.ts:450`) BFS is already optimal,
and `npcPath`'s multi-goal signature (`pathfinding.ts:15-19`) is capacity the engine's
single-destination `findRoute` lacks — though all four call sites currently pass one goal, so this
is latent, not used. Revisit if tile costs ever appear.

### 2.7 Recorded cost: what soft collision would have bought

Not a §0 deviation — §2.3 — but the cost is recorded on the same principle.

The disc lets two agents slide past each other in a one-tile-wide corridor with partial overlap.
Reservation makes that corridor a hard block. For hand-authored maps of this size that is level
design, and the 26 shipped scenes were drawn against a mover that already had this constraint.

The part that is _not_ free: reservation alone does not solve deadlock. Two agents stepping into
each other's target tile both refuse and both stop, and `startEntityStep` simply returns.

**Narrowed by §2.9.** "There is no retry" was wrong: `advanceState` calls `startEntityStep` for
every entity on every step, so a refused step is retried next tick and a blocked walker resumes the
moment the blocker moves. Nothing needs backoff jitter, and the question of whether a
`game.rng.random()` draw survives replay does not arise. What is left is the narrow case — two
entities holding each other's target tile, refusing each other forever — and for that a
deterministic tiebreak, **lowest entity id yields**, is the whole fix. Still to be written, no
longer a decision.

### 2.8 Consequences accepted

**Agent movement enters through `schedules.ts`.** Already noted as the natural seam, and §2.2 is
why: it hands a path to the mover, and `startEntityStep` does the reservation. An agent that wants
to move produces a destination tile; it never writes a position.

**No diagonals, and no sub-tile retargeting.** An agent cannot change course mid-tile. At the
shipped `stepMs = 160` that bounds retarget latency at 160 ms, which is below the agent loop's own
cadence by three orders of magnitude and so costs nothing in practice.

**The player's mid-move lock is not extended to agents.**
`throw new Error('Player is moving; advance simulation first')` (`world.ts:711`) is an
input-validation rule for a synchronous command queue. Agents queue a `path` and are stepped by
`startEntityStep`, so they need no equivalent.

**Speed must be reconciled in content, not code.** 160 ms/tile against 0.75 tiles/s is an 8.3× gap
(§2.1). Whichever number wins, the 20× clock compression in §3 multiplies it, so this lands with §3
rather than here.

### 2.9 The map is the init side's, and the agentic world has none

This chapter was written as though two coordinate systems had to be reconciled. They do not. **The
26 authored scenes are the ground; the agentic world places its entities on anchors those scenes
define and owns no map at all.** Everything below follows from that, and most of it is subtraction.

**What the constraint deletes outright.** The engine's mover is retired rather than converted.
`findRoute`, `tickPathfinding`, `tickPosition`, `COLLISION_THRESHOLD`, `PATHFINDING_BACKOFF` and
`movementSpeed` have no ground to walk on once the ground is a scene, so §2.2's second part and
§2.6's three takes stop being ports into the engine and become ports into `npcPath`. `data/gentle`
stops being the agentic world's ground; `createAgenticWorld`'s `staticCollision()` and
`mapContext()` go with it.

**Scene-keyed registry, not one world per scene.** `MemoryWorld` already answers this: `State` holds
every scene's actors in one flat map, each labelled with `sceneId`, every scene ticks, and actors
cross between them mid-tick (`world.ts:1254`). The engine's own ownership forbids the other answer —
`World` holds `nextId`, `seed`, `rng` and `worldStateVersion` (`world.ts:37-44`), and 26 Games would
mean 26 PRNG streams from one authored seed and 26 version counters for a `__world__` whose §4 fold
assumes one chain.

The label is cheaper than it sounds, and where it is expensive it is an artifact: `sceneId` and
`position` are siblings today, so occupancy reads `e.sceneId === X && e.position[0] === x`. §2.2's
first part is the fix — the scene is a component of the address, and comparison helpers carry it —
after which the label appears only where places are compared, and inputs, conversations, memory and
the prompt layer never mention it.

**One writer for a position, and the second writer was the engine's own tick.** `EntityState` owns
position: the ground, the reservation, the renderer and the recording are all on that side. The
duplicate writer is not the agent deciding twice — it is `game.tick` running `tickPosition` over
every `Player` unconditionally (`game.ts:203-205`), because an agentic actor _is_ a `Player` +
`Agent` pair (`entityInputs.ts:76-100`). `Player` is the body and `human` is an optional token on
it; in the merged world the person plays `draft.player`, so every engine `Player` is an agent body
and the mover is deleted rather than gated.

**A conversation is what arrival produces.** The two approach paths were inverted: an approach to a
prop fired `agentInteract` on arrival, while an approach to an actor called `Conversation.start` at
decision time and let the conversation walk the pair together. Now both end on arrival.
`Conversation.start` refuses at range, membership has one state, and `Conversation.tick` is gone —
with it the `invited`/`walkingOver` machine, `INVITE_TIMEOUT`, `MIDPOINT_THRESHOLD`, the midpoint
chase and the seating nudge. The typing lock expires on read instead of on a tick, which is also the
stronger shape: a lock cannot outlive a model call that died holding it.

Two costs, accepted. **Invitation stops existing before the walk** — a refusal now happens at
arrival or in the conversation's first turn, which is more legible and is still a behaviour change.
And **two actors arriving at each other in the same tick both try to start**; lowest id wins, which
is §2.7's tiebreak and settles with it.

What this buys is not tidiness. With the actor path flipped there is no engine-issued destination
left anywhere, so "the engine never writes a position" stops being a rule to enforce and becomes
true because nothing remains that would.

### 2.10 What is unblocked now

| #   | work                                                                            | state                                                                                                       |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A   | `Scene` → `MapContext` / `CollisionLayer` / `WorldMap` adapter                  | **landed** (`src/sim/sceneMap.ts`). Checked against every tile of all 26 scenes                             |
| B   | anchors accept `[x, y, w, h]` beside `[x, y]`                                   | **landed**. Rides inside the array, so no reader changed                                                    |
| C   | `scene` on a world-file entity; scene-keyed `MapContext`; scene-keyed occupancy | **landed**. Anchor errors name the scene                                                                    |
| D   | `npcPath` partial paths and a search budget; `approachTiles`; `nearestFreeTile` | **landed**. `partial` is opt-in: `loadContent` uses a null return to mean "unroutable" at authoring time    |
| E   | `scene` on `Entity` and `Player`; the map derived and never persisted           | **landed**. The map left `GameStateDiff`; it is content the client already holds                            |
| F   | conversation on arrival; `Conversation.tick` deleted                            | **landed**                                                                                                  |
| G   | `reconcileEntities`: a save is brought up to its content rather than refused    | **landed**. `validateEntities`' two checks survive as post-conditions                                       |
| H   | `story.sprites` and `placedAppearance`                                          | **landed**. An unresolvable sprite draws nothing rather than something wrong                                |
| I   | delete the engine mover                                                         | waits on the init-side seam below, or the agentic world stops moving                                        |
| J   | the placement pass: world-file entity + scene anchor → `EntityState`            | must live inside `initialEntities`: `validateEntities` is exact, so nothing may be created at runtime       |
| K   | an agent destination as a `MemoryWorld` command                                 | the last seam. `execute()` is a whitelist matching exact key sets, so it lands in the input log and replays |
| L   | the scene as a component of the address, with comparison helpers                | wants I done first, so the bundling is not spent on code about to be deleted                                |

**What `moveEntity` settles, beyond moving something.** A destination rather than a path is what
keeps routing in the only place that knows the scene — an agent that had to hand over a path would
need the collision map, and a path computed a tick ago replays into a wall. Three things follow.
Agent movement is in the input log, so a run driven by agents replays for the first time. Arrival
stops being something the engine polls by distance and becomes what the init world already answers —
`nearby()`, on the tile grid the content was authored against. And retry is free, because
`advanceState` re-attempts every entity's step every tick, which is what narrows §2.7.

**One thing J changes that is worth knowing before it lands.** A recording embeds its own content
(`replay.ts:89`), so editing scenes has never invalidated a save — the save keeps playing the old
content. Reconciliation only does anything once something loads a save against the _current_
package, and that path does not exist yet. Which content wins is a decision, not an oversight.

---

## 3. Time: fast-forward, idle pause, cadence

### 3.1 The conflict is three clocks, not two

The chapter was stated as one question about fast-forward. Read against the code it is a question
about how many clocks there are, and the answer is three — plus a wall clock that leaks into two of
them.

| clock                        | unit and origin                                                          | advanced by                                                                               | read by                                                                           |
| ---------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `draft.time`                 | simulation ms, starts at **0** (`prototype/world.ts:357`)                | `world.step(ms)` from the frame quantum, plus `waitUntil` jumps                           | movement `arrivesAt`, `startEntityStep`, `schedules`                              |
| `AgenticRuntime.currentTime` | game ms, starts at **`Date.now()`** (`src/sim/createAgenticWorld.ts:83`) | `advance(quantum)` — the same quantum, one call site (`src/components/LocalGame.tsx:580`) | every engine tick and every agentic timeout                                       |
| `draft.storyTime`            | fiction **seconds**, starts at 18:00                                     | `advanceStoryClock`, a 600s jump per 30 real s (`prototype/world.ts:1268-1288`)           | schedules, restocks, `balance`                                                    |
| wall clock                   | `Date.now()`                                                             | —                                                                                         | `agent/operations.ts:124,129`, `agent/conversation.ts:101`, `agent/memory.ts:160` |

Rows one and two share a unit and a rate source but **not an origin**, so they are two counters kept
in step by one line of `LocalGame` rather than one tick. Row three is not a tick: nothing under
`agent/` or `src/sim/` reads `storyTime` at all. The fourth row is not a clock the world owns, and
§3.5 is about it.

Three findings decide the rest of the chapter.

**`storyTime` is not a function of `draft.time`.** Two worlds at the same `draft.time` hold
different `storyTime`:

```
X  { time: 60000, storyTime: 66000, elapsedMs: 0     }   // waited to +600s
Y  { time: 60000, storyTime: 65407, elapsedMs: 29650 }   // waited to +607s
```

Four things break the mapping, independently:

| #   | where                                  | what it does                                                                                                                                                                                                          |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `waitUntil` (`prototype/world.ts:885`) | sets `elapsedMs = 0` while `draft.time` is off a period boundary, converting the sub-period carry to `storyTime` at 1s granularity. The phase is lost permanently — a 7-second residue injected once never reconciles |
| 2   | `advanceStoryTime` (`:690`)            | `storyTime += n`, `draft.time` unchanged                                                                                                                                                                              |
| 3   | `nextScene` (`:707`)                   | `storyTime += 3600`, `draft.time` unchanged                                                                                                                                                                           |
| 4   | `setClockSpeed` (`:681-686`)           | the **rate itself** is mutable at runtime; it rescales `elapsedMs`, not `draft.time`                                                                                                                                  |

**The recording already carries state per event, not commands.** Every event embeds the full encoded
state (`prototype/world.ts:1298-1302`), `player` and `storyTime` included; on disk it is
delta-encoded with `finalState` kept whole (`src/lib/recordingStorage.ts:33-50`). So a reload reads
`storyTime` the same way it reads the player's position, and "what was the fiction time at event N"
is a field read in memory and a delta fold from disk — never a re-simulation.

**The agentic clock cannot be fast-forwarded.** `runTicks` caps at `maxTicksPerStep = 600` ×
`tickDuration = 16`, then `advance` assigns `currentTime = result.currentTs` and discards the
remainder with no error and no return value. Measured: a 604,800,000 ms advance moves the clock
**9,616 ms**.

### 3.2 The decision

**`draft.time` is the single timestamp and belongs to the engine. `storyTime` is stored state that
rides beside it and belongs to the fiction. Neither is derived from the other.**

1. **One stamp.** Every input and every state shift carries `draft.time`. The agentic runtime's
   clock becomes that same counter rather than a parallel one seeded from `Date.now()`.
2. **`storyTime` stays stored**, persisted and stamped per event exactly as the player's position
   is. §2.2's derive-and-never-store rule does **not** extend to it; §3.3 says why.
3. **`draft.time` is the engine's clock and narrative never moves it.** A character waiting costs
   it; an author cutting does not. What changes instead is that fiction-keyed deadlines move to
   `storyTime`, where they belong (§3.4).
4. **Wall time is written to the log and never read** by the simulation or by a prompt (§3.5).
5. **Idle pause stays, stops everything, and gets a longer fuse** (§3.6).
6. **20× stands.** What changes is that the agentic constants are re-expressed against it (§3.7).

### 3.3 Why `storyTime` is stored, and where §0 stands

§0 is nearly silent here, as it was in §2 — a clock is not a thing a natural-language premise has an
opinion about. It speaks once, in §3.4, and only about whether agents experience a jump.

The tempting move is §2.2's: make `storyTime` a view function of `draft.time` and store nothing. It
is available — `rate` mode already is that function, and is verifiably path-independent (one 60s
step and 600 × 100 ms land on identical state). It would delete `state.clock`, `elapsedMs`, its
validator and breaker #4 in one stroke.

**It is rejected, because the property it buys is already bought.** Derivation would give locality —
fiction time computable from a stamp with no fold. The recording already gives that, per event, by
storing the state. Paying for it a second time in deleted features is a bad trade, and the features
are not nothing: `setClockSpeed` is a dev-console affordance (`ROADMAP.md:86`), the 10-minute
quantum is the readout the "remaining time" premise is built on, and `idlePauseSeconds` is rejected
by the content validator outside batch mode (`prototype/content.ts:246`).

There is also a precedent, and it is the agentic side's own. `LoggedEvent` keeps `gameTime` **and**
`wallTime` with the reason stated in place: _"Both clocks are kept, because neither is
reconstructible from the other later"_ (`src/sim/agenticRuntime.ts:39-45`). That is this codebase
already deciding, in this exact situation, to store a non-derivable clock per event instead of
deriving it. §3.2's second part is that decision applied once more.

**So `storyTime` becomes a third stamp on the agentic log**, beside `gameTime` and `wallTime`. One
integer per event, no semantic change to any command, and every reader — the prompt builder, the
backend, a log tool — converts a stamp to "second day, evening" without a fold.

The four breakers of §3.1 then need no fixing _as breakers_: nothing derives `storyTime`, so nothing
can be broken by the mapping not being pure. #2 and #3 turn out not to be breakage at all — §3.4 —
and #1 and #4 are tidiness, handled by §3.10 item B.

### 3.4 Waiting is lived through; a cut is not

The code already draws this line, and the first draft of this chapter erased it. Measured:

| command                          | `draft.time` | `storyTime` | `balance` |
| -------------------------------- | ------------ | ----------- | --------- |
| `waitUntil` 1h (bed, wait panel) | +180,000 ms  | +3,600 s    | −3,600    |
| `advanceStoryTime` 1h            | 0            | +3,600 s    | 0         |
| `nextScene`                      | 0            | +3,600 s    | 0         |

That is not an inconsistency. It is the diegetic/extradiegetic split: `waitUntil` is a character
waiting, and it costs simulation time and life. `advanceStoryTime` and `nextScene` are an author
cutting. Making cuts pay `draft.time` — as this chapter first proposed — collapses the two and
deletes the author's only way to skip.

**So `draft.time` is the engine's clock, and narrative never moves it.** It is monotonic, it orders
every event, and it is the key for everything the engine owns: movement `arrivesAt`, agent cadence,
the timeouts of §3.7. `storyTime` is the fiction's clock: stored, stamped, and the only clock a
model is ever told about.

**The argument that decides it is about the stories not yet written.** Coupling `draft.time` to
`storyTime` makes the engine's monotonicity a constraint on fiction — no story could move its clock
backwards, because `draft.time` cannot. Today's validators forbid backwards motion anyway
(`advanceStoryTime` is forward-only, 1–604,800 s), but that is a content rule and it should stay
one. A flashback, a framing device, a story that opens _in medias res_ and fills in earlier: none of
these are things a simulation clock should have an opinion about. §0 is about ownership, and the
engine owning whether fiction may run backwards is the engine owning too much.

**What already crosses a cut, corrected.** An earlier draft of this section claimed a cut left NPC
schedules behind while restocks fired, and called that the real bug. **That was wrong**, and the
correction is worth more than the claim was: `execute` runs the schedule pass after _every_ command
(`prototype/world.ts:813`, the end of the dispatch block), not only from `advanceState`. So a
fiction-keyed deadline already fires on a cut, and the keying is already right:

| deadline                   | keyed to                              | crosses a cut |
| -------------------------- | ------------------------------------- | ------------- |
| shop restocks              | `storyTime`, in `advanceStoryClock`   | yes           |
| NPC `sleepAt`/`wakeAt`     | `storyTime`, via `npcResting`         | yes           |
| `activateTasks`            | world `vars`, run after every command | yes           |
| movement `arrivesAt`       | `draft.time`                          | **no**        |
| agent cadence, god batches | `draft.time`                          | **no**        |

The two that do not cross are exactly the two that should not, under this section's decision: they
are the simulation living, and a cut is the author declining to simulate. Nothing here needs fixing,
and `tests/engine/storyClock.test.ts` pins it — a cut and three hours of living reach the same
schedule phase. The one genuine gap is the next paragraph's.

**What a cut costs, and how that is paid.** Across a cut no agent thinks and no god batch forms, so
every state document is an hour stale in fiction with nothing in the log saying why. That is real,
and simulating the hour is the wrong fix: it invents an hour of events the story did not have. The
right fix is to tell the world a cut happened — an event the next god write is asked to incorporate.
That is exactly §5's mechanism, and it is the second case for it.

**Balance.** A cut is free life and a wait is not. Left as it is: an author's cut should not bill
the player. Worth stating because it is now a rule rather than an accident — `nextScene` is the
cheapest hour in the game, and content that reached for it as a wait would be exploiting that.

**The scale, corrected — for waits, which do cost.** This chapter previously read `waitUntil`'s
seven-day bound as seven days of world to simulate. That is seven days of `storyTime`. In
`draft.time` — the unit the agentic clock shares — 20× compression makes it a twentieth of that:

| wait                    | `storyTime` | `draft.time`          | `GOD_INTERVAL`s crossed |
| ----------------------- | ----------- | --------------------- | ----------------------- |
| one night's sleep (6h)  | 21,600 s    | 1,080,000 ms = 18 min | 36                      |
| the `waitUntil` maximum | 604,800 s   | 30,240,000 ms = 8.4 h | 1,008                   |

A night's sleep is 36 god batches, not a week of agent life. That makes a long wait a budget
decision rather than an impossibility — and the budget is `11` §4.4's, since the client pays it.

It still cannot be spelled as one `advance` call. 1,080,000 ms is ~113 calls at the 9,616 ms
ceiling, and a single call would silently simulate 9.6 s and drop the rest. **`advance` must loop or
throw; it must not clamp in silence.**

### 3.5 Wall time is written and never read

Two uses of `Date.now()` are being conflated, and only one is a leak.

**Not a leak: `LoggedEvent.wallTime`.** It answers when something happened in the real world — how
long a session ran, when a crash landed, how a run lines up with a model provider's logs. It is the
one clock genuinely not reconstructible from the others, which is why `11` §6.1 keeps it. Keep it,
and add `storyTime` beside it rather than in place of it.

**A leak: every wall-clock read inside `agent/`.**

| site                            | what it does                                                                                         | why it is wrong                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/operations.ts:129`       | `timestamp: Date.now()` → `conversation.lastMessage.timestamp` (`engine/aiTown/conversation.ts:322`) | compared against game-time `now` in `engine/aiTown/agent.ts:208,214`. Two clocks in one subtraction. It works today only because the agentic epoch _is_ `Date.now()` and its rate _is_ 1:1 — both accidents this chapter removes |
| `agent/operations.ts:124`       | `createdAt: Date.now()` on the stored message                                                        | a message's time in the world is fiction time                                                                                                                                                                                    |
| `agent/conversation.ts:101,113` | tells the model the time                                                                             | `now` is a **number**, so `now.toLocaleString()` renders `"1,790,208,000,000"`. The one place the model is told what time it is, it is told an integer                                                                           |
| `agent/memory.ts:160`           | recency decays at `0.99 ** hoursSinceAccess` in wall hours                                           | at 20×, a memory from an hour ago in the fiction is three real minutes old and the decay never fires                                                                                                                             |

**The rule, stated once because it is what makes one stamp work:** wall time may be written to the
log and may never be read by the simulation, by a gate, or by a prompt. Anything an agent is told
about time is `storyTime`; anything the engine subtracts is `draft.time`.

`agent/conversation.ts:113` is the fix worth doing first — it is one line, it needs no other
decision, and until it lands every conversation prompt carries a nonsense clock.

### 3.6 Idle pause

`idlePauseSeconds: 60` stops the loop after a minute without input
(`src/components/LocalGame.tsx:570-574`, `:634`). A world meant to keep thinking while the player
reads a dialogue box will not.

**It stays, it stops everything, and 60 seconds becomes a few minutes.** The reasoning is forced by
§3.2's first part: with one clock there is no pausing one world and not the other, and `11` §4.4
says the client drives the bill — so an afternoon away from the keyboard must eventually stop agents
too, not only the player. What is wrong with the shipped value is its length, not its existence: 60
s is tuned for a world where nothing happened without input.

Resuming is already correct and must stay so. The loop consumes elapsed real time before deciding
whether to simulate it, so the gap is discarded rather than replayed — `11` §4.5's invariant, with a
test at `src/sim/agenticRuntime.test.ts:48`.

One format wrinkle: `idlePauseSeconds` is accepted only alongside the batch clock
(`prototype/content.ts:246`), so it rides on a clock shape it has nothing to do with. Move it to a
top-level story field.

### 3.7 Cadence, and the speed question §2.8 deferred

**20× stands.** It is the shipped content's assumption, `balance` is denominated in it, and nothing
found here argues against it. What was never done is expressing the agentic constants in it. At 50
ms of `draft.time` per story-second, `engine/constants.ts` reads:

| constant                                                    | game ms | in fiction |
| ----------------------------------------------------------- | ------- | ---------- |
| `MIN_DECISION_INTERVAL`                                     | 5,000   | 1m 40s     |
| `CONVERSATION_COOLDOWN`                                     | 15,000  | 5 min      |
| `GOD_INTERVAL`                                              | 30,000  | 10 min     |
| `AWKWARD_CONVERSATION_TIMEOUT`                              | 60,000  | 20 min     |
| `INVITE_TIMEOUT`, `APPROACH_TIMEOUT`, `PATHFINDING_TIMEOUT` | 60,000  | 20 min     |
| `PLAYER_CONVERSATION_COOLDOWN`                              | 60,000  | 20 min     |
| `ACTION_TIMEOUT`                                            | 120,000 | 40 min     |
| `MAX_CONVERSATION_DURATION`                                 | 600,000 | **3h 20m** |

A conversation that feels like ten minutes to the player consumes a third of the character's day and
drains `balance` accordingly. These are not prompt problems and no conversion fixes them: each
constant has to be chosen against the clock it is meant to be _felt_ in. `MAX_CONVERSATION_DURATION`
and `ACTION_TIMEOUT` are the two that cannot ship as they are.

`GOD_INTERVAL = 30_000` happens to equal exactly one story-clock tick (`realSecondsPerTick: 30`).
Make that deliberate or note it; a coincidence this load-bearing should not stay one.

**§2.8's deferred speed question, decided here.** The gap is 8.3× — 160 ms/tile against 0.75 tiles/s
(§2.1) — and 20× multiplies whichever survives. Crossing a 64-tile map (`prototype/content.ts:450`):

| mover                           | `draft.time` | in fiction  |
| ------------------------------- | ------------ | ----------- |
| init side, `stepMs = 160`       | 10,240 ms    | 3m 25s      |
| `engine/aiTown`, `0.75` tiles/s | 85,333 ms    | **28m 27s** |

**The init side's 160 ms/tile wins**, and `movementSpeed` becomes 6.25 tiles/s. In a game whose
currency is time, half a story-hour to cross one map is not a tuning value, it is a different game.
The 26 shipped scenes were drawn against the faster mover, per §2.7.

### 3.8 Recorded cost: what the derived clock would have bought

Not a §0 deviation — §3.3 — but recorded on the same principle.

Deriving `storyTime` from `draft.time` would have made the mapping pure **by construction rather
than by discipline**. What is kept instead is four stored quantities that must be maintained in
agreement: `draft.time`, `storyTime`, `elapsedMs` and the mutable `realSecondsPerTick`. There is no
invariant test that catches them drifting, and breaker #1 is exactly that drift — a 7-second residue
that no later code reconciles.

The mitigation is narrow and worth naming: **`storyTime` has one writer, `advanceStoryClock`, and
every path that moves time goes through it.** `waitUntil` today does not — it computes story-second
targets itself while calling `advanceState` with `runClock = false` (`prototype/world.ts:889-902`) —
and that is precisely where breaker #1 lives. Routing it back through the one writer is §3.9 item B.

A latent form of the same defect: `waitUntil` ignores `rate` entirely. Its `period`/`quantum`
default to 1000/1 when there is no `draft.clock` (`prototype/world.ts:876-878`), so under `rate`
mode waiting costs 1,000 ms of `draft.time` per story-second while living it costs `1000/rate` — a
20× divergence at the shipped rate. No shipped content uses `rate` mode, so this bites nobody today.
It is a trap for whoever switches.

### 3.9 Consequences accepted

**A long wait is a real cost.** 36 god batches for a night's sleep, paid by the client (`11` §4.4).
This is not new — `waitUntil` already advances `draft.time` by the full span — but it is newly
expensive, because until now nothing was thinking while it did. What it does _not_ cost is
correctness on the document: §4.2 makes a write a patch and §4.3 folds at read, so 36 batches of
agent and god writes landing across one wait merge line by line rather than racing. A wait is
expensive, not dangerous.

**A cut is invisible to the agents until §5 lands.** `advanceStoryTime` and `nextScene` move the
fiction forward with nobody experiencing it, and nothing today tells the world that happened. §3.4
names the fix and it is not in this chapter's gift. Until then, content that cuts is content whose
agents quietly believe time passed without remembering any of it.

**Replay cost grows with waits.** A six-hour sleep is 1,080,000 ms of `draft.time` that replay walks
through. `waitUntil`'s 200,000-step bound (`prototype/world.ts:891`) exists for exactly this and is
now load-bearing rather than defensive.

**One clock means one pause.** §3.6 accepts that a player reading a long dialogue eventually stops
the agents too. A world that thinks while nobody watches is a separate decision, and it is `10` M3,
answered there by `11` §8.

### 3.10 What is unblocked now

| #   | work                                                                                                                           | why it can start                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | `agent/conversation.ts:113` — tell the model a real time                                                                       | one line; the prompt currently carries `"1,790,208,000,000"`. Needs nothing from this chapter                                                                            |
| B   | one `msPerStorySecond` behind `gameTime()`, `npcResting` and `waitUntil` — **done**; the carry reset (breaker #1) **deferred** | the rate-mode trap is free to fix: no shipped content uses `rate`, so no recording exercises it. Breaker #1 is not free — see below                                      |
| C   | `advance` loops or throws instead of clamping at 9,616 ms                                                                      | a silent 99.998% drop is a §1.6-class bug whichever fast-forward policy wins                                                                                             |
| D   | seed `AgenticRuntime.currentTime` from `draft.time`; replace the `Date.now()` payload stamps in `agent/operations.ts`          | §3.2 item 1 and §3.5. Independent of §4 and §5                                                                                                                           |
| E   | add `storyTime` to `LoggedEvent` beside `gameTime` and `wallTime`                                                              | §3.3. Additive; nothing reads it yet                                                                                                                                     |
| F   | move `idlePauseSeconds` out of the clock block, lengthen the fuse                                                              | content-format work only, both spellings accepted as in §1.8 item E                                                                                                      |
| G   | re-express `MAX_CONVERSATION_DURATION` and `ACTION_TIMEOUT` against the story clock                                            | §3.7; a content decision needing no code beyond the constants                                                                                                            |
| H   | ~~fire NPC `sleepAt`/`wakeAt` from `advanceStoryClock`~~ — **withdrawn**                                                       | the premise was wrong: `execute` already runs the schedule pass after every command. §3.4 is corrected, and `tests/engine/storyClock.test.ts` pins the behaviour instead |

**Breaker #1 cannot ride along with B, and this is why.** `replay.step()` throws `Replay diverged`
on any mismatch between the recomputed state and the recorded one (`prototype/replay.ts:254`), and
every recorded event embeds its state (§3.1). So changing `waitUntil`'s arithmetic under the
_shipped_ clock invalidates every saved run containing a sleep. The `msPerStorySecond` refactor is
arithmetically identical for the batch clock and for a world with no story clock — which is what
made it shippable — and differs only under `rate`, which no content uses. Breaker #1's carry reset
is a real change to a real path, it is tidiness rather than correctness (§3.3), and it costs save
compatibility: it needs a recording-format version gate, and that is a bigger decision than the
defect warrants.

**A and D are the ones not to skip.** Until D lands, `conversation.lastMessage.timestamp` is a wall
clock being subtracted from game time (`engine/aiTown/agent.ts:208,214`), and it produces plausible
answers only by the coincidence this chapter removes. Landing §3.2 item 1 without D turns a hidden
inconsistency into a visible one.

Blocked, and left alone: whether a `failed` task can be produced by a clock deadline rather than by
an actor, which is §5's question and the last one in this document.

### 3.11 A disposition in `10` that no longer holds

`10` §6.6 lists `setClockSpeed`, `waitUntil` and `advanceStoryTime` as **"retired by §3"** — its own
§3, which decided _"the backend is the sole driver of the time system"_ and gave up
frontend-initiated pause, speed and wait as a consequence (`10` §3, `:147`).

`11` reverses that premise: the frontend is authoritative and the backend never simulates (`11` §1,
§4.1). The three commands are therefore **not** retired, and this chapter is where they are decided
instead. Recorded here so the contradiction is found on purpose rather than tripped over.

`10` M2 and `11` F4 — "is 20× still right when agents drive the world" — are answered by §3.7: yes
for the clock, no for the constants measured against it. `11` F3 — block on a pending decision, or
act late — stays open and is sharpened by §3.1's third finding: acting late is the only option that
does not require `advance` to be re-entrant.

---

## 4. Write authority on world state

### 4.1 The conflict

`engine/aiTown/entityInputs.ts:31-32` threw if anything but the god wrote `__world__`. §1 requires
agents to write it on the main path — an agent grants an item, or moves a task on, in the
conversation where it happens — so that restriction lifts (§1.8 item F). What it opens: two classes
of writer on one document, versioned by a single counter, with no merge and last-write-wins.

The forcing case is scale. A world with fifty tasks, and an agent that cares about one of them:

```
<tasks>
task_42 = ask_ash
</tasks>
```

Under whole-document semantics that write asserts the other forty-nine no longer exist. Under
whole-document semantics done _correctly_, the agent restates all fifty every time it changes one —
tokens per turn, and a fresh chance to mangle a line on each restatement. §1.4's preservation rule
is what fights that, and at fifty lines it is fighting a losing battle. Replace does not scale.

### 4.2 The decision

**A write is a patch. What everything reads is the fold of every patch so far.** The rule is per
part, and it falls out of what can be keyed:

| part               | a write that contains it | a write that omits it |
| ------------------ | ------------------------ | --------------------- |
| head-state + prose | replaced whole           | kept                  |
| `<tasks>`          | merged line by line      | kept                  |
| `<player_items>`   | merged line by line      | kept                  |

Three things follow, and they are the argument.

**The merge is total without a tombstone vocabulary.** Both blocks have a natural absorbing value:
`<player_items>` says a thing is gone by writing it `= 0`, and a task line is never removed at all,
because the set of tasks is authored and fixed (§1.2). So **leaving a line out never removes it** —
one rule, no exceptions, and the destructive reading is simply not sayable. An empty block is a
no-op for the same reason: asserting emptiness is exactly the operation the merge exists to make
unsayable.

**One semantics for every writer.** The alternative was writer-typed — god replaces, agents patch —
and it is wrong in both directions: the god also usually wants to fix one line, and correctness that
depends on provenance breaks the moment a third writer appears. So the god's contract changes too:
it is told it is no longer the only writer, that what it sends is merged, and to send only what it
is changing.

**The division of labour falls out of the mechanism rather than being decreed.** The paragraph has
no keys, so it cannot merge; the blocks do, so they can. Agents patch blocks, the god owns the
paragraph, and a write that omits the paragraph leaves it alone — which answers "whether each part
has one writer or several" without a rule anybody has to remember.

### 4.3 Why the fold runs at read

Three places could hold the merge, and two of them are worse:

| where                           | replay | lost updates                           | cost                           |
| ------------------------------- | ------ | -------------------------------------- | ------------------------------ |
| in the agent, before submitting | fine   | **yes** — two agents read v7, one wins | none                           |
| in the input handler            | fine   | no                                     | breaks the §5.3 prose boundary |
| at read, folding the chain      | exact  | no                                     | the document becomes derived   |

The first throws away the only thing patches are worth doing for: read-modify-write in the agent
reintroduces exactly the lost update this chapter exists to remove.

The second is the intuitive home and it cannot reach the data. `applyWorldStateUpdate`
(`engine/aiTown/entityInputs.ts:348-362`) receives `write.state` and queues it; the engine has no
read access to the prose tier at all, because docs/05 §5.3 deliberately keeps prose out of the world
document — the world holds the version integer and nothing else. Merging there means handing the
engine a prose read, which is a larger change than it sounds and undoes a boundary that is load-
bearing for §1.7's replay note.

The third fits what is already built. The store keeps **every** version, sorted and idempotent by
the version the input handler allocated (`agent/store/memoryStore.ts:146-153`);
`readEntityStateSync` merely took the last. Folding there makes patches commute by construction —
two agents touching different lines cannot lose each other's write, with no read-modify-write
anywhere — and replay is exact because the log is the source rather than a derived snapshot.

It is done inside the store rather than at each call site, so "the document" stays one thing: the
god's prompt, an agent's prompt and the client ask the same question and get the same answer, and
none of them knows the storage is a chain.

### 4.4 Recorded cost: the document is no longer something a model wrote

Not a §0 deviation — §4.3 is an engineering choice — but recorded on the same principle.

What is stored is a chain of patches; what anything reads is this function's assembly of them. Two
consequences worth having written down:

- **A conformance record now describes a patch, not a state.** `stateAudit.tags` asks "did the
  writer follow the shape", and under patches the honest answer is about the fragment that was sent.
  A run's drift query has to read it that way.
- **Time travel gets cheaper and "what did the model say" gets dearer.** Reconstructing the document
  at version N is a fold of the first N patches, which is exact. Asking what any one writer believed
  the whole document to be is no longer answerable, because no writer ever said.

### 4.5 The failure this creates, and the guard for it

Merge converts a loud failure into a silent one, and this is the part to watch.

A misspelled task id under **replace** was loud: the real line vanished with it, and §1.6's guard
rendered the task as unknown on the board. Under **merge** it is inert. The old line survives
untouched, the misspelling lands as a row nothing reads — the reader looks up by authored id and
never enumerates the block — and the task holds its previous step for the rest of the run with no
signal anywhere.

So the reader enumerates the block once, for exactly this: `unknownKeys` (`src/sim/taskStatus.ts`)
reports every key matching no authored task, and the §1.8 D oracle logs it more loudly than a
disagreement, because it is worse than one. The contract carries the same warning in the writer's
direction: _"A name you invent does not correct the old line; it adds a line that nothing reads, and
the old line stands."_

This is the same shape as §1.6's mitigation and it is not optional either. Prose owning a value
never licenses losing it (§0), and a value that is silently stale is lost.

### 4.6 Consequences accepted

**A stale line outlives the writer that made it.** Nothing expires a record line, and the fold never
forgets one. That is the price of "leaving a line out never removes it", and it is the right price
while the alternative is a writer that can clear the record by accident.

**Two writers on the same line is still last-write-wins.** Merge narrows the conflict from the
document to the line; it does not resolve a real disagreement about one line. That is a genuine
conflict rather than an artefact of the storage shape, and it is left to be one.

**Batch boundaries no longer need a rule.** An agent write and a god intervention crossing the same
boundary were the hard case under whole-document semantics. Under §4.2 they commute unless they
touch the same line, so the question dissolves rather than being answered.

**The fold is cached, and the cache is invalidated on append rather than keyed on the newest
version.** A replayed write can land _before_ the newest version — `appendEntityState` sorts — which
would change the fold without changing the version it folds through.

---

## 5. Code-driven state change

**Open.** Nothing decided.

Some state changes have no author. `activateTasks` runs every tick and every command, flipping a
task to activated from a `vars` condition with nobody acting (`prototype/world.ts:1066-1072`).
`advanceStoryClock` fires game-time deadlines. Nothing today produces a `failed` task, but the clock
that would drive one is already running and draining `balance`.

Under §1 these have to reach a document a model authored. Read-only prose cannot express them;
parse-then-rewrite puts a regex edit of model output inside `advanceState`, which is synchronous and
replayed, and races §4's writers.

To decide: whether deterministic code writes prose at all, or instead emits an event that the next
model write is asked to incorporate — trading immediacy for keeping one writer per document.

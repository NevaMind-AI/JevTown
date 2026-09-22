# World Description Format — Specification v2

`format_version: 2.0`

Supersedes `01-world-format-spec.md`, which is retained unchanged as the 1.0 reference.
Read `02-design-rationale.md` for *why* the underlying ideas exist; this document only
justifies what changed. §13 lists every difference from 1.0 and the mechanical migration.

**Scope note.** This revision is deliberately reduced to what the first demo needs. Three
features from the 2.0 draft — the rule system, `spawn` / `despawn`, and `emit_event` — are
**deferred**, and §14 records each one's grammar, what it cost to remove, and when to bring
it back. All three are **purely additive** to the schema: reintroducing them adds optional
keys and effect ops and invalidates nothing, so world files authored against this document
stay valid and need no `format_version` bump.

A **world file** is a single JSON document that fully defines a playable world: its
variables, its entities, its story episodes, and its scripted dialogue. The engine
contains **no world-specific code**. Swapping worlds means swapping this file.

Map *geometry* remains out of scope and owned by the map system. Map-placed **entities**
are now in scope — see §6.4.

---

## 1. Top-level structure

```json
{
  "format_version": "2.0",
  "meta":      { },
  "vars":      { },
  "entities":  [ ],
  "episodes":  [ ],
  "scripts":   { }
}
```

| Key | Required | Meaning |
|---|---|---|
| `format_version` | yes | Schema version. The loader refuses files it cannot migrate. |
| `meta` | yes | Human/agent metadata: `id`, `title`, `description`, `authored_by`, `seed`. |
| `vars` | yes | Declaration of every authored variable. Undeclared variables are a load error. |
| `entities` | yes | Everything in the world that is not the map itself or a human player. Replaces `npcs` + `objects`. |
| `episodes` | yes | Ordered story episodes, and the deltas and conditions that shift between them. |
| `scripts` | no | Bodies of scripted dialogue, referenced by `script_ref`. |

`meta.seed` seeds the simulation PRNG. Two runs of the same world file with the same seed
and the same input log produce byte-identical results.

---

## 2. Variable declarations (`vars`)

Unchanged from 1.0.

```json
"vars": {
  "trust_alice":  { "type": "int",  "init": 0, "min": 0, "max": 10, "scope": "player",
                    "doc": "How much Alice trusts the player." },
  "met_bob":      { "type": "bool", "init": false, "scope": "player" },
  "mill_burned":  { "type": "bool", "init": false, "scope": "world" },
  "allegiance":   { "type": "enum", "values": ["crown", "guild", "none"],
                    "init": "none", "scope": "player" }
}
```

| Field | Meaning |
|---|---|
| `type` | One of `bool`, `int`, `float`, `string`, `enum`. |
| `init` | Initial value. Must satisfy the declared type and bounds. |
| `min` / `max` | Optional, numeric types only. Writes are **clamped**, not rejected. |
| `values` | Required for `enum`. The closed set of legal values. |
| `doc` | Human/agent-facing description. Included in the generation prompt. |
| `scope` | `world` or `player`. Set it explicitly on every variable. |

`scope: "world"` — one value shared by everyone. `scope: "player"` — one value per human
player, resolved against the acting player. Getting this wrong is still the most likely
source of confusing story bugs.

With the rule system deferred (§14.1), `vars` carries **more** weight than it did in the
2.0 draft: it is now the only place ambient bookkeeping can live, since every effect must
hang off a state entry, a transition, or an interaction outcome.

---

## 3. The fact namespace

Conditions never read engine internals. They read a flat, stable namespace populated from
authored variables and a versioned engine adapter. This is the only coupling surface
between world files and the engine.

Each path carries a **write class**, which the loader uses to validate writes and which
the engine uses to decide what a write costs (§5.1).

| Path | Type | Write class | Meaning |
|---|---|---|---|
| `vars.<name>` | declared | `value` | Authored variables from §2. |
| `entity.<id>.state` | string | `transition` | Entity's current state id. |
| `episode.current` | string | `transition` | Current episode id. |
| `episode.elapsed_ms` | int | — | Time since the current episode was entered. |
| `world.elapsed_ms` | int | — | Time since world start. |
| `player.near.<entity_id>` | bool | — | Player is within interaction range of that entity. |
| `interaction.outcome` | string | — | **Scoped** — see §3.1. |
| `interaction.turns` | int | — | **Scoped** — turn count of the interaction just ended. |

A `—` write class means the path is read-only in conditions and cannot appear in a `set`
effect: the elapsed clocks and proximity are engine-derived.

**Every entity is always present.** There is no `entity.<id>.present` path in this
revision, because with `spawn` / `despawn` deferred (§14.2) nothing could write it and it
would trip the dead-condition check (§12, rule 22). It returns as a writable `value`-class
path when presence comes back.

Time-based conditions need no special syntax: `episode.elapsed_ms` is just another
readable fact.

### 3.1 Scoped facts

`interaction.*` is readable **only** inside transitions evaluated in the context of an
interaction that has just concluded. Referencing it anywhere else is a validation error.

### 3.2 Continuous vs. discrete facts

This split drives the whole evaluation strategy in §11 and should be understood before
writing conditions.

- **Discrete facts** change only when an effect writes them: `vars.*`,
  `entity.*.state`, `episode.current`.
- **Continuous facts** change on their own as the simulation advances:
  `*.elapsed_ms`, `player.near.*`.

A condition that reads only discrete facts is *event-driven and free*. A condition that
reads any continuous fact must be polled. Authors do not need to declare which; the loader
computes it and reports the polled set (§11.3).

`player.near.*` is retained even though its most natural consumer (rules) is deferred. The
engine already computes interaction range to decide whether the player *can* talk to an
entity, so exposing it costs nothing, and it is the only spatial trigger a transition has.

---

## 4. Condition grammar

Unchanged from 1.0. A condition is a tree. Composite nodes:

```json
{ "all":      [ <cond>, ... ] }
{ "any":      [ <cond>, ... ] }
{ "not":      <cond> }
{ "at_least": { "n": 2, "of": [ <cond>, ... ] } }
{ "always":   true }
```

The only leaf form:

```json
{ "var": "<fact path>", "op": "<operator>", "value": <literal> }
```

Operators — closed set: `==` `!=` `<` `<=` `>` `>=` `in` `not_in`.

`in` / `not_in` take an array literal on the right. Conditions perform **no arithmetic**,
so every condition stays statically analyzable — this is what makes §11 possible.

```json
{
  "all": [
    { "var": "vars.conv_intro_done", "op": "==", "value": true },
    { "any": [
        { "var": "vars.trust_alice",   "op": ">=", "value": 3 },
        { "var": "episode.elapsed_ms", "op": ">",  "value": 600000 }
    ]},
    { "not": { "var": "entity.bob.state", "op": "==", "value": "hostile" } }
  ]
}
```

`at_least` exists for non-linear progression: a player who wanders off should still be able
to advance by completing *some* of the available beats.

---

## 5. Effect vocabulary

Effects are the only way anything changes. The vocabulary is closed — freeform effects
(script strings, arbitrary state patches) are not permitted, because they would break
validation, agent-generation, and replay.

**Three operations.**

```json
{ "op": "set",  "path": "vars.trust_alice",   "value": 3 }
{ "op": "set",  "path": "entity.alice.state", "value": "panicked" }
{ "op": "set",  "path": "episode.current",    "value": "ep2_fire" }
{ "op": "inc",  "path": "vars.trust_alice",   "by": 1 }
{ "op": "move", "entity": "bob", "to": { "anchor": "town_square" } }
```

1.0's five separate assignment ops collapse into one `set` that takes a fact path.

`inc` stays separate from `set` because it is arithmetic: it has different bounds handling
(clamping against `min`/`max`) and applies only to numeric paths. `move` stays separate
because it is not an assignment — position is not in the fact namespace, so there is no
path to write.

`spawn`, `despawn`, and `emit_event` from the 2.0 draft are deferred; see §14.2 and §14.3.

### 5.1 Write classes: why `set` is one op with two meanings

Unifying the *syntax* is what makes §11 tractable — every effect is a write to a path,
every condition is a read of paths, so the dependency graph is a plain bipartite graph over
one namespace. But the two write classes are **not** semantically equal, and the format
keeps that visible rather than hiding it:

- **`value`** (`vars.*`) — a plain assignment. Type-checked against the variable's
  declaration; numeric values clamped to `min`/`max`. Two writes in one step are benign;
  last-write-wins.
- **`transition`** (`entity.*.state`, `episode.current`) — a **control-flow event**, not an
  assignment. It runs the old state's `on_exit`, then the new state's `on_enter`, and (for
  `episode.current`) re-applies the entity override layer. Value is checked against the
  target's declared state/episode ids *and* against the current episode's `disable_states`.

Two `transition`-class writes to the same path in one step means two cascades and is
almost always a bug. The loader **errors** on a statically provable one and the runtime
logs it; two `value`-class writes to one path is only a warning.

**Ordering.** Effects within one list apply in declaration order. Effects from different
transitions apply in the deterministic order defined in §7. Cascades from a `transition`
write run to completion before the next effect in the list is applied.

---

## 6. Entities

`npcs` and `objects` are merged into one `entities` array. Everything in the world that is
not the map itself or a human player is an entity: NPCs, interactable objects, and inert
decoration and barriers.

### 6.1 The `kind` discriminator

Exactly **one** new required field distinguishes the tiers: `kind`.

```json
{ "kind": "actor" | "prop" }
```

- **`actor`** — has a mobile body. Gets pathfinding, an agent loop, and `move`. Carries
  `character` (sprite from the character table) and `persona` (stable across all states,
  always included in agentic prompts).
- **`prop`** — pinned to an `anchor`. No pathfinding, no agent loop. Its collision
  footprint is static per state.

There is deliberately **no `interactable` field.** Interactivity is derived: an entity with
no `states` is inert, and a state with no `interaction` block cannot be interacted with in
that state. A redundant boolean is a second source of truth that can disagree with the
content, and a writer agent will eventually set it wrong.

`kind`, by contrast, is *not* safely derivable. Inferring it from the presence of `persona`
or `character` means a forgotten optional field silently turns an NPC into furniture. An
explicit discriminator produces a real error message and gives the schema a clean `oneOf`
for constrained generation.

The split is on **mobility**, not on story vocabulary. "Is this a character or a thing" is
a narrative question the engine does not need to answer; "does this need a pathfinder and
an agent tick" is the question it does.

### 6.2 Entity shape

```json
{
  "id": "alice",
  "kind": "actor",
  "name": "Alice",
  "character": "f3",
  "persona": "A cautious millwright who lost her brother to the river.",
  "spawn": { "anchor": "mill_yard" },
  "initial_state": "calm",
  "states": [ <state>, ... ]
}
```

```json
{
  "id": "mill_door",
  "kind": "prop",
  "name": "Mill door",
  "anchor": "mill_entrance",
  "blocks_movement": true,
  "initial_state": "locked",
  "states": [ <state>, ... ]
}
```

```json
{
  "id": "oak_04",
  "kind": "prop",
  "anchor": "square_ne",
  "sprite": "oak",
  "blocks_movement": true
}
```

| Field | Applies to | Meaning |
|---|---|---|
| `id` | both | Unique across all entities. |
| `kind` | both | `actor` or `prop`. |
| `name` | both | Display name. Optional for inert props. |
| `character` | actor | Sprite from the character table. |
| `persona` | actor | Stable personality text for agentic prompts. |
| `spawn` | actor | Position the actor starts at. |
| `anchor` | prop | Fixed position. |
| `sprite` | prop | Visual. |
| `blocks_movement` | prop | Default collision footprint; may be overridden per state. |
| `initial_state` | both | Required **iff** `states` is present. |
| `states` | both | Omit entirely for inert entities. |
| `origin` | both | `story` (default) or `map`. Provenance only; see §6.4. |

The `spawn` **field** is not the deferred `spawn` **op**. It declares where an actor stands
from world start, and it is what makes presence cheap to reintroduce later (§14.2): the
position is already authored, so a future `present` toggle needs no position argument.

The third example is the whole of the inert tier: a barrier is four fields. Hoisting
`blocks_movement` to entity level is what makes that possible — 1.0 required a `states`
array purely to hold it.

### 6.3 Entity state

```json
{
  "id": "calm",
  "on_enter": [ <effect>, ... ],
  "on_exit":  [ <effect>, ... ],
  "blocks_movement": false,
  "interaction": <interaction>,
  "transitions": [ <transition>, ... ]
}
```

A state is **one beat**: at most one interaction, plus the conditions under which the
entity leaves for another beat. `blocks_movement` here overrides the entity-level default
for this state (an open door).

In the 2.0 draft a state also carried `rules`, a priority list holding behavioral variation
*within* the beat. That is deferred (§14.1). The consequence is real and worth stating
plainly: **until rules return, every behavioral variation must become its own state.** For
a demo with two to four states per entity that is fine. It stops being fine as soon as
content volume grows — see §14.1 for the trigger to bring rules back.

### 6.4 Map-placed entities

Merging decoration into `entities` means the world file can now describe the full contents
of a scene, which 1.0 could not. Two things keep this from swamping the format:

1. **The format has one array; the pipeline has two producers.** The map exporter appends
   its props; the writer agent authors story entities. The writer agent's prompt is
   filtered to story entities plus a *manifest* of legal anchor ids and prop ids it may
   reference — it never sees three hundred trees.
2. **`origin`** marks provenance so a regeneration pass can replace story entities without
   clobbering map output. It has no runtime semantics.

`anchor` still refers to a **named location declared by the map system**. This format never
contains raw tile coordinates. Validation checks that every referenced anchor exists in the
loaded map; the anchor vocabulary is owned by the map team.

---

## 7. Transitions

A transition is the only control-flow construct in the format. Entity transitions and
episode transitions use exactly the same condition and effect grammar — one evaluator, one
validator, one grammar for the writer agent to learn.

```json
{
  "id": "calm_to_friendly",
  "priority": 0,
  "when": { "var": "interaction.outcome", "op": "==", "value": "intro_done" },
  "to": "friendly",
  "once": true,
  "effects": [
    { "op": "set", "path": "vars.conv_intro_done", "value": true },
    { "op": "inc", "path": "vars.trust_alice", "by": 1 }
  ]
}
```

Transitions are evaluated in `priority` descending, ties by declaration order; the first
whose `when` is satisfied fires, and evaluation stops. `once` is **transition metadata, not
a condition** — "has this fired before" is bookkeeping and does not belong in the condition
tree.

Firing a transition is equivalent to `{ "op": "set", "path": "entity.<self>.state",
"value": <to> }` followed by `effects`, and carries the full §5.1 cascade.

**`to` must name a state other than the one that owns the transition.** A self-transition
is the obvious way to fake a deferred rule — "run these effects, stay put" — but it re-runs
`on_exit` and `on_enter` and can cascade into a loop. It is a load error (§12, rule 16).
The supported places to run an effect without leaving a beat are `on_enter`, `on_exit`, and
an interaction outcome's `effects`.

---

## 8. Interactions and the outcome contract

1.0's `conversation` block is renamed `interaction`, because after the entity merge an
NPC's conversation and a door's examine prompt are the same thing wearing different modes.

**Every interaction, in every mode, must terminate by emitting exactly one declared
`outcome`.** This is the contract that lets free-form LLM dialogue drive a deterministic
story layer. Without it, agentic NPCs talk indefinitely and never advance the plot.

Reserved outcome: `__abandoned` — emitted when the player walks away, disconnects, or the
turn limit is hit. Implicitly available everywhere; it does not need declaring, but may be
listed to attach handling.

With rules deferred, interactions carry almost the entire behavioral surface of the demo.
Nearly every effect in a world file will hang off an outcome or a state entry.

### 8.1 `outcomes` is a map, and is the primary trigger surface

In 1.0 `outcomes` was an array of names and every consequence lived in a separate
transition. Here it is a **map from outcome id to its consequence**:

```json
"interaction": {
  "mode": "agentic",
  "prompt": "Alice is terrified; the mill is burning and her tools are inside.",
  "max_turns": 8,
  "outcomes": {
    "agreed_to_help": { "to": "helping",
                        "effects": [ { "op": "inc", "path": "vars.trust_alice", "by": 2 } ] },
    "refused":        { "effects": [ { "op": "set", "path": "vars.alice_rebuffed", "value": true } ] },
    "__abandoned":    { }
  }
}
```

Each entry is pure sugar and desugars to an ordinary transition on the owning state:

```json
{ "id": "__outcome_agreed_to_help",
  "when": { "var": "interaction.outcome", "op": "==", "value": "agreed_to_help" },
  "to": "helping",
  "effects": [ ... ] }
```

Desugared transitions are **appended after** the state's explicit `transitions` at equal
priority, so an explicit transition always wins a tie and can override sugar. An empty
value `{}` declares the outcome without consequence — legal, and the way to say "this
outcome is handled by a full transition elsewhere."

An entry with `effects` but no `to` runs its effects and leaves the entity in its current
state. This is the sanctioned "effects without a state change" path, and it is why the
self-transition ban in §7 costs nothing.

**Constraint:** a sugar entry's `to` may only name a state of the **owning entity**. Its
`effects` may touch anything. This keeps sugar from growing into a second, weaker copy of
the transition system.

Making `outcomes` a map subsumes 1.0 validation rule #8: an outcome that changes nothing is
now *visible in the file* rather than a warning the loader has to compute.

### 8.2 Why this is sugar and not a replacement

Outcome binding buys **authoring locality** — "when the player says X, this happens" reads
best next to the dialogue that produced X. It does **not** buy evaluation efficiency; §11
gets that for every transition, bound or not. So it is offered as convenience and standalone
transitions are never removed. This resolves the two structural objections to pure binding:

- **A trigger shared by several entities** is not repeated. Each entity's outcome entry
  sets a common variable, and one standalone transition watches that variable. (Or, for a
  simple case, each entry's `effects` writes the target's state directly.)
- **A trigger that is not an interaction** — `vars.trust_alice >= 5`, `episode.elapsed_ms`,
  a proximity threshold — is written as a full transition, exactly as in 1.0.

### 8.3 Modes

**Scripted.** Fully authored, fully deterministic.

```json
{ "mode": "scripted", "script_ref": "alice_intro",
  "outcomes": { "intro_done": { "to": "friendly" }, "rebuffed": { } } }
```

**Agentic.** Real-time LLM generation. On end, a second constrained call classifies the
transcript into exactly one declared outcome (rationale doc §5). Takes `prompt` and
`max_turns`.

**Guided.** Beats authored, prose generated. The LLM must hit each beat in order; the
outcome is determined by which beat was reached.

```json
{ "mode": "guided",
  "beats": [
    { "id": "greet",   "intent": "Alice greets the player warily." },
    { "id": "confide", "intent": "Alice admits she saw someone at the mill.",
      "outcome": "learned_of_stranger" }
  ],
  "outcomes": { "learned_of_stranger": { "to": "confiding" } } }
```

**Inspect.** A one-shot prompt with no dialogue — the common case for props. Sugar for a
single-node script.

```json
{ "mode": "inspect", "text": "The door is locked.",
  "outcomes": { "examined": { } } }
```

**None.** `{ "mode": "none" }`. Equivalent to omitting `interaction`.

---

## 9. Episodes

### 9.1 Entities are global; episodes are a delta layer

Entities are declared once at the top level and **never** redefined inside an episode. The
deciding argument is not how many entities are shared — it is **identity and continuity**.
If Alice were redefined per episode, `entity.alice.state` and `vars.trust_alice` would stop
meaning anything across an episode boundary; she would be a new character who happens to
share a name. That holds even if only one entity in ten persists.

So an episode is a *modifier*, never a *container*.

```json
{
  "id": "ep2_fire",
  "title": "The mill burns",
  "on_enter": [ <effect>, ... ],
  "on_exit":  [ <effect>, ... ],
  "entity_overrides": { },
  "transitions": [ <transition>, ... ]
}
```

The first episode in the array is the starting episode.

### 9.2 `entity_overrides`

1.0's `npc_overrides` supported only `force_state` and `disable_states`, which cannot
express the common middle case: an entity whose behavior is 90% stable but whose *one*
state differs in this episode. Redefining the entity repeats the other 90%.

The fix is **not** recursive deep merge of arbitrary JSON — that is unvalidatable and
impossible to reason about when two overrides touch the same subtree. Instead the override
vocabulary is **id-addressed list operations plus whole-block replacement of small leaves**:

```json
"entity_overrides": {
  "alice": {
    "force_state": "panicked",
    "disable_states": ["cheerful"],
    "states": {
      "calm": {
        "add_transitions":     [ { "id": "calm_to_fleeing", "when": {...}, "to": "fleeing" } ],
        "disable_transitions": ["calm_to_friendly"],
        "interaction":         { "mode": "agentic", "prompt": "...", "outcomes": { } },
        "on_enter":            [ ... ]
      }
    }
  }
}
```

| Operation | Applies to | Semantics |
|---|---|---|
| `force_state` | entity | Enter this state on episode entry (full cascade). |
| `disable_states` | entity | Transitions targeting these states are inert; writing one is an error. |
| `add_transitions` | state | Appended to the list. Ids must not collide with existing ones. |
| `disable_transitions` | state | By id. Every id must exist in the base definition. |
| `interaction` / `on_enter` / `on_exit` | state | **Replaced wholesale.** These are small leaves. |

Transitions are an append-only priority list, so `add_transitions` composes cleanly, and
every `disable_transitions` id is statically checkable — a typo is a load error, not a
silent no-op. Nothing else may be overridden; `persona`, `kind`, `character`, and `id` are
fixed for the life of the world.

This is the answer to rationale doc **Q5**: episodes may inject and suppress behavior and
replace a beat's dialogue, but may not redefine who someone is.

The deferred rule system had a matching `add_rules` / `disable_rules` pair here. Its
removal does not weaken the mechanism — the override vocabulary is the same shape, one list
narrower.

### 9.3 The cheaper first resort: guard on `episode.current`

For a variation that is one transition wide, do not write an override at all.
`episode.current` is an ordinary fact:

```json
{ "id": "calm_to_fleeing", "priority": 15,
  "when": { "all": [
      { "var": "episode.current",  "op": "==", "value": "ep2_fire" },
      { "var": "player.near.alice", "op": "==", "value": true }
  ]},
  "to": "fleeing" }
```

Zero new machinery, and the behavior stays legible in one place next to the rest of Alice.

**Guidance for authors and the writer agent:**

| Situation | Use |
|---|---|
| One or two transitions differ | `episode.current` guard on the transition |
| A beat's dialogue or shape differs | `entity_overrides` |
| The entity is inactive in some episodes | A `dormant` state with `mode: "none"`, entered via `force_state` |
| Who the entity *is* differs | Two entities |

Row three is the workaround for deferred `despawn` (§14.2). A dormant entity is still
visible and still collides; if the demo needs something to genuinely *not be there*, that
is the signal to reintroduce presence rather than to work around it.

### 9.4 Episode transitions

Identical grammar to §7, with `to` naming an episode:

```json
{
  "id": "t_ep1_ep2",
  "once": true,
  "priority": 0,
  "when": { "all": [ ... ] },
  "to": "ep2_fire",
  "effects": [ { "op": "set", "path": "entity.alice.state", "value": "panicked" } ]
}
```

---

## 10. Scripts

Unchanged from 1.0 except that `outcome` terminal nodes now resolve against the
`outcomes` **map**.

```json
"scripts": {
  "alice_intro": {
    "start": "n1",
    "nodes": {
      "n1": { "speaker": "alice", "text": "You're not from the valley.", "next": "n2" },
      "n2": { "speaker": "alice", "text": "What brings you here?",
              "choices": [
                { "text": "I'm looking for work.", "next": "n3" },
                { "text": "None of your business.", "outcome": "rebuffed" },
                { "text": "I heard about the mill.", "next": "n3",
                  "when": { "var": "vars.heard_rumor", "op": "==", "value": true } }
              ] },
      "n3": { "speaker": "alice", "text": "Then you'd best speak to Bob.",
              "outcome": "intro_done" }
    }
  }
}
```

Every node has exactly one of `next`, `choices`, or `outcome`. A node with `outcome` is
terminal. Choices may carry a `when`; choices whose condition is false are hidden. Every
path through the graph must reach an `outcome`.

---

## 11. Static analysis: the fact dependency graph

This section is not a format feature — it is what the format's closure properties buy the
engine, and it is the reason no trigger-binding field was added.

### 11.1 Construction

Because the condition grammar is closed with no arithmetic (§4) and the effect vocabulary
is closed with a single path-addressed write op (§5), the loader can compute exactly:

- the **read set** of every condition — the fact paths its leaves touch;
- the **write set** of every effect list — the fact paths it can change.

Joining them gives a bipartite dependency graph over one namespace. `set` being one op is
what makes this a single uniform edge type rather than a per-op special case.

### 11.2 Wake classes

Every transition is assigned a wake class from its read set. Nothing is scanned
periodically unless it is in the third bucket.

| Read set contains | Wake class | Cost |
|---|---|---|
| `interaction.*` | on end of the owning entity's interaction | free |
| only discrete facts (`vars.*`, `entity.*.state`, `episode.current`) | on any write to a path in the read set | free |
| any continuous fact (`*.elapsed_ms`, `player.near.*`) | polled at the step boundary | one evaluation per step |

Additionally, every transition is evaluated once on entry to its owning state or episode,
so `on_enter` effects cannot leave a satisfied condition unfired.

**In this revision the third bucket is usually empty.** Rules were the main consumer of
continuous facts; a demo with no timed episode shifts and no proximity transitions polls
nothing at all, and the scheduler reduces to a dependency-indexed event dispatch. Build it
that way and the polled path stays a small, separately testable addition.

Evaluation remains at **step boundaries (1 Hz)** in a fixed iteration order (entities and
transitions sorted by id), per rationale doc §7. Event-driven wake changes *which* items
are evaluated at a boundary, never *when* boundaries occur — so it cannot introduce replay
divergence.

### 11.3 What this is reported as

The loader emits, per world file, the set of polled transitions with the continuous fact
that put each there. This is the number that matters for cost, and making it visible at
author time is more useful than a `trigger` field the author has to keep in sync with the
condition they wrote.

The same graph yields the dead-condition diagnostic in §12, rule 22.

---

## 12. Validation rules

The loader **rejects** a world file that violates any of these. All are statically
checkable without running the world.

**Structural**

1. `format_version` is supported.
2. Every variable referenced in any condition or effect is declared in `vars`.
3. Every value written satisfies the target path's declared type / `values` / bounds.
4. Every `entity`, `episode`, `state`, `transition`, and `script_ref` id referenced exists.
5. All ids are unique within their namespace; entity ids are unique across the whole
   `entities` array regardless of `kind`.
6. `initial_state` is present iff `states` is present, and names one of them.
7. Every referenced `anchor` exists in the loaded map.

**Entity**

8. `kind: "actor"` requires `character` and `spawn`; `kind: "prop"` requires `anchor`.
9. `move` targets only a `kind: "actor"` entity.
10. An entity with no `states` has no `interaction` or `transitions` anywhere.

**Write class (§5.1)**

11. `set` targets only a path whose write class is `value` or `transition`. Writing
    `*.elapsed_ms` or `player.near.*` is an error, as is writing any path not in the §3
    table.
12. `inc` targets only a numeric `value`-class path.
13. Two statically provable `transition`-class writes to the same path in one step —
    **error**. Two `value`-class writes to one path — **warning**.

**Interaction**

14. Every `interaction.outcome` reference occurs in an interaction-scoped position.
15. Every outcome reachable in a script or guided beat list is a key in that interaction's
    `outcomes` map.
16. A sugar entry's `to` names a state of the owning entity.
17. Every script node path terminates in an `outcome`; no cycles without an exit.

**Transition**

18. A transition's `to` differs from the state that owns it — no self-transitions (§7).

**Episode overrides**

19. Every id in `disable_transitions` exists in the base state, and no `add_transitions` id
    collides with a base id or another override.
20. No override targets an entity or state that does not exist.
21. No transition targets a state that `disable_states` suppresses in an episode where that
    transition is live — **warning** (the override may be intentional shadowing).

**Graph**

22. A condition whose read set contains a path no effect anywhere can write, and which is
    not continuous, is **dead** — **warning**. (Falls out of §11.1.)
23. Every state reachable in a transition graph exists; unreachable states are a
    **warning**.
24. Every episode is reachable from the first; at least one episode is terminal or the graph
    is intentionally cyclic — **warning** if neither.

Errors block loading. Warnings are surfaced to the author and, during agent generation, fed
back into the repair loop.

---

## 13. Changes from 1.0

### 13.1 Summary

| Area | 1.0 | This revision | Why |
|---|---|---|---|
| Entities | `npcs` + `objects` | `entities` with `kind: actor \| prop` | One namespace, one runtime; inert decoration becomes expressible in 4 fields |
| Interactivity | implied by block presence | same, made explicit as a rule; **no** `interactable` field | Derivable; a redundant flag is a second source of truth |
| Collision | per-state `blocks_movement` only | entity-level default + per-state override | A barrier no longer needs a `states` array |
| Effects | 9 ops | 3 ops; `set` takes a fact path | One uniform edge type for the dependency graph (§11); three ops deferred (§14) |
| State change | `set_npc_state` / `set_object_state` / `shift_episode` | `set` with write class `transition` | Unified syntax, distinct and documented semantics |
| Rules | priority rule list per state | **deferred** (§14.1) | Not needed for one behavior per beat; returns additively |
| Presence | `spawn_npc` / `despawn_npc` | **deferred** (§14.2) | Every entity is always present; returns as a writable `present` path |
| Instrumentation | `emit_event` | **deferred** (§14.3) | The input log and condition trace already record every effect |
| Conversations | `conversation`, `outcomes` array | `interaction`, `outcomes` map with inline consequences | Authoring locality; makes 1.0 warning #8 structural |
| Interaction modes | 4 | 5 (adds `inspect`) | Props need a one-liner, not a script graph |
| Episode overrides | `force_state`, `disable_states` | `+ add/disable transitions`, replaceable `interaction` / `on_enter` / `on_exit` | The 90%-shared/10%-varies case without repetition |
| Facts | `npc.*`, `object.*`, `conversation.*` | `entity.*`, `interaction.*`; write class per path | Follows the entity merge |
| Evaluation | periodic scan | fact dependency graph, three wake classes | Free consequence of §4/§5 closure; no format change needed |
| Map | fully out of scope | geometry out of scope, entities in scope with `origin` | One shared interface file; authoring stays split |

### 13.2 Mechanical migration

Every 1.0 construct except the three deferred ones has a deterministic rewrite. A migration
script is feasible and should be written alongside the loader.

```
npcs[i]                        → entities[] + { "kind": "actor" }
objects[i]                     → entities[] + { "kind": "prop" }
npc.<id>.state                 → entity.<id>.state
object.<id>.state              → entity.<id>.state
player.near.<npc_id>           → player.near.<entity_id>
conversation.outcome           → interaction.outcome
conversation.turns             → interaction.turns
"conversation": {...}          → "interaction": {...}
"outcomes": ["a","b"]          → "outcomes": { "a": {}, "b": {} }
set_var    {var,value}         → set     {path,value}
inc_var    {var,by}            → inc     {path,by}
set_npc_state    {npc,state}   → set     {path:"entity.<npc>.state",   value:<state>}
set_object_state {object,state}→ set     {path:"entity.<object>.state",value:<state>}
shift_episode    {to}          → set     {path:"episode.current",      value:<to>}
move_npc    {npc,to}           → move    {entity,to}
npc_overrides                  → entity_overrides

npc.<id>.present               → no equivalent; §14.2
spawn_npc / despawn_npc        → no equivalent; §14.2
emit_event                     → no equivalent; §14.3
npc state `rules` / `npc_overrides.add_rules`
                               → no equivalent; §14.1
```

The migration script must **fail loudly** on the last four rather than dropping them —
silently discarding an `emit_event` or a rule list turns a migration into data loss.

The one migration that is not mechanical: 1.0 objects whose only reason for having `states`
was to carry `blocks_movement` should collapse to a stateless entity. The script should flag
those rather than guess.

### 13.3 What did not change

The load-bearing ideas from `02-design-rationale.md` are untouched, and this revision
depends on them more heavily than 1.0 did:

- Conditions read a declared fact namespace, never engine internals (§1 of the rationale).
- One leaf form, closed operators, no arithmetic (§2) — now also the precondition for §11.
- History is projected into flags by effects, never queried (§3).
- Effects are a closed vocabulary applied as engine inputs, so the story layer is replayable
  for free (§4).
- The outcome contract, including reserved `__abandoned` and the classifier call (§5).
- Episodes are global authority over entities (§6).
- Step-boundary evaluation in fixed iteration order (§7).
- Condition tracing from day one (§8).

**One rationale claim is temporarily suspended.** Rationale §6 reads "states are beats,
rules are behavior, episodes are authority", and argues at length that a flat FSM without
rules explodes combinatorially. That argument is still correct — deferring rules means
accepting the explosion risk for as long as content volume stays low. §14.1 says when it
stops being acceptable. The rationale doc should be read with that caveat until rules
return; it is not wrong, it is describing the target rather than this revision.

### 13.4 Impact on the implementation plan

Against `03-implementation-plan.md`:

- **U2 (fact namespace)** gains the write-class table, loses `present`. Small.
- **U4 (effect applier)** shrinks sharply — three ops instead of nine, with `set`
  dispatching on write class. Close to trivial.
- **U5 (loader/validator)** grows — it builds the dependency graph of §11 and owns the rule
  set of §12.
- **U6 (entity runtime)** loses the rule engine (priority scan, `once` and `cooldown_ms`
  bookkeeping) and absorbs props explicitly. This is the single largest saving in the trim.
- **U9 (episode layer)** implements `entity_overrides` list operations, one list narrower
  than the draft.
- A new small unit, **U5b (dependency graph + wake scheduler)**, splits out of U5/U6. It is
  a pure function of the loaded world and should be tested as one. With the polled bucket
  usually empty (§11.2), build the event-driven path first.
- **U10 (condition trace)** becomes more important, not less: it is now the only structured
  record of why the story advanced, since `emit_event` is gone (§14.3).

---

## 14. Deferred features

Each of these was specified in the 2.0 draft and removed for the first demo. The grammar is
preserved here so reintroduction is a copy, not a redesign. All three are **additive**:
each adds optional keys or new effect ops and invalidates no file written against §1–§13,
so none requires a `format_version` bump.

### 14.1 Rules — behavior within a state

**What it was.** A priority-ordered list on each entity state, holding behavioral variation
inside one story beat.

```json
{
  "id": "alice_warns_about_river",
  "priority": 10,
  "when": { "var": "player.near.alice", "op": "==", "value": true },
  "once": true,
  "cooldown_ms": 30000,
  "do": [ <effect>, ... ]
}
```

At each evaluation the highest-`priority` rule whose `when` was satisfied fired; ties broke
by declaration order. `once` and `cooldown_ms` were rule metadata, not conditions. Episodes
could inject and suppress them via `add_rules` / `disable_rules` in `entity_overrides`.

**What depended on it.** The state schema, `entity_overrides`, the wake-class table, four
validation rules, and — in practice — most consumers of `player.near.*`.

**Why removing it is safe now.** The story spine is transitions, interactions, and
episodes; rules were never part of it. Every effect site the demo needs is still reachable:
`on_enter`, `on_exit`, transition `effects`, and interaction outcome `effects` (§8.1). This
is the check that makes the removal safe rather than merely survivable — confirm it holds
for each new world file.

**What you lose.** Two things.

- **Ambient behavior.** "Alice waves when you come close", "the fountain splashes every
  thirty seconds." Flavor, not story — acceptable to skip in a demo.
- **Repeatable effects.** `cooldown_ms` has no replacement. `once` exists on transitions,
  but a transition fires at most once per entry into its state, so anything that must
  recur at a rate is simply not expressible.

**The real cost.** Rationale §6 argues that a flat FSM without rules explodes: every
behavioral variation must become a state, and the state graph grows combinatorially. That
is now the standing risk. It is invisible at two to four states per entity and becomes
acute the moment content volume rises.

**When to bring it back.** Before **U11 (agent generation)**. A writer agent producing
content into a rules-free format has only one way to add behavior — add a state — and it
must reason about graph reachability to do it, which is exactly the failure mode rationale
§6 was written to avoid. Two earlier signals: an entity acquires more than about six
states, or an author writes a self-transition to fake a rule (which §12 rule 18 rejects, so
it will surface as a load error rather than silently).

**Cost to reintroduce.** Add `rules` to the state schema and `add_rules` / `disable_rules`
to `entity_overrides`; add the priority scan plus `once` / `cooldown_ms` bookkeeping to U6;
add rules to the read-set walk in U5b. The dependency graph and wake classes already
generalize over "conditioned item" — rules slot in with no change to §11.

### 14.2 `spawn` / `despawn` — presence

**What it was.**

```json
{ "op": "spawn",   "entity": "stranger", "at": { "anchor": "north_gate" } }
{ "op": "despawn", "entity": "stranger" }
```

plus a read-only fact `entity.<id>.present`.

**Why removing it is safe now.** Nothing in the current story needs an entity to appear or
vanish. Both the op pair and the fact go together: with no writer, `present` would be
constant and every condition reading it would trip the dead-condition warning (§12, rule
22), so leaving the fact in place would be worse than removing it.

**What you lose.** Entities cannot be hidden. The workaround is a `dormant` state with
`mode: "none"` (§9.3), which stops the entity interacting but leaves it visible and
colliding. If the demo needs something to genuinely not be there, reintroduce presence
rather than work around it.

**Reintroduction — and the user-facing question of whether a `set` on a visibility property
suffices: yes, and it is better than the op pair.** Add one row to §3:

| `entity.<id>.present` | bool | `value` | Whether the entity is in the world. Defaults true. |

Then `{ "op": "set", "path": "entity.stranger.present", "value": true }` replaces both ops.
The only thing a boolean cannot carry is `spawn`'s position argument — and that is already
solved, because §6.2 requires every actor to declare a `spawn` anchor and every prop an
`anchor` at authoring time. An entity therefore always knows where it appears; `move` (kept
in §5) covers the rarer case of appearing somewhere else. Treating presence as `value`
class rather than `transition` class is correct: toggling presence should not fire
`on_enter` / `on_exit`, which belong to *state*, not existence.

The real cost is in the runtime, not the format: adding and removing an entity from the
render set, the collision grid, and the agent schedule. That work is the reason to defer,
and it does not shrink by choosing one syntax over the other.

### 14.3 `emit_event` — instrumentation

**What it was.**

```json
{ "op": "emit_event", "name": "beat_completed", "data": { "beat": "intro" } }
```

A structured record written to the run log with no gameplay effect, for research analysis.

**Why removing it is safe.** It is the most cleanly removable of the three: nothing reads
it. By design (rationale §3) conditions cannot query event history, so `emit_event` has
exactly zero coupling to the condition grammar, the dependency graph, or the evaluator.
Its only in-doc use was inside a rule example, which is deferred anyway.

**What you lose, and why it is less than it looks.** Two mechanisms already record what
`emit_event` recorded. Effects are applied as engine inputs (rationale §4), so the
append-only input log captures every state change with its arguments; and the condition
trace (rationale §8, U10) records which leaves were true and false at every evaluation.
Between them, "which beats did this run reach" is reconstructable from state transitions.

The genuine loss is the ability to mark a **named** beat that changes no state. That is
arguably a feature: in this format a beat that changes no state has not happened, and
naming it would create a second, untyped progress vocabulary alongside `vars` and
`entity.*.state`.

**When to bring it back.** When analysis needs a label that is not derivable from state —
for example distinguishing two paths that converge on the same variable assignment. Until
then, prefer a declared `vars` flag, which is typed, validated, replayed, and readable by
conditions.

**Cost to reintroduce.** One effect op with no evaluator coupling and no dependency-graph
edges. Genuinely trivial, which is a good reason not to carry it before it is needed.

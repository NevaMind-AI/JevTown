# World Description Format — Specification

`format_version: 1.0`

A **world file** is a single JSON document that fully defines a playable world: its
variables, its NPCs, its story episodes, and its interactable objects. The engine
contains **no world-specific code**. Swapping worlds means swapping this file.

Map data is **out of scope** for this document and owned by a separate system. This
format references map locations only through **named anchors** (see §9).

---

## 1. Top-level structure

```json
{
  "format_version": "1.0",
  "meta":      { },
  "vars":      { },
  "npcs":      [ ],
  "objects":   [ ],
  "episodes":  [ ],
  "scripts":   { }
}
```

| Key | Required | Meaning |
|---|---|---|
| `format_version` | yes | Schema version. The loader refuses files it cannot migrate. |
| `meta` | yes | Human/agent metadata: `id`, `title`, `description`, `authored_by`, `seed`. |
| `vars` | yes | Declaration of every authored variable. Undeclared variables are a load error. |
| `npcs` | yes | NPC definitions, each a state machine. |
| `objects` | no | Interactable world objects (doors, plants, containers). First-class entities. |
| `episodes` | yes | Ordered story episodes and the conditions that shift between them. |
| `scripts` | no | Bodies of scripted conversations, referenced by `script_ref`. |

`meta.seed` seeds the simulation PRNG. Two runs of the same world file with the same
seed and the same input log produce byte-identical results.

---

## 2. Variable declarations (`vars`)

Every authored variable is declared up front with a type and an initial value. This is
what makes world files statically checkable and agent-generatable.

```json
"vars": {
  "trust_alice":  { "type": "int",  "init": 0, "min": 0, "max": 10,
                    "doc": "How much Alice trusts the player." },
  "met_bob":      { "type": "bool", "init": false },
  "conv_intro_done": { "type": "bool", "init": false },
  "allegiance":   { "type": "enum", "values": ["crown", "guild", "none"], "init": "none" }
}
```

| Field | Meaning |
|---|---|
| `type` | One of `bool`, `int`, `float`, `string`, `enum`. |
| `init` | Initial value. Must satisfy the declared type and bounds. |
| `min` / `max` | Optional, numeric types only. Writes are **clamped**, not rejected. |
| `values` | Required for `enum`. The closed set of legal values. |
| `doc` | Human/agent-facing description. Included in the generation prompt. |
| `scope` | `world` (default) or `player`. See §2.1. |

### 2.1 Variable scope

`scope: "world"` — one value shared by everyone in the world.
`scope: "player"` — one value **per human player**, addressed as `vars.<name>` and
resolved against the acting player.

This distinction matters as soon as two humans share a world. A variable like
`trust_alice` is almost always `player`-scoped; `mill_burned_down` is `world`-scoped.
**Getting this wrong is the most likely source of confusing story bugs**, so `scope`
should be set explicitly on every variable rather than relying on the default.

---

## 3. The fact namespace

Conditions never read engine internals directly. They read a **flat, stable namespace**
populated from authored variables and from a versioned engine adapter. This is the only
coupling surface between world files and the engine.

| Path | Type | Writable | Meaning |
|---|---|---|---|
| `vars.<name>` | declared | yes | Authored variables from §2. |
| `npc.<id>.state` | string | via effect | NPC's current state id. |
| `npc.<id>.present` | bool | no | Whether the NPC is spawned in the world. |
| `object.<id>.state` | string | via effect | Object's current state id. |
| `episode.current` | string | via effect | Current episode id. |
| `episode.elapsed_ms` | int | no | Time since the current episode was entered. |
| `world.elapsed_ms` | int | no | Time since world start. |
| `player.near.<npc_id>` | bool | no | Player is within interaction range of that NPC. |
| `conversation.outcome` | string | no | **Scoped** — see §3.1. |
| `conversation.turns` | int | no | **Scoped** — turn count of the conversation just ended. |

Time-based conditions need no special syntax: `episode.elapsed_ms` is just another
readable fact.

### 3.1 Scoped facts

`conversation.*` is readable **only** inside transitions and rules that are evaluated in
the context of a conversation that has just concluded. Referencing it anywhere else is a
validation error.

---

## 4. Condition grammar

A condition is a tree. Composite nodes:

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

Operators — this set is closed:

`==` `!=` `<` `<=` `>` `>=` `in` `not_in`

`in` / `not_in` take an array literal on the right. Conditions perform **no arithmetic**;
this is deliberate, so every condition stays statically analyzable.

Example:

```json
{
  "all": [
    { "var": "vars.conv_intro_done", "op": "==", "value": true },
    { "any": [
        { "var": "vars.trust_alice",   "op": ">=", "value": 3 },
        { "var": "episode.elapsed_ms", "op": ">",  "value": 600000 }
    ]},
    { "not": { "var": "npc.bob.state", "op": "==", "value": "hostile" } }
  ]
}
```

`at_least` exists for non-linear progression: a player who wanders off should still be
able to advance the story by completing *some* of the available beats.

---

## 5. Effect vocabulary

Effects are the only way anything changes. The vocabulary is closed — freeform effects
(script strings, arbitrary state patches) are not permitted, because they would break
validation, agent-generation, and replay.

```json
{ "op": "set_var",         "var": "vars.trust_alice", "value": 3 }
{ "op": "inc_var",         "var": "vars.trust_alice", "by": 1 }
{ "op": "set_npc_state",   "npc": "alice",  "state": "panicked" }
{ "op": "set_object_state","object": "mill_door", "state": "open" }
{ "op": "shift_episode",   "to": "ep2_fire" }
{ "op": "spawn_npc",       "npc": "stranger", "at": { "anchor": "north_gate" } }
{ "op": "despawn_npc",     "npc": "stranger" }
{ "op": "move_npc",        "npc": "bob",    "to": { "anchor": "town_square" } }
{ "op": "emit_event",      "name": "beat_completed", "data": { "beat": "intro" } }
```

`emit_event` writes a structured record into the run log. It has no gameplay effect and
exists purely for research instrumentation and analysis.

**Ordering.** Effects within one list apply in declaration order. Effects from different
rules apply in the deterministic rule order defined in §8. Two effects writing the same
variable in the same step resolve last-write-wins, and the loader emits a warning if it
can prove such a conflict statically.

---

## 6. NPC definitions

```json
{
  "id": "alice",
  "name": "Alice",
  "character": "f3",
  "persona": "A cautious millwright who lost her brother to the river.",
  "spawn": { "anchor": "mill_yard" },
  "initial_state": "calm",
  "states": [ <state>, ... ]
}
```

`persona` is stable across all states and is always included in agentic prompts.
`character` selects a sprite from the existing character table.

### 6.1 NPC state

```json
{
  "id": "calm",
  "on_enter": [ <effect>, ... ],
  "on_exit":  [ <effect>, ... ],
  "conversation": <conversation>,
  "rules":       [ <rule>, ... ],
  "transitions": [ <transition>, ... ]
}
```

**States are coarse story beats**, not behavioral variations. Behavioral variation within
a beat belongs in `rules`, so that adding content is appending to a list rather than
rewiring a graph.

### 6.2 Rules (behavior within a state)

```json
{
  "id": "alice_warns_about_river",
  "priority": 10,
  "when": { "var": "player.near.alice", "op": "==", "value": true },
  "once": true,
  "cooldown_ms": 30000,
  "do": [ { "op": "emit_event", "name": "warned_player" } ]
}
```

At each evaluation the highest-`priority` rule whose `when` is satisfied fires. Ties break
by declaration order. `once` and `cooldown_ms` are **rule metadata, not conditions** —
"has this fired before" is bookkeeping and does not belong in the condition tree.

### 6.3 Transitions (between states)

```json
{
  "id": "calm_to_friendly",
  "when": { "var": "conversation.outcome", "op": "==", "value": "intro_done" },
  "to": "friendly",
  "once": true,
  "effects": [
    { "op": "set_var", "var": "vars.conv_intro_done", "value": true },
    { "op": "inc_var", "var": "vars.trust_alice", "by": 1 }
  ]
}
```

Transitions use exactly the same condition and effect grammar as episodes. One evaluator,
one validator, one grammar for the writer agent to learn.

---

## 7. Conversations and the outcome contract

**Every conversation, in every mode, must terminate by emitting exactly one declared
`outcome`.** This is the contract that lets free-form LLM dialogue drive a deterministic
story layer. Without it, agentic NPCs can talk indefinitely and never advance the plot.

Reserved outcome: `__abandoned` — emitted when the player walks away, disconnects, or the
turn limit is hit. It is implicitly available in every state and does not need declaring,
but transitions may match on it.

### 7.1 Scripted mode

Fully authored, fully deterministic.

```json
{ "mode": "scripted", "script_ref": "alice_intro",
  "outcomes": ["intro_done", "rebuffed"] }
```

### 7.2 Agentic mode

Real-time LLM generation. On conversation end, a **second constrained call classifies the
transcript into exactly one of the declared `outcomes`** (see rationale doc §5).

```json
{ "mode": "agentic",
  "prompt": "Alice is terrified; the mill is burning and her tools are inside.",
  "outcomes": ["agreed_to_help", "refused"],
  "max_turns": 8 }
```

### 7.3 Guided mode

Beats are authored, prose is generated. The LLM must hit each beat in order; the outcome
is determined by which beat the conversation reached.

```json
{ "mode": "guided",
  "beats": [
    { "id": "greet",   "intent": "Alice greets the player warily." },
    { "id": "confide", "intent": "Alice admits she saw someone at the mill.",
      "outcome": "learned_of_stranger" }
  ],
  "outcomes": ["learned_of_stranger"] }
```

### 7.4 No conversation

```json
{ "mode": "none" }
```

---

## 8. Episodes

```json
{
  "id": "ep1_arrival",
  "title": "Arrival",
  "on_enter": [ <effect>, ... ],
  "on_exit":  [ <effect>, ... ],
  "npc_overrides": {
    "alice": { "force_state": "panicked" },
    "bob":   { "disable_states": ["cheerful"] }
  },
  "transitions": [
    {
      "id": "t_ep1_ep2",
      "once": true,
      "priority": 0,
      "when": { "all": [ ... ] },
      "to": "ep2_fire",
      "effects": [ { "op": "set_npc_state", "npc": "alice", "state": "panicked" } ]
    }
  ]
}
```

`npc_overrides` gives episodes authority over NPCs — a two-level hierarchy that handles
"the fire started, so everyone reacts regardless of their individual state" without a full
hierarchical state machine.

The first episode in the array is the starting episode.

---

## 9. Objects

Interactable world elements are **first-class entities**, not NPCs. (Modelling them as
immobile NPCs makes them collision obstacles, slows pathfinding, and requires exclusion
logic in every agent code path.)

```json
{
  "id": "mill_door",
  "name": "Mill door",
  "anchor": "mill_entrance",
  "initial_state": "locked",
  "states": [
    { "id": "locked", "blocks_movement": true,
      "interaction": { "prompt": "The door is locked.",
                       "outcomes": ["examined"] },
      "transitions": [
        { "when": { "var": "vars.has_key", "op": "==", "value": true },
          "to": "open", "effects": [] }
      ]
    },
    { "id": "open", "blocks_movement": false, "transitions": [] }
  ]
}
```

Objects use the same state / condition / effect grammar as NPCs.

### 9.1 Map integration

`anchor` refers to a **named location declared by the map system**. This format never
contains raw tile coordinates. Validation checks that every referenced anchor exists in
the loaded map; the anchor vocabulary itself is owned by the map team.

---

## 10. Scripts

Bodies of scripted conversations, referenced by `script_ref`.

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
terminal. Choices may carry a `when` condition; choices whose condition is false are
hidden. Every path through the graph must reach an `outcome`.

---

## 11. Validation rules

The loader **rejects** a world file that violates any of these. All are statically
checkable without running the world.

1. `format_version` is supported.
2. Every variable referenced in any condition or effect is declared in `vars`.
3. Every value written to a variable satisfies its declared type / `values` / bounds.
4. Every `npc`, `object`, `episode`, `state`, and `script_ref` id referenced exists.
5. All ids are unique within their namespace.
6. Every NPC's `initial_state` exists in its `states`.
7. Every state reachable in a transition graph exists; unreachable states are a **warning**.
8. Every declared `outcome` is matched by at least one transition — otherwise a
   conversation can complete and change nothing (**warning**).
9. Every `conversation.outcome` reference occurs in a conversation-scoped position.
10. Every script node path terminates in an `outcome`; no cycles without an exit.
11. Every episode is reachable from the first episode; at least one episode is terminal
    or the graph is intentionally cyclic (**warning** if neither).
12. Every `anchor` exists in the loaded map.
13. Statically provable same-step write conflicts on one variable (**warning**).

Errors block loading. Warnings are surfaced to the author and, during agent generation,
fed back into the repair loop.

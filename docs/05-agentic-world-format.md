# Agentic World Format — Specification

`format_version: a1.0`

**This is a parallel branch, not a successor.** `04-world-format-spec-v2.md` describes a
world whose story layer is a typed state machine. This document describes a world whose
story layer is natural language, evaluated by models. Both are being attempted; neither has
been chosen. `06-agentic-design-rationale.md` explains why there are two, what they share,
and how we expect to decide.

The `a` prefix on `format_version` marks the branch. An `a1.0` file and a `2.0` file are not
migratable into one another, and the loader must refuse the wrong one rather than guess.

**Amended by `08-agentic-implementation-plan.md` §7** (D1, D2, D3, D6, D7, D8) and by
`07-map-entity-split.md`. Sections carrying an amendment say so inline; `08` §7 holds the
rationale for each. `09-agent-loop.md` specifies the agent loop this format assumes.

---

## 1. The thesis, and its one exception

**Everything that describes the story is natural language.** Entity state is prose. Memory
is prose. The rules governing when an entity changes is prose in a prompt. There are no
declared variables, no condition trees, no effect vocabulary, and no transition tables.

**The exception is physics.** The simulation tick runs at 16 ms
(`convex/aiTown/game.ts:177`) and calls `blocked()` (`convex/aiTown/movement.ts:172`) on
every pathfinding expansion and every position update. It is synchronous. **It cannot call
a model.** Anything the tick loop reads must therefore be a typed field.

That boundary — not a philosophical compromise, a hard runtime constraint — defines the
whole format:

| Layer | Representation | Read by | Written by |
|---|---|---|---|
| **Physics** | typed, tiny | the 16 ms tick loop | LLM, via a tag written *inside* the prose |
| **Story** | prose | LLM prompts only | LLM |

The typed surface is two booleans per entity (§4.3). Everything else is prose.

**The governing rule, stated once:** *the same model call that rewrites an entity's prose
state also emits its physics projection.* Never two calls, never a separate classifier pass.
This keeps prose and physics from drifting apart and keeps per-interaction cost flat.

**Amended: the projection is not a second field, it is a tag in the first one.** The rule above
was satisfied by a `physics` object emitted beside the `state` string in one envelope — one call,
but two artefacts, which can disagree. The entity now writes `<blocked/>` or `<unblocked/>` inside
the state document itself and the engine derives the typed value from that text (§4.3). One call,
one artefact, nothing to keep in step.

---

## 2. Top-level structure

```json
{
  "format_version":   "a1.0",
  "meta":             { },
  "world_rules":      "",
  "common_knowledge": "",
  "entities":         [ ],
  "god":              { }
}
```

| Key | Required | Meaning |
|---|---|---|
| `format_version` | yes | Must be `a1.0`. The loader refuses `2.0` files rather than migrating. |
| `meta` | yes | `id`, `title`, `description`, `authored_by`, `seed`. |
| `world_rules` | yes | Prose. The setting, its constraints, and what may and may not happen. Enters the god's system prompt and **every actor's, verbatim**. |
| `common_knowledge` | no | Prose. What is true in the world right now that everyone in it knows. Authored once here, and the god's to rewrite thereafter. See §5.3. |
| `entities` | yes | Everything that is not the map itself or a human player. |
| `god` | yes | Configuration for the overseer agent, including `hidden_rules`. See §7. |

`world_rules` and `common_knowledge` are a pair and the difference between them is the whole of
why there are two: **rules are how this world works and never change; common knowledge is what has
come to be true within them and changes.** A world file that puts a current event in `world_rules`
has written a fact nothing can ever update.

**Amended (`08` §7 D1).** Two changes from the original table:

`state_contract` **is no longer part of the world file.** It is engine configuration — see §5.1.

`world_rules` is **not filtered per actor.** Filtering would require deciding which rules an
actor knows, which is a knowledge model this format does not have. Rules an actor must not
know are not filtered out of `world_rules`; they are written in `god.hidden_rules` (§7)
instead, which never enters an actor prompt at all. Structural, not algorithmic.

`meta.seed` seeds the simulation PRNG. Two runs of the same world file with the same seed
and the same input log produce byte-identical results — see §10.

`vars`, `episodes`, and `scripts` from the typed branch have no counterpart here. Their
content lives in `world_rules` and in per-entity prose. §11 records what that costs — with one
qualification added by `08` §7 D1: the head-state line of §5.1 **is** a typed field by another
name. It is written by the entity, unvalidated by the engine, and read by the god; nothing in the
tick loop branches on it. If anything ever does, this branch has reinvented `vars` and should
say so, exactly as §9.4 warns.

---

## 3. The entity taxonomy

Two authored fields produce four tiers. A third tier boundary is derived rather than
declared.

```json
{ "kind": "actor" | "prop", "mobile": true | false }
```

| Tier | `kind` | `mobile` | prose `state` | `memory` | Initiates? | Runs inference? |
|---|---|---|---|---|---|---|
| (a) mobile agent | `actor` | `true` | yes | yes | yes | yes |
| (b) fixed agent | `actor` | `false` | yes | yes | no | yes |
| (c) passive prop | `prop` | — | yes | no | no | no — appears in *another* agent's prompt |
| (d) decoration | `prop` | — | absent | no | no | no |

### 3.1 Why `kind` splits on agency, not mobility

`04` §6.1 splits `kind` on mobility, reasoning that the engine's real question is "does this
need a pathfinder and an agent tick." That bundles two things this taxonomy separates: tier
(b) needs an agent tick but no pathfinder. Three reasons the split moves:

**The schema delta is on the agency axis.** An `actor` carries prose state, memory, prompt
configuration, and a turn budget. A `prop` carries none of them. Across the
mobility axis the delta is `spawn` vs `anchor` and whether `move` is legal — two fields. A
`oneOf` discriminator should carve where the shapes differ most; the small difference
travels as a flag.

**The runtime already draws this line.** `Conversation`
(`convex/aiTown/conversation.ts:29,53`) is a two-participant structure keyed by
`GameId<'players'>`, and `Conversation.start(game, now, player, invitee)` takes two `Player`
objects. Tier (b) is by definition a two-sided dialogue. As an `actor` with `mobile: false`
it is a `Player` + `Agent` pair whose decision operation never returns a destination, and it
drops into the existing conversation machinery **with no changes to `Conversation` at all**.
As a `prop` it could not occupy a participant slot without rewriting that model. Tier (c),
by contrast, is genuinely not a conversation — it is a one-shot call by the visiting agent
and needs no participant slot. The (b)/(c) line is exactly the line the runtime already
enforces.

**Cost visibility.** Every `actor` costs inference. Every `prop` is free. "How many
inference-bearing entities does this world contain" should be one field lookup.

**Amended (`08` §7 D3): the second argument above is half right.** The runtime splits on two
different axes at two different phases, and this section collapsed them into one:

| Phase | Splits on | (a) vs (b) | (b) vs (c) |
|---|---|---|---|
| Approach | **mobility** | different — (a) is invited and walks toward you; (b) is walked to | identical |
| Dialogue | **agency** | identical — both take turns | different — (c) is one-shot |

So `04` §6.1's mobility split and this section's agency split are each correct about one
phase. What follows for the runtime:

- **Targeting is homogeneous.** The set an actor may aim at is (a) + (b) + (c), one manifest,
  one id space. Nothing about choosing a target distinguishes the tiers.
- **(b) and (c) share the approach path** and are one storage collection — `entities`, with
  anchors and physics. (b) additionally carries the fields that make it run inference.
- **The dialogue lifecycle stays split.** A two-sided `Conversation` and a one-shot
  `Interaction`, not one lifecycle. `Conversation`'s participant statuses are `invited` /
  `walkingOver` / `participating` (`convex/aiTown/conversation.ts:147,175`), and the first two
  encode *two things walking toward each other* — for a fixed target they would all have to be
  no-ops, which is more dead state than a second lifecycle is code.

The consequence for §3.1's opening claim: a fixed actor no longer needs to be a `Player` +
`Agent` pair to reach the conversation machinery, so "it drops into the existing machinery with
no changes" is no longer the reason to prefer the agency split. The reason is the schema delta,
which stands. `09-agent-loop.md` §6 specifies the pipeline.

### 3.2 Why (c) vs (d) is derived, not declared

Carried unchanged from `04` §6.1: there is no `interactable` field. An entity with no
`state` is inert. A redundant boolean is a second source of truth that can disagree with the
content, and a generating agent will eventually set it wrong.

Note this is *not* in tension with the runtime `interactable` physics flag (§4.3), which is
a mutable runtime value derived at load and toggled by models thereafter. Authors never
write it.

### 3.3 Mobility and initiative are separable; v1 conflates them

Tier (b) is defined here as "cannot move, does not initiate." Those are distinct properties
— a statue that hails passers-by is `mobile: false, initiates: true`. Splitting them
requires a proximity trigger between two non-player entities, which the engine does not
compute (it derives `player.near.*` only). **For `a1.0`, `initiates` is derived as
`mobile`.** Adding an explicit `initiates` field later is additive and invalidates no file.

---

## 4. Entity shape

### 4.1 Examples, one per tier

```json
{
  "id": "alice",
  "kind": "actor",
  "mobile": true,
  "name": "Alice",
  "character": "f3",
  "spawn": { "anchor": "mill_yard" },
  "description": "A cautious millwright who lost her brother to the river.",
  "behavior": "She measures people before she trusts them, and she does not forgive being lied to.",
  "initial_state": "Uneasy. The mill has been running hot for three days and nobody will tell her why. She has not spoken to the stranger yet.",
  "initial_memory": [
    "The river took my brother two winters ago. I do not go near the north bank."
  ],
  "physics": { "blocks_movement": false }
}
```

```json
{
  "id": "hearth_oracle",
  "kind": "actor",
  "mobile": false,
  "name": "The Hearth Oracle",
  "sprite": "brazier",
  "anchor": "great_hall_hearth",
  "description": "A voice in the coals.",
  "behavior": "It answers only what is asked, always truthfully, and always in a way that costs the asker something to hear.",
  "initial_state": "Dormant but listening. It has answered nobody this cycle.",
  "physics": { "blocks_movement": true }
}
```

```json
{
  "id": "mill_door",
  "kind": "prop",
  "name": "Mill door",
  "anchor": "mill_entrance",
  "sprite": "door_closed",
  "description": "A heavy oak door, banded in iron, set into the mill's north face.",
  "initial_state": "Locked. The bar is set from the inside and the lock has been recently oiled.",
  "physics": { "blocks_movement": true }
}
```

```json
{
  "id": "oak_04",
  "kind": "prop",
  "anchor": "square_ne",
  "sprite": "oak",
  "physics": { "blocks_movement": true }
}
```

### 4.2 Field table

| Field | Applies to | Kind | Meaning |
|---|---|---|---|
| `id` | both | id | Unique across all entities. |
| `kind` | both | enum | `actor` or `prop`. |
| `mobile` | actor | bool | Required on actors, forbidden on props. |
| `name` | both | string | Display name. Optional for decoration. |
| `character` | actor, mobile | id | Sprite from the character table. |
| `sprite` | prop, fixed actor | id | Visual. |
| `spawn` | actor, mobile | anchor | Where the actor starts. |
| `anchor` | prop, fixed actor | anchor | Fixed position. |
| `description` | both | **prose** | Stable identity, for an actor and a prop alike. Never rewritten at runtime. |
| `behavior` | both | **prose** | Optional. An extension of `description`, appended to it wherever it is injected. |
| `initial_state` | actor, prop | **prose** | Mutable. Absent ⇒ the entity is inert (tier d). |
| `initial_memory` | actor | **prose[]** | Optional seed memories. |
| `physics` | both | typed | Initial physics. See §4.3. |

**Amended: `persona` and `description` are one field, `states` is gone, and `origin` with it.**

An actor had a `persona` and a prop had a `description`, and every consumer had to ask which tier
it was holding before it could read the prose. They are one field, `description`, on every tier.
The only place the distinction survives is the manifest (§6.4), which publishes a *prop's*
description and never an actor's — that is a rule about what may be seen, which is the tier's
business, not the field's.

`behavior` is not a second kind of prose. It is appended to `description` at every injection site
and nothing downstream tells them apart; they are two fields so that a writer agent can produce
them separately and an ablation can drop one.

`states` — the authored head-state vocabulary — is **gone**, and with it the prompt line that
offered it. An entity's legal states are whatever its `description` and `behavior` imply. §5.1
records what that costs.

`origin` is gone as well. It marked whether an entity came from the story file or the map, and
`07` §5 already found it vestigial once those became two files with one producer each.

`description` is **immutable**; `initial_state` and memory are the mutable prose. Keeping identity
separate from state is what stops fifty rounds of model rewriting from turning Alice into someone
else — the drift has a floor.

`anchor` refers to a named location owned by the map system. This format never contains
raw tile coordinates.

### 4.3 `physics` — the entire typed surface

Authored:

```json
"physics": { "blocks_movement": true }
```

Runtime, after load:

```json
{ "blocks_movement": true, "interactable": true }
```

| Field | Read by | Initial value | Mutable at runtime |
|---|---|---|---|
| `blocks_movement` | `blocked()`, every pathfinding expansion and position tick | authored, default `false` | yes |
| `interactable` | interaction gating, before an agent may target the entity | derived: `true` iff the entity has `initial_state` | yes |

That is the complete list. If a future feature needs the tick loop to read something new,
adding a field here is the correct move and should be done deliberately — every addition
widens the typed surface this branch exists to minimise.

Physics is written **only** as the projection accompanying a prose state update (§1). There
is no standalone "set physics" operation, because a physics change with no story reason is
exactly the drift this design is trying to prevent.

### `blocks_movement` is a tag in the state document

**Amended.** `physics` in the world file is now an *initial* value only. At runtime the value is
carried by a tag the entity writes inside its own state document:

```
state: open

The bar is splintered and the door hangs off the upper hinge.

<unblocked/>
```

Six rules:

1. **The tag is a level, not an edge.** An entity that uses tags at all writes the true one every
   time it writes a state, not only when it changes. A repeated assertion is idempotent — the
   engine applies nothing and audits nothing when the value already matches.
2. **No tag asserts nothing**, and the entity keeps the physics it had. So does a document
   carrying both tags. Neither ever falls back to a default: guessing `blocks_movement: false`
   opens doors nobody opened, and that failure has been observed in a live run.
3. **Most entities never write one.** The shared contract explains the shape and then says not to
   use it unless the entity's own `description` tells it to (§5.1). Which entities may switch, and
   on what, is written in their `behavior` — a door's rule belongs to the door.
4. **The engine derives the typed value from the text, in the input handler.** Parsing is pure, so
   a mutation may do it and replay reproduces it exactly. Deriving there rather than in the calling
   action is what makes it true of every writer — including the god, which emits no physics of its
   own and could otherwise rewrite a door's prose while leaving the pathfinder believing the old
   thing (§7.6).
5. **`interactable` has no tag.** It is derived at load from having state and is not currently
   writable at runtime. Nothing can become non-targetable mid-run; that is a known limit, not an
   oversight, and a second tag is the additive fix when a world needs one.
6. **The tag goes last, below the prose.** Anything in angle brackets sits at the foot of the
   document — under the paragraph, and under the intention where there is one. The parser finds
   the tag anywhere (§5.1 is tolerant on purpose), so this is a rule about the document being
   legible as prose, not about parsing: the contract asks for one position so the god has one
   thing to judge.

An `<items>` block may follow the tag, at the same end of the document and on the same terms —
same "not unless your description says so", same silence from the engine, which never reads it:

```
<items>
"a brass key" = 1
"coin" = 40
</items>
```

It is parsed only so a run can be queried (the count lands in `stateAudit.tags`). Nothing branches
on it. The moment something does, this branch has reinvented `vars` and should say so (§9.4).

---

## 5. Prose state and memory

### 5.1 The `state_contract` — engine-owned

**Amended (`08` §7 D1, D2).** Two changes: the contract left the world file, and the format
gained structure.

**The `state_contract` is not part of `world.json`.** It is the format the engine's parser
reads and the god's gate judges against. A writer agent able to rewrite it could emit a
contract the parser cannot enforce, and nothing could detect the disagreement. It is engine
configuration, versioned with the engine, and the writer agent obeys it rather than declaring
it.

#### The format

An actor's state document:

```
state: <one word or short phrase>
<optional typed lines, one per line, e.g. trust_player: true>

<a paragraph of finer state, in natural language>

<one or a few sentences: what this entity intends or is about to do>

<optional <blocked/> or <unblocked/>, then an optional <items> block — §4.3>
```

**An actor writes in the first person and a prop is written about in the third.** An actor's
document is its own voice — "I am on the ridge because the light is better" — which is the voice
the next decision is made in. A prop's document is written *by whoever acted on it*, so it speaks
about the thing: "the bar is splintered". The contract carries the rule in both variants.

A prop's state document is the same **without the intention section** — a door has a
condition, not a plan. The contract carries both variants; the engine injects the one matching
the tier.

The typed lines after the head-state are a last resort. Most entities should have none: an
entity that tracks "does she trust the player" in a boolean has moved a judgement the model is
good at into a field it is bad at maintaining.

Why this rather than the original "two to five sentences, present tense, third person": each
section has a distinct job, and a drifting model blurs *within* a section long before it drops
a labelled one. **Structure is the drift defence that the character budget used to be** — which
is what makes deferring the drift spike defensible (`08` §7 D6).

**Amended: there is no authored vocabulary.** The head-state token used to be drawn from a
per-entity `states` list, injected with the instruction to choose from it and invent nothing. That
field is gone (§4.2): an entity's states are whatever its `description` and `behavior` imply, and
the contract asks it to reuse the word it last wrote unless something actually changed.

The engine could never validate the token — it had no vocabulary either way — so nothing the
engine does changes. What is lost is a drift defence: the token is now open, and an entity may
coin a new one every write. The replacement instrument is observational rather than preventive.
The parser records the token itself in the conformance record, so the distribution of head states
per entity is a query over `stateAudit.tags` (§9.3) and §13 A1 stays answerable.

#### Enforcement is deliberately weak

| Field | Checked | On failure |
|---|---|---|
| `state` length | **hard** | one re-ask, then keep the previous state |
| `state` structure | no | recorded, tolerated |
| head-state token legality | no — the engine has no vocabulary | the god is the second gate (§7); a bad token is tolerated |
| `memory` length | **hard** | truncate, no re-ask |
| `reason` length | **hard** | truncate, no re-ask |
| physics tag | n/a — absent, present, or contradictory | absent or contradictory ⇒ keep the previous physics, never a default |

**Length is the only hard restriction on prose.** A missing section, an invented head-state, a
broken boolean, a state document that is one long paragraph — all tolerated, all recorded. This
is a research stance, not an oversight: what an entity does with a malformed state document is
an observation. Two implementation consequences:

1. **The parser must never throw.** It returns the document plus a conformance record: whether
   line one matched and what token it carried, how many blocks there were, how many typed lines,
   word count, whether a re-ask happened. That record goes into `stateAudit.tags` (§9.3), which is
   what makes §13 A1 answerable by query instead of by a separate harness (`08` §7 D6).

   **It does not split the body into sections.** The contract asks for a paragraph of condition
   and, from an actor, an intention — but that split is guidance to the writer, never a rule to
   check, and no consumer ever needed either half alone: the client renders the document whole and
   every prompt injects it whole. "Did it write an intention" was in any case a positional guess
   that reduced to the block count, so the block count is what is recorded.
2. **The physics tag is the one part the tick loop reads** (§1), and tolerance there means
   something specific: a document that says nothing about physics, or says two contradictory
   things, leaves the entity exactly as it was. There is no malformed case to reject and no
   default to fall back to — the only way to move physics is to assert one tag and mean it.

#### Budgets and where they run

The budget is loose, on the order of a thousand words. `a1.0`'s 600 characters was set against
undifferentiated prose; state complexity scales with the complexity of the world and the story,
and a tight cap on a structured document truncates the intention section, which is the part the
next decision reads.

**Enforcement runs in the action, before the input is sent** (`08` §7 D2). The original text
put it "in the input handler"; input handlers are Convex mutations and **mutations cannot call
models**, so a handler can reject or truncate but can never re-ask. The handler stays as a hard
backstop; the re-ask lives in the action, and there is exactly one of them before falling back.

Nothing here bounds what enters *another* agent's prompt, because nothing needs to: an actor
cannot see another entity's state before an interaction begins (§6.4). A state document is only
ever read by its own entity, by the party it is talking to, and by the god.

### 5.2 Memory

Memory reuses the existing machinery unchanged in shape:
`convex/agent/memory.ts` already embeds, stores, ranks by relevance and importance, and
retrieves via vector search over `memoryEmbeddings`. What changes:

- The subject widens. Today memory is written only about conversations
  (`data.type: 'conversation' | 'relationship' | 'reflection'`). Add a type for
  prop interactions and one for god interventions.
- **Every memory write becomes an engine input** (§9). Today `insertMemory`
  (`convex/agent/memory.ts:273`) is an `internalMutation` called straight from the action;
  nothing about its content reaches the log.
- Memory is never read by the tick loop, so it stays out of the world document (§8).

Tier (c) props have state but **no memory**. A door does not remember. If something needs to
remember, it is a fixed actor, not a prop — that is the tier boundary doing its job.

### 5.3 Common knowledge — the one document everybody reads

**Added by `08` §7 D8.**

Prose state answers *what is this entity like now*. Memory answers *what does it carry from what
happened to it*. Nothing answered **what is true in this world now**, and `world_rules` is the
wrong place to look for it: it is authored, immutable, and about how the world works rather than
about what has happened in it. A fact the whole town has come to know — the ferry is not running,
a boat went out and did not come back — had nowhere to live except inside each entity's own state,
separately, where fifty rewrites drift the copies apart one by one.

**Common knowledge is one prose document per world, read by every actor and written only by the
god.**

#### Where it lives, and what it deliberately is not

It is stored in `entityState` under the reserved id `__world__`
(`convex/prose/contract.ts:COMMON_KNOWLEDGE_ID`), with its version counter on the world document
as `commonKnowledgeVersion` (`convex/aiTown/world.ts`). Three things follow, and each was the
alternative that got rejected:

**Not an `Entity`.** It could have been a pseudo-entity in `world.entities` — the id space is
untyped and it would have worked. But `world.entities` is what the manifest, the collision
overlay, the targeting set and the client iterate, so a pseudo-entity means four exclusion checks
that each have to be remembered again by the next person who adds a fifth iteration. Staying out
of the collection makes *not targetable, no physics, no memory, never rendered* true by
construction. This is `04`'s own lesson about derived-vs-declared (§3.2) applied to a collection
instead of a field.

**Not a new table.** §7.3 refuses to put the god's transcript in `messages` for four concrete
reasons — branded ids validated by `parseGameId`, a renderer, a scanner one join from agent
memory, and a shape that does not fit. None of them are true of `entityState`: its `entityId` is
an unvalidated `v.string()` that already mixes two namespaces (`p:` for tier (a), entity ids
otherwise), and it is read only by explicit lookup. So the reserved key inherits versioning, the
audit table, the blob escape hatch and the client's change-signal pattern, and a new table would
have duplicated all four to buy nothing. **Reuse the derived storage; never reuse the engine's
collections** is the line that separates this from §7.3, and it is the line to apply next time.

**Not in the world document.** §8 holds: prose never enters a document rewritten in full every
step. `commonKnowledgeVersion` is one integer per step, which is exactly what an entity's
`stateVersion` costs.

#### The scope rule, which is the whole of the safety

§6.4 is deliberate: an actor cannot see another entity's state and learns it only by interacting.
A document every actor reads is a channel straight through that rule — anything written there is
known by everyone without anybody having learned it. **That exception is the feature, and it is
only safe while what goes in is restricted to what every inhabitant would already know anyway.**

So the contract the god writes against says: only what is settled, only what happened in the open
or would have travelled by now, third person, about the world. One character's belief, one
character's secret, or anything only the people present could know stays in that character's own
state and memory. And **nothing here is secret** — a fact some actors must not know goes in
`god.hidden_rules` (§7), which no actor prompt ever reads, or nowhere at all.

It is **not filtered per actor**, for the same reason `world_rules` is not (§2): filtering would
need a model of who knows what, which this format does not have. The rule is structural — what
may be written, not who may read it.

#### Format

The §5.1 document, in the prop variant (no intention — the world has a condition, not a plan) and
without the bracketed tail (it occupies no tiles and carries nothing, so `<blocked/>` and
`<items>` are meaningless). One parser, one budget, one conformance record; no third variant.

```
state: uneasy

The ferry is running short days because the river is low. A boat went out last week and has not
come back, and the whole town knows it; nobody knows what became of it.
```

The head-state line earns its place here more than anywhere else. "Where the world is now, in one
phrase, advanced by the god" is precisely §13 A2's cheap fallback — *`world_rules` becomes an
ordered array of prose phases with the god responsible for advancing between them* — arriving
without an episodes table and without a schema. It is also §9.4's warning at its sharpest: the
moment anything in the tick loop branches on that token, this branch has reinvented `vars` and
should say so out loud.

#### One writer, structurally

`entityUpdateState` and `entityUpdateTarget` refuse the reserved id
(`convex/aiTown/entityInputs.ts:refuseCommonKnowledge`). The only path that writes it is
`godVerdict`, and the write rides in the **same verdict** as that batch's entity writes rather
than in an input of its own, so one judgement lands as one atomic step-boundary application under
one `batchId` (§7.6). A separate input could tear against the entity writes formed from the same
evidence.

The authored `common_knowledge` is installed at world creation alongside `world_rules` and the map
(`convex/init.ts`), not through an input. It is configuration the world is built from rather than
something that happened in it, and routing it through an input would mean a second writer for the
one document whose entire guarantee is that it has exactly one.

#### What this does not do

The god's evidence is still only what §7 gives it: concluded interactions, read back from
`stateAudit` rows with `field: 'state'`. **Engine events are not in that channel.** A human player
joining the world writes no state, so it produces no audit row, so the god never sees it — which
means common knowledge records a fact like *a stranger is in town* only once some actor has met
the stranger and written it into its own state. That is the §6.4-consistent behaviour and it is
the deliberate v1 position (§13 A8), not an oversight; widening the evidence channel is additive
and invalidates nothing here.

The god's own write is filtered back out of its next batch
(`convex/agent/god.ts:loadGodBatch`). Without that it would arrive as evidence with no
`entityDescriptions` row, be labelled a prop by the fallback, be judged against a contract it was
never written to, and be rewritten — the god reading its own output as input.

---

## 6. Interaction

Four interaction shapes. Only the first two are conversations in the engine's sense.

### 6.1 Actor ↔ actor (tiers a–a, a–b)

Both sides see: `system + description + state + retrieved memory + world_rules`. Each
turn's output becomes the other's input. The first input is the initiating agent's stated
intent — "I want to ask Alice why the mill is running hot" — produced by the same decision
call that chose the target.

On conclusion, **each side makes one call** that emits, together:

```json
{
  "state": "<rewritten prose state, carrying its own physics tag if it has one>",
  "memory": ["<new memory entry>", "..."],
  "reason": "<why the state changed, one sentence>",
  "tags": { }
}
```

One call, not four. `reason` is mandatory — §9.3 explains why. `tags` is optional and
described in §9.4. There is no `physics` field: it moved inside `state` (§4.3).

A fixed actor (tier b) uses this path unchanged. It simply never initiates, and its
`physics.blocks_movement` is typically `true` and stays so.

### 6.2 Actor → prop (tier a–c)

One-way. The acting agent sees `system + own description + own state + own memory + the prop's
description + the prop's state`, and emits the same envelope as §6.1 plus a nested update
for the prop:

The prop's `behavior` travels with its description here, and has to: a prop writes no state of
its own, so a rule about how this thing behaves is only ever read by the actor acting on it.

```json
{
  "self":   { "state": "...", "memory": ["..."], "reason": "..." },
  "target": { "state": "state: open\n\n...\n\n<unblocked/>", "reason": "..." }
}
```

The prop makes no call of its own. It has no memory to write. This is where a locked door
becomes an open one, and it is the reason the physics tag lives in the prose: the same sentence
that says "Alice forces the door" is the one that tells the pathfinder the door no longer
blocks.

### 6.3 Human ↔ actor

**Already implemented in the framework.** `Player.join` creates a player with
`human: tokenIdentifier` and no `Agent` record (`convex/aiTown/player.ts:165`), so a human
is a distinct entity from the start and is never a "taken-over" agent. Agents already invite
humans — humans are unfiltered in `otherFreePlayers` (`convex/aiTown/agent.ts:82`) — and
already accept human invitations unconditionally (`convex/aiTown/agent.ts:114`).
Accept and reject exist as engine inputs (`convex/aiTown/conversation.ts:83,106`) with UI
wired at `src/components/PlayerDetails.tsx:102-113`.

What this branch adds is only that the agent side of the conversation writes prose state and
memory on conclusion, exactly as in §6.1. The human side writes nothing.

### 6.4 Target selection

The single largest behavioural change from stock AI Town. Today `agentDoSomething`
(`convex/aiTown/agentOperations.ts:88`) chooses among three branches using `Math.random()`
and timers, and `wanderDestination` picks a uniform random tile. Here it becomes a model
call that sees `system + description + state + memory + a manifest of nearby interactable
entities + world_rules` and emits one of:

```json
{ "action": "approach", "target": "<entity id>", "intent": "<prose>", "reason": "..." }
{ "action": "wander",   "anchor": "<anchor id>", "reason": "..." }
{ "action": "idle",     "duration_ms": 60000, "reason": "..." }
```

This runs in a Convex action, outside the tick path, and re-enters through an input — so it
is replay-safe by construction and adds no nondeterminism source (§10).

`approach` still resolves through the existing A* pathfinder. The model chooses *where* and
*why*; it never computes a route.

**Amended (`08` §7 D1): the manifest carries identity, not state.** An actor cannot see
another entity's prose state before an interaction begins — it learns state only from the
interaction itself, and for a prop only once it is being interacted with. The manifest holds
id, name, tier, a prop's immutable `description`, and roughly how far away the thing is;
never `state`, `memory`, or `physics`.

This is a world rule with consequences worth stating. An agent cannot react to visible state
— a character who is obviously distressed, a door that is obviously open — because it has no
channel to perceive it. `physics.blocks_movement` leaks through pathfinding failure and
nothing else does. If a world needs visible state, that is a change to this rule, not a
change to the budget.

**Amended: common knowledge is the one deliberate exception** (§5.3). Every actor reads one shared
document without having learned anything in it. The rule survives because of what may be written
there rather than because of who may read it: only facts every inhabitant would already know. It
is a channel for *the town heard about the boat*, never for *Alice is distressed*.

`09-agent-loop.md` specifies the manifest, the gates around this call, and how an `approach`
becomes an interaction.

> **Note on an upstream bug.** `findConversationCandidate`
> (`convex/aiTown/agent.ts:337-362`) pushes the *initiating* player's own position onto
> every candidate, so its "sort by distance and take the nearest" is a no-op and it returns
> whichever player is first in `Map` insertion order. Since §6.4 replaces this function
> entirely, the bug goes away — but note that the `Map`-order dependence it relies on is
> exactly the replay hazard `02` §7 warns about, and it is live in the code today.

---

## 7. The god agent

An overseer with authority over every entity's state. Invisible, never rendered, no
position, no entry in `world.players`. It exists as a Convex action plus two tables.

```json
"god": {
  "persona": "You are the keeper of this world's coherence. You intervene rarely and only to prevent contradiction.",
  "hidden_rules": "The mill is haunted. Nobody in the town knows this.",
  "max_transcript_turns": 40,
  "gate": { "enabled": true }
}
```

The god has **two jobs**, not one: judging entity state against the rule, and keeping the world's
common knowledge current (§5.3). §7.7 says why both run through one gate and one verdict.

`hidden_rules` (added by `08` §7 D1) is prose the god sees and no actor ever does. It is where
world facts that characters must not know are written, and it is why `world_rules` needs no
per-actor filtering (§2).

**v1 placeholder (`08` §7 D7).** The god's shape is *state + rule → judgement, and a fix if
they conflict*. Until a world file carries a real story, the rule it judges against is the
§5.1 format contract rather than `world_rules` + `hidden_rules`. The pipeline is unchanged —
gate, transcript, batch, step-boundary application — and only the rule text is swapped when a
story exists.

Two constraints on that placeholder, so it stays a simulation of the real thing rather than a
formatter with a transcript. **Conformance checking belongs in the gate, not the
intervention**, so the intervention still fires rarely and its hit rate is still informative.
And the god is not the first line: §5.1's re-ask already ran in the action, so the god sees
only what survived one repair attempt. A god that fires on most writes is a signal the gate is
in the wrong place, not that the world is broken.

### 7.1 Shape

A long-running conversation in appearance; an append-only transcript in fact. It waits for
input, receives a short summary of a concluded interaction plus the current state of the
affected entities, and decides between doing nothing (the overwhelmingly common case) and
forcing an update.

### 7.2 There is no persistent LLM session

Convex actions are bounded. AI Town's own engine loop self-restarts every
`ENGINE_ACTION_DURATION = 30s` (`convex/aiTown/main.ts:104-114`). The god's "conversation"
must therefore be a stored transcript, re-sent on each call, with prompt caching. It is not
an in-memory session and cannot be.

### 7.3 The transcript is a **separate table**, and is not replay state

```
godTranscript: {
  worldId:      Id<'worlds'>,
  seq:          number,
  role:         'event' | 'verdict',
  content:      string,
  batchId?:     string,
  inputNumber?: number,      // join key to the input log, set on verdicts
}
  .index('bySeq', ['worldId', 'seq'])
```

Do **not** reuse the `messages` table. Four concrete reasons:

1. `messages` requires `conversationId` and `author: playerId`, both branded `GameId`
   strings validated by `parseGameId`. The god has neither, and faking them mints ids that
   other code will later validate.
2. `messages` is indexed `['worldId', 'conversationId']` and rendered by
   `src/components/Messages.tsx`. A synthetic conversation id risks the god's deliberations
   appearing in the client, and the god is invisible by design.
3. `loadMessages` (`convex/agent/memory.ts:230`) scans that table by conversation to build
   agent memory prompts. God rows would sit one join away from entering an agent's context.
4. The god's turns are not `(author, text)` pairs. They are (batched event summaries in) →
   (verdict + reason + writes out). Flattening that into `text: v.string()` discards
   structure needed for analysis.

The deeper reason: **replay never calls a model, so it needs only the god's decisions —
which are inputs. The transcript exists solely to condition the live model.** It is a
rebuildable cache. Giving it its own table means it can be compacted, truncated, or
discarded without touching anything replay depends on.

For `a1.0`, cap it at `max_transcript_turns` in the style of `MAX_CONVERSATION_MESSAGES`.
One warning for when real compression is designed: for the god specifically, **the tail is
the wrong thing to keep.** Its early turns are where durable world facts get established; a
rolling window silently forgets them. Summarise-and-pin, do not truncate.

### 7.4 Batching must be recorded, not re-derived

"Everything that accumulated while I was busy" is a wall-clock-dependent set — its
composition depends on model latency. Persist the **formed batch** as the args of one input.
Replay reads it back verbatim. Re-deriving the batch at replay time produces a different
batch and silent divergence.

Each batch gets a `batchId`, carried on both the `event` rows and the resulting `verdict`
row, so a verdict can always be traced to exactly the evidence that produced it.

### 7.5 Two-stage gating

The god sees every interaction conclusion and is **serial by construction** — one
transcript, one queue. At twenty actors this is the throughput ceiling, not the engine.

Since its answer is "do nothing" in the overwhelming majority of cases, split it:

- **Gate.** Small model, short prompt, the batch summary only, no transcript. Emits
  `{ "intervene": false }` or `{ "intervene": true, "why": "..." }`.
- **Intervention.** Full transcript context, entity states, world rules. Only runs when the
  gate fires.

The gate is what makes the god affordable. Build it in the first version, not as an
optimisation later — retrofitting it means re-tuning a prompt that has already been tuned
against full context.

### 7.6 Authority and ordering

The god writes `entity.*.state` and `entity.*.physics` from outside the world file. Two
rules:

1. **God writes apply at a step boundary, after every other write in that step,
   last-write-wins.** Without this, a god verdict can land mid-cascade and race an
   interaction's own state update.
2. **Every god write carries a `reason` and is written to the audit table (§9.3) with its
   `batchId`.** The god is the single largest threat to the debuggability that `02` §8 calls
   the instrument of this platform. "Why did Alice turn hostile" must always have an answer,
   and with no condition trace the `reason` string is the only thing that can provide it.

### 7.7 The second job: common knowledge

**Added by `08` §7 D8.** The god is the only writer of the world's common knowledge (§5.3), and
that work is folded into the existing two-stage pipeline rather than given a third stage.

**The gate asks two questions, not one.** Does a document break the rule; and has anything in this
batch become true that everyone should know and is not written down yet. Either fires the
intervention, and the gate's `why` says which. The alternative — leaving common knowledge to the
intervention alone — was rejected because the intervention only runs when the gate fires, and the
gate fires on format breaches: two unrelated jobs sharing one trigger, with the rarer one deciding
for both. Common knowledge would have gone stale except on the batches where something else
happened to be malformed.

The cost of that is honest and worth recording: **the gate's hit rate now mixes two causes**, so
"the god fires on most batches" is no longer a single diagnosis. The `why` string is what keeps it
readable, and the trace records `commonKnowledge: true|false` on every verdict.

**Both halves ride in one verdict.** `godVerdict` carries `writes` and an optional `world`
(§9.2). One judgement, one `batchId`, one step-boundary application. The two are parsed
independently, so a malformed `writes` array does not discard a good common-knowledge write and
vice versa.

**Scoping differs between them, necessarily.** §7.6's rule that the god may only rewrite entities
that were in its own batch has no counterpart for common knowledge: there is one document and one
writer, so there is nothing to scope it against. What bounds it is the scope rule in the contract
(§5.3) — a prompt rule, not something the parser can check. That is a real asymmetry: the entity
half of a verdict is constrained structurally and the world half is constrained only by
instruction.

---

## 8. Storage architecture — three tiers

This follows directly from §1 and is the load-bearing consequence of the typed floor.

The world document is **rewritten in full every step**, at 1 Hz, via `ctx.db.replace()`
(`02` §9; `convex/aiTown/game.ts:saveStep`). Putting multi-kilobyte prose state into it
means rewriting all of it, for every entity, every second. That is both a document-size
problem and a write-amplification problem, and it would be the first thing to break at
scale.

The typed floor makes it unnecessary. The tick loop never reads prose, so prose never needs
to be in the world document.

| Tier | Contents | Write frequency | Replay role |
|---|---|---|---|
| **World document** | positions, `physics`, conversation membership, pathfinding, per-entity `stateVersion`, `commonKnowledgeVersion` | every step (1 Hz) | reconstructed by replay |
| **Prose tables** | `entityState`, `memories`, `memoryEmbeddings`, `godTranscript` | on change only | derived; rebuildable from the log |
| **Input log** | every mutation, with content | on change only | **authoritative** |

`stateVersion` is a monotonic integer in the world document pointing at the current row in
`entityState`. It is cheap to replicate every step and it gives the client a change signal
without carrying the prose.

`commonKnowledgeVersion` is the same integer for the world's one shared document (§5.3), which
lives in the same table under a reserved id. It is on the world rather than on an entity because
common knowledge is not an entity — see §5.3 for why that is the point rather than an accident.

```
entityState: {
  worldId:   Id<'worlds'>,
  entityId:  string,
  version:   number,
  state:     string,        // prose
  updatedAt: number,
}
  .index('byEntity', ['worldId', 'entityId', 'version'])
```

---

## 9. The input log, the audit table, and document size

### 9.1 What the framework actually records today

`02` §9 states: *"What an agent said is in the input log; we replay it without calling any
model."* **The second half of that sentence is not true of the current code**, and the plan
depends on knowing it:

- `insertMemory` (`convex/agent/memory.ts:273`) is an `internalMutation` invoked directly
  from the `agentRememberConversation` action. It writes straight to `memories` and
  `memoryEmbeddings`. The only thing reaching the log is `finishRememberConversation`, whose
  args are `{agentId, operationId}` — no content whatsoever.
- Dialogue is the same. `agentSendMessage` (`convex/aiTown/agent.ts`) inserts into
  `messages`, then sends `agentFinishSendingMessage` with args
  `{agentId, conversationId, timestamp, operationId, leaveConversation}` — no text, not even
  the `messageUuid`.

Stock AI Town survives this because its engine state machine never reads message text, only
`lastMessage.timestamp`, `numMessages` and `isTyping`. Replaying inputs alone reproduces
every position and every conversation structure exactly, just silently.

**This branch does not survive it**, because here prose state and memory feed back into
engine-visible behaviour through §6.4's target selection. Every such mutation must be an
input.

### 9.2 No schema migration is required

`convex/engine/schema.ts:17` declares `args: v.any()`. The input table already accepts
arbitrary JSON. What is needed is new input *handlers*, not a new table shape:

| Input | Args | Written by |
|---|---|---|
| `entityUpdateState` | `{entityId, state, memory[], reason, tags?, operationId}` | §6.1 / §6.2 self-update |
| `entityUpdateTarget` | `{actorId, targetId, state, reason, operationId}` | §6.2 prop update |
| `agentDecideAction` | `{agentId, action, target?, anchor?, intent?, reason, operationId}` | §6.4 |
| `godVerdict` | `{batchId, writes: [{entityId, state, reason}], world?: {state, reason}, operationId}` | §7, §7.7 |

Physics is absent from all four. The handler derives it from `state` (§4.3), which is why a god
verdict moves a door's physics without the god knowing physics exists. Each handler still accepts
an optional `physics` **patch** — partial keys, not a whole value — as an explicit override for a
writer that knows something the text does not; nothing sends one today.

Every one carries a `reason`. Every one is applied at a step boundary. `godVerdict` applies
after the others in its step (§7.6), and its optional `world` — the only write path to common
knowledge (§5.3) — applies after its own entity writes.

### 9.3 The audit table

Derived from the inputs, written by the same mutation that applies them, **never read by the
engine**, and explicitly not part of replay. It exists so a human can answer "how did this
entity get here" without reconstructing it from the log.

```
stateAudit: {
  worldId:     Id<'worlds'>,
  entityId:    string,
  seq:         number,
  field:       'state' | 'memory' | 'physics',
  source:      'self' | 'interaction' | 'god',
  before:      string,
  after:       string,
  reason:      string,        // mandatory
  inputNumber: number,        // join key back to the authoritative log
  batchId?:    string,        // set when source is 'god'
  tags?:       any,
}
  .index('byEntity', ['worldId', 'entityId', 'seq'])
  .index('byInput',  ['worldId', 'inputNumber'])
```

Because it is derived, it can be rebuilt from the log, backfilled after a schema change, or
dropped entirely without consequence for correctness. It is the replacement for the
condition trace of `02` §8: there are no conditions to trace, so the `reason` string carries
that weight instead. That is why it is mandatory on every write and not optional.

### 9.4 The `tags` bag

An optional, **unvalidated** key-value object emitted alongside a state update. Never read
by the engine. Never referenced by any prompt. It exists purely so that runs are comparable
across experiments.

This deliberately inverts `04` §14.3, which argued against `emit_event` on the grounds that
typed state changes were already reconstructable from the log and a second progress
vocabulary would be redundant. That argument depended on state being typed. With prose
state, a diff between two runs is not comparable, and there is no other structured record.
The argument flips, and the instrumentation channel earns its place.

Keep it unvalidated. The moment `tags` gets a schema and something starts branching on it,
this branch has quietly reinvented `vars` and should say so out loud rather than drift.

### 9.5 Convex document size — the 1 MB cap

Convex documents cap at 1 MB. Three places this bites, with the fix for each:

| Where | Risk | Fix |
|---|---|---|
| **World document** | Prose state × N entities, rewritten every step | §8: prose never enters the world document. Only `stateVersion` does. This is the primary defence and it is structural, not a workaround. |
| **`inputs.args`** | A single `entityUpdateState` carrying a full state doc plus several memory entries; a `godVerdict` carrying writes for many entities at once | Two defences. First, `state_max_chars` and `memory_max_chars` (§5.1) bound the common case — at 600 + 4×240 chars an update is ~2 KB and the cap is three orders of magnitude away. Second, for payloads that still exceed a threshold, store the blob content-addressed and put the hash in `args`. |
| **`godTranscript` rows** | A batch summary covering many concurrent interactions | Same content-addressed escape hatch. Cap `max_transcript_turns`. |

The content-addressed escape hatch:

```
blobs: { hash: string, content: string }
  .index('byHash', ['hash'])
```

An input whose payload exceeds the threshold stores `{..., stateRef: "<sha256>"}` instead of
`{..., state: "<prose>"}`. The log remains authoritative because the hash is; replay resolves
hashes through `blobs`. `blobs` is append-only and content-addressed, so it deduplicates
naturally and never needs invalidation.

**Set the threshold well below the cap** — 64 KB is generous — so the hash path is exercised
in normal operation rather than discovered the first time a model produces an unusually long
state doc in production.

### 9.6 Retention

`convex/crons.ts` shipped with `inputs`, `memories` and `memoryEmbeddings` in
`TablesToVacuum`, running daily against `VACUUM_MAX_AGE` (two weeks). The file's own comment
said it plainly: *"Inputs aren't useful unless you're trying to replay history."* The system
as shipped destroys the thing this design rests on.

`TablesToVacuum` is now **empty**. Re-enable entries selectively only once snapshots exist
and a retention policy has been decided, and never for `inputs`.

### 9.7 Input volume and the OCC hotspot

`engineInsertInput` (`convex/engine/abstractGame.ts:129-145`) allocates the next input number
with `.order('desc').first()` on `byInputNumber` for **every** insert — a serialization point
on a single index. The codebase already hits it: `convex/aiTown/agentOperations.ts:147-149`
carries the comment *"We hit a lot of OCC errors on sending inputs in this file"*, mitigated
with `sleep(Math.random() * 1000)` jitter.

Routing every state update, memory write, decision and god verdict through inputs multiplies
that traffic several-fold. **Load-test this before content work begins**, not at twenty
actors in a demo. If it does not hold, the fix is a per-world counter in the world document
or a sharded allocator — but measure first.

---

## 10. Determinism

The claim is unchanged from `02`: a run is exactly reproducible from its seed and its input
log, without calling any model. What changes is the shape of the surface.

**Removing the typed story layer removes divergence sources rather than adding them.** The
fixed iteration order, sorted-by-id traversal, and step-boundary evaluation discipline of
`02` §7 exist to make a *condition evaluator* deterministic. There is no condition
evaluator here.

| Source | Status | Fix |
|---|---|---|
| `Math.random()` invite-accept roll (`agent.ts:114`) | inherited | seeded PRNG in the world document |
| Pathfinding backoff jitter (`player.ts:154`) | inherited | seeded PRNG |
| Random spawn position (`player.ts:193-194`) | inherited | seeded PRNG |
| Random initial facing (`player.ts:211`) | inherited | seeded PRNG |
| `crypto.randomUUID()` ×3 (`agent.ts:174,195,222`) | inherited | seeded PRNG |
| `Map` iteration order | inherited | sort by id everywhere it is observable |
| **Step-boundary placement** | **not in `02`'s table** | see below |
| **God batch composition** | new | §7.4 — record the formed batch |
| God verdict arrival time | new, **already solved** | inputs bind to ticks via persisted `received` (`abstractGame.ts:44-47`); arrival is a pure function of recorded data |
| All model outputs | new, **already solved** | recorded as input args (§9.2); replay never calls a model |
| Random wander destination / activity choice | **eliminated** | replaced by §6.4 model decisions, which are inputs |
| Condition evaluation order | **eliminated** | no conditions |

**Step-boundary placement.** `runStep(ctx, now)` takes wall-clock `now`
(`convex/aiTown/main.ts:103`), and `now` determines how many 16 ms ticks fall inside each
step. Two things key off step boundaries rather than ticks: `beginStep()`, which resets the
historical-location buffers (`convex/aiTown/game.ts:165-175`), and — in this branch — the
application of god verdicts (§7.6). Feed a different `now` on replay and the boundaries
move. The fix is cheap if done now: have the periodic snapshots record each step's
`(lastStepTs, currentTime)` pair, and drive replay from those rather than from a synthetic
clock.

Note that simulated time here *is* epoch milliseconds — `currentTime` advances in 16 ms
increments and is clamped so it can never run past wall clock
(`abstractGame.ts:29-31, 70-73`). There is no tick-number-to-wall-clock conversion anywhere
in the system.

---

## 11. What is deliberately absent, and what that costs

| `04` construct | Here | Cost |
|---|---|---|
| `vars` | none | Nothing branches on a typed value. Anything that must be measured across runs goes in `tags` (§9.4), which nothing reads. |
| Condition grammar (§4) | none | The engine cannot gate on state. Every gate is a model decision. |
| Effect vocabulary (§5) | four input handlers (§9.2) | Writes are no longer statically enumerable, so the dependency graph of `04` §11 does not exist. |
| Transitions (§7) | prose in prompts | No `once`, no priority, no cascade. An entity's behaviour is whatever the prompt elicits. |
| `outcomes` map + classifier (§8) | folded into the state-update call (§6.1) | The `04` §8 outcome contract was the bridge from free text to typed branching. With no typed branching there is nothing to bridge, so the second constrained call disappears — a real cost saving. |
| Episodes (§9) | `world_rules` prose + the god (§7) | No mechanical episode authority, no `entity_overrides`, no `force_state`. The god is the only global authority, and it is a model rather than a table. |
| Scripts (§10) | none | No deterministic authored dialogue at all. |
| Fact dependency graph (§11) | none | No wake classes, no polled set, no dead-condition diagnostic. |
| Validation rules (§12) | ids, anchors, sprites, tier consistency | ~20 of `04`'s 24 rules have nothing to check. Quality control moves from load-time validation to prompt engineering and evals. |
| Condition trace (`02` §8) | mandatory `reason` + audit table (§9.3) | Direct analogue, but prose rather than structured, and only as honest as the model writing it. |

The load-bearing consequence, stated plainly: **`04`'s closed grammars exist so a writer
agent can be constrained by JSON Schema and repaired by a load-time validator (`02` §2, §4).
Prose cannot be constrained that way.** On this branch, the effort that would have gone into
U5 (loader/validator) and U11 (generation + repair) goes into prompts and evals instead. It
is not less work; it is differently shaped work with a weaker safety net and a higher
ceiling.

---

## 12. Validation rules

Everything statically checkable, which is much less than `04` §12.

**Structural**

1. `format_version` is `a1.0`. A `2.0` file is rejected, not migrated.
2. All entity ids are unique across the whole `entities` array regardless of `kind`.
3. Every referenced `anchor` exists in the loaded map.
4. Every referenced `character` and `sprite` exists in its table.

**Tier consistency**

5. `mobile` is required on `kind: "actor"` and forbidden on `kind: "prop"`.
6. `kind: "actor", mobile: true` requires `character` and `spawn`.
7. `kind: "actor", mobile: false` requires `sprite` and `anchor`.
8. `kind: "prop"` requires `anchor` and has no `initial_memory`. A prop is described like
   anything else; a thing that remembers is a fixed actor, not a prop.
9. `initial_memory` requires `initial_state` — an entity cannot remember without being able
   to be affected.
10. An entity with neither `initial_state` nor `description` is decoration and belongs in the
   map, not here (`07` §8 rule 8).

**Budgets**

11. Every `initial_state` is within `state_contract.state_max_chars`.
12. Every `initial_memory` entry is within `state_contract.memory_max_chars`.
13. `world_rules` and every `description` are non-empty — **warning** if under 40 characters,
    since a one-word description is almost always an authoring slip.
14. `common_knowledge`, if present, is within the same budget every state document gets. Checked
    at load because nothing at runtime will re-ask on the author's behalf.
15. No entity claims the id `__world__` — it is the reserved key for common knowledge (§5.3), and
    an entity holding it would share a row namespace and overwrite its versions.

**God**

16. `god.persona` is non-empty and `god.max_transcript_turns` is at least 4.

Errors block loading. Warnings surface to the author. There is no repair loop, because there
is no schema to repair against.

---

## 13. Open questions

Ordered by how much they would cost to get wrong.

**A1. Does prose state actually stay stable over a long run?**
This is the central bet and it is untested. The failure mode is drift: after fifty rewrites,
an entity's state is a rambling essay that no longer resembles the format, and its behaviour
follows.

**Amended (`08` §7 D6).** There are now three defences, not two: `description` immutability
(§4.2), the length budget (§5.1), and the section structure — which is the strongest of the
three, because a labelled section survives blurring that free prose does not — the *contract*
still asks for those sections even though the parser no longer tries to tell them apart (§5.1).
The original plan was a synthetic spike run before anything else was built. It is now a **query
over production data**: §5.1's parser writes a conformance record into `stateAudit.tags` on every
state write, so block count, head-state token, word count and retry rate are answerable at any
point in any run, with no separate harness. The question stays open; what changed is that
answering it no longer blocks.

**A2. Is the god enough authority, or does the world need episodes?**
`04` §9 argues episodes are global authority over entities. Here the god is the only global
authority and it is a model, which means world-level story progression is as reliable as one
prompt. Cheap fallback if it is not: `world_rules` becomes an ordered array of prose phases
with the god responsible for advancing between them.

**A3. What does the god see, and how much does it cost at scale?**
`02` Q8 was never answered and this branch multiplies it. The gate (§7.5) is the mitigation,
but the gate's own cost is linear in interaction volume and the god is serial. Size this
before committing to twenty actors.

**A4. Can two agents' prose states contradict each other, and does anyone notice?**
Alice believes she told Bob about the mill; Bob's state says nobody told him. No mechanism
detects this. The god is the intended answer, but it only sees interaction summaries, not
pairwise consistency. Possibly this is acceptable — humans contradict each other — but it
should be a decision rather than an accident.

**A5. What is the human player's state?**
Agents write prose state about themselves after an interaction. Nothing writes state about
the human. Should agents maintain a prose model of the player, and if so is it per-agent
(scattered, realistic) or shared (coherent, wrong)? This is the `02` Q1 scope question in a
new form.

**A6. Retention, now that nothing is vacuumed.**
`inputs` grows without bound and is now never cleaned (§9.6). At what point does a long run
need snapshot-plus-truncate, and what is the snapshot format? This blocks nothing today and
blocks everything eventually.

**A7. Do we need `initiates` split from `mobile`?**
§3.3 defers it. The trigger to revisit is the first world file that wants a fixed entity to
hail a passer-by — at which point the engine needs an entity-to-entity proximity signal it
does not currently compute.

**A8. Should the god see engine events, not just concluded interactions?**
Its batch is built from `stateAudit` rows with `field: 'state'` (§7, `loadGodBatch`), so its whole
picture of the world is what entities wrote about themselves. Anything the engine does and no
entity notices — a human joining, a player crossing into a place, a conversation timing out — is
invisible to it. For common knowledge (§5.3) this is defensible and arguably correct: the world
learns things because someone noticed them, which is the §6.4 rule holding rather than being
worked around. But it is a *consequence* of how the batch is built rather than a decision anyone
made, and the first world that wants "the gates closed at dusk" recorded will need it. The fix is
additive — a second event source feeding `loadGodBatch` — and the constraint to keep if it is
built is that engine events are god **inputs** and never bypass it.

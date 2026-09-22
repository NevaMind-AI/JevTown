# Frontend Authority and the Storage Schema

`parallel to docs/10` · `verified against dev@87c7b22, feat/agentic@a4e35e4`

**`10` and this document are two answers to the same question, and only one can be built.** `10`
decides that the backend is the sole authority over time and state, and derives a contract from
that. This document decides the opposite: the browser owns the simulation, and the backend is
reduced to storage plus a key-holding proxy for model calls.

Both are kept, in the same way `04` and `05` are kept — `10` is not superseded prose, it is the
branch not taken, and its §1 (the merge mechanics, the graft) and §4.2 (the RNG rule) apply verbatim
to either. Everything in `10` §3, §5 and §6 is replaced by this document.

This is the branch we are taking. §9 lists what is still open.

---

## 1. The decision

**The frontend is the single source of truth for world state and for the order of events.** The
backend appends what the frontend sends it, serves what the frontend asks for, holds the model API
key, and never executes simulation logic.

Four things follow, and they are the argument:

1. **Ordering stops being a problem rather than being solved.** There is one queue, in one runtime,
   with one clock. `10` §4.1's distinction between when an input was received and which step it
   lands on does not arise: the frontend stamps both order and time at the moment it decides. The
   time-of-init versus time-of-confirm question that shapes `10` §6 has no referent here.
2. **`MemoryWorld` and `LocalGame` stay where they are.** They produce events into a local queue
   instead of being lifted behind `tick()`. `10` §5.4's port does not happen.
3. **What is given up is real and bounded.** A world no longer runs with no browser attached, and
   multiplayer stops being an extension and becomes a rewrite. §8 argues these are acceptable here
   and names the one that is irreversible.
4. **Durability is a batch, not a step.** The frontend accumulates events and state and ships them
   every few seconds. A crash loses the last unacknowledged batch. §4 makes that bound true rather
   than merely hoped for.

---

## 2. Why this is cheaper than `10` assumed

Two facts about the code that were not visible when `10` was written.

### 2.1 This branch's simulation core is already portable

`inputHandler`'s signature is `(game, now, args) => Return` — synchronous, no `ctx`
(`convex/aiTown/inputHandler.ts:4-7`), and `convex/aiTown/game.ts:44-52` records that this is
deliberate. The consequence is that Convex coupling inside `convex/aiTown/` is concentrated in four
files:

| file                 | `ctx` uses |
| -------------------- | ---------- |
| `game.ts`            | 26         |
| `main.ts`            | 15         |
| `agentOperations.ts` | 6          |
| `agent.ts`           | 2          |

The other ~3,900 non-test lines — `player`, `conversation`, `movement`, `entity`, `entityInputs`,
`worldFile`, `world`, `ids`, `location`, `collisionOverlay` — are pure deterministic code that runs
in a browser unmodified. The engine was written to be relocatable and nobody had noticed.

This is what makes the direction viable at all. Moving the agentic simulation into the frontend is
not a port of 4,000 lines; it is deleting a driver (`game.ts`'s Convex half, `main.ts`,
`convex/engine/`) and attaching the remainder to an existing loop.

### 2.2 `takeDiff` already exists

`convex/aiTown/game.ts:317` already computes a state diff per step. The batch payload is not a new
mechanism to design; it is an existing one redirected from `saveDiff` to the network. §7 argues we
should not actually use it, but the option is free.

### 2.3 What the decision deletes

Not simplifications — deletions. Nothing takes their place.

| deleted                                                                          | why it existed                          |
| -------------------------------------------------------------------------------- | --------------------------------------- |
| `10` §6 entire: `setHeading`, ray synthesis, the proposed-stop clamp, prediction | server owned the journey                |
| `HistoricalObject`, `historicalLocations`, the quantise→delta→RLE→varint buffer  | client replayed server-recorded samples |
| `useHistoricalTime`, `useHistoricalValue`                                        | same                                    |
| `convex/engine/` (681 lines): `abstractGame`, `engines`, `steps`                 | server drove time from a wall clock     |
| `10` §6.5's latency budget, M4 (`STEP_INTERVAL` → 200ms)                         | round-trip was in the movement path     |
| `worldStatus.lastViewed` heartbeat and the idle-world cron                       | server needed to know if anyone watched |

`steps` is worth naming separately. It existed because `runStep` derived its boundaries from the
`now` it happened to be handed, so replay needed the boundaries recorded
(`convex/engine/schema.ts:52-58`). Once the frontend stamps game time on every event, boundaries are
in the log. `10` §4.3's retention problem — ≈2.6M rows per world-month — is deleted, not managed. M1
goes with it.

WASD becomes an ordinary keyboard handler.

---

## 3. What this does **not** solve

`10` §5.4 conflated two jobs, and the distinction matters for estimating:

- **Runtime and ownership** — who ticks, who owns the clock, who logs, latency, prediction,
  playback. This decision deletes essentially all of it (§2.3).
- **Domain-model unification** — `prototype/world.ts` (1,847 lines: tavern, dining, commerce,
  schedules, performance) and `convex/aiTown/`'s world (players, agents, conversations, fixed
  entities) are two independent state trees with two command vocabularies. They still have to become
  one coherent world.

The second job is the same size wherever it runs. Frontend authority relocates it; it does not
cancel it. This is now the largest open question in the merge (§9 F1), and it replaces `10`'s M2 and
M4 at the top of the list.

---

## 4. The backend contract

Four rules. The first is the one that makes the architecture hold.

### 4.1 The backend never simulates

It is tempting to say the backend "recalculates state deterministically from the deltas." Do not.
There are two readings and only one is safe:

- **A delta is a state patch** — field-level, what `takeDiff` emits. The backend merges fields it
  does not understand. No engine, no determinism surface, no second world.
- **A delta is an event the backend interprets by running `tick()`** — which requires a second copy
  of the engine executing server-side. That is the duplication this decision exists to remove. It
  re-opens every concern in `10` §4.2 (`Math.random`, `Date.now`, `performance.now`), adds
  cross-runtime iteration-order and float divergence, and hands us a second world state that can
  disagree with the browser's silently.

**The backend stores. It never executes simulation logic.** If determinism needs to be testable —
and it does — get it from a headless Node replay in CI driving the same frontend engine module. That
module is already `ctx`-free (§2.1), so this costs nothing. It is a development tool and never an
authority.

`10` §4.2's lint rule still applies, now pointed at the frontend engine module instead of
`convex/aiTown/`. Bare `Date.now()` and `Math.random()` in simulation code are a replay divergence
in any runtime.

### 4.2 The frontend assigns `idx`

**`idx` is assigned by the frontend, never by a database sequence.** A server-assigned sequence
quietly restores server ordering, and a batch retried after a network timeout assigns a second range
to the same events.

The frontend assigns; the store enforces `UNIQUE(world_id, idx)`. **That constraint is the
idempotency key.** A replayed batch becomes a no-op instead of a duplication, which is what makes
retry-on-timeout safe, which is what makes "we lose at most the last batch" true.

### 4.3 Batches carry a version chain, and there is one writer

Two failures that are silent if unaddressed:

**Two tabs.** Two browsers open on one world interleave two divergent histories into one log. This
is not hypothetical; people leave tabs open. A frontend claims a lease (`world_sessions`,
`generation`) and heartbeats it; the backend rejects any batch bearing a stale session. The loser
goes read-only rather than forking.

**A dropped batch.** Every batch carries `(base_version → new_version)`. The backend rejects a batch
whose `base_version` does not match the version it has stored; the frontend answers a rejection by
sending full state rather than the next delta. Unacknowledged batches queue in IndexedDB and are
re-sent on reconnect.

A batch boundary is the only moment the world is consistent. A model call in flight at boundary time
is either included in that batch or deferred to the next — never split across both.

### 4.4 The client now drives the bill

Single-player means we do not care whether the client lies about world state. We do care that it
drives model spend. **This is the one authority that stays server-side**: per-world rate limit and
quota, enforced by the backend regardless of what the client asks for, and an `llm_calls` row per
call (§6.2) so the limit has something to read and so spend reconciles against Langfuse
(`convex/agent/tracing.ts`).

### 4.5 Wall-clock jumps: already handled, keep it that way

`dev`'s loop consumes elapsed time _before_ deciding whether to simulate it
(`dev: src/components/LocalGame.tsx:510-518`: `previous += elapsed` precedes the
`document.hidden || !document.hasFocus()` bail), and caps each tick at 160ms (`:541`,
`Math.min(activeElapsed, 160)`). A laptop waking from sleep therefore discards the gap rather than
simulating hours of game time — and, with agents attached, rather than firing a burst of model
calls.

This is load-bearing and currently incidental. Record it as an invariant before the agentic loop
lands: **elapsed real time is consumed unconditionally and simulated conditionally.**

> `10` §2 cites `LocalGame.tsx:499`/`:576` and a ≤100ms quantum, and `prototype/world.ts:109` for
> `MemoryWorld`. `dev` has moved (`53772d5` → `87c7b22`): the file is 1,573 lines, the quantum is
> 160ms, and `MemoryWorld` is at `:139`. Cite against `87c7b22`.

---

## 5. Removing Convex

**It becomes possible, and it is a separate decision from §1. Do not take both in one change.**

The sharp version of the case for removal: the one Convex feature we are deleting is the one we were
paying for. Reactive query push is its distinguishing feature, and the 32 `useQuery` call sites in
`src/` exist entirely because the browser had to be told what the server computed. Under §1 the
browser already knows.

What is actually left needing a backend:

| need                    | current usage                                       | any Postgres           |
| ----------------------- | --------------------------------------------------- | ---------------------- |
| append-only ordered log | `inputs`                                            | `UNIQUE(world_id,idx)` |
| JSON documents          | `worlds`, descriptions                              | `jsonb`                |
| vector search           | 1 site (`convex/agent/memory.ts:179`)               | pgvector               |
| blob storage            | 2 sites, both `convex/music.ts`                     | bucket or `text`       |
| auth                    | **0** — all four `ctx.auth` calls are commented out | n/a                    |
| scheduler / crons       | 9 sites                                             | deleted by §1          |

**Recommendation: defer.** Put a thin repository interface in front of storage now, design the
schema to be engine-portable (§6 is written that way), and decide the engine after §1 lands green.
Coupling a storage migration to an authority flip makes both harder to verify and neither easier.

**If and when we do decide: Postgres.** An append-only ordered log with ranged reads is a
Postgres-shaped workload, `jsonb` has no document-size ceiling to design around, and pgvector puts
the embedding in the row — which collapses `memories` and `memoryEmbeddings` into one table, a split
Convex forced on us. §6 marks the two places the engine choice changes the schema.

---

## 6. The schema

Fourteen core tables and three optional, from twenty-four today. Written engine-neutrally; types are
indicative.

### 6.1 Core

```
worlds(id, name, status, created_at,
       current_idx, current_version)
  -- worldStatus folded in; it was a separate document for reactivity reasons that are gone.

world_definition(world_id, doc jsonb, loaded_at)
  -- The parsed world file: map, player/agent/entity descriptions, world_rules, god config.
  -- Replaces maps + playerDescriptions + agentDescriptions + entityDescriptions +
  -- worldDescriptions. Nothing mutates per tick; the frontend loads it whole, once.

events(world_id, idx, kind, game_time, wall_time, batch_id, payload jsonb)
  PRIMARY KEY (world_id, idx)
  -- The log. `idx` is frontend-assigned (§4.2) and the PK is the idempotency key.
  -- Both clocks are stored: game_time for the simulation, wall_time for debugging and cost
  -- attribution. Neither is reconstructible later.
  -- `kind` discriminates player input / agent decision / model result / god verdict, so the log
  -- is filterable without parsing payloads. Model outputs are events here, per docs/10 §4.

world_state(world_id PRIMARY KEY, idx, version, state jsonb, updated_at)
  -- One row. The current state, upserted per batch, guarded on version (§4.3). Resume reads
  -- this and replays nothing. See §7.

world_sessions(world_id, session_id, generation, claimed_at, heartbeat_at)
  -- The writer lease (§4.3). The table that stops two tabs corrupting a world.

batches(world_id, batch_id, from_idx, to_idx, base_version, session_id, received_at)
  -- The sync ledger. Without it, "what did we lose" is unanswerable, and the version guard has
  -- nowhere to live.
```

### 6.2 Prose, dialogue and agent memory

```
entity_state(world_id, entity_id, version, state text NULL, state_ref text NULL, updated_at)
  -- Unchanged from convex/prose/schema.ts. `state`/`state_ref` exclusive; oversized documents
  -- go to blobs and travel as a hash. See §7 for why this stays out of world_state.

blobs(hash PRIMARY KEY, content)
  -- Content-addressed, append-only, dedupes naturally, never needs invalidation.

conversations(world_id, conversation_id, creator, participants[], created, ended,
              last_message, num_messages)
  -- Completed conversations. Live ones are in world_state's JSON, as they are in the world
  -- document today. This is archivedConversations renamed and given its real job: a parent for
  -- messages, and the source for "when did A and B last talk".

messages(world_id, channel_kind, channel_id, seq, author_kind, author_id, text, message_uuid)
  -- interactionTurns merged in. It existed only because messages demanded a conversationId and
  -- a player-id author, and a fixed entity is neither (convex/prose/schema.ts:57-60). A
  -- polymorphic (author_kind, author_id) removes the reason. `message_uuid` stays as the
  -- frontend-generated idempotency key.

god_transcript(world_id, seq, role, content, batch_id, idx, through_idx)
  -- Kept separate, deliberately. Its rows are (role: event|verdict, content) and genuinely not
  -- (speaker, text) pairs. `through_idx` stays on the rows rather than in a mutable counter, so
  -- a truncated transcript loses history but never double-judges.

memories(world_id, player_id, description, importance, last_access, data jsonb, embedding)
  -- On Postgres the embedding is a pgvector column here and memoryEmbeddings disappears.
  -- On Convex it stays a separate table with a vectorIndex, as today.

embeddings_cache(text_hash PRIMARY KEY, embedding)
  -- Keep. It saves real money.

llm_calls(world_id, idx, purpose, model, prompt_tokens, completion_tokens, cost, latency, trace_id)
  -- New. §4.4's quota reads this, and it is how spend reconciles against Langfuse.
```

### 6.3 Optional

- **`state_audit`** — keep. Cheap, rebuildable from the log, explicitly outside replay, and "how did
  this entity get here" is a question we will actually ask.
- **`archived_entities(world_id, kind, entity_id, payload jsonb)`** — one table replacing
  `archivedPlayers` / `archivedAgents`. Or drop it and scan the log.
- **`music`** — two `ctx.storage` calls; keep or drop on its own merits.

### 6.4 Dropped

| table                        | why                                                          |
| ---------------------------- | ------------------------------------------------------------ |
| `inputs`, `engines`, `steps` | replaced by `events`; see §2.3                               |
| `worldStatus`                | folded into `worlds`                                         |
| `maps`, `*Descriptions` (4)  | folded into `world_definition`                               |
| `participatedTogether`       | a pure projection of `conversations.participants`; derive it |
| `interactionTurns`           | merged into `messages`                                       |
| `archivedConversations`      | became `conversations`                                       |

`participatedTogether` is read from `convex/agent/conversation.ts`, `convex/agent/memory.ts` and
`convex/world.ts`. All three build prompt context, which the frontend now does with both sides in
memory. If the derived query later turns out to be hot, materialize it then — with a reason.

---

## 7. World state and entity state

The question this answers: is world state a single huge JSON that wants a blob or a file, and should
entity state be folded into it?

**World state is not big, and it is not big because the current design already fixed this.**
`serializedWorld` carries `stateVersion` and `commonKnowledgeVersion` as _integer pointers_; the
prose itself never enters the world document (`convex/aiTown/world.ts:33-37`,
`convex/prose/schema.ts:9-12`). And `historicalLocations` — the one genuinely bulky field — is
deleted outright by §2.3.

What remains is scalars: positions, paths, agent state machines, conversation membership, entity
anchors and physics, plus `dev`'s side (balance, `storyTime`, inventory, seats, task progress,
dialogue flags). A populated world lands well under 200 KB.

**So: a database row, not a file.** And the corollary —

### 7.1 Do not use deltas

Batching already bought what the delta was for. We are no longer writing per _step_; we are writing
per _batch_, every few seconds. A full 200 KB upsert at that cadence is nothing, and it is
idempotent, self-healing on reconnect, and immune to the broken-chain fragility §4.3 otherwise has
to defend against. A delta chain buys a saving we no longer need and costs a correctness surface.

Revisit only if state crosses roughly 1 MB — and if it does, the answer is probably to split the
state, not to delta it.

`world_snapshots(world_id, idx, state jsonb)` — periodic anchors keyed by `idx` — are needed only
for **time travel** to an arbitrary past point. That is a debugging feature, not a resume
requirement, and `world_state` plus `events` is enough without it. Add anchors when we want the
feature.

### 7.2 Entity state stays a separate table

Not because of payload size — because of write rhythm, author and reader:

|          | world state                          | entity prose state                |
| -------- | ------------------------------------ | --------------------------------- |
| changes  | every tick                           | on change only                    |
| authored | by the simulation                    | by the model                      |
| read by  | the simulation, a snapshot at a time | humans, and prompt construction   |
| queried  | never independently                  | by entity, by version, as history |

Merge them and every batch's snapshot carries prose that did not move, while every prose edit
rewrites the world. The current split avoids exactly that, and the `state` / `state_ref` + `blobs`
overflow handles the one case where prose is genuinely large. Keep it.

The framing "world state = entity states + global vars" is elegant but conflates two tiers that
behave differently. Mobile actors are `Player` + `Agent` pairs that tick every frame; fixed entities
are anchored things whose meaningful content is prose and whose world-document footprint is an id,
an anchor, two physics booleans and a version integer (`convex/aiTown/entity.ts:42-53`). Same word,
different objects.

---

## 8. Consequences

**Hidden rules now ship to the client.** `worldDescriptions.godHiddenRules` — the rules no actor
ever sees (`05` §2, §7) — currently stays server-side because the god runs server-side. Under §1 the
client _is_ the god runner, so hidden rules travel to the browser. Nothing breaks in single-player,
but the guarantee changes category: **"hidden from actors" becomes a prompt-construction discipline,
not a transport boundary.** Write it down before someone assumes the old boundary still holds.

**The world stops having a life when nobody is watching.** Multiplayer was already out of scope;
this also rules out scheduled world events and "come back tomorrow and something happened." For a
five-game-day tavern story starting at 18:00, that is very likely irrelevant. It is also the only
choice here that is expensive to reverse, so it should be made deliberately rather than inherited
from §1.

**Server-side world inspection goes away.** Debugging a world means loading it in a browser — unless
we keep the headless Node replay of §4.1, which is the same module and is worth having for
determinism tests regardless.

**The device is now the ceiling.** The whole simulation plus N agents runs in one JS thread. Fine
now; it is what will bind first.

---

## 9. Open questions

| #   | question                                                                                                          | blocks         |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| F1  | Does the agentic world merge _into_ `MemoryWorld`, or sit beside it as a second pure module over shared entities? | §3, everything |
| F2  | Batch interval, and what forces an early flush (model result, scene change, user idle)?                           | §4.3           |
| F3  | Does the world block on a pending agent decision, or does the agent simply act late?                              | pacing, cost   |
| F4  | Is 20× compression still right when agents drive the world? (`10` M2, unchanged)                                  | cost           |
| F5  | Storage engine, and when we decide it (§5)                                                                        | §6             |
| F6  | Do we want time travel, and therefore `world_snapshots` (§7.1)?                                                   | §6.1           |

F1 is the real work. F3 is new to this architecture in visibility only — `10` had the same question
— but here it cannot be hidden behind step scheduling, because stalling the world to wait for a
model also stalls the player's keyboard.

`10`'s M1 and M4 are answered by §2.3. `10`'s M3 is answered by §8. `10`'s M5 (rebase or graft) is
unaffected and still open.

---

## 10. Sequence

1. Decide `10` M5. Graft or rebase accordingly, and merge per `10` §1 — that part is unchanged.
2. Lift `convex/aiTown/`'s pure core (§2.1) into a runtime-neutral module. No behaviour change; it
   should pass its existing tests in Node with no Convex import.
3. Add the lint rule of `10` §4.2 against that module. Before anything else moves.
4. Stand up the headless Node replay (§4.1) over it, as a determinism test.
5. Attach the module to `LocalGame`'s loop. Record §4.5's invariant as a test.
6. Build the backend contract: `events` with frontend-assigned `idx`, `world_state` upsert with the
   version guard, `world_sessions` lease, `batches` ledger, IndexedDB queue for unacked batches.
   Kill-the-tab-mid-batch is the acceptance test.
7. Delete §2.3's list. All of it, in one change, so nothing keeps a dead path warm.
8. Then F1 — unify the two world models — with everything else already settled.

Steps 2–5 are reversible and independently valuable. Step 7 is the point of no return.

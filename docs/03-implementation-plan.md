# Implementation Plan

Companion to `01-world-format-spec.md` and `02-design-rationale.md`.

The system decomposes into **11 units**. Most are pure functions with no engine or network
dependency, which means they can be built and tested in isolation and in parallel. The
ordering below is driven by dependencies and by risk — we front-load the two things that
would be expensive to discover late (determinism, and the outcome classifier).

**Two sequencing principles:**

1. **Determinism first.** Replay must exist before the story layer, so that story state is
   replayable from day one rather than retrofitted.
2. **Prove the risky bridge early.** The outcome classifier (U7) is the one component
   whose feasibility we have not validated. Spike it before building around it.

---

## Unit inventory

| # | Unit | Depends on | Pure? | Rough size |
|---|---|---|---|---|
| U0 | Determinism prerequisites | — | no | S |
| U1 | Snapshot + replay driver | U0 | no | M |
| U2 | Fact namespace + adapter | — | mostly | S |
| U3 | Condition evaluator | U2 | **yes** | S |
| U4 | Effect applier | U2 | **yes** | S |
| U5 | World file loader + validator | U2–U4 | **yes** | M |
| U6 | NPC state machine runtime | U3, U4, U5 | no | M |
| U7 | Outcome contract + classifier | U6 | no | M |
| U8 | Scripted conversation player | U3, U7 | no | M |
| U9 | Episode layer | U3, U4, U6 | no | S |
| U10 | Condition trace + inspector | U3, U6, U1 | no | M |
| U11 | Agent generation + repair loop | U5 | no | M |

`S` ≈ a few days, `M` ≈ one to two weeks, for one engineer. Objects (spec §9) reuse U6
wholesale and are folded into it rather than listed separately.

---

## Phase 0 — Determinism foundation

### U0. Determinism prerequisites
Make the existing engine reproducible before adding anything to it.

- Add a seeded PRNG whose state lives in the world document; thread it through `Game`.
- Replace the enumerated nondeterminism sources (rationale doc §9 table): 4 `Math.random()`
  call sites and 3 `crypto.randomUUID()` call sites.
- Fix a deterministic iteration order over entities (sort by id; do not rely on `Map`
  insertion order).
- **Acceptance test:** run a world twice from the same seed and input log; assert
  byte-identical world documents at every step. This test is the guardrail for everything
  that follows and should run in CI from here on.

### U1. Snapshot + replay driver
- Persist periodic world-document snapshots to an append-only table (the engine currently
  `replace()`s and keeps no history).
- Build an alternate driver that calls `runStep(ctx, now)` with synthetic time, for
  headless fast-forward.
- Replay API: load snapshot at step *N*, feed the input log forward, verify against the
  next snapshot.

**Why first.** Every later unit produces state. If replay lands after them, we retrofit
logging into each one and discover divergences with no tooling to diagnose them.

---

## Phase 1 — Pure core

These three units have no engine dependency, no network, no Convex. They are ordinary
TypeScript functions over plain objects, they are exhaustively unit-testable, and they can
be built in parallel by different people.

### U2. Fact namespace + adapter
- Define the readable path table (spec §3) and a `FactSource` interface.
- Implement the engine adapter: world document → fact reads.
- Implement variable scoping (`world` vs `player`) — **blocked on open question Q1**.
- Version the namespace independently of the engine.

### U3. Condition evaluator
- Parse and evaluate `all` / `any` / `not` / `at_least` / `always` and the single leaf form.
- Seven operators, no arithmetic.
- Export `readsVariables(condition): string[]` — needed by the validator, by the inspector,
  and by any future dirty-flag optimization.
- Evaluate against a `FactSource`, never against live engine objects.

### U4. Effect applier
- Implement the ~9 enumerated effects.
- Type/bounds checking and clamping on variable writes.
- Deterministic ordering; last-write-wins conflict resolution with a diagnostic.
- **Emit effects as engine inputs**, not direct state mutation — this is what makes the
  story layer replayable for free.

### U5. World file loader + validator
- JSON Schema for the whole format, with `$defs` and strict `enum`s.
- All 13 validation rules from spec §11, separated into errors and warnings.
- Clear, addressable error messages (`npcs[2].states[0].transitions[1].when`) — these are
  consumed by humans *and* by the U11 repair loop, so message quality is a feature.
- Split the immutable authored file from mutable runtime state (variable values, current
  states). Do not let them share a representation.

**Milestone A.** At the end of Phase 1 we can load, validate, and evaluate a world file
end-to-end in tests, with nothing running. Worth pausing here to write a real world file
by hand and see whether the format is actually pleasant.

---

## Phase 2 — Runtime

### U6. NPC state machine runtime
- State entry/exit, rule selection by priority with declaration-order tie-breaking,
  transition evaluation.
- `once` / `cooldown_ms` bookkeeping as rule metadata, held in runtime state.
- Hook evaluation into `beginStep` (1 Hz), not per tick.
- Objects (spec §9) reuse this same runtime; add them here as a distinct entity type —
  **not** as immobile NPCs, which would make them collision obstacles, slow pathfinding at
  every A* node expansion, and require exclusion logic in every agent code path.

### U7. Outcome contract + classifier — **spike this first**
The one genuinely unproven component. Before building it into the runtime, run a spike:
collect real agentic transcripts, classify them with a constrained call, and measure
accuracy against human labels.

- Constrained classification call, `enum` over the state's declared outcomes.
- `__abandoned` handling for walk-away, disconnect, and turn-limit — without this, NPCs
  deadlock in their current state.
- Confidence / `__unclear` handling — **blocked on open question Q3**.
- Emit the outcome as an engine input so it lands in the replay log.

**Why here.** If classification turns out unreliable, the answer is to lean on guided mode
rather than agentic mode — which is a *format-level* decision. Much better to learn that
before U8 and U9 are built on the assumption.

### U8. Scripted conversation player
- Node graph traversal, choice filtering by `when`, terminal outcome emission.
- Determinism is free here; scripted conversations add no new replay surface.
- **Blocked on open question Q2** (off-script player input in scripted mode).

### U9. Episode layer
- Episode entry/exit effects, transition evaluation, `npc_overrides`
  (`force_state`, `disable_states`).
- Reuses U3 and U4 entirely — episodes have no grammar of their own.

Small, and deliberately last of the runtime units: by this point the same condition/effect
machinery has been exercised by NPCs, so episodes are mostly wiring.

**Milestone B.** A hand-written world file runs end-to-end: NPCs converse in both modes,
outcomes drive transitions, episodes shift. Replay reproduces a full session exactly.

---

## Phase 3 — Tooling and generation

### U10. Condition trace + inspector
- Record per-evaluation leaf results (which leaves were true, which were false, which rule
  won, which transitions were considered and rejected).
- Surface it against the replay timeline: scrub to a moment, see why the episode did not
  shift.
- Volume control — tracing every leaf at 1 Hz across many NPCs adds up; sample or scope by
  entity.

Listed in Phase 3, but **start recording traces during U6** even if the viewer comes
later. The data is nearly free to capture and impossible to recover after the fact.

### U11. Agent generation + repair loop
- Generation prompt built from the JSON Schema plus the declared fact namespace and effect
  vocabulary — not from our engine types.
- Constrained/structured output against the schema.
- Validate → feed errors and warnings back → regenerate. The quality of U5's error
  messages determines how well this converges.
- Golden-file tests: a set of world files that must always validate, guarding against
  format regressions.

---

## Recommended order

```
U0 ──► U1 ──────────────────────────────────► U10
                                          ▲
U2 ──┬─► U3 ──┬─► U5 ──► U6 ──► U7 ──► U8 ─┤
     └─► U4 ──┘         │        │         │
                        └────────┴──► U9 ──┘
                                  U5 ──► U11
```

**Parallelisation.** After U2 lands, U3 / U4 / U5 can proceed concurrently — they are pure
and independently testable. U11 needs only U5, so schema and generation work can run
alongside Phase 2 runtime work.

**Critical path.** U0 → U2 → U3 → U5 → U6 → U7. Everything else can slot around it.

---

## Decisions needed before coding starts

These block specific units. Q-numbers refer to the rationale doc.

| Question | Blocks | Why it blocks |
|---|---|---|
| **Q1** — per-player vs global story state | U2, and all of Phase 2 | Determines the shape of runtime state. Retrofitting per-player scope touches every unit. |
| **Q3** — classifier confidence handling | U7 | Changes the outcome vocabulary itself (`__unclear`). |
| **Q2** — off-script input in scripted mode | U8 | Determines whether scripted mode needs a classifier too. |
| **Q4** — story facts visible in agentic prompts | U7 | Needs a new per-state field in the format; cheaper to add before world files exist. |

Q5–Q8 (episode authority, versioning, human tooling, cost model) do not block Phase 0–2
and can be resolved as we go.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Outcome classification too unreliable to drive story | medium | Spike in U7 before building on it; fall back to guided mode as the default. |
| Q1 answered late, forcing rework across Phase 2 | medium | Decide before U2. It is a one-meeting decision. |
| Condition debugging becomes the team's time sink | medium-high | U10, with trace capture starting in U6. |
| Format churn invalidates written world files | medium | `format_version` from day one; keep world files as immutable artifacts beside their replay logs (Q6). |
| Tile renderer becomes the bottleneck as maps grow | low near-term | Contained later swap to `@pixi/tilemap`; the map *data model* is sound and is what game logic couples to. |
| LLM cost/latency at experiment scale | unknown | Size it (Q8) before defaulting to agentic mode. |

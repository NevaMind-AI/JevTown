# The System One Decider

`extends docs/09 §4` · `specifies ACTION_DECIDER=jev`

`09` specifies the decision call: the engine builds a manifest of legal options, a model picks one,
and the choice re-enters through an input. It assumes a chat model, because that was the only kind
there was. This document specifies the alternative — the same decision asked of a **System One**
model (TypeSafe's Jev) — and records the options considered at each point where the two kinds of
model are not interchangeable.

The governing decision: **a second decider behind a flag, not a replacement.** Jev is a better fit
for the half of `09` §1 that matters most, and it cannot do a thing the current decision relies on.
Both statements are true, so both deciders stay.

---

## 1. Why this is a fit at all

`09` §1 states the principle: **the engine filters the option set; the model chooses within it.** It
was implemented as far as a chat model allows — `buildManifest` filters
(`engine/aiTown/manifest.ts:50`), and `parseDecision` treats a target outside the manifest as a
_parse failure_ rather than something to validate later (`agent/decide.ts:37-40`):

> the engine already decided what was legal, so a model naming something else has not made a legal
> move that needs checking.

That comment describes a hole the chat decider cannot close. A model asked for JSON can always name
`p:99`, and the only available answer is to throw the whole decision away and idle.

A Choice question closes it. The request carries the options; the answer is one of them, with a
probability for each and a calibrated confidence. The illegal answer is not caught — it is
unrepresentable. Everything else follows from that: the two manifest-membership branches
(`agent/decide.ts:62-68`, `81-87`) have no counterpart in `decisionFromAnswers`, and neither does
`extractJsonObject`, because there is no prose to dig an object out of.

Nothing about the engine changes. Same manifest, same `Decision` type, same `agentDecideAction`
input, same `targetIsStillLegal` recheck on the way in — the world still moves during a model call
(`09` §8), and that was never the model's problem to solve.

---

## 2. The flag

`ACTION_DECIDER=jev` (or `VITE_ACTION_DECIDER=jev` for the bundle) switches `agentDecide`. Default
is `llm`.

Named for the decision, not for the agent. An agent makes more than one call that could be answered
by a model of a different kind — the action decision is simply the first one where a System One
model fits — so the flag that selects this one leaves room for a sibling rather than claiming the
whole agent.

```
agent/config.ts        decider(): 'llm' | 'jev'
agent/operations.ts    the branch, inside one shared Tracer
```

A flag rather than a swap, for two reasons. The first is that the two deciders are not equivalent —
§3 is the list of what the Jev one stops producing, and that is a product decision that should be
reversible by an env var while it is being judged. The second is that a flag is what makes them
_comparable_: same world, same manifest, same trace shape, one variable. The trace carries
`decider:llm` or `decider:jev` as a tag, so a Langfuse run is never ambiguous about which answered.

---

## 3. Jev writes no prose

This is the whole cost, and it is worth stating exactly. Jev returns typed values — a choice, a
score, a 0–1 probability. It generates no text at all. Four fields of `Decision` were text, and
three of them are read by something downstream:

| Field         | Read by                                                                                                | Options                           | Taken      |
| ------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------- | ---------- |
| `intent`      | `agent.pendingInteraction`, then verbatim into the interaction prompt (`agent/interact.ts:80`, `:163`) | (a) hybrid (b) enumerate (c) drop | **(c)**    |
| `description` | `player.activity.description` (`engine/aiTown/agentInputs.ts:108`)                                     | (a) (b) (c)                       | **(b)**    |
| `emoji`       | the speech bubble (`src/components/Player.tsx:78`)                                                     | (a) (b) (c)                       | **(c)**    |
| `reason`      | the trace, and `problems` reporting (`agent/operations.ts:173`)                                        | (a) (b) synthesize                | synthesize |

The three options, spelled out:

**(a) Hybrid.** Jev picks; a chat model writes the prose for what it picked. Keeps every field and
every behaviour. Costs a second model call per decision, which makes the decision _more_ expensive
than the thing it replaced — the chat decider does this in one. Rejected on that alone: the point of
`09` §10's decision floor is that decisions are the thing an idle world spends money on.

**(b) Enumerate.** Turn the prose into an option set and let Jev choose from it: a fixed list of
intents per target tier, an authored activity table of description/emoji pairs. No extra call, and
it is what a System One model is _for_. But an activity table is exactly what `09` §4 deleted, and
the reason it deleted it stands: a fixed list of eight makes every agent do the same eight things.
Taken for `description` only, where the list is two items long and the two mean something (§4).

**(c) Drop.** Emit nothing and let the consumer handle its absence.

`intent` takes (c). `interactWithEntity` already branches on an empty intent —
`agent/interact.ts:79-81` falls back to "Act on it, and write what you and it are like afterwards" —
so nothing downstream needs to change to accept one. What is lost is real and `09` §4 names it:
_"`intent` is what makes the approach mean something by the time the agent arrives."_ Under this
decider an approach means only that the agent chose this target over the others, and the interaction
prompt discovers why from the agent's own state document instead. Enumerating intents (b) is the
obvious next move if that reads as flat; it is not done here because the right list is a content
question, not a wiring one.

`emoji` takes (c) too, and this one is visible: an idling agent under the Jev decider has no bubble.
There is no honest way to derive an emoji from a probability, and this branch will not pick one at
random to fill the space.

`reason` is **synthesized from the numbers** — `seek 0.83 · talk to Bob p=0.62 c=0.70`. Less
charming than a sentence, and strictly more informative: it is the distribution the choice actually
came from rather than the model's account of itself, which `05` §9.2 asked for and no model has ever
been able to guarantee.

---

## 4. Idle duration: two options, not a Score

`idle` carried `duration_ms`, a number Jev will not emit. Two ways to get one:

**A Score.** Two to ten ordered levels, mapped to durations in code. It is the type designed for a
position on a spectrum, and the levels would have to be described distinctly — "a few seconds",
"about a minute", "several minutes" — for the answer to mean anything. The objection is that there
is no reason to believe a model can bind a described duration to a wall-clock one reliably, and a
Score that is wrong in the middle of its range fails quietly.

**A two-option Choice.** Taken. `pause for a moment` → 5s, `stay put for a while` → 30s, both
hard-coded in `agent/decideJev.ts`. The model is asked the only thing it can actually judge —
whether anything nearby is about to change — and the durations stay a policy the code owns.

`IDLE_SHORT_MS` is 5s, which is exactly `MIN_DECISION_INTERVAL` (`engine/constants.ts:35`). That is
deliberate: a short idle means "ask me again as soon as you are allowed to", and the engine floor is
what "as soon as" means. `09` §10 worried that a model always picking a 5-second idle would burn the
budget without bound — under this decider that worry is smaller, because the floor still binds and a
Jev decision costs about two thousandths of a chat completion (§7), but the floor is still what
makes it bounded, not the model's restraint.

---

## 5. Request shape: flat or fan-out

The three actions have different payloads, so one Choice cannot express the decision. Two shapes
were considered.

**Flat.** One Choice whose options are every legal move at once: each target, each place, plus
`idle`. One question, one answer, the code maps the label back to an action. Simplest possible
mapping, and well inside the limits — a Choice accepts up to 255 options and a manifest holds a
handful.

Rejected because it destroys the measurement. Confidence over a single distribution that mixes "who
to talk to" with "where to wander idly" answers a question nobody asked: a 0.3 confidence could mean
the agent is torn between two people, or torn between talking to someone and going for a walk. Those
call for different behaviour and the flat shape cannot tell them apart.

**Fan-out.** Taken. Five questions in one request:

| id            | type   | asks                                                                 |
| ------------- | ------ | -------------------------------------------------------------------- |
| `seek`        | noul   | now is a moment to go to somebody or something, rather than stay put |
| `target`      | choice | of these, the one worth going to                                     |
| `roam`        | noul   | if not going to anybody, walking somewhere else beats staying put    |
| `place`       | choice | of these places, the one worth walking to for no particular reason   |
| `idle_length` | choice | if you stay, how long before it is worth looking around again        |

One round trip: Jev ingests the `state` once and evaluates every question against it in parallel, so
the extra questions cost a few tokens each and no latency. The `state` goes as an object — `you`,
`how_this_world_works`, `what_everyone_here_knows`, `your_state_right_now` — rather than as one
assembled system prompt, which is what the format is for. As in `decisionSystemPrompt`, another
entity's prose state is not among those fields (`05` §6.4).

Verified against a live `jev-1.13.0`, with Alice's state document saying she means to ask Bob:
`seek 0.81`, `target` → `talk to Bob` at `p=0.96 c=0.93`, `roam 0.48`, 610 input tokens. The
composition in §6 turns that into `approach p:2`.

A question whose option set would be empty is **omitted**, not sent empty: there is no Choice with
nothing to choose between, and `decisionFromAnswers` reads a missing answer as "no". That is the
degenerate case `describeTargets` handles with a sentence ("There is nobody and nothing you can go
to right now") and this shape handles by not asking.

---

## 6. Where the policy went

The fan-out's real payoff. `decisionFromAnswers` composes the answers in a fixed order — seek
someone out, else wander, else stand still — and the thresholds are four named numbers in one file
instead of tone in a prompt:

| constant                  | default | what it gates                                               |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `SEEK_THRESHOLD`          | 0.5     | whether to approach at all                                  |
| `ROAM_THRESHOLD`          | 0.5     | whether to wander at all                                    |
| `CHOICE_CONFIDENCE_FLOOR` | 0.2     | below this, a Choice is a coin toss and is not committed to |

Each gate **falls through** to the next rather than to an idle. A target the model cannot pick
between does not mean there was nowhere worth walking to, and collapsing straight to `idle` would
make low confidence look like contentment.

`idleFallback` changes character here. Under the chat decider it is an error path — the model
returned something unusable. Under this one it is the last branch of a policy: nothing cleared its
gate. The `problems` array still carries everything worth knowing (an option that was not offered, a
choice under the floor), and still does not discard a decision on its own.

---

## 7. The proxy: a third axis, not a provider

`getLLMConfig` (`server/model/llm.ts:105`) resolves two endpoints — chat and embeddings — and both
speak the OpenAI wire format, which is what makes `LLMProvider` a meaningful union. Jev speaks
neither: `POST /v1/systemone`, `{state, model, questions}` in, `{model, answers, usage}` out, no
messages, no `choices`, no streaming, no `stop`.

So it is a third independent axis with its own config and its own file (`server/model/jev.ts`),
following the `LLM_EMBEDDING_API_URL` precedent rather than being folded into `LLMProvider` as a
provider whose every branch is an exception. `detectMismatchedLLMProvider` is untouched: it infers a
chat provider from `EMBEDDING_DIMENSION`, and has nothing to say here.

| variable      | default                   | meaning                                        |
| ------------- | ------------------------- | ---------------------------------------------- |
| `JEV_API_URL` | `https://api.typesafe.ai` | the endpoint; set it to a gateway if using one |
| `JEV_API_KEY` | unset                     | the key, which stays in the proxy              |
| `JEV_MODEL`   | `jev-1.13.0`              | **pinned, not `jev-latest`**                   |

The pin is deliberate. An alias moves when a release ships, and the response's `model` field is the
only place the version that actually answered is recorded. A world one can replay is worth more here
than one that quietly gets a newer model's judgment.

Tracing needed one adaptation. `reportGeneration` puts `messages` in the span's input and the
completion text in its output; there is neither. The Jev span carries `{state, questions}` as input
and the typed answers — probabilities included — as output, which is strictly more useful than a
sentence was.

---

## 8. Cost, and the caps

Input tokens are billed at \$42 per billion; output tokens are free. A measured decision request was
425 input tokens, so a decision costs roughly **\$0.00002** — call it two thousandths of a chat
completion for the same job. Rate limits (1,200 requests/minute) are far above anything a demo world
generates, and the context budget (64k per request, 32k for `state` plus the longest question) is
far above anything a manifest and four questions will occupy.

The `/systemone` route counts against `MODEL_PROXY_CALL_CAP` and the per-world quota anyway. Both
are denominated in _calls_, not dollars, so they are now very blunt — but a runaway decision loop is
still a runaway loop, and the right response is to raise the cap for a long Jev run, not to exempt
the route from it (`11` §4.4).

---

## 9. What this does not change

- **Replay.** The decision still re-enters through `agentDecideAction`, so `05` §10 and the
  replayable-without-a-model property of `agent/operations.ts:24-26` are untouched. No new
  nondeterminism source; a Jev call is exactly as unrepeatable as a chat call was.
- **The manifest.** `buildManifest` and `targetIsStillLegal` are used unchanged.
- **`MIN_DECISION_INTERVAL`.** Still the one piece of pacing the model must not own (§4).
- **Conversations, memory, state documents.** All still chat-model work. This decider replaces one
  call of four (`agent/operations.ts:46-57`); a System One model cannot write a state document and
  is not trying to.
- **The god's _intervention_.** Still chat-model work, for the same reason — it writes documents.
  Its **gate** is not, as of §11; that is a separate flag over a separate call.
- **Embeddings.** Untouched, still Voyage.

---

## 10. Open questions

**F1. Gateway fidelity.** A first probe through a gateway returned `confidence 0.7` and
probabilities `0.8 / 0.2` where the published example for that input gives `0.78` and `0.85 / 0.15`,
both reporting `jev-1.13.0` — which read like a decimal of quantization in the middle. The decision
request above, sent through the same gateway, came back with `confidence 0.93`, `0.21`, and
probabilities `0.61 / 0.39`, so there is no quantization: the two-decimal resolution the thresholds
in §6 assume is really there. What the first probe's difference was remains unexplained, and
comparing one request against `api.typesafe.ai` directly is still the cheap way to rule the gateway
out before any threshold here is tuned finely.

**F2. Does the approach still mean anything without `intent`?** §3 takes option (c) and names the
cost. The test is whether interactions under `ACTION_DECIDER=jev` read as blunter than under `llm`.
If do, the fix is (b) — an enumerated intent per target tier — and not a second model call.

**F3. Is `seek` the right gate?** A single noul decides whether the agent engages at all, which
makes it the highest-leverage number in the loop and the one most likely to want per-agent
variation. A cautious millwright and a curious child should probably not share a threshold, and
nothing here lets them differ.

**F4. Should the probabilities reach the world?** They currently stop at the trace and the
synthesized `reason`. `agentDecideAction` could carry the whole distribution, which would make a
replayed run explain itself — at the cost of putting model output in the input log for something the
engine does not read.

---

## 11. The god's gate

`extends docs/05 §7.5` · `specifies GOD_GATE_DECIDER=jev`

The second decision this model answers, and the one it fits best. `05` §7 splits the god in two: a
cheap **gate** over the batch, and an expensive **intervention** that rewrites what the gate
flagged. The intervention writes state documents and common knowledge, so it stays chat work
forever. The gate is a yes/no judgement over evidence, which is the shape a noul has.

`GOD_GATE_DECIDER=jev` (or `VITE_GOD_GATE_DECIDER=jev`) switches it. Default is `llm`. A sibling of
`ACTION_DECIDER`, named the same way and for the same reason — for the decision, not for the agent
that makes it — and deliberately **not** a god-wide flag.

```
agent/config.ts     godGateDecider(): 'llm' | 'jev'
agent/gateJev.ts    the request, the thresholds, the composition — all pure
agent/god.ts        the branch, inside the god's existing standalone Tracer
```

### 11.1 It costs almost nothing here

§3 is the price list for the action decision: four prose fields, three of them read by something
downstream. The gate's price list is one line. `GateVerdict` is `{ intervene, why }`; `intervene` is
a boolean, and `why` was already the kind of field §3 synthesizes from numbers.

So the trade that made §3 a judgement call is not a judgement call here, and three things get
strictly better rather than merely cheaper:

**The failure direction stops being silent.** `parseGate` never throws and a gate it cannot read
does not intervene (`agent/god.ts:182`) — the safe direction, and also indistinguishable from a god
with nothing to do. A malformed gate response is a god that quietly stops working. There is no prose
to dig an object out of here, and `extractJsonObject` has no counterpart on this path, for the same
reason it has none in `decisionFromAnswers`.

**The two questions stop sharing one boolean.** `05` §5.3 put common knowledge in the gate so it
would not be revisited only on batches where a _document_ broke the format rule, and
`agent/god.ts:48-53` names the residue honestly: "two unrelated things sharing one trigger, and the
rarer one deciding for both". Two nouls end it. They have separate thresholds, because a false
positive on format spends one intervention that rewrites nothing while a false positive on common
knowledge writes a document everybody reads.

**The gate learns which documents broke.** A chat gate returns one boolean for a whole batch. A
per-document fan-out returns one number each, so stage two can be shown the flagged documents
instead of all of them — the fan-out shrinks the _expensive_ call, not just the cheap one. When only
common knowledge is stale, no document is sent at all, where today the whole batch is.

### 11.2 The request

Five state fields and one question per document, plus one:

| field                           | is                                        |
| ------------------------------- | ----------------------------------------- |
| `who_you_are`                   | `config.persona`                          |
| `how_documents_must_be_written` | `BOTH_TIERS_STATE_CONTRACT`               |
| `what_common_knowledge_is_for`  | `COMMON_KNOWLEDGE_CONTRACT`               |
| `what_everyone_here_knows`      | the current document, or "nothing yet"    |
| `document_1` … `document_n`     | one per write: kind, reason, the document |

| id                      | type | asks                                                              |
| ----------------------- | ---- | ----------------------------------------------------------------- |
| `format_1` … `format_n` | noul | `document_i`, judged against its own variant, should be rewritten |
| `knowledge`             | noul | something here belongs in common knowledge and is not there yet   |

Two adaptations, both the kind §5 already made for the decision.

`BOTH_TIERS_STATE_CONTRACT` goes in, not `god.ts`'s `FORMAT_RULE`. Same rule; what is dropped is
`FORMAT_RULE`'s trailing paragraph — "each document below is labelled with which kind of entity
wrote it, judge it against that variant" — which exists only because the chat gate puts every
document in one prompt and has to tell them apart. Each question here judges one document and names
its variant, so the paragraph would instruct the model to do what the request shape already did.

`what_everyone_here_knows` is **stated when empty** rather than omitted. §5 omits a question whose
option set is empty; this is the opposite case and the distinction matters — the gate is being asked
whether something is _missing_ from that document, so an absent field and a field reading "(nothing
has been written there yet)" are different questions.

**A per-document fan-out, not one noul over the batch.** The flat version is less code and throws
away the reason to do this at all: it asks the model to run a per-document check internally and OR
the results, over a batch whose documents are judged against _different_ variants of one contract,
and it returns a number that cannot say which document it was about. It costs nothing extra — Jev
ingests the state once and evaluates every question against it in parallel (§5) — and a batch is a
handful of documents.

As in §5, an entity id never reaches the model. Questions point at `document_3`, not at `e:1`; the
mapping back lives in `JevGateRequest.documents` and never leaves the process.

### 11.3 Where the policy went, again

| constant                    | default | what it gates                       |
| --------------------------- | ------- | ----------------------------------- |
| `FORMAT_BREAK_THRESHOLD`    | 0.5     | whether a document counts as broken |
| `KNOWLEDGE_STALE_THRESHOLD` | 0.5     | whether common knowledge is stale   |

The gate's sensitivity used to be the word "badly" in "breaks the rule badly enough that it should
be rewritten". `05` §7.5 makes the gate's hit rate a cost signal worth reading, and a signal is only
tunable if the thing that produces it is a number. These are the §6 payoff applied to the one call
whose hit rate is explicitly the measurement.

`why` is synthesized the way `reason` is: `documents p:2 0.82 · knowledge 0.10`. When nothing
clears, the highest number is reported anyway — `documents clear (highest p:2 0.47)` and
`(highest p:2 0.02)` are the difference between a gate nearly firing and one nowhere near it, and a
bare "clear" cannot tell them apart in the transcript afterwards. `why` has a consumer the
decision's `reason` does not: it is fed into stage two, whose prompt asked the gate to "say which of
the two in `why`". Two labelled numbers say which more exactly than a sentence picking one did.

### 11.4 What this does not change

- **The scope rule.** `parseVerdict`'s `legalIds` is still the **whole batch** (`05` §7.6), not the
  flagged subset. Only the _evidence_ stage two is shown is narrowed. Narrowing legality too would
  turn a gate false negative into a document nothing can ever fix, which is a worse failure than the
  cost it would save.
- **The mystery-gift probe.** It still stands the gate down entirely (`08` §7 D7), on either
  decider, and stage two still sees the whole batch while it is on.
- **`godGateEnabled`.** A world with the gate off still goes straight to the intervention.
- **The transcript, the watermark, the batch.** `loadGodBatch` is untouched; both deciders judge the
  same evidence, which is what makes them comparable.

### 11.5 Open questions

**F5. Does persona survive the move?** The chat gate puts `config.persona` in a system prompt and
the god is _in character_. Jev has no system role, so persona becomes one named state field among
five, with much weaker pull. For the format question that is fine — conformance is mechanical. For
common knowledge it may not be: "what everyone should know" is a judgement a persona shapes. This is
the most likely place the two gates diverge, and the cheapest thing to measure, because both can be
run over the same batch.

**F6. The batch is still unbounded.** `loadGodBatch` returns every audit after the watermark, so a
long gap produces a large batch — and under the fan-out, a large question set. Well inside Jev's 32k
`state` budget for any batch a demo world produces (`BOTH_TIERS_STATE_CONTRACT` is ~1.4k tokens, a
document a few hundred), but neither decider bounds it. The fix belongs in `loadGodBatch`, where it
applies to both; capping one path and not the other would destroy the comparison this flag exists
for, and capping by dropping documents would advance the watermark past writes nothing ever judged.

**F7. Should the flagged subset reach the transcript?** It currently reaches the trace, stage two's
evidence, and `why`. The god's transcript records `why` verbatim, so the numbers do persist — but
the _structured_ flagged set does not, and a later batch reading its own history back sees a
sentence where it could see a list.

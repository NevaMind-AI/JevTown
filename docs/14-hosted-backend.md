# A Hosted Backend Without Accounts

`extends docs/11 §4.4, §8` · `verified against vandoger-merge-agentic@eb0bae2`

`11` puts the simulation in the browser and reduces the backend to storage plus a key-holding model
proxy. It was written for one trusted developer running both halves on one machine. This document is
about the next shape: **every player runs the frontend on their own machine, and all of them talk to
one backend we host.**

Nothing in `11` §1 changes. The browser still owns world state and event order, and the backend
still never simulates. What changes is who the backend serves: many anonymous players, some of whom
will read the source and send it whatever they like.

Two constraints decide most of what follows:

- **No login and no accounts.** A best-effort token that tells players apart is enough. It should
  let a player resume their world in most cases. Losing progress occasionally is acceptable.
- **The backend is open.** Anyone can run the frontend, so anyone can call the backend. The frontend
  is public code on the player's machine, so it cannot hold a secret.

| §   | question                                            |
| --- | --------------------------------------------------- |
| 1   | What the token is                                   |
| 2   | Scoping stored data to the token                    |
| 3   | Keeping the model endpoints from being a free proxy |
| 4   | Local and hosted from one repository                |
| 5   | Sequence                                            |
| 6   | Open questions                                      |

---

## 1. Identity: a bearer token the server mints

### 1.1 What was rejected

| candidate           | why not                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| machine code        | A browser cannot read one. It would need a native wrapper.                                                                                                                                                                                                    |
| browser fingerprint | Unstable: it changes with browser updates, monitors and privacy settings, which loses progress far more often than "occasionally". It collides on identical machines. And it is an identifier, not a secret: anyone who can reproduce it becomes that player. |
| cookie              | The frontend is served from `localhost` and the backend from another site, so the cookie is third-party. Safari and Firefox block it and Chrome restricts it, and the failures differ by browser.                                                             |

### 1.2 The shape

1. On first launch the frontend calls `POST /identity`. The server generates 128 random bits and
   returns them as the token. The server may HMAC-sign the token, so a forged one is rejected
   without a database read.
2. The frontend keeps the token in `localStorage` and sends it as `Authorization: Bearer <token>` on
   every request, to `/llm/*` and to `/worlds/*`.
3. The server stores only a hash of the token and uses that hash as `owner_id`. The token is a
   secret the server can revoke, and a leaked database does not leak tokens.

This is separate from `world_sessions.session_id`. The token says who a player is. The session says
which of that player's tabs holds the writer lease (`11` §4.3). A player with two tabs open has one
token and two sessions, and the lease still settles which tab writes.

### 1.3 What loses a player's worlds

Clearing site data, switching browser or switching machine each produce a new token, and the old
worlds become unreachable. That is the "occasional loss" the constraints allow. Two cheap measures
make it rarer:

- **Storage is per origin.** `localhost:5173`, `127.0.0.1:5173` and another port are three origins,
  so they are three players. Pin the dev server's host and port.
- **A recovery code.** Settings shows the token as a copyable code, and the frontend accepts a
  pasted one. A player can move machines without an account.

### 1.4 Minting is the weak point

Every per-player limit in §2 and §3 can be dodged by minting a fresh token. Rate-limit
`POST /identity` by IP. If that proves too weak, an invisible check such as Cloudflare Turnstile
fits here and only here: it runs once per identity, never during play.

---

## 2. Scoping stored data to the token

### 2.1 One column, on `worlds`

Every table in `server/db/001_init.sql` is keyed by `world_id` with
`REFERENCES worlds(id) ON DELETE CASCADE`. Ownership of the world implies ownership of every row
under it, so the column goes on `worlds` only:

- `worlds.owner_id`, set at creation.
- `llm_calls.owner_id`, because §2.4 counts quota by owner rather than by world.
- One `authorizeWorld(owner, worldId)` check in `handleWorlds`, before `bootstrap`, `session`,
  `batches` and `events`. A world the token does not own answers 404, not 403, so that world IDs
  cannot be probed.

Copying `owner_id` onto every table only pays off if Postgres row-level security is adopted later.
Nothing needs it now. Any file storage follows the same rule: put files under a `worlds/<worldId>/…`
prefix and run the same check.

### 2.2 The shared tables leak today

Two tables have no `world_id`. That is correct for a single developer and wrong once the backend is
shared.

- **`bootstrap` returns every row of both tables.** It runs `SELECT hash, content FROM blobs` and
  `SELECT text_hash, embedding FROM embeddings_cache` with no filter (`server/worlds.ts:348`,
  `:375`). On a shared backend, every player's resume would download every other player's entity
  prose. Fix: read only the blobs that this world's `entity_state.state_ref` points at, and stop
  shipping the embeddings cache to the client at all.
- **The first writer wins on keys the client supplies.** Both inserts are `ON CONFLICT DO NOTHING`,
  and the client supplies the hash and the vector (`server/worlds.ts:186`, `:305`). A player can
  plant a garbage embedding for a common text before anyone else does, and every player's memory
  search then uses it. Fix: the server computes blob hashes itself, and only `/llm/embed` writes
  `embeddings_cache`, using vectors the server fetched itself. The `embedding` change kind leaves
  the batch protocol.

Once the server writes it, the embeddings cache remains shared across players. That is fine and is
what makes it worth keeping ("it saves real money").

### 2.3 World IDs

`POST /worlds` takes a client-chosen ID and is idempotent by ID: `createWorld` answers
`created: false` when the ID already exists, whoever owns it. With owners, an existing ID that
belongs to another owner must be refused. The better fix is for the server to generate world IDs,
which also ends ID squatting. The client then has to wait for the create response before it sends
its first batch.

### 2.4 Quotas move to the owner

`MODEL_WORLD_QUOTA` counts by `worldId`, and a new world gets a fresh quota. Count by `owner_id`
instead, with IP as a backstop. The process-wide `MODEL_PROXY_CALL_CAP` becomes a denial-of-service
lever on a shared backend: one abuser exhausts it for everyone. Keep it only as a global circuit
breaker sized well above normal traffic (§3.6).

### 2.5 Storage bounds and cleanup

- `world_definition.doc` and each batch's `state` are arbitrary JSONB up to the 8 MB body limit. Cap
  the number of worlds per owner, the definition size and the state size.
- A lost token orphans its worlds. A periodic job deletes worlds with no batch in N days, and the
  cascade removes everything under them.

---

## 3. Keeping the model endpoints from being a free proxy

### 3.0 What cannot be done

**The backend cannot prove that a request came from our frontend.** The player runs the frontend and
has its source. Any signing key, header or obfuscation in the bundle can be read and replayed. These
slow an attacker down but do not stop one, and none of them is worth building.

What can be done is to narrow what each endpoint accepts, until an arbitrary payload is worth no
more to an attacker than a legitimate one. Rate limits are the last guard, not the first.

### 3.1 Pin the fields that drive cost on the server

`/llm/chat` currently forwards the client's body to the provider, including `model`
(`server/model/llm.ts:257`). An attacker can choose the most expensive model and a huge
`max_tokens`. On the server:

- Ignore `model`, or check it against an allowlist.
- Clamp `max_tokens`, `n` and `temperature`, and cap the number and length of messages.
- Drop fields the server does not recognise.
- On `/llm/embed`, cap the number of texts and the length of each one.

This is the cheapest change in the document and the one with the most effect.

### 3.2 Prompts become purposes

Today the client sends finished `messages`, so `/llm/chat` accepts any prompt at all. That makes it
a general-purpose LLM endpoint with our key attached. The change:

```
before:  POST /llm/chat     { messages: [...], max_tokens, model, trace }
after:   POST /llm/purpose  { purpose: 'conversation.continue', vars: {...}, trace }
```

The world travels in the lease headers of §3.3 rather than in the body.

The server looks up the template registered for `purpose` and renders it from `vars`. It fixes the
model and the token limit for that purpose, and requests structured output where the purpose has a
shape. It checks that the response has that shape before returning it. There are about fifteen call
sites in `agent/` (`conversation.ts`, `memory.ts`, `interact.ts`, `god.ts`, `stateUpdate.ts`,
`operations.ts`), so the registry is small.

Text in `vars` can still carry an injection, but it lands inside our system prompt, under a short
token limit and an output schema. The result is a poor chatbot, which is the goal.

Three points about the move:

- **It does not break `11` §4.1.** Rendering a prompt is not simulation. The server still never
  advances a clock or applies an input.
- **The template code is shared, not copied.** The prompt builders move into one module under
  `agent/` that both the server and the tab import, as `server/index.ts` already imports
  `agent/model/trace.ts`. The local setup also runs this server, so local play and hosted play take
  the same path, and a change to an agent's prompt reaches both.
- **The cost:** changing a prompt means redeploying the backend.

**One route for every kind of model.** A purpose has one variant per kind of model that can answer
it: a chat variant renders `messages` and parses text, and a System One variant renders `state` and
`questions` and parses typed answers (`12`). Where a purpose has both, as the action decision does,
a server setting picks one. The tab sends the same purpose and vars either way and cannot choose.
That is why the route is `/llm/purpose` rather than one route per kind: a route per kind would put
the choice back in the client.

**The server parses.** It has to read the answer to check its shape anyway, so it returns the
purpose's result already parsed, in one shape whichever variant answered. The response also names
the `provider` that answered. The tab may log or show it but never branches on it. Parsing in the
tab instead would mean parsing twice, and every new provider would need a client change.

The registry lives in `agent/purposes/`, with explicit `.ts` imports so the server can import it
without a build step (§4.3, option one). The first purpose is `memory.importance`.

### 3.3 Model calls require a world and a lease

A model call is accepted only when the token owns `worldId` and the request carries that world's
current `sessionId` and `generation`. This is not cryptographic. It means an attacker has to create
a world and hold its lease, and it makes the per-owner accounting of §2.4 mean something.

### 3.4 `/llm/systemone`

The request is already typed (`SystemOneRequest`). Validate it at runtime against a schema, for
example with zod, and reject anything else. The same caps as §3.1 apply to the number and size of
questions.

That check is a stopgap, and its weak point is that its limits have to be generic. The god's gate
asks one question per document written in the batch, plus one (`agent/gateJev.ts`), so a large batch
can pass any fixed cap on question count. The lasting fix is the same as §3.2: System One calls
become purposes. That buys three things:

- **The questions come from the server.** Today the client writes each question's `instructions` and
  `criteria`, so it can ask anything of the model with our key attached.
- **So does the fixed text in `state`.** The gate sends the same contracts
  (`how_documents_must_be_written`, `what_the_world_state_is_for`) on every call. The server adds
  them instead, so the payload shrinks and a caller cannot substitute its own rules.
- **Answers are checked exactly.** The server knows the question keys and option labels it asked, so
  it can reject an answer that does not match them.

It is the lower priority of the two. System One returns probabilities, or a choice among the options
it was given, and never free text, so it is not the general-purpose generator that §3.2 exists to
close. The budgets and the lease requirement already bound what is left. The largest input, the
world's documents and state, stays client-supplied either way, because the tab owns the world.

There are two call sites: the action decision (`agent/decideJev.ts`) and the god's gate
(`agent/gateJev.ts`). Both already have a chat counterpart (`agent/decide.ts`, and the chat gate in
`agent/god.ts`), which becomes the other variant of the same purpose (§3.2). The deciders are then
picked by server settings rather than by `VITE_ACTION_DECIDER` and `VITE_GOD_GATE_DECIDER`.

### 3.5 `/llm/trace`

This endpoint is free and unbounded, so it can flood Langfuse. Accept an entry only when its
`traceId` appears in `llm_calls.trace_id` for this owner within the last hour. The table already
records that column, so no new ID-issuing mechanism is needed. Add a size cap per request.

### 3.6 Rate limits, in layers

1. Per token and per IP, counted in tokens or estimated dollars rather than in calls. `llm_calls`
   already records prompt and completion tokens. A System One call is about two thousandths of a
   chat completion (`12` §8), so a count of calls misprices both.
2. A global daily spend circuit breaker, which is what `MODEL_PROXY_CALL_CAP` becomes.
3. A rate-based rule at the edge, e.g. AWS WAF in front of the load balancer.
4. A hard spend limit in the provider's own console. It is the only limit that does not depend on
   our code being right.

### 3.7 CORS

Set `MODEL_PROXY_ORIGIN` rather than leaving it at `*`. This does not stop scripts, since CORS only
binds browsers, but it stops another website from using our backend through a visitor's browser.

---

## 4. Local and hosted from one repository

`npm run play:local` stays what it is: the whole game on one machine. The hosted setup is the same
game with its server somewhere else. This chapter is about keeping those two one codebase.

### 4.1 Not a fork, and not a long-lived branch

The two modes differ only in where the server runs and how strict it is. The simulation and the
agent layer are identical in both, and that is exactly the code a fork would copy. Every change to
an agent's behaviour would then need to be carried across by hand, and the two copies would drift
apart. A long-lived "hosted" branch has the same problem. The hosted work lands on `dev` through
ordinary feature branches.

Being a public repository is not a reason to split. §3.0 already assumes an attacker reads the code,
so nothing here depends on the server's source being secret. What stays private is:

- the secrets: provider keys and the database URL, in AWS Secrets Manager or the deployment's
  environment;
- optionally, infrastructure code that names account IDs, in a small private deploy repository or
  outside git.

A fork would become the right call only if the hosted version stopped sharing the simulation, for
example by simulating on the server (`10`) or becoming multiplayer, or if hosted content had to be
closed. Neither applies now.

### 4.2 The rule that keeps the modes from drifting

**Agent behaviour lives in `agent/` and is imported by both the server and the tab. Mode differences
live only in server settings and client URLs.** If an `if (hosted)` ever appears in `agent/` or
`src/sim/`, the modes have started to drift.

| layer                             | local (`play:local`)                              | hosted                                                                                     |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `agent/`, `engine/`, `prototype/` | shared, unchanged                                 | shared, unchanged                                                                          |
| `server/`                         | `HOSTED` unset: the permissive defaults of today  | `HOSTED=1`: token required, quotas by owner, model allowlist, a set CORS origin (§1 to §3) |
| `src/`                            | one fetch wrapper adds the base URL and the token | the same wrapper, pointed elsewhere                                                        |

The prompt builders of §3.2 stay in `agent/` and the server imports them. Local play runs the same
server, so a change to an agent's prompt reaches both modes with no extra step.

The frontend always does the identity handshake of §1.2. The local server mints tokens as the hosted
one does, so the client never checks which mode it is in.

Scripts:

- `play:local`: unchanged.
- `play:remote`: `vite --mode remote`, reading a committed `.env.remote` that holds the hosted URLs.
  They are public values, so committing them is fine.
- `server:start`: the server with `HOSTED=1`, or a Dockerfile that runs it.

Two client settings are needed, and one of them is missing today:

- `VITE_MODEL_PROXY_URL` already exists (`agent/model/client.ts:40`).
- The storage base URL does not. `SyncClient` defaults to `/worlds`, and `useAgenticSync` does not
  override it (`src/sim/useAgenticRuntime.ts:92`). `vite.config.ts` forwards only `/llm` to the
  server, so under `play:local` the `/worlds` requests reach Vite, not the server. Add a `/worlds`
  entry to the Vite proxy for local play, and a `VITE_STORAGE_URL` for hosted play.

### 4.3 The one friction: import extensions

The server runs under `node --experimental-strip-types`, which requires explicit file extensions,
and `server/` already writes them (`'./model/llm.ts'`). `agent/` imports without them
(`agent/memory.ts:1` imports `'./model/client'`), so the server cannot import most of `agent/` as it
stands. There are two ways out:

- The shared prompt module uses explicit `.ts` imports and pulls in as little as possible. This
  keeps the server's zero-build start.
- The server runs through `tsx` or an esbuild bundle. This lifts the restriction for all of
  `agent/`, at the cost of a build step for the server.

This is the only real friction in sharing the code.

### 4.4 Which world a tab opens

**Today.** Local mode does not generate a world ID. It takes `VITE_SYNC_WORLD_ID` from `.env.local`
(`src/sim/useAgenticRuntime.ts:88`), and sync is off when that setting is absent. Vite bakes the
value into the bundle, so every browser on every host gets the same ID.

The tab only writes to that world. It claims the lease and sends batches, but nothing in `src/`
calls `bootstrap()` or `POST /worlds`. So:

- A reopened game starts fresh from the world file. Nothing is read back from the database.
- Unless something else created the `worlds` row first, claiming the lease should fail on the
  foreign key from `world_sessions` to `worlds`. This has not been run.

The ID is stable, but resuming is not wired up in either mode.

**Who the player is and which world they open stay separate.** The token of §1 answers the first,
the world ID the second. The handshake is not bent into producing a fixed world ID for local mode:
merging the two breaks as soon as one player has two worlds. Local mode is handled in two other
places instead.

The server decides whether ownership is checked:

- `HOSTED` unset: `authorizeWorld` always passes, and every request belongs to one fixed owner,
  `local`. A new browser gets a new token, and nothing is lost, because locally the token is not
  checked. `POST /worlds` accepts the client's ID and stays idempotent, as today.
- `HOSTED=1`: the owner check of §2.1 applies, and `POST /worlds` ignores any client-chosen ID and
  generates one (§2.3).

The tab picks its world in the same order in both modes:

```
worldId = VITE_SYNC_WORLD_ID          // pinned in config: local play and development
       ?? localStorage.lastWorldId    // hosted: the world this browser last opened
       ?? (await POST /worlds).id     // first launch: a new world
bootstrap(worldId) → 404 → create it, then start fresh from the world file
```

A pinned ID in a hosted build gets a 404, because the player does not own it, and falls through to
creating a new world. No special case is needed.

**Pinned IDs stay.** They are worth keeping for development: several named worlds side by side, test
fixtures, and loading someone else's database dump. To reset, point the setting at a new ID, or run
a small `npm run world:reset` that deletes the `worlds` row; the cascade removes everything under
it. A `?world=<id>` URL parameter would allow switching worlds without restarting Vite. It is not
needed yet.

Two consequences, both acceptable:

- **Two tabs on one world.** The lease settles it. `start()` takes the lease by default, so the
  older tab goes read-only (`11` §4.3).
- **A different hostname.** `IndexedDbOutbox` belongs to one origin. Changing hostname leaves behind
  only the batches not yet acknowledged, a few seconds of play. The world itself resumes from the
  database.

**The missing piece, in both modes:** in `useAgenticSync`, create the world if missing and resume
from the bootstrap response before the first flush. `AgenticRuntime.restore()` already exists
(`src/sim/agenticRuntime.ts:442`). What is missing is the call, and the mapping from
`BootstrapResponse` to the runtime's snapshot.

### 4.5 Batches left by an earlier page

A batch goes into the `IndexedDbOutbox` before it is sent, and leaves only when the backend
acknowledges it (`src/sim/syncClient.ts`). That is what limits a closed tab's loss to the
unacknowledged batch. Leftovers appear when a page closes while a flush is in flight, and more often
after a stretch in which the server was unreachable, since every failed flush stays queued.

**The problem.** Every page load builds a new `SyncClient` with a new random `sessionId`, and
`start()` takes the lease under it. It then re-sends the leftovers as they were stored, carrying the
earlier page's `sessionId` and `generation`. `applyBatch` refuses them as `stale-session`, and
`resend()` answers that by going read-only. The tab that has just taken the lease stops saving.

A reload and a new tab look the same to the server: each is a new session taking the lease. They
differ only in the browser. After a reload the earlier page is gone, and its leftovers are orphans
that nobody else will send. A new tab opens beside a page that is still running, and because the
outbox belongs to the origin, the new tab also sees that page's in-flight batches.

**The fix.** `resend()` re-stamps each leftover with the current `sessionId` and `generation`, and
keeps its `batchId`. This does not weaken the lease, because the other two guards of `applyBatch`
still decide:

- a `batchId` already in the ledger answers `duplicate`: the acknowledgement was lost, and the batch
  is done;
- a `baseVersion` other than the stored one answers `version-conflict`: the batch was superseded,
  and it is dropped;
- otherwise the batch applies exactly where it was always going to. A re-stamped batch cannot fork
  history.

A leftover describes the earlier page's runtime, not this one, so accepting it moves only the stored
version. This runtime's shipped index and change sequence stay as they were. `stale-session` during
the resend still means read-only, because then another tab really has taken the lease since.

Keeping the session id in `sessionStorage` would also let a reload keep its session, but "Duplicate
tab" copies `sessionStorage`. Two live tabs would share one session, and the lease would no longer
tell them apart.

**Two live tabs.** The new tab may send the older tab's in-flight batch on its behalf. That is
harmless: the version chain still applies, the batch lands at most once, and the older tab goes
read-only at its next heartbeat or flush, as §4.4 says.

**Order with resume.** Once step 0 restores from `bootstrap`, the resend must come first: claim the
lease, send the leftovers, then bootstrap and restore, then flush. Restoring first would leave the
runtime a batch behind the stored version, and its first flush would conflict. Today `resolveWorld`
bootstraps before `start()`, which is harmless only because nothing restores yet.

**What read-only means today.** Only that nothing more is stored. The older tab logs a console
warning and keeps simulating, and it keeps calling models, which its owner's quota pays for. Telling
the player, pausing the runtime and offering to take the world back are a separate change. §3.3
would also refuse the older tab's model calls on the server.

---

## 5. Sequence

Ordered by risk removed per unit of work. Steps 1 to 4 are a few hours in total and remove most of
the exposure. Step 5 is the real change. Step 0 is not about the hosted backend at all: local play
needs it too, and the rest builds on it.

0. Resume in both modes: a `/worlds` Vite proxy entry, create-if-missing, and restore from
   `bootstrap` once the outbox is drained (§4.2, §4.4, §4.5).

1. Pin the cost fields on `/llm/chat` and `/llm/embed` (§3.1).
2. Stop `bootstrap` returning every row of `blobs` and `embeddings_cache`. Move writes to those
   tables to the server (§2.2).
3. `POST /identity`, `worlds.owner_id`, `authorizeWorld`, and world IDs generated by the server
   (§1.2, §2.1, §2.3).
4. Quotas by owner, and the process cap as a circuit breaker (§2.4, §3.6).
5. Prompts as purposes (§3.2), one call site at a time: a small chat purpose as the pilot, the other
   chat call sites, then the two System One call sites (§3.4). Only once every call site has moved
   can the free-form `/llm/chat` and `/llm/systemone` paths close, together with the generic checks
   of §3.1 and §3.4.
6. The lease requirement, `systemone` validation and trace binding (§3.3 to §3.5).
7. Edge and provider limits, and the idle-world cleanup job (§3.6, §2.5), at deployment.

The `HOSTED` switch of §4.2 arrives with step 3, since that is the first rule local play must not be
subject to. The import-extension decision of §4.3 has to be made before step 5.

---

## 6. Open questions

- **Should a hosted world come from a catalog?** If `POST /worlds` takes a `definitionId` from
  worlds the server ships, instead of an uploaded document, two things follow. §3.2's templates can
  fill character and world text from a definition the server trusts, rather than from `vars`. And
  the god's hidden rules can stay on the server instead of travelling to the browser (`11` §8),
  which turns a prompt-construction discipline back into a transport boundary. The cost is that
  players cannot load their own worlds on the hosted backend.
- **How long does an idle world live?** N in §2.5. It trades storage cost against how "occasional"
  the loss really is.
- **Is Turnstile needed at mint time?** Only if IP rate limits on `POST /identity` prove too weak in
  practice.

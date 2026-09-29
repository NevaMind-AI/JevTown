# server

The model proxy and the storage service. Started by `npm run proxy`, and by `npm run play:local`
alongside Vite.

It does two jobs and no others. It holds the provider key, so the browser never sees one. And it
stores what the browser sends it — **it never executes simulation logic** (docs/11 §4.1). There is
no engine in here on purpose: a second copy of the simulation is a second world state that can
disagree with the browser's silently.

## Running it

```sh
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/remaining_time
npm run play:local
```

Without `DATABASE_URL` it still runs, as a proxy only; the `/worlds` routes answer 503. That is the
right failure for anyone working on the simulation and not on persistence.

The schema applies itself on boot. Every statement in `db/001_init.sql` is `IF NOT EXISTS`, so this
is idempotent — the day there is a second migration file, it becomes a real ordered runner.

## Endpoints

| route                        | what it does                                               |
| ---------------------------- | ---------------------------------------------------------- |
| `POST /llm/chat`             | a completion, with the key attached and the trace exported |
| `POST /llm/systemone`        | a typed decision from a System One model (docs/12)         |
| `POST /llm/embed`            | embeddings                                                 |
| `POST /llm/trace`            | observations the tab built but cannot export itself        |
| `POST /identity`             | a new identity token for a browser that has none           |
| `GET  /worlds`               | the caller's worlds, newest first                          |
| `POST /worlds`               | create a world; returns the id to use                      |
| `GET  /worlds/:id/bootstrap` | everything needed to resume, in one round trip             |
| `POST /worlds/:id/session`   | claim or renew the writer lease                            |
| `POST /worlds/:id/batches`   | take one batch, whole or not at all                        |
| `GET  /worlds/:id/events`    | a range of the log                                         |

## Settings

| variable                      | default                   | meaning                           |
| ----------------------------- | ------------------------- | --------------------------------- |
| `DATABASE_URL`                | unset                     | enables the storage routes        |
| `MODEL_PROXY_PORT`            | 3001                      | where it listens                  |
| `MODEL_PROXY_CALL_CAP`        | 2000                      | model calls per process lifetime  |
| `MODEL_OWNER_QUOTA`           | 1000                      | model calls per owner, per window |
| `MODEL_QUOTA_WINDOW_MS`       | 1h                        | that window                       |
| `HOSTED`                      | unset                     | see "Local and hosted" below      |
| `IDENTITY_SECRET`             | unset                     | signs tokens; required if hosted  |
| `JEV_API_URL`                 | `https://api.typesafe.ai` | the System One endpoint           |
| `JEV_API_KEY`                 | unset                     | its key, which never leaves here  |
| `JEV_MODEL`                   | `jev-1.13.0`              | pinned, not an alias (docs/12 §7) |

`/llm/systemone` counts against both limits like any other call, which is blunt — a System One call
costs about two thousandths of a chat completion (docs/12 §8). Raise the cap for a long run with
`ACTION_DECIDER=jev` rather than exempting the route.

The two limits answer different questions. The process cap catches a runaway loop in one session;
the per-owner quota catches a player who is expensive across all of their worlds. Both live here rather than
in the client, because a limit that lives in code the client can edit is not a limit (docs/11 §4.4).

## Local and hosted

One server, two strictnesses (docs/14 §4.2). The client always does the same thing: it asks
`POST /identity` for a token once, keeps it in `localStorage`, and sends it as
`Authorization: Bearer <token>` on every request.

- **`HOSTED` unset** (local play): tokens are minted but never checked. Every request belongs to one
  owner, `local`, and `POST /worlds` keeps the client's id, so `VITE_SYNC_WORLD_ID` pins a world.
- **`HOSTED=1`** (`npm run server:start`): `/llm/*` and `/worlds/*` answer 401 without a token this server signed. The owner
  is a hash of the token; the token itself is never stored. A world another owner holds answers
  404. `POST /worlds` ignores the client's id and makes its own. Quotas count by owner, with a
  per-address backstop, and minting is rate-limited per address. Model calls are refused when the
  database is down, since they could not be counted. See `.env.example` for the hosted-only limits.

`npm run play:remote` runs this frontend against the hosted server, with the URLs in `.env.remote`.

The embeddings cache is shared by every world, so only `/llm/embed` writes it, from vectors the
server fetched itself, and `bootstrap` no longer returns it. Blobs are keyed by the server's own
hash of their content, and `bootstrap` returns only those the world refers to (docs/14 §2.2).

## Tests

`server/sync.test.ts` is the acceptance suite for docs/11 §4 and skips itself unless `DATABASE_URL`
is set:

```sh
docker compose up -d postgres
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/remaining_time npm test
```

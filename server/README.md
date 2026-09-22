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
| `POST /worlds`               | create a world (idempotent by id)                          |
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
| `MODEL_WORLD_QUOTA`           | 1000                      | model calls per world, per window |
| `MODEL_WORLD_QUOTA_WINDOW_MS` | 1h                        | that window                       |
| `JEV_API_URL`                 | `https://api.typesafe.ai` | the System One endpoint           |
| `JEV_API_KEY`                 | unset                     | its key, which never leaves here  |
| `JEV_MODEL`                   | `jev-1.13.0`              | pinned, not an alias (docs/12 §7) |

`/llm/systemone` counts against both limits like any other call, which is blunt — a System One call
costs about two thousandths of a chat completion (docs/12 §8). Raise the cap for a long run with
`ACTION_DECIDER=jev` rather than exempting the route.

The two limits answer different questions. The process cap catches a runaway loop in one session;
the per-world quota catches a world that is expensive across all of them. Both live here rather than
in the client, because a limit that lives in code the client can edit is not a limit (docs/11 §4.4).

## Tests

`server/sync.test.ts` is the acceptance suite for docs/11 §4 and skips itself unless `DATABASE_URL`
is set:

```sh
docker compose up -d postgres
DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/remaining_time npm test
```

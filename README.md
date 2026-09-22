# Remaining Time

A pixel-art narrative game by NevaMind-AI, built around relics, choices, and digital life. It is an
MVP in progress: TypeScript, React, and PixiJS, running a local world entirely in the browser — no
backend, no account, and no model service required to play.

## What you can play today

- **The room world.** Start in unit 404 and explore 26 connected rooms, interacting with NPCs and
  props, and completing the S01 door-tag investigation. The full main story is still being built.
- **Local progress.** Autosaves, snapshot loading, run recording and replay, and resuming from a
  previous position.

Room contents and known limits are documented in the
[room content package](public/content/remaining-time/README.md). LLM small talk for NPCs is not
wired into the main line yet, and traversal feel still needs per-map tuning.

## Quick start

Requires **Node.js 22 LTS (22.22.1 or a newer patch)** and npm:

```sh
npm ci
npm run dev
```

Open the address printed by the terminal, usually `http://localhost:5173/ai-town/`. The `/ai-town/`
prefix is a retained asset base path; it does not mean an AI Town backend is involved.

Just and Make wrappers are available if you prefer one:

```sh
just install && just dev
```

```sh
make install && make dev
```

### Controls

| Key           | Action                                         |
| ------------- | ---------------------------------------------- |
| WASD / arrows | Move; in dialogue, W/S or ↑/↓ select an option |
| Shift         | Sprint                                         |
| E / Esc       | Interact, confirm / leave dialogue             |
| 1 / 2         | Inventory / relic collection                   |
| T / R / H     | Tasks / wait / toggle HUD                      |

Walk up to an interactive NPC or prop and press E (or click) to interact; step into an exit tile to
change rooms.

### Saves

- Saves live in **OPFS, scoped to the current browser and site origin**, and are never uploaded.
  Clearing site data deletes them; switching browser, domain, or port does not carry progress over.
- The room world uses the `remaining-time-room-saves` store and restores the latest saved position
  on reload.
- **Settings → Save now** writes the current progress by hand; autosaves keep running, and no
  duplicate save is produced when nothing has advanced. A failed save leaves in-memory progress
  intact, and manual saves are unavailable during replay.
- **Settings → Saves** loads a save, plays a recording, or starts a new timeline. **Loading an older
  position, or resuming from a replay cursor, discards everything recorded after it.**
- After editing story or map content, start a new timeline to load it; existing saves keep the
  content embedded in them.

## Architecture

The game is a client-only application. Everything that makes a world — the collision grid, the
scenes, the dialogue, the tasks — is data loaded at runtime, and the simulation runs in the tab.

| Layer            | Where it lives                   | What it holds                                                            |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Rendering and UI | `src/`                           | React components, the PixiJS viewport, HUD, dialogue, panels             |
| Simulation core  | `prototype/`                     | World stepping, pathfinding, entities, schedules, recording and replay   |
| Content contract | `content/`                       | Scene and story capability tables — what the engine can express          |
| Playable content | `public/content/remaining-time/` | The manifest, scenes, stories, and assets actually loaded by the browser |
| Authoring source | `art/`, `scripts/`               | Map/portal/NPC recipes and the exporters that generate the runtime JSON  |

Content loads through a manifest: it names the scenes and stories for a content version, scenes
place entities and define collision and portals, and stories attach dialogue, effects, and tasks to
entity IDs. Runtime state — position, inventory, task facts, recorded history — is owned by the tab
and persisted to OPFS; a save embeds the content it was created against, which is why new content
needs a new timeline.

The build is a plain Vite static site. `dist/` can be served from any static host; the asset base
path is set by `base: '/ai-town/'` in [vite.config.ts](vite.config.ts), with path rewrites in
[vercel.json](vercel.json).

## Running the agentic demo

`npm run play:demo` runs prompt-driven agents on a `dev` room, with nobody playing. It replaces the
game rather than joining it: `npm run play:local` is the game again, unchanged.

```sh
npm ci
npm run play:demo
```

Then open `http://localhost:5173/ai-town/`. Either script starts two processes: Vite, and a small
Node proxy that holds the model credentials so the browser never sees one. The simulation itself
still runs in the browser; the proxy never executes simulation logic.

The only difference between the two is the Vite mode. `play:demo` runs `vite --mode demo`, which
loads the committed [.env.demo](.env.demo) in addition to your `.env.local`; that file sets the one
flag that selects the demo, and deliberately nothing else.

### Credentials

The proxy reads `.env.local` from the repository root. A minimum configuration:

```sh
LLM_API_URL=https://your-openai-compatible-endpoint/v1
LLM_API_KEY=...
LLM_MODEL=...
LLM_EMBEDDING_API_URL=https://your-embedding-endpoint/v1
LLM_EMBEDDING_API_KEY=...
LLM_EMBEDDING_MODEL=...
```

`OPENAI_API_KEY`, `TOGETHER_API_KEY`, and a local Ollama host are supported as alternatives; the
proxy reports which provider it picked, and why, on boot.

### Knobs

Client flags need the `VITE_` prefix (Vite only exposes those to the bundle) and belong in
`.env.local`, not in `.env.demo` — Vite loads the mode file last, so a knob set there would override
the one you set for yourself:

| Flag                         | Effect                                                           |
| ---------------------------- | ---------------------------------------------------------------- |
| `VITE_DEMO_AGENTS=n`         | Cast size, clamped to `[1, 50]`; five by default                 |
| `VITE_ACTION_DECIDER=jev`    | Uses the typed System One decider instead of the chat model      |
| `VITE_DISABLE_MEMORY=true`   | Skips embeddings, for a backend with no embedding model          |
| `VITE_SUPPRESS_IDLE_AFTER=n` | After n consecutive idles, the decider leans against another one |

Server-side, `MODEL_PROXY_CALL_CAP` (2000 model calls per process lifetime) is the spend backstop. A
run that goes quiet with `429`s in the console has hit it; restart the proxy to reset it.

Every decision and every line of dialogue is a model call, so a large cast is expensive. Storage is
off in this demo — a reload starts a new world — and enabling it is a matter of setting
`DATABASE_URL` and starting the bundled Postgres with `docker compose up -d postgres`.

The demo carries its own notes next to the code: `src/sim/demo/README.md` for the demo itself,
`server/README.md` for the proxy and storage service, and `docs/` for the design documents behind
them.

## Authoring content and assets

| Entry point                                                      | Purpose                                            |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| [Scene / story capability index](content/CAPABILITIES.md)        | What the current engine can express                |
| [Story authoring skill](.agents/skills/story-authoring/SKILL.md) | Conventions for dialogue, effects, and tasks       |
| [Room content package](public/content/remaining-time/README.md)  | Scenes, stories, map generation, data entry points |
| [Map asset skill](.agents/skills/map-asset-extraction/SKILL.md)  | Prop extraction, occlusion, asset delivery         |
| [Visual asset notes](docs/visual-assets.md)                      | JSON images, anchors, and layers                   |

Room map generation is configured in `art/room-maps.json`, connections in `art/room-portals.json`,
and NPCs in `art/room-npcs.json`. After editing a source config, run:

```sh
python scripts/export-room-maps.py
```

Do not edit only the generated map and scene JSON — the next export overwrites it. Hand-written
stories are wired in as described in the room content package.

To browse room assets, run `python scripts/room-asset-catalog.py` and open
`art/map-study/asset-catalog.html`. Regenerate it after a layout change or a map export; the catalog
and other production intermediates stay local and are not committed.

## Development and build

| Task                   | npm                 | Just                 | Make                 |
| ---------------------- | ------------------- | -------------------- | -------------------- |
| Run the room world     | `npm run dev`       | `just dev`           | `make dev`           |
| Type-check and build   | `npm run build`     | `just build`         | `make build`         |
| Run the tests          | `npm test`          | `just test`          | `make test`          |
| Check formatting       | `npm run fmt:check` | `just fmt-check`     | `make fmt-check`     |
| Format the workspace   | `npm run fmt`       | `just fmt`           | `make fmt`           |
| Enable the commit hook | `npm run prepare`   | `just hooks-install` | `make hooks-install` |

`npm run build:local` runs the Vite build alone, without type-checking.

`npm ci` enables `.githooks` through the `prepare` script. In a fresh worktree, or after skipping
install scripts, run `npm run prepare` once; merge the configuration yourself if you already have a
custom hook.

The commit hook only formats staged files — it runs no tests, lint, or type-check. lint-staged
protects unstaged changes to partially staged files, so leave its stash-and-restore behaviour alone.
A full `fmt` rewrites the whole workspace, so review the diff before committing.

### Test layout

Tests live apart from the source: `tests/engine/` covers the engine, `tests/src/` covers the UI and
browser storage, and `tests/fixtures/` holds test-only data. The suite deliberately favours
regressions that matter — saves, replay, the clock, content validation, trading, tasks, and
traversal — over one test per mechanic.

`npm run test:prototype` runs `tests/engine/`; `npm test` runs every TypeScript suite. The commit
formatting guard is checked by `node --test tests/scripts/format-staged.test.mjs`, which is not part
of the Jest suite.

## License and credits

This project started from [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town) and is
directly inspired by it: the agent loop, the simulation shape, and parts of the client all trace
back to that work, and the project still uses assets from it. Upstream code is © 2023 a16z-infra
and distributed under the [MIT License](LICENSE); attribution for the initial snapshot belongs to
the upstream authors.

Original code and modifications by NevaMind-AI contributors are likewise MIT licensed, with
copyright retained by each contributor. Story, art, music, and third-party assets may carry their
own licenses, which take precedence where they apply; the code license grants no rights over player
game data.

Upstream assets and foundational work:

- Map tiles: [George Bailey](https://opengameart.org/content/16x16-game-assets) and
  [hilau](https://opengameart.org/content/16x16-rpg-tileset).
- Original art: [ansimuz](https://opengameart.org/content/tiny-rpg-forest).
- UI assets: [Mounir Tohami](https://mounirtohami.itch.io/pixel-art-gui-elements).
- The upstream proof of concept was based on
  [phaser3-simple-rpg](https://github.com/pierpo/phaser3-simple-rpg).
- Character rendering uses [PixiJS](https://pixijs.com/).

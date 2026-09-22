# The solarium flow check

Five prompt-driven agents on `dev`'s 高层天井, with nobody playing.

```
npm run play:demo     # then open http://localhost:5173/ai-town/
```

It replaces the game rather than joining it, and it is a whole script rather than a flag on the
game's: `npm run play:local` is the game, unchanged. The difference between them is the Vite mode —
`play:demo` is `vite --mode demo`, and the committed `.env.demo` it loads sets `VITE_AGENTIC_DEMO`.
That flag is wiring; there is no reason to set it by hand.

## How many agents

Five, unless you say otherwise:

```
VITE_AGENTIC_DEMO=1 VITE_DEMO_AGENTS=2  npm run play:local   # a nearly empty room
VITE_AGENTIC_DEMO=1 VITE_DEMO_AGENTS=40 npm run play:local   # a crowded one
```

Clamped to `[1, 50]`; a value outside that is clamped with a warning, and anything that is not a
whole number is ignored with one. **Below five**, agents are dropped — a seeded draw, so the same
number picks the same cast every reload. **Above five**, the authored five stay where they are and
the rest are copies: same description, same sprite, a numbered name (`Ren 2`), spawning together at
`the-lift-queue`, the one place on the map that is a rect rather than a tile. A copy may be drawn
twice, so two agents can carry the identical prompt and meet each other — which is the sort of thing
that has never been put in front of the prompt layer, and the reason the flag exists.

Changing the world file's `meta.seed` deals a different cast at every size.

This is a pressure test, not the demo. Forty agents is forty standing model calls: the proxy's
`MODEL_PROXY_CALL_CAP` (2000 per process) will stop the run within a couple of minutes, and the
console `429`s are the cap doing its job, not a bug.

## What it is for

One question: **does the upstream agent loop still close when the ground under it is a `dev` scene
instead of `data/gentle.js`?** Decide → walk → invite → accept → converse → remember.

It is deliberately _not_ docs/11 §9 F1. The two world models are still two. What this shows is that
the gap between them, for one map, is an adapter and a world file rather than a merge.

## What is on and what is off

|                  |                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| player           | none — the agents are alone, so anything that moves was decided by a model                                           |
| god              | off — the world file declares no persona, so `godEnabled` resolves false                                             |
| storage / resume | off — no `VITE_SYNC_WORLD_ID`; a reload is a new world                                                               |
| memory           | on — `rememberConversation` calls the embedding model through the proxy. `VITE_DISABLE_MEMORY=true` skips it         |
| cost             | every decision and every line is a model call. The proxy's `MODEL_PROXY_CALL_CAP` (2000 per process) is the backstop |
| cast size        | five, or `VITE_DEMO_AGENTS` in `[1, 50]` — see below                                                                 |

## The files

| file                               | what it is                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `solarium.world.json`              | the world: five actors, two props, and the prose they think with                              |
| `solariumWorld.ts`                 | the places — fourteen described anchors, most of them positions picked off the collision grid |
| `scaleCast.ts`                     | `VITE_DEMO_AGENTS`: the same world file with a smaller or a much larger cast                  |
| `../sceneWorldMap.ts`              | the adapter: a scene's collision transposed, its anchors described                            |
| `loadScene.ts`                     | one scene out of the room content package, in the browser                                     |
| `../../components/AgenticDemo.tsx` | the loop, the view, and the transcript                                                        |
| `solariumDemo.test.ts`             | the same flow with the model stubbed out — runs in CI, spends nothing                         |
| `scaleCast.test.ts`                | the resizer on its own: what the world file looks like at 1, at 5, and at 50                  |

## Watching it

The first line takes a few seconds: every agent's opening decision is a model call, and
`MIN_DECISION_INTERVAL` gates how often one may make another. The panel on the right is the
transcript; bubbles over heads are the last eight seconds. The camera follows the crowd unless you
turn that off, and the viewport drags and zooms either way.

If it stays silent, the console says why — a `429` is the call cap, and everything else is
`agent/model/client.ts` failing to reach the proxy.

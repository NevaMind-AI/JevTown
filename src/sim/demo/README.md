# The solarium flow check

Five prompt-driven agents on `dev`'s 高层天井, with nobody playing.

```
npm run play:demo     # then open http://localhost:5173/ai-town/
```

It replaces the game rather than joining it, and it is a whole script rather than a flag on the
game's: `npm run play:local` is the game, unchanged. The difference between them is the Vite mode —
`play:demo` is `vite --mode demo`, and the committed `.env.demo` it loads sets `VITE_AGENTIC_DEMO`.
That flag is wiring; there is no reason to set it by hand.

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

## The files

| file                               | what it is                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `solarium.world.json`              | the world: five actors, two props, and the prose they think with                              |
| `solariumWorld.ts`                 | the places — thirteen described anchors, most of them positions picked off the collision grid |
| `../sceneWorldMap.ts`              | the adapter: a scene's collision transposed, its anchors described                            |
| `loadScene.ts`                     | one scene out of the room content package, in the browser                                     |
| `../../components/AgenticDemo.tsx` | the loop, the view, and the transcript                                                        |
| `solariumDemo.test.ts`             | the same flow with the model stubbed out — runs in CI, spends nothing                         |

## Watching it

The first line takes a few seconds: every agent's opening decision is a model call, and
`MIN_DECISION_INTERVAL` gates how often one may make another. The panel on the right is the
transcript; bubbles over heads are the last eight seconds. The camera follows the crowd unless you
turn that off, and the viewport drags and zooms either way.

If it stays silent, the console says why — a `429` is the call cap, and everything else is
`agent/model/client.ts` failing to reach the proxy.

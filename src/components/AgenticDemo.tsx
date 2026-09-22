import { useEffect, useRef, useState } from 'react';
import { Container, Stage } from '@pixi/react';
import { Scene } from '../../prototype/content';
import { StoredMessage } from '../../agent/ports';
import { GameSnapshot } from '../hooks/gameSnapshot';
import { useElementSize } from '../hooks/useElementSize';
import { AgenticRuntime } from '../sim/agenticRuntime';
import { createAgenticWorld } from '../sim/createAgenticWorld';
import { loadScene } from '../sim/demo/loadScene';
import { SOLARIUM_SCENE_ID, solariumWorldSource } from '../sim/demo/solariumWorld';
import { requestedAgentCount } from '../sim/demo/scaleCast';
import AssetSprite from './AssetSprite';
import { EntityMarker } from './Entity';
import { Player } from './Player';
import SpeechBubble from './SpeechBubble';
import TownViewport from './TownViewport';

/**
 * Five agents on a `dev` room, with nobody playing.
 *
 * ## How many agents
 *
 * Five is what the world file authors and what an unset flag gives. `VITE_DEMO_AGENTS=n` builds
 * `n` instead, clamped to [1, 50] -- fewer by dropping agents, more by duplicating them. That is
 * a pressure test and not a demo: see `scaleCast.ts` for what it does and why the duplicates are
 * allowed to be identical.
 *
 * ## Why this is its own mode and not a layer over `LocalGame`
 *
 * The two worlds share a clock but not a map (see `createAgenticWorld`'s header). Drawn on top of
 * each other they would be mutually invisible: `MemoryWorld`'s player is not in the agentic
 * world's collision and the agents are not in `MemoryWorld`'s, so the player would walk through
 * agents and agents would path straight through the player. Rather than half-fix that with a
 * shared overlay -- which is docs/11 §9 F1, the work this demo exists to defer -- the demo simply
 * has no player. That is also what the brief asked for, and it makes the check sharper: anything
 * that moves on screen was decided by a model.
 *
 * ## What it is checking
 *
 * That the upstream loop still closes on unfamiliar ground: decide -> walk -> invite -> accept ->
 * converse -> remember, on `dev`'s 高层天井 instead of `data/gentle.js`. The god is off (the world
 * file declares no persona), storage is off (no `VITE_SYNC_WORLD_ID`), and nothing is persisted:
 * a reload is a new world, which is the point of a one-shot check.
 */
export default function AgenticDemo() {
  const [scene, setScene] = useState<Scene>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    loadScene(SOLARIUM_SCENE_ID, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setScene(loaded);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!scene) return <p role="status">Loading the solarium…</p>;
  return <RunningDemo scene={scene} />;
}

/**
 * How long a message stays over an agent's head.
 *
 * `MESSAGE_COOLDOWN` is 2s and `AWKWARD_CONVERSATION_TIMEOUT` is 60s, so a reply can be a long
 * way behind the line it answers. Holding a bubble for eight seconds keeps both halves of an
 * exchange legible without leaving stale text over someone who has walked off.
 */
const BUBBLE_MS = 8_000;
/** A bubble is a glance, not a transcript. The panel on the right has the whole thing. */
const BUBBLE_CHARS = 110;

/**
 * Read once at module load, like every other flag here: the world is built in an effect, and a
 * value that could change between renders would silently rebuild it.
 */
const requestedAgents = requestedAgentCount((import.meta as any).env?.VITE_DEMO_AGENTS);

function RunningDemo({ scene }: { scene: Scene }) {
  const [runtime, setRuntime] = useState<AgenticRuntime | Error>();
  useEffect(() => {
    try {
      setRuntime(
        createAgenticWorld({
          source: solariumWorldSource(scene, { agents: requestedAgents }),
          worldId: 'solarium-demo',
          godEnabled: false,
        }),
      );
    } catch (e) {
      setRuntime(e as Error);
    }
  }, [scene]);

  if (runtime instanceof Error)
    return <p role="alert">The demo world failed to build: {runtime.message}</p>;
  if (!runtime) return <p role="status">Building the world…</p>;
  return <DemoStage scene={scene} runtime={runtime} />;
}

function DemoStage({ scene, runtime }: { scene: Scene; runtime: AgenticRuntime }) {
  const [wrapperRef, { width, height }] = useElementSize();
  const [, setFrame] = useState(0);
  const messages = useConversationMessages(runtime);
  const [follow, setFollow] = useState(true);
  const [focus, setFocus] = useState({
    x: runtime.game.worldMap.width / 2,
    y: runtime.game.worldMap.height / 2,
  });

  /**
   * Keep the crowd on screen.
   *
   * `PixiViewport` clamps zoom to *cover* the screen rather than to fit the map in it
   * (`viewportScale`), so on this room there is always more world than viewport and the cast
   * will not stay in it on their own. Recentring on their midpoint once a second is enough to
   * follow them without the picture sliding continuously -- and it stops entirely when the
   * checkbox is off, because the viewport is draggable and a follow that cannot be switched off
   * would drag it back.
   */
  useEffect(() => {
    if (!follow) return;
    const timer = window.setInterval(() => {
      const players = runtime.game.world.sortedPlayers();
      if (!players.length) return;
      setFocus({
        x: Math.round(players.reduce((sum, p) => sum + p.position.x, 0) / players.length),
        y: Math.round(players.reduce((sum, p) => sum + p.position.y, 0) / players.length),
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runtime, follow]);

  useEffect(() => {
    let handle = 0;
    let previous = performance.now();
    const frame = () => {
      handle = requestAnimationFrame(frame);
      const now = performance.now();
      const elapsed = Math.floor(now - previous);
      // Consumed before anything may bail on it. That is docs/11 §4.5, and it is the whole reason
      // a laptop waking from sleep does not fire an hour of decisions nobody was present for.
      previous += elapsed;
      if (document.hidden || elapsed <= 0) return;
      runtime.advance(Math.min(elapsed, 160));
      setFrame((n) => n + 1);
    };
    handle = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(handle);
  }, [runtime]);

  const game = runtime.game;
  // Live engine objects, re-read every frame. There is nothing to copy and nothing to subscribe
  // to: this component is running the tick it is drawing (docs/11 §1).
  const snapshot: GameSnapshot = {
    world: game.world,
    playerDescriptions: game.playerDescriptions,
    agentDescriptions: game.agentDescriptions,
    entityDescriptions: game.entityDescriptions,
    worldMap: game.worldMap,
  };
  const scale = scene.map.playerScale ?? 1;
  const players = game.world.sortedPlayers();

  return (
    <div className="flex h-[100dvh] min-h-0 w-full flex-col bg-brown-900 text-brown-100 lg:flex-row">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden" ref={wrapperRef}>
        {width > 0 && height > 0 && (
          <Stage width={width} height={height} options={{ backgroundColor: 0x000000 }}>
            <TownViewport
              map={game.worldMap}
              width={width}
              height={height}
              focus={follow ? focus : undefined}
              // The room draws itself with art, so the tile layers stay unpainted -- the same
              // decision `LocalGame` makes for every `remaining-time` scene.
              background={<></>}
            >
              <Container sortableChildren>
                {scene.map.art?.map((art, i) => (
                  <AssetSprite
                    key={`art-${i}`}
                    visual={art}
                    position={art.position}
                    depth={art.depth}
                  />
                ))}
                {game.world.sortedEntities().map((entity) => (
                  <Container key={entity.id} zIndex={game.worldMap.anchor(entity.anchor)?.y ?? 0}>
                    <EntityMarker
                      game={snapshot}
                      entity={entity}
                      isSelected={false}
                      onClick={() => {}}
                    />
                  </Container>
                ))}
                {players.map((player) => (
                  <Player
                    key={player.id}
                    game={snapshot}
                    player={player}
                    scale={scale}
                    isViewer={false}
                    onClick={() => {}}
                  />
                ))}
                {players.map((player) => {
                  const said = messages.spoken.get(player.id);
                  if (!said) return null;
                  return (
                    <SpeechBubble
                      key={`bubble-${player.id}`}
                      text={said}
                      x={player.position.x * game.worldMap.tileDim + game.worldMap.tileDim / 2}
                      y={player.position.y * game.worldMap.tileDim - 8 * scale}
                    />
                  );
                })}
              </Container>
            </TownViewport>
          </Stage>
        )}
      </div>
      <Transcript runtime={runtime} log={messages.log} follow={follow} onFollow={setFollow} />
    </div>
  );
}

/**
 * The messages, pulled out of the store.
 *
 * `listMessages` is async because `AgentStore` has to be -- the Postgres implementation of it is
 * a query -- so the read cannot happen during render even though the in-memory one resolves on
 * the next microtask. Refetching is keyed on `lastMessage.timestamp`, which the input handler
 * stamps as the message lands, so each conversation is read exactly once per line rather than
 * once per frame.
 */
function useConversationMessages(runtime: AgenticRuntime) {
  const [byConversation, setByConversation] = useState<Record<string, StoredMessage[]>>({});
  const fetched = useRef<Record<string, number>>({});
  const [, setPoll] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const conversation of runtime.game.world.conversations.values()) {
        const stamp = conversation.lastMessage?.timestamp ?? 0;
        if (!stamp || fetched.current[conversation.id] === stamp) continue;
        fetched.current[conversation.id] = stamp;
        void runtime.store.listMessages(conversation.id).then((list) => {
          setByConversation((previous) => ({ ...previous, [conversation.id]: list }));
        });
      }
      // Bubbles expire on wall time, so the view has to be re-evaluated even when nothing new
      // was said.
      setPoll((n) => n + 1);
    }, 250);
    return () => window.clearInterval(timer);
  }, [runtime]);

  const now = Date.now();
  const spoken = new Map<string, string>();
  for (const conversation of runtime.game.world.conversations.values()) {
    const list = byConversation[conversation.id];
    const last = list?.[list.length - 1];
    if (!last || now - last.createdAt > BUBBLE_MS) continue;
    spoken.set(
      last.author,
      last.text.length > BUBBLE_CHARS ? `${last.text.slice(0, BUBBLE_CHARS)}…` : last.text,
    );
  }
  // Newest last, so the panel reads like a transcript. Conversations are kept apart because two
  // running at once interleave into nonsense otherwise.
  const log = Object.entries(byConversation)
    .map(([id, list]) => ({ id, list }))
    .sort((a, b) => (a.list[0]?.createdAt ?? 0) - (b.list[0]?.createdAt ?? 0));
  return { spoken, log };
}

function Transcript({
  runtime,
  log,
  follow,
  onFollow,
}: {
  runtime: AgenticRuntime;
  log: { id: string; list: StoredMessage[] }[];
  follow: boolean;
  onFollow: (value: boolean) => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const total = log.reduce((sum, entry) => sum + entry.list.length, 0);
  useEffect(() => {
    // A block body, not a concise one: a concise arrow hands React whatever the call returned as
    // the effect's cleanup, and React calls it.
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [total]);
  const nameOf = (playerId: string) =>
    runtime.game.playerDescriptions.get(playerId as never)?.name ?? playerId;
  const live = new Set([...runtime.game.world.conversations.keys()]);
  const agents = runtime.game.world.agents.size;

  return (
    <aside className="flex min-h-0 shrink-0 flex-col gap-3 overflow-y-auto border-brown-900 bg-brown-800 px-4 py-5 lg:w-96 lg:border-l-8">
      <header>
        <h1 className="text-lg">Solarium · agentic flow check</h1>
        <p className="text-sm opacity-70">
          {agents} agent{agents === 1 ? '' : 's'}, no player, no god, nothing saved. {total} message
          {total === 1 ? '' : 's'} so far.
        </p>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} />
          Keep the camera on the agents
        </label>
      </header>
      {log.length === 0 && (
        <p className="text-sm opacity-70">
          Nobody has spoken yet. The first decision is a model call, so give it a few seconds — and
          check the console if it stays quiet.
        </p>
      )}
      {log.map(({ id, list }) => (
        <section key={id} className="border border-brown-500 p-3">
          <h2 className="mb-2 text-xs uppercase tracking-wide opacity-60">
            {live.has(id as never) ? 'talking' : 'ended'}
          </h2>
          <ol className="flex flex-col gap-2">
            {list.map((message) => (
              <li key={message.messageUuid} className="text-sm">
                <span className="opacity-60">{nameOf(message.author)}: </span>
                {message.text}
              </li>
            ))}
          </ol>
        </section>
      ))}
      <div ref={bottom} />
    </aside>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Container, Stage } from '@pixi/react';
import { Scene } from '../../prototype/content';
import { decider } from '../../agent/config';
import { StoredMessage } from '../../agent/ports';
import { GameSnapshot } from '../hooks/gameSnapshot';
import { useElementSize } from '../hooks/useElementSize';
import { watch, outstanding } from '../../agent/model/watchdog';
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
    // The first of the three things that can leave this page showing a status line forever. It is
    // twenty-six scenes' worth of JSON over `fetch`, so it is a real wait and it can hang.
    const done = watch('demo', `load scene ${SOLARIUM_SCENE_ID}`);
    loadScene(SOLARIUM_SCENE_ID, controller.signal)
      .then((loaded) => {
        done('loaded');
        if (!controller.signal.aborted) setScene(loaded);
      })
      .catch((e: Error) => {
        done(`failed: ${e.message}`);
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      done('abandoned');
      controller.abort();
    };
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
 * How often the demo says it is still there.
 *
 * Ten seconds is longer than any healthy wait in the loop and short enough that nobody stares at
 * a frozen room wondering whether to reload. It is a fixed cost of one line per interval, which
 * is the price of a run that explains itself when it stops.
 */
const HEARTBEAT_MS = 10_000;

/**
 * Read once at module load, like every other flag here: the world is built in an effect, and a
 * value that could change between renders would silently rebuild it.
 */
const requestedAgents = requestedAgentCount((import.meta as any).env?.VITE_DEMO_AGENTS);

function RunningDemo({ scene }: { scene: Scene }) {
  const [runtime, setRuntime] = useState<AgenticRuntime | Error>();
  useEffect(() => {
    // Synchronous, so it cannot hang -- but with `VITE_DEMO_AGENTS` able to ask for fifty it can
    // be slow, and a slow build is indistinguishable from a stuck one from the outside. The
    // timing also pins down which side of the build a later silence started on.
    const started = performance.now();
    console.log(`[demo] building the world · ${requestedAgents} agents requested`);
    try {
      const built = createAgenticWorld({
        source: solariumWorldSource(scene, { agents: requestedAgents }),
        worldId: 'solarium-demo',
        godEnabled: false,
      });
      console.log(
        `[demo] world built in ${Math.round(performance.now() - started)}ms · ` +
          `${built.game.world.agents.size} agents, ${built.game.world.players.size} players, ` +
          `decider ${decider()}`,
      );
      setRuntime(built);
    } catch (e) {
      console.error('[demo] the world failed to build:', e);
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
   * follow them without the picture sliding continuously. There is no switch for it: the viewport
   * still drags and zooms, but a drag away from the crowd is pulled back at the next tick.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const players = runtime.game.world.sortedPlayers();
      if (!players.length) return;
      setFocus({
        x: Math.round(players.reduce((sum, p) => sum + p.position.x, 0) / players.length),
        y: Math.round(players.reduce((sum, p) => sum + p.position.y, 0) / players.length),
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runtime]);

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

  /**
   * A pulse, so a run that has stopped says why.
   *
   * "Stuck" has three causes that look identical on screen and the three lines this prints tell
   * them apart. **No game time** means the `requestAnimationFrame` loop above is not running --
   * a thrown render, a backgrounded tab -- and nothing below it will ever fire. **Game time but
   * no new inputs, with work in flight** means the simulation is fine and the loop is blocked on
   * something outside it; `outstanding()` names it, and the `[model]` and `[proxy]` lines follow
   * it across the process boundary. **Game time, no new inputs, and nothing in flight** is the
   * uncomfortable one: nobody is waiting on anything, so the agents have decided to stand still
   * and that is the decider's answer rather than a hang.
   */
  useEffect(() => {
    let lastTime = runtime.time;
    // `version` rather than `events().length`, which a sync flush is entitled to prune.
    let lastVersion = runtime.version;
    const timer = window.setInterval(() => {
      const waiting = outstanding();
      const advanced = Math.round((runtime.time - lastTime) / 1000);
      const inputs = runtime.version - lastVersion;
      lastTime = runtime.time;
      lastVersion = runtime.version;
      console.log(
        `[demo] +${advanced}s game time · ${inputs} new input${inputs === 1 ? '' : 's'} · ` +
          `${runtime.game.world.conversations.size} conversation` +
          `${runtime.game.world.conversations.size === 1 ? '' : 's'} · ` +
          (waiting.length
            ? `waiting on ${waiting.length}: ` +
              waiting
                .slice(0, 3)
                .map((w) => `${w.label} (${Math.round(w.waitingMs / 1000)}s)`)
                .join(', ')
            : 'nothing in flight'),
      );
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
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
              focus={focus}
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
      <Transcript runtime={runtime} log={messages.log} />
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

/** The arguments of `agentDecideAction`, the input a decision re-enters the world through. */
type DecideArgs = {
  agentId: string;
  action: 'approach' | 'wander' | 'idle';
  target?: string;
  anchor?: string;
  description?: string;
  reason: string;
  problems?: string[];
};

interface DecisionEntry {
  id: string;
  at: number;
  who: string;
  what: string;
  reason: string;
  problems: string[];
}

/**
 * The decisions, read straight off the runtime's input log.
 *
 * Nothing extra is recorded to show these. Every decision already re-enters the world as an
 * `agentDecideAction` input (docs/09 §5) and `AgenticRuntime.send` stamps each input with the wall
 * time it landed, which is exactly what is needed to merge them with the transcript in time order.
 * A decision belongs to no conversation by definition -- it is what an agent does *instead* of
 * being in one -- so this is the only place the two streams meet.
 *
 * `reason` is the field worth reading, and what it contains depends on who answered. Under
 * `ACTION_DECIDER=jev` the model writes no prose at all and the reason is synthesized from the
 * numbers -- `seek 0.83 · talk to Bob p=0.62 c=0.70`, the distribution the choice actually came
 * from (docs/12 §3). Under the chat decider it is a sentence the model wrote about itself. Both
 * are that decider's raw output, so both are shown verbatim rather than prettified.
 */
function decisionLog(runtime: AgenticRuntime): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  for (const event of runtime.events()) {
    if (event.name !== 'agentDecideAction') continue;
    const args = event.args as DecideArgs;
    const agent = runtime.game.world.agents.get(args.agentId as never);
    entries.push({
      id: `decision-${event.idx}`,
      at: event.wallTime,
      who: agent ? nameIn(runtime, agent.playerId) : args.agentId,
      what: describeAction(runtime, args),
      reason: args.reason,
      problems: args.problems ?? [],
    });
  }
  return entries;
}

function nameIn(runtime: AgenticRuntime, playerId: string): string {
  return runtime.game.playerDescriptions.get(playerId as never)?.name ?? playerId;
}

/** What the decider picked: the action, and the thing it is about. */
function describeAction(runtime: AgenticRuntime, args: DecideArgs): string {
  switch (args.action) {
    case 'approach':
      // A tier-(a) target is a player id and has a name; anything else is an entity, which does
      // not, so its id stands in.
      return `approach ${
        args.target?.startsWith('p:') ? nameIn(runtime, args.target) : (args.target ?? '?')
      }`;
    case 'wander':
      // Anchor ids are snake_case and readable once they are not, as in `decideJev.ts`.
      return `wander to the ${(args.anchor ?? '?').replace(/_/g, ' ')}`;
    default:
      return args.description ?? 'idle';
  }
}

/**
 * The right-hand column: decisions and conversations, in one list, in the order they happened.
 *
 * Two independent switches rather than two panes. The point of the check is the loop -- decide,
 * walk, invite, converse -- and a decision sitting between the conversation it interrupted and the
 * one it started is the only arrangement in which that is visible. Either stream can be turned off
 * on its own: the decisions alone are the decider under a microscope, the conversations alone are
 * what the demo used to show.
 *
 * A conversation stays a **single block** rather than dissolving into its lines. Two agents talking
 * is one thing happening, and interleaving its messages with three other agents' decisions would
 * shred it. The block sorts by its first line, so it keeps its place in the column while it grows
 * and the decisions taken during it fall in after it.
 */
function Transcript({
  runtime,
  log,
}: {
  runtime: AgenticRuntime;
  log: { id: string; list: StoredMessage[] }[];
}) {
  const [showDecisions, setShowDecisions] = useState(true);
  const [showConversations, setShowConversations] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const total = log.reduce((sum, entry) => sum + entry.list.length, 0);
  const live = new Set([...runtime.game.world.conversations.keys()]);
  const agents = runtime.game.world.agents.size;

  const feed = [
    ...(showConversations
      ? log.map((conversation) => ({
          kind: 'conversation' as const,
          at: conversation.list[0]?.createdAt ?? 0,
          ...conversation,
        }))
      : []),
    ...(showDecisions
      ? decisionLog(runtime).map((decision) => ({ kind: 'decision' as const, ...decision }))
      : []),
  ].sort((a, b) => a.at - b.at);

  useEffect(() => {
    // A block body, not a concise one: a concise arrow hands React whatever the call returned as
    // the effect's cleanup, and React calls it.
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [feed.length, total]);

  return (
    <aside className="flex max-h-[50dvh] min-h-0 shrink-0 flex-col border-brown-900 bg-brown-800 lg:max-h-none lg:w-96 lg:border-l-8">
      {/*
        The header does not scroll: the switches are the controls for what is below them, and a
        column that grows all evening would carry them off the top within a minute. So the panel
        is the flex container and only the feed inside it scrolls -- which is also why the aside
        needs a bounded height when it is stacked under the stage rather than beside it, since
        nothing else would stop it from growing past the viewport on a narrow screen.
      */}
      <header className="shrink-0 border-b border-brown-900 px-4 pb-3 pt-5">
        <h1 className="text-lg">Solarium · agentic flow check</h1>
        <p className="text-sm opacity-70">
          {agents} agent{agents === 1 ? '' : 's'}, no player, no god, nothing saved. {total} message
          {total === 1 ? '' : 's'} so far.
        </p>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showDecisions}
              onChange={(e) => setShowDecisions(e.target.checked)}
            />
            {/* Named for whoever is actually answering: the flag has two settings (docs/12 §2). */}
            {decider()} decisions
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showConversations}
              onChange={(e) => setShowConversations(e.target.checked)}
            />
            conversations
          </label>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {feed.length === 0 && (
          <p className="text-sm opacity-70">
            {showDecisions || showConversations
              ? 'Nothing has happened yet. The first decision is a model call, so give it a few seconds — and check the console if it stays quiet.'
              : 'Both switches are off, so there is nothing to show.'}
          </p>
        )}
        {feed.map((entry) =>
          entry.kind === 'conversation' ? (
            <section key={entry.id} className="border border-brown-500 p-3">
              <h2 className="mb-2 text-xs uppercase tracking-wide opacity-60">
                {live.has(entry.id as never) ? 'talking' : 'ended'}
              </h2>
              <ol className="flex flex-col gap-2">
                {entry.list.map((message) => (
                  <li key={message.messageUuid} className="text-sm">
                    <span className="opacity-60">{nameIn(runtime, message.author)}: </span>
                    {message.text}
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <div key={entry.id} className="border-l-2 border-brown-500 pl-3">
              <p className="text-sm">
                <span className="opacity-60">{entry.who} · </span>
                {entry.what}
              </p>
              <p className="text-xs opacity-60">{entry.reason}</p>
              {entry.problems.map((problem, i) => (
                <p key={i} className="text-xs text-brown-300">
                  {problem}
                </p>
              ))}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>
    </aside>
  );
}

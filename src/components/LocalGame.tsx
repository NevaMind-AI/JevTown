import { contentPackage } from '../lib/localMode';
import DialogueBubble from './DialogueBubble';
import type { Viewport } from 'pixi-viewport';
import DebugConsole from './DebugConsole';
import WaitPanel from './WaitPanel';
import { Gain, useGainNotifications } from './GainNotifications';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Character } from './Character';
import RoomPlayer from './RoomPlayer';
import RoomNpc from './RoomNpc';
import NpcAnimationPreview from './NpcAnimationPreview';
import { roomNpcId } from '../lib/roomNpcAnimation';
import { Graphics, Text, Container } from '@pixi/react';
import AssetSprite from './AssetSprite';
import { interactionHighlight } from '../lib/interactionHighlight';
import { taskGuidance } from '../lib/taskGuidance';
import { TextStyle } from 'pixi.js';
import GameFrame from './GameFrame';
import TownViewport from './TownViewport';
import { characters } from '../../data/characters';
import { MemoryWorld, formatTime } from '../../prototype/world';
import TimeHud from './TimeHud';
import GoodsPanel, { GoodsMode } from './GoodsPanel';
import TaskBoard from './TaskBoard';
import { sceneMap, localRoom } from '../../prototype/map';
import { catalogue, restoreSlot, SaveHead, SavePlayback } from '../lib/autosaves';
import { useAutoSaves, Restored, PlayHandler } from './AutoSaves';
import { loadPackage, Package } from '../../prototype/package';
import { useAgenticRuntime } from '../sim/useAgenticRuntime';
type PlaybackSession = SavePlayback & { playing: boolean; speed: number };
export default function LocalGame({ controlsBlocked }: { controlsBlocked: boolean }) {
  const gains = useGainNotifications();
  const [content, setContent] = useState<Package>();
  const [error, setError] = useState('');
  const [session, setSession] = useState<PlaybackSession>();
  const [generation, setGeneration] = useState(0);
  const [saved, setSaved] = useState<Restored>();
  const [bootError, setBootError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let head: SaveHead = { revision: 'empty', slot: 0, sequence: 0 };
      try {
        const existing = await catalogue();
        head = existing.head;
        if (cancelled) return;
        const restored = head.slot
          ? await restoreSlot(head.slot, head, (text) => {
              if (!cancelled) setError(text);
            })
          : { head };
        if (!cancelled) {
          setSaved(restored);
          setError('');
        }
      } catch (e) {
        if (!cancelled) {
          setSaved({ head });
          setBootError((e as Error).message);
          setError('');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const restored = (value: Restored) => {
    gains.clear();
    setSaved(value);
    setSession(undefined);
    setBootError('');
    setError('');
    setGeneration((n) => n + 1);
  };
  const played: PlayHandler = (value, live, playing = true, speed = 1) => {
    if (!session) {
      gains.clear();
      setSaved(live);
    }
    setSession({ ...value, playing, speed });
    setError('');
    setGeneration((n) => n + 1);
  };
  useEffect(() => {
    const controller = new AbortController();
    const root = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/content/${contentPackage}/`;
    const mapFiles = import.meta.glob('../content/*/{maps,animations}/*.json', {
      as: 'url',
      eager: true,
    });
    const read = async (path: string) => {
      const url = mapFiles[`../content/${contentPackage}/${path}`] ?? root + path;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Content load failed: ${path}`);
      const text = await response.text();
      if (text.length > 1_000_000) throw new Error('Content file too large');
      return JSON.parse(text);
    };
    void read('manifest.json')
      .then((m) => loadPackage(m, read))
      .then((c) => {
        if (!controller.signal.aborted) setContent(c);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  if (!content || !saved) return <p role="status">{error || '正在加载场景与自动存档…'}</p>;
  return (
    <LoadedLocalGame
      key={generation}
      gains={gains}
      controlsBlocked={controlsBlocked}
      content={content}
      session={session}
      initialWorld={saved.world}
      initialHead={saved.head}
      bootError={session ? '' : bootError}
      onRestore={restored}
      onPlay={played}
      onExit={() => {
        gains.clear();
        setSession(undefined);
        setGeneration((n) => n + 1);
      }}
    />
  );
}
function LoadedLocalGame({
  gains,
  controlsBlocked,
  content: providedContent,
  session,
  initialWorld,
  initialHead,
  bootError,
  onRestore,
  onPlay,
  onExit,
}: {
  gains: ReturnType<typeof useGainNotifications>;
  controlsBlocked: boolean;
  content: Package;
  session?: PlaybackSession;
  initialWorld?: MemoryWorld;
  initialHead: SaveHead;
  bootError: string;
  onRestore: (saved: Restored) => void;
  onPlay: PlayHandler;
  onExit: () => void;
}) {
  const replay = session?.replay;
  const [content] = useState(
    () => replay?.world.recording().content ?? initialWorld?.recording().content ?? providedContent,
  );
  const [watching] = useState(!!replay);
  const [playing, setPlaying] = useState(session?.playing ?? false);
  const [speed, setSpeed] = useState(session?.speed ?? 1);
  const [cursor, setCursor] = useState(replay?.index ?? 0);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [stepMs] = useState(
    () =>
      replay?.world.recording().config.stepMs ??
      initialWorld?.recording().config.stepMs ??
      localRoom.stepMs,
  );
  const [world] = useState(() => {
    if (replay) return replay.world;
    if (initialWorld) return initialWorld;
    const runtime = new MemoryWorld(Date.now, Math.random, localRoom);
    runtime.load(content.scenes, content.story, content.npcs);
    return runtime;
  });
  const [state, setState] = useState(() => world.inspect());
  // The agentic world, when it is switched on. It rides the same clock as `world` below rather
  // than keeping one of its own -- see `useAgenticRuntime` for why that matters.
  const agentic = useAgenticRuntime();
  const gainCursor = useRef<{
    sequence: number;
    state: Pick<typeof state, 'tasks' | 'commerce' | 'clues' | 'balance' | 'storyTime'>;
  }>({ sequence: world.recordingStats().end, state });
  const itemDefinitions = useMemo(
    () => new Map((content.story.items ?? []).map((item) => [item.id, item])),
    [content],
  );
  const collectGains = () => {
    const receipts: Gain[] = [];
    for (const event of world.history(gainCursor.current.sequence)) {
      const before = gainCursor.current.state;
      if (event.result.ok) {
        for (const task of content.story.tasks ?? []) {
          const previous = before.tasks[task.id],
            next = event.state.tasks[task.id];
          if (!next || (task.trigger && !next.activated)) continue;
          const started = !!task.trigger && !previous?.activated;
          const changed =
            next.completed.length > (previous?.completed.length ?? 0) ||
            task.steps.some(
              (step) => (next.steps[step.id]?.count ?? 0) > (previous?.steps[step.id]?.count ?? 0),
            );
          if (!started && !changed) continue;
          const current = task.steps.find((step) => !next.completed.includes(step.id));
          receipts.push({
            kind: !current ? 'task-complete' : started ? 'task' : 'task-progress',
            name:
              task.title +
              (current
                ? ` · ${current.text}${current.condition.count > 1 ? `（${next.steps[current.id]?.count ?? 0}/${current.condition.count}）` : ''}`
                : ''),
          });
        }
        for (const [id, quantity] of Object.entries(event.state.commerce?.inventory ?? {})) {
          const amount = quantity - (before.commerce?.inventory[id] ?? 0),
            item = itemDefinitions.get(id);
          if (amount > 0 && item)
            receipts.push({ name: item.name, image: item.image, amount: String(amount) });
        }
        const newClues = (event.state.clues ?? []).filter(
          (id) => !before.clues?.includes(id),
        ).length;
        if (newClues) receipts.push({ name: '遗物线索', amount: String(newClues) });
        const income =
          event.state.balance -
          before.balance +
          (event.cause.type === 'advance' && content.story.clock
            ? event.state.storyTime - before.storyTime
            : 0);
        if (income > 0) receipts.push({ name: '余时', amount: formatTime(income) });
      }
      gainCursor.current = { sequence: event.sequence, state: event.state };
    }
    gains.add(receipts);
  };
  const resetGains = () => {
    gains.clear();
    gainCursor.current = { sequence: world.recordingStats().end, state: world.inspect() };
  };
  const pendingTime = useRef(0),
    replayTime = useRef(0);
  const [frameMs, setFrameMs] = useState(0);
  const [feedback, setFeedback] = useState('');
  const saves = useAutoSaves(world, !watching, initialHead, onRestore, onPlay, bootError, () =>
    flushTime(),
  );
  const capacityReached = world.recordingCapacityReached();
  const [paused, setPaused] = useState(document.hidden || !document.hasFocus());
  const [idlePaused, setIdlePaused] = useState(false);
  const idlePauseRef = useRef(false),
    lastActivity = useRef(performance.now());
  const [tasksOpen, setTasksOpen] = useState(false);
  const [hudHidden, setHudHidden] = useState(false);
  const [goodsMode, setGoodsMode] = useState<GoodsMode | null>(null);
  const [waitOpen, setWaitOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [sleepChoice, setSleepChoice] = useState<string | null>(null);
  const [npcPreviewOpen, setNpcPreviewOpen] = useState(false);
  useEffect(() => setNpcPreviewOpen(false), [state.dialogue, state.activeEntity, state.sceneId]);
  const goodsOpen = useRef(false);
  goodsOpen.current =
    goodsMode !== null || waitOpen || consoleOpen || sleepChoice !== null || npcPreviewOpen;
  const [sprintEnabled] = useState(() => world.recording().rules !== 'memory-world-1');
  const sprint = useRef(false);
  useEffect(() => {
    const hide = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        controlsBlocked ||
        goodsOpen.current ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,[contenteditable="true"]'))
      )
        return;
      if (event.key.toLowerCase() === 'h') {
        event.preventDefault();
        setHudHidden((value) => !value);
      }
    };
    window.addEventListener('keydown', hide);
    return () => window.removeEventListener('keydown', hide);
  }, [controlsBlocked]);
  const blocked = useRef(controlsBlocked);
  blocked.current = controlsBlocked || tasksOpen || watching || saves.blocked || idlePaused;
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  const keys = useRef(new Set<string>());
  const curtain = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Viewport>();
  const transitioning = useRef(false);
  const displayedScene = useRef(state.sceneId);
  const animation = useRef<Animation>();
  useEffect(
    () => () => {
      animation.current?.cancel();
    },
    [],
  );
  const flushTime = () => {
    if (watchingRef.current || !pendingTime.current) return true;
    const result = world.step(pendingTime.current);
    pendingTime.current = 0;
    collectGains();
    if (!result.ok) setFeedback(result.error);
    return result.ok;
  };
  const publish = () => {
    collectGains();
    if (transitioning.current) return;
    const next = world.inspect();
    setFrameMs(
      watchingRef.current
        ? Math.min(replayTime.current, replay?.nextDelayMs ?? 0)
        : pendingTime.current,
    );
    if (watchingRef.current || next.sceneId === displayedScene.current) {
      displayedScene.current = next.sceneId;
      setState(next);
      return;
    }
    transitioning.current = true;
    keys.current.clear();
    void (async () => {
      const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
      try {
        animation.current = curtain.current!.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration,
          fill: 'forwards',
        });
        await animation.current.finished;
        displayedScene.current = next.sceneId;
        setState(next);
        // Keep the curtain opaque while React mounts the destination map.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        animation.current = curtain.current!.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration,
          fill: 'forwards',
        });
        await animation.current.finished;
      } catch {
        /* Unmount cancels the animation. */
      } finally {
        transitioning.current = false;
      }
    })();
  };
  const send = (command: object) => {
    if (transitioning.current || blocked.current || watchingRef.current || !flushTime())
      return false;
    const previousScene = world.inspect().sceneId;
    const result = world.execute({ requestId: crypto.randomUUID(), ...command });
    if (world.inspect().sceneId !== previousScene) keys.current.clear();
    publish();
    setFeedback(result.ok ? '操作完成' : result.error);
    return result.ok;
  };
  const openInventory = (mode: 'bag' | 'relics') => {
    keys.current.clear();
    sprint.current = false;
    setFeedback('');
    setGoodsMode(mode);
  };
  const openWait = () => {
    const current = world.inspect();
    if (
      !content.story.clock ||
      watching ||
      blocked.current ||
      goodsOpen.current ||
      transitioning.current ||
      current.moving ||
      current.dialogue ||
      current.balance <= 0 ||
      !flushTime()
    )
      return;
    keys.current.clear();
    sprint.current = false;
    setFeedback('');
    publish();
    setWaitOpen(true);
  };
  const openDebugConsole = () => {
    if (controlsBlocked || watching || saves.blocked || capacityReached || !flushTime()) return;
    keys.current.clear();
    sprint.current = false;
    setFeedback('');
    setConsoleOpen(true);
    publish();
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        !import.meta.env.DEV ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,[contenteditable="true"]'))
      )
        return;
      if (event.key !== '`' && event.key !== '~' && event.code !== 'Backquote') return;
      event.preventDefault();
      if (consoleOpen) {
        setConsoleOpen(false);
        return;
      }
      openDebugConsole();
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, [capacityReached, consoleOpen, controlsBlocked, saves.blocked, watching]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        controlsBlocked ||
        tasksOpen ||
        saves.blocked ||
        goodsOpen.current ||
        transitioning.current ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,[contenteditable="true"]'))
      )
        return;
      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        openWait();
        return;
      }
      if (event.key === '1' || event.key === '2') {
        event.preventDefault();
        openInventory(event.key === '1' ? 'bag' : 'relics');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [controlsBlocked, tasksOpen, saves.blocked]);
  useEffect(() => {
    let previous = performance.now();
    const stop = () => {
      if (watchingRef.current) return;
      flushTime();
      keys.current.clear();
      sprint.current = false;
      publish();
    };
    const activity = () => {
      if (document.hidden || !document.hasFocus()) return;
      lastActivity.current = performance.now();
      if (idlePauseRef.current) {
        idlePauseRef.current = false;
        setIdlePaused(false);
        previous = performance.now();
      }
    };
    const focus = () => {
      previous = performance.now();
      setPaused(false);
      activity();
    };
    const blur = () => {
      stop();
      setPaused(true);
    };
    const visibility = () => {
      previous = performance.now();
      stop();
      setPaused(document.hidden || !document.hasFocus());
      if (!document.hidden) activity();
    };
    const directions: Record<string, number[]> = {
      w: [0, -1],
      arrowup: [0, -1],
      s: [0, 1],
      arrowdown: [0, 1],
      a: [-1, 0],
      arrowleft: [-1, 0],
      d: [1, 0],
      arrowright: [1, 0],
    };
    const down = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        transitioning.current ||
        blocked.current ||
        goodsOpen.current ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,[contenteditable="true"]'))
      )
        return;
      sprint.current = event.shiftKey;
      if (key in directions) {
        if (world.inspect().dialogue) return;
        event.preventDefault();
        if (!keys.current.has(key) && !flushTime()) return;
        keys.current.add(key);
      } else if (!event.repeat && key === 'e') {
        event.preventDefault();
        if (world.inspect().dialogue) return;
        stop();
        send(
          world.inspect().seated
            ? { type: 'stand' }
            : { type: 'interact', target: world.nearby()[0]?.id ?? '' },
        );
      } else if (key === 'escape') {
        stop();
        send({ type: 'closeDialogue' });
      }
    };
    const up = (event: KeyboardEvent) => {
      sprint.current = event.shiftKey;
      keys.current.delete(event.key.toLowerCase());
      if (!keys.current.size) stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    for (const event of ['keydown', 'pointerdown', 'pointermove', 'wheel'])
      window.addEventListener(event, activity, true);
    document.addEventListener('visibilitychange', visibility);
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.floor(now - previous);
      previous += elapsed;
      if (watchingRef.current) return;
      if (transitioning.current || document.hidden || !document.hasFocus() || elapsed <= 0) {
        if (pendingTime.current) {
          flushTime();
          publish();
        }
        return;
      }
      if (world.recordingCapacityReached()) {
        keys.current.clear();
        return;
      }
      let current = world.inspect();
      if (idlePauseRef.current) return;
      if (blocked.current || goodsOpen.current) {
        lastActivity.current = now;
        if (pendingTime.current) {
          flushTime();
          publish();
        }
        if (keys.current.size) stop();
        return;
      }
      const idleMs = (content.story.clock?.idlePauseSeconds ?? Infinity) * 1000;
      const idle = now - lastActivity.current >= idleMs;
      const activeElapsed = Math.max(
        0,
        Math.min(elapsed, Math.floor(lastActivity.current + idleMs - (now - elapsed))),
      );
      const quantum = Math.min(activeElapsed, 160);
      pendingTime.current += quantum;
      // Same budget, same cap, same bail conditions: this line is reached only when the loop has
      // already decided this elapsed time should be simulated (docs/11 §4.5).
      agentic?.advance(quantum);
      if (current.seated || current.dialogue) {
        keys.current.clear();
        sprint.current = false;
      }
      let changed = false;
      while (true) {
        const key = [...keys.current].at(-1);
        if (!current.moving && key) {
          const [dx, dy] = directions[key];
          const result = world.execute({
            requestId: crypto.randomUUID(),
            type: 'move',
            dx,
            dy,
            ...(sprint.current && sprintEnabled ? { sprint: true } : {}),
          });
          if (!result.ok) {
            setFeedback(result.error);
            keys.current.clear();
          }
          const next = world.inspect();
          if (next.sceneId !== current.sceneId) keys.current.clear();
          current = next;
          changed = true;
        }
        if (
          !content.story.clock &&
          !current.moving &&
          !Object.values(current.entities).some((e) => e.path.length || e.transit)
        ) {
          pendingTime.current = 0;
          break;
        }
        // Simulate at most 100ms (or to an actor arrival); step() records only effective changes.
        const moving = [current.moving, ...Object.values(current.entities).map((e) => e.moving)];
        const ms = Math.min(
          100,
          ...moving.map((m) => (m ? Math.max(1, m.arrivesAt - current.time) : 100)),
        );
        if (pendingTime.current < ms) break;
        pendingTime.current -= ms;
        const result = world.step(ms);
        changed = true;
        if (!result.ok) {
          setFeedback(result.error);
          pendingTime.current = 0;
          break;
        }
        current = world.inspect();
      }
      if (idle) {
        flushTime();
        keys.current.clear();
        idlePauseRef.current = true;
        setIdlePaused(true);
        publish();
      } else if (changed) publish();
      else setFrameMs(pendingTime.current);
    }, 16);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      for (const event of ['keydown', 'pointerdown', 'pointermove', 'wheel'])
        window.removeEventListener(event, activity, true);
    };
  }, [world]);
  const stepReplay = () => {
    if (!replay || transitioning.current || playbackFailed || saves.blocked) return;
    try {
      replayTime.current = 0;
      replay.step();
      setCursor(replay.index);
      publish();
    } catch (e) {
      setPlaying(false);
      setPlaybackFailed(true);
      setFeedback((e as Error).message);
    }
  };
  useEffect(() => {
    if (
      !watching ||
      !playing ||
      !replay ||
      !session ||
      saves.blocked ||
      controlsBlocked ||
      tasksOpen ||
      goodsMode ||
      paused ||
      playbackFailed
    )
      return;
    if (replay.index >= replay.total) {
      if (session.id < session.slots.length)
        void saves.play(session.id + 1, session.head, true, speed);
      else setPlaying(false);
      return;
    }
    let previous = performance.now(),
      switching = false;
    const timer = setInterval(() => {
      const now = performance.now(),
        elapsed = now - previous;
      previous = now;
      if (document.hidden || switching) return;
      replayTime.current += Math.min(elapsed, 160) * speed;
      try {
        // ponytail: cap zero-time command bursts at 100 events per frame; carry the remaining budget forward.
        let count = 0;
        while (count < 100 && replay.index < replay.total) {
          const delay = replay.nextDelayMs;
          if (delay === undefined || replayTime.current < delay) break;
          replayTime.current -= delay;
          replay.step();
          count++;
        }
        if (count) {
          setCursor(replay.index);
          publish();
        } else setFrameMs(Math.min(replayTime.current, replay.nextDelayMs ?? 0));
        if (replay.index === replay.total) {
          switching = true;
          if (session.id < session.slots.length)
            void saves.play(session.id + 1, session.head, true, speed);
          else setPlaying(false);
        }
      } catch (e) {
        setPlaying(false);
        setPlaybackFailed(true);
        setFeedback((e as Error).message);
      }
    }, 16);
    return () => clearInterval(timer);
  }, [
    watching,
    playing,
    speed,
    replay,
    session,
    controlsBlocked,
    saves.blocked,
    tasksOpen,
    goodsMode,
    paused,
    playbackFailed,
  ]);
  const currentScene = world.scene(state.sceneId)!;
  const tasks = world.taskViews();
  const currentTask = tasks.find((task) => task.completed.length < task.steps.length);
  const currentStep = currentTask?.steps.find((step) => !currentTask.completed.includes(step.id));
  const guide = taskGuidance(content.scenes, currentScene, currentStep);
  const guideVisual = guide?.entity.sprite;
  const guidePosition = guide
    ? {
        x:
          guide.entity.position[0] * 32 +
          (guideVisual?.offset?.[0] ?? 0) +
          (guideVisual?.size?.[0] ?? 32) * (0.5 - (guideVisual?.anchor?.[0] ?? 0)),
        y:
          guide.entity.position[1] * 32 +
          (guideVisual?.offset?.[1] ?? 0) -
          (guideVisual?.size?.[1] ?? 32) * (guideVisual?.anchor?.[1] ?? 0) -
          12,
      }
    : undefined;
  const map = useMemo(() => sceneMap(currentScene), [state.sceneId]);
  const shop = world.shopView(),
    items = world.inventoryView();
  const active = currentScene.entities.find((e) => e.id === state.activeEntity);
  const activeNpcId = roomNpcId(active?.sprite?.image);
  const nearby = world.nearby();
  const highlightedEntities = new Set(
    state.seated
      ? []
      : nearby
          .filter((e) => !world.seatUnavailable(e.id) && (!e.seat || !state.dialogue))
          .map((e) => e.id),
  );
  const seat = currentScene.entities.find((e) => e.id === state.seated?.entity);
  const sleep = sleepChoice ? world.sleepView(sleepChoice) : undefined;
  const visualPaused =
    idlePaused ||
    paused ||
    controlsBlocked ||
    tasksOpen ||
    !!goodsMode ||
    waitOpen ||
    consoleOpen ||
    npcPreviewOpen ||
    !!sleep ||
    saves.blocked ||
    (watching && !playing);
  const visualTime = state.time + frameMs;
  const target = state.moving?.target ?? state.player;
  const progress = state.moving
    ? Math.max(
        0,
        Math.min(
          1,
          1 - (state.moving.arrivesAt - visualTime) / (state.moving.durationMs ?? stepMs),
        ),
      )
    : 0;
  const position = {
    x: state.player.x + (target.x - state.player.x) * progress,
    y: state.player.y + (target.y - state.player.y) * progress,
  };
  return (
    <GameFrame
      backgroundColor={currentScene.map.art?.length ? 0x000000 : undefined}
      shortcuts={
        <nav className="inventory-shortcuts" aria-label="物品快捷栏">
          <button
            aria-label="背包"
            aria-keyshortcuts="1"
            title="背包 · 1"
            disabled={controlsBlocked || tasksOpen || saves.blocked}
            onClick={() => openInventory('bag')}
          >
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M17 12V8h14v4M10 15h28v27H10zM10 25h28M17 20v11M31 20v11" />
            </svg>
            <span>背包</span>
            <kbd>1</kbd>
          </button>
          <button
            aria-label="遗物收藏"
            aria-keyshortcuts="2"
            title="遗物收藏 · 2"
            disabled={controlsBlocked || tasksOpen || saves.blocked}
            onClick={() => openInventory('relics')}
          >
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M9 6h30v36H9zM24 13l4 8 8 1-6 6 1 9-7-4-7 4 1-9-6-6 8-1z" />
            </svg>
            <span>遗物</span>
            <kbd>2</kbd>
          </button>
          {content.story.clock && (
            <button
              aria-label="等待"
              aria-keyshortcuts="R"
              title="等待 · R"
              disabled={
                watching ||
                controlsBlocked ||
                tasksOpen ||
                saves.blocked ||
                !!state.moving ||
                state.dialogue ||
                state.balance <= 0
              }
              onClick={openWait}
            >
              <svg viewBox="0 0 48 48" aria-hidden="true">
                <circle cx="24" cy="24" r="18" />
                <path d="M24 12v13l9 5" />
              </svg>
              <span>等待</span>
              <kbd>R</kbd>
            </button>
          )}
        </nav>
      }
      notifications={!goodsMode ? gains.view : undefined}
      hudHidden={hudHidden}
      menuItems={
        <>
          {saves.menu}
          {import.meta.env.DEV && (
            <button
              className="px-3 py-2 text-left"
              disabled={watching || controlsBlocked || saves.blocked || capacityReached}
              onClick={openDebugConsole}
            >
              开发控制台 · ~
            </button>
          )}
          {capacityReached && (
            <p role="alert" className="px-3 py-2 text-sm">
              录制已暂停，正在等待保存。
            </p>
          )}
        </>
      }
      playback={
        watching &&
        replay &&
        session && (
          <section aria-label="事件回放">
            <div className="flex flex-wrap items-center gap-2">
              <button
                disabled={saves.loading || controlsBlocked || session.id <= 1}
                onClick={() => {
                  gains.clear();
                  void saves.play(session.id - 1, session.head, playing, speed);
                }}
              >
                ⏮ 上一档
              </button>
              <span>存档 {session.id}</span>
              <button
                disabled={saves.loading || controlsBlocked || session.id >= session.slots.length}
                onClick={() => {
                  gains.clear();
                  void saves.play(session.id + 1, session.head, playing, speed);
                }}
              >
                下一档 ⏭
              </button>
              <input
                type="range"
                className="min-w-20 flex-1 cursor-pointer accent-amber-400"
                aria-label="回放事件进度"
                aria-valuetext={`事件 ${cursor}，本档 ${cursor - replay.start} / ${replay.total - replay.start}`}
                min={replay.start}
                max={replay.total}
                step={1}
                value={cursor}
                disabled={saves.blocked || controlsBlocked || playbackFailed}
                onPointerDown={() => setPlaying(false)}
                onChange={(e) => {
                  setPlaying(false);
                  try {
                    replayTime.current = 0;
                    replay.seek(Number(e.target.value));
                    resetGains();
                    setCursor(replay.index);
                    publish();
                  } catch (error) {
                    setPlaybackFailed(true);
                    setFeedback((error as Error).message);
                  }
                }}
              />
              <span>
                {cursor - replay.start}/{replay.total - replay.start}
              </span>
              <button
                disabled={saves.blocked || controlsBlocked || playbackFailed}
                onClick={() => {
                  if (cursor >= replay.total) {
                    try {
                      replayTime.current = 0;
                      replay.seek(replay.start);
                      resetGains();
                      setCursor(replay.index);
                      publish();
                      setPlaying(true);
                    } catch (error) {
                      setPlaybackFailed(true);
                      setFeedback((error as Error).message);
                    }
                  } else setPlaying(!playing);
                }}
              >
                {cursor >= replay.total ? '重播本档' : playing ? '暂停' : '播放'}
              </button>
              {[1, 2, 4, 8].map((n) => (
                <button
                  key={n}
                  disabled={saves.loading}
                  aria-pressed={speed === n}
                  onClick={() => setSpeed(n)}
                >
                  {n}×
                </button>
              ))}
              <button
                disabled={
                  playing ||
                  saves.blocked ||
                  controlsBlocked ||
                  playbackFailed ||
                  cursor >= replay.total
                }
                onClick={stepReplay}
              >
                下一事件
              </button>
              <button
                disabled={playing || saves.blocked || controlsBlocked || playbackFailed}
                onClick={() => {
                  setPlaying(false);
                  keys.current.clear();
                  void saves.resume(session);
                }}
              >
                从此处继续游戏
              </button>
              <button
                disabled={saves.loading}
                onClick={() => {
                  setPlaying(false);
                  onExit();
                }}
              >
                退出回放
              </button>
            </div>
            <p className="text-xs">
              1×
              按记录中的模拟时长播放，播完自动接下一档。继续游戏会清除当前位置之后的记录；退出回放则返回观看前的游戏。
            </p>
          </section>
        )
      }
      overlay={
        <>
          {import.meta.env.DEV && (
            <DebugConsole
              open={consoleOpen}
              disabled={watching || controlsBlocked || saves.blocked || capacityReached}
              feedback={feedback}
              sceneId={state.sceneId}
              onClose={() => setConsoleOpen(false)}
              onCommand={(command) => {
                // TODO: 等 agentic 合入、record 方案确定后，再考虑 tp 等修改世界状态的命令。
                setFeedback(
                  command.trim().toLowerCase() === 'help'
                    ? '可用命令：\n  help'
                    : '未知命令，输入 help 查看可用命令',
                );
                return false;
              }}
            />
          )}
          {idlePaused && (
            <section
              role="status"
              className="absolute left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-brown-500 bg-brown-900 p-5 text-center"
            >
              <h2>无操作，已暂停</h2>
              <p>世界、时间结算与录制均已暂停。任意键鼠操作继续。</p>
              <button
                onClick={() => {
                  lastActivity.current = performance.now();
                  idlePauseRef.current = false;
                  setIdlePaused(false);
                }}
              >
                继续
              </button>
            </section>
          )}
          {saves.window}
          <WaitPanel
            open={waitOpen || !!sleep}
            sleeping={!!sleep}
            fixedTime={sleep?.time}
            time={state.storyTime}
            earliestTime={world.gameTime()}
            balance={state.balance}
            feedback={feedback}
            onClose={() => {
              setWaitOpen(false);
              setSleepChoice(null);
            }}
            onWait={(time, hours) =>
              send(
                sleepChoice
                  ? {
                      type: 'choose',
                      choice: sleepChoice,
                      revision: state.interactionRevision,
                      ...(sleep?.selectHours ? { hours } : {}),
                    }
                  : { type: 'waitUntil', time },
              )
            }
          />
          <div
            ref={curtain}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-50 bg-black opacity-0"
          />
          <GoodsPanel
            clues={world.clueView()}
            notifications={goodsMode ? gains.view : undefined}
            mode={goodsMode}
            shop={goodsMode === 'relics' ? null : shop}
            items={items}
            balance={state.balance}
            feedback={feedback}
            readOnly={watching || controlsBlocked || world.recordingCapacityReached()}
            onMode={setGoodsMode}
            onTrade={(type, item, quantity) =>
              send({
                type,
                target: shop?.id ?? '',
                item,
                quantity,
                revision: state.interactionRevision,
              })
            }
          />
          {npcPreviewOpen && state.dialogue && active && activeNpcId && (
            <NpcAnimationPreview
              key={active.id}
              characterId={activeNpcId}
              name={active.name}
              onClose={() => setNpcPreviewOpen(false)}
            />
          )}
        </>
      }
      hud={
        <>
          {!hudHidden && (
            <TimeHud
              quantumSeconds={state.clock ? content.story.clock?.gameSecondsPerTick : undefined}
              balance={state.balance}
              storyTime={state.storyTime}
            />
          )}
          <TaskBoard hidden={hudHidden} tasks={tasks} onOpenChange={setTasksOpen} />
        </>
      }
      sceneOverlay={(width, height) =>
        state.dialogue &&
        active && (
          <DialogueBubble
            viewportRef={viewportRef}
            position={active.position}
            width={width}
            height={height}
            name={active.name}
            text={state.npc.reply ?? ''}
            topic={state.dialogueTopic}
            disabled={
              watching ||
              controlsBlocked ||
              tasksOpen ||
              saves.blocked ||
              idlePaused ||
              capacityReached ||
              !!goodsMode ||
              waitOpen ||
              consoleOpen ||
              npcPreviewOpen ||
              !!sleep
            }
            feedback={feedback && feedback !== '操作完成' ? feedback : undefined}
          >
            {activeNpcId && !state.dialogueTopic && (
              <>
                <button disabled>闲聊（LLM 待接入）</button>
                <button
                  onClick={() => {
                    if (!flushTime()) return;
                    keys.current.clear();
                    sprint.current = false;
                    publish();
                    setNpcPreviewOpen(true);
                  }}
                >
                  NPC 动画素材预览
                </button>
              </>
            )}
            {shop && !state.dialogueTopic && (
              <button
                onClick={() => {
                  setFeedback('');
                  setGoodsMode('buy');
                }}
              >
                看看商品
              </button>
            )}
            {world.choices().map((choice) => (
              <button
                key={choice.id}
                onClick={() => {
                  if (choice.effects.some((e) => e.op === 'sleep')) {
                    if (
                      watchingRef.current ||
                      blocked.current ||
                      transitioning.current ||
                      !flushTime()
                    )
                      return;
                    keys.current.clear();
                    publish();
                    if (world.sleepView(choice.id)) {
                      setFeedback('');
                      setSleepChoice(choice.id);
                    }
                  } else
                    send({
                      type: 'choose',
                      choice: choice.id,
                      revision: state.interactionRevision,
                    });
                }}
              >
                {choice.text}
              </button>
            ))}
            {active.portal && !world.choices().length && <p>当前尚未满足通行条件。</p>}
            <button onClick={() => send({ type: 'closeDialogue' })}>
              离开 <span aria-hidden="true">· Esc</span>
            </button>
          </DialogueBubble>
        )
      }
      scene={(width, height) => (
        <TownViewport
          viewportRef={viewportRef}
          key={state.sceneId}
          map={map}
          width={width}
          height={height}
          focus={position}
          background={
            (currentScene.map.showTiles ?? !currentScene.map.art?.length) ? undefined : <></>
          }
        >
          <Container sortableChildren>
            {currentScene.map.art?.map((art, i) => (
              <AssetSprite
                key={`art-${i}`}
                visual={art}
                position={art.position}
                depth={art.depth}
              />
            ))}
            {seat?.seat ? (
              <AssetSprite
                visual={seat.seat.playerSprite}
                position={[position.x * 32, position.y * 32]}
                depth={seat.seat.depth + 1}
                onClick={() => send({ type: 'stand' })}
              />
            ) : (
              <Container
                eventMode="none"
                zIndex={position.y * 32 + 16}
                x={position.x * 32 + 16}
                y={position.y * 32 + 16}
                scale={currentScene.map.playerScale ?? 1}
              >
                {contentPackage === 'remaining-time' ? (
                  <RoomPlayer
                    orientation={state.orientation}
                    moving={!!state.moving}
                    time={visualTime}
                    sprinting={state.moving?.durationMs === stepMs / 2}
                  />
                ) : (
                  <Character
                    textureUrl={characters[0].textureUrl}
                    spritesheetData={characters[0].spritesheetData}
                    x={0}
                    y={currentScene.map.art?.length ? -16 : 0}
                    orientation={state.orientation}
                    isMoving={!!state.moving && !visualPaused}
                    speed={state.moving?.durationMs === stepMs / 2 ? 0.2 : 0.1}
                    isViewer
                    onClick={() => {}}
                  />
                )}
              </Container>
            )}
            {currentScene.entities.map((entity) => {
              if (entity.portalTiles && entity.sprite)
                return (
                  <Container key={entity.id} zIndex={1} eventMode="none">
                    {entity.portalTiles.map(([x, y]) => (
                      <AssetSprite
                        key={`${x},${y}`}
                        visual={entity.sprite!}
                        position={[x * 32, y * 32]}
                        depth={1}
                      />
                    ))}
                  </Container>
                );
              if (entity.portal && !entity.sprite)
                return (
                  <Container
                    key={entity.id}
                    x={entity.position[0] * 32}
                    y={entity.position[1] * 32}
                  >
                    <Graphics
                      draw={(g) => {
                        g.clear()
                          .beginFill(0x211d24)
                          .lineStyle(3, 0xc5a56d)
                          .drawRect(2, -12, 28, 44)
                          .endFill();
                        g.beginFill(0x6f4936)
                          .lineStyle(1, 0x241e22)
                          .drawRect(7, -7, 18, 38)
                          .endFill();
                        g.beginFill(0xf2d192).drawCircle(21, 15, 2).endFill();
                      }}
                    />
                    <Text
                      text="↓ 门"
                      x={-3}
                      y={-35}
                      style={
                        new TextStyle({
                          fontSize: 13,
                          fill: 0xffffff,
                          stroke: 0x000000,
                          strokeThickness: 3,
                        })
                      }
                    />
                  </Container>
                );
              const actor = state.entities[entity.id];
              const progress = actor.moving
                ? Math.max(0, Math.min(1, 1 - (actor.moving.arrivesAt - visualTime) / stepMs))
                : 0;
              const x =
                actor.position[0] +
                ((actor.moving?.target.x ?? actor.position[0]) - actor.position[0]) * progress;
              const y =
                actor.position[1] +
                ((actor.moving?.target.y ?? actor.position[1]) - actor.position[1]) * progress;
              const visual = entity.sprite;
              if (visual) {
                const occupiedSeat = actor.activity?.seatedOn
                  ? currentScene.entities.find((e) => e.id === actor.activity?.seatedOn)?.seat
                  : undefined;
                const SpriteComponent = roomNpcId(visual.image) ? RoomNpc : AssetSprite;
                return (
                  <SpriteComponent
                    key={entity.id}
                    time={visualTime}
                    highlighted={highlightedEntities.has(entity.id)}
                    visual={visual}
                    position={[x * 32, y * 32]}
                    depth={
                      occupiedSeat ? occupiedSeat.depth + 1 : (entity.seat?.depth ?? y * 32 + 32)
                    }
                    onClick={
                      entity.portal
                        ? undefined
                        : () =>
                            send(
                              state.seated?.entity === entity.id
                                ? { type: 'stand' }
                                : { type: 'interact', target: entity.id },
                            )
                    }
                  />
                );
              }
              if (entity.character === 'book')
                return (
                  <Container key={entity.id} x={x * 32} y={y * 32}>
                    <Graphics
                      filters={highlightedEntities.has(entity.id) ? interactionHighlight : null}
                      draw={(g) => {
                        g.clear().beginFill(0x201c27, 0.4).drawEllipse(16, 27, 15, 5).endFill();
                        g.beginFill(0x663d43)
                          .lineStyle(2, 0xd6af6c)
                          .drawRoundedRect(3, 3, 26, 24, 2)
                          .endFill();
                        g.beginFill(0xf2dfb1)
                          .lineStyle(1, 0xb99a64)
                          .drawRect(6, 5, 20, 18)
                          .endFill();
                        g.moveTo(16, 5).lineTo(16, 23);
                        g.moveTo(9, 10).lineTo(13, 10);
                        g.moveTo(19, 10).lineTo(23, 10);
                        g.moveTo(9, 15).lineTo(13, 15);
                        g.moveTo(19, 15).lineTo(23, 15);
                      }}
                    />
                    <Text
                      text={entity.name}
                      x={-8}
                      y={-20}
                      style={
                        new TextStyle({
                          fontSize: 12,
                          fill: 0xffedc4,
                          stroke: 0x211d24,
                          strokeThickness: 3,
                        })
                      }
                    />
                  </Container>
                );
              const character = characters.find((c) => c.name === entity.character)!;
              return (
                <Character
                  key={entity.id}
                  highlighted={highlightedEntities.has(entity.id)}
                  textureUrl={character.textureUrl}
                  spritesheetData={character.spritesheetData}
                  x={x * 32 + 16}
                  y={y * 32 + 16}
                  orientation={actor.orientation}
                  isMoving={!!actor.moving && !visualPaused}
                  onClick={() => send({ type: 'interact', target: entity.id })}
                />
              );
            })}
            {guide && guidePosition && (
              <Container x={guidePosition.x} y={guidePosition.y} zIndex={100000} eventMode="none">
                <Text
                  text={guide.marker}
                  anchor={[0.5, 1]}
                  style={
                    new TextStyle({
                      fontSize: 40,
                      fontWeight: 'bold',
                      fill: 0xffd45c,
                      stroke: 0x3d260b,
                      strokeThickness: 5,
                      dropShadow: true,
                      dropShadowDistance: 2,
                    })
                  }
                />
                <Text
                  text={guide.label}
                  anchor={[0.5, 0]}
                  style={
                    new TextStyle({
                      fontSize: 13,
                      fill: 0xffe8a1,
                      stroke: 0x20170d,
                      strokeThickness: 4,
                    })
                  }
                />
              </Container>
            )}
          </Container>
        </TownViewport>
      )}
      details={
        <div className="space-y-4 [&_button]:border [&_button]:border-brown-500 [&_button]:p-2">
          <h2>{currentScene.name}</h2>
          {state.seated && (
            <section aria-label="坐姿状态">
              <p>已坐在{seat?.name}</p>
              <button
                disabled={watching || controlsBlocked}
                onClick={() => send({ type: 'stand' })}
              >
                起身 · E
              </button>
            </section>
          )}
          {!state.seated && nearby.length > 0 && (
            <>
              <p>邻近：{nearby.map((e) => e.name).join('、')}</p>
              <button
                disabled={world.seatUnavailable(nearby[0]?.id ?? '')}
                onClick={() => send({ type: 'interact', target: nearby[0]?.id ?? '' })}
              >
                {nearby[0]?.seat
                  ? world.seatUnavailable(nearby[0].id)
                    ? '此桌已有客人'
                    : '坐下 · E'
                  : '交互 · E'}
              </button>
            </>
          )}
          <p role="status">{saves.error || (paused ? '后台已暂停模拟' : feedback)}</p>
        </div>
      }
    />
  );
}

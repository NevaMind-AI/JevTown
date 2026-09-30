import { useEffect, useRef } from 'react';
import { AgenticRuntime } from './agenticRuntime';
import { createAgenticWorld, worldFileOf } from './createAgenticWorld';
import type { Content } from '../../prototype/content';
import { IndexedDbOutbox, SyncClient } from './syncClient';
import { resolveWorld } from './resolveWorld';
import { serverFetch } from '../lib/identity';
import { holdLease } from '../lib/lease';

/**
 * The agentic world, attached to the tab that is already running a simulation.
 *
 * **On by default.** It was behind `VITE_AGENTIC` while the agentic world was an experiment
 * running beside the game; it is the game now. The client still drives the bill (docs/11 §4.4),
 * and the proxy's call cap is what bounds it — a flag never did, since a session that wanted
 * agents simply set it.
 *
 * `advance` is deliberately not a `useEffect` with its own interval. It takes the quantum
 * `LocalGame` has already computed, which is what keeps docs/11 §4.5 true for both worlds at
 * once: that loop consumes elapsed real time *before* deciding whether to simulate it, and caps
 * each tick at 160ms, so a laptop waking from sleep discards the gap rather than simulating hours
 * of game time — and, with agents attached, rather than firing a burst of model calls for a
 * night nobody was present for. A second interval here would quietly lose that.
 */

/**
 * How often a batch goes out.
 *
 * docs/11 §9 F2 asks for this number and for what forces an early flush. Five seconds is the
 * answer to the first: a crash costs at most that much play, and it is far longer than a batch
 * takes to write. The second half is still open — a model result and a scene change are the
 * obvious candidates — and until it is settled the interval is the only trigger, which is the
 * conservative direction because it never flushes mid-operation.
 */
const FLUSH_INTERVAL_MS = 5_000;
/** Well inside any reasonable lease expiry, and cheap: renewing is the same call as claiming. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * What the agentic world needs of the simulation it rides on.
 *
 * Two clocks, because docs/13 §3.2 keeps them separate: `time` is the engine's millisecond
 * counter, which both worlds now share as a single stamp, and `storyTime` is the fiction's, which
 * only the prompts read.
 */
export interface HostClock {
  time: number;
  storyTime: () => number;
  /**
   * The loaded content package: its scenes are the agentic world's ground and its `world` is the
   * world file (docs/13 §2). A package without one has no agents, and no runtime is started.
   */
  content: Content;
}

export function useAgenticRuntime(host: HostClock): AgenticRuntime | undefined {
  const runtime = useRef<AgenticRuntime | null | undefined>(undefined);
  if (runtime.current === undefined) {
    try {
      runtime.current = worldFileOf(host.content)
        ? createAgenticWorld({
            content: host.content,
            // One counter for both worlds (docs/13 §3.2). `MemoryWorld` starts at 0, which the
            // falsy start-of-step test in `engine/runtime.ts` used to discard; that test is now
            // `undefined`, so 0 is a legal start and no offset is needed to dodge it.
            startTime: host.time,
            storyTime: host.storyTime,
          })
        : // Not an error: a package that authors no agents is a game with no agents in it.
          null;
    } catch (error) {
      // A world file that will not load is worth reporting, and is never worth taking the game
      // down with: the scenes, the story and the player are all still there without it.
      console.error('The agentic world failed to start:', error);
      runtime.current = null;
    }
  }
  useAgenticSync(runtime.current ?? undefined);
  return runtime.current ?? undefined;
}

/**
 * One resolution per page. StrictMode runs the effect twice in development, and on a first launch
 * two resolutions would create two worlds.
 */
let resolving: ReturnType<typeof resolveWorld> | undefined;

/**
 * Ship the world to the backend, when there is one to ship it to.
 *
 * First the tab finds its world (`resolveWorld`, docs/14 §4.4). That needs the server, since a
 * hosted one chooses world ids, so nothing is shipped until it answers. With no storage behind the
 * server, or no server, the session simply stays local. Once it has a world, the tab claims the
 * writer lease, re-sends anything the last session left unacknowledged, and flushes on a timer.
 *
 * Resuming from what `resolveWorld` read back is not wired yet (docs/14 §5 step 0): the tab still
 * starts from the world file.
 */
function useAgenticSync(runtime: AgenticRuntime | undefined) {
  useEffect(() => {
    if (!runtime) return;
    const env = (import.meta as any).env ?? {};
    const baseUrl: string = env.VITE_STORAGE_URL ?? '/worlds';

    let stopped = false;
    let teardown: (() => void) | undefined;

    const open = async () => {
      resolving ??= resolveWorld({
        baseUrl,
        pinned: env.VITE_SYNC_WORLD_ID,
        fetchImpl: serverFetch,
      });
      const world = await resolving;
      if (!world) {
        holdLease(undefined);
        return;
      }
      if (stopped) return;

      const sync = new SyncClient({
        worldId: world.worldId,
        runtime,
        baseUrl,
        // One outbox per world: a batch owed to one world must never be re-sent to another.
        outbox: new IndexedDbOutbox(`remaining-time-sync:${world.worldId}`),
        fetchImpl: serverFetch,
        onReadOnly: (reason) =>
          console.warn(`This world is now read-only and will not be saved. ${reason}`),
      });

      const flush = window.setInterval(() => {
        void sync.flush().catch((error) => console.error('Batch failed:', error));
      }, FLUSH_INTERVAL_MS);
      const heartbeat = window.setInterval(() => {
        void sync.heartbeat().catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      teardown = () => {
        window.clearInterval(flush);
        window.clearInterval(heartbeat);
        // One last attempt on the way out. It may not finish, which is exactly why the outbox is
        // written before a batch is sent rather than after.
        void sync.flush().catch(() => {});
      };

      await sync.start();
      // Model calls have been waiting for this (docs/14 §3.3).
      holdLease(sync.lease);
    };
    void open().catch((error) => {
      console.error('Could not open the world:', error);
      holdLease(undefined);
    });

    return () => {
      stopped = true;
      teardown?.();
    };
  }, [runtime]);
}

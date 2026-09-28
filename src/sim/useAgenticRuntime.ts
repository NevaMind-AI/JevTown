import { useEffect, useRef } from 'react';
import { AgenticRuntime } from './agenticRuntime';
import { createAgenticWorld } from './createAgenticWorld';
import { IndexedDbOutbox, SyncClient } from './syncClient';

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
}

export function useAgenticRuntime(host?: HostClock): AgenticRuntime | undefined {
  const runtime = useRef<AgenticRuntime | null | undefined>(undefined);
  if (runtime.current === undefined) {
    try {
      runtime.current = createAgenticWorld(
        host && {
          // One counter for both worlds (docs/13 §3.2). `MemoryWorld` starts at 0, which the
          // falsy start-of-step test in `engine/runtime.ts` used to discard; that test is now
          // `undefined`, so 0 is a legal start and no offset is needed to dodge it.
          startTime: host.time,
          storyTime: host.storyTime,
        },
      );
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
 * Ship the world to the backend, when there is one to ship it to.
 *
 * Off unless `VITE_SYNC_WORLD_ID` names a world, so the default session stays entirely local and
 * needs no database. When it is on, the tab claims the writer lease, re-sends anything the last
 * session left unacknowledged, and flushes on a timer.
 */
function useAgenticSync(runtime: AgenticRuntime | undefined) {
  useEffect(() => {
    const worldId = (import.meta as any).env?.VITE_SYNC_WORLD_ID as string | undefined;
    if (!runtime || !worldId) return;

    let stopped = false;
    const sync = new SyncClient({
      worldId,
      runtime,
      outbox: new IndexedDbOutbox(),
      onReadOnly: (reason) =>
        console.warn(`This world is now read-only and will not be saved. ${reason}`),
    });

    const flush = window.setInterval(() => {
      if (!stopped) void sync.flush().catch((error) => console.error('Batch failed:', error));
    }, FLUSH_INTERVAL_MS);
    const heartbeat = window.setInterval(() => {
      if (!stopped) void sync.heartbeat().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);

    void sync.start().catch((error) => console.error('Could not claim the world:', error));

    return () => {
      stopped = true;
      window.clearInterval(flush);
      window.clearInterval(heartbeat);
      // One last attempt on the way out. It may not finish, which is exactly why the outbox is
      // written before a batch is sent rather than after.
      void sync.flush().catch(() => {});
    };
  }, [runtime]);
}

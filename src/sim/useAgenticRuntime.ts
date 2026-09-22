import { useEffect, useRef } from 'react';
import { AgenticRuntime } from './agenticRuntime';
import { createAgenticWorld } from './createAgenticWorld';
import { IndexedDbOutbox, SyncClient } from './syncClient';

/**
 * The agentic world, attached to the tab that is already running a simulation.
 *
 * **Off unless `VITE_AGENTIC=1`.** The client drives the bill now (docs/11 §4.4), so a world full
 * of deciding agents is not something an ordinary play session should start by accident. The
 * proxy's call cap is the backstop; this is the switch.
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

export function useAgenticRuntime(): AgenticRuntime | undefined {
  const runtime = useRef<AgenticRuntime | null | undefined>(undefined);
  if (runtime.current === undefined) {
    if (!(import.meta as any).env?.VITE_AGENTIC) {
      runtime.current = null;
    } else {
      try {
        runtime.current = createAgenticWorld();
      } catch (error) {
        // A world file that will not load is worth reporting, and is never worth taking the game
        // down with: the agentic world is an addition to a session that works without it.
        console.error('The agentic world failed to start:', error);
        runtime.current = null;
      }
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

import { useRef } from 'react';
import { AgenticRuntime } from './agenticRuntime';
import { createAgenticWorld } from './createAgenticWorld';

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
  return runtime.current ?? undefined;
}

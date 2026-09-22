/**
 * The few settings the agent layer reads, from wherever it happens to be running.
 *
 * These were `process.env` lookups, which was correct while every one of them ran in a Convex
 * action. The agent layer runs in a browser now, where `process` does not exist and reading it
 * throws on the first decision — so each setting is read through here instead: `import.meta.env`
 * in a bundle (Vite only exposes `VITE_`-prefixed names to the client), `process.env` in Node for
 * tests and the proxy.
 *
 * Read per call rather than captured at module load, so a test can change one.
 */

function setting(name: string): string | undefined {
  const fromBundle = ((import.meta as any).env ?? {})[`VITE_${name}`];
  if (fromBundle !== undefined) return fromBundle as string;
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

/** Skip memory entirely, for a backend with no embedding model configured. */
export function memoryDisabled(): boolean {
  return setting('DISABLE_MEMORY') === 'true';
}

/** How many memories a conversation prompt retrieves. Falls back to the engine constant. */
export function numMemoriesToSearch(fallback: number): number {
  return Number(setting('NUM_MEMORIES_TO_SEARCH')) || fallback;
}

/** The temporary probe of docs/08 §7 D7. See `agent/god.ts`. */
export function mysteryGiftEnabled(): boolean {
  return setting('GOD_MYSTERY_GIFT') === '1';
}

/**
 * A lens on work that has not come back yet.
 *
 * A run that is *stuck* produces no log line. That is the whole difficulty of reading one: the
 * console ends on whatever succeeded last, and the call that never returned says nothing at all,
 * so the symptom of the failure is an absence. Every hop between a decision and a model answer is
 * an `await` with no timeout on it -- the browser's `fetch` to the proxy, the proxy's `fetch`
 * upstream, the Postgres round trips either side of it, and the Langfuse export that
 * `Tracer.close()` waits for before the decision is allowed to re-enter the world -- and any one
 * of them hanging looks identical from the outside: agents standing still.
 *
 * So this turns the absence into a line. `watch()` prints when work starts, prints again when it
 * finishes with how long it took, and -- the part nothing else can do -- keeps printing while it
 * has not, naming what is outstanding and how many other things are outstanding with it.
 *
 * ## It only ever reports
 *
 * Nothing here aborts, retries, or times a call out. A lens that changes what it is looking at is
 * worth less than no lens, and the engine already has an answer for an operation that never
 * reports back: `Agent.tick` times it out after `ACTION_TIMEOUT` and decides again. The question
 * this file answers is *which* hop ate the call, which is exactly what that recovery hides.
 *
 * ## Both runtimes
 *
 * The chain crosses a process boundary in the middle, so the same helper is used on both sides of
 * it: the tab imports it as `./watchdog`, the proxy as `../../agent/model/watchdog.ts`. It takes
 * no imports of its own so that stays true, and reads its switch from `import.meta.env` and
 * `process.env` the way `agent/config.ts` does, for the same reason.
 *
 * Off with `VITE_LOG_WAITS=0` in the tab or `LOG_WAITS=0` in the proxy. Stalls are still reported
 * when it is off: a stall is never noise.
 */

/** How long work may run before it is worth mentioning, and how often to mention it after that. */
const STALL_MS = 8_000;
/** The sweep is coarse on purpose: it is a heartbeat for a hang, not a profiler. */
const SWEEP_MS = 2_000;

interface Entry {
  scope: string;
  label: string;
  id: number;
  started: number;
  /** When this entry was last reported stalled, so each report covers a fresh interval. */
  reported: number;
}

let nextId = 1;
const live = new Map<number, Entry>();
let sweeper: ReturnType<typeof setInterval> | undefined;

function setting(name: string): string | undefined {
  const fromBundle = ((import.meta as any).env ?? {})[`VITE_${name}`];
  if (fromBundle !== undefined) return fromBundle as string;
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

/** Read per call rather than captured, so a test or a live edit can turn it off. */
function chatty(): boolean {
  return setting('LOG_WAITS') !== '0';
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function sweep() {
  const now = Date.now();
  for (const entry of live.values()) {
    if (now - entry.started < STALL_MS || now - entry.reported < STALL_MS) continue;
    entry.reported = now;
    console.warn(
      `[${entry.scope}] … #${entry.id} ${entry.label} — no answer after ` +
        `${seconds(now - entry.started)} · ${live.size} in flight`,
    );
  }
  if (live.size === 0 && sweeper !== undefined) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

/**
 * Register work that is starting, and get back the function that says it finished.
 *
 * The returned function is idempotent, so a `finally` that runs after an explicit call on the
 * success path is harmless -- which is what lets a call site report its own outcome (`200`,
 * `HTTP 429`, `failed: …`) without having to prove that every branch reports exactly once.
 *
 * `#n` is the only way to pair a start with its finish once more than one thing is in flight, and
 * with twenty agents deciding at once there always is.
 */
export function watch(scope: string, label: string): (outcome?: string) => void {
  const started = Date.now();
  const entry: Entry = { scope, label, id: nextId++, started, reported: started };
  live.set(entry.id, entry);
  if (sweeper === undefined) {
    sweeper = setInterval(sweep, SWEEP_MS);
    // The proxy must not be held open by its own instrumentation. `unref` is Node-only; in the
    // tab there is nothing to exit and the property is simply absent.
    (sweeper as { unref?: () => void }).unref?.();
  }
  if (chatty()) {
    console.log(`[${scope}] → #${entry.id} ${label} · ${live.size} in flight`);
  }
  return (outcome?: string) => {
    if (!live.delete(entry.id)) return;
    const ms = Date.now() - started;
    // A slow call is reported even when the switch is off, because it is the thing being hunted:
    // by the time it finishes it has already been reported stalled, and a start with no finish
    // reads as still-hanging.
    if (!chatty() && ms < STALL_MS) return;
    console.log(
      `[${scope}] ← #${entry.id} ${label} · ${seconds(ms)}${outcome ? ` · ${outcome}` : ''} · ` +
        `${live.size} in flight`,
    );
  };
}

/** What is outstanding right now, oldest first. For a caller that wants to print a summary. */
export function outstanding(): { scope: string; label: string; waitingMs: number }[] {
  const now = Date.now();
  return [...live.values()]
    .sort((a, b) => a.started - b.started)
    .map((entry) => ({ scope: entry.scope, label: entry.label, waitingMs: now - entry.started }));
}

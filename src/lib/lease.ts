import type { ModelCallLease } from '../../server/protocol';
import { serverFetch } from './identity';

/**
 * The lease this tab's model calls carry (docs/14 §3.3).
 *
 * A hosted server serves a model call only for a tab that holds its world's writer lease. So the
 * model client waits until sync has settled which world this tab writes, then sends the lease as
 * headers on every call. A tab that has lost the lease to a newer one keeps sending its old one,
 * and the server refuses it: an older tab stops spending as well as saving.
 *
 * The agent layer never sees any of this. It goes through `setModelProxyFetch`, as the token does.
 */

let current: ModelCallLease | undefined;
let settle: () => void = () => {};
const settled = new Promise<void>((resolve) => {
  settle = resolve;
});

/**
 * Nothing may wait forever on a sync that never reports. After this, calls go without a lease: a
 * local server never asks for one, and a hosted one refuses them, which is the truth.
 */
const WAIT_MS = 15_000;

/** Called once sync knows: with the lease it took, or `undefined` when there is none. */
export function holdLease(lease: ModelCallLease | undefined) {
  current = lease;
  settle();
}

export const modelFetch: typeof fetch = async (input, init) => {
  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
  if (!current) return await serverFetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('X-World-Id', current.worldId);
  headers.set('X-Session-Id', current.sessionId);
  headers.set('X-Generation', String(current.generation));
  return await serverFetch(input, { ...init, headers });
};

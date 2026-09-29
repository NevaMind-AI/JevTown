import type { IdentityResponse } from '../../server/protocol';
import { WORLD_KEY_PREFIX } from '../sim/resolveWorld';

/**
 * Who this browser is to the backend (docs/14 §1).
 *
 * No accounts. On first use the server mints a token, this browser keeps it, and every request to
 * the model proxy and to storage carries it. A local server mints tokens too and never checks
 * them, so nothing here asks which kind of server it is talking to (docs/14 §4.2).
 *
 * Clearing site data or switching browser loses the token, and with it the worlds it owns: the
 * "occasional loss" the design accepts. Storage is per origin, so `localhost:5173` and
 * `127.0.0.1:5173` are two players (§1.3). The recovery code is the token itself, for a player to
 * carry to another browser.
 */

const TOKEN_KEY = 'remaining-time:identity';
const IDENTITY_URL: string = (import.meta as any).env?.VITE_IDENTITY_URL ?? '/identity';

let minting: Promise<string | undefined> | undefined;

function storedToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeToken(token: string | undefined) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Blocked storage: the token lives for this page only, which is still better than none.
  }
}

async function mint(): Promise<string | undefined> {
  try {
    const response = await fetch(IDENTITY_URL, { method: 'POST' });
    if (!response.ok) return undefined;
    const { token } = (await response.json()) as IdentityResponse;
    storeToken(token);
    return token;
  } catch {
    // No server is a normal state for a session that never syncs. The next request tries again.
    return undefined;
  }
}

/**
 * This browser's token, minted on first use.
 *
 * `undefined` when no server would mint one. Concurrent callers share one mint, and a failed
 * mint is not remembered, so the next request tries again.
 */
export async function identity(): Promise<string | undefined> {
  const token = storedToken();
  if (token) return token;
  minting ??= mint().finally(() => {
    minting = undefined;
  });
  return await minting;
}

function withToken(init: RequestInit | undefined, token: string | undefined): RequestInit {
  if (!token) return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * `fetch`, with this browser's token attached (docs/14 §4.2).
 *
 * The one wrapper both the model client and storage go through. A 401 means the server no longer
 * accepts the token — its signing key changed, or a pasted recovery code was wrong — so the token
 * is worthless either way: mint a new one and try once more.
 */
export const serverFetch: typeof fetch = async (input, init) => {
  const token = await identity();
  const response = await fetch(input, withToken(init, token));
  if (response.status !== 401) return response;
  if (token) storeToken(undefined);
  const fresh = await identity();
  if (!fresh || fresh === token) return response;
  return await fetch(input, withToken(init, fresh));
};

/** The recovery code of docs/14 §1.3: the token, for a player to copy. */
export function recoveryCode(): string | undefined {
  return storedToken();
}

/**
 * Become the player a code copied from another browser names.
 *
 * The worlds this browser remembers belong to the old token, so they are forgotten too; the next
 * start finds the new owner's newest world instead (see `resolveWorld`).
 */
export function adoptRecoveryCode(code: string) {
  storeToken(code.trim());
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(WORLD_KEY_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Nothing remembered, nothing to forget.
  }
}

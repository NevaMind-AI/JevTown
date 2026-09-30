import type { IncomingMessage } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Who a request comes from, without accounts (docs/14 §1).
 *
 * The server mints a token of 128 random bits and signs it, so a forged token is refused without a
 * database read. The browser keeps the token and sends it as a bearer on every request. The server
 * never stores the token itself: the owner id is a hash of it, so a leaked database does not leak
 * the secrets that would let someone become a player.
 *
 * This is not login. A player who clears site data gets a new token and loses the old worlds,
 * which is the "occasional loss" the design accepts (§1.3).
 */

/** The owner of everything on a server that does not check tokens (docs/14 §4.4). */
export const LOCAL_OWNER = 'local';

let secret: Buffer = randomBytes(32);

/**
 * Set the signing key.
 *
 * Without one, each process signs with a random key, so its tokens stop verifying when it
 * restarts. That is harmless on a local server, which never checks them, and fatal on a hosted
 * one, which is why `server/index.ts` refuses to start hosted without `IDENTITY_SECRET`.
 */
export function configureIdentity(configured: string | undefined) {
  if (configured) secret = Buffer.from(configured, 'utf8');
}

function sign(id: string): string {
  // 128 bits of the MAC is as much as the id it protects.
  return createHmac('sha256', secret).update(id).digest('base64url').slice(0, 22);
}

export function mintToken(): string {
  const id = randomBytes(16).toString('base64url');
  return `${id}.${sign(id)}`;
}

/** The owner a token names, or `undefined` for a token this server did not mint. */
export function verifyToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  const [id, signature] = parts;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  // The hash of the random half, not of the whole token: the owner stays the same if the
  // signature format ever changes.
  return createHash('sha256').update(id).digest('hex');
}

export function bearerToken(request: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
  return match?.[1];
}

/**
 * The address a request came from.
 *
 * Behind a load balancer the socket is the balancer, so `TRUST_PROXY` reads `X-Forwarded-For`
 * instead. The last entry is the one our own proxy appended; anything to its left came from the
 * client and can be forged.
 */
export function clientAddress(request: IncomingMessage): string {
  if (process.env.TRUST_PROXY) {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/**
 * A fixed-window meter per key, in memory.
 *
 * Deliberately crude. It forgets on restart and is not shared between instances, which is enough
 * for what it guards: minting identities by address (§1.4), counted in hits, and model spend by
 * address as a backstop behind the per-owner budget (§2.4, §3.6), counted in dollars.
 */
export class WindowCounter {
  private windows = new Map<string, { start: number; used: number }>();
  // Plain fields: the server runs with type stripping only, which has no parameter properties.
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private window(key: string) {
    const now = Date.now();
    if (this.windows.size > 10_000) this.sweep(now);
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      window = { start: now, used: 0 };
      this.windows.set(key, window);
    }
    return window;
  }

  /** Whether `key` is at its limit for this window. */
  over(key: string): boolean {
    return this.window(key).used >= this.limit;
  }

  /** Count `amount` against `key`, for a cost known only after the fact. */
  add(key: string, amount: number) {
    this.window(key).used += amount;
  }

  /** Count one hit for `key`. `false` when the key is already at its limit, and nothing is counted. */
  take(key: string): boolean {
    if (this.over(key)) return false;
    this.add(key, 1);
    return true;
  }

  private sweep(now: number) {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

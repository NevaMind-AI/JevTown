import type {
  BootstrapResponse,
  CreateWorldResponse,
  WorldListResponse,
} from '../../server/protocol';

/**
 * Which world this tab opens (docs/14 §2.3, §4.4).
 *
 * Who the player is and which world they open stay separate: the token answers the first, this
 * the second. Both modes take the same path, and the server decides what an id means.
 *
 *   1. The world this browser last opened, for this build's pin.
 *   2. The pin, `VITE_SYNC_WORLD_ID`, when there is one.
 *   3. With no pin, the newest world this player owns — which is how a recovery code, or a
 *      browser that lost its memory of the last world, finds its way back.
 *   4. A new world. A local server keeps the pinned id; a hosted one makes its own.
 *
 * The browser's memory is kept per pin because a hosted server never grants a pinned id: without
 * it, a build with a pin would miss the pin and create a new world on every launch. Locally the
 * remembered world always is the pin, so pointing the pin at a new id still resets.
 */

export const WORLD_KEY_PREFIX = 'remaining-time:world:';

export interface ResolvedWorld {
  worldId: string;
  /** `null` for a world created just now. */
  bootstrap: BootstrapResponse | null;
}

function remembered(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(key: string, worldId: string) {
  try {
    localStorage.setItem(key, worldId);
  } catch {
    // Blocked storage: this tab still syncs, and the next one finds the world through step 3.
  }
}

/**
 * Resolve, creating a world if none is found.
 *
 * `undefined` when there is no storage to sync to — no database behind the server, or no server
 * at all — which is a normal state for a session that plays entirely in the tab.
 */
export async function resolveWorld(options: {
  baseUrl: string;
  pinned?: string;
  fetchImpl: typeof fetch;
}): Promise<ResolvedWorld | undefined> {
  const { baseUrl, pinned, fetchImpl: http } = options;
  const key = `${WORLD_KEY_PREFIX}${pinned ?? ''}`;

  /** The world, `null` when this player has no such world, `undefined` when storage is off. */
  const open = async (worldId: string): Promise<BootstrapResponse | null | undefined> => {
    const response = await http(`${baseUrl}/${encodeURIComponent(worldId)}/bootstrap`);
    if (response.status === 404) return null;
    if (!response.ok) return undefined;
    return (await response.json()) as BootstrapResponse;
  };

  /** The first of `ids` this player has, `null` for none, `undefined` when storage is off. */
  const first = async (ids: (string | undefined)[]) => {
    for (const worldId of new Set(ids.filter((id): id is string => Boolean(id)))) {
      const bootstrap = await open(worldId);
      if (bootstrap === undefined) return undefined;
      if (bootstrap) {
        remember(key, worldId);
        return { worldId, bootstrap };
      }
    }
    return null;
  };

  try {
    let found = await first([remembered(key), pinned]);
    if (found === null && !pinned) {
      const listing = await http(baseUrl);
      if (!listing.ok) return undefined;
      const { worlds } = (await listing.json()) as WorldListResponse;
      found = await first([worlds[0]?.id]);
    }
    if (found !== null) return found;

    const created = await http(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pinned }),
    });
    if (!created.ok) return undefined;
    // The server's id, not the pin: a hosted server does not grant client-chosen ids. The first
    // batch must wait for this answer, since it is addressed to the id in it.
    const { id } = (await created.json()) as CreateWorldResponse;
    remember(key, id);
    return { worldId: id, bootstrap: null };
  } catch {
    // Unreachable server: the same as no storage.
    return undefined;
  }
}

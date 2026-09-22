import { Rng } from '../../../engine/util/rng';
import { WorldFile, WorldFileEntity } from '../../../engine/aiTown/worldFile';

/**
 * Resizing the demo's cast, for pressure rather than for fiction.
 *
 * The solarium world file authors five agents and that is the number the check was written
 * around. This module exists for the other question the demo cannot answer at five: **what
 * happens to the loop when the room is nearly empty, or when it is crowded?** One agent has
 * nobody to invite and has to keep deciding anyway; forty agents contend for tiles, for the
 * decision interval, and for the proxy's call cap all at once. Neither is a story worth watching.
 * Both are worth running.
 *
 * So the scaling is deliberately crude, and the crudeness is the point:
 *
 *   - **Below the authored five**, a subset is sampled and the rest are dropped. Nobody is
 *     rewritten to cover for the missing -- Ovid may be gone and his secret with him, and the
 *     world is simply poorer.
 *   - **Above it**, agents are duplicated. A copy carries its source's description verbatim, so
 *     two agents can hold the same beliefs, want the same thing, and meet each other. That is a
 *     situation the prompt layer has never been shown and exactly the sort of thing a pressure
 *     test should put in front of it.
 *
 * The draw is seeded, so `VITE_DEMO_AGENTS=3` picks the same three every reload and a run that
 * misbehaves can be looked at twice. Changing the world file's `meta.seed` redeals it.
 */

/** A world with nobody in it is not a smaller world, it is a broken one. */
export const MIN_AGENTS = 1;
/**
 * Forty-five copies is already past anything the demo is for. The ceiling is here because every
 * agent is a standing model call: fifty of them will hit the proxy's `MODEL_PROXY_CALL_CAP`
 * within a couple of minutes, and a number above that would only spend faster.
 */
export const MAX_AGENTS = 50;

/**
 * `VITE_DEMO_AGENTS`, read.
 *
 * `undefined` means the flag was not set and the world file's own cast stands, which is what
 * keeps the default demo the demo. Anything unparseable is a typo in a shell command, and a typo
 * should not silently change the size of the world -- it warns and falls back.
 */
export function requestedAgentCount(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isInteger(parsed)) {
    console.warn(
      `VITE_DEMO_AGENTS is "${text}", which is not a whole number — using the world file's cast.`,
    );
    return undefined;
  }
  const clamped = Math.min(MAX_AGENTS, Math.max(MIN_AGENTS, parsed));
  if (clamped !== parsed) {
    console.warn(
      `VITE_DEMO_AGENTS is ${parsed}, outside [${MIN_AGENTS}, ${MAX_AGENTS}] — using ${clamped}.`,
    );
  }
  return clamped;
}

export interface ScaleOptions {
  /**
   * Where a copy spawns. The authored spawn anchors are single tiles, and a tile holds one
   * player: a second Ren at `central-hall` would find nowhere free and `Player.join` would throw
   * his `createEntity` input away (`engine/runtime.ts` fails one input, not the world), leaving a
   * pressure test quietly short of the agents it asked for. So copies are sent somewhere with
   * room -- a rect anchor wide enough for the whole ceiling.
   */
  spawnAnchor: string;
  /** Seeded, so a given size deals the same cast every time. */
  rng: Rng;
}

const isMobileActor = (entity: WorldFileEntity) => entity.kind === 'actor' && !!entity.mobile;

/** A Fisher-Yates shuffle off the seeded PRNG, returning a copy. */
function shuffled<T>(values: readonly T[], rng: Rng): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * The same world file with `count` mobile actors in it.
 *
 * Fixed entities are untouched, for `createWorldPlan`'s reason: a world missing its props is not
 * a smaller world either. Ordering is preserved for the survivors and copies are appended, so
 * the entity inputs -- and therefore the ids the engine allocates -- stay stable as the count
 * grows.
 */
export function scaleCast(file: WorldFile, count: number, options: ScaleOptions): WorldFile {
  const cast = (file.entities ?? []).filter(isMobileActor);
  if (cast.length === 0) {
    throw new Error('The world file has no mobile actors to scale');
  }
  const size = Math.min(MAX_AGENTS, Math.max(MIN_AGENTS, Math.trunc(count)));

  // Which of the authored five survive. A shuffle taken once and then re-sorted into file order,
  // rather than `size` draws: it cannot pick the same actor twice and it cannot loop.
  const keptIds = new Set(
    shuffled(cast, options.rng)
      .slice(0, Math.min(size, cast.length))
      .map((a) => a.id),
  );
  const entities = (file.entities ?? []).filter((e) => !isMobileActor(e) || keptIds.has(e.id));

  // Copies, one at a time, each a fresh draw from the surviving cast. Repetition is allowed and
  // expected: three Miras appraising each other is a legitimate thing to make the prompt layer
  // survive.
  const survivors = entities.filter(isMobileActor);
  const copiesOf = new Map<string, number>();
  for (let i = survivors.length; i < size; i++) {
    const source = options.rng.pick(survivors);
    const nth = (copiesOf.get(source.id) ?? 1) + 1;
    copiesOf.set(source.id, nth);
    entities.push({
      ...source,
      // Ids must be unique or validation rejects the file; they are otherwise invisible, since
      // `createEntityArgs` never passes one to the engine.
      id: `${source.id}-${nth}`,
      // The name is not invisible -- it is how the manifest offers this agent to everyone else,
      // and how the transcript labels a line. Two identical names would make both unreadable,
      // so the copy is numbered. Everything the model *thinks with* is left alone.
      name: source.name ? `${source.name} ${nth}` : undefined,
      spawn: { anchor: options.spawnAnchor },
    });
  }

  return { ...file, entities };
}

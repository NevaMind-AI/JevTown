import type { Content } from './content.js';
import { EntityState, initialEntities, scriptedEntities } from './entities.js';
import type { State } from './world.js';

type V3Actor = Omit<EntityState, 'activity'> & { seatedOn?: string };
export type V3State = Omit<State, 'entities'> & { entities: Record<string, V3Actor> };
type LegacyActor = Omit<V3Actor, 'name' | 'appearance'>;
export type LegacyState = Omit<State, 'entities'> & { entities: Record<string, LegacyActor> };

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every((key) => Object.hasOwn(b, key) && equal((a as any)[key], (b as any)[key]))
  );
}

function actorData(a: V3Actor): LegacyActor {
  return {
    ...(a.seatedOn ? { seatedOn: a.seatedOn } : {}),
    sceneId: a.sceneId,
    position: a.position,
    path: a.path,
    transit: a.transit,
    moving: a.moving,
    orientation: a.orientation,
  };
}
// Only the recording boundary uses old layouts. Simulation and inspect() use one canonical state.
export function encodeState(
  content: Content,
  current: State,
  rules: string,
): State | V3State | LegacyState {
  if (rules === 'memory-world-4') return structuredClone(current);
  const state: V3State = {
    ...current,
    entities: Object.fromEntries(
      Object.entries(current.entities).map(([id, actor]) => {
        const { activity, ...base } = actor;
        return [id, { ...base, ...(activity ? { seatedOn: activity.seatedOn } : {}) }];
      }),
    ),
  };
  if (rules === 'memory-world-3') return structuredClone(state);
  const result: LegacyState = {
    ...state,
    entities: Object.fromEntries(scriptedEntities(state).map(([id, a]) => [id, actorData(a)])),
  };
  return structuredClone(result);
}

function hasFields(value: unknown, keys: string[]) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function restoreActivities(input: V3State): State {
  const state = structuredClone(input);
  for (const actor of Object.values(state.entities)) {
    if (Object.hasOwn(actor, 'activity')) throw new Error('Unexpected legacy activity');
    const { seatedOn, ...base } = actor;
    Object.assign(actor, base, seatedOn === undefined ? {} : { activity: { seatedOn } });
    delete actor.seatedOn;
  }
  return state as State;
}

export function decodeState(
  content: Content,
  input: State | V3State | LegacyState,
  rules: string,
): State {
  if (rules === 'memory-world-4') return structuredClone(input) as State;
  if (rules === 'memory-world-3') return restoreActivities(input as V3State);
  const old = structuredClone(input) as LegacyState;
  const result = { ...old, entities: initialEntities(content) } as State;
  for (const actor of Object.values(result.entities)) delete actor.activity;
  if (!old.entities || typeof old.entities !== 'object') throw new Error('Invalid legacy entities');
  for (const [id, actor] of Object.entries(old.entities)) {
    if (!Object.hasOwn(result.entities, id)) throw new Error('Unknown legacy entity');
    if (!hasFields(actor, ['sceneId', 'position', 'path', 'moving', 'transit', 'orientation']))
      throw new Error('Invalid legacy actor');
    Object.assign(result.entities[id], actor);
  }
  for (const scene of content.scenes)
    for (const e of scene.entities)
      if (!Object.hasOwn(old.entities, e.id)) throw new Error('Missing legacy entity');
  return restoreActivities(result);
}

export function validateEntities(content: Content, state: State) {
  const fail = () => {
    throw new Error('Invalid entity snapshot');
  };
  const dictionary = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  const xy = (v: unknown): v is number[] =>
    Array.isArray(v) && v.length === 2 && v.every(Number.isSafeInteger);
  if (!dictionary(state?.entities)) fail();
  const initial = initialEntities(content);
  for (const id of Object.keys(initial)) if (!Object.hasOwn(state.entities, id)) fail();
  for (const [id, a] of Object.entries(state.entities)) {
    if (
      !dictionary(a) ||
      typeof a.name !== 'string' ||
      !dictionary(a.appearance) ||
      typeof a.appearance.character !== 'string' ||
      !xy(a.position) ||
      !Array.isArray(a.path) ||
      !a.path.every(xy) ||
      ![0, 90, 180, 270].includes(a.orientation) ||
      typeof a.sceneId !== 'string' ||
      (a.sceneId !== '' && !content.scenes.some((s) => s.id === a.sceneId))
    )
      fail();
    if (
      a.moving !== null &&
      (!dictionary(a.moving) ||
        !xy([a.moving?.target?.x, a.moving?.target?.y]) ||
        !Number.isSafeInteger(a.moving.arrivesAt) ||
        a.moving.arrivesAt < 0 ||
        !a.path.length ||
        a.path[0][0] !== a.moving.target.x ||
        a.path[0][1] !== a.moving.target.y ||
        (a.moving.durationMs !== undefined &&
          (!Number.isSafeInteger(a.moving.durationMs) || a.moving.durationMs <= 0)))
    )
      fail();
    if (
      a.transit !== null &&
      (!dictionary(a.transit) ||
        typeof a.transit.via !== 'string' ||
        typeof a.transit.arrival !== 'string')
    )
      fail();
    const scene = content.scenes.find((s) => s.id === a.sceneId);
    if (
      scene &&
      [a.position, ...a.path].some(
        ([x, y]) => x < 0 || y < 0 || x >= scene.map.width || y >= scene.map.height,
      )
    )
      fail();
    if (Object.hasOwn(a, 'seatedOn')) fail();
    if (a.activity !== undefined) {
      const chair = scene?.entities.find((e) => e.id === a.activity?.seatedOn && e.seat);
      if (
        !dictionary(a.activity) ||
        Object.keys(a.activity).length !== 1 ||
        typeof a.activity.seatedOn !== 'string' ||
        !chair ||
        !equal(a.position, chair.position)
      )
        fail();
    }
    if (a.transit) {
      const door = content.scenes.flatMap((s) => s.entities).find((e) => e.id === a.transit!.via);
      if (
        !door?.portal ||
        !Object.hasOwn(
          content.scenes.find((s) => s.id === door.portal!.scene)!.anchors,
          a.transit.arrival,
        )
      )
        fail();
    }
    if (Object.hasOwn(initial, id)) {
      if (a.name !== initial[id].name || !equal(a.appearance, initial[id].appearance)) fail();
    } else fail();
  }
}

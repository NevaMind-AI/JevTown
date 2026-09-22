import type { Content, Entity } from './content.js';
import type { State } from './world.js';

export type Appearance = {
  character: string;
  image?: string;
  sprite?: Entity['sprite'];
};
export type EntityState = {
  name: string;
  appearance: Appearance;
  // An empty scene means offstage; position is then only the last simulation coordinate.
  sceneId: string;
  position: number[];
  orientation: number;
  path: number[][];
  moving: null | { target: { x: number; y: number }; arrivesAt: number; durationMs?: number };
  transit: null | { via: string; arrival: string };
  activity?: { seatedOn: string };
};

export function createEntity(
  name: string,
  appearance: Appearance,
  sceneId: string,
  position: number[],
): EntityState {
  return {
    name,
    appearance: structuredClone(appearance),
    sceneId,
    position: [...position],
    orientation: 90,
    path: [],
    moving: null,
    transit: null,
  };
}

export function initialEntities(content: Content): Record<string, EntityState> {
  const entries = content.scenes.flatMap((scene) =>
    scene.entities.map((e): [string, EntityState] => {
      const actor = createEntity(
        e.name,
        {
          character: e.character,
          ...(content.npcs?.[e.id]?.image ? { image: content.npcs[e.id].image } : {}),
          ...(e.sprite ? { sprite: e.sprite } : {}),
        },
        scene.id,
        e.position,
      );
      if (e.seatedOn) {
        actor.activity = { seatedOn: e.seatedOn };
        actor.orientation = scene.entities.find(
          (chair) => chair.id === e.seatedOn,
        )!.seat!.orientation;
      }
      return [e.id, actor];
    }),
  );
  return Object.fromEntries(entries);
}

export function scriptedEntities(state: State) {
  return Object.entries(state.entities);
}

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

/** Named prop art from the content package: sprite name -> the image to draw. */
export type SpriteArt = Record<string, NonNullable<Entity['sprite']>>;

/**
 * How a world-file entity is drawn once it is placed on the map (docs/13 §2).
 *
 * The two sides name appearance differently. A scene entity carries a `character` from a small
 * closed vocabulary — `f1`–`f8`, or `sprite` meaning "draw the attached art". A world file
 * carries either a `character` (mobile actors) or a `sprite` **name** (props and fixed actors),
 * and the name is an id into the content's `story.sprites`, never a path.
 *
 * `undefined` for anything that cannot be drawn: an unknown character, a sprite name the content
 * has no art for, or neither. That is an authoring error and the caller reports it — inventing a
 * placeholder would put a book on the map where a well was meant to be, and nothing downstream
 * would ever say so.
 */
export function placedAppearance(
  source: { character?: string; sprite?: string },
  art: SpriteArt = {},
): Appearance | undefined {
  if (source.character !== undefined)
    return /^f[1-8]$/.test(source.character) ? { character: source.character } : undefined;
  if (source.sprite === undefined) return undefined;
  const visual = art[source.sprite];
  return visual ? { character: 'sprite', sprite: structuredClone(visual) } : undefined;
}

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

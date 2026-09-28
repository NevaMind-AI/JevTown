import room from '../../content/scenes/room.json';
import corridor from '../../content/scenes/corridor.json';
import story from '../../content/story.json';
import worldFile from '../../data/world.json';
import { loadContent, type Content, type WorldEntities } from '../../prototype/content';

/**
 * A content package with agents in it, for tests (docs/13 §2).
 *
 * `data/world.json`'s cast — five walkers, a voice in a well, a mill door, a notice board —
 * placed on the fixture `room` scene instead of the `data/gentle` map it was written for. Each of
 * its anchor names is authored here as a room anchor, and every entity names `room` as its scene,
 * which is what a world file standing on real scenes looks like.
 *
 * The room is 12x10 with a solid border: interior (1, 1)-(10, 8). n07 stands at (5, 5), the exit
 * door at (10, 5), and `start` (3, 5) and `from_corridor` (9, 5) are arrival anchors, so nothing
 * here is placed on them.
 */
export const FIXTURE_ANCHORS: Record<string, number[]> = {
  north_field: [2, 2],
  west_orchard: [2, 7],
  crossroads: [6, 3],
  east_ridge: [8, 2],
  south_commons: [7, 7],
  old_well: [4, 8],
  mill_yard: [9, 8],
  east_shore: [10, 2],
};

/** One image for every prop: the fixture needs something drawable, not something pretty. */
const ART = { image: 'assets/low-deck/door-tag-317.png' };

export function fixtureContent(): Content {
  const scenes = [structuredClone(room), structuredClone(corridor)];
  (scenes[0] as { anchors: Record<string, number[]> }).anchors = {
    ...scenes[0].anchors,
    ...FIXTURE_ANCHORS,
  };
  const world = structuredClone(worldFile) as typeof worldFile & WorldEntities;
  for (const entity of world.entities) (entity as { scene?: string }).scene = 'room';
  return loadContent(
    scenes,
    { ...structuredClone(story), sprites: { well: ART, door_closed: ART, board: ART } },
    undefined,
    world,
  );
}

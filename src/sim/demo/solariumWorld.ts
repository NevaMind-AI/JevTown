import { Scene } from '../../../prototype/content';
import { Rng } from '../../../engine/util/rng';
import { WorldFile } from '../../../engine/aiTown/worldFile';
import { characters } from '../../../data/characters';
import { WorldSource } from '../createAgenticWorld';
import { PlaceSpec, sceneAnchors, sceneWorldMap } from '../sceneWorldMap';
import { scaleCast } from './scaleCast';
import worldFileJson from './solarium.world.json';

/**
 * Five agents on `dev`'s 高层天井, as a check that the flow runs.
 *
 * The question this answers is narrow and worth stating: **does the upstream agent loop still
 * work end to end when the ground under it is a `dev` scene rather than `data/gentle.js`?** Walk,
 * decide, invite, accept, converse, remember. Nothing here is a step toward docs/11 §9 F1 --
 * the two world models are still two -- and nothing here is content. The prose is written to be
 * plausible enough that a model has something to say, and no further.
 *
 * ## The places
 *
 * `solarium.json` already carries eight anchors, but all eight are arrival points: where the
 * player lands when they come through a particular door. They are bare `[x, y]` pairs with no
 * description, and a place with no description is one no agent can choose (`sceneWorldMap.ts`
 * explains why). So most of what follows is positions picked off the collision grid -- every one
 * verified walkable, and the whole map is a single connected component, so any agent can reach
 * any place from any spawn.
 *
 * Two of them, `the-long-bench` and `the-notice-board`, are where the world file's props live.
 * They are places *and* targets: an agent can wander to the bench or approach it, which is the
 * point of having them.
 *
 * One of them, `the-lift-queue`, is a nine-by-nine rect rather than a tile, because it is also
 * where `scaleCast` puts a crowd. See the note on it below.
 */
const PLACES: Record<string, PlaceSpec> = {
  // Inherited from the scene -- position comes from `solarium.json`, prose from here.
  'from-enter-gallery': {
    description: 'The gallery door, where the valuation desk is visible through the glass.',
  },
  'from-bridge-tower': {
    description: 'The mouth of the bridge across to the roof garden, shut since the storm.',
  },
  'from-service-lift': {
    description: 'The service lift, the only way up to the garden while the bridge is shut.',
  },

  // Authored: free tiles chosen across the floor so there is somewhere to go in every direction.
  'skylight-shaft': {
    x: 28,
    y: 6,
    description: 'A narrow well of glass directly under the skylight, painfully bright at midday.',
  },
  'west-alcove': {
    x: 6,
    y: 10,
    description: 'A shallow alcove off the west wall, out of sight of most of the floor.',
  },
  'central-hall': {
    x: 24,
    y: 13,
    description: 'The open middle of the atrium, which everyone crossing the level walks through.',
  },
  'east-terrace': {
    x: 33,
    y: 15,
    description: 'A raised terrace on the east side, looking down over the atrium floor.',
  },
  'west-corridor': {
    x: 8,
    y: 19,
    description: 'A long corridor along the west wall, running down toward the archive door.',
  },
  'south-west-room': {
    x: 17,
    y: 23,
    description: 'A quiet side room in the south-west corner, well off the through traffic.',
  },
  'south-east-room': {
    x: 33,
    y: 23,
    description: 'A south-east side room, with the service passage running behind its wall.',
  },
  'south-stair': {
    x: 25,
    y: 28,
    description: 'The head of the south stair, down to the private lift lobby.',
  },
  'service-passage': {
    x: 41,
    y: 17,
    description: 'A cramped service passage on the east side, smelling of machine oil.',
  },

  // The one place that is a rect rather than a point, and the only one that is here for a
  // mechanical reason as well as a fictional one. It is where `scaleCast` spawns copies: the
  // other thirteen places are single tiles, a tile holds one player, and a crowded run needs
  // somewhere that can take forty-five arrivals at once. Eighty-one free tiles, all of them
  // reachable, and a description that the world's own common knowledge already implies.
  'the-lift-queue': {
    x: 11,
    y: 12,
    w: 9,
    h: 9,
    description:
      'The open west end of the floor, where the queue for the service lift backs up and people stand about waiting for it.',
  },

  // The props' anchors. A prop is fixed *at* a place, so its anchor is one.
  'the-long-bench': {
    x: 22,
    y: 20,
    description: 'The long bench against the atrium rail, facing the middle of the floor.',
  },
  'the-notice-board': {
    x: 30,
    y: 12,
    description: 'The notice board by the gallery door, where announcements go up.',
  },
};

export const SOLARIUM_SCENE_ID = 'solarium';

/** Where a duplicated agent arrives. See the note on the place itself. */
export const SOLARIUM_CROWD_ANCHOR = 'the-lift-queue';

export interface SolariumOptions {
  /**
   * How many mobile agents to build, clamped to [1, 50]. Omitted -- the default, and what an
   * unset `VITE_DEMO_AGENTS` gives -- means the five the world file authors, untouched.
   */
  agents?: number;
  /** Seeds the cast draw. Defaults to the world file's own seed, so a run repeats. */
  seed?: number;
}

/** The demo world, over whichever scene the caller loaded. Throws if it is not the solarium. */
export function solariumWorldSource(scene: Scene, options: SolariumOptions = {}): WorldSource {
  if (scene.id !== SOLARIUM_SCENE_ID) {
    throw new Error(`Expected scene "${SOLARIUM_SCENE_ID}", got "${scene.id}"`);
  }
  const authored = worldFileJson as WorldFile;
  return {
    worldFile:
      options.agents === undefined
        ? authored
        : scaleCast(authored, options.agents, {
            spawnAnchor: SOLARIUM_CROWD_ANCHOR,
            rng: Rng.fromSeed(options.seed ?? authored.meta?.seed ?? 0),
          }),
    map: sceneWorldMap(scene, sceneAnchors(scene, PLACES)),
    // The same eight sheets the agentic world has always drawn from. `dev`'s own room sprites are
    // a different rig entirely (`RoomPlayer`, a 40x48 workwear sheet) and the world file's
    // `character` field is validated against this set, so the demo casts from f1-f8.
    characters: new Set(characters.map((c) => c.name)),
  };
}

export { PLACES as SOLARIUM_PLACES };

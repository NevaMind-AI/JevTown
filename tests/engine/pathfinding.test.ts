import type { Scene } from '../../prototype/content';
import {
  anchorApproachTiles,
  approachTiles,
  nearestFreeTile,
  npcPath,
} from '../../prototype/pathfinding';

/**
 * Two rooms, one wall between them:
 *
 * ```
 *   #######
 *   #..#..#
 *   #..#c.#
 *   #..#..#
 *   #######
 * ```
 *
 * `c` is a fixed crate at (5, 2). Nothing connects the rooms, which is what makes the partial
 * path and the reachable-versus-straight-line distinction observable.
 */
const scene = {
  id: 'two-rooms',
  name: 'Two rooms',
  map: {
    width: 7,
    height: 5,
    collision: ['#######', '#..#..#', '#..#..#', '#..#..#', '#######'],
  },
  anchors: {},
  entities: [{ id: 'crate', name: 'Crate', position: [5, 2], character: 'prop' }],
} as unknown as Scene;

describe('npcPath', () => {
  test('routes within a room', () => {
    expect(npcPath(scene, [1, 1], [[1, 3]])).toEqual([
      [1, 2],
      [1, 3],
    ]);
  });

  test('an unreachable goal is still null by default', () => {
    expect(npcPath(scene, [1, 1], [[5, 1]])).toBeNull();
  });

  test('with partial, it walks as far toward the goal as it can reach', () => {
    expect(npcPath(scene, [1, 1], [[5, 1]], [], { partial: true })).toEqual([[2, 1]]);
  });

  test('partial returns null rather than a zero-step path when it cannot improve', () => {
    expect(npcPath(scene, [2, 1], [[4, 1]], [], { partial: true })).toBeNull();
  });

  test('a reserved tile is routed around, not through', () => {
    expect(npcPath(scene, [1, 1], [[1, 3]], [[1, 2]])).toEqual([
      [2, 1],
      [2, 2],
      [2, 3],
      [1, 3],
    ]);
  });

  test('a goal that is itself blocked yields nothing', () => {
    expect(npcPath(scene, [1, 1], [[3, 1]])).toBeNull();
  });
});

describe('approachTiles', () => {
  test('the free neighbours of a one-tile entity, nearest first then by tile', () => {
    expect(approachTiles(scene, 'crate')).toEqual([
      [4, 2],
      [5, 1],
      [5, 3],
    ]);
  });

  test('a reserved neighbour drops out', () => {
    expect(approachTiles(scene, 'crate', [[5, 1]])).toEqual([
      [4, 2],
      [5, 3],
    ]);
  });

  test('interactionOffsets are admitted alongside the neighbours, as nearby() reads them', () => {
    const withOffsets = {
      ...scene,
      entities: [{ ...scene.entities[0], interactionOffsets: [[-1, -1]] }],
    } as unknown as Scene;
    expect(approachTiles(withOffsets, 'crate')).toEqual([
      [4, 2],
      [5, 1],
      [5, 3],
      [4, 1],
    ]);
  });

  test('an offset onto a wall is not a place to stand', () => {
    const withOffsets = {
      ...scene,
      entities: [{ ...scene.entities[0], interactionOffsets: [[1, 0]] }],
    } as unknown as Scene;
    expect(approachTiles(withOffsets, 'crate')).not.toContainEqual([6, 2]);
  });

  test('an unknown target has nowhere to stand', () => {
    expect(approachTiles(scene, 'no-such-entity')).toEqual([]);
  });

  test('a rect anchor is approached from its perimeter', () => {
    expect(anchorApproachTiles(scene, [1, 1, 2, 2])).toEqual([
      [1, 3],
      [2, 3],
    ]);
  });
});

describe('nearestFreeTile', () => {
  test('the anchor tile itself, when nothing is standing on it', () => {
    expect(nearestFreeTile(scene, [1, 1])).toEqual([1, 1]);
  });

  test('the nearest tile by walking, when it is occupied', () => {
    expect(nearestFreeTile(scene, [1, 1], [[1, 1]])).toEqual([2, 1]);
  });

  test('it spreads outward in walking order', () => {
    const occupied = [
      [1, 1],
      [2, 1],
      [1, 2],
    ];
    expect(nearestFreeTile(scene, [1, 1], occupied)).toEqual([2, 2]);
  });

  test('nearest means reachable: a full room yields nothing, wall or no wall', () => {
    // Every tile of the left room is taken. (4, 1) is two tiles away in a straight line and
    // free, and it is not an answer, because no walk reaches it.
    const occupied = [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
      [1, 3],
      [2, 3],
    ];
    expect(nearestFreeTile(scene, [2, 1], occupied)).toBeNull();
  });
});

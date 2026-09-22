import { jest } from '@jest/globals';
import { Rng } from '../../../engine/util/rng';
import { WorldFile } from '../../../engine/aiTown/worldFile';
import { MAX_AGENTS, MIN_AGENTS, requestedAgentCount, scaleCast } from './scaleCast';
import worldFileJson from './solarium.world.json';

/**
 * The cast resizer, without a world around it.
 *
 * What matters here is what the *world file* comes out looking like, because everything
 * downstream -- validation, spawning, the manifest -- reads only that. `solariumDemo.test.ts`
 * covers the other half: that a file shaped this way actually builds.
 */

const authored = worldFileJson as WorldFile;
const options = () => ({ spawnAnchor: 'the-lift-queue', rng: Rng.fromSeed(7) });
const mobile = (file: WorldFile) => file.entities.filter((e) => e.kind === 'actor' && e.mobile);
const fixed = (file: WorldFile) => file.entities.filter((e) => !(e.kind === 'actor' && e.mobile));

describe('requestedAgentCount', () => {
  test('an unset or empty flag leaves the world file alone', () => {
    expect(requestedAgentCount(undefined)).toBeUndefined();
    expect(requestedAgentCount('')).toBeUndefined();
    expect(requestedAgentCount('  ')).toBeUndefined();
  });

  test('a number is taken, and clamped to the range', () => {
    expect(requestedAgentCount('1')).toBe(1);
    expect(requestedAgentCount(' 12 ')).toBe(12);
    expect(requestedAgentCount('50')).toBe(50);
    expect(requestedAgentCount('0')).toBe(MIN_AGENTS);
    expect(requestedAgentCount('-4')).toBe(MIN_AGENTS);
    expect(requestedAgentCount('500')).toBe(MAX_AGENTS);
  });

  test('a typo falls back rather than silently resizing the world', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(requestedAgentCount('five')).toBeUndefined();
    expect(requestedAgentCount('2.5')).toBeUndefined();
    jest.restoreAllMocks();
  });
});

describe('scaleCast', () => {
  test('asking for what the file already has changes nothing', () => {
    const scaled = scaleCast(authored, mobile(authored).length, options());
    expect(scaled.entities).toEqual(authored.entities);
  });

  test('a smaller cast drops agents and keeps every prop', () => {
    for (const size of [1, 2, 3, 4]) {
      const scaled = scaleCast(authored, size, options());
      expect(mobile(scaled)).toHaveLength(size);
      expect(fixed(scaled)).toEqual(fixed(authored));
      // Survivors are authored agents, untouched, and still in file order.
      const names = mobile(scaled).map((a) => a.name);
      expect(
        mobile(authored)
          .map((a) => a.name)
          .filter((n) => names.includes(n)),
      ).toEqual(names);
    }
  });

  test('a bigger cast duplicates, keeping the authored five at their own spawns', () => {
    const scaled = scaleCast(authored, 20, options());
    expect(mobile(scaled)).toHaveLength(20);
    expect(mobile(scaled).slice(0, 5)).toEqual(mobile(authored));
    for (const copy of mobile(scaled).slice(5)) {
      expect(copy.spawn).toEqual({ anchor: 'the-lift-queue' });
      const source = mobile(authored).find((a) => copy.id.startsWith(`${a.id}-`))!;
      // The whole point of a copy: the prompt is identical, so two agents can hold the same
      // beliefs and meet each other.
      expect(copy.description).toBe(source.description);
      expect(copy.character).toBe(source.character);
      expect(copy.name).toMatch(new RegExp(`^${source.name} \\d+$`));
    }
  });

  test('ids and names stay unique however large the crowd', () => {
    const scaled = scaleCast(authored, MAX_AGENTS, options());
    expect(mobile(scaled)).toHaveLength(MAX_AGENTS);
    expect(new Set(scaled.entities.map((e) => e.id)).size).toBe(scaled.entities.length);
    const names = mobile(scaled).map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('the count is clamped here too, so a caller cannot get round the ceiling', () => {
    expect(mobile(scaleCast(authored, 0, options()))).toHaveLength(MIN_AGENTS);
    expect(mobile(scaleCast(authored, 1000, options()))).toHaveLength(MAX_AGENTS);
  });

  test('the same seed deals the same cast, and a different one deals another', () => {
    const cast = (seed: number) =>
      mobile(
        scaleCast(authored, 3, { spawnAnchor: 'the-lift-queue', rng: Rng.fromSeed(seed) }),
      ).map((a) => a.id);
    expect(cast(7)).toEqual(cast(7));
    // Not a guarantee of the algorithm, but true of these seeds: the draw is actually seeded.
    expect(new Set([...cast(7), ...cast(11), ...cast(29)]).size).toBeGreaterThan(3);
  });
});

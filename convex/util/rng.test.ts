import { Rng, SerializedRng } from './rng';

describe('Rng', () => {
  test('the same seed produces the same stream', () => {
    const a = Rng.fromSeed(12345);
    const b = Rng.fromSeed(12345);
    const first = Array.from({ length: 100 }, () => a.random());
    const second = Array.from({ length: 100 }, () => b.random());

    expect(first).toEqual(second);
  });

  test('different seeds produce different streams', () => {
    const a = Rng.fromSeed(1);
    const b = Rng.fromSeed(2);

    expect(a.random()).not.toBe(b.random());
  });

  test('a round trip through serialization resumes the same stream', () => {
    const original = Rng.fromSeed(99);
    for (let i = 0; i < 17; i++) {
      original.random();
    }
    // This is the property replay depends on: the state survives the world document.
    const resumed = new Rng(JSON.parse(JSON.stringify(original.serialize())) as SerializedRng);
    const expected = Array.from({ length: 50 }, () => original.random());
    const actual = Array.from({ length: 50 }, () => resumed.random());

    expect(actual).toEqual(expected);
  });

  test('random stays in [0, 1)', () => {
    const rng = Rng.fromSeed(7);
    for (let i = 0; i < 10000; i++) {
      const value = rng.random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test('int stays in range and covers it', () => {
    const rng = Rng.fromSeed(3);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const value = rng.int(5);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
      seen.add(value);
    }

    expect(seen.size).toBe(5);
  });

  test('the stream is not obviously biased', () => {
    const rng = Rng.fromSeed(2024);
    const buckets = new Array(10).fill(0);
    const draws = 100000;
    for (let i = 0; i < draws; i++) {
      buckets[rng.int(10)] += 1;
    }
    for (const count of buckets) {
      // Each bucket should hold ~10%; anything outside 9-11% is a broken generator, not noise.
      expect(count).toBeGreaterThan(draws * 0.09);
      expect(count).toBeLessThan(draws * 0.11);
    }
  });

  test('pick is uniform over the array and rejects empty ones', () => {
    const rng = Rng.fromSeed(11);
    const values = ['a', 'b', 'c', 'd'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(rng.pick(values));
    }

    expect(seen).toEqual(new Set(values));
    expect(() => rng.pick([])).toThrow();
  });

  test('uuid is v4-shaped, unique, and replayable', () => {
    const rng = Rng.fromSeed(42);
    const uuids = Array.from({ length: 1000 }, () => rng.uuid());
    for (const uuid of uuids) {
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }

    expect(new Set(uuids).size).toBe(uuids.length);
    expect(Rng.fromSeed(42).uuid()).toBe(uuids[0]);
  });
});

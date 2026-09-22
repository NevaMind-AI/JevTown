import { ObjectType, v } from 'convex/values';

/**
 * A seeded PRNG whose state lives in the world document.
 *
 * The engine's `tick()` runs inside a Convex *action* (`abstractGame.runStep`), so `Math.random()`
 * there is genuinely unseeded — Convex only makes it deterministic inside queries and mutations,
 * and only across retries of one execution, never across runs. Every draw the simulation makes
 * therefore has to come from here instead, or a replay of the same input log diverges.
 * See docs/05-agentic-world-format.md §10 and docs/08 §3 (A0).
 *
 * Algorithm is sfc32, seeded through splitmix32. Chosen because its whole state is four uint32s,
 * which survive a round trip through Convex's float64 numbers exactly.
 */
export const serializedRng = {
  a: v.number(),
  b: v.number(),
  c: v.number(),
  d: v.number(),
};
export type SerializedRng = ObjectType<typeof serializedRng>;

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(state: SerializedRng) {
    this.a = state.a >>> 0;
    this.b = state.b >>> 0;
    this.c = state.c >>> 0;
    this.d = state.d >>> 0;
  }

  static fromSeed(seed: number): Rng {
    let s = seed >>> 0;
    const splitmix32 = () => {
      s = (s + 0x9e3779b9) | 0;
      let t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      return (t ^ (t >>> 15)) >>> 0;
    };
    const rng = new Rng({ a: splitmix32(), b: splitmix32(), c: splitmix32(), d: 1 });
    // Discard the first outputs so nearby seeds don't produce correlated streams.
    for (let i = 0; i < 12; i++) {
      rng.next();
    }
    return rng;
  }

  /** The next raw uint32. */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** A float in [0, 1), the drop-in for `Math.random()`. */
  random(): number {
    return this.next() / 4294967296;
  }

  /** An integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    return Math.floor(this.random() * maxExclusive);
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new Error(`Can't pick from an empty array`);
    }
    return values[this.int(values.length)];
  }

  /**
   * A v4-shaped UUID drawn from this stream, replacing `crypto.randomUUID()`. It is not
   * cryptographically random and must not be used where that matters — its only job is to be a
   * unique, replayable identity for a message.
   */
  uuid(): string {
    const bytes = new Uint8Array(16);
    for (let word = 0; word < 4; word++) {
      const value = this.next();
      bytes[word * 4] = (value >>> 24) & 0xff;
      bytes[word * 4 + 1] = (value >>> 16) & 0xff;
      bytes[word * 4 + 2] = (value >>> 8) & 0xff;
      bytes[word * 4 + 3] = value & 0xff;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
  }

  serialize(): SerializedRng {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }
}

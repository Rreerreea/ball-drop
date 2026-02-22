/**
 * Mulberry32 — fast 32-bit seeded PRNG.
 * Returns a function that produces floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a random seed. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

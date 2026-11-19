// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · rng — deterministic, seeded randomness for every simulation
// in the lab. Same seed ⇒ same paths ⇒ same charts, so a mental model a user
// stares at is reproducible and citable ("run 42 of the gamma-scalper").
//
//   • mulberry32 — small, fast, well-behaved 32-bit PRNG (deterministic across
//     platforms, unlike Math.random)
//   • gaussian   — Box–Muller transform over a mulberry32 stream
//   • pick/repeat helpers used by the market-machinery toys
// ─────────────────────────────────────────────────────────────────────────────

/** Mulberry32 — deterministic 32-bit PRNG, period 2³². */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard-normal sampler built on a uniform stream. */
export function gaussianStream(uniform: () => number): () => number {
  let spare: number | null = null;
  return function () {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = uniform();
    let v = uniform();
    // avoid log(0)
    if (u < 1e-12) u = 1e-12;
    if (v < 1e-12) v = 1e-12;
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * v;
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

/** Convenience: seeded standard-normal sampler. */
export function seededNormals(seed: number): () => number {
  return gaussianStream(mulberry32(seed));
}

/** Deterministic pick from a finite set. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

/** Deterministic Poisson-ish arrival count for a step (λ small). */
export function poissonSmall(rng: () => number, lambda: number): number {
  let n = 0;
  let acc = rng();
  const target = Math.exp(-lambda);
  while (acc > target && n < 50) {
    n++;
    acc *= rng();
  }
  return n;
}

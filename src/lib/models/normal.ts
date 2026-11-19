// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · normal — Φ, φ and Φ⁻¹, one high-accuracy implementation
// shared by every model in the lab. Φ via the Abramowitz–Stegun 7.1.26 erf
// expansion (|err| < 7.5e-8 — agrees with textbook tables to 5 decimals);
// Φ⁻¹ seeded by the A&S 26.2.23 rational approximation (|err| < 4.5e-4) then
// polished by Halley's method to ~1e-12 — used to solve delta-quoted strikes
// (K of a 25Δ option: d1 = Φ⁻¹(0.25)).
// ─────────────────────────────────────────────────────────────────────────────

/** φ(x) — standard normal density. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** erf(x), Abramowitz–Stegun 7.1.26 (|err| < 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  // t·(a1 + t·(a2 + t·(a3 + t·(a4 + t·a5)))) — degree 5
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Φ(x) — standard normal CDF. */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Φ⁻¹(p) — A&S 26.2.23 seed + Halley polish. */
export function normInv(p: number): number {
  if (!(p > 0)) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // symmetric seed from the upper half
  const pu = p > 0.5 ? p : 1 - p;
  const t = Math.sqrt(-2 * Math.log(1 - pu));
  let x =
    t -
    (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  if (p < 0.5) x = -x;

  // Halley refinement (cubic convergence, ~2 steps to machine precision)
  for (let i = 0; i < 3; i++) {
    const e = normCdf(x) - p;
    const f = normPdf(x);
    if (!(f > 0)) break;
    const u = (x * e) / f;
    x -= (e / f) * (1 + u / 2) / (1 + u);
  }
  return x;
}

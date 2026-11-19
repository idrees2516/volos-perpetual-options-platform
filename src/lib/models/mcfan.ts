// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · mcfan — the MIXED-PROCESS Monte Carlo engine.
//
// One seeded simulator where every process family we model can be COMBINED:
//   drift   (the forecast layer's drift),
//   GARCH   (vol clustering from the fit),
//   Heston  (stochastic variance, correlated),
//   Merton  (Poisson gap jumps with fat tails),
//   OU      (mean-reversion pull on the log level).
// The output is the per-step quantile fan of S_t — the distribution the
// decision hub cross-checks the conformal fan against — plus any path
// payoff the caller wants (strategy legs, barriers, liquidations).
//
// Variance-leg priority when several are supplied: Heston > GARCH > baseVol.
// Antithetic pairs share pre-drawn step normals (price AND variance noise
// jointly negated — correlation-preserving); jump counts/sizes are drawn
// per-path independently.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32 } from './rng';
import type { GarchFit } from './timeseries';
import type { MertonParams } from './stochastic';

export interface MixedProcessSpec {
  /**
   * Annualized drift of the LOG price — the TOTAL expected log-return per
   * year INCLUDING the average jump contribution (the jump leg's mean is
   * subtracted from the smooth drift so the total matches).
   */
  drift: number;
  /**
   * Bars per year — the unit bridge for the GARCH leg (whose ω/α/β are
   * per-BAR quantities) into this annualized simulator. Default 35_040 (15m).
   */
  barsPerYear?: number;
  /** base annualized vol (used when no GARCH/Heston leg given) */
  baseVol?: number;
  /** discrete GARCH vol-clustering leg (overrides baseVol per step) */
  garch?: { omega: number; alpha: number; beta: number; seedVar?: number };
  /** Heston stochastic-variance leg (overrides GARCH/baseVol per step) */
  heston?: { v0: number; kappa: number; theta: number; xi: number; rho: number };
  /** Merton jump leg */
  merton?: MertonParams;
  /** OU pull on the log level toward theta (kappa per year) */
  ou?: { kappa: number; theta: number };
}

export interface FanStep {
  i: number;
  q05: number;
  q25: number;
  q50: number;
  q75: number;
  q95: number;
  mean: number;
  sd: number;
}

export interface MixedFanResult {
  steps: FanStep[];
  terminal: { mean: number; sd: number; q05: number; q95: number; pUp: number };
  nPaths: number;
  /** P(path touches level before the horizon) */
  probTouch: (level: number) => number;
  samplePaths: number[][];
}

/**
 * Simulate one mixed-process path from PRE-DRAWN step normals (antithetic
 * negation happens at the caller). Heston variance uses full-truncation
 * Euler; the GARCH recursion consumes the step's standardized shock after
 * the increment is applied (no look-ahead); Merton jumps are Poisson-counted
 * (Knuth multiplication method) with normal sizes from a per-path stream; OU
 * pulls the log toward theta.
 */
function simulatePath(
  stepNormals: Float64Array,
  jumpRng: () => number,
  jumpUniform: () => number,
  S0: number,
  steps: number,
  dtYears: number,
  spec: MixedProcessSpec,
): Float64Array {
  const path = new Float64Array(steps + 1);
  path[0] = S0;
  let x = Math.log(S0);
  let vHeston = spec.heston?.v0 ?? 0;
  const g = spec.garch;
  let vGarch = g
    ? (g.seedVar ?? g.omega / Math.max(1e-9, 1 - g.alpha - g.beta))
    : 0;
  for (let s = 1; s <= steps; s++) {
    const eps = stepNormals[(s - 1) * 2] ?? 0;
    const z2 = stepNormals[(s - 1) * 2 + 1] ?? 0;
    // per-step variance (annualized): Heston > GARCH > baseVol
    let v: number;
    let vBar = 0; // per-BAR variance, kept for the GARCH recursion
    if (spec.heston) {
      const h = spec.heston;
      const vPos = Math.max(0, vHeston);
      // correlated variance noise: w2 = ρ·w1 + √(1−ρ²)·z2 (w1 = eps)
      const w2 = eps * h.rho + Math.sqrt(Math.max(0, 1 - h.rho * h.rho)) * z2;
      vHeston = Math.max(
        0,
        vHeston + h.kappa * (h.theta - vPos) * dtYears + h.xi * Math.sqrt(vPos * dtYears) * w2,
      );
      v = vPos;
    } else if (g) {
      // the GARCH recursion is per-BAR: annualize for this annual-dt simulator
      vBar = Math.max(1e-12, vGarch);
      v = vBar * (spec.barsPerYear ?? 35_040);
    } else {
      const bv = spec.baseVol ?? 0.5;
      v = bv * bv;
    }
    // smooth-drift: total log drift minus the jumps' average contribution
    const jumpMeanPerStep = spec.merton && spec.merton.lambda > 0 ? spec.merton.lambda * dtYears * spec.merton.muJ : 0;
    const smoothDrift = spec.drift - jumpMeanPerStep / Math.max(1e-12, dtYears);
    let dx = smoothDrift * dtYears + Math.sqrt(v * dtYears) * eps;
    if (spec.ou && spec.ou.kappa > 0) {
      dx -= Math.min(0.5, spec.ou.kappa * dtYears) * (x - spec.ou.theta);
    }
    // Merton jumps within the step (Poisson count, normal sizes)
    if (spec.merton && spec.merton.lambda > 0 && spec.merton.sigmaJ > 0) {
      const lamDt = spec.merton.lambda * dtYears;
      // Knuth: multiply uniforms until the product drops below e^{−λΔt}
      const L = Math.exp(-lamDt);
      let prod = jumpUniform();
      let count = 0;
      while (prod > L && count < 60) {
        count++;
        prod *= jumpUniform();
      }
      for (let j = 0; j < count; j++) dx += spec.merton.muJ + spec.merton.sigmaJ * jumpRng();
    }
    // GARCH recursion on the step's realized shock (after the increment) —
    // per-BAR units: r² = ε²·σ̄²_bar
    if (g && !spec.heston) {
      vGarch = g.omega + g.alpha * (eps * eps) * vBar + g.beta * vGarch;
      if (!Number.isFinite(vGarch) || vGarch <= 0) vGarch = g.omega / Math.max(1e-9, 1 - g.alpha - g.beta);
    }
    x += dx;
    path[s] = Math.exp(x);
  }
  return path;
}

const qOf = (arr: Float64Array, p: number): number => {
  const sorted = Array.from(arr).sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
};

/**
 * The mixed fan: nPaths seeded paths through the COMBINED process, per-step
 * quantiles [5, 25, 50, 75, 95], terminal stats, and a P(touch level) helper
 * for liquidation-style questions.
 */
export function mixedModelFan(
  seed: number,
  nPaths: number,
  S0: number,
  steps: number,
  dtYears: number,
  spec: MixedProcessSpec,
): MixedFanResult {
  const baseRng = mulberry32(seed >>> 0);
  const perStep: Float64Array[] = Array.from({ length: steps + 1 }, () => new Float64Array(nPaths));
  const samplePaths: number[][] = [];
  // pre-draw the pair's step normals (eps + z2 per step)
  const normals = new Float64Array(steps * 2);
  const half = Math.floor(nPaths / 2);
  let p = 0;
  for (let i = 0; i < half; i++) {
    for (let j = 0; j < normals.length; j++) normals[j] = boxMuller(baseRng);
    const negNormals = new Float64Array(normals.length);
    for (let j = 0; j < normals.length; j++) negNormals[j] = -normals[j];
    const uA = mulberry32((seed + i * 131) >>> 0);
    const uB = mulberry32((seed + i * 131 + 7) >>> 0);
    const jA = gaussianFrom(mulberry32((seed + i * 7919) >>> 0));
    const jB = gaussianFrom(mulberry32((seed + i * 7919 + 13) >>> 0));
    const a = simulatePath(normals, jA, uA, S0, steps, dtYears, spec);
    const b = simulatePath(negNormals, jB, uB, S0, steps, dtYears, spec);
    for (let s = 0; s <= steps; s++) {
      perStep[s][p] = a[s];
      perStep[s][p + 1] = b[s];
    }
    if (samplePaths.length < 3) samplePaths.push([...a]);
    p += 2;
  }
  while (p < nPaths) {
    for (let j = 0; j < normals.length; j++) normals[j] = boxMuller(baseRng);
    const u = mulberry32((seed + p * 131) >>> 0);
    const jr = gaussianFrom(mulberry32((seed + p * 7919) >>> 0));
    const a = simulatePath(normals, jr, u, S0, steps, dtYears, spec);
    for (let s = 0; s <= steps; s++) perStep[s][p] = a[s];
    if (samplePaths.length < 3) samplePaths.push([...a]);
    p++;
  }
  const stepsOut: FanStep[] = [];
  for (let s = 1; s <= steps; s++) {
    const col = perStep[s];
    let mean = 0;
    let m2 = 0;
    for (const v of col) {
      mean += v;
      m2 += v * v;
    }
    mean /= col.length;
    m2 = Math.sqrt(Math.max(0, m2 / col.length - mean * mean));
    stepsOut.push({
      i: s,
      q05: qOf(col, 0.05),
      q25: qOf(col, 0.25),
      q50: qOf(col, 0.5),
      q75: qOf(col, 0.75),
      q95: qOf(col, 0.95),
      mean,
      sd: m2,
    });
  }
  const term = perStep[steps];
  let pUp = 0;
  for (const v of term) if (v > S0) pUp++;
  const last = stepsOut[stepsOut.length - 1];
  return {
    steps: stepsOut,
    terminal: {
      mean: last?.mean ?? S0,
      sd: last?.sd ?? 0,
      q05: qOf(term, 0.05),
      q95: qOf(term, 0.95),
      pUp: pUp / Math.max(1, term.length),
    },
    nPaths,
    probTouch: (level: number): number => {
      let hits = 0;
      for (let pi = 0; pi < nPaths; pi++) {
        let hit = false;
        for (let s = 1; s <= steps && !hit; s++) {
          const v = perStep[s][pi];
          if (level < S0 ? v <= level : v >= level) hit = true;
        }
        if (hit) hits++;
      }
      return hits / nPaths;
    },
    samplePaths,
  };
}

/** One standard normal from a uniform rng (Box–Muller cosine branch). */
export function boxMuller(u: () => number): number {
  const u1 = Math.max(1e-9, u());
  const u2 = u();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Standard-normal stream from any uniform rng (Box–Muller with cache). */
export function gaussianFrom(uniform: () => number): () => number {
  let cached: number | null = null;
  return (): number => {
    if (cached !== null) {
      const v = cached;
      cached = null;
      return v;
    }
    const u1 = Math.max(1e-9, uniform());
    const u2 = uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    cached = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
}

/**
 * Price any path payoff under the mixed process at the RISK-NEUTRAL drift —
 * the exotics/structures engines' mixed-model upgrade path. Antithetic
 * pairs, stderr like the rest of the MC barrel.
 */
export function mcMixedPayoff(
  payoff: (path: Float64Array) => number,
  S0: number,
  steps: number,
  dtYears: number,
  spec: MixedProcessSpec,
  nPaths: number,
  seed: number,
  r: number,
  q: number,
): { price: number; stderr: number; nPaths: number } {
  // risk-neutral log drift: (r−q) − ½·var̄ − λ·m keeps E[S_T] ≈ S e^{(r−q)T}
  const varEst = spec.heston
    ? spec.heston.theta
    : spec.garch
      ? (spec.garch.omega / Math.max(1e-9, 1 - spec.garch.alpha - spec.garch.beta))
      : (spec.baseVol ?? 0.5) ** 2;
  const merton = spec.merton;
  const m = merton && merton.lambda > 0 ? Math.exp(merton.muJ + (merton.sigmaJ * merton.sigmaJ) / 2) - 1 : 0;
  const rnSpec: MixedProcessSpec = { ...spec, drift: r - q - 0.5 * varEst - (merton ? merton.lambda * m : 0) };
  const disc = Math.exp(-r * steps * dtYears);
  const baseRng = mulberry32((seed ^ 0x5eed) >>> 0);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  const normals = new Float64Array(steps * 2);
  const half = Math.floor(nPaths / 2);
  for (let i = 0; i < half; i++) {
    for (let j = 0; j < normals.length; j++) normals[j] = boxMuller(baseRng);
    const negNormals = new Float64Array(normals.length);
    for (let j = 0; j < normals.length; j++) negNormals[j] = -normals[j];
    const uA = mulberry32((seed + i * 131) >>> 0);
    const uB = mulberry32((seed + i * 131 + 7) >>> 0);
    const jA = gaussianFrom(mulberry32((seed + i * 7919) >>> 0));
    const jB = gaussianFrom(mulberry32((seed + i * 7919 + 13) >>> 0));
    for (const [nm, ju, jr] of [
      [normals, uA, jA],
      [negNormals, uB, jB],
    ] as const) {
      const path = simulatePath(nm, jr, ju, S0, steps, dtYears, rnSpec);
      const v = disc * payoff(path);
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  while (n < nPaths) {
    for (let j = 0; j < normals.length; j++) normals[j] = boxMuller(baseRng);
    const u = mulberry32((seed + n * 131) >>> 0);
    const jr = gaussianFrom(mulberry32((seed + n * 7919) >>> 0));
    const path = simulatePath(normals, jr, u, S0, steps, dtYears, rnSpec);
    const v = disc * payoff(path);
    sum += v;
    sumSq += v * v;
    n++;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { price: mean, stderr: Math.sqrt(variance / n), nPaths: n };
}

/**
 * Assemble a mixed spec from fitted artifacts — the deep-integration
 * constructor used by the decision hub and the forecast cross-check:
 * GARCH(1,1) vol clustering + Merton jumps from the calibrated tails + an OU
 * pull when the reversion is statistically real + a Heston leg when the
 * residuals' vol-of-vol dominates the clustering signal.
 */
export function mixedSpecFromFits(opts: {
  drift: number;
  garch: GarchFit | null;
  lastReturn: number;
  merton: MertonParams | null;
  ou: { kappaPerBar: number; theta: number; strength: number } | null;
  barsPerYear: number;
  volOfVol?: number | null;
}): MixedProcessSpec {
  const spec: MixedProcessSpec = { drift: opts.drift, barsPerYear: opts.barsPerYear };
  if (opts.garch) {
    // seed the GARCH leg with the h=1 forecast
    let v = opts.garch.omega + opts.garch.alpha * opts.lastReturn ** 2 + opts.garch.beta * opts.garch.currentVar;
    if (!Number.isFinite(v) || v <= 0) v = opts.garch.longRunVar;
    spec.garch = {
      omega: opts.garch.omega,
      alpha: opts.garch.alpha,
      beta: opts.garch.beta,
      seedVar: v,
    };
  } else {
    spec.baseVol = 0.6;
  }
  if (opts.merton && opts.merton.lambda > 0 && opts.merton.sigmaJ > 0) {
    spec.merton = {
      lambda: opts.merton.lambda,
      muJ: opts.merton.muJ,
      sigmaJ: opts.merton.sigmaJ,
    };
  }
  if (opts.ou && opts.ou.kappaPerBar > 0 && opts.ou.strength > 20) {
    // κ_year = κ_bar·barsPerYear gives the same per-step pull; cap it sane
    spec.ou = {
      kappa: Math.min(500, opts.ou.kappaPerBar * opts.barsPerYear),
      theta: opts.ou.theta,
    };
  }
  if (opts.volOfVol && opts.volOfVol > 0.2 && opts.garch) {
    // stochastic-vol regime: swap the GARCH leg for a Heston leg calibrated
    // from the fit (κ from persistence, θ from long-run, ξ from vol-of-vol)
    const persistence = opts.garch.persistence;
    const kappa = Math.max(0.5, -Math.log(Math.max(1e-9, persistence)) * (24 * 365));
    const theta = opts.garch.longRunVar;
    const xi = Math.min(2.5, Math.max(0.2, Math.sqrt(theta) * opts.volOfVol * 4));
    spec.garch = undefined;
    spec.heston = { v0: opts.garch.currentVar, kappa, theta, xi, rho: -0.3 };
  }
  return spec;
}

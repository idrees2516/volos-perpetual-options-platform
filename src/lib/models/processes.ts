// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · processes — the path engines behind the lectures' "watch it
// happen" scenes:
//
//   • gbmPath / gbmFan  — one seeded GBM path / a fan of them (Part 1's random
//                         walk made continuous; Part 10's two-worlds P vs Q)
//   • mcEuropean        — price as an expectation (Part 10 ch4: Q-measure Monte
//                         Carlo with a stderr band and antithetic variance kill)
//   • mcPathDependent   — any payoff that eats the whole path (the exotics engine)
//   • crrTree           — Cox–Ross–Rubinstein lattice: European + American put
//                         with the early-exercise free boundary S*(t) per slice
//   • crrConvergence    — the N = 1…400 sawtooth converging onto the closed form
//   • hitProbAbove/Below — the reflection principle: P(touch a barrier) in
//                         closed form — the liquidation-price math of Part 2
//                         ch4 and the engine room of every barrier option
// ─────────────────────────────────────────────────────────────────────────────

import { bsPrice } from './bs';
import { normCdf } from './normal';
import { mulberry32, gaussianStream } from './rng';

/** One seeded geometric-Brownian path (S0 at index 0 … S_T at index steps). */
export function gbmPath(seed: number, S0: number, T: number, steps: number, mu: number, sigma: number): Float64Array {
  const z = gaussianStream(mulberry32(seed >>> 0));
  const dt = T / steps;
  const path = new Float64Array(steps + 1);
  path[0] = S0;
  for (let i = 1; i <= steps; i++) {
    path[i] = path[i - 1] * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z());
  }
  return path;
}

/** Fan of n seeded paths — the lecture's "P and Q, two worlds" prop. */
export function gbmFan(
  seed: number,
  n: number,
  S0: number,
  T: number,
  steps: number,
  mu: number,
  sigma: number,
): Float64Array[] {
  return Array.from({ length: n }, (_, i) => gbmPath((seed + i * 7919) >>> 0, S0, T, steps, mu, sigma));
}

export interface MCResult {
  price: number;
  /** standard error of the mean */
  stderr: number;
  nPaths: number;
}

/** European option by Monte Carlo under the risk-neutral measure (antithetic pairs). */
export function mcEuropean(
  call: boolean,
  S0: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
  nPaths: number,
  seed: number,
): MCResult {
  const z = gaussianStream(mulberry32(seed >>> 0));
  const drift = (r - q - 0.5 * sigma * sigma) * T;
  const vol = sigma * Math.sqrt(T);
  const disc = Math.exp(-r * T);
  let sum = 0;
  let sumSq = 0;
  const m = Math.floor(nPaths / 2);
  for (let i = 0; i < m; i++) {
    const zz = z();
    for (const sgn of [1, -1] as const) {
      const ST = S0 * Math.exp(drift + vol * sgn * zz);
      const payoff = call ? Math.max(ST - K, 0) : Math.max(K - ST, 0);
      const v = disc * payoff;
      sum += v;
      sumSq += v * v;
    }
  }
  const n = 2 * m;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { price: mean, stderr: Math.sqrt(Math.max(0, variance) / n), nPaths: n };
}

/**
 * Path-dependent pricing engine — runs `payoff(path)` on seeded antithetic
 * GBM paths under the risk-neutral drift r−q. Each antithetic pair shares one
 * normal per step (path A +z_j, path B −z_j), the standard variance kill.
 */
export function mcPathDependent(
  payoff: (path: Float64Array) => number,
  S0: number,
  T: number,
  steps: number,
  r: number,
  q: number,
  sigma: number,
  nPaths: number,
  seed: number,
): MCResult {
  const z = gaussianStream(mulberry32(seed >>> 0));
  const dt = T / steps;
  const driftA = (r - q - 0.5 * sigma * sigma) * dt;
  const volA = sigma * Math.sqrt(dt);
  const disc = Math.exp(-r * T);
  const pathA = new Float64Array(steps + 1);
  const pathB = new Float64Array(steps + 1);
  const zs = new Float64Array(steps);
  let sum = 0;
  let sumSq = 0;
  const m = Math.floor(nPaths / 2);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < steps; j++) zs[j] = z();
    pathA[0] = S0;
    pathB[0] = S0;
    for (let j = 1; j <= steps; j++) {
      const e = driftA + volA * zs[j - 1];
      pathA[j] = pathA[j - 1] * Math.exp(e);
      pathB[j] = pathB[j - 1] * Math.exp(driftA - volA * zs[j - 1]);
    }
    for (const p of [pathA, pathB]) {
      const v = disc * payoff(p);
      sum += v;
      sumSq += v * v;
    }
  }
  const n = 2 * m;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { price: mean, stderr: Math.sqrt(variance / n), nPaths: n };
}

// ── binomial (CRR) ──────────────────────────────────────────────────────────

export interface CrrResult {
  euroCall: number;
  euroPut: number;
  amerCall: number;
  amerPut: number;
  /** American-put free boundary S*(t_i) per time slice (null ⇒ never exercise early) */
  putBoundary: (number | null)[];
}

/** Cox–Ross–Rubinstein lattice with American exercise and the put's free boundary. */
export function crrTree(S0: number, K: number, T: number, r: number, q: number, sigma: number, N: number): CrrResult {
  const dt = T / N;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const disc = Math.exp(-r * dt);
  const grow = Math.exp((r - q) * dt);
  const p = (grow - d) / (u - d);
  if (!(p > 0) || !(p < 1)) {
    // degenerate tree (σ too small for the drift) — closed form fallback
    const sg = Math.max(sigma, 1e-4);
    const c = bsPrice(true, S0, K, T, r, q, sg);
    const put = bsPrice(false, S0, K, T, r, q, sg);
    return { euroCall: c, euroPut: put, amerCall: c, amerPut: put, putBoundary: [] };
  }

  const stock = (i: number, j: number) => S0 * Math.pow(u, j) * Math.pow(d, i - j);

  // terminal values
  const callV = new Float64Array(N + 1);
  const putV = new Float64Array(N + 1);
  for (let j = 0; j <= N; j++) {
    const S = stock(N, j);
    callV[j] = Math.max(S - K, 0);
    putV[j] = Math.max(K - S, 0);
  }

  // European back-induction
  const euroCall = new Float64Array(N + 1);
  const euroPut = new Float64Array(N + 1);
  euroCall.set(callV);
  euroPut.set(putV);
  for (let i = N - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      euroCall[j] = disc * (p * euroCall[j + 1] + (1 - p) * euroCall[j]);
      euroPut[j] = disc * (p * euroPut[j + 1] + (1 - p) * euroPut[j]);
    }
  }

  // American back-induction (exercise checked at every node) + the put boundary.
  // NOTE: in-place arrays ⇒ iterate j ASCENDING (node j reads old[j] and old[j+1],
  // neither yet overwritten — descending order would corrupt the induction).
  const amerCall = new Float64Array(N + 1);
  const amerPut = new Float64Array(N + 1);
  amerCall.set(callV);
  amerPut.set(putV);
  const putBoundary: (number | null)[] = new Array(N + 1).fill(null);
  putBoundary[N] = K; // at maturity exercise == intrinsic; boundary = strike
  for (let i = N - 1; i >= 0; i--) {
    let bs: number | null = null; // highest S(i, ·) where exercising the put is optimal
    for (let j = 0; j <= i; j++) {
      const S = stock(i, j);
      const cCont = disc * (p * amerCall[j + 1] + (1 - p) * amerCall[j]);
      amerCall[j] = Math.max(cCont, S - K);
      const pCont = disc * (p * amerPut[j + 1] + (1 - p) * amerPut[j]);
      const exercise = K - S;
      amerPut[j] = Math.max(pCont, exercise);
      // ascending j ⇒ S increases: the LAST exercise-optimal node is the boundary S*(t_i)
      if (pCont < exercise - 1e-12 && exercise > 0) {
        bs = S;
      }
    }
    putBoundary[i] = bs;
  }

  return { euroCall: euroCall[0], euroPut: euroPut[0], amerCall: amerCall[0], amerPut: amerPut[0], putBoundary };
}

/** CRR convergence to the closed form — the N-step sawtooth the lecture shows. */
export function crrConvergence(
  S0: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
  ns: number[],
): { N: number; euroCall: number; amerPut: number }[] {
  return ns.map((N) => {
    const t = crrTree(S0, K, T, r, q, sigma, N);
    return { N, euroCall: t.euroCall, amerPut: t.amerPut };
  });
}

// ── reflection principle ─────────────────────────────────────────────────────

/**
 * P(max_{s≤T} X_s ≥ b) for X = x0 + νt + σW — the reflection principle, closed
 * form. For a spot GBM pass x0 = ln S0, b = ln B, ν = μ − σ²/2.
 * Sanity anchors: ν = 0 ⇒ 2Φ(−(b−x0)/(σ√T)); ν < 0, T → ∞ ⇒ e^{2ν(b−x0)/σ²}.
 */
export function hitProbAbove(x0: number, b: number, T: number, nu: number, sigma: number): number {
  if (b <= x0) return 1;
  const v = sigma * Math.sqrt(T);
  if (v <= 0) return x0 + nu * T >= b ? 1 : 0;
  const gap = b - x0;
  return normCdf((nu * T - gap) / v) + Math.exp((2 * nu * gap) / (sigma * sigma)) * normCdf(-(nu * T + gap) / v);
}

/** P(min_{s≤T} X_s ≤ b) for b below the start — the liquidation-barrier mirror. */
export function hitProbBelow(x0: number, b: number, T: number, nu: number, sigma: number): number {
  if (b >= x0) return 1;
  const v = sigma * Math.sqrt(T);
  if (v <= 0) return x0 + nu * T <= b ? 1 : 0;
  const gap = x0 - b;
  // P(min ≤ b) = Φ((−νT − gap)/v) + e^{−2ν·gap/σ²}·Φ((νT − gap)/v)
  // anchors: ν=0 ⇒ 2Φ(−gap/v); ν>0, T→∞ ⇒ e^{−2ν·gap/σ²}
  return normCdf((-nu * T - gap) / v) + Math.exp((-2 * nu * gap) / (sigma * sigma)) * normCdf((nu * T - gap) / v);
}

/**
 * Probability a leveraged long is liquidated before T (Part 2 ch4): maintenance
 * barrier = entry × (1 − 1/L), drift ν = μ − σ²/2 on the log.
 */
export function liquidationProb(entry: number, leverage: number, mu: number, sigma: number, T: number): number {
  const barrier = entry * (1 - 1 / leverage);
  return hitProbBelow(Math.log(entry), Math.log(barrier), T, mu - 0.5 * sigma * sigma, sigma);
}

/**
 * One-touch by Monte Carlo with BROWNIAN-BRIDGE intrastep crossings — the
 * exact conditional crossing probability
 *   P(step crosses b | endpoints x, xe) = exp(−2(b−x)(b−xe)/(σ²Δt))
 * (for xe < b; 1 if xe ≥ b), drawn as a Bernoulli gate, so the simulation
 * measures the CONTINUOUS barrier despite discrete steps — the gap between
 * this and naive step-wise monitoring is exactly the Broadie–Glasserman–Kou
 * continuity correction (β ≈ 0.5826·σ√Δt) the lectures teach.
 */
export function mcOneTouch(
  S0: number,
  B: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
  nPaths: number,
  seed: number,
): MCResult {
  const uniform = mulberry32((seed ^ 0x51ce5eed) >>> 0);
  const z = gaussianStream(mulberry32(seed >>> 0));
  const steps = 512;
  const dt = T / steps;
  const nu = r - q - 0.5 * sigma * sigma;
  const vdt = sigma * Math.sqrt(dt);
  const b = Math.log(B / S0);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < nPaths; i++) {
    let x = 0;
    let hit = false;
    for (let s = 0; s < steps && !hit; s++) {
      const xe = x + nu * dt + vdt * z();
      if (xe >= b) {
        hit = true;
      } else if (b > x) {
        // Brownian-bridge crossing probability, gated by an independent uniform
        const pCross = Math.exp((-2 * (b - x) * (b - xe)) / (sigma * sigma * dt));
        if (uniform() < pCross) hit = true;
      }
      x = xe;
    }
    const v = hit ? 1 : 0;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / nPaths;
  const variance = Math.max(0, sumSq / nPaths - mean * mean);
  return { price: mean, stderr: Math.sqrt(variance / nPaths), nPaths };
}

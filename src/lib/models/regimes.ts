// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · regimes — the Hidden Markov Model engine.
//
// A Gaussian-emission HMM fit by SCALED Baum–Welch (forward–backward with
// per-step rescaling — no underflow, no logs needed), deterministic
// quantile-based initialization, Viterbi decoding of the full state path, and
// a regime verdict (state probabilities now, transition matrix, expected
// durations, stationary distribution). This is the engine that answers
// "which market are we actually in" — calm, trending, or violent — with
// probabilities instead of adjectives.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32 } from './rng';

export interface HmmState {
  mu: number;
  sigma: number;
  /** stationary share of time spent in this state (power iteration on A) */
  stationaryProb: number;
  /** E[run length in bars] = 1/(1 − a_ii) */
  expectedDurationBars: number;
  /** σ-ordered label */
  label: 'calm' | 'normal' | 'trending' | 'volatile' | 'extreme';
}

export interface HmmFit {
  k: number;
  states: HmmState[];
  /** row-stochastic transition matrix A (k×k) */
  trans: number[][];
  /** filtered state probabilities at the last observation */
  probsNow: number[];
  /** state probabilities for the final 120 observations (chart tail) */
  probsTail: number[][];
  /** Viterbi-decoded state index per observation */
  path: number[];
  logLik: number;
  iterations: number;
  converged: boolean;
  n: number;
}

const STATE_LABELS: HmmState['label'][] = ['calm', 'normal', 'trending', 'volatile', 'extreme'];

function gaussPdf(x: number, mu: number, sigma: number): number {
  const s = Math.max(1e-8, sigma);
  const z = (x - mu) / s;
  return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
}

/** Deterministic quantile initialization of means/vars per state band. */
function initStates(returns: number[], k: number): { mus: number[]; sigmas: number[] } {
  const sorted = [...returns].sort((a, b) => a - b);
  const mus: number[] = [];
  const sigmas: number[] = [];
  for (let i = 0; i < k; i++) {
    const lo = Math.floor((i / k) * sorted.length);
    const hi = Math.floor(((i + 1) / k) * sorted.length);
    const band = sorted.slice(lo, Math.max(lo + 1, hi));
    const m = band.reduce((a, b) => a + b, 0) / band.length;
    const v = band.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, band.length - 1);
    mus.push(m);
    sigmas.push(Math.max(1e-6, Math.sqrt(v)));
  }
  return { mus, sigmas };
}

/** Stationary distribution of a row-stochastic matrix by power iteration. */
function stationaryDist(trans: number[][]): number[] {
  const k = trans.length;
  let p = new Array<number>(k).fill(1 / k);
  for (let it = 0; it < 200; it++) {
    const next = new Array<number>(k).fill(0);
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) next[j] += p[i] * trans[i][j];
    const s = next.reduce((a, b) => a + b, 0) || 1;
    for (let j = 0; j < k; j++) next[j] /= s;
    const delta = Math.max(...next.map((v, j) => Math.abs(v - p[j])));
    p = next;
    if (delta < 1e-10) break;
  }
  return p;
}

/**
 * Fit a k-state Gaussian HMM by scaled Baum–Welch.
 * Deterministic: quantile-band init + a fixed tiny self-transition floor —
 * the only rng use is optional state-order tie-breaking (seeded, unused
 * default). `maxIter` Baum–Welch passes with a 1e-4 relative log-lik stop.
 */
export function fitHmm(returns: number[], opts: { k?: number; maxIter?: number; seed?: number } = {}): HmmFit | null {
  const n = returns.length;
  const k = Math.max(2, Math.min(4, opts.k ?? 3));
  if (n < Math.max(60, 24 * k)) return null;
  const maxIter = opts.maxIter ?? 60;
  void mulberry32;

  const { mus, sigmas } = initStates(returns, k);
  // transitions: strong diagonal start
  let A: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 0.9 : 0.1 / (k - 1))),
  );
  let pi = new Array<number>(k).fill(1 / k);

  let prevLL = -Infinity;
  let converged = false;
  let iterations = 0;
  let alpha: number[][] = [];
  let scales: number[] = [];

  for (let iter = 0; iter < maxIter; iter++) {
    // ── forward with scaling ───────────────────────────────────────────────
    alpha = Array.from({ length: n }, () => new Array<number>(k).fill(0));
    scales = new Array<number>(n).fill(0);
    const b0 = mus.map((m, i) => gaussPdf(returns[0], m, sigmas[i]));
    let c0 = 0;
    for (let i = 0; i < k; i++) {
      alpha[0][i] = pi[i] * b0[i];
      c0 += alpha[0][i];
    }
    scales[0] = c0 || 1e-300;
    for (let i = 0; i < k; i++) alpha[0][i] /= scales[0];
    for (let t = 1; t < n; t++) {
      const bt = mus.map((m, i) => gaussPdf(returns[t], m, sigmas[i]));
      let ct = 0;
      for (let j = 0; j < k; j++) {
        let acc = 0;
        for (let i = 0; i < k; i++) acc += alpha[t - 1][i] * A[i][j];
        alpha[t][j] = acc * bt[j];
        ct += alpha[t][j];
      }
      scales[t] = ct || 1e-300;
      for (let j = 0; j < k; j++) alpha[t][j] /= scales[t];
    }
    const logLik = scales.reduce((acc, c) => acc + Math.log(c), 0);
    if (Number.isFinite(prevLL) && Math.abs(logLik - prevLL) < 1e-4 * Math.abs(prevLL || 1)) {
      converged = true;
      iterations = iter + 1;
      break;
    }
    prevLL = logLik;

    // ── backward with the same scale factors ──────────────────────────────
    const beta: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(0));
    for (let j = 0; j < k; j++) beta[n - 1][j] = 1 / scales[n - 1];
    for (let t = n - 2; t >= 0; t--) {
      const bt1 = mus.map((m, i) => gaussPdf(returns[t + 1], m, sigmas[i]));
      for (let i = 0; i < k; i++) {
        let acc = 0;
        for (let j = 0; j < k; j++) acc += A[i][j] * bt1[j] * beta[t + 1][j];
        beta[t][i] = acc / scales[t];
      }
    }

    // ── E-step: gamma and xi ──────────────────────────────────────────────
    const gamma: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(0));
    for (let t = 0; t < n; t++) {
      let s = 0;
      for (let i = 0; i < k; i++) {
        gamma[t][i] = alpha[t][i] * beta[t][i] * scales[t];
        s += gamma[t][i];
      }
      if (s > 0) for (let i = 0; i < k; i++) gamma[t][i] /= s;
    }
    const xiSum: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let t = 0; t < n - 1; t++) {
      const bt1 = mus.map((m, i) => gaussPdf(returns[t + 1], m, sigmas[i]));
      let norm = 0;
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          const v = alpha[t][i] * A[i][j] * bt1[j] * beta[t + 1][j];
          xiSum[i][j] += v;
          norm += v;
        }
      }
      if (norm > 0) for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) xiSum[i][j] /= norm;
    }

    // ── M-step ────────────────────────────────────────────────────────────
    pi = gamma[0].slice();
    const musNew = new Array<number>(k).fill(0);
    const gamSum = new Array<number>(k).fill(0);
    for (let t = 0; t < n; t++) for (let i = 0; i < k; i++) gamSum[i] += gamma[t][i];
    for (let i = 0; i < k; i++) {
      if (gamSum[i] <= 1e-12) {
        musNew[i] = mus[i];
        continue;
      }
      for (let t = 0; t < n; t++) musNew[i] += (gamma[t][i] * returns[t]) / gamSum[i];
    }
    const sigmasNew = new Array<number>(k).fill(0);
    for (let i = 0; i < k; i++) {
      if (gamSum[i] <= 1e-12) {
        sigmasNew[i] = sigmas[i];
        continue;
      }
      for (let t = 0; t < n; t++) sigmasNew[i] += (gamma[t][i] * (returns[t] - musNew[i]) ** 2) / gamSum[i];
      sigmasNew[i] = Math.sqrt(Math.max(1e-10, sigmasNew[i]));
    }
    // A update with a small self-transition floor (degenerate-run guard)
    const floor = 1e-3;
    A = Array.from({ length: k }, (_, i) => {
      const row = Array.from({ length: k }, (_, j) => xiSum[i][j] + (i === j ? floor : 0));
      const s = row.reduce((a, b) => a + b, 0) || 1;
      return row.map((v) => v / s);
    });
    mus.forEach((_, i) => {
      mus[i] = musNew[i];
      sigmas[i] = sigmasNew[i];
    });
    iterations = iter + 1;
  }

  // ── Viterbi decode of the final fit ────────────────────────────────────────
  const path: number[] = new Array<number>(n).fill(0);
  {
    const delta: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(0));
    const psi: number[][] = Array.from({ length: n }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < k; i++) delta[0][i] = Math.log(Math.max(1e-300, pi[i])) + Math.log(Math.max(1e-300, gaussPdf(returns[0], mus[i], sigmas[i])));
    for (let t = 1; t < n; t++) {
      for (let j = 0; j < k; j++) {
        let bestI = 0;
        let bestV = -Infinity;
        for (let i = 0; i < k; i++) {
          const v = delta[t - 1][i] + Math.log(Math.max(1e-300, A[i][j]));
          if (v > bestV) {
            bestV = v;
            bestI = i;
          }
        }
        delta[t][j] = bestV + Math.log(Math.max(1e-300, gaussPdf(returns[t], mus[j], sigmas[j])));
        psi[t][j] = bestI;
      }
    }
    let bestJ = 0;
    for (let j = 1; j < k; j++) if (delta[n - 1][j] > delta[n - 1][bestJ]) bestJ = j;
    path[n - 1] = bestJ;
    for (let t = n - 1; t > 0; t--) path[t - 1] = psi[t][path[t]];
  }

  // order states by σ (calm → extreme) and build the public shape
  const order = mus.map((_, i) => i).sort((a, b) => sigmas[a] - sigmas[b]);
  const transOrdered = order.map((i) => order.map((j) => A[i][j]));
  const stat = stationaryDist(transOrdered);
  const states: HmmState[] = order.map((i, rank) => {
    const persist = 1 - Math.max(0, Math.min(1, transOrdered[rank][rank]));
    return {
      mu: mus[i],
      sigma: sigmas[i],
      stationaryProb: stat[rank],
      expectedDurationBars: persist > 0 ? 1 / persist : Infinity,
      label: STATE_LABELS[Math.min(STATE_LABELS.length - 1, Math.round((rank / Math.max(1, k - 1)) * 4))],
    };
  });
  const probsNow = order.map((_, rank) => alpha[n - 1][rank] ?? 0);
  const probsTail = alpha.slice(-120).map((row) => order.map((_, rank) => row[rank] ?? 0));
  const pathOrdered = path.map((s) => order.indexOf(s));

  return {
    k,
    states,
    trans: transOrdered,
    probsNow,
    probsTail,
    path: pathOrdered,
    logLik: Number.isFinite(prevLL) ? prevLL : 0,
    iterations,
    converged,
    n,
  };
}

/** The regime verdict: dominant state now + its probability + regime score. */
export function hmmRegime(fit: HmmFit): {
  label: HmmState['label'];
  prob: number;
  regimeScore: number; // −100 calm-risk-off … +100 (unused sign convention: high vol = negative)
  expectedDurationBars: number;
  probsNow: number[];
  dominantIndex: number;
} {
  let dom = 0;
  for (let i = 1; i < fit.k; i++) if (fit.probsNow[i] > fit.probsNow[dom]) dom = i;
  const s = fit.states[dom];
  // map σ-rank to a stance: extreme/volatile ⇒ risk-off (negative), calm/trending ⇒ positive
  const rankScore = -((dom / Math.max(1, fit.k - 1)) * 2 - 1) * 100;
  return {
    label: s.label,
    prob: fit.probsNow[dom],
    regimeScore: Math.round(Math.max(-100, Math.min(100, rankScore))),
    expectedDurationBars: s.expectedDurationBars,
    probsNow: fit.probsNow,
    dominantIndex: dom,
  };
}

/**
 * Synthetic regime-switching returns for the lab's HMM explorer: a seeded
 * 3-state generator with known parameters, so the model can be judged against
 * ground truth in the UI.
 */
export function simulateRegimeReturns(
  seed: number,
  n: number,
  opts: { calmSigma?: number; trendSigma?: number; violentSigma?: number; pStay?: number } = {},
): { returns: number[]; states: number[] } {
  const rng = mulberry32(seed >>> 0);
  const gauss = (): number => {
    // Box–Muller from the seeded uniform
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const pStay = opts.pStay ?? 0.96;
  const sigmas = [opts.calmSigma ?? 0.004, opts.trendSigma ?? 0.01, opts.violentSigma ?? 0.03];
  const mus = [0.0002, 0.0009, -0.0015];
  let state = 0;
  const returns: number[] = [];
  const states: number[] = [];
  for (let t = 0; t < n; t++) {
    if (rng() > pStay) state = Math.floor(rng() * 3);
    returns.push(mus[state] + sigmas[state] * gauss());
    states.push(state);
  }
  return { returns, states };
}

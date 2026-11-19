// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · hedging — "trading options" as a running machine (Part 11):
//
//   • hedgingLedger   — the gamma-scalper's book: option marked at IMPLIED vol,
//                       hedge set to delta, path generated at REALIZED vol; each
//                       step decomposes into the ledger identity
//                       d(book) = ½ΓS²[(ΔS/S)² − σᵢ²Δt]  — gamma vs theta, live
//   • shuffleLedger   — same hourly returns, different ORDER: identical realized
//                       variance, wildly different P&L (the path-order lesson)
//   • pnlExplain      — the desk's next-morning waterfall: delta/gamma/theta/
//                       vega/vanna/volga/unexplained against the real revaluation
//   • discreteHedge   — hedging frequency vs error (slope ≈ −½ in log-log) with
//                       transaction costs on/off — Leland's effect measured, not
//                       quoted: costs make frequency a trade, not a free lunch
//   • wwBand          — Whalley–Wilmott no-trade corridor: cube root of cost —
//                       double the cost, band ×2^{1/3} ≈ 1.26 (the lecture's
//                       pause-and-predict, computed here)
// ─────────────────────────────────────────────────────────────────────────────

import { bsPrice, delta, gamma, vanna, volga, vega, theta, dollarGamma } from './bs';
import { mulberry32, gaussianStream } from './rng';

export interface LedgerOpts {
  seed: number;
  S0: number;
  K: number;
  /** days to expiry */
  days: number;
  /** implied vol (the desk's mark) */
  sigmaI: number;
  /** realized vol (what the path actually does) */
  sigmaR: number;
  /** rebalance every n steps (1 = every step) */
  hedgeEvery: number;
  /** total steps across the life */
  nSteps: number;
  r: number;
  q: number;
  /** proportional transaction cost on traded notional */
  costRate: number;
  /** P-drift of the path (the ledger is drift-free — set it nonzero and watch) */
  mu: number;
}

export interface LedgerStep {
  i: number;
  /** fraction of life elapsed */
  t: number;
  S: number;
  /** cumulated book P&L */
  pnl: number;
  /** running ½ΓS²Σr² (gamma scalps) */
  gammaSum: number;
  /** running −½ΓS²σᵢ²Σdt (theta bleed) */
  thetaSum: number;
}

export interface LedgerResult {
  path: Float64Array;
  steps: LedgerStep[];
  total: number;
  gammaSum: number;
  thetaSum: number;
  residual: number;
  /** how many times the hedge actually traded */
  trades: number;
  costPaid: number;
  breakevenDaily: number;
}

/** Run the scalper: long call, delta-hedged every `hedgeEvery` steps (≤0 = rehedge on a ±2% move). */
export function hedgingLedger(o: LedgerOpts): LedgerResult {
  const z = gaussianStream(mulberry32(o.seed >>> 0));
  const T = o.days / 365;
  const dt = T / o.nSteps;
  const path = new Float64Array(o.nSteps + 1);
  const steps: LedgerStep[] = [];
  path[0] = o.S0;
  let S = o.S0;
  let hedgePos = delta(true, S, o.K, T, o.r, o.q, o.sigmaI);
  let lastHedgedS = o.S0;
  let pnl = 0;
  let gammaSum = 0;
  let thetaSum = 0;
  let costPaid = 0;
  let trades = 1;
  const moveTrigger = 0.02;
  for (let i = 1; i <= o.nSteps; i++) {
    const Sprev = S;
    // the path runs at REALIZED vol, with any P-drift (μ) the viewer chooses
    S = Sprev * Math.exp((o.mu - 0.5 * o.sigmaR * o.sigmaR) * dt + o.sigmaR * Math.sqrt(dt) * z());
    const tau = T * (1 - i / o.nSteps);
    const ret = S / Sprev - 1;
    // option mark-to-market at implied vol
    const Vprev = bsPrice(true, Sprev, o.K, Math.max(tau + dt, 1e-9), o.r, o.q, o.sigmaI);
    const Vnow = bsPrice(true, S, o.K, Math.max(tau, 1e-9), o.r, o.q, o.sigmaI);
    const stepPnl = Vnow - Vprev - hedgePos * (S - Sprev);
    pnl += stepPnl;
    // ledger decomposition of the same step
    const g = gamma(Sprev, o.K, Math.max(tau + dt, 1e-9), o.r, o.q, o.sigmaI);
    const dG = 0.5 * g * Sprev * Sprev;
    gammaSum += dG * ret * ret;
    thetaSum += -dG * o.sigmaI * o.sigmaI * dt;
    // rebalance?  (fixed cadence, or move-triggered when hedgeEvery ≤ 0)
    const due = o.hedgeEvery > 0 ? i % o.hedgeEvery === 0 : Math.abs(S / lastHedgedS - 1) >= moveTrigger;
    if (due && tau > 0) {
      const newHedge = delta(true, S, o.K, tau, o.r, o.q, o.sigmaI);
      const traded = Math.abs(newHedge - hedgePos);
      costPaid += traded * S * o.costRate;
      pnl -= traded * S * o.costRate;
      trades++;
      hedgePos = newHedge;
      lastHedgedS = S;
    }
    steps.push({
      i,
      t: i / o.nSteps,
      S,
      pnl,
      gammaSum,
      thetaSum,
    });
  }
  const total = pnl;
  return {
    path,
    steps,
    total,
    gammaSum,
    thetaSum,
    residual: total - gammaSum - thetaSum,
    trades,
    costPaid,
    breakevenDaily: o.sigmaI * Math.sqrt(1 / 365),
  };
}

/** Same hourly returns, reshuffled — identical variance, different P&L. */
export function shuffleLedger(o: LedgerOpts, nPerm: number): { base: LedgerResult; samples: number[]; mean: number; p05: number; p95: number } {
  const base = hedgingLedger(o);
  const z = gaussianStream(mulberry32((o.seed ^ 0x9e3779b9) >>> 0));
  // collect the base hourly log-returns, then reshuffle with Fisher–Yates
  const rets: number[] = [];
  for (let i = 1; i < base.path.length; i++) rets.push(Math.log(base.path[i] / base.path[i - 1]));
  const samples: number[] = [];
  const T = o.days / 365;
  const dt = T / o.nSteps;
  const work = rets.slice();
  for (let p = 0; p < nPerm; p++) {
    for (let i = work.length - 1; i > 0; i--) {
      const j = Math.floor(z() * (i + 1));
      [work[i], work[j]] = [work[j], work[i]];
    }
    // replay the ledger on the shuffled returns (daily hedging assumed)
    let S = o.S0;
    let hedgePos = delta(true, S, o.K, T, o.r, o.q, o.sigmaI);
    let pnl = 0;
    let gammaSum = 0;
    for (let i = 1; i <= o.nSteps; i++) {
      const Sprev = S;
      S = Sprev * Math.exp(work[i - 1]);
      const tau = T * (1 - i / o.nSteps);
      const Vprev = bsPrice(true, Sprev, o.K, Math.max(tau + dt, 1e-9), o.r, o.q, o.sigmaI);
      const Vnow = bsPrice(true, S, o.K, Math.max(tau, 1e-9), o.r, o.q, o.sigmaI);
      pnl += Vnow - Vprev - hedgePos * (S - Sprev);
      const g = gamma(Sprev, o.K, Math.max(tau + dt, 1e-9), o.r, o.q, o.sigmaI);
      const ret = S / Sprev - 1;
      gammaSum += 0.5 * g * Sprev * Sprev * ret * ret;
      if (tau > 0) hedgePos = delta(true, S, o.K, tau, o.r, o.q, o.sigmaI);
    }
    samples.push(pnl);
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    base,
    samples,
    mean: samples.reduce((s, v) => s + v, 0) / samples.length,
    p05: sorted[Math.floor(sorted.length * 0.05)] ?? NaN,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? NaN,
  };
}

// ── the P&L explain waterfall ────────────────────────────────────────────────

export interface ExplainLeg {
  call: boolean;
  K: number;
  /** days to expiry at t0 */
  days: number;
  qty: number;
}

export interface ExplainReport {
  legs: ExplainLeg[];
  dS: number;
  /** vol move in σ units (e.g. −0.026 = −2.6 vol points) */
  dSigma: number;
  dDays: number;
  total: number;
  contributions: { label: string; value: number }[];
  unexplained: number;
}

/** One night on the desk: full revaluation vs the Taylor waterfall. */
export function pnlExplain(
  legs: ExplainLeg[],
  S0: number,
  sigma0: number,
  dS: number,
  dSigma: number,
  dDays: number,
  r: number,
  q: number,
): ExplainReport {
  const S1 = S0 + dS;
  const sigma1 = Math.max(0.005, sigma0 + dSigma);
  const entries: { label: string; value: number }[] = [];
  let total = 0;
  let agg = {
    delta: 0,
    gamma: 0,
    theta: 0,
    vega: 0,
    vanna: 0,
    volga: 0,
  };
  for (const leg of legs) {
    const T0 = leg.days / 365;
    const T1 = Math.max(leg.days - dDays, 0) / 365;
    const V0 = bsPrice(leg.call, S0, leg.K, T0, r, q, sigma0);
    const V1 = bsPrice(leg.call, S1, leg.K, T1, r, q, sigma1);
    total += leg.qty * (V1 - V0);
    agg.delta += leg.qty * delta(leg.call, S0, leg.K, T0, r, q, sigma0);
    agg.gamma += leg.qty * 0.5 * gamma(S0, leg.K, T0, r, q, sigma0) * dS * dS;
    agg.theta += leg.qty * (theta(leg.call, S0, leg.K, T0, r, q, sigma0) / 365) * dDays;
    agg.vega += leg.qty * vega(S0, leg.K, T0, r, q, sigma0) * dSigma;
    agg.vanna += leg.qty * vanna(S0, leg.K, T0, r, q, sigma0) * dS * dSigma;
    agg.volga += leg.qty * 0.5 * volga(S0, leg.K, T0, r, q, sigma0) * dSigma * dSigma;
  }
  entries.push({ label: 'delta', value: agg.delta * dS });
  entries.push({ label: 'gamma', value: agg.gamma });
  entries.push({ label: 'theta', value: agg.theta });
  entries.push({ label: 'vega', value: agg.vega });
  entries.push({ label: 'vanna', value: agg.vanna });
  entries.push({ label: 'volga', value: agg.volga });
  const sum = entries.reduce((s, e) => s + e.value, 0);
  return {
    legs,
    dS,
    dSigma,
    dDays,
    total,
    contributions: entries,
    unexplained: total - sum,
  };
}

// ── discrete hedging and the WW band ─────────────────────────────────────────

export interface DiscreteRow {
  /** hedge interval in trading-step units */
  every: number;
  label: string;
  meanPnl: number;
  sdPnl: number;
  meanCost: number;
}

/** Frequency study: hedging every / 4× / daily / on-2%-moves, with & without costs. */
export function discreteHedge(
  o: Omit<LedgerOpts, 'hedgeEvery' | 'nSteps' | 'seed'> & { nSteps: number; nSims: number; seed: number },
): DiscreteRow[] {
  const rows: DiscreteRow[] = [];
  const configs: { every: number; label: string }[] = [
    { every: 1, label: 'every step' },
    { every: 4, label: 'every 4 steps' },
    { every: 24, label: 'daily (24h)' },
    { every: -1, label: 'on ±2% move' },
  ];
  for (const c of configs) {
    let pnls = 0;
    let pnlSq = 0;
    let costs = 0;
    for (let s = 0; s < o.nSims; s++) {
      const res = hedgingLedger({
        seed: (o.seed + s * 1299709) >>> 0,
        S0: o.S0,
        K: o.K,
        days: o.days,
        sigmaI: o.sigmaI,
        sigmaR: o.sigmaR,
        hedgeEvery: c.every,
        nSteps: o.nSteps,
        r: o.r,
        q: o.q,
        costRate: o.costRate,
        mu: 0,
      });
      pnls += res.total;
      pnlSq += res.total * res.total;
      costs += res.costPaid;
    }
    const mean = pnls / o.nSims;
    const sd = Math.sqrt(Math.max(0, pnlSq / o.nSims - mean * mean));
    rows.push({ every: c.every, label: c.label, meanPnl: mean, sdPnl: sd, meanCost: costs / o.nSims });
  }
  return rows;
}

/**
 * Whalley–Wilmott no-trade band (asymptotic form): half-width in DELTA
 *   h = [ (3/2) · (costRate · dollarGamma) / riskAversion ]^{1/3}
 * Cube root of cost — double the cost, the band widens only ×2^{1/3} ≈ 1.26.
 */
export function wwBand(
  S: number,
  K: number,
  T: number,
  sigma: number,
  r: number,
  q: number,
  costRate: number,
  riskAversion: number,
): { halfWidth: number; centre: number; lo: number; hi: number } {
  const centre = delta(true, S, K, T, r, q, sigma);
  const dG = dollarGamma(S, K, T, r, q, sigma);
  const h = Math.pow((1.5 * costRate * dG) / riskAversion, 1 / 3);
  return { halfWidth: h, centre, lo: centre - h, hi: centre + h };
}

/** Leland's question, answered empirically: what σ makes the cost-laden hedger whole? */
export function lelandEffectiveVol(o: Omit<LedgerOpts, 'sigmaI'> & { sigmaI: number; nSims: number }): number | null {
  // the hedger marks at sigmaI; with costs the mean P&L drifts down — find the
  // sigma that recentres it by bisection on mean P&L
  let lo = o.sigmaI;
  let hi = o.sigmaI * 1.5;
  const meanAt = (sg: number) => {
    let acc = 0;
    for (let s = 0; s < o.nSims; s++) {
      acc += hedgingLedger({ ...o, sigmaI: sg, seed: (o.seed + s * 2654435761) >>> 0 }).total;
    }
    return acc / o.nSims;
  };
  let mLo = meanAt(lo);
  if (mLo > 0) return lo; // already whole
  for (let i = 0; i < 30; i++) {
    const mid = 0.5 * (lo + hi);
    const m = meanAt(mid);
    if (m < 0) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-4) break;
  }
  return 0.5 * (lo + hi);
}

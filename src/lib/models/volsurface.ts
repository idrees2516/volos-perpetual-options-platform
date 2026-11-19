// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · volsurface — the volatility surface as an object (Part 12).
//
//   • sviParam / sviW      — Gatheral's raw SVI slice: w(k) = a + b[ρ(k−m) + √((k−m)²+σ²)]
//   • sviSlice             — a full implied-vol slice hung off 5 numbers
//   • sviDerivs            — analytic w' and w'' (the only derivatives we trust)
//   • gOf                  — Gatheral's g(k): butterfly-arbitrage detector; g < 0
//                            ⇒ a negative risk-neutral density ⇒ a butterfly
//                            you are PAID to own (Part 12 ch3's glowing red region)
//   • calendarCheck        — no-calendar-arbitrage ⇔ ∂w/∂T ≥ 0 at fixed k
//   • leeWing              — Lee (2004): wing slope β ≤ 2, implied moment p̃ = (2−β)²/(8β)
//   • dupireLocalVol       — Dupire's formula in total-variance form; the local
//                            vol surface a skewed market actually implies
//   • varSwapStrike        — the 1/K² strip: the log contract's fair variance
//   • jwParams             — Zeliade's trader view: ATM vol, ATM skew, put/call wings
// ─────────────────────────────────────────────────────────────────────────────

import { bsPrice } from './bs';
import { normInv } from './normal';

/** Raw-SVI parameters — the five numbers a desk actually quotes (per slice). */
export interface SviParam {
  /** minimum total variance (can be negative in raw form) */
  a: number;
  /** wing slope scale, b(1+|ρ|) ≤ 2 (Lee) */
  b: number;
  /** asymmetry: −1 put wing steep, +1 call wing steep */
  rho: number;
  /** center of the smile in log-moneyness */
  m: number;
  /** rounding of the vertex */
  si: number;
}

/** Total implied variance w(k) at log-moneyness k = ln(K/F). */
export function sviW(k: number, p: SviParam): number {
  const km = k - p.m;
  return p.a + p.b * (p.rho * km + Math.sqrt(km * km + p.si * p.si));
}

/** Implied vol σ(k) = √(w(k)/T). */
export function sviIV(k: number, T: number, p: SviParam): number {
  const w = sviW(k, p);
  return Math.sqrt(Math.max(0, w) / T);
}

/** Analytic first derivative w'(k). */
function sviW1(k: number, p: SviParam): number {
  const km = k - p.m;
  return p.b * (p.rho + km / Math.sqrt(km * km + p.si * p.si));
}

/** Analytic second derivative w''(k). */
function sviW2(k: number, p: SviParam): number {
  const km = k - p.m;
  const d = km * km + p.si * p.si;
  return (p.b * p.si * p.si) / (d * Math.sqrt(d));
}

/**
 * Gatheral's g(k) — no-butterfly-arbitrage ⇔ g ≥ 0.
 *   g = (1 − k·w'/(2w))² − (w'/2)²·(1/w + 1/4) + w''/2
 */
export function gOf(k: number, w: number, w1: number, w2: number): number {
  if (w <= 0) return NaN;
  const t1 = Math.pow(1 - (k * w1) / (2 * w), 2);
  const t2 = ((w1 * w1) / 4) * (1 / w + 0.25);
  return t1 - t2 + w2 / 2;
}

/** g(k) for a raw-SVI slice (analytic derivatives). */
export function sviG(k: number, p: SviParam): number {
  return gOf(k, sviW(k, p), sviW1(k, p), sviW2(k, p));
}

/** Scan a slice for butterfly arbitrage: the min g on a k grid. */
export function sviGMin(p: SviParam, kLo = -1, kHi = 1, n = 400): { min: number; atK: number } {
  let min = Infinity;
  let atK = kLo;
  for (let i = 0; i <= n; i++) {
    const k = kLo + ((kHi - kLo) * i) / n;
    const g = sviG(k, p);
    if (Number.isFinite(g) && g < min) {
      min = g;
      atK = k;
    }
  }
  return { min, atK };
}

/** The implied risk-neutral density shape q(k) ∝ g(k)/√w·e^{−d−²/2} — its sign is g's sign. */
export function sviDensitySign(p: SviParam, k: number): number {
  return Math.sign(sviG(k, p));
}

// ── the surface: SVI slices hung on a term structure ────────────────────────

/** One expiry of the surface. */
export interface SurfaceSlice {
  /** years */
  T: number;
  p: SviParam;
}

export interface VolSurface {
  slices: SurfaceSlice[];
  /** spot */
  S: number;
  r: number;
  q: number;
}

/** ATM total variance of a slice (k = 0). */
export function atmTotalVar(p: SviParam): number {
  return sviW(0, p);
}

/**
 * The surface family the panels sculpt with sliders — the lecture's SSVI view
 * ("θ_T rising on the floor, SVI smiles hung above it") built from raw-SVI
 * slices that share one tilt ρ and one wing strength λ, so the smile's shape
 * evolves with maturity the way desks see it: b(T) = λ·√θ(T) makes ATM skew
 * in vol points decay like 1/√T (the classic term structure of skew), and a
 * is solved so w(0) = θ(T) pins the ATM variance to the term curve.
 */
export interface SurfaceSpec {
  S: number;
  r: number;
  q: number;
  /** ATM vol at the FIRST expiry (term curve then scales per-expiry). */
  atmVols: number[];
  /** shared asymmetry (−1 put skew … +1 call skew) */
  rho: number;
  /** wing strength λ — b(T) = λ√θ(T) */
  skew: number;
  /** smile centre in log-moneyness */
  m: number;
  /** vertex rounding */
  si: number;
  /** expiries in years, paired 1:1 with atmVols */
  expiries: number[];
}

export function buildSurface(spec: SurfaceSpec): VolSurface {
  const slices: SurfaceSlice[] = spec.expiries.map((T, i) => {
    const atmVol = spec.atmVols[Math.min(i, spec.atmVols.length - 1)];
    const theta = (atmVol * atmVol) * T;
    const b = spec.skew * Math.sqrt(theta);
    // a solved so w(0) = θ: a = θ − b·(ρ(0−m) + √(m²+σ²))
    const a = theta - b * (spec.rho * -spec.m + Math.sqrt(spec.m * spec.m + spec.si * spec.si));
    return { T, p: { a, b, rho: spec.rho, m: spec.m, si: spec.si } };
  });
  return { slices, S: spec.S, r: spec.r, q: spec.q };
}

// ── static arbitrage checks ─────────────────────────────────────────────────

/** No calendar arbitrage ⇔ ∂w/∂T ≥ 0 at fixed k for every adjacent slice pair. */
export function calendarCheck(surface: VolSurface, kGrid: number[]): {
  ok: boolean;
  worstPair: { T1: number; T2: number; k: number; dw: number } | null;
} {
  let worst: { T1: number; T2: number; k: number; dw: number } | null = null;
  for (let i = 1; i < surface.slices.length; i++) {
    const { T: T1, p: p1 } = surface.slices[i - 1];
    const { T: T2, p: p2 } = surface.slices[i];
    for (const k of kGrid) {
      const dw = (sviW(k, p2) - sviW(k, p1)) / (T2 - T1);
      if (dw < -1e-9 && (worst === null || dw < worst.dw)) {
        worst = { T1, T2, k, dw };
      }
    }
  }
  return { ok: worst === null, worstPair: worst };
}

/**
 * Lee's wing bound: at large |k|, w ~ β·|k| with β ≤ 2; the implied moment
 * p̃ = (2 − β)²/(8β) (right wing) and q̃ = (2 − β_L)²/(8β_L) (left).
 */
export function leeWing(p: SviParam): { betaRight: number; betaLeft: number; pRight: number; qLeft: number } {
  const betaRight = p.b * (1 + p.rho);
  const betaLeft = p.b * (1 - p.rho);
  const moment = (beta: number) => ((2 - beta) * (2 - beta)) / (8 * beta);
  return { betaRight, betaLeft, pRight: moment(betaRight), qLeft: moment(betaLeft) };
}

// ── Dupire local volatility ──────────────────────────────────────────────────

/**
 * Dupire's local variance from the total-variance surface (Gatheral ch 1):
 *   σ_loc²(k,T) = ∂w/∂T / [1 − (k/w)·∂w/∂k + ((∂w/∂k)²/4)(−1/4 − 1/w + k²/w²) + w''/2]
 * evaluated numerically on a fine grid from SVI slices (w exact per slice,
 * ∂w/∂T from adjacent slices in T).
 */
export function dupireGrid(
  surface: VolSurface,
  kGrid: number[],
): { k: number[]; T: number[]; lv: number[][]; dataOk: boolean } {
  const { slices } = surface;
  const Ts = slices.map((s) => s.T);
  const lv: number[][] = [];
  let dataOk = true;
  for (let i = 1; i < slices.length; i++) {
    const row: number[] = [];
    const { T: T1, p: p1 } = slices[i - 1];
    const { T: T2, p: p2 } = slices[i];
    const dT = T2 - T1;
    for (const k of kGrid) {
      const w2 = sviW(k, p2);
      const w = w2;
      const w1 = sviW1(k, p2);
      const w2d = sviW2(k, p2);
      const wT = (sviW(k, p2) - sviW(k, p1)) / dT;
      if (w <= 0 || !Number.isFinite(wT)) {
        row.push(NaN);
        dataOk = false;
        continue;
      }
      const denom =
        1 -
        (k * w1) / w +
        (w1 * w1 * (-(1 / 4) - 1 / w + (k * k) / (w * w))) / 4 +
        w2d / 2;
      const v = denom > 1e-12 ? wT / denom : NaN;
      if (!Number.isFinite(v)) dataOk = false;
      row.push(v > 0 ? Math.sqrt(v) : NaN);
    }
    lv.push(row);
  }
  return { k: kGrid, T: Ts.slice(1), lv, dataOk };
}

// ── variance swap ────────────────────────────────────────────────────────────

/**
 * Fair variance-swap strike from the OTM strip:
 *   K_var² = (2/T)·∫_0^∞ Q(K)/K² dK,  Q = OTM option price (C above F, P below)
 * computed by trapezoid over the SVI slice's implied-vol prices — the same
 * recipe the VIX uses (Cboe strips, Part 12 ch11). Flat σ ⇒ K_var = σ exactly.
 */
export function varSwapStrike(
  S: number,
  T: number,
  r: number,
  q: number,
  p: SviParam,
  kLo = -1.5,
  kHi = 1.5,
  n = 400,
): number {
  const F = S * Math.exp((r - q) * T);
  const dk = (kHi - kLo) / n;
  let acc = 0;
  for (let i = 0; i <= n; i++) {
    const k = kLo + i * dk;
    const K = F * Math.exp(k);
    const sigma = sviIV(k, T, p);
    // OTM strip: call above F, put below — the put priced DIRECTLY (with r ≠ 0
    // the put is not call − forward intrinsic; parity has the discount factor)
    const otm = k >= 0
      ? bsPrice(true, S, K, T, r, q, sigma)
      : bsPrice(false, S, K, T, r, q, sigma);
    // measure: dK/K² = dk/K  (K = F·e^k ⇒ dK = K·dk)
    const wgt = (dk * (i === 0 || i === n ? 0.5 : 1)) / K;
    acc += wgt * otm;
  }
  // the strip of options costs PV: ∫Q/K²dK = e^{−rT}·E[I(S_T)] = e^{−rT}σ²T/2 for
  // a flat surface — so the strike charged against a payoff AT maturity carries
  // the e^{rT} compounding: K_var² = (2/T)·e^{rT}·strip. Flat σ ⇒ K_var = σ exactly.
  const kvar2 = ((2 / T) * Math.exp(r * T)) * acc;
  return Math.sqrt(Math.max(0, kvar2));
}

// ── Zeliade JW parameters — the trader's five numbers ───────────────────────

/** Jumping to the trader's view: v, ψ, p, c, ṽ (Zeliade 2009). */
export function jwParams(p: SviParam, T: number) {
  const w0 = sviW(0, p);
  const rt = Math.sqrt(w0);
  const pWing = p.b * (1 - p.rho);
  const cWing = p.b * (1 + p.rho);
  return {
    /** ATM implied variance (annualised) */
    v: w0 / T,
    /** ATM skew */
    psi: (p.b / (2 * rt)) * (p.rho - p.m / Math.sqrt(p.m * p.m + p.si * p.si)),
    /** put wing slope (normalised) */
    p: pWing / rt,
    /** call wing slope (normalised) */
    c: cWing / rt,
    /** minimum variance */
    vTilde: (p.a + p.b * p.si * Math.sqrt(Math.max(0, 1 - p.rho * p.rho))) / T,
  };
}

// ── delta-space quoting ─────────────────────────────────────────────────────

/**
 * The strike of a Δ-quoted option (25Δ etc.): solve N(d1)·e^{-qT} = ±Δ for K
 * under the slice's own smile — the desk's "wings are quoted in deltas".
 */
export function strikeForDelta(targetDelta: number, S: number, T: number, r: number, q: number, sigma: number): number {
  // d1 = Φ⁻¹(Δ·e^{qT}); K = S·exp(−[d1·σ√T − (r−q+σ²/2)·T]) from d1's definition
  const d1 = normInv(Math.min(0.9999, Math.max(0.0001, Math.abs(targetDelta)) * Math.exp(q * T)));
  const v = sigma * Math.sqrt(T);
  const lnK = Math.log(S) - d1 * v + (r - q + 0.5 * sigma * sigma) * T;
  return Math.exp(lnK);
}

/** 25Δ risk reversal and butterfly of a slice, in vol points. */
export function rrBf(p: SviParam, S: number, T: number, r: number, q: number): { rr: number; bf: number; atm: number } {
  const atmSigma = sviIV(0, T, p);
  const k25c = strikeForDelta(0.25, S, T, r, q, atmSigma * 1.15);
  const k25p = strikeForDelta(-0.25, S, T, r, q, atmSigma * 1.15);
  const kc = Math.log(k25c / (S * Math.exp((r - q) * T)));
  const kp = Math.log(k25p / (S * Math.exp((r - q) * T)));
  const s25c = sviIV(kc, T, p);
  const s25p = sviIV(kp, T, p);
  return { rr: s25c - s25p, bf: 0.5 * (s25c + s25p) - atmSigma, atm: atmSigma };
}

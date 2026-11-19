// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · bs — the Black–Scholes–Merton engine, complete to the last
// Greek. One module, everything derived from the same formula:
//
//   C = S e^{-qT} N(d1) − K e^{-rT} N(d2),   d1,2 = [ln(S/K) + (r − q ± σ²/2)T] / (σ√T)
//
//   Greeks:  Δ Γ Θ 𝒱 ρ  (first order) · vanna ∂Δ/∂σ · volga ∂𝒱/∂σ ·
//           charm ∂Δ/∂t · speed ∂Γ/∂S  (second order)
//           dollar Greeks: ½ΓS² (dollar gamma), στS²Γ (vega seen as gamma)
//
//   Also:  implied-vol inversion (robust bisection — "the one quote you
//          invert to read the market's σ"), put–call parity, the forward,
//          and the Bachelier (normal) model for the post-2020 negative-oil
//          world (CME switched to it in 2020; the course's Part 5 pointer).
// ─────────────────────────────────────────────────────────────────────────────

import { normCdf } from './normal';

export interface QuoteInputs {
  S: number;
  K: number;
  /** years to expiry */
  T: number;
  r: number;
  /** continuous dividend/borrow/funding yield */
  q: number;
  /** annualised log-normal volatility */
  sigma: number;
}

export function forward(S: number, T: number, r: number, q: number): number {
  return S * Math.exp((r - q) * T);
}

export function d1d2(S: number, K: number, T: number, r: number, q: number, sigma: number): { d1: number; d2: number } {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / v;
  return { d1, d2: d1 - v };
}

/** Black–Scholes–Merton price of a European call or put. */
export function bsPrice(call: boolean, S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0) return call ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (sigma <= 1e-12) {
    // deterministic limit: discounted intrinsic
    const fwd = forward(S, T, r, q);
    return call ? Math.exp(-r * T) * Math.max(fwd - K, 0) : Math.exp(-r * T) * Math.max(K - fwd, 0);
  }
  const { d1, d2 } = d1d2(S, K, T, r, q, sigma);
  if (call) return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
}

/** Put–call parity: C − P = S e^{-qT} − K e^{-rT}. */
export function parityGap(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  const c = bsPrice(true, S, K, T, r, q, sigma);
  const p = bsPrice(false, S, K, T, r, q, sigma);
  return c - p - (S * Math.exp(-q * T) - K * Math.exp(-r * T));
}

/** One synthetic from the other: P = C − S e^{-qT} + K e^{-rT} (a conversion's leg). */
export function syntheticPutFromCall(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  return bsPrice(true, S, K, T, r, q, sigma) - S * Math.exp(-q * T) + K * Math.exp(-r * T);
}

// ── Greeks ───────────────────────────────────────────────────────────────────

/** Δ — shares to hold per option (call: N(d1)·e^{-qT}, put: −N(−d1)·e^{-qT}). */
export function delta(call: boolean, S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 1e-12) return call ? (S > K ? 1 : 0) - (call ? 0 : S < K ? 1 : 0) : 0;
  const { d1 } = d1d2(S, K, T, r, q, sigma);
  const eq = Math.exp(-q * T);
  return call ? eq * normCdf(d1) : -eq * normCdf(-d1);
}

/** Γ = φ(d1) e^{-qT} / (S σ √T) — curvature; the same for call and put. */
export function gamma(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 1e-12 || S <= 0) return 0;
  const { d1 } = d1d2(S, K, T, r, q, sigma);
  return (Math.exp(-q * T) * Math.exp(-0.5 * d1 * d1)) / (S * sigma * Math.sqrt(2 * Math.PI * T));
}

/** 𝒱 per 1.00 of vol (multiply by 0.01 for a "vol point"). */
export function vega(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 1e-12) return 0;
  const { d1 } = d1d2(S, K, T, r, q, sigma);
  return S * Math.exp(-q * T) * Math.exp(-0.5 * d1 * d1) * Math.sqrt(T) / Math.sqrt(2 * Math.PI);
}

/** Θ per year (negative for long options; the daily bleed is /365). */
export function theta(call: boolean, S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 1e-12) return 0;
  const { d1, d2 } = d1d2(S, K, T, r, q, sigma);
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const common = -(S * sigma * pdf * Math.exp(-q * T)) / (2 * Math.sqrt(T));
  if (call) return common + q * S * Math.exp(-q * T) * normCdf(d1) - r * K * Math.exp(-r * T) * normCdf(d2);
  return common - q * S * Math.exp(-q * T) * normCdf(-d1) + r * K * Math.exp(-r * T) * normCdf(-d2);
}

/** ρ per 1.00 of rate. */
export function rho(call: boolean, S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0) return 0;
  const { d2 } = d1d2(S, K, T, r, q, sigma);
  if (call) return K * T * Math.exp(-r * T) * normCdf(d2);
  return -K * T * Math.exp(-r * T) * normCdf(-d2);
}

/** Vanna ∂Δ/∂σ = −φ(d1) d2 / σ · e^{-qT} — how delta shifts when vol moves. */
export function vanna(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 1e-12) return 0;
  const { d1, d2 } = d1d2(S, K, T, r, q, sigma);
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  return (-pdf * d2 * Math.exp(-q * T)) / sigma;
}

/** Volga ∂𝒱/∂σ = 𝒱 · d1 d2 / σ — the convexity of vega (why wings carry volga). */
export function volga(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 1e-12) return 0;
  const { d1, d2 } = d1d2(S, K, T, r, q, sigma);
  return vega(S, K, T, r, q, sigma) * ((d1 * d2) / sigma);
}

/** Charm ∂Δ/∂t (t = calendar time), i.e. −∂Δ/∂T — the delta your hedge loses overnight. */
export function charm(call: boolean, S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 1e-12) return 0;
  const eps = Math.min(1e-4, T * 0.01);
  const dT = Math.max(T - eps, 1e-6);
  return (delta(call, S, K, T, r, q, sigma) - delta(call, S, K, dT, r, q, sigma)) / (T - dT);
}

/** Speed ∂Γ/∂S — where the gamma ridge steepens (gamma of the gamma). */
export function speed(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 1e-12 || S <= 0) return 0;
  const h = S * 1e-4;
  return (gamma(S + h, K, T, r, q, sigma) - gamma(S - h, K, T, r, q, sigma)) / (2 * h);
}

/** Dollar gamma ½ Γ S² — the quantity the gamma scalper actually farms. */
export function dollarGamma(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  return 0.5 * gamma(S, K, T, r, q, sigma) * S * S;
}

/** The identity that reads a risk report: 𝒱 = σ τ S² Γ (one bump seen two ways). */
export function vegaAsGamma(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  return sigma * T * S * S * gamma(S, K, T, r, q, sigma);
}

/** The hedger's ledger identity at r=q=0: Θ = −½ σ² S² Γ (breakeven σ√dt). */
export function thetaFromGamma(S: number, K: number, T: number, sigma: number): number {
  return -0.5 * sigma * sigma * S * S * gamma(S, K, T, 0, 0, sigma);
}

// ── implied volatility (inversion) ──────────────────────────────────────────

/**
 * Implied σ from a market price — robust bracket + bisection (the lecture's
 * "one quote inverted": price in, the market's fear out). Returns null when the
 * price is outside the no-arbitrage band [intrinsic, upper bound].
 */
export function impliedVol(
  target: number,
  call: boolean,
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
): number | null {
  if (!(T > 0) || !Number.isFinite(target) || target < 0) return null;
  const fwd = forward(S, T, r, q);
  const intrinsic = call ? Math.max(0, fwd - K) * Math.exp(-r * T) : Math.max(0, K - fwd) * Math.exp(-r * T);
  const cap = call ? S * Math.exp(-q * T) : K * Math.exp(-r * T);
  if (target < intrinsic - 1e-9 || target > cap + 1e-9) return null;
  if (Math.abs(target - intrinsic) < 1e-10) return 0;

  let lo = 1e-6;
  let hi = 5;
  // bracket: expand hi until price(hi) ≥ target (σ=5 is already absurd)
  let ph = bsPrice(call, S, K, T, r, q, hi);
  while (ph < target && hi < 50) {
    hi *= 2;
    ph = bsPrice(call, S, K, T, r, q, hi);
  }
  if (bsPrice(call, S, K, T, r, q, lo) > target) return lo;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const p = bsPrice(call, S, K, T, r, q, mid);
    if (p < target) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return 0.5 * (lo + hi);
}

// ── Bachelier (normal) model — the negative-oil world ────────────────────────

/**
 * Bachelier price on the forward with NORMAL (not lognormal) noise.
 * CME switched oil options to Bachelier in 2020 when WTI went negative —
 * the lognormal world cannot price below zero.
 */
export function bachelierPrice(call: boolean, S: number, K: number, T: number, r: number, q: number, sigmaN: number): number {
  const fwd = forward(S, T, r, q);
  const d = (fwd - K) / (sigmaN * Math.sqrt(T));
  const phi = Math.exp(-0.5 * d * d) / Math.sqrt(2 * Math.PI);
  const df = Math.exp(-r * T);
  const forwardIntrinsic = call ? fwd - K : K - fwd;
  return df * (forwardIntrinsic * normCdf(d) + sigmaN * Math.sqrt(T) * phi);
}

/** Convenience bundle: every number the desk reads off one option. */
export function optionSnapshot(call: boolean, i: QuoteInputs) {
  const { S, K, T, r, q, sigma } = i;
  return {
    price: bsPrice(call, S, K, T, r, q, sigma),
    forward: forward(S, T, r, q),
    d1: d1d2(S, K, T, r, q, sigma).d1,
    d2: d1d2(S, K, T, r, q, sigma).d2,
    delta: delta(call, S, K, T, r, q, sigma),
    gamma: gamma(S, K, T, r, q, sigma),
    vega: vega(S, K, T, r, q, sigma),
    vegaPoint: vega(S, K, T, r, q, sigma) * 0.01,
    thetaDay: theta(call, S, K, T, r, q, sigma) / 365,
    rho: rho(call, S, K, T, r, q, sigma),
    vanna: vanna(S, K, T, r, q, sigma),
    volga: volga(S, K, T, r, q, sigma),
    charm: charm(call, S, K, T, r, q, sigma),
    speed: speed(S, K, T, r, q, sigma),
    dollarGamma: dollarGamma(S, K, T, r, q, sigma),
  };
}

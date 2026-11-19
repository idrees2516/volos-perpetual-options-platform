// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · stochastic — the stochastic-volatility wing of the lab.
//
//   • Heston (1993)  — semi-analytic European pricing through the stable
//                      "little Heston trap" characteristic function
//                      (Albrecher–Mayer–Schoutens–Tistaart), integrated with a
//                      fixed-grid Simpson rule: the smile engine that makes vol
//                      itself a mean-reverting random process.
//   • SABR (Hagan)   — the desk's smile-on-the-fly formula: lognormal SABR
//                      implied vol for β=1, plus a deterministic least-squares
//                      calibration to ATM/RR25/Fly25.
//   • Merton (1976)  — jump-diffusion pricing by the Poisson mixture series
//                      (conditionally lognormal), plus tail calibration from
//                      realized returns: the gap-risk engine.
// ─────────────────────────────────────────────────────────────────────────────

import { normCdf } from './normal';
import { bsPrice } from './bs';
import { strikeForDelta } from './volsurface';

// ── minimal complex arithmetic ([re, im]) ───────────────────────────────────

type C = [number, number];

const cMul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cDiv = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1] || 1e-300;
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cExp = (z: C): C => {
  const m = Math.exp(z[0]);
  return [m * Math.cos(z[1]), m * Math.sin(z[1])];
};

// ── Heston ──────────────────────────────────────────────────────────────────

export interface HestonParams {
  /** spot variance v₀ (decimal², e.g. 0.04 ⇒ 20% vol) */
  v0: number;
  /** mean-reversion speed κ */
  kappa: number;
  /** long-run variance θ */
  theta: number;
  /** vol-of-vol ξ */
  xi: number;
  /** spot/vol correlation ρ ∈ (−1, 1) */
  rho: number;
}

/**
 * The Heston characteristic function of ln S_T at a (possibly complex)
 * argument — the "little Heston trap" formulation, numerically stable for
 * all ρ·ξ combinations:
 *   φ(u) = e^{C(u) + D(u)·v₀ + iu(ln S + (r−q)T)}
 *   d    = √((ρξ·iu − κ)² + ξ²(u² + iu))
 *   g    = (κ − ρξiu − d)/(κ − ρξiu + d)
 *   C    = (κθ/ξ²)[(κ − ρξiu − d)T − 2·ln((1 − ge^{−dT})/(1 − g))]
 *   D    = (κ − ρξiu − d)(1 − e^{−dT}) / (ξ²(1 − ge^{−dT}))
 */
export function hestonPhi(u: C, T: number, S: number, r: number, q: number, p: HestonParams): C {
  const uRe = u[0];
  const uIm = u[1];
  // iu = i(uRe + i·uIm) = −uIm + i·uRe
  const iuRe = -uIm;
  const iuIm = uRe;
  // a = ρξ·iu − κ ; b = ξ²(u² + iu)
  const aRe = p.rho * p.xi * iuRe - p.kappa;
  const aIm = p.rho * p.xi * iuIm;
  const u2Re = uRe * uRe - uIm * uIm;
  const u2Im = 2 * uRe * uIm;
  const bRe = p.xi * p.xi * (u2Re + iuRe);
  const bIm = p.xi * p.xi * (u2Im + iuIm);
  // d = √(a² + b)
  const dRe0 = aRe * aRe - aIm * aIm + bRe;
  const dIm0 = 2 * aRe * aIm + bIm;
  const dR = Math.hypot(dRe0, dIm0);
  let dRe: number;
  let dIm: number;
  if (dR === 0) {
    dRe = 0;
    dIm = 0;
  } else {
    const w = Math.sqrt(dR);
    dRe = w;
    dIm = dRe0 >= 0 ? dIm0 / (2 * w) : -dIm0 / (2 * w);
  }
  // κ − ρξiu
  const kRe = p.kappa - p.rho * p.xi * iuRe;
  const kIm = -p.rho * p.xi * iuIm;
  // num = κ − ρξiu − d ; den = κ − ρξiu + d
  const numRe = kRe - dRe;
  const numIm = kIm - dIm;
  const denRe = kRe + dRe;
  const denIm = kIm + dIm;
  // g = num/den
  const gD = denRe * denRe + denIm * denIm || 1e-300;
  const gRe = (numRe * denRe + numIm * denIm) / gD;
  const gIm = (numIm * denRe - numRe * denIm) / gD;
  // e^{−dT}
  const eDT = cExp([-dRe * T, -dIm * T]);
  // g·e^{−dT}
  const gExpRe = gRe * eDT[0] - gIm * eDT[1];
  const gExpIm = gRe * eDT[1] + gIm * eDT[0];
  // ratio = (1 − g e^{−dT})/(1 − g)
  const num2Re = 1 - gExpRe;
  const num2Im = -gExpIm;
  const den2Re = 1 - gRe;
  const den2Im = -gIm;
  const rD = den2Re * den2Re + den2Im * den2Im || 1e-300;
  const ratioRe = (num2Re * den2Re + num2Im * den2Im) / rD;
  const ratioIm = (num2Im * den2Re - num2Re * den2Im) / rD;
  const lnR = Math.log(Math.max(1e-300, Math.hypot(ratioRe, ratioIm)));
  const lnI = Math.atan2(ratioIm, ratioRe);
  // bracket = num·T − 2·ln(ratio)
  const brRe = numRe * T - 2 * lnR;
  const brIm = numIm * T - 2 * lnI;
  const kThetaOverXi2 = (p.kappa * p.theta) / (p.xi * p.xi);
  const CRe = kThetaOverXi2 * brRe;
  const CIm = kThetaOverXi2 * brIm;
  // D = (num/ξ²)·(1 − e^{−dT})/(1 − g·e^{−dT})   [no (1−g) — the trap form]
  const dDenRe = p.xi * p.xi * (1 - gExpRe);
  const dDenIm = p.xi * p.xi * (0 - gExpIm);
  const dD = dDenRe * dDenRe + dDenIm * dDenIm || 1e-300;
  const dNumRe = numRe * (1 - eDT[0]) - numIm * (0 - eDT[1]);
  const dNumIm = numRe * (0 - eDT[1]) + numIm * (1 - eDT[0]);
  const DRe = (dNumRe * dDenRe + dNumIm * dDenIm) / dD;
  const DIm = (dNumIm * dDenRe - dNumRe * dDenIm) / dD;
  // φ = exp(C + D·v₀ + iu·(ln S + (r−q)T))
  const phaseRe = -uIm * (Math.log(S) + (r - q) * T);
  const phaseIm = uRe * (Math.log(S) + (r - q) * T);
  const eRe = CRe + DRe * p.v0 + phaseRe;
  const eIm = CIm + DIm * p.v0 + phaseIm;
  const m = Math.exp(eRe);
  return [m * Math.cos(eIm), m * Math.sin(eIm)];
}

/** φ₁(u) = φ(u − i)/φ(−i) — the CF under the stock-numeraire measure. */
function hestonPhi1(u: number, T: number, S: number, r: number, q: number, p: HestonParams): C {
  const phiUmi = hestonPhi([u, -1], T, S, r, q, p);
  const phiMinusI = hestonPhi([0, -1], T, S, r, q, p);
  return cDiv(phiUmi, phiMinusI);
}

/**
 * Heston European price. C = S e^{−qT} P₁ − K e^{−rT} P₂ with the Gil-Pelaez
 * probabilities integrated by a fixed-grid Simpson rule (u ∈ [0, 256], 1024
 * intervals — the trap CF decays long before the cap).
 */
export function hestonPrice(
  call: boolean,
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  p: HestonParams,
): { price: number; nPoints: number } {
  if (T <= 0 || S <= 0 || K <= 0) return { price: call ? Math.max(S - K, 0) : Math.max(K - S, 0), nPoints: 0 };
  const lnK = Math.log(K);
  const N = 1024;
  const h = 256 / N;
  /** integrand_j(u) = Re[e^{−iu lnK} φ_j(u)/(iu)] */
  const integrand = (u: number, phi: C): number => {
    if (u <= 0) {
      // u→0 limit: Re[e^{−iu lnK} φ(u)/(iu)] → Im[φ'(0)]·... — evaluate tiny u
      const tiny = 1e-8;
      const e: C = [Math.cos(-tiny * lnK), Math.sin(-tiny * lnK)];
      const over = cDiv(cMul(e, phi), [0, tiny]);
      return over[0];
    }
    const e: C = [Math.cos(-u * lnK), Math.sin(-u * lnK)];
    const over = cDiv(cMul(e, phi), [0, u]);
    return over[0];
  };
  const prob = (shifted: boolean): number => {
    const phiAt = (u: number): C => (shifted ? hestonPhi1(u, T, S, r, q, p) : hestonPhi([u, 0], T, S, r, q, p));
    let sum = integrand(0, phiAt(1e-8));
    for (let i = 1; i < N; i++) {
      const u = i * h;
      const val = integrand(u, phiAt(u));
      sum += i % 2 === 0 ? 2 * val : 4 * val;
    }
    sum += integrand(256, phiAt(256));
    return 0.5 + (sum * h) / (3 * Math.PI);
  };
  const P1 = prob(true);
  const P2 = prob(false);
  const c = S * Math.exp(-q * T) * P1 - K * Math.exp(-r * T) * P2;
  return { price: call ? c : c - S * Math.exp(-q * T) + K * Math.exp(-r * T), nPoints: N };
}

/** Heston smile: price + implied-vol-by-strike grid repriced from the model. */
export function hestonSmile(
  S: number,
  T: number,
  r: number,
  q: number,
  p: HestonParams,
  moneyness: number[],
): { k: number; price: number; iv: number }[] {
  return moneyness.map((m) => {
    const K = S * m;
    const { price } = hestonPrice(true, S, K, T, r, q, p);
    const iv = ivFromPrice(price, true, S, K, T, r, q);
    return { k: m, price, iv };
  });
}

/** Bisection implied-vol recovery off the shared BS kernel. */
function ivFromPrice(target: number, call: boolean, S: number, K: number, T: number, r: number, q: number): number {
  let lo = 1e-4;
  let hi = 5;
  const f = (v: number): number => bsPrice(call, S, K, T, r, q, v) - target;
  if (f(lo) > 0 || f(hi) < 0) return NaN;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// ── SABR (β = 1, lognormal) ─────────────────────────────────────────────────

export interface SabrParams {
  /** α — the ATM vol backbone */
  alpha: number;
  /** ρ — spot/vol correlation (the skew) */
  rho: number;
  /** ν — vol-of-vol (the smile curvature) */
  nu: number;
}

/** Hagan's lognormal SABR implied vol for β = 1. */
export function sabrImpliedVol(F: number, K: number, T: number, p: SabrParams): number {
  const z = (p.nu / Math.max(1e-9, p.alpha)) * Math.log(F / K);
  const x = (zz: number): number =>
    Math.log((Math.sqrt(Math.max(0, 1 - 2 * p.rho * zz + zz * zz)) + zz - p.rho) / (1 - p.rho));
  const corr = 1 + T * (((2 - 3 * p.rho * p.rho) / 24) * p.nu * p.nu + (p.rho * p.nu * p.alpha) / 4);
  if (Math.abs(z) < 1e-6) return p.alpha * corr;
  return p.alpha * (z / x(z)) * corr;
}

/** SABR ATM vol (the K → F limit). */
export function sabrAtmVol(p: SabrParams, T: number): number {
  return p.alpha * (1 + T * (((2 - 3 * p.rho * p.rho) / 24) * p.nu * p.nu + (p.rho * p.nu * p.alpha) / 4));
}

/**
 * Deterministic least-squares SABR calibration to (ATM vol, 25Δ risk reversal,
 * 25Δ butterfly) — a 21×25 grid over (ρ, ν) plus a local refinement pass,
 * with α solved from the ATM condition in each cell (2 fixed-point passes).
 * Returns best (α, ρ, ν) plus the fit residuals.
 */
export function calibrateSabr(
  F: number,
  T: number,
  atmVol: number,
  rr25: number,
  fly25: number,
): { params: SabrParams; resid: { atm: number; rr: number; fly: number } } {
  const cellFor = (rho: number, nu: number): { err: number; params: SabrParams; resid: { atm: number; rr: number; fly: number } } | null => {
    // α from the ATM condition
    let alpha = atmVol;
    for (let it = 0; it < 3; it++) {
      const atm = sabrAtmVol({ alpha, rho, nu }, T);
      if (!(atm > 0)) break;
      alpha *= atmVol / atm;
    }
    const p: SabrParams = { alpha: Math.max(1e-4, alpha), rho, nu };
    // 25Δ strikes via the BS delta inversion at the ATM vol
    const kCall = strikeForDelta(0.25, F, T, 0, 0, atmVol);
    const kPut = strikeForDelta(-0.25, F, T, 0, 0, atmVol);
    const vc = sabrImpliedVol(F, kCall, T, p);
    const vp = sabrImpliedVol(F, kPut, T, p);
    const atm = sabrAtmVol(p, T);
    const rr = vc - vp;
    const fly = (vc + vp) / 2 - atm;
    const err = (rr - rr25) ** 2 + (fly - fly25) ** 2;
    if (!Number.isFinite(err)) return null;
    return { err, params: p, resid: { atm: atm - atmVol, rr: rr - rr25, fly: fly - fly25 } };
  };
  let best: SabrParams = { alpha: atmVol, rho: 0, nu: 0.3 };
  let bestErr = Infinity;
  let bestResid = { atm: 0, rr: 0, fly: 0 };
  for (let ri = 0; ri <= 20; ri++) {
    const rho = -0.95 + (ri / 20) * 1.9;
    for (let ni = 0; ni <= 24; ni++) {
      const nu = 0.05 + (ni / 24) * 2.95;
      const e = cellFor(rho, nu);
      if (e && e.err < bestErr) {
        bestErr = e.err;
        best = e.params;
        bestResid = e.resid;
      }
    }
  }
  // local refinement around the best cell
  const dr = 1.9 / 20 / 2;
  const dn = 2.95 / 24 / 2;
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      const e = cellFor(best.rho + i * dr, best.nu + j * dn);
      if (e && e.err < bestErr) {
        bestErr = e.err;
        best = e.params;
        bestResid = e.resid;
      }
    }
  }
  return { params: best, resid: bestResid };
}

// ── Merton jump-diffusion ────────────────────────────────────────────────────

export interface MertonParams {
  /** jump intensity λ (per year) */
  lambda: number;
  /** mean log-jump μ_J */
  muJ: number;
  /** jump-size stdev σ_J */
  sigmaJ: number;
}

/** E[e^J] − 1, the compensator's m. */
export function mertonM(p: MertonParams): number {
  return Math.exp(p.muJ + (p.sigmaJ * p.sigmaJ) / 2) - 1;
}

/**
 * Merton (1976) European price — the Poisson-weighted mixture of conditional
 * (lognormal) payoffs over the number of jumps, truncated where the Poisson
 * mass dies. Conditional on n jumps:
 *   ln S_T ~ N(ln S + (r−q−σ²/2−λm)T + nμ_J, σ²T + nσ_J²)
 */
export function mertonJumpPrice(
  call: boolean,
  S: number,
  K: number,
  T: number,
  r: number,
  q: number,
  sigma: number,
  p: MertonParams,
  nMax = 80,
): { price: number; terms: number } {
  if (p.lambda <= 0 || p.sigmaJ <= 0) {
    return { price: bsPrice(call, S, K, T, r, q, sigma), terms: 1 };
  }
  const m = mertonM(p);
  const lamT = p.lambda * T;
  const disc = Math.exp(-r * T);
  let w = Math.exp(-lamT);
  let price = 0;
  let terms = 0;
  for (let n = 0; n <= nMax; n++) {
    if (w > 1e-13) {
      const sN = Math.sqrt(Math.max(1e-12, sigma * sigma * T + n * p.sigmaJ * p.sigmaJ));
      const muLn = Math.log(S) + (r - q - (sigma * sigma) / 2 - p.lambda * m) * T + n * p.muJ;
      const d2 = (muLn - Math.log(K)) / sN;
      // E[S_T 1_{S_T>K} | n] = e^{μLn + s²/2}·N(d2 + s)
      const expMean = Math.exp(muLn + (sN * sN) / 2);
      price += w * disc * (expMean * normCdf(d2 + sN) - K * normCdf(d2));
      terms = n + 1;
    }
    w *= lamT / (n + 1);
  }
  if (!call) price = price - S * Math.exp(-q * T) + K * Math.exp(-r * T);
  return { price, terms };
}

/**
 * Tail calibration of the jump leg from realized per-bar returns: λ̂ = share of
 * |z| > 4σ moves (converted to per-year, capped at 60/yr — crypto 3σ
 * exceedances are routine and an uncapped λ would scream), μ_J/σ_J from the
 * tail observations.
 */
export function calibrateMerton(
  returns: number[],
  opts: { barsPerYear: number },
): { params: MertonParams; tailCount: number; tailShare: number } {
  const n = returns.length;
  if (n < 20) return { params: { lambda: 0, muJ: 0, sigmaJ: 0 }, tailCount: 0, tailShare: 0 };
  const mu = returns.reduce((a, b) => a + b, 0) / n;
  const sd =
    Math.sqrt(returns.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, n - 1)) || 1e-6;
  const threshold = 4 * sd;
  const tails: number[] = [];
  for (const r of returns) if (Math.abs(r - mu) > threshold) tails.push(r - mu);
  const tailShare = tails.length / n;
  const lambda = Math.min(60, tailShare * opts.barsPerYear);
  let muJ = 0;
  let sigmaJ = 0;
  if (tails.length >= 2) {
    muJ = tails.reduce((a, b) => a + b, 0) / tails.length;
    sigmaJ = Math.sqrt(tails.reduce((a, b) => a + (b - muJ) ** 2, 0) / Math.max(1, tails.length - 1));
  } else if (tails.length === 1) {
    muJ = tails[0];
    sigmaJ = Math.abs(tails[0]) / 2;
  }
  return { params: { lambda, muJ, sigmaJ }, tailCount: tails.length, tailShare };
}

/** Jump-tail mass beyond ±kσ under the calibrated mixture (vs Gaussian). */
export function jumpTailMass(p: MertonParams, sigma: number, T: number, k = 3): { merton: number; gaussian: number } {
  const gaussian = 2 * (1 - normCdf(k));
  const lamT = p.lambda * T;
  let w = Math.exp(-lamT);
  let merton = 0;
  for (let n = 0; n <= 60; n++) {
    const s = Math.sqrt(Math.max(1e-12, sigma * sigma * T + n * p.sigmaJ * p.sigmaJ));
    merton += w * 2 * (1 - normCdf((k * sigma * Math.sqrt(T)) / s));
    w *= lamT / (n + 1);
  }
  return { merton, gaussian };
}

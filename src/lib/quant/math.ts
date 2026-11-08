// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · math — Black-76 pricing/greeks + numeric helpers.
//
// Our own implementation (no external quant library): everything the engine
// computes for the Deribit chain — greeks per contract, vanna/charm via
// central finite differences, implied-move & PDF numerics.
// ─────────────────────────────────────────────────────────────────────────────

/** Normal probability density function. */
export function npdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Normal CDF via Abramowitz–Stegun 7.1.26 (|err| < 7.5e-8). */
export function ncdf(x: number): number {
  // Zelen & Severo coefficients
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/** Safe log. */
const lnsafe = (x: number) => (x > 0 ? Math.log(x) : NaN);

export interface B76Greeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number; // per 1.00 change in vol
  theta: number; // per year (r=0 convention)
  vanna: number; // d(vega)/dF
  charm: number; // d(delta)/dT per year
}

/**
 * Black-76 call price with r=0 (crypto discounting convention — Deribit
 * margined options in underlying; forward F per expiry from the venue's own
 * futures/underlying index).
 */
export function b76Call(F: number, K: number, T: number, sigma: number): number {
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return Math.max(F - K, 0);
  const s = sigma * Math.sqrt(T);
  const d1 = (lnsafe(F / K) + 0.5 * s * s) / s;
  const d2 = d1 - s;
  return F * ncdf(d1) - K * ncdf(d2);
}

export function b76Put(F: number, K: number, T: number, sigma: number): number {
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return Math.max(K - F, 0);
  const s = sigma * Math.sqrt(T);
  const d1 = (lnsafe(F / K) + 0.5 * s * s) / s;
  const d2 = d1 - s;
  return K * ncdf(-d2) - F * ncdf(-d1);
}

/** Full Black-76 greek set for a call or put (vega/theta identical by type). */
export function b76Greeks(F: number, K: number, T: number, sigma: number, isCall: boolean): B76Greeks {
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) {
    return { price: isCall ? Math.max(F - K, 0) : Math.max(K - F, 0), delta: isCall ? (F > K ? 1 : 0) : F < K ? -1 : 0, gamma: 0, vega: 0, theta: 0, vanna: 0, charm: 0 };
  }
  const s = sigma * Math.sqrt(T);
  const d1 = (lnsafe(F / K) + 0.5 * s * s) / s;
  const d2 = d1 - s;
  const nd1 = ncdf(d1);
  const pd1 = npdf(d1);
  const price = isCall ? F * nd1 - K * ncdf(d2) : K * ncdf(-d2) - F * ncdf(-d1);
  const delta = isCall ? nd1 : nd1 - 1;
  const gamma = pd1 / (F * s);
  const vega = F * pd1 * Math.sqrt(T);
  const theta = -(F * pd1 * sigma) / (2 * Math.sqrt(T)); // per year, r=0
  // vanna & charm via central finite differences (robust, venue-independent)
  const hF = F * 0.005;
  const vegaF = (f: number) => {
    const sf = sigma * Math.sqrt(T);
    return f * npdf((lnsafe(f / K) + 0.5 * sf * sf) / sf) * Math.sqrt(T);
  };
  const vanna = (vegaF(F + hF) - vegaF(F - hF)) / (2 * hF);
  const hT = Math.min(T * 0.05, 1 / 365);
  const deltaT = (t: number) => {
    const st = sigma * Math.sqrt(t);
    const dd1 = (lnsafe(F / K) + 0.5 * st * st) / st;
    return isCall ? ncdf(dd1) : ncdf(dd1) - 1;
  };
  const charm = hT > 0 ? (deltaT(T - hT) - deltaT(T + hT)) / (2 * hT) : 0;
  return { price, delta, gamma, vega, theta, vanna, charm };
}

/** Linear interpolation over sorted xy points (clamped). */
export function interp(xs: number[], ys: number[], x: number): number {
  if (!xs.length) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0,
    hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] > x) hi = mid;
    else lo = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** Smooth an array with a centered 3-point moving average (k passes). */
export function smooth3(arr: number[], passes = 1): number[] {
  let a = arr.slice();
  for (let p = 0; p < passes; p++) {
    const b = a.slice();
    for (let i = 1; i < a.length - 1; i++) b[i] = (a[i - 1] + 2 * a[i] + a[i + 1]) / 4;
    a = b;
  }
  return a;
}

/** Annualized realized volatility from close prices (std of log returns). */
export function realizedVol(closes: number[], perYear = 365): number {
  if (closes.length < 3) return NaN;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const r = lnsafe(closes[i] / closes[i - 1]);
    if (Number.isFinite(r)) rets.push(r);
  }
  const n = rets.length;
  if (!n) return NaN;
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const varr = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / Math.max(1, n - 1);
  return Math.sqrt(varr * perYear);
}

export const fmtUsd = (v: number) => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0));

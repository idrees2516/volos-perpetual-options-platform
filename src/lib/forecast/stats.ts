// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — statistics helpers
//
// Quantiles use the linear-interpolation scheme (numpy / pandas default,
// "type 7") so calibration numbers match the reference implementation's
// semantics: sorted copy + piecewise-linear inverse CDF.
// ─────────────────────────────────────────────────────────────────────────────

/** Mean of a numeric array (0 for empty). */
export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population variance (0 for empty / degenerate). */
export function variance(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / n;
}

export function std(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

/**
 * Quantile of an UNSORTED array with linear interpolation
 * (numpy default, R type 7). `q` in [0, 1].
 */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  if (xs.length === 1) return xs[0];
  const sorted = xs.slice().sort((a, b) => a - b);
  return quantileSorted(sorted, q);
}

/** Quantile of an ascending-sorted array (linear interpolation, type 7). */
export function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, q));
  const pos = clamped * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

/**
 * Empirical CDF: share of samples ≤ x (used for coverage sanity and
 * calibration diagnostics).
 */
export function ecdfAt(xs: number[], x: number): number {
  if (!xs.length) return 0;
  let c = 0;
  for (const v of xs) if (v <= x) c++;
  return c / xs.length;
}

/** Pinball (quantile) loss for one observation at quantile q. */
export function pinballLoss(y: number, yhat: number, q: number): number {
  const e = y - yhat;
  return e >= 0 ? 2 * q * e : -2 * (1 - q) * e;
}

/**
 * Standard normal quantile (Acklam's rational approximation), used by native
 * residual intervals between the fixed knots.
 */
export function normQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** In-sample seasonal naive MAE — the MASE / scaled-CRPS denominator. */
export function seasonalNaiveMae(y: number[], seasonLength: number): number {
  const m = Math.max(1, Math.min(seasonLength, Math.floor(y.length / 2)));
  let s = 0;
  let n = 0;
  for (let i = m; i < y.length; i++) {
    s += Math.abs(y[i] - y[i - m]);
    n++;
  }
  return n > 0 ? s / n : 0;
}

/**
 * Detect the dominant season length of a series via autocorrelation of the
 * differenced series. Capped so calibration stays affordable; falls back to 1
 * (no seasonality) when nothing clears the threshold.
 */
export function detectSeasonLength(y: number[], maxLag = 64): number {
  const n = y.length;
  if (n < 16) return 1;
  const max = Math.min(maxLag, Math.floor(n / 3));
  if (max < 2) return 1;
  // detrend with a first difference so random walks don't alias every lag
  const d: number[] = new Array(n - 1);
  for (let i = 1; i < n; i++) d[i - 1] = y[i] - y[i - 1];
  const dm = mean(d);
  let dv = 0;
  for (const v of d) dv += (v - dm) * (v - dm);
  dv /= d.length;
  if (dv <= 0) return 1;
  let bestLag = 1;
  let bestR = 0.22; // threshold — must clear to count
  for (let lag = 2; lag <= max; lag++) {
    let s = 0;
    const nd = d.length - lag;
    for (let i = 0; i < nd; i++) s += (d[i] - dm) * (d[i + lag] - dm);
    const r = s / (nd * dv);
    if (r > bestR) {
      bestR = r;
      bestLag = lag;
    }
  }
  return bestLag;
}

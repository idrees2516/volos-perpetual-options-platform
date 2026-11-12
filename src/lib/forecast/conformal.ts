// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — ConformalIntervals
//
// Faithful TypeScript port of foundationforecast's ConformalIntervals
// (TimeCopilot), the engine behind the conformal-prediction example:
//
//   Calibration is a panel cross-validation of the POINT forecast. Let T be
//   the last observed timestamp, h the horizon, W = n_windows and Δ =
//   step_size (defaults to h → non-overlapping windows).
//
//   1. Backtest the point forecast: for each window w = 1..W the model
//      forecasts h steps from the cutoff t_w = T − h − (W−w)·Δ using only
//      data up to t_w, keeping the absolute error at every horizon step
//      j = 1..h:  e_{w,j} = |y_{t_w+j} − ŷ_{t_w+j|t_w}|
//
//   2. Forecast: the point forecast ŷ_{T+j} from the full history, unchanged.
//
//   3. Build the interval for level L (α = 1 − L/100):
//        conformal_distribution (default):
//            S_j = {ŷ_{T+j} − e_{w,j}} ∪ {ŷ_{T+j} + e_{w,j}}   (2W outcomes)
//            interval = [Q_{α/2}(S_j), Q_{1−α/2}(S_j)]
//        conformal_error:
//            q̂_j = Q_{1−α}(e_{1,j}, …, e_{W,j})
//            interval = [ŷ_{T+j} − q̂_j, ŷ_{T+j} + q̂_j]
//
//   Each series and horizon step gets its own width, and wider levels reach
//   into the error distribution instead of stopping at a fixed knot.
//
//   Requirement: ≥ h + (W−1)·Δ + 1 observations (auto-shrink reports the
//   largest usable W when history is short, minimum 2 per the reference).
// ─────────────────────────────────────────────────────────────────────────────

import { quantile, quantileSorted, normQuantile } from './stats';
import type { FcLevelInterval } from './types';
import type { FcModelContext, FcPointModelFn } from './models';

export interface ConformalCalibration {
  /** errors e[w][j] (w = 0..W−1 ascending in time, j = 0..h−1) */
  errors: number[][];
  /** mean |error| per horizon step */
  errorByStep: number[];
  /** windows actually used (may be < requested after auto-shrink) */
  nWindows: number;
  /** effective step size (defaults to h) */
  stepSize: number;
  /** observations the requested configuration requires */
  required: number;
  /** observations available at calibration time */
  available: number;
  /** calibration succeeded */
  ok: boolean;
}

export class ConformalIntervals {
  constructor(
    /** rolling backtest windows for residual estimation (minimum 2) */
    public nWindows = 10,
    /** 'conformal_distribution' | 'conformal_error' */
    public method: 'conformal_distribution' | 'conformal_error' = 'conformal_distribution',
    /** gap between calibration cutoffs; null → h (non-overlapping windows) */
    public stepSize: number | null = null,
  ) {
    if (this.nWindows < 2) this.nWindows = 2;
  }

  /**
   * Largest n_windows ≤ requested that satisfies the observation requirement
   * for (n, h, Δ): n ≥ h + (W−1)·Δ + 1. Returns 0 when even W = 2 fails.
   */
  static fitWindows(n: number, h: number, stepSize: number, requested: number): number {
    const w = Math.max(2, Math.min(requested, 64));
    if (n >= h + (w - 1) * stepSize + 1) return w;
    const maxW = Math.floor((n - 1 - h) / stepSize) + 1;
    return maxW >= 2 ? maxW : 0;
  }

  /**
   * Calibrate on the history ENDING at the forecast origin (inclusive): the
   * calibration windows tile [T−h−(W−1)·Δ, T]. Calling this with the data
   * before any CV cutoff is exactly the reference's "recalibrate at every
   * cutoff" behaviour.
   */
  calibrate(
    ctx: FcModelContext,
    model: FcPointModelFn,
    h: number,
    opts: { autoShrink?: boolean } = {},
  ): ConformalCalibration {
    const y = ctx.y;
    const n = y.length;
    const stepSize = this.stepSize ?? h;
    const requested = this.nWindows;
    const required = h + (requested - 1) * stepSize + 1;
    let W = requested;
    if (n < required) {
      if (opts.autoShrink === false) {
        return { errors: [], errorByStep: [], nWindows: requested, stepSize, required, available: n, ok: false };
      }
      W = ConformalIntervals.fitWindows(n, h, stepSize, requested);
      if (W < 2) {
        return { errors: [], errorByStep: [], nWindows: requested, stepSize, required, available: n, ok: false };
      }
    }
    const errors: number[][] = [];
    for (let w = 1; w <= W; w++) {
      // cutoff index (inclusive): T − h − (W−w)·Δ   with T = n−1
      const cutoff = n - 1 - h - (W - w) * stepSize;
      if (cutoff < 4 || cutoff + h >= n + 0) {
        // guard: window must fit strictly inside the history
        continue;
      }
      const history = y.slice(0, cutoff + 1);
      const historyCtx: FcModelContext = {
        y: history,
        h,
        seasonLength: ctx.seasonLength,
        features: ctx.features ? ctx.features.map((f) => f.subarray(0, cutoff + 1)) : undefined,
      };
      const { forecast } = model(historyCtx);
      const row: number[] = [];
      for (let j = 0; j < h; j++) {
        const actual = y[cutoff + 1 + j];
        row.push(Number.isFinite(actual) ? Math.abs(actual - forecast[j]) : NaN);
      }
      errors.push(row);
    }
    if (errors.length < 2) {
      return { errors, errorByStep: [], nWindows: W, stepSize, required, available: n, ok: false };
    }
    const errorByStep: number[] = [];
    for (let j = 0; j < h; j++) {
      let s = 0;
      let c = 0;
      for (const row of errors) {
        if (Number.isFinite(row[j])) {
          s += row[j];
          c++;
        }
      }
      errorByStep.push(c > 0 ? s / c : NaN);
    }
    return { errors, errorByStep, nWindows: W, stepSize, required, available: n, ok: true };
  }

  /**
   * Turn calibration errors into per-step, per-level intervals around the
   * point forecast (formulas from the reference, see header).
   */
  intervals(
    point: number[],
    calibration: ConformalCalibration,
    levels: number[],
    bounds?: { lo?: number; hi?: number },
  ): FcLevelInterval[][] {
    const h = point.length;
    const W = calibration.errors.length;
    const out: FcLevelInterval[][] = [];
    if (!calibration.ok || W < 2) {
      for (let j = 0; j < h; j++) out.push(levels.map((level) => ({ level, lo: NaN, hi: NaN })));
      return out;
    }
    for (let j = 0; j < h; j++) {
      const eAt: number[] = [];
      for (const row of calibration.errors) {
        if (Number.isFinite(row[j])) eAt.push(row[j]);
      }
      const stepLevels: FcLevelInterval[] = [];
      for (const level of levels) {
        const alpha = 1 - level / 100;
        let lo: number;
        let hi: number;
        if (this.method === 'conformal_error') {
          // q̂_j = Quantile_{1−α}(e_{1,j}, …, e_{W,j}); symmetric around point
          const q = quantile(eAt, 1 - alpha);
          lo = point[j] - q;
          hi = point[j] + q;
        } else {
          // conformal_distribution: 2W synthetic outcomes, symmetric quantiles
          const s: number[] = [];
          for (const e of eAt) {
            s.push(point[j] - e, point[j] + e);
          }
          s.sort((a, b) => a - b);
          lo = quantileSorted(s, alpha / 2);
          hi = quantileSorted(s, 1 - alpha / 2);
        }
        if (bounds) {
          if (bounds.lo !== undefined && Number.isFinite(bounds.lo)) lo = Math.max(lo, bounds.lo);
          if (bounds.hi !== undefined && Number.isFinite(bounds.hi)) hi = Math.min(hi, bounds.hi);
          if (hi < lo) {
            // degenerate after clamping (e.g. share pinned to [0,1] edges)
            const mid = (lo + hi) / 2;
            lo = mid;
            hi = mid;
          }
        }
        stepLevels.push({ level, lo, hi });
      }
      out.push(stepLevels);
    }
    return out;
  }
}

/**
 * Native fixed-knot intervals, mirroring foundation models whose quantile
 * heads stop at the 0.1 / 0.9 knots (Tafsut, Chronos-Bolt): any level wider
 * than 80% is CLAMPED to the 80% band — the exact behaviour the conformal
 * example exists to fix. Width scales with √step (random-walk diffusion).
 */
export function nativeKnotIntervals(
  point: number[],
  residuals: number[],
  levels: number[],
  bounds?: { lo?: number; hi?: number },
): FcLevelInterval[][] {
  const h = point.length;
  const sigma1 = residuals.length >= 8 ? Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / residuals.length) : NaN;
  const out: FcLevelInterval[][] = [];
  const z80 = 1.2815515655446004; // Φ⁻¹(0.9)
  for (let j = 0; j < h; j++) {
    const sigmaJ = sigma1 * Math.sqrt(j + 1);
    const stepLevels: FcLevelInterval[] = [];
    for (const level of levels) {
      // knot interpolation with the 0.9-knot clamp (levels > 80 stay at 80)
      const knotCoverage = 0.5 + Math.min(level, 80) / 200;
      const z = normQuantile(knotCoverage);
      let lo = point[j] - z * sigmaJ;
      let hi = point[j] + z * sigmaJ;
      if (bounds) {
        if (bounds.lo !== undefined && Number.isFinite(bounds.lo)) lo = Math.max(lo, bounds.lo);
        if (bounds.hi !== undefined && Number.isFinite(bounds.hi)) hi = Math.min(hi, bounds.hi);
        if (hi < lo) {
          const mid = (lo + hi) / 2;
          lo = mid;
          hi = mid;
        }
      }
      stepLevels.push({ level, lo, hi });
    }
    out.push(stepLevels);
  }
  return out;
}

/** Standard-normal quantile (cached Acklam approximation). */
function phiInverse(p: number): number {
  return normQuantileImpl(p);
}

let normCache = new Map<number, number>();
function normQuantileImpl(p: number): number {
  const key = Math.round(p * 100000) / 100000;
  let v = normCache.get(key);
  if (v === undefined) {
    v = acklam(key);
    normCache.set(key, v);
  }
  return v;
}

function acklam(p: number): number {
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

// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — point-forecast models (the "foundation models" of our stack)
//
// Every model is a pure function of the flow-bar history: (y, h, seasonality,
// exogenous flow features) → h point forecasts + one-step in-sample fitted
// values (used for native residual intervals and MASE-style diagnostics).
//
// Models:
//   naive           random walk — ŷ_{T+j} = y_T
//   seasonal_naive  ŷ_{T+j} = y_{T+j−m·k}
//   drift           random walk with drift — RW + j·(y_T−y_1)/(T−1)
//   theta           classic Theta: 0.5·(Θ₀ linear extrapolation + SES on Θ₂)
//   ets_damped      Holt's damped trend, (α,β,φ) by SSE grid
//   ar              AR(p) on first differences (ARIMA(p,1,0)), p by AICc
//   flowx           FlowX — AR on differences conditioned on LAGGED order-flow
//                   features (delta z, volume z, buy share, CVD slope), ridge
//   ensemble        equal-weight mean of every base model
// ─────────────────────────────────────────────────────────────────────────────

import { mean } from './stats';
import type { FcModelId } from './types';

export interface FcModelContext {
  /** history, ascending by time */
  y: number[];
  /** horizon (steps ahead to forecast) */
  h: number;
  /** season length m (1 = no seasonality) */
  seasonLength: number;
  /**
   * Exogenous flow-feature columns aligned index-for-index with `y`
   * (FlowX consumes them lagged, so no look-ahead leaks into calibration).
   */
  features?: Float64Array[];
}

export interface FcModelOutput {
  /** h point forecasts */
  forecast: number[];
  /**
   * One-step in-sample fitted values, same length as y (NaN before the
   * model's burn-in). Residuals y − fitted drive the native quantile knots.
   */
  fitted: number[];
}

export type FcPointModelFn = (ctx: FcModelContext) => FcModelOutput;

const nanArray = (n: number): number[] => new Array(n).fill(NaN);

// ── naive ───────────────────────────────────────────────────────────────────

const naiveModel: FcPointModelFn = ({ y, h }) => {
  const last = y[y.length - 1] ?? 0;
  const fitted = nanArray(y.length);
  for (let i = 1; i < y.length; i++) fitted[i] = y[i - 1];
  return { forecast: new Array(h).fill(last), fitted };
};

// ── seasonal naive ──────────────────────────────────────────────────────────

const seasonalNaiveModel: FcPointModelFn = ({ y, h, seasonLength }) => {
  const m = Math.max(1, Math.min(seasonLength, y.length));
  const forecast: number[] = [];
  for (let j = 1; j <= h; j++) {
    // ŷ_{T+j} = y_{T+j − m·ceil(j/m)} semantics: last observed value at the
    // same seasonal position, walking back season by season.
    const idx = y.length - m + ((j - 1) % m);
    forecast.push(y[Math.max(0, idx)] ?? y[y.length - 1] ?? 0);
  }
  const fitted = nanArray(y.length);
  for (let i = m; i < y.length; i++) fitted[i] = y[i - m];
  return { forecast, fitted };
};

// ── drift ───────────────────────────────────────────────────────────────────

const driftModel: FcPointModelFn = ({ y, h }) => {
  const n = y.length;
  const fitted = nanArray(n);
  if (n < 2) return { forecast: new Array(h).fill(y[0] ?? 0), fitted };
  const drift = (y[n - 1] - y[0]) / (n - 1);
  const forecast: number[] = [];
  for (let j = 1; j <= h; j++) forecast.push(y[n - 1] + j * drift);
  for (let i = 1; i < n; i++) fitted[i] = y[i - 1] + drift;
  return { forecast, fitted };
};

// ── theta (Θ₀ + Θ₂) ─────────────────────────────────────────────────────────

const thetaModel: FcPointModelFn = ({ y, h }) => {
  const n = y.length;
  const fitted = nanArray(n);
  if (n < 4) {
    const last = y[n - 1] ?? 0;
    return { forecast: new Array(h).fill(last), fitted };
  }
  // Θ₀: least-squares line over the full sample
  const tm = (n - 1) / 2;
  const ym = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - tm) * (y[i] - ym);
    den += (i - tm) * (i - tm);
  }
  const b = den > 0 ? num / den : 0;
  const a = ym - b * tm;
  // Θ₂ = 2y − Θ₀, forecast by SES with α chosen on one-step SSE
  const z2 = new Float64Array(n);
  for (let i = 0; i < n; i++) z2[i] = 2 * y[i] - (a + b * i);
  let bestAlpha = 0.3;
  let bestSse = Infinity;
  for (let ai = 1; ai <= 49; ai++) {
    const alpha = ai * 0.02;
    let level = z2[0];
    let sse = 0;
    for (let i = 1; i < n; i++) {
      const e = z2[i] - level;
      sse += e * e;
      level += alpha * e;
    }
    if (sse < bestSse) {
      bestSse = sse;
      bestAlpha = alpha;
    }
  }
  // final pass with best α, recording the level after each observation
  const levels = new Float64Array(n);
  let level = z2[0];
  levels[0] = level;
  for (let i = 1; i < n; i++) {
    level += bestAlpha * (z2[i] - level);
    levels[i] = level;
  }
  const forecast: number[] = [];
  for (let j = 1; j <= h; j++) {
    const z0 = a + b * (n - 1 + j);
    forecast.push(0.5 * (z0 + level));
  }
  for (let i = 1; i < n; i++) fitted[i] = 0.5 * (a + b * i + levels[i - 1]);
  return { forecast, fitted };
};

// ── ETS damped trend ────────────────────────────────────────────────────────

const etsDampedModel: FcPointModelFn = ({ y, h }) => {
  const n = y.length;
  const fitted = nanArray(n);
  if (n < 4) {
    const last = y[n - 1] ?? 0;
    return { forecast: new Array(h).fill(last), fitted };
  }
  const grid: { alpha: number; beta: number; phi: number }[] = [];
  for (const alpha of [0.1, 0.3, 0.5]) {
    for (const beta of [0.01, 0.05, 0.1]) {
      for (const phi of [0.85, 0.95]) grid.push({ alpha, beta, phi });
    }
  }
  let best = grid[0];
  let bestSse = Infinity;
  let bestFitted: number[] = nanArray(n);
  let bestLevel = y[0];
  let bestTrend = 0;
  for (const g of grid) {
    // error-correction form of Holt's damped method:
    //   f_t = ℓ + φ·b ; e = y_t − f_t
    //   ℓ ← ℓ + α·e ; b ← φ·b + α·β·e
    let level = y[0];
    let trend = y[1] - y[0];
    let sse = 0;
    const fit = nanArray(n);
    for (let i = 1; i < n; i++) {
      const f = level + g.phi * trend;
      fit[i] = f;
      const e = y[i] - f;
      sse += e * e;
      level = level + g.phi * trend + g.alpha * e;
      trend = g.phi * trend + g.alpha * g.beta * e;
    }
    if (sse < bestSse) {
      bestSse = sse;
      best = g;
      bestFitted = fit;
      bestLevel = level;
      bestTrend = trend;
    }
  }
  const forecast: number[] = [];
  let cum = 0;
  for (let j = 1; j <= h; j++) {
    cum += Math.pow(best.phi, j);
    forecast.push(bestLevel + cum * bestTrend);
  }
  return { forecast, fitted: bestFitted };
};

// ── AR(p) on differences (ARIMA(p,1,0)) ─────────────────────────────────────

/** Solve (XᵀX)β = Xᵀz via Gaussian elimination with partial pivoting. */
function solveNormal(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

interface ArFit {
  p: number;
  coef: number[]; // [intercept, φ₁..φ_p]
  fittedDiff: number[]; // aligned to d (NaN for first p)
}

function fitArOnDiffs(d: number[], maxP = 8): ArFit | null {
  const T = d.length;
  if (T < 12) return null;
  let best: ArFit | null = null;
  let bestAicc = Infinity;
  for (let p = 1; p <= Math.min(maxP, Math.floor(T / 6)); p++) {
    const rows = T - p;
    const k = p + 1;
    const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
    const Xtz = new Array(k).fill(0);
    for (let t = p; t < T; t++) {
      const row = [1];
      for (let l = 1; l <= p; l++) row.push(d[t - l]);
      const z = d[t];
      for (let i = 0; i < k; i++) {
        Xtz[i] += row[i] * z;
        for (let j = 0; j < k; j++) XtX[i][j] += row[i] * row[j];
      }
    }
    const beta = solveNormal(XtX, Xtz);
    if (!beta) continue;
    let sse = 0;
    const fittedDiff = new Array(T).fill(NaN);
    for (let t = p; t < T; t++) {
      let f = beta[0];
      for (let l = 1; l <= p; l++) f += beta[l] * d[t - l];
      fittedDiff[t] = f;
      sse += (d[t] - f) ** 2;
    }
    const aicc = rows * Math.log(Math.max(sse, 1e-12) / rows) + 2 * k + (2 * k * (k + 1)) / Math.max(1, rows - k - 1);
    if (aicc < bestAicc) {
      bestAicc = aicc;
      best = { p, coef: beta, fittedDiff };
    }
  }
  return best;
}

function arForecast(d: number[], fit: ArFit, h: number): number[] {
  const out: number[] = [];
  const hist = d.slice();
  for (let j = 0; j < h; j++) {
    let f = fit.coef[0];
    for (let l = 1; l <= fit.p; l++) f += fit.coef[l] * hist[hist.length - l];
    out.push(f);
    hist.push(f);
  }
  return out;
}

const arModel: FcPointModelFn = ({ y, h }) => {
  const n = y.length;
  const fitted = nanArray(n);
  if (n < 14) return { forecast: new Array(h).fill(y[n - 1] ?? 0), fitted };
  const d: number[] = new Array(n - 1);
  for (let i = 1; i < n; i++) d[i - 1] = y[i] - y[i - 1];
  const fit = fitArOnDiffs(d);
  if (!fit) return { forecast: new Array(h).fill(y[n - 1] ?? 0), fitted };
  const diffFc = arForecast(d, fit, h);
  const forecast: number[] = [];
  let cum = 0;
  for (let j = 0; j < h; j++) {
    cum += diffFc[j];
    forecast.push(y[n - 1] + cum);
  }
  for (let t = 0; t < d.length; t++) {
    if (!Number.isNaN(fit.fittedDiff[t])) fitted[t + 1] = y[t] + fit.fittedDiff[t];
  }
  return { forecast, fitted };
};

// ── FlowX — flow-conditioned AR on differences ──────────────────────────────

/**
 * FlowX: Δy_t = c + Σ φ_k Δy_{t−k} + Σ γ_f feature_{f,t}.
 * Row t predicts the change y[t] → y[t+1] from past changes and the flow
 * features observed over bar t itself — everything is known at forecast
 * time, so no look-ahead leaks into conformal calibration. Features are
 * z-scored on the fitting window; ridge λ keeps the recursion stable; future
 * features persist at their last observed value (documented heuristic).
 */
function flowxFit(d: number[], feats: Float64Array[] | undefined, maxLag = 3) {
  const T = d.length;
  const nFeat = feats ? Math.min(feats.length, 6) : 0;
  if (T < 20) return null;
  const p = Math.min(maxLag, Math.max(1, Math.floor(T / 12)));
  const k = 1 + p + nFeat;
  if (T - p < k + 2) return null;
  // z-score each feature over the rows used (feature index t ≤ T−1)
  const zFeats: Float64Array[] = [];
  for (let f = 0; f < nFeat; f++) {
    const col = feats![f];
    let m = 0;
    let cnt = 0;
    for (let t = p; t < T; t++) {
      const v = col[t] ?? 0;
      if (Number.isFinite(v)) {
        m += v;
        cnt++;
      }
    }
    m /= Math.max(1, cnt);
    let vv = 0;
    for (let t = p; t < T; t++) {
      const v = col[t] ?? 0;
      if (Number.isFinite(v)) vv += (v - m) ** 2;
    }
    const sd = Math.sqrt(vv / Math.max(1, cnt)) || 1;
    const z = new Float64Array(Math.max(col.length, T));
    for (let t = 0; t < z.length; t++) z[t] = Number.isFinite(col[t] ?? NaN) ? ((col[t] as number) - m) / sd : 0;
    zFeats.push(z);
  }
  // design rows: t = p .. T−1 (target d[t], feature[t] known at bar t)
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xtz = new Array(k).fill(0);
  let rows = 0;
  for (let t = p; t < T; t++) {
    const row = [1];
    for (let l = 1; l <= p; l++) row.push(d[t - l]);
    for (let f = 0; f < nFeat; f++) row.push(zFeats[f][t]);
    const z = d[t];
    for (let i = 0; i < k; i++) {
      Xtz[i] += row[i] * z;
      for (let j = 0; j < k; j++) XtX[i][j] += row[i] * row[j];
    }
    rows++;
  }
  // ridge
  const lambda = 1e-4 * rows;
  for (let i = 1; i < k; i++) XtX[i][i] += lambda;
  const beta = solveNormal(XtX, Xtz);
  if (!beta) return null;
  return { p, k, beta, zFeats, nFeat };
}

function flowxForecast(d: number[], fit: NonNullable<ReturnType<typeof flowxFit>>, h: number): number[] {
  const { p, beta, zFeats, nFeat } = fit;
  const hist = d.slice();
  const lastZ = nFeat ? zFeats.map((z) => z[Math.max(0, z.length - 1)]) : [];
  const out: number[] = [];
  for (let j = 0; j < h; j++) {
    let f = beta[0];
    for (let l = 1; l <= p; l++) f += beta[l] * hist[hist.length - l];
    for (let fi = 0; fi < nFeat; fi++) f += beta[1 + p + fi] * lastZ[fi];
    out.push(f);
    hist.push(f);
  }
  return out;
}

const flowxModel: FcPointModelFn = ({ y, h, features }) => {
  const n = y.length;
  const fitted = nanArray(n);
  if (n < 22) return { forecast: new Array(h).fill(y[n - 1] ?? 0), fitted };
  const d: number[] = new Array(n - 1);
  for (let i = 1; i < n; i++) d[i - 1] = y[i] - y[i - 1];
  const fit = flowxFit(d, features && features.length ? features : undefined);
  if (!fit) return arModel({ y, h, seasonLength: 1 });
  const diffFc = flowxForecast(d, fit, h);
  const forecast: number[] = [];
  let cum = 0;
  for (let j = 0; j < h; j++) {
    cum += diffFc[j];
    forecast.push(y[n - 1] + cum);
  }
  // one-step fitted over the regression rows
  const { p, beta, zFeats, nFeat } = fit;
  for (let t = p; t < d.length; t++) {
    let f = beta[0];
    for (let l = 1; l <= p; l++) f += beta[l] * d[t - l];
    for (let fi = 0; fi < nFeat; fi++) f += beta[1 + p + fi] * zFeats[fi][t];
    fitted[t + 1] = y[t] + f;
  }
  return { forecast, fitted };
};

// ── ensemble ────────────────────────────────────────────────────────────────

const BASE_MODELS: FcModelId[] = ['naive', 'seasonal_naive', 'drift', 'theta', 'ets_damped', 'ar', 'flowx'];

const ensembleModel: FcPointModelFn = (ctx) => {
  const n = ctx.y.length;
  const outs = BASE_MODELS.map((m) => FC_POINT_MODELS[m](ctx));
  const h = ctx.h;
  const forecast: number[] = new Array(h).fill(0);
  const fitted = nanArray(n);
  const fitAcc = new Array(n).fill(0);
  const fitCnt = new Array(n).fill(0);
  for (const o of outs) {
    for (let j = 0; j < h; j++) forecast[j] += o.forecast[j] / outs.length;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(o.fitted[i])) {
        fitAcc[i] += o.fitted[i];
        fitCnt[i]++;
      }
    }
  }
  for (let i = 0; i < n; i++) if (fitCnt[i] > 0) fitted[i] = fitAcc[i] / fitCnt[i];
  return { forecast, fitted };
};

// ── registry ────────────────────────────────────────────────────────────────

export const FC_POINT_MODELS: Record<FcModelId, FcPointModelFn> = {
  naive: naiveModel,
  seasonal_naive: seasonalNaiveModel,
  drift: driftModel,
  theta: thetaModel,
  ets_damped: etsDampedModel,
  ar: arModel,
  flowx: flowxModel,
  ensemble: ensembleModel,
};

/** One-step residuals (y − fitted) over the valid (non-NaN) range. */
export function modelResiduals(y: number[], fitted: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < y.length; i++) {
    if (!Number.isNaN(fitted[i])) out.push(y[i] - fitted[i]);
  }
  return out;
}

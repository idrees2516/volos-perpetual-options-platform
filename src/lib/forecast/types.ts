// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — shared types (server + client)
//
// The forecasting layer mirrors TimeCopilot's foundationforecast design:
// a panel of series (unique_id / ds / y), point-forecast models, and
// prediction intervals produced either from a model's native quantile knots
// (fixed, e.g. {0.1, 0.5, 0.9} — wider levels get clamped, like Tafsut /
// Chronos-Bolt) or from ConformalIntervals calibrated on the model's own
// backtested errors (conformal_distribution / conformal_error).
//
// Input series are built from the native order-flow engine's flow bars and
// footprint candles (close / volume / delta / CVD / imbalance / trades / OI),
// optionally backfilled with Binance klines (taker-buy base volume gives the
// same delta/imbalance semantics).
// ─────────────────────────────────────────────────────────────────────────────

/** One observation of a forecasting series. */
export interface FcPoint {
  /** timestamp (bucket open, ms) */
  ds: number;
  /** target value */
  y: number;
}

/** One series of the forecasting panel (foundationforecast `unique_id`). */
export interface FcSeries {
  uniqueId: string;
  /** human label, e.g. "BTC · close · 1m" */
  label: string;
  points: FcPoint[];
  /** true when the tail comes from the live engine (not kline backfill) */
  liveTailFrom?: number;
}

/** Interval construction methods (aliases match foundationforecast). */
export type FcIntervalMethod =
  | 'native'
  | 'native_full' // unclamped z-scores — the honest 95% native baseline
  | 'conformal_distribution'
  | 'conformal_error'
  | 'enbpi' // jackknife+ ensemble batch prediction intervals
  | 'aci'; // adaptive conformal inference (online α)

/** Point-forecast model ids implemented natively on flow bars. */
export type FcModelId =
  | 'naive'
  | 'seasonal_naive'
  | 'drift'
  | 'theta'
  | 'ets_damped'
  | 'ar'
  | 'flowx'
  | 'ensemble';

/** A model instance in the Forecaster: model class + interval strategy + alias. */
export interface FcModelSpec {
  alias: string;
  model: FcModelId;
  /** interval strategy; omit for a pure point model */
  intervals?: FcIntervalMethod;
  /** conformal calibration windows (ConformalIntervals.n_windows) */
  nWindows?: number;
  /** gap between calibration cutoffs; null → h (non-overlapping) */
  stepSize?: number | null;
}

/** Forecast for one model / one series / one horizon step. */
export interface FcForecastRow {
  uniqueId: string;
  alias: string;
  /** forecast origin timestamp (ms) */
  cutoff: number;
  /** horizon step, 1..h */
  step: number;
  /** forecast timestamp (ms) */
  ds: number;
  /** point forecast */
  point: number;
  /** intervals per requested level, ascending */
  levels: FcLevelInterval[];
}

export interface FcLevelInterval {
  /** level in percent, e.g. 80 */
  level: number;
  lo: number;
  hi: number;
}

/** Cross-validation row: prediction vs actual at a rolling cutoff. */
export interface FcCvRow {
  uniqueId: string;
  alias: string;
  cutoff: number;
  step: number;
  ds: number;
  /** actual value (undefined for true out-of-sample future) */
  y: number | null;
  point: number;
  levels: FcLevelInterval[];
}

/** Evaluation metrics for one model alias (mirrors the docs' evaluation table). */
export interface FcEvalRow {
  alias: string;
  model: FcModelId;
  intervals: FcIntervalMethod | 'point';
  /** share of actuals inside [lo, hi], per level */
  coverage: Record<number, number>;
  /** mean interval width (hi − lo), per level */
  width: Record<number, number>;
  /** mean absolute scaled error (point accuracy, seasonality-aware) */
  mase: number | null;
  /** scaled continuous ranked probability score from the interval bounds */
  scaledCrps: number | null;
  /** mean pinball loss per level (lo/hi knots), the calibration-fidelity score */
  pinball: Record<number, number>;
  mae: number | null;
  rmse: number | null;
  smape: number | null;
  /** true when the widest level is clamped to a narrower native knot */
  clampedAt: number | null;
  forecasts: number;
}

/** One point of the coverage-over-time series (per evaluation cutoff). */
export interface FcCoveragePoint {
  /** forecast origin (ms) */
  cutoff: number;
  /** horizon steps scored in this bucket */
  steps: number;
  /** share of actuals inside the band, per level (keyed as percent) */
  covered: Record<number, number>;
  /** mean band width at the widest level (target-scale units) */
  width: number | null;
}

/** Calibration diagnostics for one conformal model. */
export interface FcCalibrationInfo {
  nWindows: number;
  stepSize: number;
  method: FcIntervalMethod;
  /** calibration errors e[w][j], absolute, per window and horizon step */
  errors: number[][];
  /** mean |error| per horizon step */
  errorByStep: number[];
  /** observations required vs available at calibration time */
  required: number;
  available: number;
  ok: boolean;
}

/** One model's full result block returned by the API. */
export interface FcModelResult {
  alias: string;
  model: FcModelId;
  modelLabel: string;
  intervals: FcIntervalMethod;
  rows: FcForecastRow[];
  calibration: FcCalibrationInfo | null;
  /** expected move readout at the final step (close target only, in price terms) */
  expectedMove: {
    level: number;
    lo: number;
    hi: number;
    width: number;
    widthPct: number;
    point: number;
  } | null;
}

/** Targets buildable from the order-flow engine's flow bars / candles. */
export type FcTargetId =
  | 'close'
  | 'volume'
  | 'delta'
  | 'cvd'
  | 'imbalance'
  | 'trades'
  | 'oi'
  | 'venueVolumeShare'
  | 'venueDelta';

export interface FcTargetMeta {
  id: FcTargetId;
  label: string;
  unit: string;
  /** series granularity: aggregate or per-venue panel */
  panel: 'aggregate' | 'venues';
  description: string;
}

export const FC_TARGETS: FcTargetMeta[] = [
  { id: 'close', label: 'price', unit: 'usd', panel: 'aggregate', description: 'flow-bar close price (multi-venue consolidated)' },
  { id: 'volume', label: 'volume', unit: 'base', panel: 'aggregate', description: 'executed base volume per bar' },
  { id: 'delta', label: 'delta', unit: 'base', panel: 'aggregate', description: 'aggressor imbalance per bar (buy − sell)' },
  { id: 'cvd', label: 'cvd', unit: 'base', panel: 'aggregate', description: 'cumulative volume delta (session)' },
  { id: 'imbalance', label: 'buy share', unit: 'ratio', panel: 'aggregate', description: 'buy volume ÷ total volume per bar' },
  { id: 'trades', label: 'prints', unit: 'count', panel: 'aggregate', description: 'trade count per bar' },
  { id: 'oi', label: 'open interest', unit: 'base', panel: 'aggregate', description: 'summed venue open interest (engine only, no backfill)' },
  { id: 'venueVolumeShare', label: 'venue share', unit: 'ratio', panel: 'venues', description: 'per-venue volume share panel — forecasts each venue separately' },
  { id: 'venueDelta', label: 'venue delta', unit: 'base', panel: 'venues', description: 'per-venue aggressor delta panel — forecasts each venue separately' },
];

export function fcTargetMeta(id: FcTargetId): FcTargetMeta {
  return FC_TARGETS.find((t) => t.id === id) ?? FC_TARGETS[0];
}

/** Point-model registry metadata (labels for UI / Copilot). */
export const FC_MODEL_LABELS: Record<FcModelId, string> = {
  naive: 'Naive (random walk)',
  seasonal_naive: 'Seasonal naive',
  drift: 'Drift (RW + drift)',
  theta: 'Theta (θ₀+θ₂)',
  ets_damped: 'ETS damped trend',
  ar: 'AR(p) OLS',
  flowx: 'FlowX (flow-conditioned AR)',
  ensemble: 'Ensemble (mean)',
};

/**
 * Models whose "native" intervals come from fixed quantile knots {0.1, 0.5,
 * 0.9} — like Tafsut / Chronos-Bolt, any level wider than 80% clamps to the
 * outermost knot. This reproduces the foundationforecast conformal example's
 * teaching point natively.
 */
export const FC_NATIVE_KNOT_MODELS: ReadonlySet<FcModelId> = new Set<FcModelId>([
  'naive',
  'seasonal_naive',
  'drift',
  'theta',
  'ets_damped',
  'ar',
  'flowx',
  'ensemble',
]);

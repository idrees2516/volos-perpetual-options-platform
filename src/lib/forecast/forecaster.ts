// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — Forecaster (the FoundationForecast equivalent)
//
// Orchestrates a panel of flow-bar series through a list of model specs
// (model class + interval strategy + alias), exactly mirroring the
// TimeCopilot foundationforecast conformal-prediction example:
//
//   forecast()         point forecast from the full history + intervals:
//                        native     fixed quantile knots {0.1,0.5,0.9} —
//                                   levels wider than 80% CLAMP (the
//                                   Tafsut/Chronos-Bolt behaviour)
//                        conformal  ConformalIntervals calibrated on the
//                                   model's own backtested errors
//
//   crossValidation()  rolling evaluation on the last n windows; conformal
//                      models RECALIBRATE at every cutoff using only data
//                      before it (the reference's guarantee: the evaluation
//                      never sees the data it is scored on)
//
//   evaluate()         coverage per level, mean width, MASE (point accuracy),
//                      scaled CRPS from the interval bounds, clamping
//                      detection — the docs' evaluation table
// ─────────────────────────────────────────────────────────────────────────────

import {
  ConformalIntervals,
  nativeKnotIntervals,
  type ConformalCalibration,
} from './conformal';
import { FC_POINT_MODELS, modelResiduals, type FcModelContext } from './models';
import { seasonalNaiveMae, pinballLoss } from './stats';
import {
  FC_MODEL_LABELS,
  FC_NATIVE_KNOT_MODELS,
  type FcEvalRow,
  type FcForecastRow,
  type FcCvRow,
  type FcModelId,
  type FcModelSpec,
  type FcSeries,
  type FcLevelInterval,
} from './types';
import type { FcPanel } from './panel';

export interface FcForecastOpts {
  /** horizon steps */
  h: number;
  /** levels in percent, ascending */
  levels: number[];
  /** conformal calibration windows per spec (spec.nWindows overrides) */
  nWindows?: number;
}

export interface FcCvOpts extends FcForecastOpts {
  /** evaluation windows (the reference uses 2) */
  cvWindows: number;
  /** gap between evaluation cutoffs; null → h */
  cvStepSize?: number | null;
}

export interface FcSeriesResult {
  uniqueId: string;
  label: string;
  rows: FcForecastRow[];
}

export interface FcForecastOutput {
  /** per series → per model → rows */
  bySeries: Record<string, FcModelOut[]>;
  /** flattened convenience: primary series only */
  primary: FcModelOut[];
}

export interface FcModelOut {
  alias: string;
  model: FcModelId;
  modelLabel: string;
  intervals: string;
  rows: FcForecastRow[];
  calibration: ConformalCalibration | null;
  /** interval source notes for the UI ("clamped at 80", "W=10 windows", …) */
  note: string;
}

// ── per-series helpers ───────────────────────────────────────────────────────

function seriesContext(
  panel: FcPanel,
  series: FcSeries,
  si: number,
  h: number,
  historyEnd: number,
): FcModelContext {
  const y = series.points
    .slice(0, historyEnd + 1)
    .map((p) => p.y)
    .filter(Number.isFinite);
  const feats = panel.features[si]?.length
    ? panel.features[si].map((f) => f.subarray(0, historyEnd + 1))
    : undefined;
  return { y, h, seasonLength: panel.seasonLength, features: feats };
}

/** level intervals for one model spec on one (context, point forecast). */
function buildIntervals(
  spec: FcModelSpec,
  ctx: FcModelContext,
  point: number[],
  levels: number[],
  bounds: { lo?: number; hi?: number } | null,
  fitted: number[],
): { perStep: FcLevelInterval[][]; calibration: ConformalCalibration | null; note: string } {
  const modelFn = FC_POINT_MODELS[spec.model];
  if (spec.intervals === 'conformal_distribution' || spec.intervals === 'conformal_error') {
    const conformal = new ConformalIntervals(
      spec.nWindows ?? 10,
      spec.intervals,
      spec.stepSize ?? null,
    );
    const calibration = conformal.calibrate(ctx, modelFn, ctx.h, {});
    const perStep = conformal.intervals(point, calibration, levels, bounds ?? undefined);
    const note = calibration.ok
      ? `W=${calibration.nWindows} windows · Δ=${calibration.stepSize} · ${spec.intervals === 'conformal_error' ? 'q̂ = Q₁₋α(e)' : '2W synthetic outcomes'}`
      : `calibration short (${calibration.available}/${calibration.required} obs)`;
    return { perStep, calibration, note };
  }
  // native fixed-knot path
  const residuals = modelResiduals(ctx.y, fitted).map(Math.abs);
  const perStep = nativeKnotIntervals(point, residuals, levels, bounds ?? undefined);
  const isKnotModel = FC_NATIVE_KNOT_MODELS.has(spec.model);
  const widest = Math.max(...levels);
  const note = isKnotModel && widest > 80
    ? `native knots {0.1, 0.5, 0.9} — levels > 80% clamp to the 80% band`
    : 'native residual intervals';
  return { perStep, calibration: null, note };
}

// ── Forecaster ──────────────────────────────────────────────────────────────

export class Forecaster {
  constructor(public specs: FcModelSpec[]) {}

  /**
   * Forecast h steps from the full history of every series in the panel.
   * Conformal models calibrate on the last nWindows holdouts of each series
   * before producing their intervals (reference: `ff.forecast(df, h, level)`).
   */
  forecast(panel: FcPanel, opts: FcForecastOpts): FcForecastOutput {
    const levels = [...opts.levels].sort((a, b) => a - b);
    const bySeries: Record<string, FcModelOut[]> = {};
    let primaryOut: FcModelOut[] = [];
    panel.series.forEach((series, si) => {
      const out: FcModelOut[] = [];
      const histEnd = series.points.length - 1;
      const ctx = seriesContext(panel, series, si, opts.h, histEnd);
      const n = ctx.y.length;
      const cutoff = series.points[Math.max(0, histEnd)]?.ds ?? Date.now();
      for (const spec of this.specs) {
        const modelFn = FC_POINT_MODELS[spec.model];
        const { forecast: point, fitted } = modelFn(ctx);
        const { perStep, calibration, note } = buildIntervals(
          spec, ctx, point, levels, panel.bounds, fitted,
        );
        const rows: FcForecastRow[] = [];
        for (let j = 0; j < opts.h; j++) {
          rows.push({
            uniqueId: series.uniqueId,
            alias: spec.alias,
            cutoff,
            step: j + 1,
            ds: cutoff + (j + 1) * panel.tf,
            point: point[j] ?? NaN,
            levels: perStep[j] ?? levels.map((level) => ({ level, lo: NaN, hi: NaN })),
          });
        }
        out.push({
          alias: spec.alias,
          model: spec.model,
          modelLabel: FC_MODEL_LABELS[spec.model],
          intervals: spec.intervals ?? 'native',
          rows,
          calibration,
          note,
        });
      }
      bySeries[series.uniqueId] = out;
      if (si === 0) primaryOut = out;
      void n;
    });
    return { bySeries, primary: primaryOut };
  }

  /**
   * Rolling cross-validation: evaluates the last `cvWindows` h-windows of
   * every series. Conformal specs RECALIBRATE at every cutoff on the windows
   * before it (reference: `ff.cross_validation(df, h, n_windows, level)`).
   */
  crossValidate(panel: FcPanel, opts: FcCvOpts): FcCvRow[] {
    const levels = [...opts.levels].sort((a, b) => a - b);
    const W = Math.max(1, Math.min(16, opts.cvWindows));
    const step = opts.cvStepSize ?? opts.h;
    const rows: FcCvRow[] = [];
    panel.series.forEach((series, si) => {
      const T = series.points.length - 1; // last index
      for (let w = 1; w <= W; w++) {
        // evaluation cutoff index: T − (W−w+1)·step
        const cutoffIdx = T - (W - w + 1) * step;
        if (cutoffIdx < 12) continue;
        const cutoff = series.points[cutoffIdx].ds;
        const ctx = seriesContext(panel, series, si, opts.h, cutoffIdx);
        for (const spec of this.specs) {
          const modelFn = FC_POINT_MODELS[spec.model];
          const { forecast: point, fitted } = modelFn(ctx);
          const { perStep } = buildIntervals(spec, ctx, point, levels, panel.bounds, fitted);
          for (let j = 0; j < opts.h; j++) {
            const actualIdx = cutoffIdx + 1 + j;
            const actual = actualIdx <= T ? series.points[actualIdx].y : null;
            rows.push({
              uniqueId: series.uniqueId,
              alias: spec.alias,
              cutoff,
              step: j + 1,
              ds: cutoff + (j + 1) * panel.tf,
              y: actual,
              point: point[j] ?? NaN,
              levels: perStep[j] ?? levels.map((level) => ({ level, lo: NaN, hi: NaN })),
            });
          }
        }
      }
    });
    return rows;
  }

  /**
   * The docs' evaluation: coverage per level (share of actuals inside the
   * interval), mean width, MASE, scaled CRPS from the interval bounds, plus
   * clamping detection (native 95% == native 80%). Rows aggregate across
   * series per alias.
   */
  evaluate(cvRows: FcCvRow[], panel: FcPanel, levels: number[]): FcEvalRow[] {
    const sorted = [...levels].sort((a, b) => a - b);
    const byAlias = new Map<string, FcCvRow[]>();
    for (const r of cvRows) {
      if (r.y === null || !Number.isFinite(r.y)) continue;
      const list = byAlias.get(r.alias) ?? [];
      list.push(r);
      byAlias.set(r.alias, list);
    }
    const specByAlias = new Map(this.specs.map((s) => [s.alias, s]));
    const scaleBySeries = new Map<string, number>();
    for (const series of panel.series) {
      const y = series.points.map((p) => p.y).filter(Number.isFinite);
      scaleBySeries.set(series.uniqueId, seasonalNaiveMae(y, panel.seasonLength) || 1);
    }

    const out: FcEvalRow[] = [];
    for (const [alias, rows] of byAlias) {
      const spec = specByAlias.get(alias);
      const coverage: Record<number, number> = {};
      const width: Record<number, number> = {};
      for (const level of sorted) {
        let inCount = 0;
        let widthSum = 0;
        let widthN = 0;
        for (const r of rows) {
          const li = r.levels.find((l) => l.level === level);
          if (!li || !Number.isFinite(li.lo) || !Number.isFinite(li.hi)) continue;
          if (r.y !== null && r.y >= li.lo && r.y <= li.hi) inCount++;
          widthSum += li.hi - li.lo;
          widthN++;
        }
        coverage[level] = widthN > 0 ? inCount / rows.length : NaN;
        width[level] = widthN > 0 ? widthSum / widthN : NaN;
      }
      // point metrics
      let aeSum = 0;
      let seSum = 0;
      let apeSum = 0;
      let smapeSum = 0;
      let n = 0;
      let maseSum = 0;
      let crpsSum = 0;
      for (const r of rows) {
        if (r.y === null || !Number.isFinite(r.y) || !Number.isFinite(r.point)) continue;
        const e = r.y - r.point;
        const ae = Math.abs(e);
        aeSum += ae;
        seSum += e * e;
        apeSum += r.y !== 0 ? ae / Math.abs(r.y) : 0;
        smapeSum += ae / ((Math.abs(r.y) + Math.abs(r.point)) / 2 || 1);
        const scale = scaleBySeries.get(r.uniqueId) ?? 1;
        maseSum += ae / scale;
        // scaled CRPS from the interval bounds: quantile knots from the
        // levels + the median (point), pinball-averaged, scaled like MASE
        const knots: { q: number; v: number }[] = [{ q: 0.5, v: r.point }];
        for (const level of sorted) {
          const li = r.levels.find((l) => l.level === level);
          if (!li || !Number.isFinite(li.lo) || !Number.isFinite(li.hi)) continue;
          const alpha = 1 - level / 100;
          knots.push({ q: alpha / 2, v: li.lo }, { q: 1 - alpha / 2, v: li.hi });
        }
        let pb = 0;
        for (const k of knots) pb += pinballLoss(r.y, k.v, k.q);
        crpsSum += (2 / knots.length) * pb / scale;
        n++;
      }
      // clamping detection: widest level bounds == narrowest level bounds
      let clampedAt: number | null = null;
      if (sorted.length >= 2 && spec && (spec.intervals ?? 'native') === 'native') {
        const narrow = sorted[0];
        const widest = sorted[sorted.length - 1];
        if (narrow !== widest) {
          let same = 0;
          let total = 0;
          for (const r of rows) {
            const a = r.levels.find((l) => l.level === narrow);
            const b = r.levels.find((l) => l.level === widest);
            if (!a || !b || !Number.isFinite(a.lo) || !Number.isFinite(b.lo)) continue;
            total++;
            if (Math.abs(a.lo - b.lo) < 1e-12 && Math.abs(a.hi - b.hi) < 1e-12) same++;
          }
          if (total > 0 && same / total > 0.95) clampedAt = narrow;
        }
      }
      out.push({
        alias,
        model: spec?.model ?? ('naive' as FcModelId),
        intervals: spec?.intervals ?? 'native',
        coverage,
        width,
        mase: n > 0 ? maseSum / n : null,
        scaledCrps: n > 0 ? crpsSum / n : null,
        mae: n > 0 ? aeSum / n : null,
        rmse: n > 0 ? Math.sqrt(seSum / n) : null,
        smape: n > 0 ? smapeSum / n : null,
        clampedAt,
        forecasts: rows.length,
      });
    }
    return out;
  }
}

// ── default model panel (mirrors the docs' 3-way comparison) ─────────────────

/**
 * The reference example runs Tafsut and Chronos-Bolt three times each
 * (native / conformal_distribution / conformal_error). Our flow-native
 * equivalents: FlowX (flow-conditioned AR — the flagship) and Ensemble, each
 * three ways, plus AR and Theta native for reference.
 */
export const DEFAULT_FC_SPECS: FcModelSpec[] = [
  { alias: 'FlowX', model: 'flowx' },
  { alias: 'FlowX-distribution', model: 'flowx', intervals: 'conformal_distribution', nWindows: 10 },
  { alias: 'FlowX-error', model: 'flowx', intervals: 'conformal_error', nWindows: 10 },
  { alias: 'Ensemble', model: 'ensemble' },
  { alias: 'Ensemble-distribution', model: 'ensemble', intervals: 'conformal_distribution', nWindows: 10 },
  { alias: 'Ensemble-error', model: 'ensemble', intervals: 'conformal_error', nWindows: 10 },
  { alias: 'AR', model: 'ar' },
  { alias: 'Theta', model: 'theta' },
];

/** Parse a model alias CSV against the known specs; falls back to defaults. */
export function resolveSpecs(raw: string | null, available: FcModelSpec[] = DEFAULT_FC_SPECS): FcModelSpec[] {
  if (!raw) return available;
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) return available;
  const matched = available.filter((s) => wanted.includes(s.alias));
  return matched.length ? matched : available;
}

/** Build a full spec list from a model-id CSV (auto-aliases each 3 ways). */
export function specsFromModelIds(raw: string | null): FcModelSpec[] | null {
  if (!raw) return null;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return null;
  const specs: FcModelSpec[] = [];
  for (const id of ids) {
    if (!(id in FC_POINT_MODELS)) continue;
    specs.push(
      { alias: id, model: id as FcModelId },
      { alias: `${id}-distribution`, model: id as FcModelId, intervals: 'conformal_distribution', nWindows: 10 },
      { alias: `${id}-error`, model: id as FcModelId, intervals: 'conformal_error', nWindows: 10 },
    );
  }
  return specs.length ? specs : null;
}

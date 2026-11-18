// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — projected-state engine ("what will everything be at that price")
//
// Answers the forward question in one shot, all from current + previous data:
//
//   • PRICE   FlowX conformal-distribution forecast: per-step point + widest
//             calibrated band (the fan that renders AHEAD of the live price
//             on the flow chart), with the Ensemble-error model as a
//             cross-check path.
//   • METRICS every flow-bar target forecast on the SAME bar history:
//             volume · aggressor delta · CVD · buy share · prints · open
//             interest — each with its own conformal band at the horizon.
//   • INDICATORS computed on history ∪ the projected price path — "if price
//             follows the forecast, what will RSI / EMA / SMA / MACD hist /
//             Bollinger %B read at each future step" via the rolling
//             projectors in indicators.ts (no look-ahead, one value at a
//             time).
//   • VOLATILITY ATR(14) now, realized σ of log returns, and the honest
//             expected-move-per-step straight off the conformal band.
//   • P(up)   empirical climatology: the share of historical h-step moves
//             that ended up — a base rate from previous data, no model
//             assumption dressed up as a probability.
// ─────────────────────────────────────────────────────────────────────────────

import { Forecaster } from './forecaster';
import { aggregateSeries, flowFeatures, loadMergedBars, type FcPanel, type RawBar } from './panel';
import { detectSeasonLength } from './stats';
import type { FcLevelInterval, FcModelSpec } from './types';
import {
  atr,
  ema,
  macd,
  percentB,
  pUpClimatology,
  realizedVolPct,
  rsi,
  sma,
  emaProjector,
  macdHistProjector,
  percentBProjector,
  rsiProjector,
  smaProjector,
} from './indicators';
import type { OfAsset } from '@/lib/orderflow/types';

export interface FcStateRow {
  step: number;
  ds: number;
  point: number;
  /** widest-level convenience bounds */
  lo: number;
  hi: number;
  /** every requested level — the fan's nested bands */
  levels: { level: number; lo: number; hi: number }[];
}

export interface FcMetricRow {
  step: number;
  ds: number;
  v: number;
  lo: number;
  hi: number;
}

export interface FcMetricBlock {
  id: string;
  label: string;
  unit: string;
  /** last actual value from the merged bar history */
  now: number | null;
  rows: FcMetricRow[];
  note?: string;
}

export interface FcIndicatorBlock {
  id: string;
  label: string;
  unit: string;
  now: number | null;
  /** projected value per future step 1..h (null-safe — NaN → omitted) */
  projected: number[];
  note?: string;
}

export interface FcProjectedState {
  asset: OfAsset;
  tf: number;
  h: number;
  levels: number[];
  nWindows: number;
  builtAt: number;
  /** the forecast origin: last merged bar's open time + its close */
  cutoff: { ds: number; price: number };
  price: {
    primary: string;
    modelLabel: string;
    intervals: string;
    note: string;
    rows: FcStateRow[];
    /** Ensemble-error cross-check point path (same horizon) */
    ensemble: number[];
    ensembleNote: string;
  };
  /** point@h vs the last close */
  drift: { pct: number | null; abs: number | null };
  /** empirical share of historical h-step moves that ended up */
  pUp: number | null;
  expectedMove: {
    level: number;
    lo: number;
    hi: number;
    width: number;
    widthPct: number | null;
  } | null;
  metrics: FcMetricBlock[];
  indicators: FcIndicatorBlock[];
  volatility: { atr14: number | null; realizedVolPct: number | null; expectedMovePctPerStep: number[] };
  /** every "now" value in one flat record (current + previous data) */
  snapshot: Record<string, number | null>;
  provenance: {
    klinesBars: number;
    engineBars: number;
    klineSource: string;
    klineError: string | null;
    oiBars: number;
    seasonLength: number;
    bars: number;
  };
}

// ── internal: a minimal well-formed FcPanel for the Forecaster ───────────────

function miniPanel(
  points: { ds: number; y: number }[],
  features: Float64Array[],
  tf: number,
  bounds: { lo?: number; hi?: number } | null,
  uniqueId: string,
  target: FcPanel['target'],
  asset: OfAsset,
): FcPanel {
  const y = points.map((p) => p.y).filter(Number.isFinite);
  return {
    asset,
    tf,
    target,
    series: [{ uniqueId, label: uniqueId, points }],
    features: features.length ? [features] : [[]],
    bounds,
    seasonLength: y.length > 32 ? detectSeasonLength(y) : 1,
    provenance: { klinesBars: 0, engineBars: 0, engineOnly: false, klineError: null, klineSource: 'none' },
    builtAt: Date.now(),
  };
}

const PRICE_SPECS: FcModelSpec[] = [
  { alias: 'FlowX-distribution', model: 'flowx', intervals: 'conformal_distribution', nWindows: 10 },
  { alias: 'Ensemble-error', model: 'ensemble', intervals: 'conformal_error', nWindows: 10 },
];

const AUX_SPEC: FcModelSpec = { alias: 'aux', model: 'flowx', intervals: 'conformal_error', nWindows: 10 };
const OI_SPEC: FcModelSpec = { alias: 'oi', model: 'theta', intervals: 'conformal_error', nWindows: 10 };

function widest(levels: FcLevelInterval[]): FcLevelInterval | undefined {
  let best: FcLevelInterval | undefined;
  for (const l of levels) {
    if (!best || l.level > best.level) best = l;
  }
  return best;
}

function lastFin(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Clamp to hard domain bounds (buy share ∈ [0,1] etc.) — points AND bands. */
function clampBounds(v: number, b: { lo?: number; hi?: number } | null): number {
  if (!b || !Number.isFinite(v)) return v;
  let x = v;
  if (b.lo !== undefined && x < b.lo) x = b.lo;
  if (b.hi !== undefined && x > b.hi) x = b.hi;
  return x;
}

// ── pure core ────────────────────────────────────────────────────────────────

export interface FcStateOpts {
  h: number;
  levels: number[];
  nWindows: number;
  asset?: OfAsset;
}

/**
 * Build the full projected state from a merged bar history (pure — the
 * async `buildProjectedState` wires the shared loader).
 */
export function buildProjectedStateFromBars(
  bars: RawBar[],
  oiPoints: { time: number; openInterest: number }[],
  tf: number,
  opts: FcStateOpts,
): FcProjectedState {
  const { h, nWindows } = opts;
  const levels = [...opts.levels].sort((a, b) => a - b);
  const levelMax = levels[levels.length - 1] ?? 95;
  const asset = opts.asset ?? ('BTC' as OfAsset);
  if (bars.length < 24) throw new Error(`insufficient history (${bars.length} bars)`);

  // ── price forecast (FlowX conformal + Ensemble cross-check) ──────────────
  const closeAgg = aggregateSeries(bars, 'close');
  const features = flowFeatures(bars);
  const pricePanel = miniPanel(closeAgg.points, features, tf, null, 'state-close', 'close', asset);
  const priceOut = new Forecaster(PRICE_SPECS.map((s) => ({ ...s, nWindows }))).forecast(pricePanel, {
    h,
    levels,
    nWindows,
  });
  const primaryOut = priceOut.primary[0];
  const ensembleOut = priceOut.primary[1];
  const priceRows: FcStateRow[] = primaryOut.rows.map((r) => {
    const band = widest(r.levels);
    return {
      step: r.step,
      ds: r.ds,
      point: r.point,
      lo: band?.lo ?? NaN,
      hi: band?.hi ?? NaN,
      levels: r.levels.map((l) => ({ level: l.level, lo: l.lo, hi: l.hi })),
    };
  });
  const closes = bars.map((b) => b.close);
  const lastClose = closes[closes.length - 1];
  const lastDs = bars[bars.length - 1].ds;
  const pointH = priceRows[priceRows.length - 1]?.point ?? NaN;
  const drift = {
    pct: Number.isFinite(pointH) && lastClose > 0 ? ((pointH - lastClose) / lastClose) * 100 : null,
    abs: Number.isFinite(pointH) ? pointH - lastClose : null,
  };

  // ── flow metrics: forecast each target on the same bar history ───────────
  const metricDefs: Array<{ id: 'volume' | 'delta' | 'cvd' | 'imbalance' | 'trades'; label: string; unit: string }> = [
    { id: 'volume', label: 'Volume', unit: 'base' },
    { id: 'delta', label: 'Aggressor delta', unit: 'base' },
    { id: 'cvd', label: 'CVD', unit: 'base' },
    { id: 'imbalance', label: 'Buy share', unit: 'ratio' },
    { id: 'trades', label: 'Prints', unit: 'count' },
  ];
  const metrics: FcMetricBlock[] = [];
  const nowValues: Record<string, number | null> = {};
  for (const def of metricDefs) {
    const agg = aggregateSeries(bars, def.id);
    const pts = agg.points;
    const nowV = pts.length ? pts[pts.length - 1].y : null;
    nowValues[def.id] = Number.isFinite(nowV as number) ? (nowV as number) : null;
    const panel = miniPanel(pts, features, tf, agg.bounds, `state-${def.id}`, def.id, asset);
    const out = new Forecaster([{ ...AUX_SPEC, nWindows }]).forecast(panel, { h, levels, nWindows });
    const rows: FcMetricRow[] = out.primary[0].rows.map((r) => {
      const band = widest(r.levels);
      return {
        step: r.step,
        ds: r.ds,
        v: clampBounds(r.point, agg.bounds),
        lo: clampBounds(band?.lo ?? NaN, agg.bounds),
        hi: clampBounds(band?.hi ?? NaN, agg.bounds),
      };
    });
    metrics.push({
      id: def.id,
      label: def.label,
      unit: def.unit,
      now: nowValues[def.id],
      rows,
    });
  }

  // ── open interest (engine history, bucketed per tf) ──────────────────────
  let oiBars = 0;
  if (oiPoints.length) {
    const buckets = new Map<number, { last: number }>();
    for (const p of oiPoints) {
      const b = Math.floor(p.time / tf) * tf;
      buckets.set(b, { last: p.openInterest });
    }
    const pts = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([ds, v]) => ({ ds, y: v.last }));
    oiBars = pts.length;
    if (pts.length >= 24) {
      const panel = miniPanel(pts, [], tf, null, 'state-oi', 'oi', asset);
      const out = new Forecaster([{ ...OI_SPEC, nWindows }]).forecast(panel, { h, levels, nWindows });
      const rows: FcMetricRow[] = out.primary[0].rows.map((r) => {
        const band = widest(r.levels);
        return { step: r.step, ds: r.ds, v: r.point, lo: band?.lo ?? NaN, hi: band?.hi ?? NaN };
      });
      metrics.push({
        id: 'oi',
        label: 'Open interest',
        unit: 'base',
        now: pts[pts.length - 1].y,
        rows,
        note: 'engine session history only',
      });
    }
  }

  // ── indicators on history ∪ the projected price path ────────────────────
  const pricePath = priceRows.map((r) => r.point).filter(Number.isFinite);
  const rsiProj = rsiProjector(closes);
  const ema21Proj = emaProjector(closes, 21);
  const sma50Proj = smaProjector(closes, 50);
  const macdProj = macdHistProjector(closes);
  const pctBProj = percentBProjector(closes);
  const indicators: FcIndicatorBlock[] = [
    {
      id: 'rsi14',
      label: 'RSI(14)',
      unit: '',
      now: lastFin(rsi(closes)),
      projected: pricePath.map(rsiProj).map((v) => (v === null ? NaN : v)),
    },
    {
      id: 'ema21',
      label: 'EMA(21)',
      unit: 'usd',
      now: lastFin(ema(closes, 21)),
      projected: pricePath.map(ema21Proj).map((v) => (v === null ? NaN : v)),
    },
    {
      id: 'sma50',
      label: 'SMA(50)',
      unit: 'usd',
      now: lastFin(sma(closes, 50)),
      projected: pricePath.map(sma50Proj).map((v) => (v === null ? NaN : v)),
    },
    {
      id: 'macdHist',
      label: 'MACD hist (12,26,9)',
      unit: 'usd',
      now: lastFin(macd(closes).hist),
      projected: pricePath.map(macdProj).map((v) => (v === null ? NaN : v)),
    },
    {
      id: 'pctB',
      label: 'Bollinger %B (20, 2σ)',
      unit: 'ratio',
      now: lastFin(percentB(closes)),
      projected: pricePath.map(pctBProj).map((v) => (v === null ? NaN : v)),
    },
  ];

  // ── volatility ──────────────────────────────────────────────────────────
  const atrNow = lastFin(atr(bars.map((b) => ({ high: b.high, low: b.low, close: b.close })), 14));
  const rvNow = realizedVolPct(closes, 200);
  const expectedMovePctPerStep = priceRows.map((r) =>
    Number.isFinite(r.lo) && Number.isFinite(r.hi) && Number.isFinite(r.point) && r.point !== 0
      ? ((r.hi - r.lo) / r.point) * 100
      : NaN,
  );
  const lastBand = priceRows.length ? priceRows[priceRows.length - 1] : null;
  const expectedMove =
    lastBand && Number.isFinite(lastBand.lo) && Number.isFinite(lastBand.hi)
      ? {
          level: levelMax,
          lo: lastBand.lo,
          hi: lastBand.hi,
          width: lastBand.hi - lastBand.lo,
          widthPct:
            Number.isFinite(pointH) && pointH > 0 ? ((lastBand.hi - lastBand.lo) / pointH) * 100 : null,
        }
      : null;

  // ── snapshot: every "now" value in one flat record ───────────────────────
  const lastBar = bars[bars.length - 1];
  const snapshot: Record<string, number | null> = {
    close: lastBar.close,
    volume: nowValues.volume ?? null,
    delta: nowValues.delta ?? null,
    cvd: nowValues.cvd ?? null,
    buyShare: nowValues.imbalance ?? null,
    trades: nowValues.trades ?? null,
    oi: oiPoints.length ? oiPoints[oiPoints.length - 1].openInterest : null,
    rsi14: indicators[0].now,
    ema21: indicators[1].now,
    sma50: indicators[2].now,
    macdHist: indicators[3].now,
    pctB: indicators[4].now,
    atr14: atrNow,
    realizedVolPct: rvNow,
  };

  return {
    asset,
    tf,
    h,
    levels,
    nWindows,
    builtAt: Date.now(),
    cutoff: { ds: lastDs, price: lastClose },
    price: {
      primary: primaryOut.alias,
      modelLabel: primaryOut.modelLabel,
      intervals: primaryOut.intervals,
      note: primaryOut.note,
      rows: priceRows,
      ensemble: ensembleOut?.rows.map((r) => r.point) ?? [],
      ensembleNote: ensembleOut?.note ?? '',
    },
    drift,
    pUp: pUpClimatology(closes, h),
    expectedMove,
    metrics,
    indicators,
    volatility: { atr14: atrNow, realizedVolPct: rvNow, expectedMovePctPerStep },
    snapshot,
    provenance: {
      klinesBars: 0,
      engineBars: 0,
      klineSource: 'none',
      klineError: null,
      oiBars,
      seasonLength: pricePanel.seasonLength,
      bars: bars.length,
    },
  };
}

// ── async wrapper (shared loader, one venue fetch for everything) ────────────

/** Build the projected state for one (asset, tf): loads merged bars once. */
export async function buildProjectedState(
  asset: OfAsset,
  tf: number,
  opts: FcStateOpts & { backfill?: number },
): Promise<FcProjectedState> {
  const backfill = Math.max(60, Math.min(1500, opts.backfill ?? 720));
  const { bars, oiPoints, klinesBars, engineCount, klineSource, klineError } = await loadMergedBars(
    asset,
    tf,
    backfill,
    { withKlines: true },
  );
  const state = buildProjectedStateFromBars(bars, oiPoints, tf, { ...opts, asset });
  state.provenance = {
    klinesBars,
    engineBars: engineCount,
    klineSource,
    klineError,
    oiBars: state.provenance.oiBars,
    seasonLength: state.provenance.seasonLength,
    bars: bars.length,
  };
  return state;
}

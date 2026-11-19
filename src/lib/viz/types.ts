// ─────────────────────────────────────────────────────────────────────────────
// VIZ · types — the universal chart/model data contract.
//
// ONE series shape feeds EVERY renderer: any product data family (price,
// indicators, flow, forecast, model outputs, derivatives surfaces) as either
// a point series (with optional band + candle fields) or a matrix. The Chart
// Studio plots any points series as any chart kind; the Model Studio runs any
// model on any series and emits its outputs as series again — so every model
// output is chartable, and every chart series is modelable.
// ─────────────────────────────────────────────────────────────────────────────

/** chart kinds any points series can be rendered as */
export type ChartKind = 'line' | 'area' | 'band' | 'bars' | 'histogram' | 'scatter' | 'step' | 'candles';

export const CHART_KINDS: { id: ChartKind; label: string; desc: string }[] = [
  { id: 'line', label: 'line', desc: 'connected polyline — the default' },
  { id: 'area', label: 'area', desc: 'filled to the zero/base line' },
  { id: 'band', label: 'band', desc: 'point line + envelope (series band or rolling ±σ)' },
  { id: 'bars', label: 'bars', desc: 'vertical bars per sample' },
  { id: 'histogram', label: 'histogram', desc: 'value distribution of the window' },
  { id: 'scatter', label: 'scatter', desc: 'dots per sample — density visible' },
  { id: 'step', label: 'step', desc: 'staircase (regimes, discrete states)' },
  { id: 'candles', label: 'candles', desc: 'OHLC candles (candle-capable series only)' },
];

/** transforms applicable to any points series */
export type VizTransform = 'none' | 'log' | 'diff' | 'pct' | 'zscore' | 'minmax' | 'ema' | 'cum';

export const TRANSFORMS: { id: VizTransform; label: string; desc: string }[] = [
  { id: 'none', label: 'raw', desc: 'as loaded' },
  { id: 'log', label: 'log', desc: 'natural log (positive series)' },
  { id: 'diff', label: 'diff', desc: 'xₜ − xₜ₋₁' },
  { id: 'pct', label: '%chg', desc: 'per-step % change' },
  { id: 'zscore', label: 'z-score', desc: 'window mean/σ standardized' },
  { id: 'minmax', label: '0–1', desc: 'min–max of the window' },
  { id: 'ema', label: 'ema 20', desc: 'exponential smooth α=2/21' },
  { id: 'cum', label: 'cumulative', desc: 'running sum (flows → net)' },
];

export interface VizPoint {
  /** timestamp (ms) */
  t: number;
  /** the value */
  v: number;
  /** band lower / upper (fan, conformal, envelope) */
  lo?: number;
  hi?: number;
  /** candle fields (candle-capable sources only) */
  o?: number;
  h?: number;
  l?: number;
  c?: number;
}

export interface VizMatrix {
  /** row labels (drawn on the y axis) */
  rows: string[];
  /** column labels (drawn on the x axis) */
  cols: string[];
  /** values[rowIdx][colIdx] — NaN renders as a hole */
  values: number[][];
}

export interface VizSeries {
  id: string;
  label: string;
  unit?: string;
  group: string;
  kind: 'points' | 'matrix';
  points?: VizPoint[];
  matrix?: VizMatrix;
  /** hard domain the chart should respect (e.g. buy share 0..1) */
  domain?: { lo?: number; hi?: number };
  provenance: string;
  builtAt: number;
  note?: string;
}

export interface SeriesSpec {
  id: string;
  group: string;
  label: string;
  unit?: string;
  desc: string;
  /** chart kinds this series renders especially well as (any kind is allowed for points) */
  kinds?: ChartKind[];
  tags: string[];
  /** other product surfaces already consuming this data family */
  consumedBy?: string[];
  /** true when points carry o/h/l/c candle fields */
  candles?: boolean;
}

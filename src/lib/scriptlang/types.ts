// ─────────────────────────────────────────────────────────────────────────────
// VolScript — types shared by the lexer / parser / interpreter / backtest.
//
// VolScript is the Script Lab language: a Pine-Script-v5-COMPATIBLE subset
// (same syntax, same ta./math./input./strategy. namespaces) with two extensions
// this desk earns for free — orderflow-native series (delta / cvd / taker
// volume) and a deterministic vectorized engine that also runs backtests.
// ─────────────────────────────────────────────────────────────────────────────

export interface ScriptBar {
  ts: number; // bar open time, epoch ms (UTC)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // volume (base units)
  tb: number; // taker-buy volume (aggressor buys)
}

export type PlotStyle = 'line' | 'histogram' | 'area' | 'circles' | 'cross' | 'stepline' | 'column';

export interface PlotSpec {
  title: string;
  data: number[]; // aligned 1:1 with bars; NaN = gap
  color: string; // css color
  alpha: number; // 0..1
  width: number;
  style: PlotStyle;
  overlay: boolean; // true → price pane, false → sub pane
  /** plotcandle()/plotbar(): four aligned arrays instead of the scalar column */
  ohlc?: { open: number[]; high: number[]; low: number[]; close: number[] };
  /** plotcandle/plotbar use this flag (Pine distinguishes candles vs OHLC bars) */
  ohlcKind?: 'candles' | 'bars';
}

export type ShapeStyle = 'triangleup' | 'triangledown' | 'circle' | 'cross' | 'square' | 'diamond' | 'arrowup' | 'arrowdown' | 'label';

export interface ShapeSpec {
  title: string;
  cond: boolean[]; // per-bar marker
  style: ShapeStyle;
  location: 'belowbar' | 'abovebar' | 'absolute';
  color: string;
  alpha: number;
  overlay: boolean;
  /** plotchar()/label text: tiny character or short label drawn with the shape */
  text?: string;
  /** plotarrow(): the arrow height is this value (else 1 at every marked bar) */
  sizeData?: number[];
}

export interface HLineSpec {
  title: string;
  price: number; // resolved last finite value
  color: string;
  alpha: number;
  dashed: boolean;
  overlay: boolean;
}

/** fill() between two plots, two hlines, or one of each (Pine plot/hline ids). */
export interface FillSpec {
  title: string;
  /** index into plots[] / hlines[] of the two edges */
  a: { kind: 'plot' | 'hline'; index: number };
  b: { kind: 'plot' | 'hline'; index: number };
  color: string;
  alpha: number;
  overlay: boolean;
}

/** bgcolor(): per-bar full-height shading behind everything in the pane. */
export interface BackgroundSpec {
  color: string;
  alpha: number;
  /** per-bar: null = untouched, else css color for that bar */
  colors: (string | null)[];
  overlay: boolean;
}

/** barcolor(): recolor the price candles per bar (null = own color). */
export interface BarColorSpec {
  colors: (string | null)[];
  overlay: boolean;
}

export type InputType = 'int' | 'float' | 'bool' | 'string' | 'source';

export interface InputSpec {
  key: string; // unique key (title or auto index)
  title: string;
  type: InputType;
  def: number | boolean | string;
  options?: string[]; // string select choices
  minval?: number;
  maxval?: number;
  step?: number;
}

export interface TradeEvent {
  id: string;
  side: 'long' | 'short';
  entryIdx: number;
  entryPrice: number;
  exitIdx: number;
  exitPrice: number;
  pnl: number; // currency
  pnlPct: number; // percent of entry notional
  reason: 'signal' | 'stop' | 'limit' | 'reverse' | 'end';
  bars: number;
}

export interface StrategyStats {
  initialCapital: number;
  finalEquity: number;
  netProfit: number;
  netProfitPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number; // %
  profitFactor: number;
  maxDrawdownPct: number;
  sharpe: number;
  avgHoldBars: number;
  bestTradePct: number;
  worstTradePct: number;
  expectancyPct: number;
  exposurePct: number;
}

export interface BacktestResult {
  stats: StrategyStats;
  equity: number[]; // per-bar mark-to-market equity
  trades: TradeEvent[];
  markers: Array<{ idx: number; price: number; side: 'long' | 'short'; kind: 'entry' | 'exit'; reason: TradeEvent['reason'] }>;
}

export interface CompileError {
  line: number;
  col: number;
  message: string;
  stage: 'lex' | 'parse' | 'runtime';
}

export interface RunOptions {
  /** user-supplied overrides keyed by InputSpec.key */
  inputs?: Record<string, number | boolean | string>;
}

export interface RunResult {
  ok: boolean;
  error?: CompileError;
  kind: 'indicator' | 'strategy';
  title: string;
  overlay: boolean;
  plots: PlotSpec[];
  shapes: ShapeSpec[];
  hlines: HLineSpec[];
  fills: FillSpec[];
  background: BackgroundSpec | null;
  barColors: BarColorSpec | null;
  inputs: InputSpec[];
  logs: string[];
  backtest?: BacktestResult;
  runtimeMs: number;
  bars: number;
}

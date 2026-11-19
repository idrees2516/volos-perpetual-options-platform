// ─────────────────────────────────────────────────────────────────────────────
// VolScript — public entry. runScript(code, bars, inputs) → RunResult.
// Deterministic, pure, client- or server-side (no DOM, no network).
// ─────────────────────────────────────────────────────────────────────────────

import { runScript } from './internal';

export { runScript } from './internal';
export type { RunResult, RunOptions, ScriptBar, PlotSpec, ShapeSpec, HLineSpec, InputSpec, BacktestResult, StrategyStats, TradeEvent, PlotStyle } from './types';
export { SCRIPT_CATEGORIES, BUILTIN_SCRIPTS, defaultScript } from './library';

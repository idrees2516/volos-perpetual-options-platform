// ─────────────────────────────────────────────────────────────────────────────
// VolScript — built-in kernels. Pure vectorized functions over Float64Array
// series (NaN = na, exactly like Pine). Covers the ta.* family, math.*,
// plot/plotshape/hline/strategy./input.* are wired by the interpreter.
//
// Every kernel is deterministic: same bars in → same series out, so backtests
// never repaint and the AI copilot sees the same numbers the chart shows.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScriptBar } from './types';

export interface ColorObj {
  css: string;
  alpha: number;
}

export type Val = number | Float64Array | string | ColorObj | Val[];

export const COLORS: Record<string, string> = {
  teal: '#2dd4bf',
  rose: '#fb7185',
  amber: '#fbbf24',
  violet: '#a78bfa',
  sky: '#38bdf8',
  emerald: '#34d399',
  zinc: '#a1a1aa',
  white: '#e4e4e7',
  black: '#18181b',
  gray: '#8b8b96',
  red: '#f87171',
  green: '#4ade80',
  blue: '#60a5fa',
  orange: '#fb923c',
  purple: '#c084fc',
  yellow: '#facc15',
  fuchsia: '#e879f9',
  aqua: '#22d3ee',
  lime: '#a3e635',
  maroon: '#7f1d1d',
  navy: '#1e40af',
  olive: '#65a30d',
  silver: '#cbd5e1',
};

/** cycling default palette for unlabeled plot() calls */
export const PALETTE = ['teal', 'amber', 'violet', 'sky', 'rose', 'emerald', 'orange', 'zinc'];

export function colorVal(name: string, alpha = 1): ColorObj {
  return { css: COLORS[name] ?? name, alpha };
}

// ── scalar/series helpers ───────────────────────────────────────────────────

export function isSeries(v: Val): v is Float64Array {
  return v instanceof Float64Array;
}
export function isColor(v: Val): v is ColorObj {
  return typeof v === 'object' && v !== null && 'css' in (v as ColorObj) && !Array.isArray(v);
}
export function broadcast(v: number, n: number): Float64Array {
  const a = new Float64Array(n);
  a.fill(v);
  return a;
}
export function asSeries(v: Val, n: number): Float64Array {
  if (isSeries(v)) return v;
  if (typeof v === 'number') return broadcast(v, n);
  throw new Error(`expected a series or number, got ${typeof v}`);
}
export function asNum(v: Val, what = 'value'): number {
  if (typeof v === 'number') return v;
  if (isSeries(v)) return v[v.length - 1];
  throw new Error(`${what}: expected a number`);
}

// ── kernels ──────────────────────────────────────────────────────────────────

function rollSum(x: Float64Array, len: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  if (len <= 0) return out;
  let acc = 0;
  let count = 0;
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    acc += Number.isFinite(v) ? v : 0;
    valid += Number.isFinite(v) ? 1 : 0;
    count++;
    if (count > len) {
      const old = x[i - len];
      acc -= Number.isFinite(old) ? old : 0;
      valid -= Number.isFinite(old) ? 1 : 0;
      count--;
    }
    if (count === len && valid === len) out[i] = acc;
  }
  return out;
}

function sma(x: Float64Array, len: number): Float64Array {
  const s = rollSum(x, len);
  for (let i = 0; i < s.length; i++) if (Number.isFinite(s[i])) s[i] /= len;
  return s;
}

function ema(x: Float64Array, len: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  const alpha = 2 / (len + 1);
  let last = NaN;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) {
      if (Number.isFinite(last)) out[i] = last; // hold through gaps
      continue;
    }
    last = Number.isFinite(last) ? alpha * v + (1 - alpha) * last : v;
    out[i] = last;
  }
  return out;
}

/** Wilder RMA — seeded with the SMA of the first `len` finite values. */
function rma(x: Float64Array, len: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  if (len <= 0) return out;
  // find first run of `len` finite values
  let start = -1;
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(x[i])) run++;
    else run = 0;
    if (run >= len) {
      start = i - len + 1;
      break;
    }
  }
  if (start < 0) return out;
  let acc = 0;
  for (let i = start; i < start + len; i++) acc += x[i];
  let last = acc / len;
  out[start + len - 1] = last;
  for (let i = start + len; i < n; i++) {
    const v = x[i];
    if (Number.isFinite(v)) last = (last * (len - 1) + v) / len;
    out[i] = last;
  }
  return out;
}

function wma(x: Float64Array, len: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < n; i++) {
    let acc = 0;
    let ok = true;
    for (let j = 0; j < len; j++) {
      const v = x[i - len + 1 + j];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      acc += v * (j + 1);
    }
    if (ok) out[i] = acc / denom;
  }
  return out;
}

function stdev(x: Float64Array, len: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = len - 1; i < n; i++) {
    let mean = 0;
    let ok = true;
    for (let j = i - len + 1; j <= i; j++) {
      if (!Number.isFinite(x[j])) {
        ok = false;
        break;
      }
      mean += x[j];
    }
    if (!ok) continue;
    mean /= len;
    let acc = 0;
    for (let j = i - len + 1; j <= i; j++) acc += (x[j] - mean) ** 2;
    out[i] = Math.sqrt(acc / len);
  }
  return out;
}

function rollExtreme(x: Float64Array, len: number, isMax: boolean): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let best = NaN;
    let seen = false;
    for (let j = Math.max(0, i - len + 1); j <= i; j++) {
      const v = x[j];
      if (!Number.isFinite(v)) continue;
      if (!seen) {
        best = v;
        seen = true;
      } else best = isMax ? Math.max(best, v) : Math.min(best, v);
    }
    if (seen) out[i] = best;
  }
  return out;
}

function highest(x: Float64Array, len: number): Float64Array {
  return rollExtreme(x, len, true);
}
function lowest(x: Float64Array, len: number): Float64Array {
  return rollExtreme(x, len, false);
}

function cum(x: Float64Array): Float64Array {
  const out = new Float64Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(x[i])) acc += x[i];
    out[i] = acc;
  }
  return out;
}

function change(x: Float64Array, n = 1): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = n; i < x.length; i++) out[i] = x[i] - x[i - n];
  return out;
}

function rsi(x: Float64Array, len: number): Float64Array {
  const ch = change(x, 1);
  const up = new Float64Array(x.length).fill(NaN);
  const dn = new Float64Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    const v = ch[i];
    if (!Number.isFinite(v)) continue;
    up[i] = v > 0 ? v : 0;
    dn[i] = v < 0 ? -v : 0;
  }
  const au = rma(up, len);
  const ad = rma(dn, len);
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(au[i]) || !Number.isFinite(ad[i])) continue;
    if (ad[i] === 0) out[i] = au[i] === 0 ? 50 : 100;
    else {
      const rs = au[i] / ad[i];
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function trSeries(bars: ScriptBar[]): Float64Array {
  const n = bars.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (i === 0) {
      out[i] = b.h - b.l;
      continue;
    }
    out[i] = Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
  }
  return out;
}

function macd(x: Float64Array, fast: number, slow: number, sig: number): [Float64Array, Float64Array, Float64Array] {
  const ef = ema(x, fast);
  const es = ema(x, slow);
  const line = new Float64Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(ef[i]) && Number.isFinite(es[i])) line[i] = ef[i] - es[i];
  }
  const signal = ema(line, sig);
  const hist = new Float64Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(line[i]) && Number.isFinite(signal[i])) hist[i] = line[i] - signal[i];
  }
  return [line, signal, hist];
}

function crossover(a: Float64Array, b: Float64Array): Float64Array {
  const n = a.length;
  const out = new Float64Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i]) || !Number.isFinite(a[i - 1]) || !Number.isFinite(b[i - 1])) continue;
    if (a[i] > b[i] && a[i - 1] <= b[i - 1]) out[i] = 1;
  }
  return out;
}

function crossunder(a: Float64Array, b: Float64Array): Float64Array {
  const n = a.length;
  const out = new Float64Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i]) || !Number.isFinite(a[i - 1]) || !Number.isFinite(b[i - 1])) continue;
    if (a[i] < b[i] && a[i - 1] >= b[i - 1]) out[i] = 1;
  }
  return out;
}

function stoch(src: Float64Array, hi: Float64Array, lo: Float64Array, len: number): Float64Array {
  const hh = highest(hi, len);
  const ll = lowest(lo, len);
  const out = new Float64Array(src.length).fill(NaN);
  for (let i = 0; i < src.length; i++) {
    const rng = hh[i] - ll[i];
    if (!Number.isFinite(src[i]) || !Number.isFinite(rng) || rng <= 0) continue;
    out[i] = ((src[i] - ll[i]) / rng) * 100;
  }
  return out;
}

function cci(src: Float64Array, len: number): Float64Array {
  const m = sma(src, len);
  const sd = stdev(src, len);
  const out = new Float64Array(src.length).fill(NaN);
  for (let i = 0; i < src.length; i++) {
    if (!Number.isFinite(m[i]) || !Number.isFinite(sd[i])) continue;
    const denom = 0.015 * sd[i];
    out[i] = denom === 0 ? 0 : (src[i] - m[i]) / denom;
  }
  return out;
}

function vwap(bars: ScriptBar[]): Float64Array {
  const n = bars.length;
  const out = new Float64Array(n).fill(NaN);
  let cumPV = 0;
  let cumV = 0;
  let day = -1;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const d = Math.floor(b.ts / 86_400_000);
    if (d !== day) {
      day = d;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * b.v;
    cumV += b.v;
    out[i] = cumV > 0 ? cumPV / cumV : NaN;
  }
  return out;
}

function obv(bars: ScriptBar[]): Float64Array {
  const n = bars.length;
  const out = new Float64Array(n);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < n; i++) {
    const d = bars[i].c - bars[i - 1].c;
    acc += d > 0 ? bars[i].v : d < 0 ? -bars[i].v : 0;
    out[i] = acc;
  }
  return out;
}

function linreg(x: Float64Array, len: number, offset = 0): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  const sumX = (len * (len - 1)) / 2;
  const sumX2 = ((len - 1) * len * (2 * len - 1)) / 6;
  for (let i = len - 1; i < n; i++) {
    let sy = 0;
    let sxy = 0;
    let ok = true;
    for (let j = 0; j < len; j++) {
      const v = x[i - len + 1 + j];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      sy += v;
      sxy += v * j;
    }
    if (!ok) continue;
    const denom = len * sumX2 - sumX * sumX;
    const slope = denom === 0 ? 0 : (len * sxy - sumX * sy) / denom;
    const intercept = (sy - slope * sumX) / len;
    out[i] = intercept + slope * (len - 1 - offset);
  }
  return out;
}

function correlation(a: Float64Array, b: Float64Array, len: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = len - 1; i < n; i++) {
    let sa = 0;
    let sb = 0;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    let ok = true;
    for (let j = i - len + 1; j <= i; j++) {
      const va = a[j];
      const vb = b[j];
      if (!Number.isFinite(va) || !Number.isFinite(vb)) {
        ok = false;
        break;
      }
      sa += va;
      sb += vb;
      sab += va * vb;
      saa += va * va;
      sbb += vb * vb;
    }
    if (!ok) continue;
    const cov = sab - (sa * sb) / len;
    const va_ = saa - (sa * sa) / len;
    const vb_ = sbb - (sb * sb) / len;
    const denom = Math.sqrt(va_ * vb_);
    out[i] = denom === 0 ? 0 : cov / denom;
  }
  return out;
}

function percentrank(x: Float64Array, len: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = len; i < n; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) continue;
    let below = 0;
    for (let j = i - len; j < i; j++) {
      if (Number.isFinite(x[j]) && x[j] <= v) below++;
    }
    out[i] = (below / len) * 100;
  }
  return out;
}

function kama(x: Float64Array, len: number, fast = 2, slow = 30): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  const fsc = 2 / (fast + 1);
  const ssc = 2 / (slow + 1);
  let last = NaN;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) continue;
    if (!Number.isFinite(last)) {
      last = v;
      out[i] = v;
      continue;
    }
    // volatility = sum of |Δ| over `len` bars
    let vol = 0;
    let ok = true;
    for (let j = Math.max(1, i - len + 1); j <= i; j++) {
      const d = x[j] - x[j - 1];
      if (!Number.isFinite(d)) {
        ok = false;
        break;
      }
      vol += Math.abs(d);
    }
    if (!ok) {
      out[i] = last;
      continue;
    }
    const er = vol === 0 ? 1 : Math.abs(v - x[Math.max(0, i - len)]) / vol;
    const alpha = Math.pow(er * (fsc - ssc) + ssc, 2);
    last = last + alpha * (v - last);
    out[i] = last;
  }
  return out;
}

function supertrend(bars: ScriptBar[], factor: number, atrLen: number): [Float64Array, Float64Array] {
  const n = bars.length;
  const tr = trSeries(bars);
  const a = rma(tr, atrLen);
  const hl2s = new Float64Array(n);
  for (let i = 0; i < n; i++) hl2s[i] = (bars[i].h + bars[i].l) / 2;
  const finalUpper = new Float64Array(n).fill(NaN);
  const finalLower = new Float64Array(n).fill(NaN);
  const line = new Float64Array(n).fill(NaN);
  const dir = new Float64Array(n).fill(NaN);
  let d = -1; // start "up" (line below price)
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i])) continue;
    const upper = hl2s[i] + factor * a[i];
    const lower = hl2s[i] - factor * a[i];
    if (i === 0 || !Number.isFinite(finalUpper[i - 1])) {
      finalUpper[i] = upper;
      finalLower[i] = lower;
    } else {
      finalUpper[i] = upper < finalUpper[i - 1] || bars[i - 1].c > finalUpper[i - 1] ? upper : finalUpper[i - 1];
      finalLower[i] = lower > finalLower[i - 1] || bars[i - 1].c < finalLower[i - 1] ? lower : finalLower[i - 1];
    }
    if (i > 0 && Number.isFinite(dir[i - 1])) {
      if (d === -1 && bars[i].c < finalLower[i]) d = 1;
      else if (d === 1 && bars[i].c > finalUpper[i]) d = -1;
    }
    dir[i] = d;
    line[i] = d === -1 ? finalLower[i] : finalUpper[i];
  }
  return [line, dir];
}

function barssince(cond: Float64Array): Float64Array {
  const n = cond.length;
  const out = new Float64Array(n).fill(NaN);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (cond[i] !== 0 && Number.isFinite(cond[i])) last = i;
    out[i] = last >= 0 ? i - last : NaN;
  }
  return out;
}

// ── builtin table ───────────────────────────────────────────────────────────

export interface BuiltinArgs {
  pos: Val[];
  named: Record<string, Val>;
  bars: ScriptBar[];
  n: number;
  /** positional-or-named accessor: named wins when present */
  get: (index: number, name?: string) => Val | undefined;
}

export type BuiltinFn = (a: BuiltinArgs) => Val;

/** arg helpers for builtin implementations */
function mkArgs(pos: Val[], named: Record<string, Val>, bars: ScriptBar[]): BuiltinArgs {
  return {
    pos,
    named,
    bars,
    n: bars.length,
    get: (i, name) => (name !== undefined && name in named ? named[name] : pos[i]),
  };
}

function seriesArg(a: BuiltinArgs, idx: number, name: string | undefined, what: string): Float64Array {
  const v = a.get(idx, name);
  if (v === undefined) throw new Error(`${what}: missing argument '${name}'`);
  return asSeries(v, a.n);
}
function numArg(a: BuiltinArgs, idx: number, name: string | undefined, what: string, def?: number): number {
  const v = a.get(idx, name);
  if (v === undefined) {
    if (def !== undefined) return def;
    throw new Error(`${what}: missing argument '${name}'`);
  }
  const r = asNum(v, what);
  if (!Number.isFinite(r)) throw new Error(`${what}: '${name}' must be a number`);
  return r;
}
function intArg(a: BuiltinArgs, idx: number, name: string | undefined, what: string, def?: number): number {
  const v = numArg(a, idx, name, what, def);
  return Math.max(1, Math.round(v));
}

/**
 * The ta.* namespace. Every entry receives (args) and returns a series,
 * scalar, or tuple (array of series for destructuring).
 */
export const TA_BUILTINS: Record<string, BuiltinFn> = {
  sma: (a) => sma(seriesArg(a, 0, undefined, 'ta.sma'), intArg(a, 1, undefined, 'ta.sma')),
  ema: (a) => ema(seriesArg(a, 0, undefined, 'ta.ema'), intArg(a, 1, undefined, 'ta.ema')),
  wma: (a) => wma(seriesArg(a, 0, undefined, 'ta.wma'), intArg(a, 1, undefined, 'ta.wma')),
  rma: (a) => rma(seriesArg(a, 0, undefined, 'ta.rma'), intArg(a, 1, undefined, 'ta.rma')),
  rsi: (a) => rsi(seriesArg(a, 0, undefined, 'ta.rsi'), intArg(a, 1, undefined, 'ta.rsi')),
  atr: (a) => rma(trSeries(a.bars), intArg(a, 0, undefined, 'ta.atr')),
  tr: (a) => trSeries(a.bars),
  change: (a) => change(seriesArg(a, 0, undefined, 'ta.change'), intArg(a, 1, undefined, 'ta.change', 1)),
  highest: (a) => highest(seriesArg(a, 0, undefined, 'ta.highest'), intArg(a, 1, undefined, 'ta.highest')),
  lowest: (a) => lowest(seriesArg(a, 0, undefined, 'ta.lowest'), intArg(a, 1, undefined, 'ta.lowest')),
  stdev: (a) => stdev(seriesArg(a, 0, undefined, 'ta.stdev'), intArg(a, 1, undefined, 'ta.stdev')),
  sum: (a) => {
    const s = seriesArg(a, 0, undefined, 'ta.sum');
    const len = intArg(a, 1, undefined, 'ta.sum');
    // sum over window; NaN-free windows only
    const out = new Float64Array(a.n).fill(NaN);
    for (let i = len - 1; i < a.n; i++) {
      let acc = 0;
      let ok = true;
      for (let j = i - len + 1; j <= i; j++) {
        if (!Number.isFinite(s[j])) {
          ok = false;
          break;
        }
        acc += s[j];
      }
      if (ok) out[i] = acc;
    }
    return out;
  },
  cum: (a) => cum(seriesArg(a, 0, undefined, 'ta.cum')),
  crossover: (a) => crossover(seriesArg(a, 0, undefined, 'ta.crossover'), seriesArg(a, 1, undefined, 'ta.crossover')),
  crossunder: (a) => crossunder(seriesArg(a, 0, undefined, 'ta.crossunder'), seriesArg(a, 1, undefined, 'ta.crossunder')),
  cross: (a) => {
    const up = crossover(seriesArg(a, 0, undefined, 'ta.cross'), seriesArg(a, 1, undefined, 'ta.cross'));
    const dn = crossunder(seriesArg(a, 0, undefined, 'ta.cross'), seriesArg(a, 1, undefined, 'ta.cross'));
    const out = new Float64Array(a.n);
    for (let i = 0; i < a.n; i++) out[i] = up[i] !== 0 || dn[i] !== 0 ? 1 : 0;
    return out;
  },
  macd: (a) => {
    const x = seriesArg(a, 0, undefined, 'ta.macd');
    const f = intArg(a, 1, undefined, 'ta.macd', 12);
    const s = intArg(a, 2, undefined, 'ta.macd', 26);
    const g = intArg(a, 3, undefined, 'ta.macd', 9);
    return macd(x, f, s, g) as unknown as Val;
  },
  stoch: (a) =>
    stoch(
      seriesArg(a, 0, undefined, 'ta.stoch'),
      seriesArg(a, 1, undefined, 'ta.stoch'),
      seriesArg(a, 2, undefined, 'ta.stoch'),
      intArg(a, 3, undefined, 'ta.stoch'),
    ),
  cci: (a) => cci(seriesArg(a, 0, undefined, 'ta.cci'), intArg(a, 1, undefined, 'ta.cci')),
  vwap: (a) => vwap(a.bars),
  obv: (a) => obv(a.bars),
  linreg: (a) => linreg(seriesArg(a, 0, undefined, 'ta.linreg'), intArg(a, 1, undefined, 'ta.linreg'), numArg(a, 2, 'offset', 'ta.linreg', 0)),
  correlation: (a) => correlation(seriesArg(a, 0, undefined, 'ta.correlation'), seriesArg(a, 1, undefined, 'ta.correlation'), intArg(a, 2, undefined, 'ta.correlation')),
  percentrank: (a) => percentrank(seriesArg(a, 0, undefined, 'ta.percentrank'), intArg(a, 1, undefined, 'ta.percentrank')),
  percentile_rank: (a) => percentrank(seriesArg(a, 0, undefined, 'ta.percentile_rank'), intArg(a, 1, undefined, 'ta.percentile_rank')),
  kama: (a) => kama(seriesArg(a, 0, undefined, 'ta.kama'), intArg(a, 1, undefined, 'ta.kama'), intArg(a, 2, 'fast', 'ta.kama', 2), intArg(a, 3, 'slow', 'ta.kama', 30)),
  supertrend: (a) => {
    const factor = numArg(a, 0, undefined, 'ta.supertrend', 3);
    const atrLen = intArg(a, 1, undefined, 'ta.supertrend', 10);
    return supertrend(a.bars, factor, atrLen) as unknown as Val;
  },
  barssince: (a) => barssince(seriesArg(a, 0, undefined, 'ta.barssince')),
};

/** math.* namespace — scalars AND series in, matching Pine semantics. */
export const MATH_BUILTINS: Record<string, BuiltinFn> = {
  abs: (a) => map1(a, 0, Math.abs),
  max: (a) => mapN(a, (vs) => Math.max(...vs)),
  min: (a) => mapN(a, (vs) => Math.min(...vs)),
  round: (a) => {
    const prec = a.get(1) !== undefined ? asNum(a.get(1) as Val, 'math.round') : 0;
    const k = Math.pow(10, Math.max(0, Math.min(12, prec)));
    return map1(a, 0, (v) => Math.round(v * k) / k);
  },
  floor: (a) => {
    const prec = a.get(1) !== undefined ? asNum(a.get(1) as Val, 'math.floor') : 0;
    const k = Math.pow(10, Math.max(0, Math.min(12, prec)));
    return map1(a, 0, (v) => Math.floor(v * k) / k);
  },
  ceil: (a) => map1(a, 0, Math.ceil),
  pow: (a) => map2(a, Math.pow),
  sqrt: (a) => map1(a, 0, Math.sqrt),
  log: (a) => map1(a, 0, Math.log),
  log10: (a) => map1(a, 0, Math.log10),
  exp: (a) => map1(a, 0, Math.exp),
  sign: (a) => map1(a, 0, (v) => (v > 0 ? 1 : v < 0 ? -1 : 0)),
  avg: (a) => mapN(a, (vs) => vs.reduce((s, v) => s + v, 0) / vs.length),
  sum: (a) => {
    // math.sum(x, len) — rolling window sum
    const s = seriesArg(a, 0, undefined, 'math.sum');
    const len = intArg(a, 1, undefined, 'math.sum');
    const out = new Float64Array(a.n).fill(NaN);
    let acc = 0;
    let valid = 0;
    for (let i = 0; i < a.n; i++) {
      const v = s[i];
      acc += Number.isFinite(v) ? v : 0;
      valid += Number.isFinite(v) ? 1 : 0;
      if (i >= len) {
        const old = s[i - len];
        acc -= Number.isFinite(old) ? old : 0;
        valid -= Number.isFinite(old) ? 1 : 0;
      }
      if (valid === len && i >= len - 1) out[i] = acc;
    }
    return out;
  },
  to_degree: (a) => map1(a, 0, (v) => (v * 180) / Math.PI),
  to_radians: (a) => map1(a, 0, (v) => (v * Math.PI) / 180),
};

function map1(a: BuiltinArgs, idx: number, fn: (v: number) => number): Val {
  const v = a.get(idx);
  if (v === undefined) throw new Error('math: missing argument');
  if (isSeries(v)) {
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = Number.isFinite(v[i]) ? fn(v[i]) : NaN;
    return out;
  }
  const s = asNum(v);
  return fn(s);
}

function map2(a: BuiltinArgs, fn: (x: number, y: number) => number): Val {
  const l = a.get(0);
  const r = a.get(1);
  if (l === undefined || r === undefined) throw new Error('math: missing argument');
  if (isSeries(l) || isSeries(r)) {
    const ls = asSeries(l, a.n);
    const rs = asSeries(r, a.n);
    const out = new Float64Array(a.n);
    for (let i = 0; i < a.n; i++) out[i] = Number.isFinite(ls[i]) && Number.isFinite(rs[i]) ? fn(ls[i], rs[i]) : NaN;
    return out;
  }
  return fn(asNum(l), asNum(r));
}

function mapN(a: BuiltinArgs, fn: (vs: number[]) => number): Val {
  const vals = a.pos;
  if (vals.length === 0) throw new Error('math: expected at least one argument');
  if (vals.some((v) => isSeries(v))) {
    const series = vals.map((v) => asSeries(v, a.n));
    const out = new Float64Array(a.n);
    for (let i = 0; i < a.n; i++) {
      const nums: number[] = [];
      let ok = true;
      for (const s of series) {
        if (!Number.isFinite(s[i])) {
          ok = false;
          break;
        }
        nums.push(s[i]);
      }
      out[i] = ok ? fn(nums) : NaN;
    }
    return out;
  }
  return fn(vals.map((v) => asNum(v)));
}

export { mkArgs, sma, ema, rma, wma, stdev, highest, lowest, cum, change, rsi, trSeries, macd, crossover, crossunder, stoch, cci, vwap, obv, linreg, correlation, percentrank, kama, supertrend, barssince };

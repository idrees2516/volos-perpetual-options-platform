// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · indicators — the technical-indicator kernel library (V2 P2).
//
// Pure, dependency-free functions over OHLCV+taker-buy bars. Every kernel
// returns arrays ALIGNED to the input (index i answers for bar i) with `null`
// during warmup — so charts and the copilot read the exact same numbers.
//
// Families (V2 roadmap §4):
//   1. Trend / momentum : SMA · EMA · WMA · RSI · MACD · Stochastic · ADX/DMI
//                         · Aroon · Supertrend · Ichimoku
//   2. Volatility       : Bollinger · ATR · Keltner · Donchian · historical vol
//                         · BB-vs-KC squeeze
//   3. Volume / flow    : OBV · anchored VWAP · per-bar delta · CVD ·
//                         taker-buy ratio
//
// No db / no fetch in here — the store-first service lives in
// indicator-service.ts; this module is the unit-testable math.
// ─────────────────────────────────────────────────────────────────────────────

export interface Bar {
  ts: number; // bar open time, ms UTC
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // base volume
  tb: number; // taker-buy base volume (aggressor buys)
}

export type Series = (number | null)[];

// ── tiny helpers ────────────────────────────────────────────────────────────

function smaWindow(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Rolling maximum of `values` over `period` (inclusive window ending at i). */
function rollMax(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

function rollMin(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

function stdevWindow(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += values[j];
    mean /= period;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

// ── family 1 · trend / momentum ──────────────────────────────────────────────

/** Simple moving average. */
export function sma(values: number[], period: number): Series {
  return period > 0 ? smaWindow(values, period) : new Array(values.length).fill(null);
}

/** Exponential moving average — SMA(period) seed, then α·x + (1−α)·prev. */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Linearly-weighted moving average (newest bar weighs `period`). */
export function wma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += values[i - j] * (period - j);
    out[i] = acc / denom;
  }
  return out;
}

/** Wilder RSI (smoothed averages). Monotone up → 100, monotone down → 0. */
export function rsi(closes: number[], period = 14): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  line: Series;
  signal: Series;
  hist: Series;
}

/** MACD = EMA(fast) − EMA(slow); signal = EMA(macd, smooth). */
export function macd(closes: number[], fast = 12, slow = 26, smooth = 9): MacdResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line: Series = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? (emaFast[i] as number) - (emaSlow[i] as number) : null,
  );
  // signal needs the compacted (null-stripped) macd line to warm up correctly
  const firstIdx = line.findIndex((v) => v != null);
  const signal: Series = new Array(closes.length).fill(null);
  if (firstIdx >= 0) {
    const compact = line.slice(firstIdx).map((v) => v as number);
    const sig = ema(compact, smooth);
    for (let i = 0; i < sig.length; i++) signal[firstIdx + i] = sig[i];
  }
  const hist: Series = closes.map((_, i) =>
    line[i] != null && signal[i] != null ? (line[i] as number) - (signal[i] as number) : null,
  );
  return { line, signal, hist };
}

export interface StochResult {
  k: Series;
  d: Series;
}

/** Stochastic oscillator (raw %K smoothed `kSmooth`, %D = SMA of %K). */
export function stoch(bars: Bar[], period = 14, kSmooth = 3, dPeriod = 3): StochResult {
  const closes = bars.map((b) => b.c);
  const hh = rollMax(bars.map((b) => b.h), period);
  const ll = rollMin(bars.map((b) => b.l), period);
  const raw: Series = bars.map((_, i) =>
    hh[i] != null && ll[i] != null && (hh[i] as number) > (ll[i] as number)
      ? (100 * (closes[i] - (ll[i] as number))) / ((hh[i] as number) - (ll[i] as number))
      : null,
  );
  // smooth raw %K over its OWN warmup (compacted, then re-aligned)
  const firstRaw = raw.findIndex((v) => v != null);
  const k: Series = new Array(bars.length).fill(null);
  if (firstRaw >= 0) {
    const compactRaw = raw.slice(firstRaw).map((v) => v as number);
    const ks = smaWindow(compactRaw, kSmooth);
    for (let i = 0; i < ks.length; i++) k[firstRaw + i] = ks[i];
  }
  // %D = SMA of the smoothed %K (again compacted)
  const firstK = k.findIndex((v) => v != null);
  const d: Series = new Array(bars.length).fill(null);
  if (firstK >= 0) {
    const compactK = k.slice(firstK).map((v) => v as number);
    const dC = smaWindow(compactK, dPeriod);
    for (let i = 0; i < dC.length; i++) d[firstK + i] = dC[i];
  }
  return { k, d };
}

/** True range (uses previous close for gaps). */
export function trueRange(bars: Bar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const pc = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  });
}

/** Wilder-smoothed ATR. */
export function atr(bars: Bar[], period = 14): Series {
  const tr = trueRange(bars);
  const out: Series = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let acc = 0;
  for (let i = 0; i < period; i++) acc += tr[i];
  let prev = acc / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export interface AdxResult {
  adx: Series;
  plusDI: Series;
  minusDI: Series;
}

/** Wilder ADX / DMI. */
export function adx(bars: Bar[], period = 14): AdxResult {
  const n = bars.length;
  const adxOut: Series = new Array(n).fill(null);
  const plusDI: Series = new Array(n).fill(null);
  const minusDI: Series = new Array(n).fill(null);
  if (n <= period * 2) return { adx: adxOut, plusDI, minusDI };

  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(bars);

  // Wilder-smoothed accumulators (first value = simple sum, then recursive)
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += plusDM[i];
    mS += minusDM[i];
  }
  const dxs: Array<{ i: number; dx: number }> = [];
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + plusDM[i];
      mS = mS - mS / period + minusDM[i];
    }
    if (trS > 0) {
      const pdi = (100 * pS) / trS;
      const mdi = (100 * mS) / trS;
      plusDI[i] = pdi;
      minusDI[i] = mdi;
      const denom = pdi + mdi;
      dxs.push({ i, dx: denom > 0 ? (100 * Math.abs(pdi - mdi)) / denom : 0 });
    }
  }
  // ADX = Wilder smoothing of DX, seeded after `period` DX values
  if (dxs.length >= period) {
    let acc = 0;
    for (let k = 0; k < period; k++) acc += dxs[k].dx;
    let prev = acc / period;
    adxOut[dxs[period - 1].i] = prev;
    for (let k = period; k < dxs.length; k++) {
      prev = (prev * (period - 1) + dxs[k].dx) / period;
      adxOut[dxs[k].i] = prev;
    }
  }
  return { adx: adxOut, plusDI, minusDI };
}

export interface AroonResult {
  up: Series;
  down: Series;
}

/** Aroon — bars since the period-high / period-low, as a percent of period. */
export function aroon(bars: Bar[], period = 25): AroonResult {
  const n = bars.length;
  const up: Series = new Array(n).fill(null);
  const down: Series = new Array(n).fill(null);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  for (let i = period; i < n; i++) {
    let hiIdx = i;
    let loIdx = i;
    for (let j = i - period; j <= i; j++) {
      if (highs[j] >= highs[hiIdx]) hiIdx = j;
      if (lows[j] <= lows[loIdx]) loIdx = j;
    }
    up[i] = (100 * (period - (i - hiIdx))) / period;
    down[i] = (100 * (period - (i - loIdx))) / period;
  }
  return { up, down };
}

export interface SupertrendResult {
  value: Series;
  /** +1 uptrend (support below price) · −1 downtrend (resistance above). */
  dir: Series;
}

/** Supertrend (ATR trailing band, canonical formulation: final bands ratchet
 *  while the trend holds; trend flips when close crosses the opposite band). */
export function supertrend(bars: Bar[], period = 10, mult = 3): SupertrendResult {
  const n = bars.length;
  const value: Series = new Array(n).fill(null);
  const dir: Series = new Array(n).fill(null);
  const atrS = atr(bars, period);
  let fU: number | null = null; // final upper band
  let fL: number | null = null; // final lower band
  let d: number | null = null; // current trend
  for (let i = 0; i < n; i++) {
    const a = atrS[i];
    if (a == null) continue;
    const mid = (bars[i].h + bars[i].l) / 2;
    const bU = mid + mult * a;
    const bL = mid - mult * a;
    const prevC = i > 0 ? bars[i - 1].c : bars[i].c;
    fU = fU == null || bU < fU || prevC > fU ? bU : fU;
    fL = fL == null || bL > fL || prevC < fL ? bL : fL;
    if (d == null) d = bars[i].c >= mid ? 1 : -1;
    else if (d === -1 && bars[i].c > fU) d = 1;
    else if (d === 1 && bars[i].c < fL) d = -1;
    dir[i] = d;
    value[i] = d === 1 ? fL : fU;
  }
  return { value, dir };
}

export interface IchimokuResult {
  tenkan: Series;
  kijun: Series;
  senkouA: Series;
  senkouB: Series;
  chikou: Series;
}

/**
 * Ichimoku Kinko Hyo (9 / 26 / 52). Values are computed AT bar i — the cloud
 * (senkouA/B) is plotted 26 bars AHEAD and chikou 26 bars BACK; the caller
 * handles the shift. senkouA/B returned per-index are un-shifted
 * (tenkan+kijun)/2 and the 52-period midpoint.
 */
export function ichimoku(bars: Bar[], conv = 9, base = 26, spanB = 52): IchimokuResult {
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const closes = bars.map((b) => b.c);
  const midpoint = (p: number): Series => {
    const hi = rollMax(highs, p);
    const lo = rollMin(lows, p);
    return bars.map((_, i) =>
      hi[i] != null && lo[i] != null ? ((hi[i] as number) + (lo[i] as number)) / 2 : null,
    );
  };
  const tenkan = midpoint(conv);
  const kijun = midpoint(base);
  const senkouB = midpoint(spanB);
  const senkouA: Series = bars.map((_, i) =>
    tenkan[i] != null && kijun[i] != null ? ((tenkan[i] as number) + (kijun[i] as number)) / 2 : null,
  );
  const chikou: Series = closes.map((c, i) => (i + base < bars.length ? c : null));
  return { tenkan, kijun, senkouA, senkouB, chikou };
}

// ── family 2 · volatility ─────────────────────────────────────────────────────

export interface BollingerResult {
  mid: Series;
  upper: Series;
  lower: Series;
  widthPct: Series; // (upper−lower)/mid × 100
  pctB: Series; // position of close within the bands
}

/** Bollinger bands (population stdev, standard 20, 2). */
export function bollinger(closes: number[], period = 20, mult = 2): BollingerResult {
  const mid = smaWindow(closes, period);
  const sd = stdevWindow(closes, period);
  const upper: Series = closes.map((_, i) => (mid[i] != null && sd[i] != null ? (mid[i] as number) + mult * (sd[i] as number) : null));
  const lower: Series = closes.map((_, i) => (mid[i] != null && sd[i] != null ? (mid[i] as number) - mult * (sd[i] as number) : null));
  const widthPct: Series = closes.map((_, i) =>
    upper[i] != null && lower[i] != null && mid[i] != null && (mid[i] as number) !== 0
      ? (100 * ((upper[i] as number) - (lower[i] as number))) / (mid[i] as number)
      : null,
  );
  const pctB: Series = closes.map((c, i) =>
    upper[i] != null && lower[i] != null && (upper[i] as number) !== (lower[i] as number)
      ? (c - (lower[i] as number)) / ((upper[i] as number) - (lower[i] as number))
      : null,
  );
  return { mid, upper, lower, widthPct, pctB };
}

export interface KeltnerResult {
  mid: Series;
  upper: Series;
  lower: Series;
}

/** Keltner channel — EMA ± mult·ATR. */
export function keltner(bars: Bar[], period = 20, mult = 2, atrPeriod = 10): KeltnerResult {
  const mid = ema(bars.map((b) => b.c), period);
  const a = atr(bars, atrPeriod);
  const upper: Series = bars.map((_, i) => (mid[i] != null && a[i] != null ? (mid[i] as number) + mult * (a[i] as number) : null));
  const lower: Series = bars.map((_, i) => (mid[i] != null && a[i] != null ? (mid[i] as number) - mult * (a[i] as number) : null));
  return { mid, upper, lower };
}

export interface DonchianResult {
  upper: Series;
  mid: Series;
  lower: Series;
}

/** Donchian channel (N-bar high/low, mid = (hi+lo)/2). */
export function donchian(bars: Bar[], period = 20): DonchianResult {
  const upper = rollMax(bars.map((b) => b.h), period);
  const lower = rollMin(bars.map((b) => b.l), period);
  const mid: Series = bars.map((_, i) =>
    upper[i] != null && lower[i] != null ? ((upper[i] as number) + (lower[i] as number)) / 2 : null,
  );
  return { upper, mid, lower };
}

/** Annualized realized vol from stdev of log returns over `period` bars. */
export function historicalVol(closes: number[], period = 20, barsPerYear = 365 * 24): Series {
  const out: Series = new Array(closes.length).fill(null);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
    else rets.push(NaN);
  }
  for (let i = period; i < closes.length; i++) {
    const win = rets.slice(i - period, i).filter((r) => Number.isFinite(r));
    if (win.length < period) continue;
    const mean = win.reduce((s, r) => s + r, 0) / period;
    const varr = win.reduce((s, r) => s + (r - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(varr * barsPerYear);
  }
  return out;
}

/** Squeeze ON when the Bollinger band sits INSIDE the Keltner channel. */
export function squeezeOn(
  bars: Bar[],
  bbPeriod = 20,
  bbMult = 2,
  kcPeriod = 20,
  kcMult = 1.5,
): (boolean | null)[] {
  const bb = bollinger(bars.map((b) => b.c), bbPeriod, bbMult);
  const kc = keltner(bars, kcPeriod, kcMult);
  return bars.map((_, i) =>
    bb.lower[i] != null && bb.upper[i] != null && kc.lower[i] != null && kc.upper[i] != null
      ? (bb.lower[i] as number) > (kc.lower[i] as number) && (bb.upper[i] as number) < (kc.upper[i] as number)
      : null,
  );
}

// ── family 3 · volume / orderflow ─────────────────────────────────────────────

/** On-balance volume. */
export function obv(bars: Bar[]): Series {
  const out: Series = new Array(bars.length).fill(null);
  if (!bars.length) return out;
  out[0] = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = out[i - 1] as number;
    const d = bars[i].c - bars[i - 1].c;
    out[i] = d > 0 ? prev + bars[i].v : d < 0 ? prev - bars[i].v : prev;
  }
  return out;
}

/**
 * VWAP anchored at each UTC-midnight boundary (perp session), typical-price
 * weighted. Resets the moment the bar's UTC day changes.
 */
export function vwapAnchored(bars: Bar[]): Series {
  const out: Series = new Array(bars.length).fill(null);
  let day = -1;
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.floor(bars[i].ts / 86_400_000);
    if (d !== day) {
      day = d;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    cumPV += tp * bars[i].v;
    cumV += bars[i].v;
    out[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}

/** Per-bar aggressor delta = 2·takerBuy − volume (positive = buyers hit ask). */
export function deltaPerBar(bars: Bar[]): Series {
  return bars.map((b) => (Number.isFinite(b.tb) && Number.isFinite(b.v) ? 2 * b.tb - b.v : null));
}

/** Cumulative volume delta over the loaded window. */
export function cvd(bars: Bar[]): Series {
  const d = deltaPerBar(bars);
  const out: Series = new Array(bars.length).fill(null);
  let acc = 0;
  let seen = false;
  for (let i = 0; i < d.length; i++) {
    if (d[i] == null) {
      out[i] = seen ? acc : null;
      continue;
    }
    acc += d[i] as number;
    seen = true;
    out[i] = acc;
  }
  return out;
}

/** Taker-buy share of bar volume (0..1). */
export function takerBuyRatio(bars: Bar[]): Series {
  return bars.map((b) => (b.v > 0 ? b.tb / b.v : null));
}

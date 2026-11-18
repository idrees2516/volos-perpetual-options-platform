// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — indicator toolkit (pure)
//
// Classic TA indicators over plain arrays, each returning a dense series of
// `number | null` (null through the burn-in) so the projection layer can
// honestly show "not enough history yet".
//
// Two flavours:
//   • full-series functions (rsi / ema / sma / macd / percentB / atr) over the
//     observed history — used for the "now" snapshot;
//   • rolling projector states (RsiState / EmaState / MacdState / PercentBState)
//     that carry the indicator's internal recursion forward across a FORECAST
//     price path — "if price follows the forecast, here's what RSI/EMA/MACD/%B
//     will read at each future step", the exact question the projected-state
//     panel answers. Projectors never look ahead: they consume one value at a
//     time.
// ─────────────────────────────────────────────────────────────────────────────

// ── helpers ──────────────────────────────────────────────────────────────────

const isFin = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v);

/** Rolling window statistic (mean / stdev) over the last `period` values. */
function windowStats(values: number[], period: number): { mean: number; sd: number } | null {
  if (values.length < period) return null;
  const w = values.slice(values.length - period);
  let s = 0;
  for (const v of w) s += v;
  const mean = s / period;
  let ss = 0;
  for (const v of w) ss += (v - mean) * (v - mean);
  return { mean, sd: Math.sqrt(ss / period) };
}

// ── SMA ──────────────────────────────────────────────────────────────────────

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i];
    if (i >= period) s -= values[i - period];
    if (i >= period - 1) out[i] = s / period;
  }
  return out;
}

// ── EMA (SMA-seeded, classic) ────────────────────────────────────────────────

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period < 1) return out;
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i];
  e /= period;
  out[period - 1] = e;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// ── RSI (Wilder) ─────────────────────────────────────────────────────────────

export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) avgGain += d / period;
    else avgLoss += -d / period;
  }
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Rolling RSI projector: carries the FULL Wilder state through history
 *  (seed + every subsequent update), then steps through forecast closes. */
export function rsiProjector(values: number[], period = 14): (v: number) => number | null {
  if (values.length <= period) {
    return () => null;
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) avgGain += d / period;
    else avgLoss += -d / period;
  }
  // roll the state through the rest of the observed history (no look-ahead)
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  let last = values[values.length - 1];
  return (v: number) => {
    const d = v - last;
    last = v;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  };
}

// ── MACD (12, 26, 9) ─────────────────────────────────────────────────────────

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { line: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line: (number | null)[] = values.map((_, i) =>
    isFin(ef[i]) && isFin(es[i]) ? (ef[i] as number) - (es[i] as number) : null,
  );
  const firstIdx = line.findIndex(isFin);
  const compact = firstIdx < 0 ? [] : (line.slice(firstIdx).filter(isFin) as number[]);
  const sigCompact = ema(compact, signal);
  const signalOut: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < sigCompact.length; i++) {
    signalOut[firstIdx + i] = sigCompact[i];
  }
  const hist: (number | null)[] = values.map((_, i) =>
    isFin(line[i]) && isFin(signalOut[i]) ? (line[i] as number) - (signalOut[i] as number) : null,
  );
  return { line, signal: signalOut, hist };
}

/** Rolling MACD-histogram projector over a forecast price path. */
export function macdHistProjector(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): (v: number) => number | null {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const lastFast = ef[ef.length - 1];
  const lastSlow = es[es.length - 1];
  if (!isFin(lastFast) || !isFin(lastSlow)) return () => null;
  let efV = lastFast as number;
  let esV = lastSlow as number;
  const kf = 2 / (fast + 1);
  const ks = 2 / (slow + 1);
  // signal EMA over the compact MACD line (seeded by its SMA)
  const firstIdx = values.findIndex((_, i) => isFin(ef[i]) && isFin(es[i]));
  const compact: number[] = [];
  for (let i = firstIdx; i < values.length; i++) {
    if (isFin(ef[i]) && isFin(es[i])) compact.push((ef[i] as number) - (es[i] as number));
  }
  if (compact.length < signal) return () => null;
  let sig = compact.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  const kSig = 2 / (signal + 1);
  for (let i = signal; i < compact.length; i++) sig = compact[i] * kSig + sig * (1 - kSig);
  let lineV = efV - esV;
  return (v: number) => {
    efV = v * kf + efV * (1 - kf);
    esV = v * ks + esV * (1 - ks);
    lineV = efV - esV;
    sig = lineV * kSig + sig * (1 - kSig);
    return lineV - sig;
  };
}

// ── Bollinger %B (period, k·σ) ───────────────────────────────────────────────

export function percentB(values: number[], period = 20, k = 2): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const st = windowStats(values.slice(0, i + 1), period);
    if (!st || st.sd === 0) {
      out[i] = st && st.sd === 0 ? 0.5 : null;
      continue;
    }
    out[i] = (values[i] - (st.mean - k * st.sd)) / (2 * k * st.sd);
  }
  return out;
}

/** Rolling %B projector: window mean/σ recomputed including forecast values. */
export function percentBProjector(
  values: number[],
  period = 20,
  k = 2,
): (v: number) => number | null {
  if (values.length < period) return () => null;
  let window = values.slice(values.length - period);
  return (v: number) => {
    window = [...window.slice(1), v];
    let s = 0;
    for (const x of window) s += x;
    const mean = s / period;
    let ss = 0;
    for (const x of window) ss += (x - mean) * (x - mean);
    const sd = Math.sqrt(ss / period);
    if (sd === 0) return 0.5;
    return (v - (mean - k * sd)) / (2 * k * sd);
  };
}

/** Rolling EMA projector (seeded from history's final EMA state). */
export function emaProjector(values: number[], period: number): (v: number) => number | null {
  const e = ema(values, period);
  const last = e[e.length - 1];
  if (!isFin(last)) return () => null;
  let eV = last as number;
  const k = 2 / (period + 1);
  return (v: number) => {
    eV = v * k + eV * (1 - k);
    return eV;
  };
}

/** Rolling SMA projector (window queue) — mean of the last `period` values incl. v. */
export function smaProjector(values: number[], period: number): (v: number) => number | null {
  if (values.length < period - 1) return () => null;
  let queue = values.slice(Math.max(0, values.length - (period - 1)));
  return (v: number) => {
    if (queue.length === period - 1) {
      const mean = (queue.reduce((a, b) => a + b, 0) + v) / period;
      queue = [...queue.slice(1), v];
      return mean;
    }
    queue = [...queue, v];
    return queue.length === period ? (queue.reduce((a, b) => a + b, 0) + v) / period : null;
  };
}

// ── ATR (Wilder, over OHLC bars) ─────────────────────────────────────────────

export interface AtrBar {
  high: number;
  low: number;
  close: number;
}

export function atr(bars: AtrBar[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return out;
  const tr: number[] = bars.map((b, i) =>
    i === 0
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)),
  );
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < bars.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

// ── realized volatility (σ of log returns, %) ───────────────────────────────

export function realizedVolPct(closes: number[], lookback = 200): number | null {
  const v = closes.slice(-Math.max(2, lookback));
  if (v.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < v.length; i++) {
    if (v[i - 1] > 0 && v[i] > 0) rets.push(Math.log(v[i] / v[i - 1]));
  }
  if (rets.length < 2) return null;
  let s = 0;
  for (const r of rets) s += r;
  const mean = s / rets.length;
  let ss = 0;
  for (const r of rets) ss += (r - mean) * (r - mean);
  return (Math.sqrt(ss / rets.length) * 100) / Math.sqrt(v.length); // per-bar σ, %
}

// ── climatology: P(up over an h-step move) from history ──────────────────────

/**
 * Empirical share of historical h-step moves that ended up — the honest
 * base-rate "probability" from previous data, no model assumption.
 */
export function pUpClimatology(closes: number[], h: number): number | null {
  if (closes.length <= h || h < 1) return null;
  let up = 0;
  let n = 0;
  for (let i = h; i < closes.length; i++) {
    const d = closes[i] - closes[i - h];
    if (d === 0) continue;
    n++;
    if (d > 0) up++;
  }
  return n >= 8 ? up / n : null;
}

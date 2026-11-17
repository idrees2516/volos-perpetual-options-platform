// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · indicator-service — the <IndicatorChart> data source (V2 P2).
//
// Store-first, same doctrine as the correlation matrix: bars come from our own
// SQLite kline mirror (A1 backfill) whenever it has coverage at the requested
// timeframe, are AGGREGATED up from the 30m base when only that exists, and
// only fall back to a single live Binance klines call when the store is cold.
// The full curated indicator battery (roadmap §4 families 1/2/3) is computed
// server-side on those bars — UI and copilot read the same numbers.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
import { candles } from './markets';
import {
  adx,
  aroon,
  atr,
  bollinger,
  cvd,
  deltaPerBar,
  donchian,
  ema,
  historicalVol,
  ichimoku,
  keltner,
  macd,
  obv,
  rsi,
  squeezeOn,
  stoch,
  supertrend,
  takerBuyRatio,
  vwapAnchored,
  type Bar,
} from './indicators';

export const TF_SECONDS = {
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
} as const;

export type TfKey = keyof typeof TF_SECONDS;
export const TF_KEYS = Object.keys(TF_SECONDS) as TfKey[];

export interface IndicatorSnapshot {
  symbol: string;
  tf: TfKey;
  tfSec: number;
  source: 'store' | 'store-agg' | 'live' | 'store-stale';
  asOf: number;
  bars: Array<{ ts: number; o: number; h: number; l: number; c: number; v: number; tb: number }>;
  /** every series aligned 1:1 with `bars` (null during indicator warmup) */
  series: Record<string, (number | null)[]>;
  /** latest reads for the header pills */
  stats: {
    last: number | null;
    chgPctWindow: number | null;
    rsi14: number | null;
    adx14: number | null;
    trend: 'up' | 'down' | null;
    atrPct: number | null;
    hv20Ann: number | null;
    hvRatio: number | null;
    squeezeOn: boolean | null;
    cvdWindow: number | null;
    deltaLast: number | null;
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
  };
  note: string;
}

const TTL_MS = 60_000; // 1 min — chart polls at 60s, cache absorbs bursts
const g = globalThis as unknown as {
  __volquantInd?: Map<string, { hit: IndicatorSnapshot; ts: number }>;
};
const cache = g.__volquantInd ?? new Map();
g.__volquantInd = cache;

/** Round to 6 significant decimals — keeps the JSON payload tight. */
function r6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

// ── bar sources ──────────────────────────────────────────────────────────────

async function storedBars(symbol: string, tfSec: number, need: number): Promise<Bar[]> {
  const rows = await db.klineBar.findMany({
    where: { asset: symbol, tfSec },
    orderBy: { tOpen: 'desc' },
    take: need,
    select: { tOpen: true, open: true, high: true, low: true, close: true, volume: true, buyVolume: true },
  });
  return rows
    .reverse()
    .map((r) => ({ ts: r.tOpen.getTime(), o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, tb: r.buyVolume }));
}

/** Aggregate store bars from a finer base timeframe (drop incomplete buckets). */
function aggregate(base: Bar[], tfSec: number, baseSec: number): Bar[] {
  if (tfSec <= baseSec || tfSec % baseSec !== 0) return [];
  const per = tfSec / baseSec;
  const out: Bar[] = [];
  let bucket = -1;
  let acc: Bar | null = null;
  let count = 0;
  for (const b of base) {
    const bk = Math.floor(b.ts / (tfSec * 1000));
    if (bk !== bucket) {
      if (acc && count === per) out.push(acc); // complete bucket only
      bucket = bk;
      acc = { ts: bk * tfSec * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, tb: b.tb };
      count = 1;
      continue;
    }
    count++;
    if (!acc) continue; // unreachable after the first bucket, but keeps narrowing honest
    acc.h = Math.max(acc.h, b.h);
    acc.l = Math.min(acc.l, b.l);
    acc.c = b.c;
    acc.v += b.v;
    acc.tb += b.tb;
  }
  if (acc && count === per) out.push(acc);
  return out;
}

/** Trim to the newest CONTIGUOUS run — a mirror with a multi-day hole must
 *  not feed indicators across the gap (fake -14% dumps, RSI 1.6…). */
function trimContiguous(bars: Bar[], tfSec: number): Bar[] {
  const step = tfSec * 1000;
  let cut = bars.length - 1;
  while (cut > 0 && bars[cut].ts - bars[cut - 1].ts <= step * 2.5) cut--;
  return bars.slice(cut);
}

async function liveBars(symbol: string, tf: TfKey, limit: number): Promise<Bar[]> {
  // escalating backoff — the whole app shares the venue's rate budget, so a
  // burst of 418/429s from sibling panels must not blank this chart
  const delays = [0, 600, 1800];
  let lastErr: unknown = null;
  for (const d of delays) {
    if (d) await new Promise((r) => setTimeout(r, d));
    try {
      const cs = await candles(symbol, tf, Math.min(limit, 1000));
      if (cs.length) return cs.map((c) => ({ ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, tb: c.takerBuy }));
      lastErr = new Error('empty klines');
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  return [];
}

// ── the battery ──────────────────────────────────────────────────────────────

function computeBattery(bars: Bar[]): Record<string, (number | null)[]> {
  const closes = bars.map((b) => b.c);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const bb = bollinger(closes, 20, 2);
  const kc = keltner(bars, 20, 2, 10);
  const mac = macd(closes);
  const st = stoch(bars);
  const atr14 = atr(bars, 14);
  const dmi = adx(bars, 14);
  const spt = supertrend(bars, 10, 3);
  const ich = ichimoku(bars);
  const ar = aroon(bars, 14);
  const dc = donchian(bars, 20);
  const hv20 = historicalVol(closes, 20);
  const hv90 = historicalVol(closes, 90);
  const sq = squeezeOn(bars);
  const series: Record<string, (number | null)[]> = {
    ema20,
    ema50,
    ema200,
    bbMid: bb.mid,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbWidth: bb.widthPct,
    pctB: bb.pctB,
    kcUpper: kc.upper,
    kcLower: kc.lower,
    vwap: vwapAnchored(bars),
    rsi14: rsi(closes, 14),
    macdLine: mac.line,
    macdSignal: mac.signal,
    macdHist: mac.hist,
    stochK: st.k,
    stochD: st.d,
    atr14,
    adx14: dmi.adx,
    plusDI: dmi.plusDI,
    minusDI: dmi.minusDI,
    supertrend: spt.value,
    supertrendDir: spt.dir,
    tenkan: ich.tenkan,
    kijun: ich.kijun,
    senkouA: ich.senkouA,
    senkouB: ich.senkouB,
    chikou: ich.chikou,
    aroonUp: ar.up,
    aroonDown: ar.down,
    donchUpper: dc.upper,
    donchLower: dc.lower,
    hv20Ann: hv20,
    hv90Ann: hv90,
    squeeze: sq.map((v) => (v == null ? null : v ? 1 : 0)),
    obv: obv(bars),
    delta: deltaPerBar(bars),
    cvd: cvd(bars),
    tbRatio: takerBuyRatio(bars),
  };
  // trim float noise for the wire
  for (const key of Object.keys(series)) {
    series[key] = series[key].map((v) => (v == null || !Number.isFinite(v) ? null : r6(v)));
  }
  return series;
}

function last(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

function computeStats(bars: Bar[], series: Record<string, (number | null)[]>): IndicatorSnapshot['stats'] {
  const n = bars.length;
  const first = n > 1 ? bars[0].c : null;
  const lastClose = n ? bars[n - 1].c : null;
  const stDir = last(series.supertrendDir);
  const atr14 = last(series.atr14);
  const hv20 = last(series.hv20Ann);
  const hv90 = last(series.hv90Ann);
  const cvdV = last(series.cvd);
  const sqV = last(series.squeeze);
  return {
    last: lastClose,
    chgPctWindow: first != null && lastClose != null && first > 0 ? ((lastClose - first) / first) * 100 : null,
    rsi14: last(series.rsi14),
    adx14: last(series.adx14),
    trend: stDir == null ? null : stDir > 0 ? 'up' : 'down',
    atrPct: atr14 != null && lastClose ? (atr14 / lastClose) * 100 : null,
    hv20Ann: hv20,
    hvRatio: hv20 != null && hv90 != null && hv90 > 0 ? hv20 / hv90 : null,
    squeezeOn: sqV == null ? null : sqV === 1,
    cvdWindow: cvdV,
    deltaLast: series.delta?.length ? series.delta[n - 1] ?? null : null,
    ema20: last(series.ema20),
    ema50: last(series.ema50),
    ema200: last(series.ema200),
  };
}

export interface BarsResult {
  bars: Bar[];
  source: IndicatorSnapshot['source'];
  aggBase: number | null;
}

const g2 = globalThis as unknown as { __volquantBars?: Map<string, { hit: BarsResult; ts: number }> };
const barsCache = g2.__volquantBars ?? new Map();
g2.__volquantBars = barsCache;
const BARS_TTL_MS = 30_000;

/**
 * The store-first bar ladder WITHOUT the indicator battery — the Script Lab
 * data source (VolScript runs client-side, UI and AI see the same bars).
 * Ladder identical to indicatorSnapshot: native tf → 30m/1m aggregation →
 * ONE live sweep fallback, contiguous-run trim, never fake.
 */
export async function loadBars(symbol: string, tf: TfKey, limit = 500): Promise<BarsResult> {
  const maxBars = Math.max(60, Math.min(1000, limit));
  const cacheKey = `${symbol}:${tf}:${maxBars}`;
  const hit = barsCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < BARS_TTL_MS) return hit.hit;

  const tfSec = TF_SECONDS[tf];
  let bars = await storedBars(symbol, tfSec, maxBars).catch(() => [] as Bar[]);
  let source: IndicatorSnapshot['source'] = 'store';
  let aggBase: number | null = null;
  const minUsable = Math.min(maxBars, 60);
  const staleMs = Math.max(tfSec * 3 * 1000, 120_000);

  if (bars.length < minUsable) {
    for (const baseSec of [1800, 60]) {
      if (tfSec <= baseSec || tfSec % baseSec !== 0) continue;
      const need = Math.min(4000, maxBars * (tfSec / baseSec));
      const b = await storedBars(symbol, baseSec, need).catch(() => [] as Bar[]);
      const agg = aggregate(b, tfSec, baseSec);
      if (agg.length > bars.length) {
        bars = agg;
        source = 'store-agg';
        aggBase = baseSec;
      }
    }
  }

  // only the newest CONTIGUOUS run is indicator-safe (holes fabricate moves)
  const trimmed = trimContiguous(bars, tfSec);
  const fresh = trimmed.length > 0 && Date.now() - trimmed[trimmed.length - 1].ts <= staleMs;

  if (trimmed.length >= minUsable && fresh) {
    bars = trimmed;
  } else {
    const live = await liveBars(symbol, tf, maxBars).catch(() => [] as Bar[]);
    if (live.length >= 30) {
      bars = live;
      source = 'live';
      aggBase = null;
    } else if (trimmed.length >= 30) {
      bars = trimmed;
      source = 'store-stale';
    } else {
      throw new Error(
        `no kline history for ${symbol} @ ${tf} (store returned ${trimmed.length} contiguous bars and the live sweep returned ${live.length})`,
      );
    }
  }

  const result: BarsResult = { bars, source, aggBase };
  if (bars.length >= 30) barsCache.set(cacheKey, { hit: result, ts: Date.now() });
  return result;
}

/** Full indicator snapshot for one symbol/timeframe (server-cached 60 s). */
export async function indicatorSnapshot(symbol: string, tf: TfKey, limit = 240): Promise<IndicatorSnapshot> {
  const cacheKey = `${symbol}:${tf}:${limit}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.hit;

  const maxBars = Math.max(60, Math.min(500, limit));
  const tfSec = TF_SECONDS[tf];
  const { bars, source, aggBase } = await loadBars(symbol, tf, maxBars);

  const series = computeBattery(bars);
  const stats = computeStats(bars, series);

  const result: IndicatorSnapshot = {
    symbol,
    tf,
    tfSec,
    source,
    asOf: Date.now(),
    bars: bars.map((b) => ({ ts: b.ts, o: r6(b.o), h: r6(b.h), l: r6(b.l), c: r6(b.c), v: r6(b.v), tb: r6(b.tb) })),
    series,
    stats,
    note:
      source === 'store'
        ? `${bars.length} bars · native ${tf} from the SQLite kline mirror (backfill store) · battery computed server-side`
        : source === 'store-agg'
          ? `${bars.length} bars · aggregated from the ${aggBase === 60 ? '1m' : '30m'} kline mirror (${tfSec / (aggBase ?? 1)} base bars/bucket) · battery computed server-side`
          : source === 'store-stale'
            ? `${bars.length} bars · contiguous stored window (aged / backfill filling — live sweep unavailable) · battery computed server-side`
            : `${bars.length} bars · live binance klines (store cold) · battery computed server-side`,
  };

  // cache only real results — a degenerate sweep retries next call
  if (bars.length >= 30) cache.set(cacheKey, { hit: result, ts: Date.now() });
  return result;
}

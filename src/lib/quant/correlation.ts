// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · correlation — rolling cross-asset correlation matrix.
//
// Reads the A1 backfill store FIRST (KlineBar, our own SQLite mirror of
// venue klines — never re-hits exchange rate limits); falls back to a short
// live sweep (one klines call per asset) when the store is cold (fresh DB).
// Log-return Pearson on timestamp-aligned closes; horizons 7d/30d/90d.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
import { candles } from './markets';
import { alignSeries, pearson } from './heatmap';
import { OF_ASSETS } from '@/lib/orderflow/catalog';
import type { OfAsset } from '@/lib/orderflow/types';

export interface CorrelationResult {
  asOf: number;
  window: '7d' | '30d' | '90d';
  tfSec: number;
  source: 'store' | 'live';
  barsUsed: number;
  assets: string[];
  matrix: (number | null)[][];
  vsBtc: { symbol: string; r: number | null }[];
  avgAbsCorrelation: number | null;
  note: string;
}

const TTL_MS = 5 * 60_000;
const HORIZONS = {
  '7d': { tfSec: 1800, days: 7 }, // 30m bars → ~336
  '30d': { tfSec: 1800, days: 30 }, // 30m bars → ~1440
  '90d': { tfSec: 86400, days: 90 }, // 1d bars → 90 (live fallback only; store has 30m)
} as const;

const g = globalThis as unknown as { __volquantCorr?: Map<string, { hit: CorrelationResult; ts: number }> };
const cache = g.__volquantCorr ?? new Map();
g.__volquantCorr = cache;

function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

async function storedCloses(assets: OfAsset[], tfSec: number, fromMs: number): Promise<Array<Map<number, number>>> {
  return Promise.all(
    assets.map(async (asset) => {
      const rows = await db.klineBar.findMany({
        where: { asset, tfSec, tOpen: { gte: new Date(fromMs) } },
        orderBy: { tOpen: 'asc' },
        select: { tOpen: true, close: true },
      });
      const m = new Map<number, number>();
      for (const r of rows) m.set(r.tOpen.getTime(), r.close);
      return m;
    }),
  );
}

async function liveCloses(assets: OfAsset[], interval: string, limit: number): Promise<Array<Map<number, number>>> {
  // staggered small batches — polite to the venue even on cold starts
  const out: Array<Map<number, number>> = [];
  const BATCH = 3;
  for (let i = 0; i < assets.length; i += BATCH) {
    const chunk = assets.slice(i, i + BATCH);
    const maps = await Promise.all(
      chunk.map(async (asset) => {
        const bars = await candles(asset, interval, limit).catch(() => []);
        return new Map<number, number>(bars.map((b): [number, number] => [b.ts, b.c]));
      }),
    );
    out.push(...maps);
    if (i + BATCH < assets.length) await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

function build(assets: string[], rets: number[][]): Pick<CorrelationResult, 'matrix' | 'vsBtc' | 'avgAbsCorrelation'> {
  const n = assets.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
  for (let i = 0; i < n; i++) {
    matrix[i][i] = rets[i].length >= 3 ? 1 : null;
    for (let j = i + 1; j < n; j++) {
      const r = pearson(rets[i], rets[j]);
      matrix[i][j] = r;
      matrix[j][i] = r;
    }
  }
  const btcIdx = assets.indexOf('BTC');
  const vsBtc =
    btcIdx >= 0
      ? assets.map((symbol, i) => ({ symbol, r: i === btcIdx ? 1 : matrix[i][btcIdx] }))
      : [];
  const pairs = matrix.flatMap((row, i) => row.slice(i + 1)).filter((v): v is number => v != null);
  const avgAbsCorrelation = pairs.length ? pairs.reduce((s, v) => s + Math.abs(v), 0) / pairs.length : null;
  return { matrix, vsBtc, avgAbsCorrelation };
}

/** Rolling cross-asset correlation for the desk's 8 majors (server-cached 5 min). */
export async function marketCorrelation(window: keyof typeof HORIZONS = '30d'): Promise<CorrelationResult> {
  const hit = cache.get(window);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.hit;

  const { tfSec, days } = HORIZONS[window];
  const fromMs = Date.now() - days * 86_400_000;
  const assets = [...OF_ASSETS];
  const needBars = Math.min(180, Math.round((days * 86_400_000) / (tfSec * 1000)));

  // store first — the backfill mirror (30m bars, tOpen-aligned)
  let series = await storedCloses(assets, tfSec, fromMs);
  let source: 'store' | 'live' = 'store';
  let enoughStored = series.every((s) => s.size >= needBars * 0.8);

  // cold store (fresh DB / environment reset) → short live sweep, same shape
  if (!enoughStored) {
    const interval = window === '90d' ? '1d' : '30m';
    const limit = Math.min(1000, Math.round((days * 86_400_000) / (interval === '1d' ? 86_400_000 : 1_800_000)));
    series = await liveCloses(assets, interval, limit);
    source = 'live';
  }

  // one failed sweep (venue hiccup / rate-limit burst) must NOT poison the
  // whole matrix — correlate the assets that DID return bars
  const goodIdx: number[] = [];
  series.forEach((s, i) => {
    if (s.size >= 24) goodIdx.push(i);
  });
  const goodAssets = goodIdx.map((i) => assets[i]);
  const goodSeries = goodIdx.map((i) => series[i]);
  const dropped = assets.length - goodAssets.length;

  const { ts, cols } = alignSeries(goodSeries);
  const rets = cols.map((c) => logReturns(c.filter((v) => Number.isFinite(v))));
  const barsUsed = ts.length;
  const { matrix, vsBtc, avgAbsCorrelation } = build(goodAssets, rets);

  const result: CorrelationResult = {
    asOf: Date.now(),
    window,
    tfSec: source === 'live' ? (window === '90d' ? 86_400 : 1_800) : tfSec,
    source,
    barsUsed,
    assets: goodAssets,
    matrix,
    vsBtc,
    avgAbsCorrelation,
    note:
      source === 'store'
        ? `pearson on log returns · ${goodAssets.length} majors × ${barsUsed} aligned ${tfSec / 60}m bars from the SQLite kline mirror (backfill store)`
        : `pearson on log returns · ${goodAssets.length} majors × ${barsUsed} aligned live bars (store cold — one klines call per asset, cached 5 min)`,
  };
  if (dropped > 0) {
    result.note += ` · ${dropped} asset${dropped > 1 ? 's' : ''} dropped (sweep returned no bars — will rejoin next refresh)`;
  }

  // cache only real results — a degenerate sweep (venue hiccup) retries next call
  if (barsUsed >= 10) cache.set(window, { hit: result, ts: Date.now() });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · funding-grid — the "where is the leverage" map.
//
// Rows = the desk's majors; columns = the last N 8-hour funding events
// (window 7d | 30d); cells = funding APR, annualized from the 8h rate
// (rate × 3 × 365). Teal = shorts pay longs (negative funding), rose =
// longs pay shorts (crowded-long leverage).
//
// STORE FIRST: the A1 backfill mirror (DerivativesPoint, kind = funding)
// is read before any venue call — history never re-hits rate limits. When
// the store is cold (fresh DB / reset) a live sweep takes over: one
// fapi/v1/fundingRate call per asset, staggered in batches of 3 with
// 150 ms gaps. A single failed sweep drops that one ASSET (row) from the
// grid instead of poisoning every cell — it rejoins on the next refresh.
// Server-cached 5 min; a degenerate sweep (fewer than 2 usable rows) is
// never cached so the next poll retries.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
import { fundingHistory } from './markets';
import { OF_ASSETS } from '@/lib/orderflow/catalog';
import type { OfAsset } from '@/lib/orderflow/types';

export type FundingWindow = '7d' | '30d';

export interface FundingRow {
  symbol: string;
  latestAprPct: number | null;
  meanAprPct: number | null;
  minAprPct: number | null;
  maxAprPct: number | null;
  points: number;
}

export interface FundingGridResult {
  asOf: number;
  window: FundingWindow;
  source: 'store' | 'live';
  venue: string;
  assets: string[];
  /** 8h bucket starts (UTC ms), ascending — the grid's time axis. */
  times: number[];
  /** [asset][time] → funding APR in percent (null = no observation). */
  aprPct: (number | null)[][];
  rows: FundingRow[];
  stats: {
    avgAprPct: number | null;
    longsPay: number; // rows with latest > +1% APR
    shortsPay: number; // rows with latest < −1% APR
    hottest: { symbol: string; aprPct: number } | null; // most crowded long
    coldest: { symbol: string; aprPct: number } | null; // shorts paying most
  };
  note: string;
}

const TTL_MS = 5 * 60_000;
const HORIZONS: Record<FundingWindow, { days: number; maxCols: number }> = {
  '7d': { days: 7, maxCols: 21 },
  '30d': { days: 30, maxCols: 60 }, // stride-skipped to ≤60 columns
};
const FUND_INTERVAL_MS = 8 * 3_600_000;

const g = globalThis as unknown as { __volquantFunding?: Map<FundingWindow, { hit: FundingGridResult; ts: number }> };
const cache = g.__volquantFunding ?? new Map();
g.__volquantFunding = cache;

// ── pure grid assembly (unit-tested) ────────────────────────────────────────

export interface AssetPoints {
  symbol: string;
  points: { ts: number; rate: number }[]; // 8h funding rate, fraction
}

/** Bucket a funding timestamp to its 8h event start (UTC). */
export function fundingBucket(ts: number): number {
  return Math.floor(ts / FUND_INTERVAL_MS) * FUND_INTERVAL_MS;
}

/** rate (per-8h fraction) → annualized APR percent. */
export function aprPct(rate: number): number {
  return rate * 3 * 365 * 100;
}

export interface AssembledGrid {
  times: number[];
  assets: string[];
  aprPct: (number | null)[][];
  rows: FundingRow[];
  stats: FundingGridResult['stats'];
}

/**
 * Assemble the heat grid from per-asset funding points: union 8h time axis
 * (right-capped at `maxCols` by striding), per-asset row stats and the
 * cross-asset census. Assets with too few points (< 4) are dropped rows.
 */
export function assembleFundingGrid(byAsset: AssetPoints[], maxCols: number): AssembledGrid {
  const good = byAsset.filter((a) => a.points.length >= 4);
  const times = [
    ...new Set(
      good.flatMap((a) => a.points.map((p) => fundingBucket(p.ts))),
    ),
  ].sort((a, b) => a - b);

  let stride = 1;
  while (times.length / stride > maxCols) stride *= 2;
  const cols = times.filter((_, i) => i % stride === 0);

  const rowMaps = good.map((a) => {
    const m = new Map<number, number>();
    for (const p of a.points) m.set(fundingBucket(p.ts), aprPct(p.rate));
    return m;
  });

  const cells: (number | null)[][] = rowMaps.map((m) => cols.map((t) => (m.has(t) ? m.get(t)! : null)));

  const rows: FundingRow[] = good.map((a, i) => {
    const vals = a.points.map((p) => aprPct(p.rate)).sort((x, y) => x - y);
    const latest = vals.length ? aprPct(a.points[a.points.length - 1].rate) : null;
    return {
      symbol: a.symbol,
      latestAprPct: Number.isFinite(latest!) ? latest : null,
      meanAprPct: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null,
      minAprPct: vals.length ? vals[0] : null,
      maxAprPct: vals.length ? vals[vals.length - 1] : null,
      points: a.points.length,
    };
  });

  const latestRows = rows.filter((r) => r.latestAprPct != null) as Array<{ symbol: string; latestAprPct: number }>;
  const avgAprPct = latestRows.length ? latestRows.reduce((s, r) => s + r.latestAprPct, 0) / latestRows.length : null;
  const sorted = [...latestRows].sort((a, b) => b.latestAprPct - a.latestAprPct);

  return {
    times: cols,
    assets: good.map((a) => a.symbol),
    aprPct: cells,
    rows,
    stats: {
      avgAprPct,
      longsPay: latestRows.filter((r) => r.latestAprPct > 1).length,
      shortsPay: latestRows.filter((r) => r.latestAprPct < -1).length,
      hottest: sorted[0] ? { symbol: sorted[0].symbol, aprPct: sorted[0].latestAprPct } : null,
      coldest: sorted.length > 1 ? { symbol: sorted[sorted.length - 1].symbol, aprPct: sorted[sorted.length - 1].latestAprPct } : null,
    },
  };
}

// ── data sources ────────────────────────────────────────────────────────────

async function storedPoints(assets: readonly OfAsset[], fromMs: number): Promise<AssetPoints[]> {
  return Promise.all(
    assets.map(async (asset) => {
      const rows = await db.derivativesPoint.findMany({
        where: { venue: 'binance', asset, kind: 'funding', ts: { gte: new Date(fromMs) } },
        orderBy: { ts: 'asc' },
        select: { ts: true, value: true },
      });
      return { symbol: asset, points: rows.map((r) => ({ ts: r.ts.getTime(), rate: r.value })) };
    }),
  );
}

async function livePoints(assets: readonly OfAsset[], limit: number): Promise<AssetPoints[]> {
  // staggered batches of 3 — polite to the venue even on cold starts
  const out: AssetPoints[] = [];
  const BATCH = 3;
  for (let i = 0; i < assets.length; i += BATCH) {
    const chunk = assets.slice(i, i + BATCH);
    const got = await Promise.all(
      chunk.map(async (asset) => {
        const pts = await fundingHistory(asset, limit).catch(() => [] as { ts: number; rate: number }[]);
        return { symbol: asset, points: pts };
      }),
    );
    out.push(...got);
    if (i + BATCH < assets.length) await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

/** Funding heat grid for the desk's majors (server-cached 5 min per window). */
export async function fundingGrid(window: FundingWindow = '7d'): Promise<FundingGridResult> {
  const hit = cache.get(window);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.hit;

  const { days, maxCols } = HORIZONS[window];
  const fromMs = Date.now() - days * 86_400_000;
  const assets = [...OF_ASSETS];
  const need = Math.floor((days * 86_400_000) / FUND_INTERVAL_MS);

  // store first — the backfill mirror (never re-hits the venue)
  let series = await storedPoints(assets, fromMs);
  let source: 'store' | 'live' = 'store';
  const enoughStored = series.every((a) => a.points.length >= Math.max(4, need * 0.6));

  // cold store (fresh DB / environment reset) → live sweep, same shape
  if (!enoughStored) {
    series = await livePoints(assets, Math.min(1000, need));
    source = 'live';
  }

  const dropped = assets.length - series.filter((a) => a.points.length >= 4).length;
  const assembled = assembleFundingGrid(series, maxCols);

  const result: FundingGridResult = {
    asOf: Date.now(),
    window,
    source,
    venue: 'binance-fapi',
    assets: assembled.assets,
    times: assembled.times,
    aprPct: assembled.aprPct,
    rows: assembled.rows,
    stats: assembled.stats,
    note:
      source === 'store'
        ? `funding APR heat · ${assembled.assets.length} majors × ${assembled.times.length} 8h events from the SQLite derivatives mirror (backfill store)`
        : `funding APR heat · ${assembled.assets.length} majors × ${assembled.times.length} 8h events (store cold — one fundingRate call per asset, cached 5 min)`,
  };
  if (dropped > 0) {
    result.note += ` · ${dropped} asset${dropped > 1 ? 's' : ''} dropped (no funding history returned — rejoin next refresh)`;
  }

  // cache only real grids — a degenerate sweep retries on the next poll
  if (assembled.assets.length >= 2 && assembled.times.length >= 3) cache.set(window, { hit: result, ts: Date.now() });
  return result;
}

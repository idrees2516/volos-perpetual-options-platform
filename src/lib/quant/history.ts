// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · history — snapshot persistence.
//
// Every ~2 minutes the engine writes a QuantSnapshot row (SQLite via Prisma):
// total GEX, HVL/call wall/put support, max pain, CM30 IV, OI, PCR — the
// GEX-history / OI-history / stress-history (long-window level ranges) that
// BackQuant served from Postgres, computed here from our own live data.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
import { getChainSnapshot } from './engine';
import { getPerpBundle } from './perps';

const SNAP_MS = 2 * 60_000; // snapshot cadence
const SYMBOLS = ['BTC', 'ETH'] as const;

const g = globalThis as unknown as { __volquantHist?: { timer: ReturnType<typeof setInterval> | null; last: Map<string, number> } };
const hist = g.__volquantHist ?? { timer: null, last: new Map<string, number>() };
g.__volquantHist = hist;

async function writeSnapshot(symbol: string) {
  try {
    const snap = await getChainSnapshot(symbol, 30_000);
    const perp = await getPerpBundle(symbol, 30_000).catch(() => null);
    await db.quantSnapshot.create({
      data: {
        symbol,
        ts: new Date(),
        spot: snap.spot,
        totalGexUsd1pct: snap.levels.totalGexUsd1pct,
        callGexUsd1pct: snap.levels.callGexUsd1pct,
        putGexUsd1pct: snap.levels.putGexUsd1pct,
        hvl: snap.levels.hvl,
        callWall: snap.levels.callWall,
        putSupport: snap.levels.putSupport,
        maxPain: snap.levels.maxPain,
        atmIv30: Number.isFinite(snap.atmIv30) ? snap.atmIv30 * 100 : null,
        totalOiContracts: snap.rows.reduce((s, r) => s + r.oi, 0),
        totalOiNotionalUsd: snap.totalOiUsd,
        putCallRatioOi: snap.putCallRatioOi,
        perpOiUsd: perp?.oiUsdTotal ?? null,
        fundingRate: perp?.fundingRate ?? null,
        dataJson: JSON.stringify({
          topStrikes: snap.levels.topStrikes.slice(0, 6),
          regime: snap.levels.regime,
          iv30vsRv30: snap.iv30vsRv30,
          volumeUsd24h: snap.totalVolumeUsd24h,
        }),
      },
    });
    hist.last.set(symbol, Date.now());
    // retention: keep ~30 days per symbol
    const cutoff = new Date(Date.now() - 30 * 864e5);
    await db.quantSnapshot.deleteMany({ where: { symbol, ts: { lt: cutoff } } });
  } catch (e) {
    console.error(`[volquant/history] snapshot ${symbol} failed:`, e instanceof Error ? e.message : e);
  }
}

/** Start the snapshot writer (idempotent). */
export function ensureHistory() {
  if (hist.timer) return;
  for (const s of SYMBOLS) void writeSnapshot(s);
  hist.timer = setInterval(() => {
    for (const s of SYMBOLS) void writeSnapshot(s);
  }, SNAP_MS);
}

export interface HistorySeries {
  symbol: string;
  metric: 'gex' | 'oi' | 'stress';
  points: { ts: number; value: number }[];
  meta: Record<string, unknown>;
}

export async function history(symbol: string, metric: 'gex' | 'oi' | 'stress', days = 7): Promise<HistorySeries> {
  ensureHistory();
  const since = new Date(Date.now() - days * 864e5);
  const rows = await db.quantSnapshot.findMany({
    where: { symbol, ts: { gte: since } },
    orderBy: { ts: 'asc' },
    take: 4000,
  });
  if (metric === 'gex') {
    return {
      symbol,
      metric,
      points: rows.map((r) => ({ ts: r.ts.getTime(), value: r.totalGexUsd1pct })),
      meta: { unit: 'USD per 1% move', regime: (rows.at(-1)?.totalGexUsd1pct ?? 0) >= 0 ? 'long-gamma' : 'short-gamma', snapshots: rows.length },
    };
  }
  if (metric === 'oi') {
    return {
      symbol,
      metric,
      points: rows.map((r) => ({ ts: r.ts.getTime(), value: r.totalOiNotionalUsd })),
      meta: { unit: 'USD notional', snapshots: rows.length },
    };
  }
  // stress: long-window level ranges (HVL / walls percentiles)
  const hvls = rows.map((r) => r.hvl).filter((v): v is number => v != null);
  const walls = rows.map((r) => r.callWall).filter((v): v is number => v != null);
  const supports = rows.map((r) => r.putSupport).filter((v): v is number => v != null);
  const pct = (arr: number[], p: number) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };
  return {
    symbol,
    metric,
    points: rows.map((r) => ({ ts: r.ts.getTime(), value: r.hvl ?? NaN })),
    meta: {
      unit: 'price level',
      hvlRange: [pct(hvls, 5), pct(hvls, 95)],
      callWallRange: [pct(walls, 5), pct(walls, 95)],
      putSupportRange: [pct(supports, 5), pct(supports, 95)],
      snapshots: rows.length,
    },
  };
}

/** Dealer hedge-flow estimate series from consecutive snapshots. */
export async function dealerFlow(symbol: string, days = 3) {
  ensureHistory();
  const rows = await db.quantSnapshot.findMany({
    where: { symbol, ts: { gte: new Date(Date.now() - days * 864e5) } },
    orderBy: { ts: 'asc' },
    take: 4000,
  });
  const out: { ts: number; hedgeFlowUsd: number; spot: number; gex: number }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const pctMove = (cur.spot - prev.spot) / prev.spot * 100;
    // dealers long gamma SELL rallies / BUY dips: flow = −GEX × %move
    const flow = -(prev.totalGexUsd1pct) * pctMove;
    out.push({ ts: cur.ts.getTime(), hedgeFlowUsd: flow, spot: cur.spot, gex: cur.totalGexUsd1pct });
  }
  return { symbol, points: out, model: 'estimated: hedgeFlow = −GEX(USD/1%) × Δspot% — dealers long gamma sell rallies, buy dips' };
}

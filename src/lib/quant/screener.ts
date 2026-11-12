// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · screener — the WHOLE-MARKET scanner.
//
// Every tradable symbol (BTC/ETH with full options analytics, SOL perps)
// side-by-side: spot momentum, crowding (funding percentile), positioning
// (GEX regime, HVL distance), vol pricing (IV vs RV), flow (tape aggression)
// and liquidation magnets — with cross-symbol z-scores and leaderboards so
// the user sees the entire market on one screen and clicks into the best
// setup. This replaces "check another platform for the other asset".
// ─────────────────────────────────────────────────────────────────────────────

import { getChainSnapshot } from './engine';
import { getPerpBundle } from './perps';
import { candles } from './markets';
import { realizedVol } from './math';
import { ensureTape, tapeAggregates } from './tape';
import { decisionBrief } from './signals';
import type { ChainSnapshot, QuantSymbol } from './types';

export interface ScreenerRow {
  symbol: string;
  spot: number;
  chg48hPct: number;
  chg24hPct: number;
  spark: number[];
  perpOiUsd: number;
  fundingApr: number;
  fundingPctile: number | null;
  basisPct: number;
  rv30Pct: number;
  options: boolean;
  iv30Pct: number | null;
  vrpPct: number | null;
  ivRank: number | null;
  pcrOi: number | null;
  gexRegime: string | null;
  netGexUsd1pct: number | null;
  hvlDistPct: number | null;
  em1sPct: number | null;
  tape12hUsd: number | null;
  tapeImbalance: number | null;
  liqAbovePct: number | null;
  liqBelowPct: number | null;
  regimeScore: number;
  regimeLabel: string;
  z: Record<string, number>;
}

export interface ScreenerResult {
  asOf: number;
  rows: ScreenerRow[];
  rankings: { label: string; symbol: string; value: number; format: string }[];
  note: string;
}

const SYMBOLS: QuantSymbol[] = ['BTC', 'ETH', 'SOL'];

export async function marketScreener(): Promise<ScreenerResult> {
  const rowsRaw = await Promise.all(SYMBOLS.map((s) => oneRow(s)));
  const rows = rowsRaw.filter((r): r is ScreenerRow => r !== null);

  // ── cross-symbol z-scores on comparable metrics ────────────────────────────
  const metrics: (keyof ScreenerRow)[] = ['chg24hPct', 'fundingApr', 'basisPct', 'rv30Pct', 'iv30Pct', 'vrpPct', 'pcrOi', 'tapeImbalance', 'netGexUsd1pct', 'em1sPct'];
  for (const m of metrics) {
    const vals = rows.map((r) => r[m]).filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length < 2) continue;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
    for (const r of rows) {
      const raw = r[m];
      const v = raw != null ? Number(raw) : NaN;
      r.z[m as string] = Number.isFinite(v) ? Math.round(((v - mean) / sd) * 100) / 100 : 0;
    }
  }

  const pick = (label: string, key: keyof ScreenerRow, dir: 'max' | 'min', format: (v: number) => string) => {
    const cand = rows.filter((r) => r[key] != null && Number.isFinite(Number(r[key])));
    if (!cand.length) return null;
    const best = cand.reduce((a, b) => (dir === 'max' ? (Number(b[key]) > Number(a[key]) ? b : a) : Number(b[key]) < Number(a[key]) ? b : a));
    return { label, symbol: best.symbol, value: Number(best[key]), format: format(Number(best[key])) };
  };
  const rankings = [
    pick('hottest 24h', 'chg24hPct', 'max', (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`),
    pick('coldest 24h', 'chg24hPct', 'min', (v) => `${v.toFixed(2)}%`),
    pick('most crowded (funding)', 'fundingApr', 'max', (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}% APR`),
    pick('cheapest vol (IV)', 'iv30Pct', 'min', (v) => `${v.toFixed(1)}%`),
    pick('richest vol (IV)', 'iv30Pct', 'max', (v) => `${v.toFixed(1)}%`),
    pick('best VRP (sell vol)', 'vrpPct', 'max', (v) => `+${v.toFixed(1)} pts`),
    pick('worst VRP (buy vol)', 'vrpPct', 'min', (v) => `${v.toFixed(1)} pts`),
    pick('most call-heavy tape', 'tapeImbalance', 'max', (v) => `${(v * 100).toFixed(0)}% net buy`),
    pick('most put-heavy tape', 'tapeImbalance', 'min', (v) => `${(v * 100).toFixed(0)}% net sell`),
    pick('longest gamma', 'netGexUsd1pct', 'max', (v) => `$${(v / 1e6).toFixed(1)}M/1%`),
    pick('shortest gamma', 'netGexUsd1pct', 'min', (v) => `$${(v / 1e6).toFixed(1)}M/1%`),
  ].filter((r): r is { label: string; symbol: string; value: number; format: string } => r !== null);

  return {
    asOf: Date.now(),
    rows,
    rankings,
    note: 'z-scores computed cross-symbol on live metrics — click a row to focus that market in every Quant Lab tab',
  };
}

async function oneRow(symbol: QuantSymbol): Promise<ScreenerRow | null> {
  try {
    const hasOpts = symbol === 'BTC' || symbol === 'ETH';
    const [perp, brief, dailyCandles] = await Promise.all([
      getPerpBundle(symbol),
      decisionBrief(symbol),
      candles(symbol, '1d', 31).catch(() => [] as { c: number }[]),
    ]);
    // true 30d realized vol (percent) from daily candles; fallback to the perp
    // bundle's shorter-window estimate if daily candles are unavailable
    const rv30 = dailyCandles.length >= 10 ? realizedVol(dailyCandles.map((c) => c.c)) * 100 : perp.rv30Pct;
    const candles5m = perp.candles.map((c) => ({ ts: c.ts, c: c.c }));
    const last = candles5m.at(-1)?.c ?? perp.spot;
    // bundle exposes the trailing 288 5m bars = 24h
    const chg24h = candles5m.length >= 288 ? ((last - candles5m[0].c) / candles5m[0].c) * 100 : NaN;
    const dailyCloses = dailyCandles.map((c) => c.c);
    const chg48h = dailyCloses.length >= 3 ? ((dailyCloses[dailyCloses.length - 1] - dailyCloses[dailyCloses.length - 3]) / dailyCloses[dailyCloses.length - 3]) * 100 : Number.isFinite(chg24h) ? chg24h : 0;

    let snap: ChainSnapshot | null = null;
    if (hasOpts) {
      snap = await getChainSnapshot(symbol, 30_000).catch(() => null);
      if (snap) ensureTape(symbol);
    }
    const tape = snap ? await tapeAggregates(symbol, 12).catch(() => null) : null;

    const above = perp.liquidationClusters.filter((c) => c.price > perp.spot).sort((a, b) => a.price - b.price)[0];
    const below = perp.liquidationClusters.filter((c) => c.price < perp.spot).sort((a, b) => b.price - a.price)[0];

    return {
      symbol,
      spot: perp.spot,
      chg48hPct: Number.isFinite(chg48h) ? chg48h : 0,
      chg24hPct: Number.isFinite(chg24h) ? chg24h : 0,
      spark: candles5m.slice(-96).map((c) => c.c),
      perpOiUsd: perp.oiUsdTotal,
      fundingApr: perp.fundingApr,
      fundingPctile: brief.context.fundingPctile,
      basisPct: perp.perpBasisPct * 100,
      rv30Pct: rv30,
      options: Boolean(snap),
      iv30Pct: snap ? snap.iv30vsRv30.iv30Pct : null,
      vrpPct: snap ? snap.iv30vsRv30.vrpPct : null,
      ivRank: brief.context.ivRank,
      pcrOi: snap ? snap.putCallRatioOi : null,
      gexRegime: snap ? snap.levels.regime : null,
      netGexUsd1pct: snap ? snap.levels.totalGexUsd1pct : null,
      hvlDistPct: snap?.levels.hvl ? ((perp.spot - snap.levels.hvl) / snap.levels.hvl) * 100 : null,
      em1sPct: snap?.expectedMoves[0]?.oneSigmaPct ?? null,
      tape12hUsd: tape ? tape.premiumUsd : null,
      tapeImbalance: tape ? tape.imbalance : null,
      liqAbovePct: above ? ((above.price - perp.spot) / perp.spot) * 100 : null,
      liqBelowPct: below ? ((below.price - perp.spot) / perp.spot) * 100 : null,
      regimeScore: brief.regimeScore,
      regimeLabel: brief.regimeLabel,
      z: {},
    };
  } catch (e) {
    console.error(`[volquant/screener] ${symbol} failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

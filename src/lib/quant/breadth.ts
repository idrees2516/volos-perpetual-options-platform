// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · breadth — the whole-market map behind the breadth treemap.
//
// ONE ticker call + ONE funding call (Binance fapi, weight 40 + 10) sweep the
// entire USDT-perp universe; the treemap tiles are sized by 24h quote volume
// and colored by 24h change / funding APR / relative volume. Breadth stats
// (advancers vs decliners, turnover concentration) come free from the same
// sweep. Cached 15 s on the server singleton — a full treemap poll costs two
// REST hits per refresh, rate-limit safe by design.
// ─────────────────────────────────────────────────────────────────────────────

import { fundingAll, tickers24h } from './markets';

export interface BreadthTile {
  symbol: string; // BTC, SOL, PEPE… (USDT stripped)
  lastPrice: number;
  change24hPct: number;
  volume24hUsd: number;
  volumeShare: number; // fraction of tracked turnover
  trades24h: number;
  fundingApr: number | null; // annualized from the 8h rate (×3×365)
}

export interface BreadthResult {
  asOf: number;
  tracked: number;
  universe: number;
  tiles: BreadthTile[];
  stats: {
    advancers: number;
    decliners: number;
    unchanged: number;
    turnoverUsd: number;
    medianChangePct: number;
    avgFundingApr: number | null; // volume-weighted across tiles with funding
    topGainer: { symbol: string; changePct: number } | null;
    topLoser: { symbol: string; changePct: number } | null;
    btcDominance: number; // BTC turnover share of tracked universe
    ethDominance: number;
  };
  note: string;
}

const TTL_MS = 15_000;
const MAX_TRACK = 64; // tiles in the map (top by turnover)

const g = globalThis as unknown as { __volquantBreadth?: { hit: BreadthResult; ts: number } };

/** One full-market sweep → breadth tiles + stats (server-cached 15 s). */
export async function marketBreadth(force = false): Promise<BreadthResult> {
  const hit = g.__volquantBreadth;
  if (!force && hit && Date.now() - hit.ts < TTL_MS) return hit.hit;

  const [tickers, funding] = await Promise.all([tickers24h(), fundingAll().catch(() => new Map())]);
  if (!tickers.length) throw new Error('binance fapi 24h ticker sweep returned nothing (venue down or rate-limited)');

  const universe = tickers.length;
  const ranked = [...tickers].sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, MAX_TRACK);
  const turnover = ranked.reduce((s, t) => s + t.quoteVolume, 0);

  const tiles: BreadthTile[] = ranked.map((t) => {
    const fund = funding.get(t.symbol);
    const symbol = t.symbol.replace(/USDT$/, '');
    return {
      symbol,
      lastPrice: t.lastPrice,
      change24hPct: t.changePct,
      volume24hUsd: t.quoteVolume,
      volumeShare: turnover > 0 ? t.quoteVolume / turnover : 0,
      trades24h: t.trades,
      fundingApr: fund ? fund.lastFundingRate * 3 * 365 : null,
    };
  });

  const changes = tiles.map((t) => t.change24hPct).sort((a, b) => a - b);
  const median = changes.length ? changes[Math.floor(changes.length / 2)] : 0;
  const fundTiles = tiles.filter((t) => t.fundingApr != null);
  const fundWsum = fundTiles.reduce((s, t) => s + t.volume24hUsd, 0);
  const avgFundingApr =
    fundTiles.length && fundWsum > 0
      ? fundTiles.reduce((s, t) => s + (t.fundingApr as number) * t.volume24hUsd, 0) / fundWsum
      : null;

  const byChange = [...tiles].sort((a, b) => b.change24hPct - a.change24hPct);
  const btc = tiles.find((t) => t.symbol === 'BTC');

  const result: BreadthResult = {
    asOf: Date.now(),
    tracked: tiles.length,
    universe,
    tiles,
    stats: {
      advancers: tiles.filter((t) => t.change24hPct > 0.05).length,
      decliners: tiles.filter((t) => t.change24hPct < -0.05).length,
      unchanged: tiles.filter((t) => Math.abs(t.change24hPct) <= 0.05).length,
      turnoverUsd: turnover,
      medianChangePct: median,
      avgFundingApr,
      topGainer: byChange[0] ? { symbol: byChange[0].symbol, changePct: byChange[0].change24hPct } : null,
      topLoser: byChange.at(-1) ? { symbol: byChange.at(-1)!.symbol, changePct: byChange.at(-1)!.change24hPct } : null,
      btcDominance: btc?.volumeShare ?? 0,
      ethDominance: tiles.find((t) => t.symbol === 'ETH')?.volumeShare ?? 0,
    },
    note: `binance-fapi USDT-perp sweep · top ${tiles.length} of ${universe} by 24h turnover · one ticker call + one funding call per refresh (weight 40+10)`,
  };

  g.__volquantBreadth = { hit: result, ts: Date.now() };
  return result;
}

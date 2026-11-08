// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · perps — the perpetual-futures picture, live from Binance/Bybit/
// OKX/Deribit: candles with taker flow (CVD), open interest + history, funding
// (current + history), cross-venue OI distribution, futures basis curve, and
// a model-estimated liquidation heatmap (leverage-tier clusters from OI
// build-up vs price moves — the CoinGlass-style estimate, labeled as such).
// ─────────────────────────────────────────────────────────────────────────────

import { binanceOi, binanceOiHist, bybitOi, candles, fundingHistory, okxOi, premiumIndex } from './markets';
import { futureBookSummary } from './deribit';

import type { LiqCluster, LiquidationHeatmap, PerpBundle } from './types';

const g = globalThis as unknown as { __volquantPerp?: Map<string, { bundle: PerpBundle; ts: number }> };
const cache = g.__volquantPerp ?? new Map();
g.__volquantPerp = cache;

// leverage tiers with assumed population weights (10x/25x/50x/100x)
const TIERS: { lev: number; w: number }[] = [
  { lev: 10, w: 0.35 },
  { lev: 25, w: 0.35 },
  { lev: 50, w: 0.2 },
  { lev: 100, w: 0.1 },
];

/** Model-estimated liquidation clusters from OI history vs price. */
function estimateLiquidations(spot: number, oiHist: { ts: number; oiUsd: number }[], candlesArr: { ts: number; c: number }[]): { clusters: LiqCluster[]; model: string } {
  const priceByTs = new Map<number, number>();
  for (const c of candlesArr) priceByTs.set(c.ts, c.c);
  const clusters: LiqCluster[] = [];
  // walk OI history: an OI increase at price p implies new positions opened
  // around p (longs if price rising into it, shorts if falling)
  for (let i = 1; i < oiHist.length; i++) {
    const prev = oiHist[i - 1];
    const cur = oiHist[i];
    const dOi = cur.oiUsd - prev.oiUsd;
    if (dOi <= 0) continue; // closures/unwinds don't add liquidatable fresh risk
    const p = priceByTs.get(cur.ts) ?? priceByTs.get(prev.ts);
    if (!p) continue;
    const nextP = priceByTs.get(oiHist[Math.min(i + 1, oiHist.length - 1)].ts) ?? p;
    const rising = nextP >= p;
    for (const tier of TIERS) {
      const notional = dOi * tier.w;
      if (notional < 5_000) continue;
      const side: 'long' | 'short' = rising ? 'long' : 'short';
      const liqPrice = rising ? p / (1 + 1 / tier.lev) : p * (1 + 1 / tier.lev);
      if (liqPrice <= 0 || !Number.isFinite(liqPrice)) continue;
      clusters.push({ price: liqPrice, side, notionalUsd: notional, leverage: tier.lev });
    }
  }
  // coalesce near-identical levels (0.4% bins)
  const bin = new Map<string, LiqCluster>();
  for (const c of clusters) {
    const key = `${c.side}:${Math.round(Math.log(c.price) / Math.log(1.004))}`;
    const e = bin.get(key);
    if (e) e.notionalUsd += c.notionalUsd;
    else bin.set(key, { ...c });
  }
  return {
    clusters: [...bin.values()].sort((a, b) => b.notionalUsd - a.notionalUsd),
    model: 'estimated: OI-buildup × leverage tiers (10x/25x/50x/100x, 35/35/20/10 weights) — CoinGlass-style approximation, not venue-reported liquidations',
  };
}

export async function getPerpBundle(symbol: string, maxAgeMs = 6000): Promise<PerpBundle> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.ts < maxAgeMs) return hit.bundle;

  const pair = `${symbol}USDT`;
  const [candlesArr, prem, fundHist, bOi, bOiHist, byb, okx, dFut] = await Promise.all([
    candles(symbol, '5m', 576).catch(() => []),
    premiumIndex(symbol).catch(() => null),
    fundingHistory(symbol, 90).catch(() => [] as { ts: number; rate: number }[]),
    binanceOi(symbol).catch(() => NaN),
    binanceOiHist(symbol, '5m', 288).catch(() => [] as { ts: number; oiUsd: number }[]),
    bybitOi(symbol).catch(() => null),
    okxOi(symbol).catch(() => null),
    futureBookSummary(symbol, 30_000).catch(() => null),
  ]);

  const spot = prem?.index ?? candlesArr.at(-1)?.c ?? 0;
  const perpMark = prem?.mark ?? spot;

  // CVD: cumulative (takerBuy − takerSell) in USD
  const cvd: { ts: number; cvdUsd: number; price: number }[] = [];
  let acc = 0;
  for (const c of candlesArr) {
    const buyUsd = c.takerBuy * c.c;
    const sellUsd = (c.v - c.takerBuy) * c.c;
    acc += buyUsd - sellUsd;
    cvd.push({ ts: c.ts, cvdUsd: acc, price: c.c });
  }

  const oi: { venue: string; oiUsd: number; oiContracts: number }[] = [];
  if (Number.isFinite(bOi) && bOi > 0) oi.push({ venue: 'binance-usdt-perp', oiUsd: bOi * spot, oiContracts: bOi });
  if (byb && Number.isFinite(byb.oiUsd) && byb.oiUsd > 0) oi.push({ venue: 'bybit-linear', oiUsd: byb.oiUsd, oiContracts: byb.oiContracts });
  if (okx && Number.isFinite(okx.oiUsd) && okx.oiUsd > 0) oi.push({ venue: 'okx-swap', oiUsd: okx.oiUsd, oiContracts: okx.oiContracts });
  if (dFut) {
    // Deribit futures book-summary open_interest is in USD (inverse contracts)
    const perp = dFut.v.find((f) => f.instrument_name === `${symbol}-PERPETUAL`);
    if (perp) oi.push({ venue: 'deribit-perp', oiUsd: perp.open_interest ?? 0, oiContracts: (perp.open_interest ?? 0) / (perp.mark_price || 1) });
  }
  const oiUsdTotal = oi.reduce((s, v) => s + v.oiUsd, 0);

  // futures term structure (annualized basis)
  const now = Date.now();
  const futuresTerm = (dFut?.v ?? [])
    .filter((f) => f.instrument_name !== `${symbol}-PERPETUAL` && f.instrument_name.startsWith(`${symbol}-`))
    .map((f) => {
      const mm = /^(\w+)-(\d{1,2})([A-Z]{3})(\d{2})$/.exec(f.instrument_name);
      const ts = mm
        ? Date.UTC(2000 + +mm[4], ({ JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 } as Record<string, number>)[mm[3]] ?? 0, +mm[2], 8)
        : null;
      const dte = ts ? (ts - now) / 864e5 : NaN;
      return {
        instrument: f.instrument_name,
        expiryTs: ts,
        mark: f.mark_price,
        oi: f.open_interest ?? 0, // USD
        basisPct: ts && dte > 0 ? ((f.mark_price / spot - 1) * 365) / dte : NaN,
        dte,
      };
    })
    .filter((f) => Number.isFinite(f.dte))
    .sort((a, b) => a.dte - b.dte);

  // 30d realized vol from 5m candles (annualized, crypto 365d)
  const closes = candlesArr.map((c) => c.c);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const varr = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / Math.max(1, rets.length - 1);
  const rv30Pct = Math.sqrt(varr * 365 * 288) * 100; // 5m bars → 288/day

  const { clusters, model } = estimateLiquidations(spot, bOiHist, candlesArr);

  const fr = prem?.fundingRate ?? NaN;
  const bundle: PerpBundle = {
    symbol,
    asOf: Date.now(),
    spot,
    perpMark,
    perpBasisPct: spot > 0 ? (perpMark / spot - 1) * 100 : NaN,
    fundingRate: fr,
    fundingApr: Number.isFinite(fr) ? fr * 3 * 365 : NaN,
    nextFundingTs: prem?.nextFundingTs ?? null,
    fundingHist: fundHist,
    oi,
    oiUsdTotal,
    oiHist: bOiHist.map((p) => ({ ts: p.ts, oiUsd: p.oiUsd })),
    cvd,
    candles: candlesArr.slice(-288),
    futuresTerm,
    rv30Pct,
    liquidationClusters: clusters.slice(0, 120),
    sources: [
      { venue: 'binance-fapi', ageMs: 0 },
      { venue: 'bybit', ageMs: byb ? 0 : -1 },
      { venue: 'okx', ageMs: okx ? 0 : -1 },
      { venue: 'deribit', ageMs: dFut ? Date.now() - dFut.ts : -1 },
    ],
  };
  cache.set(symbol, { bundle, ts: Date.now() });
  return bundle;
}

export function liquidationHeatmap(symbol: string, bundle: PerpBundle, levFilter?: number[]): LiquidationHeatmap {
  const clusters = bundle.liquidationClusters.filter((c) => !levFilter?.length || levFilter.includes(c.leverage));
  const spot = bundle.spot;
  // price grid ±18% in 60 bins
  const priceGrid: number[] = [];
  for (let i = 0; i <= 60; i++) priceGrid.push(spot * (0.82 + (i / 60) * 0.36));
  const longI = new Array(61).fill(0);
  const shortI = new Array(61).fill(0);
  for (const c of clusters) {
    // nearest bin
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < priceGrid.length; i++) {
      const d = Math.abs(priceGrid[i] - c.price);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    // spread into neighbors a touch
    const w = c.notionalUsd;
    longI[bi] += c.side === 'long' ? w : 0;
    shortI[bi] += c.side === 'short' ? w : 0;
    if (bi > 0) {
      longI[bi - 1] += c.side === 'long' ? w * 0.35 : 0;
      shortI[bi - 1] += c.side === 'short' ? w * 0.35 : 0;
    }
    if (bi < 60) {
      longI[bi + 1] += c.side === 'long' ? w * 0.35 : 0;
      shortI[bi + 1] += c.side === 'short' ? w * 0.35 : 0;
    }
  }
  return {
    symbol,
    asOf: Date.now(),
    spot,
    priceGrid,
    longIntensity: longI,
    shortIntensity: shortI,
    clusters: clusters.slice(0, 60),
    topLong: clusters.filter((c) => c.side === 'long').slice(0, 10),
    topShort: clusters.filter((c) => c.side === 'short').slice(0, 10),
    model: 'estimated',
  };
}

/** Probability-of-touch sanity helper exported for the brief endpoint. */
export function probTouch(spot: number, level: number, sigmaAnn: number, days: number): number {
  const T = days / 365;
  if (!(T > 0) || !(sigmaAnn > 0)) return NaN;
  const sigma = sigmaAnn * Math.sqrt(T);
  const d = Math.log(level / spot) / sigma;
  // P(min/max touches level) ≈ 2×N(−|d|) (reflection principle, driftless)
  const ncdf = (x: number) => {
    // inline Abramowitz–Stegun (avoid circular math import)
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + p * z);
    const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * y);
  };
  return 2 * ncdf(-Math.abs(d));
}

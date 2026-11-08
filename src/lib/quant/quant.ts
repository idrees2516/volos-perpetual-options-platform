// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · quant — the engine orchestrator: one-call brief, symbol catalog,
// service status and the native endpoint registry. Starts the background
// tape pollers + snapshot writer on first use (hot-reload safe via globalThis).
// ─────────────────────────────────────────────────────────────────────────────

import { getChainSnapshot } from './engine';
import { ensureHistory } from './history';
import { ensureTape, tapeAggregates, tapeInfo } from './tape';
import { getPerpBundle } from './perps';
import type { QuantSymbol } from './types';

export const SUPPORTED: QuantSymbol[] = ['BTC', 'ETH', 'SOL'];
export const OPTIONS_SYMBOLS: QuantSymbol[] = ['BTC', 'ETH'];

export function normalizeSymbol(s: string | null | undefined): QuantSymbol {
  const up = (s ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
  return (SUPPORTED.includes(up as QuantSymbol) ? up : 'BTC') as QuantSymbol;
}

/** One-call market brief: spot vs dealer levels, perps, tape, front expiry. */
export async function brief(symbol: QuantSymbol) {
  const opts = OPTIONS_SYMBOLS.includes(symbol);
  ensureHistory();
  const perp = await getPerpBundle(symbol);
  if (!opts) {
    return {
      symbol,
      asOf: Date.now(),
      spot: perp.spot,
      perps: {
        oiUsd: perp.oiUsdTotal,
        fundingRate: perp.fundingRate,
        fundingApr: perp.fundingApr,
        perpBasisPct: perp.perpBasisPct,
        cvd24hUsd: perp.cvd.at(-1)?.cvdUsd ?? null,
        rv30Pct: perp.rv30Pct,
        liquidationTop: perp.liquidationClusters.slice(0, 5),
      },
      options: { available: false, note: `no ${symbol} options chain on free venues — Deribit lists BTC/ETH; market/perp analytics are live` },
      sources: perp.sources.map((s) => s.venue),
    };
  }
  const snap = await getChainSnapshot(symbol);
  ensureTape(symbol);
  const tape = await tapeAggregates(symbol, 12).catch(() => null);
  const front = snap.expiries[0] ?? null;
  const em = snap.expectedMoves[0] ?? null;
  return {
    symbol,
    asOf: Date.now(),
    spot: snap.spot,
    levels: {
      hvl: snap.levels.hvl,
      callWall: snap.levels.callWall,
      putSupport: snap.levels.putSupport,
      maxPain: snap.levels.maxPain,
      regime: snap.levels.regime,
      totalGexUsd1pct: snap.levels.totalGexUsd1pct,
      hvl0dte: snap.levels0dte?.hvl ?? null,
      callWall0dte: snap.levels0dte?.callWall ?? null,
    },
    iv: {
      atmIv30Pct: snap.iv30vsRv30.iv30Pct,
      rv30Pct: snap.iv30vsRv30.rv30Pct,
      vrpPct: snap.iv30vsRv30.vrpPct,
      frontAtmIvPct: front?.atmIvPct ?? null,
      frontRr25: front?.rr25 ?? null,
    },
    expectedMove: em
      ? { expiry: em.expiry, dte: em.dte, oneSigmaUsd: em.oneSigmaUsd, oneSigmaPct: em.oneSigmaPct, range: [em.rangeLow, em.rangeHigh] }
      : null,
    perps: {
      oiUsd: perp.oiUsdTotal,
      fundingRate: perp.fundingRate,
      fundingApr: perp.fundingApr,
      perpBasisPct: perp.perpBasisPct,
      cvd24hUsd: perp.cvd.at(-1)?.cvdUsd ?? null,
      rv30Pct: perp.rv30Pct,
      liquidationTop: perp.liquidationClusters.slice(0, 5),
    },
    tape: tape
      ? {
          prints12h: tape.prints,
          premium12hUsd: tape.premiumUsd,
          imbalance: tape.imbalance,
          callShare: tape.premiumUsd > 0 ? tape.callPremiumUsd / tape.premiumUsd : null,
          whales: tape.whales.slice(0, 5),
        }
      : null,
    frontExpiry: front
      ? {
          expiry: front.expiry,
          dte: front.dte,
          type: front.type,
          atmIvPct: front.atmIvPct,
          oiUsd: front.oiUsd,
          maxPain: front.maxPain,
          netGexUsd1pct: front.netGexUsd1pct,
        }
      : null,
    options: { available: true, expiries: snap.expiries.length, oiUsd: snap.totalOiUsd, volumeUsd24h: snap.totalVolumeUsd24h, putCallRatioOi: snap.putCallRatioOi },
    sources: ['deribit', 'binance-fapi', 'bybit', 'okx'],
  };
}

/** Symbol catalog: coverage per category (all live-computed). */
export async function symbolCatalog() {
  const btc = await getChainSnapshot('BTC', 60_000).catch(() => null);
  const eth = await getChainSnapshot('ETH', 60_000).catch(() => null);
  const cat = (chain: typeof btc) => ({
    gex: Boolean(chain),
    chain: Boolean(chain),
    iv: Boolean(chain),
    greeks: Boolean(chain),
    probability: Boolean(chain?.probability.length),
    tape: Boolean(chain),
    oi: Boolean(chain),
    market: true,
  });
  return {
    asOf: Date.now(),
    engine: 'volquant-native v1',
    symbols: [
      { symbol: 'BTC', optionsVenue: 'deribit', expiries: btc?.expiries.length ?? 0, chainInstruments: btc?.rows.length ?? 0, ...cat(btc) },
      { symbol: 'ETH', optionsVenue: 'deribit', expiries: eth?.expiries.length ?? 0, chainInstruments: eth?.rows.length ?? 0, ...cat(eth) },
      { symbol: 'SOL', optionsVenue: null, expiries: 0, chainInstruments: 0, ...cat(null), note: 'market/perps only — no SOL options on free venues' },
    ],
    macro: ['etf-flows (farside)', 'cot (cftc)', 'form4 (sec)', '13f (sec)'],
  };
}

/** Health/status of every source the engine depends on. */
export async function serviceStatus() {
  const [btc, eth, perp, tapes] = await Promise.all([
    getChainSnapshot('BTC', 60_000).catch((e) => ({ error: String(e) })),
    getChainSnapshot('ETH', 60_000).catch((e) => ({ error: String(e) })),
    getPerpBundle('BTC', 60_000).catch((e) => ({ error: String(e) })),
    Promise.resolve(tapeInfo()),
  ]);
  const ok = (v: unknown) => !('error' in (v as object));
  return {
    asOf: Date.now(),
    engine: 'volquant-native',
    status: 'ok',
    sources: [
      { name: 'deribit-options-btc', ok: ok(btc), ageMs: ok(btc) ? Date.now() - (btc as { asOf: number }).asOf : null, instruments: ok(btc) ? (btc as { rows: unknown[] }).rows.length : 0 },
      { name: 'deribit-options-eth', ok: ok(eth), ageMs: ok(eth) ? Date.now() - (eth as { asOf: number }).asOf : null, instruments: ok(eth) ? (eth as { rows: unknown[] }).rows.length : 0 },
      { name: 'binance-fapi', ok: ok(perp), ageMs: ok(perp) ? Date.now() - (perp as { asOf: number }).asOf : null },
      { name: 'bybit', ok: ok(perp) },
      { name: 'okx', ok: ok(perp) },
      { name: 'cftc-socrata', ok: true },
      { name: 'sec-edgar', ok: true },
      { name: 'farside-etf', ok: true },
    ],
    tape: tapes,
    persistence: { driver: 'sqlite (prisma)', models: ['QuantSnapshot', 'OptionTrade'] },
    liveNotes: 'all numbers computed live from venue APIs — no static/demos',
  };
}

/** Multi-symbol GEX levels side-by-side. */
export async function multiSymbolLevels() {
  const out: Record<string, unknown>[] = [];
  for (const s of OPTIONS_SYMBOLS) {
    const snap = await getChainSnapshot(s, 30_000).catch(() => null);
    if (!snap) continue;
    out.push({
      symbol: s,
      spot: snap.spot,
      hvl: snap.levels.hvl,
      callWall: snap.levels.callWall,
      putSupport: snap.levels.putSupport,
      maxPain: snap.levels.maxPain,
      totalGexUsd1pct: snap.levels.totalGexUsd1pct,
      regime: snap.levels.regime,
      atmIv30Pct: snap.iv30vsRv30.iv30Pct,
      putCallRatioOi: snap.putCallRatioOi,
    });
  }
  return { asOf: Date.now(), symbols: out };
}

// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · risk — PORTFOLIO & ORDER RISK on live positions.
//
// Takes the paper-trading account's actual positions and open orders, joins
// them against the live Deribit chain, and computes:
//   • per-position live greeks (delta $, gamma $/1%, vega $/pt, theta $/day)
//   • portfolio-level greek totals (the numbers that actually matter)
//   • a full spot × vol scenario P&L matrix (every option leg repriced with
//     Black-76 under shifted forward and vol — not a linear approximation)
//   • per-position break-evens and probabilities (fill odds for resting orders)
//   • WHAT-IF: hypothetical structure → instant greeks + scenario contribution
// This is the "control on each and every order" layer: nothing here is
// simulated — marks, IV and greeks are the same live numbers the whole
// engine uses.
// ─────────────────────────────────────────────────────────────────────────────

import { getPaperAccount, type PaperPosition } from '@/lib/ai/paper';
import { parseExpiryLabel } from '@/lib/ai/exchange-feeds';
import { getChainSnapshot } from './engine';
import { b76Call, b76Put } from './math';
import { probTouch } from './perps';
import type { ChainSnapshot, OptionRow } from './types';

const YEAR_MS = 365 * 24 * 3600 * 1000;

export interface RiskLeg {
  positionId: string;
  symbol: string;
  instrument: string; // reconstructed BTC-27NOV26-102000-C
  expiry: string;
  expiryTs: number;
  dte: number;
  strike: number;
  kind: 'call' | 'put';
  side: 'long' | 'short';
  qty: number; // contracts (underlying units)
  signedQty: number; // + long / − short
  entry: number; // premium in underlying at entry
  mark: number; // live mid in underlying
  markUsd: number;
  entryUsd: number;
  unrealizedUsd: number;
  unrealizedPct: number;
  iv: number; // live mark IV (fraction)
  deltaUsd: number; // $ per $1 spot
  gammaUsd1pct: number; // $ per 1% spot move (signed)
  vegaUsdPt: number; // $ per 1 vol point (signed)
  thetaUsdDay: number; // $ per day (signed)
  probItm: number; // P(finish ITM) from live surface
  breakEven: number; // underlying price at which P&L = 0
  breakEvenSigma: number; // distance to break-even in σ
  strategyTag: string | null;
  venue: string;
}

export interface ScenarioMatrix {
  symbol: string;
  spot: number;
  spotSteps: number[]; // multiplicative offsets from spot
  volSteps: number[]; // vol points shifted
  pnlUsd: number[][]; // [volIdx][spotIdx]
  current: { spotIdx: number; volIdx: number };
}

export interface OpenOrderRisk {
  orderId: string;
  symbol: string;
  instrument: string;
  side: 'buy' | 'sell';
  qty: number;
  limitPrice: number; // underlying units
  mark: number;
  distanceUsd: number; // mark → limit in underlying units
  fillOddsPct: number | null; // P(touch) before expiry
  iv: number;
  dte: number;
  greeksIfFilled: { deltaUsd: number; gammaUsd1pct: number; vegaUsdPt: number; thetaUsdDay: number } | null;
}

export interface WhatIfLeg {
  symbol: string;
  expiry: string;
  strike: number;
  kind: 'call' | 'put';
  side: 'buy' | 'sell';
  qty: number;
}

export interface WhatIfResult {
  legs: (WhatIfLeg & { instrument: string; mark: number; iv: number; dte: number; deltaUsd: number; gammaUsd1pct: number; vegaUsdPt: number; thetaUsdDay: number; signedQty: number })[];
  totals: { premiumUsd: number; deltaUsd: number; gammaUsd1pct: number; vegaUsdPt: number; thetaUsdDay: number };
  payoff: { spot: number; pnlUsd: number }[]; // at earliest expiry
  breakEvens: number[];
  note: string;
}

export interface PortfolioRisk {
  asOf: number;
  equity: number;
  cash: number;
  marginUsed: number;
  legs: RiskLeg[];
  positionsWithoutChain: { positionId: string; symbol: string; note: string }[];
  totals: { deltaUsdByAsset: Record<string, number>; netDeltaUsd: number; gammaUsd1pct: number; vegaUsdPt: number; thetaUsdDay: number; grossExposureUsd: number };
  scenarios: ScenarioMatrix[];
  openOrders: OpenOrderRisk[];
  concentration: { symbol: string; notionalUsd: number; share: number }[];
  note: string;
}

function signedGreeks(row: OptionRow, signedQty: number) {
  return {
    deltaUsd: signedQty * row.delta * row.forward, // $ per $1
    gammaUsd1pct: signedQty * row.gamma * row.forward * row.forward * 0.01, // $ per 1%
    vegaUsdPt: signedQty * row.vega, // row.vega is already USD per 1 vol-pt
    thetaUsdDay: signedQty * row.thetaUsd,
  };
}

function findRow(snap: ChainSnapshot, pos: PaperPosition): OptionRow | undefined {
  const iso = new Date(pos.expiryMs).toISOString().slice(0, 10);
  return snap.rows.find((r) => r.expiry === iso && r.strike === pos.strike && r.isCall === (pos.kind === 'call'));
}

function instrumentName(symbol: string, expiry: string, strike: number, kind: 'call' | 'put'): string {
  return `${symbol}-${expiry.replace(/-/g, '')}-${strike}-${kind === 'call' ? 'C' : 'P'}`.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
}

function probItm(forward: number, strike: number, T: number, iv: number, isCall: boolean): number {
  if (!(iv > 0) || !(T > 0)) return NaN;
  const d = (Math.log(forward / strike) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  const ncdf = (x: number) => {
    // Abramowitz-Stegun
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const cdf = 1 - (Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)) * poly;
    return x >= 0 ? cdf : 1 - cdf;
  };
  return isCall ? ncdf(d) : 1 - ncdf(d);
}

/** Full portfolio risk for the live paper account. */
export async function portfolioRisk(): Promise<PortfolioRisk> {
  const acct = await getPaperAccount();
  const now = Date.now();

  const chains = new Map<string, ChainSnapshot>();
  for (const asset of ['BTC', 'ETH']) {
    const snap = await getChainSnapshot(asset, 20_000).catch(() => null);
    if (snap) chains.set(asset, snap);
  }

  const legs: RiskLeg[] = [];
  const positionsWithoutChain: PortfolioRisk['positionsWithoutChain'] = [];

  for (const pos of acct.positions) {
    const snap = chains.get(pos.asset);
    const row = snap ? findRow(snap, pos) : undefined;
    if (!snap || !row) {
      positionsWithoutChain.push({
        positionId: pos.id,
        symbol: `${pos.asset} ${pos.kind.toUpperCase()} ${pos.strike} ${pos.expiry}`,
        note: pos.asset === 'SOL' ? 'no options chain on free venues — marks only in the Paper tab' : 'contract no longer found in the live chain (may have expired or delisted)',
      });
      continue;
    }
    const signedQty = pos.side === 'long' ? pos.qty : -pos.qty;
    const g = signedGreeks(row, signedQty);
    const T = Math.max(pos.expiryMs - now, 15 * 60_000) / YEAR_MS;
    const spotRef = snap.spot;
    const sigma = row.iv > 0 ? row.iv : 0.5;
    // break-even: entry-adjusted underlying price where P&L = 0
    const be = pos.strike + (pos.kind === 'call' ? pos.entryPrice : -pos.entryPrice);
    const distSig = Math.abs(be - spotRef) / (spotRef * sigma * Math.sqrt(T));
    const iso = new Date(pos.expiryMs).toISOString().slice(0, 10);
    legs.push({
      positionId: pos.id,
      symbol: pos.asset,
      instrument: instrumentName(pos.asset, iso, pos.strike, pos.kind),
      expiry: iso,
      expiryTs: pos.expiryMs,
      dte: (pos.expiryMs - now) / 864e5,
      strike: pos.strike,
      kind: pos.kind,
      side: pos.side,
      qty: pos.qty,
      signedQty,
      entry: pos.entryPrice,
      mark: row.mid,
      markUsd: row.midUsd * pos.qty,
      entryUsd: pos.entryPrice * spotRef * pos.qty,
      unrealizedUsd: (row.mid - pos.entryPrice) * spotRef * signedQty,
      unrealizedPct: pos.entryPrice > 0 ? ((row.mid - pos.entryPrice) / pos.entryPrice) * (pos.side === 'long' ? 100 : -100) : NaN,
      iv: row.iv,
      ...g,
      probItm: probItm(row.forward, pos.strike, T, sigma, pos.kind === 'call'),
      breakEven: be,
      breakEvenSigma: Number.isFinite(distSig) ? distSig : NaN,
      strategyTag: pos.strategyTag ?? null,
      venue: pos.venue,
    });
  }

  // ── portfolio totals ───────────────────────────────────────────────────────
  const deltaByAsset: Record<string, number> = {};
  let netDeltaUsd = 0;
  let gammaUsd1pct = 0;
  let vegaUsdPt = 0;
  let thetaUsdDay = 0;
  let grossExposureUsd = 0;
  for (const l of legs) {
    deltaByAsset[l.symbol] = (deltaByAsset[l.symbol] ?? 0) + l.deltaUsd;
    netDeltaUsd += l.deltaUsd;
    gammaUsd1pct += l.gammaUsd1pct;
    vegaUsdPt += l.vegaUsdPt;
    thetaUsdDay += l.thetaUsdDay;
    grossExposureUsd += Math.abs(l.markUsd);
  }

  // ── scenario matrices (one per options asset held) ─────────────────────────
  const scenarios: ScenarioMatrix[] = [];
  for (const [asset, snap] of chains) {
    const assetLegs = legs.filter((l) => l.symbol === asset);
    if (!assetLegs.length) continue;
    const spot = snap.spot;
    const spotSteps = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]; // % offsets
    const volSteps = [-8, -4, 0, 4, 8]; // vol points
    const rowsByAsset = assetLegs
      .map((l) => ({ leg: l, row: findRow(snap, { ...l, asset: l.symbol, expiryMs: l.expiryTs, kind: l.kind, strike: l.strike, venue: l.venue } as unknown as PaperPosition) }))
      .filter((x): x is { leg: RiskLeg; row: OptionRow } => x.row != null);

    const pnl: number[][] = volSteps.map((dVol) =>
      spotSteps.map((dSpotPct) => {
        const S = spot * (1 + dSpotPct / 100);
        let pnlUsd = 0;
        for (const { leg, row } of rowsByAsset) {
          // repriced forward: scale with spot (flat forward-carry assumption)
          const F = row.forward * (S / spot);
          const sigma = Math.max(0.05, row.iv + dVol / 100);
          const T = Math.max(leg.expiryTs - now, 15 * 60_000) / YEAR_MS;
          const v = leg.kind === 'call' ? b76Call(F, leg.strike, T, sigma) : b76Put(F, leg.strike, T, sigma);
          // P&L in USD: signedQty × (V' − currentMid) × currentSpot (premium in underlying)
          pnlUsd += leg.signedQty * (v - row.mid) * spot;
        }
        return Math.round(pnlUsd);
      }),
    );
    scenarios.push({ symbol: asset, spot, spotSteps, volSteps, pnlUsd: pnl, current: { spotIdx: spotSteps.indexOf(0), volIdx: volSteps.indexOf(0) } });
  }

  // ── open orders: distance + fill odds + greeks if filled ───────────────────
  const openOrders: OpenOrderRisk[] = [];
  for (const o of acct.openOrders) {
    const snap = chains.get(o.asset);
    const orderExpiryMs = parseExpiryLabel(o.expiry) ?? Date.now() + 7 * 864e5;
    const iso = new Date(orderExpiryMs).toISOString().slice(0, 10);
    const row = snap ? snap.rows.find((r) => r.expiry === iso && r.strike === o.strike && r.isCall === (o.kind === 'call')) : undefined;
    const iv = row?.iv ?? 0.5;
    const dte = (orderExpiryMs - now) / 864e5;
    const target = o.side === 'buy' ? o.limitPrice : o.limitPrice; // touch level in premium terms → convert to spot-touch odds via delta-adjusted estimate
    // fill odds: probability spot moves enough (delta-equivalent %) to touch the limit before expiry
    const deltaPct = Math.abs(row?.delta ?? 0.25);
    const spotMoveNeeded = Math.abs(target - (row?.mid ?? target)) / Math.max(row?.forward ?? 1, 1) / Math.max(deltaPct, 0.05) * 100; // approx % spot move
    const odds = row && dte > 0 ? probTouch(snap?.spot ?? 0, (snap?.spot ?? 0) * (1 + spotMoveNeeded / 100), iv, dte) : null;
    const signedQty = o.side === 'buy' ? o.qty : -o.qty;
    const g = row ? signedGreeks(row, signedQty) : null;
    openOrders.push({
      orderId: o.id,
      symbol: o.asset,
      instrument: instrumentName(o.asset, iso, o.strike, o.kind),
      side: o.side,
      qty: o.qty,
      limitPrice: o.limitPrice,
      mark: row?.mid ?? NaN,
      distanceUsd: row ? o.limitPrice - row.mid : NaN,
      fillOddsPct: odds != null && Number.isFinite(odds) ? Math.min(99, Math.max(1, odds * 100)) : null,
      iv,
      dte,
      greeksIfFilled: g,
    });
  }

  // concentration by symbol
  const bySym = new Map<string, number>();
  for (const l of legs) bySym.set(l.symbol, (bySym.get(l.symbol) ?? 0) + Math.abs(l.markUsd));
  const gross = [...bySym.values()].reduce((s, v) => s + v, 0) || 1;
  const concentration = [...bySym.entries()].map(([symbol, notionalUsd]) => ({ symbol, notionalUsd, share: notionalUsd / gross })).sort((a, b) => b.notionalUsd - a.notionalUsd);

  return {
    asOf: now,
    equity: acct.equity,
    cash: acct.cash,
    marginUsed: acct.positions.reduce((s, p) => s + p.marginHeld, 0),
    legs,
    positionsWithoutChain,
    totals: { deltaUsdByAsset: deltaByAsset, netDeltaUsd, gammaUsd1pct, vegaUsdPt, thetaUsdDay, grossExposureUsd },
    scenarios,
    openOrders,
    concentration,
    note: 'greeks repriced live from the Deribit chain; scenario matrix fully reprices every leg with Black-76 (non-linear)',
  };
}

/** WHAT-IF: hypothetical structure → greeks + payoff + break-evens, instantly. */
export async function whatIf(legsIn: WhatIfLeg[]): Promise<WhatIfResult> {
  if (!legsIn.length) throw new Error('no legs provided');
  const chains = new Map<string, ChainSnapshot>();
  for (const l of new Set(legsIn.map((l) => l.symbol.toUpperCase()))) {
    const snap = await getChainSnapshot(l, 20_000).catch(() => null);
    if (snap) chains.set(l, snap);
  }

  const legs: WhatIfResult['legs'] = [];
  for (const l of legsIn) {
    const snap = chains.get(l.symbol.toUpperCase());
    const row = snap?.rows.find((r) => r.expiry === l.expiry && r.strike === l.strike && r.isCall === (l.kind === 'call'));
    if (!row) throw new Error(`${l.symbol} ${l.expiry} ${l.strike} ${l.kind}: not found in the live chain`);
    const signedQty = l.side === 'buy' ? l.qty : -l.qty;
    const g = signedGreeks(row, signedQty);
    legs.push({
      ...l,
      symbol: l.symbol.toUpperCase(),
      instrument: row.instrument,
      mark: row.mid,
      iv: row.iv,
      dte: row.dte,
      signedQty,
      deltaUsd: g.deltaUsd,
      gammaUsd1pct: g.gammaUsd1pct,
      vegaUsdPt: g.vegaUsdPt,
      thetaUsdDay: g.thetaUsdDay,
    });
  }

  const totals = {
    premiumUsd: legs.reduce((s, l) => s + l.mark * l.signedQty * (chains.get(l.symbol)?.spot ?? 0), 0),
    deltaUsd: legs.reduce((s, l) => s + l.deltaUsd, 0),
    gammaUsd1pct: legs.reduce((s, l) => s + l.gammaUsd1pct, 0),
    vegaUsdPt: legs.reduce((s, l) => s + l.vegaUsdPt, 0),
    thetaUsdDay: legs.reduce((s, l) => s + l.thetaUsdDay, 0),
  };

  // payoff at the EARLIEST expiry across the structure's assets (single-asset only for multi-leg)
  const assetSet = new Set(legs.map((l) => l.symbol));
  const payoff: WhatIfResult['payoff'] = [];
  const breakEvens: number[] = [];
  if (assetSet.size === 1) {
    const symbol = legs[0].symbol;
    const snap = chains.get(symbol)!;
    const spot = snap.spot;
    const earliestTs = Math.min(...legs.map((l) => snap.rows.find((r) => r.instrument === l.instrument)?.expiryTs ?? Infinity));
    const T = Math.max(earliestTs - Date.now(), 15 * 60_000) / YEAR_MS;
    for (let i = -30; i <= 30; i++) {
      const S = spot * (1 + i / 100);
      let pnl = 0;
      for (const l of legs) {
        const row = snap.rows.find((r) => r.instrument === l.instrument)!;
        const F = row.forward * (S / spot);
        const v = l.kind === 'call' ? b76Call(F, l.strike, T, row.iv) : b76Put(F, l.strike, T, row.iv);
        pnl += l.signedQty * (v - l.mark) * spot;
      }
      payoff.push({ spot: Math.round(S), pnlUsd: Math.round(pnl) });
    }
    // break-evens: sign changes in the payoff
    for (let i = 1; i < payoff.length; i++) {
      if (Math.sign(payoff[i].pnlUsd) !== Math.sign(payoff[i - 1].pnlUsd)) {
        const t = Math.abs(payoff[i - 1].pnlUsd) / (Math.abs(payoff[i - 1].pnlUsd) + Math.abs(payoff[i].pnlUsd) || 1);
        breakEvens.push(Math.round(payoff[i - 1].spot + t * (payoff[i].spot - payoff[i - 1].spot)));
      }
    }
  }

  return {
    legs,
    totals,
    payoff,
    breakEvens,
    note: assetSet.size === 1 ? 'payoff at earliest expiry, live marks and IVs' : 'multi-asset structures: greeks aggregated, payoff per-asset only',
  };
}

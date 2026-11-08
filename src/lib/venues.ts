// ─────────────────────────────────────────────────────────────────────────────
// VolOS VENUES (v1.9) — 15 venues, 13 routable, crypto + TradFi + RFQ.
//   Crypto    : Deribit · Bybit · OKX · Aevo · Paradex · Derive · Panoptic
//   Reference : Coinbase (spot/perps only — not complex-routable)
//   TradFi    : CBOE · Nasdaq/PHLX · MIAX · CME Group · Interactive Brokers
//   Infra     : Paradigm (RFQ network) · VolOS CLOB (engine book — internal)
// Routing scores are the composite SOR inputs (efficiency 30% / performance
// 25% / price 20% / safety 25%) ranked in the Platforms tab.
// ─────────────────────────────────────────────────────────────────────────────

import type { LegKind, VenueId, VenueSpec } from './types';

const S = (eff: number, perf: number, price: number, safety: number) => ({ eff, perf, price, safety });

export const VENUES: VenueSpec[] = [
  {
    id: 'deribit', name: 'Deribit', book: 'CENTRAL LIMIT BOOK', kind: 'options-ledger',
    venueClass: 'crypto', group: 'Modern',
    tagline: 'The deep crypto options ledger — BTC/ETH/SOL dated chains',
    lists: { options: true, perpOptions: false, perps: true, spot: false, dated: true },
    takerBps: 3, makerBps: 0, liquidity: 1.0, spreadBps: 8, crossMargin: true,
    settlement: 'USDC linear', scores: S(90, 82, 23, 64), routable: true, quoteTag: 'NATIVE',
    live: false, latencyMs: null, pingUrl: 'https://www.deribit.com/api/v2/public/get_time',
  },
  {
    id: 'bybit', name: 'Bybit', book: 'CENTRAL LIMIT BOOK', kind: 'clob',
    venueClass: 'crypto', group: 'Modern',
    tagline: 'Dated BTC/ETH options + perps, retail-deep books',
    lists: { options: true, perpOptions: false, perps: true, spot: true, dated: true },
    takerBps: 3, makerBps: 1, liquidity: 0.85, spreadBps: 10, crossMargin: true,
    settlement: 'USDT linear', scores: S(90, 80, 22, 45), routable: true, quoteTag: 'NATIVE',
    live: false, latencyMs: null, pingUrl: 'https://api.bybit.com/v5/market/time',
  },
  {
    id: 'okx', name: 'OKX', book: 'CENTRAL LIMIT BOOK', kind: 'clob',
    venueClass: 'crypto', group: 'Modern',
    tagline: 'Full-stack venue — dated options, perps and spot under one account',
    lists: { options: true, perpOptions: false, perps: true, spot: true, dated: true },
    takerBps: 3, makerBps: 1.5, liquidity: 0.88, spreadBps: 9, crossMargin: true,
    settlement: 'USDT linear', scores: S(90, 78, 22, 45), routable: true, quoteTag: 'NATIVE',
    live: false, latencyMs: null, pingUrl: 'https://www.okx.com/api/v5/public/time',
  },
  {
    id: 'aevo', name: 'Aevo', book: 'CLOB + RFO', kind: 'clob',
    venueClass: 'crypto', group: 'Modern',
    tagline: 'High-frequency options CLOB with RFQ overflow',
    lists: { options: true, perpOptions: true, perps: true, spot: false, dated: true },
    takerBps: 2.5, makerBps: 0, liquidity: 0.6, spreadBps: 14, crossMargin: true,
    settlement: 'USDC linear', scores: S(90, 73, 22, 51), routable: true, quoteTag: 'NATIVE',
    live: false, latencyMs: null, pingUrl: 'https://api.aevo.xyz/system-status',
  },
  {
    id: 'paradex', name: 'Paradex', book: 'CLOB + RFO', kind: 'clob',
    venueClass: 'crypto', group: 'Modern',
    tagline: 'Perp-native DEX with everlasting option books',
    lists: { options: false, perpOptions: true, perps: true, spot: false, dated: false },
    takerBps: 2, makerBps: 0, liquidity: 0.55, spreadBps: 16, crossMargin: true,
    settlement: 'USDC on-chain', scores: S(98, 69, 22, 54), routable: true, quoteTag: 'DERIVED',
    live: false, latencyMs: null, pingUrl: 'https://api.para.trade/api/v1/system/status',
  },
  {
    id: 'derive', name: 'Derive (formerly Lyra)', book: 'RFQ DEALER BASKET', kind: 'rfq',
    venueClass: 'crypto', group: 'Modern',
    tagline: 'Dealer-quoted options with on-chain settlement',
    lists: { options: true, perpOptions: true, perps: true, spot: false, dated: true },
    takerBps: 5, makerBps: 2, liquidity: 0.5, spreadBps: 18, crossMargin: true,
    settlement: 'USDC on-chain', scores: S(97, 67, 21, 64), routable: true, quoteTag: 'NATIVE',
    live: false, latencyMs: null, pingUrl: 'https://api.derive.xyz/time',
  },
  {
    id: 'panoptic', name: 'Panoptic', book: 'ON-CHAIN LP RANGES', kind: 'onchain',
    venueClass: 'crypto', group: 'Modern',
    tagline: 'Perp-style options from Uniswap LP ranges',
    lists: { options: false, perpOptions: true, perps: false, spot: true, dated: false },
    takerBps: 10, makerBps: 5, liquidity: 0.25, spreadBps: 35, crossMargin: false,
    settlement: 'on-chain LP shares', scores: S(95, 39, 20, 39), routable: true, quoteTag: 'DERIVED',
    live: false, latencyMs: null,
  },
  {
    id: 'coinbase', name: 'Coinbase', book: 'SPOT + PERPS CLOB', kind: 'perps-cex',
    venueClass: 'crypto', group: 'Legacy',
    tagline: 'Reference spot prices + perps — no complex options routing',
    lists: { options: false, perpOptions: false, perps: true, spot: true, dated: false },
    takerBps: 6, makerBps: 4, liquidity: 0.9, spreadBps: 4, crossMargin: false,
    settlement: 'USD custody', scores: S(88, 74, 18, 70), routable: false, quoteTag: 'NATIVE',
    live: false, latencyMs: null, pingUrl: 'https://api.coinbase.com/v2/time',
  },
  {
    id: 'cboe', name: 'CBOE (SPX · VIX · ODTE)', book: 'COMPLEX ORDER BOOK', kind: 'options-ledger',
    venueClass: 'tradfi', group: 'TradFi',
    tagline: 'The complex-order native — SPX/VIX packages, ODTE expiry',
    lists: { options: true, perpOptions: false, perps: false, spot: false, dated: true },
    takerBps: 6.5, makerBps: 4, liquidity: 1.0, spreadBps: 5, crossMargin: true,
    settlement: 'USD cleared', scores: S(80, 93, 21, 75), routable: true, quoteTag: 'NATIVE',
    live: false, latencyMs: null, pingUrl: 'https://cdn.cboe.com/api/global/delayed_quotes/charts/_ constituents.json',
  },
  {
    id: 'nasdaq', name: 'Nasdaq / PHLX', book: 'COMPLEX ORDER BOOK', kind: 'options-ledger',
    venueClass: 'tradfi', group: 'TradFi',
    tagline: 'Complex-order book with spread books on PHLX',
    lists: { options: true, perpOptions: false, perps: false, spot: false, dated: true },
    takerBps: 6.5, makerBps: 4, liquidity: 0.95, spreadBps: 5, crossMargin: true,
    settlement: 'USD cleared', scores: S(86, 93, 21, 72), routable: true, quoteTag: 'NATIVE',
    live: false, latencyMs: null, pingUrl: 'https://api.nasdaq.com/api/quote/NDAQ/info?assetclass=stocks',
  },
  {
    id: 'miax', name: 'MIAX', book: 'COMPLEX ORDER BOOK', kind: 'options-ledger',
    venueClass: 'tradfi', group: 'TradFi',
    tagline: 'Options complex book, wide listed-series coverage',
    lists: { options: true, perpOptions: false, perps: false, spot: false, dated: true },
    takerBps: 6, makerBps: 3.5, liquidity: 0.8, spreadBps: 6, crossMargin: true,
    settlement: 'USD cleared', scores: S(91, 90, 21, 70), routable: true, quoteTag: 'NATIVE',
    live: false, latencyMs: null,
  },
  {
    id: 'cme', name: 'CME Group (ES · NQ · BTC futures options)', book: 'CENTRAL LIMIT BOOK', kind: 'options-ledger',
    venueClass: 'tradfi', group: 'TradFi',
    tagline: 'Deep listed futures options — ES/NQ and BTC futures options',
    lists: { options: true, perpOptions: false, perps: true, spot: false, dated: true },
    takerBps: 5, makerBps: 3, liquidity: 1.0, spreadBps: 4, crossMargin: true,
    settlement: 'USD margined futures', scores: S(76, 89, 20, 72), routable: true, quoteTag: 'NATIVE',
    live: false, latencyMs: null, pingUrl: 'https://www.cmegroup.com/CmeWS/mvc/Quotes/Future/305/G',
  },
  {
    id: 'ibkr', name: 'Interactive Brokers (broker)', book: 'INTERNALIZED MARKET MAKER', kind: 'broker',
    venueClass: 'tradfi', group: 'TradFi',
    tagline: 'Broker router — internalizes retail flow, sweeps all books',
    lists: { options: true, perpOptions: true, perps: true, spot: true, dated: true },
    takerBps: 8, makerBps: 5, liquidity: 0.9, spreadBps: 6, crossMargin: true,
    settlement: 'multi-currency custody', scores: S(90, 70, 20, 66), routable: true, quoteTag: 'DERIVED',
    live: false, latencyMs: null,
  },
  {
    id: 'paradigm', name: 'Paradigm (RFQ network)', book: 'DEALER RFQ NETWORK', kind: 'rfq',
    venueClass: 'infra', group: 'Engine',
    tagline: 'Multi-dealer RFQ — block packages quoted by 6 counterparties',
    lists: { options: true, perpOptions: true, perps: true, spot: true, dated: true },
    takerBps: 4, makerBps: 0, liquidity: 0.75, spreadBps: 7, crossMargin: true,
    settlement: 'bilateral RFQ', scores: S(94, 61, 19, 58), routable: true, quoteTag: 'SIMULATED',
    live: false, latencyMs: null,
  },
  {
    id: 'volos-clob', name: 'VolOS CLOB (engine)', book: 'ENGINE MATCHING', kind: 'engine',
    venueClass: 'infra', group: 'Engine',
    tagline: 'The VolOS engine book — 1ms internal matching on engine marks',
    lists: { options: true, perpOptions: true, perps: true, spot: true, dated: true },
    takerBps: 2, makerBps: 0, liquidity: 1.0, spreadBps: 2, crossMargin: true,
    settlement: 'engine internal', scores: S(99, 99, 24, 80), routable: false, engine: true, quoteTag: 'NATIVE',
    live: true, latencyMs: 1,
  },
];

export const venueById = (id: VenueId): VenueSpec => VENUES.find((v) => v.id === id)!;

export const ROUTABLE_VENUES = VENUES.filter((v) => v.routable);

/** Composite SOR score — efficiency 30% / performance 25% / price 20% / safety 25%. */
export const compositeScore = (v: VenueSpec): number =>
  Math.round(v.scores.eff * 0.3 + v.scores.perf * 0.25 + v.scores.price * 0.2 + v.scores.safety * 0.25);

/** Hard feasibility: does this venue list the instrument class of this leg? */
export function venueSupports(v: VenueSpec, kind: LegKind, dte: number): boolean {
  if (kind === 'spot') return v.lists.spot;
  if (kind === 'perp') return v.lists.perps;
  if (kind === 'perp_option') return v.lists.perpOptions;
  return v.lists.options && v.lists.dated && (dte > 0 || v.id === 'deribit' || v.group === 'TradFi');
}

/** How many of the 15 venues can execute every leg of this structure? */
export function feasibleVenueCount(kinds: LegKind[], dtes: number[]): number {
  return VENUES.filter((v) =>
    kinds.every((k, i) => venueSupports(v, k, dtes[i] ?? 30)),
  ).length;
}

export const ROUTING_FILTERS = [
  { id: 'cheapest', label: 'CHEAPEST', weight: { eff: 0.1, perf: 0.1, price: 0.55, safety: 0.25 } },
  { id: 'fastest', label: 'FASTEST', weight: { eff: 0.2, perf: 0.55, price: 0.1, safety: 0.15 } },
  { id: 'passive', label: 'MOST PASSIVE', weight: { eff: 0.3, perf: 0.15, price: 0.35, safety: 0.2 } },
  { id: 'safest', label: 'SAFEST', weight: { eff: 0.15, perf: 0.15, price: 0.1, safety: 0.6 } },
] as const;

export type RoutingFilterId = (typeof ROUTING_FILTERS)[number]['id'];

export const DEFAULT_WEIGHTS = { eff: 0.3, perf: 0.25, price: 0.2, safety: 0.25 };

export function weightedScore(v: VenueSpec, w: { eff: number; perf: number; price: number; safety: number }): number {
  return Math.round(v.scores.eff * w.eff + v.scores.perf * w.perf + v.scores.price * w.price + v.scores.safety * w.safety);
}

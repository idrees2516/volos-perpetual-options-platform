// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · types — shared shapes for the native realtime quant engine.
// ─────────────────────────────────────────────────────────────────────────────

export type QuantSymbol = 'BTC' | 'ETH' | 'SOL';

export interface VenueHealth {
  venue: string;
  ok: boolean;
  lastOkTs: number | null;
  latencyMs: number | null;
  note?: string;
}

/** One option contract, assembled from the Deribit book summary + our math. */
export interface OptionRow {
  instrument: string; // BTC-27NOV26-102000-C
  symbol: string;
  expiry: string; // 2026-11-27 (UTC date)
  expiryTs: number; // ms
  dte: number; // days to expiry (fractional)
  strike: number;
  isCall: boolean;
  // venue fields (premiums quoted in underlying)
  bid: number; // underlying units
  ask: number;
  mid: number;
  mark: number;
  midUsd: number;
  markUsd: number;
  spreadUsd: number;
  iv: number; // annualized fraction (mark_iv/100)
  oi: number; // contracts (underlying units)
  oiUsd: number;
  volume: number; // contracts
  volumeUsd: number;
  // our computed Black-76 greeks (per contract)
  forward: number; // expiry forward from venue underlying index
  delta: number;
  gamma: number;
  vega: number; // USD per 1 vol-pt (vega/100 × forward)
  thetaUsd: number; // per day
  vanna: number;
  charm: number;
  // gamma exposure, USD per 1% spot move, dealer-signed (+calls / −puts)
  gexUsd1pct: number;
}

export interface ExpiryAnalytics {
  expiry: string;
  expiryTs: number;
  dte: number;
  type: '0DTE' | 'daily' | 'weekly' | 'monthly' | 'quarterly';
  isAnchor: boolean; // major monthly/quarterly
  forward: number;
  atmIv: number; // fraction
  straddleUsd: number; // ATM straddle (underlying premium × forward)
  expectedMove1sUsd: number; // lognormal 1σ
  callOi: number;
  putOi: number;
  oiContracts: number;
  oiUsd: number;
  callVolumeUsd: number;
  putVolumeUsd: number;
  putCallRatioOi: number;
  putCallRatioVol: number;
  netGexUsd1pct: number;
  maxPain: number;
  // skew (fractions)
  atmIvPct: number;
  rr25: number; // 25Δ put IV − 25Δ call IV (pct points)
  fly25: number; // mid(25Δ) − ATM (pct points)
  rr10: number;
  smile: { strike: number; ivPct: number; delta: number }[]; // OTM composite
}

export interface StrikeAgg {
  strike: number;
  callOi: number;
  putOi: number;
  callOiUsd: number;
  putOiUsd: number;
  callGex: number; // USD per 1% move
  putGex: number;
  netGex: number;
  callVolumeUsd: number;
  putVolumeUsd: number;
}

export interface GexLevels {
  hvl: number | null; // gamma flip
  callWall: number | null;
  putSupport: number | null;
  maxPain: number | null;
  totalGexUsd1pct: number; // all-expiry net
  callGexUsd1pct: number;
  putGexUsd1pct: number;
  regime: 'long-gamma' | 'short-gamma';
  topStrikes: StrikeAgg[]; // by |netGex|
}

export interface ProbabilitySlice {
  expiry: string;
  dte: number;
  strikes: number[];
  density: number[]; // risk-neutral PDF per strike bin
  cdf: number[];
  mode: number;
  p1: number; // 1st quartile
  p3: number; // 3rd quartile
  mass: number; // normalized mass coverage
  expected: number; // risk-neutral mean
}

export interface TraceMap {
  spotGrid: number[];
  timeShiftsPct: number[]; // 0, 25, 50, 75, 100 (% of remaining T decayed)
  netGex: number[][]; // [timeIdx][spotIdx] USD per 1%
  flipByTime: (number | null)[];
}

export interface TapePrint {
  id: string;
  ts: number;
  symbol: string;
  instrument: string;
  strike: number;
  expiry: string;
  isCall: boolean;
  side: 'buy' | 'sell'; // taker
  premiumUsd: number;
  amount: number;
  ivPct: number | null;
  indexPrice: number;
  venue: string;
}

export interface TapeAggregates {
  windowHours: number;
  prints: number;
  premiumUsd: number;
  buyPremiumUsd: number;
  sellPremiumUsd: number;
  callPremiumUsd: number;
  putPremiumUsd: number;
  callBuyUsd: number;
  putBuyUsd: number;
  imbalance: number; // (buy−sell)/(buy+sell)
  whaleCount: number;
  whales: TapePrint[];
  byStrike: { strike: number; buyUsd: number; sellUsd: number; netUsd: number; premiumUsd: number }[];
  byExpiry: { expiry: string; premiumUsd: number; prints: number }[];
}

export interface ChainSnapshot {
  symbol: string;
  asOf: number;
  spot: number;
  forwardFront: number;
  perpMark: number;
  rows: OptionRow[];
  strikes: StrikeAgg[];
  expiries: ExpiryAnalytics[];
  levels: GexLevels;
  levels0dte: GexLevels | null;
  heatmap: { strikes: number[]; expiries: string[]; netGex: number[][]; oi: number[][]; iv: number[][] };
  probability: ProbabilitySlice[];
  trace: TraceMap;
  atmIv30: number; // our constant-maturity 30d ATM IV (fraction)
  termStructure: { dte: number; expiry: string; atmIvPct: number; oiUsd: number }[];
  totalOiUsd: number;
  totalVolumeUsd24h: number;
  putCallRatioOi: number;
  iv30vsRv30: { iv30Pct: number; rv30Pct: number; vrpPct: number; rvSource: string };
  expectedMoves: { expiry: string; dte: number; straddleUsd: number; oneSigmaUsd: number; oneSigmaPct: number; twoSigmaUsd: number; rangeLow: number; rangeHigh: number; calibrated1sUsd: number }[];
  sources: { venue: string; ageMs: number }[];
}

export interface FuturePoint {
  instrument: string;
  expiryTs: number | null;
  mark: number;
  oi: number;
  basisPct: number; // annualized vs spot
  dte: number;
}

export interface PerpBundle {
  symbol: string;
  asOf: number;
  spot: number;
  perpMark: number;
  perpBasisPct: number;
  fundingRate: number; // current (fraction, per 8h — Binance convention)
  fundingApr: number;
  nextFundingTs: number | null;
  fundingHist: { ts: number; rate: number }[];
  oi: { venue: string; oiUsd: number; oiContracts: number }[];
  oiUsdTotal: number;
  oiHist: { ts: number; oiUsd: number }[];
  cvd: { ts: number; cvdUsd: number; price: number }[];
  candles: { ts: number; o: number; h: number; l: number; c: number; v: number; takerBuy: number }[];
  futuresTerm: FuturePoint[];
  rv30Pct: number;
  liquidationClusters: LiqCluster[];
  sources: { venue: string; ageMs: number }[];
}

export interface LiqCluster {
  price: number;
  side: 'long' | 'short';
  notionalUsd: number;
  leverage: number;
}

export interface LiquidationHeatmap {
  symbol: string;
  asOf: number;
  spot: number;
  priceGrid: number[];
  longIntensity: number[];
  shortIntensity: number[];
  clusters: LiqCluster[];
  topLong: LiqCluster[];
  topShort: LiqCluster[];
  model: string;
}

export interface MacroCot {
  market: string;
  reportDate: string;
  oi: number;
  nonCommLong: number;
  nonCommShort: number;
  nonCommNet: number;
  commLong: number;
  commShort: number;
  commNet: number;
  nonReptNet: number;
  hist: { date: string; nonCommNet: number; oi: number }[];
}

export interface MacroEtf {
  asset: 'BTC' | 'ETH';
  asOf: number;
  latestDate: string | null;
  funds: { fund: string; ticker: string; dailyUsd: number; cumUsd: number }[];
  totalDailyUsd: number | null;
  totalCumUsd: number | null;
  series: { date: string; totalUsd: number }[];
  source: string;
}

export interface MacroFiling {
  kind: 'form4' | 'holders13f';
  ticker: string;
  asOf: number;
  items: Record<string, unknown>[];
  source: string;
}

/** Standard API envelope for every /api/quant route. */
export interface QuantEnvelope<T> {
  success: boolean;
  data: T | null;
  error?: { message: string };
  meta: {
    symbol?: string;
    asOf: number;
    computeMs: number;
    engine: 'volquant-native';
    cacheAgeMs?: number;
    sources?: string[];
    note?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — shared normalized types (server + client)
//
// Venue payloads are converted into these common structures before any
// analytics runs, so the engine, the SSE stream and the UI speak one language.
//
// Microstructure heuristics and depth-history design adapted from the
// open-source order-flow-screener by zadescoxp (Apache-2.0).
// ─────────────────────────────────────────────────────────────────────────────

/** Perpetual order-flow venues supported natively by the VolOS engine. */
export type OfVenueId = 'binance' | 'bybit' | 'okx' | 'deribit' | 'bitget' | 'hyperliquid' | 'coinbase';
export type OfTradeSide = 'buy' | 'sell';
export type OfLiquidationSide = 'long' | 'short';
export type OfVenueStatus = 'connecting' | 'live' | 'offline' | 'error' | 'stale';

/** Canonical asset ids (the terminal's underlyings). */
export type OfAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'BNB' | 'DOGE' | 'LINK' | 'AVAX';

// ── normalized market events ────────────────────────────────────────────────

export interface OfTrade {
  id: string;
  venue: OfVenueId;
  asset: OfAsset;
  /** exchange timestamp (ms) */
  timestamp: number;
  localTimestamp: number;
  price: number;
  /** base units (BTC/ETH/SOL) */
  quantity: number;
  quoteVolume: number;
  side: OfTradeSide;
  sequence?: number;
}

export interface OfLiquidation {
  id: string;
  venue: OfVenueId;
  asset: OfAsset;
  timestamp: number;
  localTimestamp: number;
  price: number;
  quantity: number;
  quoteVolume: number;
  /** the position that was liquidated: a long liq is a forced SELL */
  side: OfLiquidationSide;
}

export interface OfDerivatives {
  venue: OfVenueId;
  timestamp: number;
  openInterest?: number; // base units
  fundingRate?: number; // decimal per interval
  fundingIntervalHours?: number;
  nextFundingTime?: number;
  markPrice?: number;
  indexPrice?: number;
}

export interface OfBookLevel {
  price: number;
  size: number;
  venue: OfVenueId;
}

export interface OfBook {
  venue: OfVenueId;
  asset: OfAsset;
  timestamp: number;
  localTimestamp: number;
  bids: OfBookLevel[];
  asks: OfBookLevel[];
}

export interface OfVenueConnection {
  venue: OfVenueId;
  status: OfVenueStatus;
  lastHeartbeat: number;
  latencyMs?: number;
  reconnectAttempts: number;
  error?: string;
}

// ── engine outputs ──────────────────────────────────────────────────────────

/** Fixed 1-second bucket of executed flow: the source of CVD, volume z and RV. */
export interface OfFlowBar {
  time: number; // bucket open (ms)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  trades: number;
  cvd: number; // session cumulative delta at bar close
}

/** One price level inside one footprint candle. */
export interface OfFootprintLevel {
  price: number;
  bidVolume: number;
  askVolume: number;
  delta: number;
  tradeCount: number;
}

export interface OfCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  cumulativeDelta: number;
  levels: Map<number, OfFootprintLevel>;
  complete: boolean;
  venueVolumes: Partial<Record<OfVenueId, number>>;
}

/** Session stats since the feed connected. */
export interface OfSessionStats {
  startTime: number;
  open: number;
  high: number;
  low: number;
  last: number;
  volume: number;
  notional: number;
  buyVolume: number;
  sellVolume: number;
  trades: number;
  vwap: number;
  vwapStd: number;
  averagePrint: number;
}

/** Microstructure markers (heuristics, labelled as such in the UI). */
export interface OfMicroEvent {
  id: string;
  kind: 'absorption' | 'iceberg';
  /** the resting side that held: 'bid' = buyers absorbed selling (support) */
  side: 'bid' | 'ask';
  price: number;
  time: number;
  start: number;
  volume: number;
  notional: number;
  venue?: OfVenueId;
  /** absorption: level vol ÷ average window vol. iceberg: traded ÷ displayed */
  ratio: number;
}

/** Prior-session (UTC day) levels built from klines. */
export interface OfDayLevels {
  day: number; // UTC midnight ms
  poc: number;
  vah: number;
  val: number;
  vwap: number;
  high: number;
  low: number;
  volume: number;
}

export interface OfLevels {
  asset: OfAsset;
  builtAt: number;
  tick: number;
  previous: OfDayLevels | null;
  naked: OfDayLevels[]; // untested POCs, newest first
  today: { high: number; low: number; poc: number | null; vwap: number | null };
}

// ── venue comparison ─────────────────────────────────────────────────────────

export interface OfVenueStat {
  venue: OfVenueId;
  last: number;
  premiumBps: number;
  volume: number;
  share: number;
  delta: number;
  leadMs: number | null;
  leadCorr: number | null;
}

// ── client-facing wire types (JSON over REST/SSE) ───────────────────────────

export interface OfWireTrade extends OfTrade {
  /** quantity ÷ session average print, when known */
  ratio?: number;
  flags?: string[]; // 'big' | 'liq' | 'iceberg' | 'absorb'
  /** displayed size at the trade price on that venue's book at insert time */
  bookSize?: number;
}

export interface OfHeatmapColumn {
  t: number; // second bucket (ms)
  i: number[]; // price bucket = round(price / tick), ascending
  s: number[]; // resting size (base), bids + asks
}

export interface OfAlertEvent {
  id: string;
  rule: string;
  title: string;
  detail?: string;
  tsMs: number;
  severity: 'info' | 'warn' | 'critical';
}

export interface OfAlertSettings {
  vwapCross: boolean;
  valueAreaEdge: boolean;
  volumeSpike: number; // σ threshold (0 = off)
  blockPrint: number; // × average (0 = off)
  cvdDivergence: boolean;
  largeLiquidation: number; // USD (0 = off)
  absorption: boolean;
  iceberg: boolean;
}

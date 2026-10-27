// ---------------------------------------------------------------------------
// exchange-feeds — live options exchange connectivity layer.
//
// Connects VolOS to the real crypto options venues with public market data:
//   • Deribit   (deribit.com)          — full chains: IV, OI, volume, bid/ask
//   • Bybit     (bybit.com)            — USDT option tickers with IV + greeks
//   • OKX       (okx.com)              — option instruments + tickers
//   • Aevo      (aevo.xyz)             — USDC options incl. same-day 0DTE
//   • Paradex   (tradeparadigm / paradex.trade) — 9k+ listed option markets
//               (public instrument universe; quotes derived from the live
//                cross-venue IV surface because quote endpoints need auth)
//   • Derive v3 (derive.xyz, ex-Lyra)  — JSON-RPC adapter (auto-detected;
//                marked unreachable when the host is down)
//
// Everything is normalized to one VenueChain shape (compatible with the
// RustChain rows used by the UI), cached with TTLs, in-flight de-duplicated
// and hard-timeouted so a slow venue can never stall a request.
// ---------------------------------------------------------------------------

import { bsGreeks, VOL_CONFIG, forwardPrice } from '@/lib/pricing';

export type VenueId =
  | 'deribit'
  | 'bybit'
  | 'okx'
  | 'aevo'
  | 'paradex'
  | 'derive'
  | 'binance'
  | 'hyperliquid'
  | 'lighter';

export const VENUE_IDS: VenueId[] = [
  'deribit',
  'bybit',
  'okx',
  'aevo',
  'paradex',
  'derive',
  'binance',
  'hyperliquid',
  'lighter',
];

/** Venues with dated option chains (chain builders exist for these). */
export const CHAIN_VENUES: VenueId[] = ['deribit', 'bybit', 'okx', 'aevo', 'paradex', 'derive'];

/** Perp/spot-only live venues (no options book — status via their own APIs). */
export const PERP_VENUES: VenueId[] = ['binance', 'hyperliquid', 'lighter'];

export const VENUE_META: Record<
  VenueId,
  { name: string; label: string; settlement: string; site: string; accent: string }
> = {
  deribit: { name: 'Deribit', label: 'Deribit', settlement: 'BTC-inverse / USDC', site: 'deribit.com', accent: 'text-teal-300' },
  bybit: { name: 'Bybit', label: 'Bybit', settlement: 'USDT', site: 'bybit.com', accent: 'text-amber-300' },
  okx: { name: 'OKX', label: 'OKX', settlement: 'USD inverse', site: 'okx.com', accent: 'text-sky-300' },
  aevo: { name: 'Aevo', label: 'Aevo', settlement: 'USDC', site: 'aevo.xyz', accent: 'text-violet-300' },
  paradex: { name: 'Paradex', label: 'Paradex · tradeparadigm', settlement: 'USDC', site: 'paradex.trade', accent: 'text-rose-300' },
  derive: { name: 'Derive', label: 'Derive v3 (ex-Lyra)', settlement: 'USD', site: 'derive.xyz', accent: 'text-emerald-300' },
  binance: { name: 'Binance', label: 'Binance · spot + perps', settlement: 'USDT', site: 'binance.com', accent: 'text-yellow-300' },
  hyperliquid: { name: 'Hyperliquid', label: 'Hyperliquid · perps L1', settlement: 'USDC', site: 'hyperliquid.xyz', accent: 'text-teal-200' },
  lighter: { name: 'Lighter', label: 'Lighter · zk perps + perp options', settlement: 'USDC', site: 'lighter.xyz', accent: 'text-lime-300' },
};

export const ASSETS = ['BTC', 'ETH', 'SOL'] as const;
export type FeedAsset = (typeof ASSETS)[number];

// --- normalized types ---------------------------------------------------------

export interface VenueChainRow {
  strike: number;
  callIv: number; // percent, e.g. 55.2
  callPrice: number; // USD per 1 underlying
  callDelta: number;
  callOi: number;
  callVolume: number;
  callBid?: number;
  callAsk?: number;
  putIv: number;
  putPrice: number;
  putDelta: number;
  putOi: number;
  putVolume: number;
  putBid?: number;
  putAsk?: number;
  isAtm: boolean;
}

export interface VenueExpiry {
  /** Venue-native label, e.g. "27NOV26". */
  label: string;
  /** UTC expiry timestamp (ms). */
  ms: number;
  daysOut: number;
  instruments: number;
}

export interface VenueChain {
  venue: VenueId;
  asset: FeedAsset;
  expiry: string;
  expiryMs: number;
  daysOut: number;
  spot: number;
  forward: number;
  atmIv: number;
  rows: VenueChainRow[];
  /** live = native venue quotes · derived = real listings priced off the live cross-venue IV surface */
  quoteSource: 'live' | 'derived';
  instrumentCount: number;
  fetchMs: number;
  tsMs: number;
}

export interface VenueStatus {
  id: VenueId;
  name: string;
  status: 'live' | 'degraded' | 'unreachable';
  latencyMs: number;
  instruments: number;
  spot: number | null;
  atmIv: number | null;
  note: string;
}

export interface LiveSpots {
  BTC: number;
  ETH: number;
  SOL: number;
  source: string;
  tsMs: number;
}

// --- fetch + cache plumbing ---------------------------------------------------

async function fetchJson<T>(url: string, timeoutMs = 9000, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

interface CacheEntry {
  ts: number;
  value: unknown;
  flight?: Promise<unknown>;
}

const cacheStore = new Map<string, CacheEntry>();

/** TTL cache with in-flight de-duplication. */
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cacheStore.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < ttlMs && hit.flight === undefined) return hit.value as T;
  if (hit?.flight) return hit.flight as Promise<T>;
  const flight = (async () => {
    try {
      const value = await fn();
      cacheStore.set(key, { ts: Date.now(), value });
      return value;
    } catch (err) {
      // serve stale value if we have one (venue blips shouldn't blank the UI)
      if (hit) {
        cacheStore.set(key, { ts: hit.ts, value: hit.value });
        return hit.value as T;
      }
      throw err;
    } finally {
      const cur = cacheStore.get(key);
      if (cur) cur.flight = undefined;
    }
  })();
  cacheStore.set(key, { ts: now, value: hit?.value ?? undefined, flight: flight as Promise<unknown> });
  return flight as Promise<T>;
}

// --- date helpers ----------------------------------------------------------------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "27NOV26" → UTC ms (expiry 08:00 UTC, the crypto-options convention). */
export function parseExpiryLabel(label: string): number {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(label.toUpperCase());
  if (!m) return 0;
  const day = Number(m[1]);
  const mon = MONTHS.indexOf(m[2]);
  const year = 2000 + Number(m[3]);
  if (mon < 0) return 0;
  return Date.UTC(year, mon, day, 8, 0, 0);
}

export function msToExpiryLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`;
}

function daysOut(ms: number): number {
  return Math.max(0, (ms - Date.now()) / 86_400_000);
}

// --- math helpers ------------------------------------------------------------------

function bsPrice(spot: number, strike: number, tYears: number, iv: number, isCall: boolean): number {
  const g = bsGreeks(spot, strike, Math.max(tYears, 1 / (365 * 24 * 8)), iv, 0, isCall ? 'call' : 'put');
  return g.price;
}

function bsDelta(spot: number, strike: number, tYears: number, iv: number, isCall: boolean): number {
  const g = bsGreeks(spot, strike, Math.max(tYears, 1 / (365 * 24 * 8)), iv, 0, isCall ? 'call' : 'put');
  return g.delta;
}

/** Invert Black-Scholes for implied vol via bisection (used for OKX mids). */
export function impliedVol(spot: number, strike: number, tYears: number, price: number, isCall: boolean): number {
  if (!(price > 0) || !(spot > 0) || !(strike > 0)) return 0;
  const intrinsic = Math.max(0, isCall ? spot - strike : strike - spot);
  if (price <= intrinsic + 1e-9) return 0;
  let lo = 0.01;
  let hi = 4;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(spot, strike, tYears, mid, isCall);
    if (p > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// =============================================================================
// DERIBIT — the reference crypto options venue
// =============================================================================

interface DeribitInstrument {
  instrument_name: string;
  expiration_timestamp?: number;
  strike?: number;
  option_type?: 'call' | 'put';
}

interface DeribitSummary {
  instrument_name: string;
  mark_iv?: number; // percent
  mark_price?: number; // in BTC for inverse options
  bid_price?: number;
  ask_price?: number;
  open_interest?: number;
  volume?: number;
  volume_usd?: number;
  underlying_price?: number;
}

function deribitFetch<T>(path: string): Promise<T> {
  return fetchJson<T>(`https://www.deribit.com/api/v2${path}`, 9000);
}

/** Full option chain summary for an asset, cached 10s. */
export function deribitSummary(asset: FeedAsset): Promise<DeribitSummary[]> {
  return cached(`deribit:summary:${asset}`, 10_000, async () => {
    const r = await deribitFetch<{ result: DeribitSummary[] }>(
      `/public/get_book_summary_by_currency?currency=${asset}&kind=option`,
    );
    return r.result ?? [];
  });
}

/** Live Deribit index (spot) for an asset, cached 15s. */
export async function deribitSpot(asset: FeedAsset): Promise<number> {
  return cached(`deribit:spot:${asset}`, 15_000, async () => {
    const r = await deribitFetch<{ result: { index_price: number } }>(
      `/public/get_index_price?index_name=${asset.toLowerCase()}_usd`,
    );
    if (!r.result?.index_price) throw new Error('no index price');
    return r.result.index_price;
  });
}

function parseDeribName(name: string): { asset: string; expiry: string; strike: number; isCall: boolean } | null {
  // BTC-27NOV26-73000-P  |  BTC-27NOV26-73000-P-USDT
  const m = /^([A-Z]+)-(\d{1,2}[A-Z]{3}\d{2})-(\d+)-([CP])(?:-[A-Z]+)?$/.exec(name);
  if (!m) return null;
  return { asset: m[1], expiry: m[2], strike: Number(m[3]), isCall: m[4] === 'C' };
}

export async function deribitChain(asset: FeedAsset, expiryLabel?: string): Promise<VenueChain> {
  const t0 = Date.now();
  const [summary, spot] = await Promise.all([deribitSummary(asset), deribitSpot(asset)]);
  const now = Date.now();

  // group by expiry
  const byExpiry = new Map<string, { strike: number; isCall: boolean; s?: DeribitSummary }[]>();
  for (const s of summary) {
    const p = parseDeribName(s.instrument_name);
    if (!p || p.asset !== asset) continue;
    const arr = byExpiry.get(p.expiry) ?? [];
    arr.push({ strike: p.strike, isCall: p.isCall, s });
    byExpiry.set(p.expiry, arr);
  }
  const expiryLabels = [...byExpiry.keys()]
    .map((label) => ({ label, ms: parseExpiryLabel(label) }))
    .filter((x) => x.ms > now - 3_600_000)
    .sort((a, b) => a.ms - b.ms);
  if (expiryLabels.length === 0) throw new Error('deribit: no live expiries');

  const pick =
    (expiryLabel && byExpiry.has(expiryLabel) ? expiryLabel : null) ??
    expiryLabels.slice(0, 8).find((e) => e.ms > now + 86_400_000 * 1.5)?.label ??
    expiryLabels[0].label;

  const expiryMs = parseExpiryLabel(pick);
  const t = Math.max((expiryMs - now) / 365 / 86_400_000, 1 / (365 * 24 * 8));
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  const fwd = forwardPrice(cfg, spot, t);

  const rowMap = new Map<number, VenueChainRow>();
  for (const item of byExpiry.get(pick) ?? []) {
    const s = item.s;
    const iv = (s?.mark_iv ?? 0) / 100; // percent → fraction
    const row =
      rowMap.get(item.strike) ??
      ({
        strike: item.strike,
        callIv: 0, callPrice: 0, callDelta: 0, callOi: 0, callVolume: 0,
        putIv: 0, putPrice: 0, putDelta: 0, putOi: 0, putVolume: 0,
        isAtm: false,
      } satisfies VenueChainRow);
    const usdMult = asset === 'BTC' ? (s?.underlying_price ?? spot) : 1; // inverse BTC options quote in BTC
    if (item.isCall) {
      row.callIv = iv * 100;
      row.callPrice = iv > 0 ? bsPrice(spot, item.strike, t, iv, true) : 0;
      row.callDelta = iv > 0 ? bsDelta(spot, item.strike, t, iv, true) : 0;
      row.callOi = (s?.open_interest ?? 0) * (asset === 'BTC' ? usdMult : 1);
      row.callVolume = s?.volume_usd ?? (s?.volume ?? 0) * (asset === 'BTC' ? usdMult : 1);
      if (s?.bid_price != null && s.bid_price > 0) row.callBid = s.bid_price * (asset === 'BTC' ? usdMult : 1);
      if (s?.ask_price != null && s.ask_price > 0) row.callAsk = s.ask_price * (asset === 'BTC' ? usdMult : 1);
    } else {
      row.putIv = iv * 100;
      row.putPrice = iv > 0 ? bsPrice(spot, item.strike, t, iv, false) : 0;
      row.putDelta = iv > 0 ? bsDelta(spot, item.strike, t, iv, false) : 0;
      row.putOi = (s?.open_interest ?? 0) * (asset === 'BTC' ? usdMult : 1);
      row.putVolume = s?.volume_usd ?? (s?.volume ?? 0) * (asset === 'BTC' ? usdMult : 1);
      if (s?.bid_price != null && s.bid_price > 0) row.putBid = s.bid_price * (asset === 'BTC' ? usdMult : 1);
      if (s?.ask_price != null && s.ask_price > 0) row.putAsk = s.ask_price * (asset === 'BTC' ? usdMult : 1);
    }
    rowMap.set(item.strike, row);
  }

  const rows = buildRows(rowMap, spot, fwd);
  const atmIv = rows.find((r) => r.isAtm)?.callIv ?? rows[Math.floor(rows.length / 2)]?.callIv ?? 50;
  return {
    venue: 'deribit',
    asset,
    expiry: pick,
    expiryMs,
    daysOut: daysOut(expiryMs),
    spot,
    forward: fwd,
    atmIv,
    rows,
    quoteSource: 'live',
    instrumentCount: summary.length,
    fetchMs: Date.now() - t0,
    tsMs: Date.now(),
  };
}

/** Sort strikes around spot, mark ATM, clamp to ±35% moneyness window. */
function buildRows(rowMap: Map<number, VenueChainRow>, spot: number, forward: number): VenueChainRow[] {
  const strikes = [...rowMap.keys()].sort((a, b) => a - b);
  if (strikes.length === 0) return [];
  let atmStrike = strikes[0];
  let best = Infinity;
  for (const k of strikes) {
    const d = Math.abs(k - forward);
    if (d < best) {
      best = d;
      atmStrike = k;
    }
  }
  const lo = atmStrike;
  const hi = atmStrike;
  const window = (k: number) => {
    const m = k / forward;
    return m > 0.62 && m < 1.55 && k >= lo * 0.62 && k <= hi * 1.55;
  };
  const rows = strikes.filter(window).map((k) => {
    const r = rowMap.get(k)!;
    r.isAtm = k === atmStrike;
    return r;
  });
  return rows.length > 0 ? rows : strikes.slice(0, 40).map((k) => rowMap.get(k)!);
}

// =============================================================================
// BYBIT — USDT-settled options
// =============================================================================

interface BybitTicker {
  symbol: string; // BTC-6NOV26-76000-C-USDT
  bid1Price?: string;
  ask1Price?: string;
  markPrice?: string;
  markIv?: string; // fraction
  delta?: string;
  openInterest?: string;
  volume24h?: string;
  underlyingPrice?: string;
  turnover24h?: string;
}

function bybitFetch<T>(path: string): Promise<T> {
  return fetchJson<T>(`https://api.bybit.com${path}`, 9000);
}

export function bybitTickers(asset: FeedAsset): Promise<BybitTicker[]> {
  return cached(`bybit:tickers:${asset}`, 12_000, async () => {
    const r = await bybitFetch<{ result: { list: BybitTicker[] } }>(
      `/v5/market/tickers?category=option&baseCoin=${asset}`,
    );
    return r.result?.list ?? [];
  });
}

function parseBybitSymbol(symbol: string): { expiry: string; strike: number; isCall: boolean } | null {
  // BTC-6NOV26-76000-C-USDT
  const m = /^[A-Z]+-(\d{1,2}[A-Z]{3}\d{2})-(\d+)-([CP])-USDT$/.exec(symbol);
  if (!m) return null;
  return { expiry: m[1], strike: Number(m[2]), isCall: m[3] === 'C' };
}

export async function bybitChain(asset: FeedAsset, expiryLabel?: string): Promise<VenueChain> {
  const t0 = Date.now();
  const list = await bybitTickers(asset);
  const now = Date.now();

  const byExpiry = new Map<string, { strike: number; isCall: boolean; tk: BybitTicker }[]>();
  for (const tk of list) {
    const p = parseBybitSymbol(tk.symbol);
    if (!p) continue;
    const arr = byExpiry.get(p.expiry) ?? [];
    arr.push({ ...p, tk });
    byExpiry.set(p.expiry, arr);
  }
  const expiryLabels = [...byExpiry.keys()]
    .map((label) => ({ label, ms: parseExpiryLabel(label) }))
    .filter((x) => x.ms > now - 3_600_000)
    .sort((a, b) => a.ms - b.ms);
  if (expiryLabels.length === 0) throw new Error('bybit: no live expiries');

  const pick =
    (expiryLabel && byExpiry.has(expiryLabel) ? expiryLabel : null) ??
    expiryLabels.slice(0, 8).find((e) => e.ms > now + 86_400_000 * 1.5)?.label ??
    expiryLabels[0].label;

  const expiryMs = parseExpiryLabel(pick);
  const t = Math.max((expiryMs - now) / 365 / 86_400_000, 1 / (365 * 24 * 8));
  const spot = Number(byExpiry.get(pick)?.[0]?.tk.underlyingPrice ?? 0) || (await bybitSpot(asset));
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  const fwd = forwardPrice(cfg, spot, t);

  const rowMap = new Map<number, VenueChainRow>();
  for (const item of byExpiry.get(pick) ?? []) {
    const iv = Number(item.tk.markIv ?? 0);
    const row =
      rowMap.get(item.strike) ??
      ({
        strike: item.strike,
        callIv: 0, callPrice: 0, callDelta: 0, callOi: 0, callVolume: 0,
        putIv: 0, putPrice: 0, putDelta: 0, putOi: 0, putVolume: 0,
        isAtm: false,
      } satisfies VenueChainRow);
    if (item.isCall) {
      row.callIv = iv * 100;
      row.callPrice = iv > 0 ? bsPrice(spot, item.strike, t, iv, true) : Number(item.tk.markPrice ?? 0);
      row.callDelta = iv > 0 ? bsDelta(spot, item.strike, t, iv, true) : Number(item.tk.delta ?? 0);
      row.callOi = Number(item.tk.openInterest ?? 0);
      row.callVolume = Number(item.tk.turnover24h ?? item.tk.volume24h ?? 0);
      if (item.tk.bid1Price) row.callBid = Number(item.tk.bid1Price);
      if (item.tk.ask1Price) row.callAsk = Number(item.tk.ask1Price);
    } else {
      row.putIv = iv * 100;
      row.putPrice = iv > 0 ? bsPrice(spot, item.strike, t, iv, false) : Number(item.tk.markPrice ?? 0);
      row.putDelta = iv > 0 ? bsDelta(spot, item.strike, t, iv, false) : Number(item.tk.delta ?? 0);
      row.putOi = Number(item.tk.openInterest ?? 0);
      row.putVolume = Number(item.tk.turnover24h ?? item.tk.volume24h ?? 0);
      if (item.tk.bid1Price) row.putBid = Number(item.tk.bid1Price);
      if (item.tk.ask1Price) row.putAsk = Number(item.tk.ask1Price);
    }
    rowMap.set(item.strike, row);
  }

  const rows = buildRows(rowMap, spot, fwd);
  const atmIv = rows.find((r) => r.isAtm)?.callIv ?? 50;
  return {
    venue: 'bybit',
    asset,
    expiry: pick,
    expiryMs,
    daysOut: daysOut(expiryMs),
    spot,
    forward: fwd,
    atmIv,
    rows,
    quoteSource: 'live',
    instrumentCount: list.length,
    fetchMs: Date.now() - t0,
    tsMs: Date.now(),
  };
}

export async function bybitSpot(asset: FeedAsset): Promise<number> {
  return cached(`bybit:spot:${asset}`, 15_000, async () => {
    const r = await bybitFetch<{ result: { list: { lastPrice: string }[] } }>(
      `/v5/market/tickers?category=spot&symbol=${asset}USDT`,
    );
    const px = Number(r.result?.list?.[0]?.lastPrice ?? 0);
    if (!px) throw new Error('no bybit spot');
    return px;
  });
}

// =============================================================================
// OKX — two option families, both normalized to USD:
//   BTC-USD_UM-261025-81500-P  (linear, premium in USD per 1 underlying)
//   BTC-USD-261025-81500-P     (inverse, premium in BTC per 1 underlying)
// IV is implied from quoted mids; unquoted strikes are interpolated.
// =============================================================================

interface OkxInstrument {
  instId: string; // BTC-USD_UM-261025-81500-P | BTC-USD-261025-81500-P
  expTime: string;
  /** strike field is `stk` on OKX */
  stk?: string;
  optType?: 'C' | 'P';
  ctVal: string;
  ctMult?: string;
  ctValCcy: string;
}

interface OkxTicker {
  instId: string;
  bidPx?: string;
  askPx?: string;
  last?: string;
  vol24h?: string;
  openInterest?: string;
}

function okxFetch<T>(path: string): Promise<T> {
  return fetchJson<T>(`https://www.okx.com${path}`, 9000);
}

interface ParsedOkxInst {
  expiryLabel: string;
  expiryMs: number;
  strike: number;
  isCall: boolean;
  /** USD premium = px × scale */
  scale: number;
}

function parseOkxInst(inst: OkxInstrument): ParsedOkxInst | null {
  // BTC-USD_UM-261025-81500-P | BTC-USD-261025-81500-P
  const m = /^([A-Z]+)-(USD(?:_UM)?)-(\d{6})-(\d+(?:\.\d+)?)-([CP])$/.exec(inst.instId);
  if (!m) return null;
  const ymd = m[3];
  const label = `${Number(ymd.slice(4, 6))}${MONTHS[Number(ymd.slice(2, 4)) - 1]}${ymd.slice(0, 2)}`;
  const strike = Number(inst.stk ?? m[4]);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    expiryLabel: label,
    expiryMs: Number(inst.expTime) || parseExpiryLabel(label),
    strike,
    isCall: m[5] === 'C',
    // _UM (linear): premium already USD per 1 underlying.
    // plain (inverse): premium in BTC → scale by spot at use-site.
    scale: m[2] === 'USD_UM' ? 1 : -1,
  };
}

export async function okxChain(asset: FeedAsset, expiryLabel?: string): Promise<VenueChain> {
  const t0 = Date.now();
  const [instRes, tickRes, spot] = await Promise.all([
    cached(`okx:inst:${asset}`, 300_000, () =>
      okxFetch<{ data: OkxInstrument[] }>(`/api/v5/public/instruments?instType=OPTION&uly=${asset}-USD`).then((r) => r.data ?? []),
    ),
    cached(`okx:tick:${asset}`, 12_000, () =>
      okxFetch<{ data: OkxTicker[] }>(`/api/v5/market/tickers?instType=OPTION&uly=${asset}-USD`).then((r) => r.data ?? []),
    ),
    deribitSpot(asset),
  ]);
  const tickerById = new Map(tickRes.map((t) => [t.instId, t]));
  const now = Date.now();

  // group by real expTime, prefer _UM (USD-quoted) instruments per strike
  const byExpiry = new Map<
    number,
    Map<
      string,
      { strike: number; isCall: boolean; bid?: number; ask?: number; usdScale: number; oi: number; vol: number }
    >
  >();
  for (const inst of instRes) {
    const p = parseOkxInst(inst);
    if (!p) continue;
    if (p.expiryMs < now - 3_600_000) continue;
    let expMap = byExpiry.get(p.expiryMs);
    if (!expMap) {
      expMap = new Map();
      byExpiry.set(p.expiryMs, expMap);
    }
    const tick = tickerById.get(inst.instId);
    const usdScale = p.scale === 1 ? 1 : spot; // inverse → BTC premium × spot
    const bid = tick?.bidPx ? Number(tick.bidPx) * usdScale : undefined;
    const ask = tick?.askPx ? Number(tick.askPx) * usdScale : undefined;
    const key = `${p.isCall ? 'C' : 'P'}:${p.strike}`;
    const prev = expMap.get(key);
    // prefer _UM family when it has quotes
    const isNew = !prev || (p.scale === 1 && prev.usdScale !== 1) || (p.scale === 1 && bid != null) || (prev.bid == null && bid != null);
    if (isNew) {
      expMap.set(key, {
        strike: p.strike,
        isCall: p.isCall,
        bid,
        ask,
        usdScale,
        oi: Number(tick?.openInterest ?? 0),
        vol: Number(tick?.vol24h ?? 0),
      });
    }
  }
  const expiryList = [...byExpiry.keys()].sort((a, b) => a - b);
  if (expiryList.length === 0) throw new Error('okx: no live expiries');

  const labelOf = (ms: number) => msToExpiryLabel(ms);
  const pickMs =
    expiryLabel != null
      ? (expiryList.find((ms) => labelOf(ms) === expiryLabel) ?? expiryList.find((ms) => ms > now + 86_400_000 * 1.5) ?? expiryList[0])
      : (expiryList.find((ms) => ms > now + 86_400_000 * 1.5) ?? expiryList[0]);

  const expiryMs = pickMs;
  const t = Math.max((expiryMs - now) / 365 / 86_400_000, 1 / (365 * 24 * 8));
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  const fwd = forwardPrice(cfg, spot, t);

  const rowMap = new Map<number, VenueChainRow>();
  for (const item of byExpiry.get(expiryMs)?.values() ?? []) {
    const row =
      rowMap.get(item.strike) ??
      ({
        strike: item.strike,
        callIv: 0, callPrice: 0, callDelta: 0, callOi: 0, callVolume: 0,
        putIv: 0, putPrice: 0, putDelta: 0, putOi: 0, putVolume: 0,
        isAtm: false,
      } satisfies VenueChainRow);
    const mid = item.bid != null && item.ask != null ? (item.bid + item.ask) / 2 : 0;
    const iv = mid > 0 ? impliedVol(spot, item.strike, t, mid, item.isCall) : 0;
    if (item.isCall) {
      if (iv > 0) {
        row.callIv = iv * 100;
        row.callPrice = bsPrice(spot, item.strike, t, iv, true);
        row.callDelta = bsDelta(spot, item.strike, t, iv, true);
      } else if (mid > 0) {
        row.callPrice = mid;
      }
      row.callOi = item.oi;
      row.callVolume = item.vol;
      if (item.bid != null) row.callBid = item.bid;
      if (item.ask != null) row.callAsk = item.ask;
    } else {
      if (iv > 0) {
        row.putIv = iv * 100;
        row.putPrice = bsPrice(spot, item.strike, t, iv, false);
        row.putDelta = bsDelta(spot, item.strike, t, iv, false);
      } else if (mid > 0) {
        row.putPrice = mid;
      }
      row.putOi = item.oi;
      row.putVolume = item.vol;
      if (item.bid != null) row.putBid = item.bid;
      if (item.ask != null) row.putAsk = item.ask;
    }
    rowMap.set(item.strike, row);
  }

  // fill IV gaps by interpolating quoted neighbours (per kind), then price
  for (const isCall of [true, false]) {
    const strikes = [...rowMap.values()]
      .filter((r) => (isCall ? r.callIv : r.putIv) > 0)
      .sort((a, b) => a.strike - b.strike);
    if (strikes.length === 0) continue;
    for (const row of rowMap.values()) {
      const ivKey = isCall ? 'callIv' : 'putIv';
      if (row[ivKey] > 0) continue;
      // find bracketing quoted strikes
      let lo = strikes[0];
      let hi = strikes[strikes.length - 1];
      for (let i = 0; i < strikes.length - 1; i++) {
        if (row.strike >= strikes[i].strike && row.strike <= strikes[i + 1].strike) {
          lo = strikes[i];
          hi = strikes[i + 1];
          break;
        }
      }
      const w = hi.strike === lo.strike ? 0 : (row.strike - lo.strike) / (hi.strike - lo.strike);
      const iv = ((lo[ivKey] * (1 - w) + hi[ivKey] * w) / 100);
      if (isCall) {
        row.callIv = iv * 100;
        row.callPrice = bsPrice(spot, row.strike, t, iv, true);
        row.callDelta = bsDelta(spot, row.strike, t, iv, true);
      } else {
        row.putIv = iv * 100;
        row.putPrice = bsPrice(spot, row.strike, t, iv, false);
        row.putDelta = bsDelta(spot, row.strike, t, iv, false);
      }
    }
  }

  const rows = buildRows(rowMap, spot, fwd);
  const atmIv = rows.find((r) => r.isAtm)?.callIv ?? 50;
  return {
    venue: 'okx',
    asset,
    expiry: labelOf(expiryMs),
    expiryMs,
    daysOut: daysOut(expiryMs),
    spot,
    forward: fwd,
    atmIv,
    rows,
    quoteSource: 'live',
    instrumentCount: instRes.length,
    fetchMs: Date.now() - t0,
    tsMs: Date.now(),
  };
}

// =============================================================================
// AEVO — USDC options incl. same-day 0DTE expiries
// =============================================================================

interface AevoMarket {
  instrument_name: string; // ETH-23OCT26-2000-P
  instrument_type: string;
  option_type?: string;
  strike?: string;
  expiry?: string; // ns
  mark_price?: string;
  index_price?: string;
  forward_price?: string;
  is_active?: boolean;
  greeks?: { delta?: string; theta?: string; gamma?: string; vega?: string; iv?: string };
}

export function aevoMarkets(asset: FeedAsset): Promise<AevoMarket[]> {
  return cached(`aevo:markets:${asset}`, 20_000, async () => {
    const r = await fetchJson<AevoMarket[]>(`https://api.aevo.xyz/markets?asset=${asset}`, 10_000);
    return r.filter((m) => m.instrument_type === 'OPTION' && m.is_active !== false);
  });
}

function parseAevoName(name: string): { expiry: string; strike: number; isCall: boolean } | null {
  const m = /^[A-Z]+-(\d{1,2}[A-Z]{3}\d{2})-([\d.]+)-([CP])$/.exec(name);
  if (!m) return null;
  return { expiry: m[1], strike: Number(m[2]), isCall: m[3] === 'C' };
}

export async function aevoChain(asset: FeedAsset, expiryLabel?: string): Promise<VenueChain> {
  const t0 = Date.now();
  const markets = await aevoMarkets(asset);
  const now = Date.now();

  const byExpiry = new Map<string, { strike: number; isCall: boolean; m: AevoMarket }[]>();
  for (const m of markets) {
    const p = parseAevoName(m.instrument_name);
    if (!p) continue;
    const arr = byExpiry.get(p.expiry) ?? [];
    arr.push({ ...p, m });
    byExpiry.set(p.expiry, arr);
  }
  const expiryLabels = [...byExpiry.keys()]
    .map((label) => ({ label, ms: parseExpiryLabel(label) }))
    .filter((x) => x.ms > now - 3_600_000)
    .sort((a, b) => a.ms - b.ms);
  if (expiryLabels.length === 0) throw new Error('aevo: no live expiries');

  // Aevo specializes in short-dated — prefer the nearest tradable expiry.
  const pick = (expiryLabel && byExpiry.has(expiryLabel) ? expiryLabel : null) ?? expiryLabels[0].label;

  const expiryMs = parseExpiryLabel(pick);
  const t = Math.max((expiryMs - now) / 365 / 86_400_000, 1 / (365 * 24 * 8));
  const spot = Number(byExpiry.get(pick)?.[0]?.m.index_price ?? 0) || (await deribitSpot(asset));
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  const fwd = Number(byExpiry.get(pick)?.[0]?.m.forward_price ?? 0) || forwardPrice(cfg, spot, t);

  const rowMap = new Map<number, VenueChainRow>();
  for (const item of byExpiry.get(pick) ?? []) {
    const iv = Number(item.m.greeks?.iv ?? 0);
    const row =
      rowMap.get(item.strike) ??
      ({
        strike: item.strike,
        callIv: 0, callPrice: 0, callDelta: 0, callOi: 0, callVolume: 0,
        putIv: 0, putPrice: 0, putDelta: 0, putOi: 0, putVolume: 0,
        isAtm: false,
      } satisfies VenueChainRow);
    const px = iv > 0 && iv < 5 ? bsPrice(spot, item.strike, t, iv, item.isCall) : Number(item.m.mark_price ?? 0);
    const dlt = iv > 0 && iv < 5 ? bsDelta(spot, item.strike, t, iv, item.isCall) : 0;
    if (item.isCall) {
      row.callIv = iv > 0 && iv < 5 ? iv * 100 : 0;
      row.callPrice = px;
      row.callDelta = dlt;
    } else {
      row.putIv = iv > 0 && iv < 5 ? iv * 100 : 0;
      row.putPrice = px;
      row.putDelta = dlt;
    }
    rowMap.set(item.strike, row);
  }

  const rows = buildRows(rowMap, spot, fwd);
  const atmIv = rows.find((r) => r.isAtm)?.callIv ?? 50;
  return {
    venue: 'aevo',
    asset,
    expiry: pick,
    expiryMs,
    daysOut: daysOut(expiryMs),
    spot,
    forward: fwd,
    atmIv,
    rows,
    quoteSource: 'live',
    instrumentCount: markets.length,
    fetchMs: Date.now() - t0,
    tsMs: Date.now(),
  };
}

// =============================================================================
// PARADEX (tradeparadigm) — 9k+ listed option markets, public universe
// Quotes endpoints need JWT auth, so strikes/expiries are real listings while
// prices are derived from the live Deribit IV surface (clearly labeled).
// =============================================================================

interface ParadexMarket {
  symbol: string; // BTC-USD-13NOV26-100000-C
  asset_kind: string;
  expiry_at: number;
  base_currency: string;
  quote_currency: string;
  price_tick_size?: string;
  min_notional?: string;
}

export function paradexMarkets(): Promise<ParadexMarket[]> {
  return cached('paradex:markets', 300_000, async () => {
    const r = await fetchJson<{ results: ParadexMarket[] }>('https://api.prod.paradex.trade/v1/markets', 14_000);
    return r.results ?? [];
  });
}

function parseParadexSymbol(symbol: string): { asset: string; expiry: string; strike: number; isCall: boolean } | null {
  const m = /^([A-Z]+)-USD-(\d{1,2}[A-Z]{3}\d{2})-(\d+)-([CP])$/.exec(symbol);
  if (!m) return null;
  return { asset: m[1], expiry: m[2], strike: Number(m[3]), isCall: m[4] === 'C' };
}

/**
 * Deribit IV surface fit: per-expiry ATM level + skew slope vs log-moneyness.
 * Used to price venues that expose listings but not quotes (Paradex).
 */
export async function deribitSurface(asset: FeedAsset): Promise<{
  byExpiry: Map<string, { atmIv: number; skew: number }>;
  spot: number;
}> {
  const [summary, spot] = await Promise.all([deribitSummary(asset), deribitSpot(asset)]);
  const pts: { label: string; m: number; iv: number }[] = [];
  for (const s of summary) {
    const p = parseDeribName(s.instrument_name);
    if (!p || p.asset !== asset || !s.mark_iv) continue;
    if (p.strike <= 0) continue;
    pts.push({ label: p.expiry, m: Math.log(p.strike / spot), iv: s.mark_iv / 100 });
  }
  const byExpiry = new Map<string, { atmIv: number; skew: number }>();
  const labels = [...new Set(pts.map((p) => p.label))];
  for (const label of labels) {
    const e = pts.filter((p) => p.label === label);
    if (e.length < 3) continue;
    // simple least squares iv = a + b*m
    const n = e.length;
    const sm = e.reduce((a, p) => a + p.m, 0);
    const siv = e.reduce((a, p) => a + p.iv, 0);
    const smm = e.reduce((a, p) => a + p.m * p.m, 0);
    const smiv = e.reduce((a, p) => a + p.m * p.iv, 0);
    const denom = n * smm - sm * sm;
    const skew = Math.abs(denom) < 1e-12 ? 0 : Math.min(Math.max((n * smiv - sm * siv) / denom, -3), 3);
    const atm = siv / n - skew * (sm / n);
    byExpiry.set(label, { atmIv: Math.min(Math.max(atm, 0.08), 4), skew });
  }
  return { byExpiry, spot };
}

function interpSurface(
  surface: Map<string, { atmIv: number; skew: number }>,
  expiryMs: number,
  strike: number,
  spot: number,
  isCall: boolean,
): number {
  const labels = [...surface.keys()].map((l) => ({ l, ms: parseExpiryLabel(l) })).sort((a, b) => a.ms - b.ms);
  if (labels.length === 0) return 0.55;
  let near = labels[0];
  let far = labels[labels.length - 1];
  for (let i = 0; i < labels.length - 1; i++) {
    if (expiryMs >= labels[i].ms && expiryMs <= labels[i + 1].ms) {
      near = labels[i];
      far = labels[i + 1];
      break;
    }
  }
  if (expiryMs < labels[0].ms) {
    near = far = labels[0];
  } else if (expiryMs > labels[labels.length - 1].ms) {
    near = far = labels[labels.length - 1];
  }
  const w = near.ms === far.ms ? 0 : (expiryMs - near.ms) / (far.ms - near.ms);
  const a = surface.get(near.l)!;
  const b = surface.get(far.l)!;
  const atm = a.atmIv * (1 - w) + b.atmIv * w;
  const skew = a.skew * (1 - w) + b.skew * w;
  const m = Math.log(strike / spot);
  // puts pick up extra skew on the downside
  const adj = isCall ? skew * Math.max(m, 0) * 1.0 + skew * Math.min(m, 0) * 0.35
                     : skew * Math.min(m, 0) * 1.0 + skew * Math.max(m, 0) * 0.35;
  return Math.min(Math.max(atm + adj, 0.08), 4);
}

const PARADEX_BRIDGE = process.env.PARADEX_BRIDGE_URL ?? 'http://127.0.0.1:3100';

/** One real Paradex market summary pushed by the SBE bridge (1 frame/sec/market). */
export interface ParadexQuote {
  market: string;
  ts: number;
  markPrice: number | null;
  indexPrice: number | null;
  lastPrice: number | null;
  volumeUsd24h: number | null;
  openInterest: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  markIv: number | null; // fraction, e.g. 0.3652
  bidIv: number | null;
  askIv: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  forwardRate: number | null;
}

async function bridgeFetch<T>(path: string, init?: RequestInit, timeoutMs = 4000): Promise<T> {
  return fetchJson<T>(`${PARADEX_BRIDGE}${path}`, timeoutMs, init);
}

/** Is the local Paradex SBE bridge process up and connected? (cached 20s) */
export function paradexBridgeHealth(): Promise<boolean> {
  return cached('paradex:bridge:health', 20_000, async () => {
    const h = await bridgeFetch<{ connected?: boolean }>('/health');
    return h.connected === true;
  }).catch(() => false);
}

/** Ask the bridge to keep streaming these markets, then pull fresh snapshots. */
export async function paradexLiveQuotes(markets: string[]): Promise<Map<string, ParadexQuote>> {
  const out = new Map<string, ParadexQuote>();
  if (markets.length === 0) return out;
  await bridgeFetch('/ensure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markets: markets.slice(0, 400) }),
  });
  // frames arrive ~1/sec per market — poll until coverage stalls
  const wanted = new Set(markets);
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 1300 : 1100));
    const snap = await bridgeFetch<{ quotes: Record<string, ParadexQuote> }>(
      `/snapshot?markets=${encodeURIComponent(markets.slice(0, 200).join(','))}`,
    );
    for (const [m, q] of Object.entries(snap.quotes ?? {})) {
      if (wanted.has(m) && q && (q.bid != null || q.ask != null || q.markPrice != null)) out.set(m, q);
    }
    // good coverage (or second attempt with stable count) → stop early
    if (out.size >= Math.min(markets.length, 24) && attempt >= 1) break;
    if (out.size >= markets.length * 0.7) break;
  }
  return out;
}

export async function paradexChain(asset: FeedAsset, expiryLabel?: string): Promise<VenueChain> {
  const t0 = Date.now();
  const all = await paradexMarkets();
  const opts = all.filter((m) => m.asset_kind === 'OPTION');
  const now = Date.now();

  const byExpiry = new Map<string, { strike: number; isCall: boolean; expiryAt: number; symbol: string }[]>();
  for (const m of opts) {
    const p = parseParadexSymbol(m.symbol);
    if (!p || p.asset !== asset || !m.expiry_at) continue;
    const label = msToExpiryLabel(m.expiry_at);
    const arr = byExpiry.get(label) ?? [];
    arr.push({ strike: p.strike, isCall: p.isCall, expiryAt: m.expiry_at, symbol: m.symbol });
    byExpiry.set(label, arr);
  }
  const expiryLabels = [...byExpiry.keys()]
    .map((label) => ({ label, ms: parseExpiryLabel(label) }))
    .filter((x) => x.ms > now - 3_600_000)
    .sort((a, b) => a.ms - b.ms);
  if (expiryLabels.length === 0) throw new Error('paradex: no live expiries');

  const pick =
    (expiryLabel && byExpiry.has(expiryLabel) ? expiryLabel : null) ??
    expiryLabels.slice(0, 8).find((e) => e.ms > now + 86_400_000 * 2)?.label ??
    expiryLabels[0].label;

  const items = byExpiry.get(pick) ?? [];
  const expiryMs = Math.max(...items.map((x) => x.expiryAt), parseExpiryLabel(pick));
  const t = Math.max((expiryMs - now) / 365 / 86_400_000, 1 / (365 * 24 * 8));

  // ---- REAL quotes through the SBE bridge (bid/ask/IV/greeks/OI, 1fps) ----
  try {
    const quotes = await paradexLiveQuotes(items.map((x) => x.symbol));
    if (quotes.size >= Math.min(6, items.length)) {
      const anyQ = quotes.values().next().value!;
      const spot = anyQ.indexPrice ?? (await deribitSpot(asset));
      const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
      const fwd = anyQ.forwardRate != null ? spot * (1 + anyQ.forwardRate * t) : forwardPrice(cfg, spot, t);

      const rowMap = new Map<number, VenueChainRow>();
      for (const item of items) {
        const q = quotes.get(item.symbol);
        const row =
          rowMap.get(item.strike) ??
          ({
            strike: item.strike,
            callIv: 0, callPrice: 0, callDelta: 0, callOi: 0, callVolume: 0,
            putIv: 0, putPrice: 0, putDelta: 0, putOi: 0, putVolume: 0,
            isAtm: false,
          } satisfies VenueChainRow);
        const iv = q?.markIv ?? 0;
        if (item.isCall) {
          if (q) {
            row.callIv = iv > 0 ? iv * 100 : 0;
            row.callPrice = q.markPrice ?? (iv > 0 ? bsPrice(spot, item.strike, t, iv, true) : 0);
            row.callDelta = q.delta ?? 0;
            row.callOi = q.openInterest ?? 0;
            row.callVolume = q.volumeUsd24h ?? 0;
            if (q.bid != null && q.bid > 0) row.callBid = q.bid;
            if (q.ask != null && q.ask > 0) row.callAsk = q.ask;
          }
        } else if (q) {
          row.putIv = iv > 0 ? iv * 100 : 0;
          row.putPrice = q.markPrice ?? (iv > 0 ? bsPrice(spot, item.strike, t, iv, false) : 0);
          row.putDelta = q.delta ?? 0;
          row.putOi = q.openInterest ?? 0;
          row.putVolume = q.volumeUsd24h ?? 0;
          if (q.bid != null && q.bid > 0) row.putBid = q.bid;
          if (q.ask != null && q.ask > 0) row.putAsk = q.ask;
        }
        rowMap.set(item.strike, row);
      }

      const rows = buildRows(rowMap, spot, fwd);
      const quoted = rows.filter((r) => r.callBid || r.putBid || r.callAsk || r.putAsk).length;
      if (quoted >= Math.min(4, rows.length)) {
        return {
          venue: 'paradex',
          asset,
          expiry: pick,
          expiryMs,
          daysOut: daysOut(expiryMs),
          spot,
          forward: fwd,
          atmIv: rows.find((r) => r.isAtm)?.callIv ?? 50,
          rows,
          quoteSource: 'live',
          instrumentCount: opts.length,
          fetchMs: Date.now() - t0,
          tsMs: Date.now(),
        };
      }
    }
  } catch {
    // bridge down → fall through to the derived-surface fallback below
  }

  // ---- fallback: real listings priced off the live Deribit IV surface ----
  const spot = await deribitSpot(asset);
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  const fwd = forwardPrice(cfg, spot, t);
  const { byExpiry: surface } = await deribitSurface(asset);
  const rowMap = new Map<number, VenueChainRow>();
  for (const item of items) {
    const iv = interpSurface(surface, expiryMs, item.strike, spot, item.isCall);
    const row =
      rowMap.get(item.strike) ??
      ({
        strike: item.strike,
        callIv: 0, callPrice: 0, callDelta: 0, callOi: 0, callVolume: 0,
        putIv: 0, putPrice: 0, putDelta: 0, putOi: 0, putVolume: 0,
        isAtm: false,
      } satisfies VenueChainRow);
    if (item.isCall) {
      row.callIv = iv * 100;
      row.callPrice = bsPrice(spot, item.strike, t, iv, true);
      row.callDelta = bsDelta(spot, item.strike, t, iv, true);
    } else {
      row.putIv = iv * 100;
      row.putPrice = bsPrice(spot, item.strike, t, iv, false);
      row.putDelta = bsDelta(spot, item.strike, t, iv, false);
    }
    rowMap.set(item.strike, row);
  }

  const rows = buildRows(rowMap, spot, fwd);
  const atmIv = rows.find((r) => r.isAtm)?.callIv ?? 50;
  return {
    venue: 'paradex',
    asset,
    expiry: pick,
    expiryMs,
    daysOut: daysOut(expiryMs),
    spot,
    forward: fwd,
    atmIv,
    rows,
    quoteSource: 'derived',
    instrumentCount: opts.length,
    fetchMs: Date.now() - t0,
    tsMs: Date.now(),
  };
}

// =============================================================================
// DERIVE v3 (ex-Lyra) — REAL quotes from the v3 JSON-RPC REST API
// (https://api.derive.xyz/v3). Instruments: BTC-20261024-83000-P (YYYYMMDD).
// public/get_all_instruments → universe; public/get_tickers → per-expiry
// snapshot with real bid/ask (price + size), IV, greeks, OI, volume, mark.
// =============================================================================

interface DeriveV3Instrument {
  instrument_name: string;
  instrument_type: string;
  is_active: boolean;
  option_details: {
    index: string;
    expiry: number; // unix seconds, 08:00 UTC
    strike: string;
    option_type: 'C' | 'P';
    settlement_price: number | null;
  } | null;
}

interface DeriveV3Ticker {
  t: number;
  b: string; // best bid price (USDC)
  B: string; // best bid amount (underlying)
  a: string; // best ask price
  A: string; // best ask amount
  I: string; // index price
  M: string; // mark price
  option_pricing: {
    d: string; // delta
    g: string; // gamma
    v: string; // vega
    t: string; // theta
    r: string; // rho
    i: string; // IV fraction
    f: string; // forward
    m: string; // model price
  };
  stats: { oi: string; v: string; n: number; h: string; l: string; c: string };
}

async function deriveV3Rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetchJson<{ result?: T; error?: { message?: string } }>(
    `https://api.derive.xyz/v3/${method}`,
    12_000,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
  );
  if (r?.error) throw new Error(`derive v3: ${r.error.message ?? 'rpc error'}`);
  if (r && typeof r === 'object' && 'result' in r) return r.result as T;
  throw new Error(`derive v3: empty ${method}`);
}

function ymdToLabel(ymd: string): string {
  // "20261024" → "24OCT26"
  return msToExpiryLabel(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)), 8, 0, 0));
}

function labelToYmd(label: string): number {
  const ms = parseExpiryLabel(label);
  if (!ms) return 0;
  const d = new Date(ms);
  return Number(
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`,
  );
}

/** Live option instrument universe for an asset (cached 10 min). */
export function deriveInstruments(asset: FeedAsset): Promise<DeriveV3Instrument[]> {
  return cached(`derive:insts:${asset}`, 600_000, async () => {
    const r = await deriveV3Rpc<{ instruments: DeriveV3Instrument[] }>('public/get_all_instruments', {
      currency: asset,
      expired: false,
      instrument_type: 'option',
      page_size: 1000,
    });
    const now = Date.now();
    return (r.instruments ?? []).filter(
      (i) => i.is_active && i.option_details && i.option_details.expiry * 1000 > now - 3_600_000,
    );
  });
}

/** Real per-expiry tickers (cached 10s). Keyed by instrument name. */
export function deriveTickers(asset: FeedAsset, ymd: number): Promise<Map<string, DeriveV3Ticker>> {
  return cached(`derive:tickers:${asset}:${ymd}`, 10_000, async () => {
    const r = await deriveV3Rpc<{ tickers: Record<string, DeriveV3Ticker> }>('public/get_tickers', {
      instrument_type: 'option',
      currency: asset,
      expiry_date: ymd,
    });
    return new Map(Object.entries(r.tickers ?? {}));
  });
}

export async function deriveChain(asset: FeedAsset, expiryLabel?: string): Promise<VenueChain> {
  const t0 = Date.now();
  const instruments = await deriveInstruments(asset);
  if (instruments.length === 0) throw new Error('derive: no live option instruments');

  const now = Date.now();
  const byExpiry = new Map<string, { strike: number; isCall: boolean; expiryMs: number }[]>();
  for (const inst of instruments) {
    const m = /^([A-Z]+)-(\d{8})-(\d+)-([CP])$/.exec(inst.instrument_name);
    if (!m || m[1] !== asset) continue;
    const label = ymdToLabel(m[2]);
    const expiryMs = inst.option_details!.expiry * 1000;
    const arr = byExpiry.get(label) ?? [];
    arr.push({ strike: Number(m[3]), isCall: m[4] === 'C', expiryMs });
    byExpiry.set(label, arr);
  }
  const expiryLabels = [...byExpiry.keys()]
    .map((label) => ({ label, ms: parseExpiryLabel(label) }))
    .filter((x) => x.ms > now - 3_600_000)
    .sort((a, b) => a.ms - b.ms);
  if (expiryLabels.length === 0) throw new Error('derive: no live expiries');

  const pick =
    (expiryLabel && byExpiry.has(expiryLabel) ? expiryLabel : null) ??
    expiryLabels.slice(0, 8).find((e) => e.ms > now + 86_400_000)?.label ??
    expiryLabels[0].label;

  const items = byExpiry.get(pick) ?? [];
  const expiryMs = items[0]?.expiryMs ?? parseExpiryLabel(pick);
  const t = Math.max((expiryMs - now) / 365 / 86_400_000, 1 / (365 * 24 * 8));
  const ymd = labelToYmd(pick);

  const tickers = await deriveTickers(asset, ymd);
  if (tickers.size === 0) throw new Error('derive: no tickers for expiry');

  // index + forward from any ticker (all share the index)
  const first = tickers.values().next().value;
  const spot = Number(first?.I ?? 0) || (await deribitSpot(asset));
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  const fwd = Number(first?.option_pricing?.f ?? 0) || forwardPrice(cfg, spot, t);

  const rowMap = new Map<number, VenueChainRow>();
  for (const item of items) {
    const name = `${asset}-${ymd}-${item.strike}-${item.isCall ? 'C' : 'P'}`;
    const tk = tickers.get(name);
    const row =
      rowMap.get(item.strike) ??
      ({
        strike: item.strike,
        callIv: 0, callPrice: 0, callDelta: 0, callOi: 0, callVolume: 0,
        putIv: 0, putPrice: 0, putDelta: 0, putOi: 0, putVolume: 0,
        isAtm: false,
      } satisfies VenueChainRow);
    if (tk) {
      const iv = Number(tk.option_pricing?.i ?? 0);
      const ivPct = iv > 0 && iv < 5 ? iv * 100 : 0;
      const mark = Number(tk.M ?? 0);
      const bid = Number(tk.b ?? 0);
      const ask = Number(tk.a ?? 0);
      const delta = Number(tk.option_pricing?.d ?? 0);
      const oi = Number(tk.stats?.oi ?? 0);
      const vol = Number(tk.stats?.v ?? 0);
      if (item.isCall) {
        row.callIv = ivPct;
        row.callPrice = mark || (iv > 0 ? bsPrice(spot, item.strike, t, iv, true) : 0);
        row.callDelta = delta;
        row.callOi = oi;
        row.callVolume = vol;
        if (bid > 0) row.callBid = bid;
        if (ask > 0) row.callAsk = ask;
      } else {
        row.putIv = ivPct;
        row.putPrice = mark || (iv > 0 ? bsPrice(spot, item.strike, t, iv, false) : 0);
        row.putDelta = delta;
        row.putOi = oi;
        row.putVolume = vol;
        if (bid > 0) row.putBid = bid;
        if (ask > 0) row.putAsk = ask;
      }
    }
    rowMap.set(item.strike, row);
  }

  const rows = buildRows(rowMap, spot, fwd);
  if (rows.length === 0) throw new Error('derive: empty chain');
  return {
    venue: 'derive',
    asset,
    expiry: pick,
    expiryMs,
    daysOut: daysOut(expiryMs),
    spot,
    forward: fwd,
    atmIv: rows.find((x) => x.isAtm)?.callIv ?? 50,
    rows,
    quoteSource: 'live',
    instrumentCount: instruments.length,
    fetchMs: Date.now() - t0,
    tsMs: Date.now(),
  };
}

// =============================================================================
// Unified access
// =============================================================================

const CHAIN_BUILDERS: Partial<Record<VenueId, (asset: FeedAsset, expiry?: string) => Promise<VenueChain>>> = {
  deribit: deribitChain,
  bybit: bybitChain,
  okx: okxChain,
  aevo: aevoChain,
  paradex: paradexChain,
  derive: deriveChain,
};

/** Get a normalized live chain from one venue (cached 8s, never throws). */
export async function getVenueChain(
  venue: VenueId,
  asset: FeedAsset,
  expiry?: string,
): Promise<{ chain: VenueChain | null; error?: string }> {
  const builder = CHAIN_BUILDERS[venue];
  if (!builder) return { chain: null, error: `${venue}: no options chain (perps/spot venue)` };
  try {
    const chain = await cached(`chain:${venue}:${asset}:${expiry ?? 'auto'}`, 8_000, () =>
      builder(asset, expiry),
    );
    return { chain };
  } catch (err) {
    return { chain: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Prefer a venue, fall back through the rest. */
export async function getBestChain(
  asset: FeedAsset,
  preferred: VenueId = 'deribit',
  expiry?: string,
): Promise<{ chain: VenueChain | null; tried: { venue: VenueId; error?: string }[] }> {
  const order: VenueId[] = [preferred, ...VENUE_IDS.filter((v) => v !== preferred)];
  const tried: { venue: VenueId; error?: string }[] = [];
  for (const v of order) {
    const { chain, error } = await getVenueChain(v, asset, expiry);
    if (chain) {
      tried.push({ venue: v });
      return { chain, tried };
    }
    tried.push({ venue: v, error });
  }
  return { chain: null, tried };
}

/** All venue healths at once (cached 30s) — chain venues via their chains,
 *  perp/spot venues (Binance · Hyperliquid · Lighter) via their own APIs. */
export async function getVenueStatuses(asset: FeedAsset = 'BTC'): Promise<VenueStatus[]> {
  return cached(`statuses:${asset}`, 30_000, async () => {
    const jobs = VENUE_IDS.map(async (v): Promise<VenueStatus> => {
      if (PERP_VENUES.includes(v)) return perpVenueStatus(v, asset);
      const t0 = Date.now();
      const base: VenueStatus = {
        id: v,
        name: VENUE_META[v].name,
        status: 'unreachable',
        latencyMs: 0,
        instruments: 0,
        spot: null,
        atmIv: null,
        note: '',
      };
      try {
        const { chain } = await getVenueChain(v, asset);
        const latency = Date.now() - t0;
        if (!chain) throw new Error('no chain');
        return {
          ...base,
          status: chain.quoteSource === 'live' ? 'live' : 'degraded',
          latencyMs: latency,
          instruments: chain.instrumentCount,
          spot: chain.spot,
          atmIv: chain.atmIv,
          note:
            chain.quoteSource === 'live'
              ? 'native quotes'
              : 'listings live · quotes derived from cross-venue IV surface',
        };
      } catch (err) {
        return {
          ...base,
          latencyMs: Date.now() - t0,
          note: err instanceof Error ? err.message.slice(0, 90) : 'unreachable',
        };
      }
    });
    return Promise.all(jobs);
  });
}

// ── perp / spot-only venues: Binance · Hyperliquid · Lighter ─────────────

/** Binance spot tickers (BTC/ETH/SOL) — also the primary live-price source. */
export async function binanceSpots(): Promise<
  Record<FeedAsset, { spot: number; change24hPct: number; volumeUsd: number }>
> {
  return cached('binance:spots', 20_000, async () => {
    const symbols: Record<FeedAsset, string> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(
      JSON.stringify(Object.values(symbols)),
    )}`;
    const rows = await fetchJson<
      { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[]
    >(url, 9000);
    const out: Partial<Record<FeedAsset, { spot: number; change24hPct: number; volumeUsd: number }>> = {};
    for (const r of rows) {
      const asset = (Object.keys(symbols) as FeedAsset[]).find((a) => symbols[a] === r.symbol);
      if (!asset) continue;
      out[asset] = {
        spot: Number(r.lastPrice),
        change24hPct: Number(r.priceChangePercent),
        volumeUsd: Number(r.quoteVolume),
      };
    }
    if (!out.BTC?.spot) throw new Error('binance empty');
    return out as Record<FeedAsset, { spot: number; change24hPct: number; volumeUsd: number }>;
  });
}

/** Hyperliquid L1 perps (mark, funding, OI, 24h volume) for BTC/ETH/SOL. */
export async function hyperliquidPerps(): Promise<
  Record<FeedAsset, { mark: number; change24hPct: number; funding8h: number; openInterestUsd: number; dayVolumeUsd: number; maxLeverage: number }>
> {
  return cached('hl:perps', 20_000, async () => {
    // Response shape: [ { universe: [...] }, assetCtxs[] ]
    const raw = await fetchJson<[{ universe?: { name: string; maxLeverage: number }[] }, unknown]>(
      'https://api.hyperliquid.xyz/info',
      9000,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      },
    );
    const universe = Array.isArray(raw?.[0]?.universe) ? raw[0].universe : [];
    const ctxs = (Array.isArray(raw?.[1]) ? raw[1] : []) as {
      markPx: string;
      prevDayPx: string;
      funding: string;
      openInterest: string;
      dayNtlVlm: string;
    }[];
    const out: Partial<
      Record<FeedAsset, { mark: number; change24hPct: number; funding8h: number; openInterestUsd: number; dayVolumeUsd: number; maxLeverage: number }>
    > = {};
    universe.forEach((u, i) => {
      if (u.name !== 'BTC' && u.name !== 'ETH' && u.name !== 'SOL') return;
      const ctx = ctxs[i];
      if (!ctx) return;
      const mark = Number(ctx.markPx);
      const prev = Number(ctx.prevDayPx);
      out[u.name as FeedAsset] = {
        mark,
        change24hPct: prev > 0 ? ((mark - prev) / prev) * 100 : 0,
        funding8h: Number(ctx.funding),
        openInterestUsd: Number(ctx.openInterest) * mark,
        dayVolumeUsd: Number(ctx.dayNtlVlm),
        maxLeverage: u.maxLeverage,
      };
    });
    if (!out.BTC?.mark) throw new Error('hyperliquid empty');
    return out as Record<
      FeedAsset,
      { mark: number; change24hPct: number; funding8h: number; openInterestUsd: number; dayVolumeUsd: number; maxLeverage: number }
    >;
  });
}

/** Lighter zk-rollup perps tickers (public REST; graceful when unreachable). */
export async function lighterPerps(): Promise<
  Record<FeedAsset, { mark: number; change24hPct: number; volumeUsd: number }>
> {
  return cached('lighter:perps', 25_000, async () => {
    const markets: Record<FeedAsset, string> = {
      BTC: 'PERP_BTC_USDC',
      ETH: 'PERP_ETH_USDC',
      SOL: 'PERP_SOL_USDC',
    };
    const out: Partial<Record<FeedAsset, { mark: number; change24hPct: number; volumeUsd: number }>> = {};
    await Promise.all(
      (Object.keys(markets) as FeedAsset[]).map(async (asset) => {
        const r = await fetchJson<
          { last_price: string; price_change_percent_24h?: string; quote_volume?: string }
        >(`https://mainnet.zklighter.cc/api/v1/ticker?market=${markets[asset]}`, 7000);
        const mark = Number(r.last_price);
        if (mark > 0) {
          out[asset] = {
            mark,
            change24hPct: Number(r.price_change_percent_24h ?? '0'),
            volumeUsd: Number(r.quote_volume ?? '0'),
          };
        }
      }),
    );
    if (!out.BTC?.mark) throw new Error('lighter empty');
    return out as Record<FeedAsset, { mark: number; change24hPct: number; volumeUsd: number }>;
  });
}

async function perpVenueStatus(v: VenueId, asset: FeedAsset): Promise<VenueStatus> {
  const t0 = Date.now();
  const base: VenueStatus = {
    id: v,
    name: VENUE_META[v].name,
    status: 'unreachable',
    latencyMs: 0,
    instruments: 0,
    spot: null,
    atmIv: null,
    note: '',
  };
  try {
    if (v === 'binance') {
      const spots = await binanceSpots();
      const s = spots[asset];
      return {
        ...base,
        status: 'live',
        latencyMs: Date.now() - t0,
        instruments: 3,
        spot: s.spot,
        note: `spot + USDT perps · ${s.change24hPct.toFixed(2)}% 24h · no options book`,
      };
    }
    if (v === 'hyperliquid') {
      const perps = await hyperliquidPerps();
      const p = perps[asset];
      return {
        ...base,
        status: 'live',
        latencyMs: Date.now() - t0,
        instruments: 3,
        spot: p.mark,
        note: `L1 perps · ${p.maxLeverage}x max · funding ${(p.funding8h * 3 * 365 * 100).toFixed(1)}% APR · OI $${(p.openInterestUsd / 1e6).toFixed(0)}M`,
      };
    }
    const lp = await lighterPerps();
    const l = lp[asset];
    return {
      ...base,
      status: 'live',
      latencyMs: Date.now() - t0,
      instruments: 3,
      spot: l.mark,
      note: 'zk-rollup perps + perpetual options · gas-free · maker rebates',
    };
  } catch (err) {
    return {
      ...base,
      latencyMs: Date.now() - t0,
      note: err instanceof Error ? `${err.message.slice(0, 60)} — venue API unreachable from this network` : 'unreachable',
    };
  }
}

/** Real spot prices — Binance first (all 3 in one call), then Deribit index,
 *  Bybit fallback. Cached 20s. */
export async function getLiveSpots(): Promise<LiveSpots> {
  return cached('spots:all', 20_000, async () => {
    const out = { BTC: 0, ETH: 0, SOL: 0 } as LiveSpots;
    // Binance spot — one call covers BTC/ETH/SOL.
    try {
      const b = await binanceSpots();
      return { BTC: b.BTC.spot, ETH: b.ETH.spot, SOL: b.SOL.spot, source: 'binance spot', tsMs: Date.now() };
    } catch {
      // fall through to per-asset sources
    }
    let source = 'deribit index';
    await Promise.all(
      (['BTC', 'ETH', 'SOL'] as FeedAsset[]).map(async (a) => {
        try {
          out[a] = await deribitSpot(a);
        } catch {
          try {
            out[a] = await bybitSpot(a);
            source = 'bybit spot';
          } catch {
            out[a] = 0;
          }
        }
      }),
    );
    if (!out.BTC) source = 'simulated (venues unreachable)';
    return { ...out, source, tsMs: Date.now() };
  });
}

/** Real ATM IV (~30d) from Deribit, cached 60s. */
export async function getLiveAtmIv(asset: FeedAsset): Promise<number | null> {
  try {
    return await cached(`atmiv:${asset}`, 60_000, async () => {
      const chain = await deribitChain(asset);
      // nearest expiry > 20 days out for a stable 30d-ish read
      return chain.atmIv;
    });
  } catch {
    return null;
  }
}

// =============================================================================
// Historical data (for backtesting + live-anchored technicals)
// =============================================================================

export interface HistBar {
  t: number; // ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type HistInterval = '15m' | '1h' | '4h' | '1d';

const BYBIT_INTERVAL: Record<HistInterval, string> = { '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

/**
 * Real spot OHLCV history from Bybit (public, no auth). Up to `bars` bars
 * (paginated 1000/call), cached 10 min.
 */
export async function getHistory(asset: FeedAsset, interval: HistInterval, bars = 400): Promise<HistBar[]> {
  return cached(`hist:${asset}:${interval}:${bars}`, 600_000, async () => {
    const all: HistBar[] = [];
    let endTime: number | undefined;
    const perCall = Math.min(bars, 1000);
    while (all.length < bars) {
      const url =
        `https://api.bybit.com/v5/market/kline?category=spot&symbol=${asset}USDT` +
        `&interval=${BYBIT_INTERVAL[interval]}&limit=${perCall}` +
        (endTime ? `&end=${endTime}` : '');
      const r = await fetchJson<{ result: { list: string[][] } }>(url, 9000);
      const rows = r.result?.list ?? [];
      if (rows.length === 0) break;
      // newest-first → chronological
      const page: HistBar[] = rows
        .map((x) => ({ t: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) }))
        .sort((a, b) => a.t - b.t);
      all.unshift(...page);
      endTime = page[0].t - 1;
      if (rows.length < perCall) break;
    }
    if (all.length === 0) throw new Error('no history');
    return all.slice(-bars);
  });
}

/** Deribit 30d historical realized vol series (daily samples, ~1 year), cached 1h. */
export async function getHistVolSeries(asset: FeedAsset): Promise<{ t: number; vol: number }[]> {
  return cached(`histvol:${asset}`, 3_600_000, async () => {
    const end = Date.now();
    const start = end - 370 * 86_400_000;
    const r = await fetchJson<{ result: [number, number][] }>(
      `https://www.deribit.com/api/v2/public/get_historical_volatility?currency=${asset}&start_timestamp=${Math.floor(start / 1000)}&end_timestamp=${Math.floor(end / 1000)}`,
      10_000,
    );
    const raw = r.result ?? [];
    // hourly samples → daily last
    const daily = new Map<number, number>();
    for (const [ts, v] of raw) daily.set(Math.floor(ts / 86_400_000), v / 100);
    return [...daily.entries()].sort((a, b) => a[0] - b[0]).map(([d, v]) => ({ t: d * 86_400_000, vol: v }));
  });
}

// =============================================================================
// Cross-venue best execution (smart routing)
// =============================================================================

export interface BestQuote {
  strike: number;
  kind: 'call' | 'put';
  bestBid: number;
  bestBidVenue: VenueId;
  bestAsk: number;
  bestAskVenue: VenueId;
  venues: { venue: VenueId; bid?: number; ask?: number; iv: number }[];
}

/** Best bid/ask per option across every live venue (for routing + multihop). */
export async function getCrossVenueQuotes(asset: FeedAsset, expiry?: string): Promise<{
  quotes: BestQuote[];
  chains: { venue: VenueId; expiry: string; quoteSource: string; error?: string }[];
  spot: number;
}> {
  const results = await Promise.all(
    VENUE_IDS.map(async (v) => {
      const { chain, error } = await getVenueChain(v, asset, expiry);
      return { venue: v, chain, error };
    }),
  );
  const live = results.filter((r) => r.chain);
  const spot = live[0]?.chain?.spot ?? 0;

  const map = new Map<string, BestQuote>();
  for (const { venue, chain } of live) {
    for (const row of chain!.rows) {
      for (const kind of ['call', 'put'] as const) {
        const bid = kind === 'call' ? row.callBid : row.putBid;
        const ask = kind === 'call' ? row.callAsk : row.putAsk;
        const iv = kind === 'call' ? row.callIv : row.putIv;
        const key = `${kind}:${row.strike}`;
        const q =
          map.get(key) ??
          ({
            strike: row.strike,
            kind,
            bestBid: 0,
            bestBidVenue: venue,
            bestAsk: Infinity,
            bestAskVenue: venue,
            venues: [],
          } as BestQuote);
        q.venues.push({ venue, bid, ask, iv });
        if (bid != null && bid > q.bestBid) {
          q.bestBid = bid;
          q.bestBidVenue = venue;
        }
        if (ask != null && ask > 0 && ask < q.bestAsk) {
          q.bestAsk = ask;
          q.bestAskVenue = venue;
        }
        map.set(key, q);
      }
    }
  }
  for (const q of map.values()) if (!Number.isFinite(q.bestAsk)) q.bestAsk = 0;

  return {
    quotes: [...map.values()].sort((a, b) => a.strike - b.strike),
    chains: results.map((r) => ({
      venue: r.venue,
      expiry: r.chain?.expiry ?? '',
      quoteSource: r.chain?.quoteSource ?? '',
      error: r.error,
    })),
    spot,
  };
}

/** Expiry calendar for one venue (cached 30s, never throws). */
export async function getVenueExpiries(
  venue: VenueId,
  asset: FeedAsset,
): Promise<{ expiries: VenueExpiry[]; error?: string }> {
  try {
    const { chain } = await getVenueChain(venue, asset);
    if (!chain) throw new Error('venue unreachable');
    const expiries: VenueExpiry[] = [
      {
        label: chain.expiry,
        ms: chain.expiryMs,
        daysOut: chain.daysOut,
        instruments: chain.instrumentCount,
      },
    ];
    // richer calendar from the raw listing endpoints where cheap
    if (venue === 'deribit') {
      const summary = await deribitSummary(asset);
      const counts = new Map<string, number>();
      for (const s of summary) {
        const p = parseDeribName(s.instrument_name);
        if (!p || p.asset !== asset) continue;
        counts.set(p.expiry, (counts.get(p.expiry) ?? 0) + 1);
      }
      const now = Date.now();
      expiries.length = 0;
      for (const [label, n] of counts) {
        const ms = parseExpiryLabel(label);
        if (ms < now - 3_600_000) continue;
        expiries.push({ label, ms, daysOut: daysOut(ms), instruments: n });
      }
      expiries.sort((a, b) => a.ms - b.ms);
    } else if (venue === 'derive') {
      const instruments = await deriveInstruments(asset);
      const counts = new Map<string, number>();
      for (const inst of instruments) {
        const m = /^([A-Z]+)-(\d{8})-(\d+)-([CP])$/.exec(inst.instrument_name);
        if (!m || m[1] !== asset) continue;
        const label = ymdToLabel(m[2]);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const now = Date.now();
      expiries.length = 0;
      for (const [label, n] of counts) {
        const ms = parseExpiryLabel(label);
        if (ms < now - 3_600_000) continue;
        expiries.push({ label, ms, daysOut: daysOut(ms), instruments: n });
      }
      expiries.sort((a, b) => a.ms - b.ms);
    } else if (venue === 'paradex') {
      const all = await paradexMarkets();
      const counts = new Map<string, number>();
      for (const mkt of all) {
        if (mkt.asset_kind !== 'OPTION') continue;
        const p = parseParadexSymbol(mkt.symbol);
        if (!p || p.asset !== asset || !mkt.expiry_at) continue;
        const label = msToExpiryLabel(mkt.expiry_at);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const now = Date.now();
      expiries.length = 0;
      for (const [label, n] of counts) {
        const ms = parseExpiryLabel(label);
        if (ms < now - 3_600_000) continue;
        expiries.push({ label, ms, daysOut: daysOut(ms), instruments: n });
      }
      expiries.sort((a, b) => a.ms - b.ms);
    }
    return { expiries: expiries.slice(0, 12) };
  } catch (err) {
    return { expiries: [], error: err instanceof Error ? err.message : String(err) };
  }
}

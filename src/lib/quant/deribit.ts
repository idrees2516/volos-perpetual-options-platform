// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · deribit — public Deribit v2 REST client (no key required).
//
// The options truth source for BTC/ETH: full-chain book summaries (bid/ask/
// mark/IV/OI per instrument), the cross-instrument trade tape, dated futures
// for true per-expiry forwards, historical realized vol.
// ─────────────────────────────────────────────────────────────────────────────

const DERIBIT = 'https://www.deribit.com/api/v2';

export interface DeribitBookSummary {
  instrument_name: string;
  bid_price: number | null;
  ask_price: number | null;
  mid_price: number | null;
  mark_price: number;
  open_interest: number;
  volume: number;
  volume_usd?: number;
  mark_iv?: number;
  underlying_price?: number;
  underlying_index?: string;
  base_currency: string;
  quote_currency: string;
  estimated_delivery_price?: number;
}

export interface DeribitTrade {
  trade_id: string;
  instrument_name: string;
  timestamp: number;
  iv?: number;
  price: number;
  direction: 'buy' | 'sell';
  index_price: number;
  amount: number;
  mark_price?: number;
}

export interface DeribitFuture {
  instrument_name: string;
  mark_price: number;
  open_interest: number;
  estimated_delivery_price?: number;
}

interface CacheEntry<T> {
  v: T;
  ts: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

export class DeribitError extends Error {
  constructor(msg: string, public status?: number) {
    super(msg);
  }
}

async function deribitGet<T>(path: string, params: Record<string, string | number | boolean | undefined>, timeoutMs = 15000): Promise<T> {
  const attempt = async (): Promise<T> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const url = `${DERIBIT}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) throw new DeribitError(`deribit ${path} http ${res.status}`, res.status);
      const json = (await res.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new DeribitError(`deribit ${path}: ${json.error.message}`);
      if (json.result === undefined) throw new DeribitError(`deribit ${path}: empty result`);
      return json.result;
    } finally {
      clearTimeout(to);
    }
  };
  try {
    return await attempt();
  } catch (e) {
    // one retry — venue/network hiccups shouldn't poison a cache slot
    await new Promise((r) => setTimeout(r, 600));
    return attempt();
  }
}

/** Cached fetch helper (age in ms). */
async function cached<T>(key: string, maxAgeMs: number, fn: () => Promise<T>): Promise<{ v: T; ts: number; ageMs: number }> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < maxAgeMs) return { v: hit.v, ts: hit.ts, ageMs: Date.now() - hit.ts };
  const v = await fn();
  const ts = Date.now();
  cache.set(key, { v, ts });
  return { v, ts, ageMs: 0 };
}

/** Full option book summary for a currency (all strikes/expiries). */
export async function optionBookSummary(currency: string, maxAgeMs = 4000) {
  return cached<DeribitBookSummary[]>(`book:${currency}:option`, maxAgeMs, () =>
    deribitGet<DeribitBookSummary[]>('/public/get_book_summary_by_currency', { currency, kind: 'option' }),
  );
}

/** Dated futures + perpetual book summary (for forwards & term structure). */
export async function futureBookSummary(currency: string, maxAgeMs = 15000) {
  return cached<DeribitBookSummary[]>(`book:${currency}:future`, maxAgeMs, () =>
    deribitGet<DeribitBookSummary[]>('/public/get_book_summary_by_currency', { currency, kind: 'future' }),
  );
}

/** Index price (spot truth). */
export async function indexPrice(currency: string, maxAgeMs = 5000) {
  return cached<{ price: number; ts: number }>(`index:${currency}`, maxAgeMs, async () => {
    const r = await deribitGet<{ index_price: number; timestamp: number } | { current_price?: number; timestamp?: number }[]>(
      '/public/ticker',
      { instrument_name: `${currency}_USDT` },
    ).catch(async () => {
      // fallback: perpetual's estimated delivery
      const fs = await futureBookSummary(currency, maxAgeMs);
      const perp = fs.v.find((f) => f.instrument_name === `${currency}-PERPETUAL`);
      return { index_price: perp?.estimated_delivery_price ?? perp?.mark_price ?? 0, timestamp: fs.ts };
    });
    const price = Array.isArray(r) ? (r[0]?.current_price ?? 0) : r.index_price;
    return { price, ts: Array.isArray(r) ? (r[0]?.timestamp ?? Date.now()) : r.timestamp ?? Date.now() };
  });
}

/**
 * Recent option trades across all instruments (the tape feed).
 * `endTs` set → page history backwards via the _and_time endpoint;
 * otherwise → the latest prints via the plain by-currency endpoint.
 */
export async function optionTrades(currency: string, count = 500, endTs?: number, maxAgeMs = 0) {
  const key = `trades:${currency}:${count}:${endTs ?? 'latest'}`;
  return cached<{ trades: DeribitTrade[]; ts: number }>(key, maxAgeMs, async () => {
    const r = endTs
      ? await deribitGet<{ trades: DeribitTrade[] }>('/public/get_last_trades_by_currency_and_time', {
          currency,
          kind: 'option',
          count,
          include_old: true,
          start_timestamp: 0,
          end_timestamp: endTs,
        })
      : await deribitGet<{ trades: DeribitTrade[] }>('/public/get_last_trades_by_currency', {
          currency,
          kind: 'option',
          count,
          include_old: true,
        });
    return { trades: r.trades ?? [], ts: Date.now() };
  });
}

/** Historical realized volatility (daily points). */
export async function historicalVolatility(currency: string, maxAgeMs = 30 * 60_000) {
  return cached<[number, number][]>(`histvol:${currency}`, maxAgeMs, () =>
    deribitGet<[number, number][]>('/public/get_historical_volatility', { currency }),
  );
}

/** DVOL volatility index (BTC/ETH): current + hourly series (2 days). */
export async function dvolSnapshot(currency: string, maxAgeMs = 60_000): Promise<{ currentPct: number; changePct: number | null; series: { ts: number; v: number }[] } | null> {
  const key = `dvol:${currency}`;
  const hit = cache.get(key) as CacheEntry<{ currentPct: number; changePct: number | null; series: { ts: number; v: number }[] }> | undefined;
  if (hit && Date.now() - hit.ts < maxAgeMs) return hit.v;
  const end = Date.now();
  const start = end - 2 * 864e5;
  const r = await deribitGet<{ data: [number, number, number, number, number][] } | null>(
    '/public/get_volatility_index_data',
    { currency, start_timestamp: Math.floor(start / 1000), end_timestamp: Math.floor(end / 1000), resolution: 3600 },
  ).catch(() => null);
  if (!r?.data?.length) return null;
  // rows: [ts(ms), open, high, low, close] — take closes
  const series = r.data.filter((d) => Number.isFinite(d[4])).map((d) => ({ ts: d[0], v: d[4] }));
  if (!series.length) return null;
  const current = series[series.length - 1].v;
  const dayAgo = series.find((p) => p.ts >= end - 864e5) ?? series[0];
  const changePct = dayAgo.v > 0 ? ((current - dayAgo.v) / dayAgo.v) * 100 : null;
  const out = { currentPct: current, changePct, series };
  cache.set(key, { v: out, ts: Date.now() });
  return out;
}

export interface InstrumentMeta {
  instrument_name: string;
  expiration_timestamp: number;
  strike?: number;
  option_type?: number; // 0 call? (unused — parsed from name)
  is_active: boolean;
}

/** Active option instruments (parse strikes/expiries from names). */
export async function optionInstruments(currency: string, maxAgeMs = 10 * 60_000) {
  return cached<InstrumentMeta[]>(`instruments:${currency}`, maxAgeMs, () =>
    deribitGet<InstrumentMeta[]>('/public/get_instruments', { currency, kind: 'option', expired: false }),
  );
}

// ── instrument name parsing ─────────────────────────────────────────────────

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** `BTC-27NOV26-102000-C` → parts. */
export function parseOptionName(name: string): { symbol: string; expiryTs: number; strike: number; isCall: boolean; expiry: string } | null {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(name);
  if (!m) return null;
  const [, symbol, day, mon, yy, strike, cp] = m;
  const year = 2000 + parseInt(yy, 10);
  const month = MONTHS[mon];
  if (month === undefined) return null;
  const d = parseInt(day, 10);
  const expiryTs = Date.UTC(year, month, d, 8, 0, 0); // Deribit 08:00 UTC expiry
  const expiry = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { symbol, expiryTs, strike: parseFloat(strike), isCall: cp === 'C', expiry };
}

/** `BTC-27NOV26` / `BTC-PERPETUAL` → expiry ts (null for perp). */
export function parseFutureName(name: string): { symbol: string; expiryTs: number | null } | null {
  const perp = /^([A-Z]+)-PERPETUAL$/.exec(name);
  if (perp) return { symbol: perp[1], expiryTs: null };
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})$/.exec(name);
  if (!m) return null;
  const year = 2000 + parseInt(m[4], 10);
  const month = MONTHS[m[3]];
  if (month === undefined) return null;
  return { symbol: m[1], expiryTs: Date.UTC(year, month, parseInt(m[2], 10), 8, 0, 0) };
}

export const deribitVenue = { optionBookSummary, futureBookSummary, indexPrice, optionTrades, historicalVolatility, optionInstruments };

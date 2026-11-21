// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · markets — Binance/Bybit/OKX public clients for the perp picture:
// candles (with taker-buy for CVD), open interest + history, funding, and
// cross-venue OI distribution. All keyless public endpoints.
// ─────────────────────────────────────────────────────────────────────────────

const BINANCE_F = 'https://fapi.binance.com';
const BYBIT = 'https://api.bybit.com';
const OKX = 'https://www.okx.com';

export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  takerBuy: number;
}

async function jget<T>(url: string, timeoutMs = 12000, headers?: Record<string, string>): Promise<T> {
  const attempt = async (): Promise<T> => {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 VolOS/1.0',
          ...headers,
        },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`http ${res.status} ${url.slice(0, 80)}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(to);
    }
  };
  try {
    return await attempt();
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return attempt(); // one retry — transient venue/network hiccups
  }
}

/** USDT-perp klines with taker buy volume (CVD source).
 *  `startTime`/`endTime` (epoch ms) make paged history possible for chart feeds.
 *  Binance fapi first; when the host's egress is geo-blocked (HTTP 451) the same
 *  perp history is served by OKX (taker-buy approximated from the bar body —
 *  the documented heuristic: bullish bars carry more taker buys). */
export async function candles(symbol: string, interval = '5m', limit = 480, range?: { startTime?: number; endTime?: number }): Promise<Candle[]> {
  try {
    let url = `${BINANCE_F}/fapi/v1/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
    if (range?.startTime) url += `&startTime=${Math.floor(range.startTime)}`;
    if (range?.endTime) url += `&endTime=${Math.floor(range.endTime)}`;
    const r = await jget<unknown[][]>(url);
    if (r.length) {
      return r.map((k) => ({
        ts: Number(k[0]),
        o: Number(k[1]),
        h: Number(k[2]),
        l: Number(k[3]),
        c: Number(k[4]),
        v: Number(k[5]),
        takerBuy: Number(k[9]),
      }));
    }
  } catch {
    /* geo-blocked / transient — OKX fallback below */
  }
  return okxCandles(symbol, interval, limit, range);
}

const OKX_INTERVAL: Record<string, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '2h': '2H',
  '4h': '4H',
  '1d': '1D',
  '1w': '1W',
};

/** OKX USDT-perp candles — the Binance fallback. Rows arrive NEWEST-first
 *  (paginate older with `after`); we sort ascending and keep the newest
 *  `limit` inside the requested window. */
async function okxCandles(symbol: string, interval: string, limit: number, range?: { startTime?: number; endTime?: number }): Promise<Candle[]> {
  const instId = `${symbol.replace('USDT', '')}-USDT-SWAP`;
  const bar = OKX_INTERVAL[interval] ?? interval;
  const want = Math.max(1, Math.min(1000, Math.round(limit)));
  const out: Candle[] = [];
  let after: string | undefined = range?.endTime ? String(Math.floor(range.endTime)) : undefined;
  for (let page = 0; page < 10 && out.length < want; page++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 12_000);
    try {
      const url = new URL(`${OKX}/api/v5/market/candles`);
      url.searchParams.set('instId', instId);
      url.searchParams.set('bar', bar);
      url.searchParams.set('limit', String(Math.min(300, want - out.length)));
      if (after) url.searchParams.set('after', after);
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`okx ${res.status}`);
      const body = (await res.json()) as { code?: string; data?: unknown[][] };
      if (body.code !== '0' || !body.data?.length) break;
      const rows = body.data;
      for (const r of rows) {
        const ts = Number(r[0]);
        const o = Number(r[1]);
        const h = Number(r[2]);
        const l = Number(r[3]);
        const c = Number(r[4]);
        const v = Number(r[5]);
        if (![ts, o, h, l, c, v].every(Number.isFinite)) continue;
        if (range?.startTime && ts < Math.floor(range.startTime)) continue;
        const rng = Math.max(1e-12, h - l);
        const share = Math.min(0.9, Math.max(0.1, 0.5 + 0.4 * ((c - o) / rng)));
        out.push({ ts, o, h, l, c, v, takerBuy: v * share });
      }
      after = String(rows[rows.length - 1][0]); // walk older
      if (range?.startTime && Number(after) < Math.floor(range.startTime)) break;
    } catch (e) {
      if (out.length) break; // partial history beats none
      throw e;
    } finally {
      clearTimeout(to);
    }
  }
  if (!out.length) throw new Error(`okx candles empty for ${instId} ${bar}`);
  const dedup = new Map<number, Candle>();
  for (const c of out) dedup.set(c.ts, c);
  return [...dedup.values()].sort((a, b) => a.ts - b.ts).slice(-want);
}

/** Paged history sweep: `countBack` bars ending at `to` (or now), walking
 *  startTime backwards in ≤1000-bar slices — the chart desk's deep history. */
export async function candlesPaged(symbol: string, interval: string, countBack: number, to?: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = to ?? Date.now();
  let remaining = Math.max(60, Math.min(5000, Math.round(countBack)));
  const guard = Date.now() - 1000 * 60 * 60 * 24 * 365 * 8; // 8-year floor
  while (remaining > 0 && end > guard) {
    const slice = Math.min(remaining, 1000);
    const batch = await candles(symbol, interval, slice, { endTime: end }).catch(() => [] as Candle[]);
    if (!batch.length) break;
    // batches arrive ascending; keep the newest `slice` of them
    const kept = batch.slice(-slice);
    for (const c of kept) {
      if (!out.length || c.ts < out[0].ts) out.unshift(c);
      else if (c.ts > out[out.length - 1].ts) out.push(c);
    }
    const oldest = kept[0].ts;
    if (out.length >= remaining + 1) break;
    remaining -= kept.length;
    end = oldest - 1;
    if (batch.length < slice) break; // venue exhausted this window
  }
  // dedupe by ts, ascending
  const seen = new Map<number, Candle>();
  for (const c of out) seen.set(c.ts, c);
  return [...seen.values()].sort((a, b) => a.ts - b.ts);
}

// ── whole-market sweep (one call each — the breadth/treemap sources) ────────

export interface Ticker24 {
  symbol: string; // venue symbol, e.g. BTCUSDT
  lastPrice: number;
  changePct: number; // 24h price change, percent
  quoteVolume: number; // 24h turnover in USDT
  trades: number;
}

/** Every USDT-perp's 24h ticker in ONE call (Binance fapi weight 40). */
export async function tickers24h(): Promise<Ticker24[]> {
  const r = await jget<
    Array<{ symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string; count: number }>
  >(`${BINANCE_F}/fapi/v1/ticker/24hr`);
  return r
    .filter((t) => /^[A-Z0-9]{2,10}USDT$/.test(t.symbol))
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: Number(t.lastPrice),
      changePct: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume),
      trades: Number(t.count),
    }))
    .filter((t) => Number.isFinite(t.quoteVolume) && t.quoteVolume > 0);
}

export interface FundingAllEntry {
  symbol: string;
  lastFundingRate: number; // per 8h interval, decimal
}

/** Funding + mark for EVERY symbol in one call (Binance fapi weight 10). */
export async function fundingAll(): Promise<Map<string, FundingAllEntry>> {
  const r = await jget<Array<{ symbol: string; lastFundingRate: string }>>(`${BINANCE_F}/fapi/v1/premiumIndex`);
  const out = new Map<string, FundingAllEntry>();
  for (const f of r) {
    const rate = Number(f.lastFundingRate);
    if (Number.isFinite(rate)) out.set(f.symbol, { symbol: f.symbol, lastFundingRate: rate });
  }
  return out;
}

/** Current funding + mark (Binance premium index). */
export async function premiumIndex(symbol: string) {
  const r = await jget<{ markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number }>(
    `${BINANCE_F}/fapi/v1/premiumIndex?symbol=${symbol}USDT`,
  );
  return { mark: +r.markPrice, index: +r.indexPrice, fundingRate: +r.lastFundingRate, nextFundingTs: r.nextFundingTime || null };
}

/** Funding rate history (per 8h). */
export async function fundingHistory(symbol: string, limit = 90) {
  const r = await jget<{ fundingTime: number; fundingRate: string }[]>(`${BINANCE_F}/fapi/v1/fundingRate?symbol=${symbol}USDT&limit=${limit}`);
  return r.map((f) => ({ ts: f.fundingTime, rate: +f.fundingRate })).reverse();
}

/** Binance USDT-perp OI in contracts. */
export async function binanceOi(symbol: string) {
  const r = await jget<{ openInterest: string }>(`${BINANCE_F}/fapi/v1/openInterest?symbol=${symbol}USDT`);
  return +r.openInterest;
}

/** Binance OI history (sumOpenInterestValue = USD). */
export async function binanceOiHist(symbol: string, period = '5m', limit = 288) {
  const r = await jget<{ timestamp: number; sumOpenInterest: string; sumOpenInterestValue: string }[]>(
    `${BINANCE_F}/futures/data/openInterestHist?symbol=${symbol}USDT&period=${period}&limit=${limit}`,
  );
  return r.map((p) => ({ ts: p.timestamp, oiContracts: +p.sumOpenInterest, oiUsd: +p.sumOpenInterestValue })).reverse();
}

/** Bybit linear perp OI. */
export async function bybitOi(symbol: string) {
  const r = await jget<{ retCode: number; result: { openInterest: string; openInterestValue: string } }>(
    `${BYBIT}/v5/market/open-interest?category=linear&symbol=${symbol}USDT&intervalTime=5min`,
  );
  if (r.retCode !== 0) throw new Error('bybit oi failed');
  return { oiContracts: +r.result.openInterest, oiUsd: +r.result.openInterestValue };
}

/** OKX USDT-swap OI. */
export async function okxOi(symbol: string) {
  const r = await jget<{ code: string; data: { instId: string; oiCcy: string; oiUsd?: string }[] }>(
    `${OKX}/api/v5/public/open-interest?instId=${symbol}-USDT-SWAP`,
  );
  if (r.code !== '0' || !r.data.length) throw new Error('okx oi failed');
  return { oiContracts: +r.data[0].oiCcy, oiUsd: r.data[0].oiUsd ? +r.data[0].oiUsd : NaN };
}

/** Deribit futures OI is quoted in USD (inverse contracts). */
export async function deribitFuturesOi(symbol: string, bookSummary: { instrument_name: string; open_interest: number; mark_price?: number }[]) {
  const rows = bookSummary.filter((f) => f.instrument_name.startsWith(`${symbol}-`));
  const perp = rows.find((f) => f.instrument_name === `${symbol}-PERPETUAL`);
  return {
    oiUsd: perp?.open_interest ?? 0,
    oiContracts: (perp?.open_interest ?? 0) / (perp?.mark_price ?? 1),
    dated: rows
      .filter((f) => f.instrument_name !== `${symbol}-PERPETUAL`)
      .map((f) => ({ name: f.instrument_name, oiUsd: f.open_interest })),
  };
}

export const marketVenues = { candles, premiumIndex, fundingHistory, binanceOi, binanceOiHist, bybitOi, okxOi };

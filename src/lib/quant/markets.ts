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

/** USDT-perp klines with taker buy volume (CVD source). */
export async function candles(symbol: string, interval = '5m', limit = 480): Promise<Candle[]> {
  const r = await jget<unknown[][]>(`${BINANCE_F}/fapi/v1/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`);
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

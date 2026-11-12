import { NextResponse } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// /api/prices — REAL live BTC/ETH/SOL spot, proxied server-side so the browser
// never hits CORS. Source chain: Binance → Bybit → OKX (first that answers).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

interface Quote {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function binance(sym: string): Promise<Quote> {
  const r = await withTimeout(
    fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`, { cache: 'no-store' }),
    3500,
  );
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const j = await r.json();
  return {
    price: parseFloat(j.lastPrice),
    change24h: parseFloat(j.priceChangePercent) / 100,
    high24h: parseFloat(j.highPrice),
    low24h: parseFloat(j.lowPrice),
    volume24h: parseFloat(j.quoteVolume),
  };
}

async function bybit(sym: string): Promise<Quote> {
  const r = await withTimeout(
    fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`, { cache: 'no-store' }),
    3500,
  );
  if (!r.ok) throw new Error(`bybit ${r.status}`);
  const j = await r.json();
  const t = j?.result?.list?.[0];
  if (!t) throw new Error('bybit empty');
  return {
    price: parseFloat(t.lastPrice),
    change24h: parseFloat(t.price24hPcnt),
    high24h: parseFloat(t.high24hPrice),
    low24h: parseFloat(t.low24hPrice),
    volume24h: parseFloat(t.turnover24h),
  };
}

async function okx(inst: string): Promise<Quote> {
  const r = await withTimeout(
    fetch(`https://www.okx.com/api/v5/market/ticker?instId=${inst}`, { cache: 'no-store' }),
    3500,
  );
  if (!r.ok) throw new Error(`okx ${r.status}`);
  const j = await r.json();
  const t = j?.data?.[0];
  if (!t) throw new Error('okx empty');
  return {
    price: parseFloat(t.last),
    change24h: (parseFloat(t.last) - parseFloat(t.open24h)) / (parseFloat(t.open24h) || 1),
    high24h: parseFloat(t.high24h),
    low24h: parseFloat(t.low24h),
    volume24h: parseFloat(t.volCcy24h) * parseFloat(t.last),
  };
}

async function quote(symbol: string): Promise<Quote & { source: string }> {
  const sources: [string, () => Promise<Quote>][] = [
    ['Binance', () => binance(symbol)],
    ['Bybit', () => bybit(symbol)],
    ['OKX', () => okx(`${symbol.replace('USDT', '-USDT')}`)],
  ];
  let lastErr: unknown = null;
  for (const [name, fn] of sources) {
    try {
      const q = await fn();
      if (q.price > 0) return { ...q, source: name };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('no source');
}

export async function GET() {
  const targets: { underlying: 'BTC' | 'ETH' | 'SOL'; symbol: string }[] = [
    { underlying: 'BTC', symbol: 'BTCUSDT' },
    { underlying: 'ETH', symbol: 'ETHUSDT' },
    { underlying: 'SOL', symbol: 'SOLUSDT' },
  ];
  const results = await Promise.allSettled(targets.map((t) => quote(t.symbol)));
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  results.forEach((res, i) => {
    const { underlying } = targets[i];
    if (res.status === 'fulfilled') {
      out[underlying] = { underlying, ...res.value, ts: Date.now() };
    } else {
      errors.push(`${underlying}: ${String((res as PromiseRejectedResult).reason).slice(0, 80)}`);
    }
  });
  return NextResponse.json(
    { ok: errors.length === 0, prices: out, errors, ts: Date.now() },
    { status: errors.length === 3 ? 502 : 200 },
  );
}

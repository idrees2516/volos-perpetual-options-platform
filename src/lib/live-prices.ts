// Real-time BTC / ETH / SOL market snapshot from public exchange APIs.
//
// The terminal's SINGLE market plane — 100% real venue data, no local
// simulation:
//   • spot + 24h stats:  Binance spot → Bybit spot → OKX spot → Deribit index
//   • perp funding + open interest:  OKX USDT swaps (public, no auth)
//   • 30d historical vol (vol-shift anchor):  Deribit HV index
//
// All endpoints are public (no auth) and CORS-enabled, so the browser can
// call them directly; the same module also works server-side (Node fetch).
//
// This is the single source of truth for "real live market data" in the UI:
// the market provider builds every frame from these snapshots.

export type LiveAsset = 'BTC' | 'ETH' | 'SOL';

export interface LiveQuote {
  spot: number;
  /** 24h price change in percent (e.g. -0.31). */
  change24hPct: number;
  high24h: number;
  low24h: number;
  /** 24h traded notional in USD. */
  volumeUsd24h: number;
}

export interface LivePerp {
  /** Current funding rate as a FRACTION PER 8H PERIOD (Binance convention, e.g. 0.0001 = 0.01%). */
  fundingRate8h: number;
  /** Perp open-interest notional in USD. */
  openInterestUsd: number;
}

export interface LivePriceSnapshot {
  quotes: Partial<Record<LiveAsset, LiveQuote>>;
  /** REAL perp metrics (OKX USDT swaps) — absent until the slow poll lands. */
  perp?: Partial<Record<LiveAsset, LivePerp>>;
  /** REAL 30d historical vol (Deribit HV, annualized FRACTION, e.g. 0.44) — absent until primed. */
  hv30d?: Partial<Record<LiveAsset, number>>;
  /** Which venue answered (for the LIVE badge / engine status line). */
  source: string;
  tsMs: number;
  ok: boolean;
}

const BINANCE_SYMBOLS: Record<LiveAsset, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
};

const OKX_INST: Record<LiveAsset, string> = {
  BTC: 'BTC-USDT',
  ETH: 'ETH-USDT',
  SOL: 'SOL-USDT',
};

const DERIBIT_INDEX: Record<LiveAsset, string> = {
  BTC: 'btc_usd',
  ETH: 'eth_usd',
  SOL: 'sol_usd',
};

async function fetchJson<T>(url: string, timeoutMs = 8000, init?: RequestInit): Promise<T> {
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

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

// ── source 1 · Binance spot tickers ─────────────────────────────────────────

async function fromBinance(): Promise<LivePriceSnapshot> {
  const symbols = Object.values(BINANCE_SYMBOLS);
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(
    JSON.stringify(symbols),
  )}`;
  const rows = await fetchJson<
    { symbol: string; lastPrice: string; priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string }[]
  >(url);
  const quotes: Partial<Record<LiveAsset, LiveQuote>> = {};
  for (const r of rows) {
    const asset = (Object.keys(BINANCE_SYMBOLS) as LiveAsset[]).find(
      (a) => BINANCE_SYMBOLS[a] === r.symbol,
    );
    if (!asset) continue;
    quotes[asset] = {
      spot: num(r.lastPrice),
      change24hPct: num(r.priceChangePercent),
      high24h: num(r.highPrice),
      low24h: num(r.lowPrice),
      volumeUsd24h: num(r.quoteVolume),
    };
  }
  if (!quotes.BTC?.spot) throw new Error('binance empty');
  return { quotes, source: 'Binance spot', tsMs: Date.now(), ok: true };
}

// ── source 2 · Bybit spot tickers ───────────────────────────────────────────

async function fromBybit(): Promise<LivePriceSnapshot> {
  const quotes: Partial<Record<LiveAsset, LiveQuote>> = {};
  await Promise.all(
    (Object.keys(BINANCE_SYMBOLS) as LiveAsset[]).map(async (asset) => {
      const r = await fetchJson<{ result: { list: Record<string, string>[] } }>(
        `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${BINANCE_SYMBOLS[asset]}`,
      );
      const t = r.result?.list?.[0];
      if (!t) return;
      quotes[asset] = {
        spot: num(t.lastPrice),
        change24hPct: num(t.price24hPcnt) * 100,
        high24h: num(t.highPrice24h),
        low24h: num(t.lowPrice24h),
        volumeUsd24h: num(t.turnover24h),
      };
    }),
  );
  if (!quotes.BTC?.spot) throw new Error('bybit empty');
  return { quotes, source: 'Bybit spot', tsMs: Date.now(), ok: true };
}

// ── source 3 · OKX spot tickers ─────────────────────────────────────────────

async function fromOkx(): Promise<LivePriceSnapshot> {
  const quotes: Partial<Record<LiveAsset, LiveQuote>> = {};
  await Promise.all(
    (Object.keys(OKX_INST) as LiveAsset[]).map(async (asset) => {
      const r = await fetchJson<{ data: Record<string, string>[] }>(
        `https://www.okx.com/api/v5/market/ticker?instId=${OKX_INST[asset]}`,
      );
      const t = r.data?.[0];
      if (!t) return;
      const last = num(t.last);
      const open = num(t.open24h);
      quotes[asset] = {
        spot: last,
        change24hPct: open > 0 ? ((last - open) / open) * 100 : 0,
        high24h: num(t.high24h),
        low24h: num(t.low24h),
        volumeUsd24h: num(t.volCcy24h),
      };
    }),
  );
  if (!quotes.BTC?.spot) throw new Error('okx empty');
  return { quotes, source: 'OKX spot', tsMs: Date.now(), ok: true };
}

// ── source 4 · Deribit index (spot only — no 24h stats) ─────────────────────

async function fromDeribitIndex(): Promise<LivePriceSnapshot> {
  const quotes: Partial<Record<LiveAsset, LiveQuote>> = {};
  await Promise.all(
    (Object.keys(DERIBIT_INDEX) as LiveAsset[]).map(async (asset) => {
      const r = await fetchJson<{ result: { index_price: number } }>(
        `https://www.deribit.com/api/v2/public/get_index_price?index_name=${DERIBIT_INDEX[asset]}`,
      );
      const spot = num(r.result?.index_price);
      if (spot > 0) quotes[asset] = { spot, change24hPct: 0, high24h: 0, low24h: 0, volumeUsd24h: 0 };
    }),
  );
  if (!quotes.BTC?.spot) throw new Error('deribit index empty');
  return { quotes, source: 'Deribit index', tsMs: Date.now(), ok: true };
}

const SOURCES = [fromBinance, fromBybit, fromOkx, fromDeribitIndex];

// ── slow plane · REAL perp funding / OI (OKX USDT swaps) ─────────────────────

const OKX_SWAP: Record<LiveAsset, string> = {
  BTC: 'BTC-USDT-SWAP',
  ETH: 'ETH-USDT-SWAP',
  SOL: 'SOL-USDT-SWAP',
};

async function okxPerpMetrics(): Promise<Partial<Record<LiveAsset, LivePerp>>> {
  const out: Partial<Record<LiveAsset, LivePerp>> = {};
  await Promise.all(
    (Object.keys(OKX_SWAP) as LiveAsset[]).map(async (asset) => {
      try {
        const [fr, oi] = await Promise.all([
          fetchJson<{ data: { fundingRate: string }[] }>(
            `https://www.okx.com/api/v5/public/funding-rate?instId=${OKX_SWAP[asset]}`, 6000),
          fetchJson<{ data: { oiUsd: string }[] }>(
            `https://www.okx.com/api/v5/public/open-interest?instId=${OKX_SWAP[asset]}`, 6000),
        ]);
        const fundingRate8h = num(fr.data?.[0]?.fundingRate);
        const openInterestUsd = num(oi.data?.[0]?.oiUsd);
        if (Number.isFinite(fundingRate8h) && Number.isFinite(openInterestUsd)) {
          out[asset] = { fundingRate8h, openInterestUsd };
        }
      } catch {
        /* perp metrics are optional per asset */
      }
    }),
  );
  return out;
}

// ── slow plane · REAL 30d historical vol (Deribit HV index) ──────────────────

async function deribitHv30d(): Promise<Partial<Record<LiveAsset, number>>> {
  const out: Partial<Record<LiveAsset, number>> = {};
  await Promise.all(
    (Object.keys(DERIBIT_INDEX) as LiveAsset[]).map(async (asset) => {
      // SOL's index name is sol_usd but HV is quoted per currency code
      const cur = asset === 'BTC' ? 'BTC' : asset === 'ETH' ? 'ETH' : 'SOL';
      try {
        const r = await fetchJson<{ result: [number, number][] }>(
          `https://www.deribit.com/api/v2/public/get_historical_volatility?currency=${cur}`, 6000);
        const rows = r.result ?? [];
        // latest sample, annualized % → fraction (e.g. 44.2 → 0.442)
        const v = rows.length ? rows[rows.length - 1][1] / 100 : NaN;
        if (Number.isFinite(v) && v > 0) out[asset] = v;
      } catch {
        /* HV optional per asset */
      }
    }),
  );
  return out;
}

/** Fetch real prices with venue fallback. Never throws. */
export async function fetchLivePrices(): Promise<LivePriceSnapshot> {
  for (const src of SOURCES) {
    try {
      const snap = await src();
      if (snap.ok) return { ...snap, perp: {}, hv30d: {} };
    } catch {
      // try the next venue
    }
  }
  return { quotes: {}, perp: {}, hv30d: {}, source: 'unreachable', tsMs: Date.now(), ok: false };
}

// ── client polling singleton ────────────────────────────────────────────────
//
// One poller per browser tab: FAST plane (spot quotes, 5s) + SLOW plane
// (perp funding/OI + Deribit HV, 60s — funding flips every 8h, HV hourly, so
// a minute cadence is plenty). Any number of subscribers.

let latest: LivePriceSnapshot | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let slowTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
const listeners = new Set<(snap: LivePriceSnapshot) => void>();

async function poll() {
  if (inFlight) return;
  inFlight = true;
  try {
    const snap = await fetchLivePrices();
    // merge the slow-plane fields from the last slow poll
    latest = snap.ok ? { ...snap, perp: slow.perp, hv30d: slow.hv30d } : snap;
    for (const cb of listeners) cb(latest);
  } finally {
    inFlight = false;
  }
}

const slow = { perp: {} as Partial<Record<LiveAsset, LivePerp>>, hv30d: {} as Partial<Record<LiveAsset, number>> };
let slowInFlight = false;

async function pollSlow() {
  if (slowInFlight) return;
  slowInFlight = true;
  try {
    const [perp, hv30d] = await Promise.all([okxPerpMetrics(), deribitHv30d()]);
    slow.perp = perp;
    slow.hv30d = hv30d;
    // push the enriched snapshot out right away (spot from cache)
    if (latest?.ok) {
      latest = { ...latest, perp, hv30d };
      for (const cb of listeners) cb(latest);
    }
  } finally {
    slowInFlight = false;
  }
}

function ensurePolling() {
  if (typeof window === 'undefined' || timer) return;
  void poll();
  timer = setInterval(() => void poll(), 5_000);
  if (!slowTimer) {
    void pollSlow();
    slowTimer = setInterval(() => void pollSlow(), 60_000);
  }
}

function maybeStopPolling() {
  if (listeners.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
    if (slowTimer) {
      clearInterval(slowTimer);
      slowTimer = null;
    }
  }
}

/** Subscribe to real market snapshots; cb fires immediately with the cached snapshot. */
export function subscribeLivePrices(cb: (snap: LivePriceSnapshot) => void): () => void {
  listeners.add(cb);
  if (latest) cb(latest);
  ensurePolling();
  return () => {
    listeners.delete(cb);
    maybeStopPolling();
  };
}

/** Last known snapshot (null before the first successful poll). */
export function livePricesNow(): LivePriceSnapshot | null {
  return latest;
}

/** Force an immediate re-poll of BOTH planes (the retry button). */
export function refreshLivePrices(): void {
  if (typeof window === 'undefined') return;
  void poll();
  void pollSlow();
}

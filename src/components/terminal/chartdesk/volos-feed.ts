// ─────────────────────────────────────────────────────────────────────────────
// Chart Desk — VolosDataFeed. The openalgo-charts DataFeed over OUR OWN bar
// plane (/api/chartdesk/bars): windowed SQLite kline mirror → live Binance
// endTime-paged sweep. History paging (scroll back), live tail polling, and a
// static symbol catalog for the widget's symbol search. Taker-buy volume is
// stashed in the feed context so VolScript descriptors (the bridge) keep the
// orderflow natives (delta / cvd) on the TradingView-style chart too.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Bar,
  BarsPage,
  BarsPageRequest,
  BarsRequest,
  DataFeed,
  SymbolMatch,
  SymbolSearchRequest,
  UnsubscribeFn,
} from 'openalgo-charts';

export const CHART_TFS = ['5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type ChartTf = (typeof CHART_TFS)[number];

/** USDT-perp catalog the widget's symbol box searches (Binance fapi majors). */
export const SYMBOL_CATALOG: SymbolMatch[] = [
  { symbol: 'BTC', exchange: 'BINANCE', name: 'Bitcoin', assetClass: 'perp' },
  { symbol: 'ETH', exchange: 'BINANCE', name: 'Ethereum', assetClass: 'perp' },
  { symbol: 'SOL', exchange: 'BINANCE', name: 'Solana', assetClass: 'perp' },
  { symbol: 'BNB', exchange: 'BINANCE', name: 'BNB', assetClass: 'perp' },
  { symbol: 'XRP', exchange: 'BINANCE', name: 'XRP', assetClass: 'perp' },
  { symbol: 'DOGE', exchange: 'BINANCE', name: 'Dogecoin', assetClass: 'perp' },
  { symbol: 'ADA', exchange: 'BINANCE', name: 'Cardano', assetClass: 'perp' },
  { symbol: 'AVAX', exchange: 'BINANCE', name: 'Avalanche', assetClass: 'perp' },
  { symbol: 'LINK', exchange: 'BINANCE', name: 'Chainlink', assetClass: 'perp' },
  { symbol: 'TRX', exchange: 'BINANCE', name: 'Tron', assetClass: 'perp' },
  { symbol: 'DOT', exchange: 'BINANCE', name: 'Polkadot', assetClass: 'perp' },
  { symbol: 'LTC', exchange: 'BINANCE', name: 'Litecoin', assetClass: 'perp' },
  { symbol: 'MATIC', exchange: 'BINANCE', name: 'Polygon', assetClass: 'perp' },
  { symbol: 'ATOM', exchange: 'BINANCE', name: 'Cosmos', assetClass: 'perp' },
  { symbol: 'NEAR', exchange: 'BINANCE', name: 'NEAR', assetClass: 'perp' },
  { symbol: 'APT', exchange: 'BINANCE', name: 'Aptos', assetClass: 'perp' },
  { symbol: 'ARB', exchange: 'BINANCE', name: 'Arbitrum', assetClass: 'perp' },
  { symbol: 'OP', exchange: 'BINANCE', name: 'Optimism', assetClass: 'perp' },
  { symbol: 'SUI', exchange: 'BINANCE', name: 'Sui', assetClass: 'perp' },
  { symbol: 'TIA', exchange: 'BINANCE', name: 'Celestia', assetClass: 'perp' },
  { symbol: 'INJ', exchange: 'BINANCE', name: 'Injective', assetClass: 'perp' },
  { symbol: 'FIL', exchange: 'BINANCE', name: 'Filecoin', assetClass: 'perp' },
  { symbol: 'PEPE', exchange: 'BINANCE', name: 'Pepe', assetClass: 'perp' },
  { symbol: 'WIF', exchange: 'BINANCE', name: 'dogwifhat', assetClass: 'perp' },
];

// ── feed context: taker-buy per bar, keyed symbol → bar time → tb ───────────
type TbMap = Map<number, number>;
const tbCtx = new Map<string, TbMap>();
let lastSymbol = 'BTC';

export function stashTakerBuy(symbol: string, bars: ApiBar[]): void {
  lastSymbol = symbol;
  let m = tbCtx.get(symbol);
  if (!m) {
    m = new Map<number, number>();
    tbCtx.set(symbol, m);
  }
  for (const b of bars) if (typeof b.tb === 'number') m.set(b.time, b.tb);
}

export function takerBuyAt(symbol: string, timeSec: number, volume: number): number {
  const tb = tbCtx.get(symbol)?.get(timeSec);
  return typeof tb === 'number' ? tb : volume / 2;
}

/** symbol-agnostic lookup (the bridge's calc sees only bars) — reads the map
 *  of the symbol the feed last served. */
export function takerBuyFor(timeSec: number, volume: number): number {
  return takerBuyAt(lastSymbol, timeSec, volume);
}

// ── API shapes ──────────────────────────────────────────────────────────────

interface ApiBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  tb?: number;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { message?: string };
}

async function fetchBars(
  symbol: string,
  interval: string,
  opts: { from?: number; to?: number; countBack?: number; signal?: AbortSignal },
): Promise<ApiBar[]> {
  const q = new URLSearchParams({ symbol, tf: interval });
  if (opts.from !== undefined) q.set('from', String(Math.floor(opts.from)));
  if (opts.to !== undefined) q.set('to', String(Math.floor(opts.to)));
  if (opts.countBack !== undefined) q.set('countBack', String(Math.round(opts.countBack)));
  const res = await fetch(`/api/chartdesk/bars?${q.toString()}`, { signal: opts.signal, cache: 'no-store' });
  const j = (await res.json()) as Envelope<{ bars: ApiBar[] }>;
  if (!j.success || !j.data?.bars) throw new Error(j.error?.message ?? `bars request failed (${res.status})`);
  return j.data.bars;
}

function toChartBar(b: ApiBar): Bar {
  return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, oi: b.oi };
}

export interface VolosFeedOptions {
  /** live tail polling interval, ms (default 20s) */
  pollMs?: number;
  onStatus?: (status: string) => void;
}

/** Build the DataFeed the widget consumes. */
export function createVolosFeed(options: VolosFeedOptions = {}): DataFeed {
  const pollMs = options.pollMs ?? 20_000;
  const emit = options.onStatus ?? (() => undefined);

  return {
    async getBars(req: BarsRequest): Promise<Bar[]> {
      try {
        const bars = await fetchBars(req.symbol, req.interval, {
          from: req.from,
          to: req.to,
          countBack: req.countBack ?? 800,
          signal: req.signal,
        });
        stashTakerBuy(req.symbol, bars);
        emit('live');
        return bars.map(toChartBar);
      } catch (e) {
        emit(String(e instanceof Error ? e.message : 'feed error'));
        throw e;
      }
    },

    async getBarsPage(req: BarsPageRequest): Promise<BarsPage> {
      try {
        const bars = await fetchBars(req.symbol, req.interval, {
          to: req.before,
          countBack: req.countBack,
          signal: req.signal,
        });
        stashTakerBuy(req.symbol, bars);
        const nextBefore = bars.length ? bars[0].time : undefined;
        return { bars: bars.map(toChartBar), hasMore: bars.length >= req.countBack, nextBefore };
      } catch {
        return { bars: [], hasMore: false };
      }
    },

    async searchSymbols(req: SymbolSearchRequest): Promise<SymbolMatch[]> {
      const query = req.query.trim().toUpperCase();
      if (!query) return SYMBOL_CATALOG.slice(0, 12);
      const starts: SymbolMatch[] = [];
      const contains: SymbolMatch[] = [];
      for (const s of SYMBOL_CATALOG) {
        const hay = `${s.symbol} ${s.name ?? ''}`.toUpperCase();
        if (s.symbol.startsWith(query)) starts.push(s);
        else if (hay.includes(query)) contains.push(s);
      }
      return [...starts, ...contains].slice(0, 20);
    },

    subscribeBars(req: BarsRequest, onBar: (bar: Bar) => void): UnsubscribeFn {
      let timer: ReturnType<typeof setInterval> | null = null;
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          // the newest 3 bars — the forming one updates, the last closed lands
          const to = Math.floor(Date.now() / 1000);
          const from = to - 60 * 60 * 24 * 3;
          const bars = await fetchBars(req.symbol, req.interval, { from, to, countBack: 3 });
          if (stopped) return;
          stashTakerBuy(req.symbol, bars);
          for (const b of bars) onBar(toChartBar(b));
        } catch {
          /* transient venue hiccup — next poll retries */
        }
      };
      timer = setInterval(() => void tick(), pollMs);
      void tick();
      return () => {
        stopped = true;
        if (timer) clearInterval(timer);
      };
    },
  };
}

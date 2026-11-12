// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — venue adapters (server-side, per asset)
//
//   Binance USD-M   aggTrade · markPrice · forceOrder on /market/ws,
//                   depth20@100ms on /public/ws, 1000-level REST snapshots,
//                   openInterest REST poll (Binance moved futures streams to
//                   category routes in 2026 — the legacy /ws delivers nothing)
//   Bybit linear    publicTrade · orderbook.1000 · tickers · allLiquidation
//   OKX swap        trades · books · open-interest · funding-rate ·
//                   mark-price · index-tickers · liquidation-orders
//   Deribit inverse trades (with liquidation flags) · grouped book · ticker
//   Bitget USDT-M   trade · books (full incremental) · ticker (funding + OI +
//                   mark + index live-verified 2026-11) — no public liq feed
//   Hyperliquid     ws trades + activeAssetCtx (hourly funding, OI, mark,
//                   oracle index) · REST l2Book poll (full aggregated book) —
//                   no public liq feed
//   Coinbase spot   matches (side is the MAKER side — inverted to taker) ·
//                   REST level-2 book poll · no funding/OI/liquidations
//
// Adapter patterns adapted from the open-source order-flow-screener by
// zadescoxp (Apache-2.0); normalized to VolOS types.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';
import { fetchJson, num, openSocket, type SocketHandle } from './socket';
import { OF_VENUE_META } from './catalog';
import type {
  OfAsset,
  OfBook,
  OfBookLevel,
  OfDerivatives,
  OfLiquidation,
  OfLiquidationSide,
  OfTrade,
  OfVenueConnection,
  OfVenueId,
  OfVenueStatus,
} from './types';

export type AdapterEvent = 'trade' | 'book' | 'status' | 'liquidation' | 'derivatives';

/** Levels emitted per side in OfBook (deep enough for ladder + OBI). */
export const BOOK_EMIT_DEPTH = 50;
/** Throttle for OfBook emission (deltas arrive continuously). */
const BOOK_EMIT_MS = 250;
const OI_POLL_MS = 5_000;
const DEEP_BOOK_POLL_MS = 5_000;
/** Discard liquidation records older than this on arrival (OKX replays). */
export const LIQ_ARRIVAL_SLACK_MS = 60_000;

function levelsFromMap(
  map: Map<number, number>,
  venue: OfVenueId,
  descending: boolean,
  cap: number,
): OfBookLevel[] {
  const out: OfBookLevel[] = [...map.entries()]
    .sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]))
    .slice(0, cap)
    .map(([price, size]) => ({ price, size, venue }));
  return out;
}

export abstract class BaseVenueAdapter extends EventEmitter {
  abstract readonly venue: OfVenueId;
  readonly asset: OfAsset;
  readonly nativeSymbol: string;

  protected socket: SocketHandle | null = null;
  protected reconnectAttempts = 0;
  protected maxReconnectAttempts = 20;
  protected reconnectDelay = 1000;
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected pingTimer: ReturnType<typeof setInterval> | null = null;
  protected lastHeartbeat = 0;
  protected staleThresholdMs = 30_000;
  protected status: OfVenueStatus = 'connecting';
  protected errorMessage: string | undefined;
  protected active = false;

  /** Full in-memory book (price → size, base units). */
  protected bids = new Map<number, number>();
  protected asks = new Map<number, number>();
  private lastBookEmit = 0;
  private bookEmitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(asset: OfAsset, nativeSymbol: string) {
    super();
    this.asset = asset;
    this.nativeSymbol = nativeSymbol;
    this.setMaxListeners(50);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  connect(): void {
    this.active = true;
    this.clearReconnectTimer();
    this.stopPing();
    this.setStatus('connecting');
    const url = this.buildWsUrl();
    this.socket = openSocket(url, {
      open: () => {
        this.reconnectAttempts = 0;
        this.lastHeartbeat = Date.now();
        this.errorMessage = undefined;
        this.setStatus('live');
        this.startPing();
        this.subscribe();
      },
      text: (data) => {
        this.lastHeartbeat = Date.now();
        if (this.status !== 'live') this.setStatus('live');
        try {
          this.handleMessage(data);
        } catch (err) {
          this.reportError(`parse: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      close: () => {
        this.stopPing();
        this.socket = null;
        if (this.active) {
          this.setStatus('connecting');
          this.reconnect();
        }
      },
      error: () => this.reportError(`${this.venue} socket error`),
    });
  }

  disconnect(): void {
    this.active = false;
    this.clearReconnectTimer();
    this.stopPing();
    this.setStatus('offline');
    this.socket?.close();
    this.socket = null;
  }

  protected reconnect(): void {
    if (!this.active || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      // Give up for a minute, then try again with a clean slate.
      this.reconnectAttempts = 0;
      this.setStatus('offline');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.active) this.connect();
      }, 60_000);
      return;
    }
    const delay = Math.min(this.reconnectDelay * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.connect();
    }, delay);
  }

  // ── to implement ─────────────────────────────────────────────────────────

  protected abstract buildWsUrl(): string;
  protected abstract subscribe(): void;
  protected abstract handleMessage(raw: string): void;
  protected abstract sendPing(): void;

  // ── status ───────────────────────────────────────────────────────────────

  protected setStatus(s: OfVenueStatus): void {
    this.status = s;
    this.emit('status', this.getConnection());
  }

  protected reportError(message: string): void {
    this.errorMessage = message;
    this.setStatus('error');
  }

  getConnection(): OfVenueConnection {
    return {
      venue: this.venue,
      status: this.status,
      lastHeartbeat: this.lastHeartbeat,
      reconnectAttempts: this.reconnectAttempts,
      error: this.errorMessage,
    };
  }

  protected startPing(intervalMs = 20_000): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > this.staleThresholdMs) {
        this.setStatus('stale');
        this.socket?.close();
        return;
      }
      this.sendPing();
    }, intervalMs);
  }

  protected stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // ── normalized emissions ──────────────────────────────────────────────────

  protected emitTrade(trade: OfTrade): void {
    if (
      !Number.isFinite(trade.timestamp) ||
      !(trade.price > 0) ||
      !Number.isFinite(trade.quantity) ||
      !(trade.quantity > 0)
    ) {
      return;
    }
    this.emit('trade', trade);
  }

  /** Called after the in-memory book changed; throttles OfBook emission. */
  protected bookChanged(): void {
    if (!this.active) return;
    const now = Date.now();
    const since = now - this.lastBookEmit;
    if (since >= BOOK_EMIT_MS) {
      this.lastBookEmit = now;
      this.flushBook();
    } else if (!this.bookEmitTimer) {
      this.bookEmitTimer = setTimeout(() => {
        this.bookEmitTimer = null;
        this.lastBookEmit = Date.now();
        this.flushBook();
      }, BOOK_EMIT_MS - since);
    }
  }

  private flushBook(): void {
    if (!this.bids.size || !this.asks.size) return;
    const book: OfBook = {
      venue: this.venue,
      asset: this.asset,
      timestamp: Date.now(),
      localTimestamp: Date.now(),
      bids: levelsFromMap(this.bids, this.venue, true, BOOK_EMIT_DEPTH),
      asks: levelsFromMap(this.asks, this.venue, false, BOOK_EMIT_DEPTH),
    };
    this.emit('book', book);
  }

  protected emitLiquidation(liq: Omit<OfLiquidation, 'venue' | 'asset' | 'localTimestamp' | 'quoteVolume'>): void {
    if (!(liq.price > 0) || !(liq.quantity > 0) || !Number.isFinite(liq.timestamp)) return;
    if (Date.now() - liq.timestamp > LIQ_ARRIVAL_SLACK_MS) return; // stale replay
    this.emit('liquidation', {
      ...liq,
      venue: this.venue,
      asset: this.asset,
      localTimestamp: Date.now(),
      quoteVolume: liq.price * liq.quantity,
    } satisfies OfLiquidation);
  }

  protected emitDerivatives(update: Omit<OfDerivatives, 'venue' | 'timestamp'> & { timestamp?: number }): void {
    const clean: OfDerivatives = { venue: this.venue, timestamp: update.timestamp ?? Date.now() };
    let any = false;
    for (const key of ['openInterest', 'fundingRate', 'fundingIntervalHours', 'nextFundingTime', 'markPrice', 'indexPrice'] as const) {
      const value = update[key];
      if (value === undefined || !Number.isFinite(value)) continue;
      if (key !== 'fundingRate' && value <= 0) continue;
      (clean as unknown as Record<string, number>)[key] = value;
      any = true;
    }
    if (any) this.emit('derivatives', clean);
  }

  /** The deepest book this adapter holds, for the resting-liquidity heatmap. */
  depthSides(): { bids: ReadonlyMap<number, number>; asks: ReadonlyMap<number, number> } | null {
    return this.bids.size || this.asks.size ? { bids: this.bids, asks: this.asks } : null;
  }

  /** Apply [price, size] deltas to a side; size 0 removes the level. */
  protected applyLevels(side: Map<number, number>, levels: ReadonlyArray<ReadonlyArray<string>>, multiplier = 1): void {
    for (const level of levels) {
      const price = parseFloat(level[0]);
      const qty = parseFloat(level[1]) * multiplier;
      if (!Number.isFinite(price)) continue;
      if (!(qty > 0)) side.delete(price);
      else side.set(price, qty);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BINANCE USD-M FUTURES
// ═══════════════════════════════════════════════════════════════════════════

const BINANCE_MARKET_WS = 'wss://fstream.binance.com/market/ws';
const BINANCE_PUBLIC_WS = 'wss://fstream.binance.com/public/ws';
const BINANCE_REST = 'https://fapi.binance.com';

interface BinanceDeepPoll {
  bids?: [string, string][];
  asks?: [string, string][];
}

export class BinancePerpAdapter extends BaseVenueAdapter {
  readonly venue: OfVenueId = 'binance';
  private depthSocket: SocketHandle | null = null;
  private depthAttempts = 0;
  private depthRetry: ReturnType<typeof setTimeout> | null = null;
  private oiTimer: ReturnType<typeof setInterval> | null = null;
  private deepTimer: ReturnType<typeof setInterval> | null = null;
  private deepBids = new Map<number, number>();
  private deepAsks = new Map<number, number>();
  private fundingIntervalHours: number | undefined;

  constructor(asset: OfAsset) {
    super(asset, OF_VENUE_META.binance.symbol(asset) ?? `${asset}USDT`);
  }

  protected buildWsUrl(): string {
    return BINANCE_MARKET_WS;
  }

  connect(): void {
    super.connect();
    this.connectDepth();
    this.startOpenInterestPolling();
    this.startDeepBookPolling();
    void this.loadFundingInterval();
  }

  disconnect(): void {
    super.disconnect();
    if (this.depthRetry) clearTimeout(this.depthRetry);
    this.depthRetry = null;
    this.depthSocket?.close();
    this.depthSocket = null;
    if (this.oiTimer) clearInterval(this.oiTimer);
    this.oiTimer = null;
    if (this.deepTimer) clearInterval(this.deepTimer);
    this.deepTimer = null;
  }

  protected subscribe(): void {
    const s = this.nativeSymbol.toLowerCase();
    this.socket?.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: [`${s}@aggTrade`, `${s}@markPrice@1s`, `${s}@forceOrder`],
        id: 1,
      }),
    );
  }

  /** Depth lives on a separate route; reconnects independently. */
  private connectDepth(): void {
    if (!this.active) return;
    const sock = openSocket(BINANCE_PUBLIC_WS, {
      open: () => {
        this.depthAttempts = 0;
        sock.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${this.nativeSymbol.toLowerCase()}@depth20@100ms`], id: 2 }));
      },
      text: (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.e === 'depthUpdate' || (msg.lastUpdateId && msg.bids && msg.asks)) {
            // Partial depth: every message is a full top-N snapshot.
            this.bids.clear();
            this.asks.clear();
            for (const [p, q] of msg.b ?? msg.bids) {
              const price = parseFloat(p);
              const qty = parseFloat(q);
              if (qty > 0) this.bids.set(price, qty);
            }
            for (const [p, q] of msg.a ?? msg.asks) {
              const price = parseFloat(p);
              const qty = parseFloat(q);
              if (qty > 0) this.asks.set(price, qty);
            }
            this.bookChanged();
          }
        } catch {
          /* ignore */
        }
      },
      close: () => {
        if (!this.active) return;
        this.depthSocket = null;
        const delay = Math.min(1000 * 2 ** this.depthAttempts++, 30_000);
        this.depthRetry = setTimeout(() => {
          this.depthRetry = null;
          this.connectDepth();
        }, delay);
      },
      error: () => undefined,
    });
    this.depthSocket = sock;
  }

  private startOpenInterestPolling(): void {
    if (this.oiTimer) return;
    const poll = async () => {
      const body = await fetchJson<{ openInterest?: string; time?: number }>(
        `${BINANCE_REST}/fapi/v1/openInterest?symbol=${encodeURIComponent(this.nativeSymbol)}`,
      );
      if (body && this.active) this.emitDerivatives({ openInterest: num(body.openInterest), timestamp: num(body.time) });
    };
    void poll();
    this.oiTimer = setInterval(poll, OI_POLL_MS);
  }

  /** The partial stream stops at 20 levels; a REST snapshot gives the heatmap 1000. */
  private startDeepBookPolling(): void {
    if (this.deepTimer) return;
    const poll = async () => {
      const body = await fetchJson<BinanceDeepPoll>(
        `${BINANCE_REST}/fapi/v1/depth?symbol=${encodeURIComponent(this.nativeSymbol)}&limit=1000`,
      );
      if (!body || !this.active) return;
      const toMap = (levels: [string, string][] = []) =>
        new Map(
          levels
            .map(([p, q]) => [Number(p), Number(q)] as [number, number])
            .filter(([p, q]) => p > 0 && q > 0),
        );
      this.deepBids = toMap(body.bids);
      this.deepAsks = toMap(body.asks);
    };
    void poll();
    this.deepTimer = setInterval(poll, DEEP_BOOK_POLL_MS);
  }

  /** Live top-20 inside its own range, the REST snapshot beyond it. */
  depthSides(): { bids: ReadonlyMap<number, number>; asks: ReadonlyMap<number, number> } | null {
    if (!this.bids.size && !this.asks.size) return null;
    const merge = (live: Map<number, number>, deep: Map<number, number>, side: 'bid' | 'ask') => {
      if (!live.size) return deep;
      const prices = [...live.keys()];
      const edge = side === 'bid' ? Math.min(...prices) : Math.max(...prices);
      const out = new Map(live);
      for (const [price, size] of deep) {
        if (side === 'bid' ? price < edge : price > edge) out.set(price, size);
      }
      return out;
    };
    return { bids: merge(this.bids, this.deepBids, 'bid'), asks: merge(this.asks, this.deepAsks, 'ask') };
  }

  /** Most symbols fund every 8h; some use 4h or 1h. */
  private async loadFundingInterval(): Promise<void> {
    const list = await fetchJson<Array<{ symbol: string; fundingIntervalHours?: number }>>(`${BINANCE_REST}/fapi/v1/fundingInfo`);
    this.fundingIntervalHours = list?.find((item) => item.symbol === this.nativeSymbol)?.fundingIntervalHours ?? 8;
  }

  protected handleMessage(raw: string): void {
    const msg = JSON.parse(raw);
    if (msg.e === 'aggTrade') {
      const price = parseFloat(msg.p);
      const qty = parseFloat(msg.q);
      this.emitTrade({
        id: `bin-${msg.a}`,
        venue: this.venue,
        asset: this.asset,
        timestamp: msg.T,
        localTimestamp: Date.now(),
        price,
        quantity: qty,
        quoteVolume: price * qty,
        // aggTrade.m = buyer is the maker → the aggressor sold.
        side: msg.m ? 'sell' : 'buy',
        sequence: msg.a,
      });
    } else if (msg.e === 'markPriceUpdate') {
      this.emitDerivatives({
        markPrice: num(msg.p),
        indexPrice: num(msg.i),
        fundingRate: num(msg.r),
        nextFundingTime: num(msg.T),
        fundingIntervalHours: this.fundingIntervalHours,
        timestamp: num(msg.E),
      });
    } else if (msg.e === 'forceOrder' && msg.o) {
      const o = msg.o;
      const price = num(o.ap) || num(o.p) || 0;
      const quantity = num(o.z) || num(o.q) || 0;
      // A forced SELL closes a long position.
      this.emitLiquidation({
        id: `bin-liq-${o.s}-${o.T}-${o.S}`,
        timestamp: o.T,
        price,
        quantity,
        side: o.S === 'SELL' ? 'long' : 'short',
      });
    }
  }

  protected sendPing(): void {
    this.socket?.send(JSON.stringify({ method: 'LIST_SUBSCRIPTIONS', id: 3 }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BYBIT LINEAR FUTURES
// ═══════════════════════════════════════════════════════════════════════════

const BYBIT_WS = 'wss://stream.bybit.com/v5/public/linear';

interface BybitTradeItem {
  T: number;
  S: 'Buy' | 'Sell';
  v: string;
  p: string;
  i: string;
}

interface BybitDepthData {
  s: string;
  b: [string, string][];
  a: [string, string][];
  u: number;
}

export class BybitPerpAdapter extends BaseVenueAdapter {
  readonly venue: OfVenueId = 'bybit';
  private lastSeq = 0;

  constructor(asset: OfAsset) {
    super(asset, OF_VENUE_META.bybit.symbol(asset) ?? `${asset}USDT`);
  }

  protected buildWsUrl(): string {
    return BYBIT_WS;
  }

  protected subscribe(): void {
    this.socket?.send(
      JSON.stringify({
        op: 'subscribe',
        args: [
          `publicTrade.${this.nativeSymbol}`,
          `orderbook.1000.${this.nativeSymbol}`,
          `tickers.${this.nativeSymbol}`,
          `allLiquidation.${this.nativeSymbol}`,
        ],
      }),
    );
  }

  protected handleMessage(raw: string): void {
    const msg = JSON.parse(raw);
    if (msg.op === 'pong' || !msg.topic) return;
    const topic: string = msg.topic;
    const data = msg.data as unknown;

    if (topic.startsWith('publicTrade.')) {
      for (const t of data as BybitTradeItem[]) {
        const price = parseFloat(t.p);
        const qty = parseFloat(t.v);
        this.emitTrade({
          id: `byb-${t.i}`,
          venue: this.venue,
          asset: this.asset,
          timestamp: t.T,
          localTimestamp: Date.now(),
          price,
          quantity: qty,
          quoteVolume: price * qty,
          side: t.S === 'Buy' ? 'buy' : 'sell',
        });
      }
    } else if (topic.startsWith('orderbook.')) {
      const d = data as BybitDepthData;
      if (msg.type === 'snapshot') {
        this.bids.clear();
        this.asks.clear();
        this.lastSeq = 0;
      } else if (msg.type === 'delta' && this.lastSeq > 0 && d.u > this.lastSeq + 1) {
        // Gap in the sequence — resubscribe.
        this.bids.clear();
        this.asks.clear();
        this.socket?.close();
        return;
      }
      for (const [p, q] of d.b) {
        const price = parseFloat(p);
        const qty = parseFloat(q);
        if (qty === 0) this.bids.delete(price);
        else this.bids.set(price, qty);
      }
      for (const [p, q] of d.a) {
        const price = parseFloat(p);
        const qty = parseFloat(q);
        if (qty === 0) this.asks.delete(price);
        else this.asks.set(price, qty);
      }
      this.lastSeq = d.u;
      this.bookChanged();
    } else if (topic.startsWith('tickers.')) {
      // Snapshot first, then deltas carrying only the changed fields.
      const t = data as Record<string, string | undefined>;
      this.emitDerivatives({
        openInterest: num(t.openInterest),
        fundingRate: num(t.fundingRate),
        fundingIntervalHours: num(t.fundingIntervalHour),
        nextFundingTime: num(t.nextFundingTime),
        markPrice: num(t.markPrice),
        indexPrice: num(t.indexPrice),
      });
    } else if (topic.startsWith('allLiquidation.')) {
      // S is the side of the forced liquidation ORDER (v5 docs): a forced
      // SELL closes a long, a forced BUY closes a short.
      for (const l of data as Array<{ T: number; s: string; S: 'Buy' | 'Sell'; v: string; p: string }>) {
        this.emitLiquidation({
          id: `byb-liq-${l.s}-${l.T}-${l.S}-${l.v}`,
          timestamp: l.T,
          price: parseFloat(l.p),
          quantity: parseFloat(l.v),
          side: l.S === 'Sell' ? 'long' : 'short',
        });
      }
    }
  }

  protected sendPing(): void {
    this.socket?.send(JSON.stringify({ op: 'ping' }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OKX SWAP
// ═══════════════════════════════════════════════════════════════════════════

const OKX_WS = 'wss://ws.okx.com:8443/ws/v5/public';
const OKX_REST = 'https://www.okx.com';

export class OkxPerpAdapter extends BaseVenueAdapter {
  readonly venue: OfVenueId = 'okx';
  private contractValue = 1;

  constructor(asset: OfAsset) {
    super(asset, OF_VENUE_META.okx.symbol(asset) ?? `${asset}-USDT-SWAP`);
  }

  protected buildWsUrl(): string {
    return OKX_WS;
  }

  protected async subscribe(): Promise<void> {
    await this.loadContractValue();
    const instId = this.nativeSymbol;
    const indexId = instId.replace(/-SWAP$/, '');
    this.socket?.send(
      JSON.stringify({
        op: 'subscribe',
        args: [
          { channel: 'trades', instId },
          { channel: 'books', instId },
          { channel: 'open-interest', instId },
          { channel: 'funding-rate', instId },
          { channel: 'mark-price', instId },
          { channel: 'index-tickers', instId: indexId },
          // Liquidations are only published for the whole instrument type.
          { channel: 'liquidation-orders', instType: 'SWAP' },
        ],
      }),
    );
  }

  protected handleMessage(raw: string): void {
    if (raw === 'pong') return;
    const msg = JSON.parse(raw);
    if (!msg.arg || !msg.data) return;
    const channel: string = msg.arg.channel;
    const data = msg.data as unknown[];

    if (channel === 'open-interest') {
      for (const d of data as Array<{ oiCcy?: string; ts?: string }>) {
        this.emitDerivatives({ openInterest: num(d.oiCcy), timestamp: num(d.ts) });
      }
    } else if (channel === 'funding-rate') {
      for (const d of data as Array<{ fundingRate?: string; fundingTime?: string; nextFundingTime?: string }>) {
        const next = num(d.fundingTime);
        const after = num(d.nextFundingTime);
        this.emitDerivatives({
          fundingRate: num(d.fundingRate),
          nextFundingTime: next,
          fundingIntervalHours: next && after && after > next ? (after - next) / 3_600_000 : undefined,
        });
      }
    } else if (channel === 'mark-price') {
      for (const d of data as Array<{ markPx?: string; ts?: string }>) {
        this.emitDerivatives({ markPrice: num(d.markPx), timestamp: num(d.ts) });
      }
    } else if (channel === 'index-tickers') {
      for (const d of data as Array<{ idxPx?: string }>) this.emitDerivatives({ indexPrice: num(d.idxPx) });
    } else if (channel === 'liquidation-orders') {
      for (const item of data as Array<{
        instId: string;
        details: Array<{ side: 'buy' | 'sell'; posSide: string; bkPx: string; sz: string; ts: string }>;
      }>) {
        if (item.instId !== this.nativeSymbol) continue;
        for (const d of item.details ?? []) {
          // A forced sell (posSide long, or net mode) closes a long.
          const side: OfLiquidationSide =
            d.posSide === 'long' || (d.posSide !== 'short' && d.side === 'sell') ? 'long' : 'short';
          this.emitLiquidation({
            id: `okx-liq-${item.instId}-${d.ts}-${d.sz}`,
            timestamp: parseInt(d.ts, 10),
            price: parseFloat(d.bkPx),
            quantity: parseFloat(d.sz) * this.contractValue,
            side,
          });
        }
      }
    } else if (channel === 'trades') {
      for (const t of data as Array<{ tradeId: string; instId: string; px: string; sz: string; side: 'buy' | 'sell'; ts: string }>) {
        const price = parseFloat(t.px);
        const qty = parseFloat(t.sz) * this.contractValue;
        this.emitTrade({
          id: `okx-${t.tradeId}`,
          venue: this.venue,
          asset: this.asset,
          timestamp: parseInt(t.ts, 10),
          localTimestamp: Date.now(),
          price,
          quantity: qty,
          quoteVolume: price * qty,
          side: t.side,
        });
      }
    } else if (channel === 'books') {
      // One "snapshot" followed by incremental "update" messages;
      // a size of 0 removes the level.
      if (msg.action === 'snapshot') {
        this.bids.clear();
        this.asks.clear();
      }
      for (const d of data as Array<{ bids: [string, string, string, string][]; asks: [string, string, string, string][] }>) {
        this.applyLevels(this.bids, d.bids, this.contractValue);
        this.applyLevels(this.asks, d.asks, this.contractValue);
      }
      this.bookChanged();
    }
  }

  private async loadContractValue(): Promise<void> {
    const body = await fetchJson<{ data?: Array<{ ctVal?: string }> }>(
      `${OKX_REST}/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(this.nativeSymbol)}`,
    );
    const value = Number(body?.data?.[0]?.ctVal);
    if (Number.isFinite(value) && value > 0) this.contractValue = value;
  }

  protected sendPing(): void {
    this.socket?.send('ping');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DERIBIT INVERSE PERPETUALS (BTC / ETH)
// ═══════════════════════════════════════════════════════════════════════════

const DERIBIT_WS = 'wss://www.deribit.com/ws/api/v2';

type DeribitLevel = [number, number] | [string, number, number];

export class DeribitPerpAdapter extends BaseVenueAdapter {
  readonly venue: OfVenueId = 'deribit';
  private reqId = 1;

  constructor(asset: OfAsset) {
    super(asset, OF_VENUE_META.deribit.symbol(asset) ?? `${asset}-PERPETUAL`);
  }

  protected buildWsUrl(): string {
    return DERIBIT_WS;
  }

  protected subscribe(): void {
    this.socket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: this.reqId++,
        method: 'public/subscribe',
        params: {
          channels: [
            `trades.${this.nativeSymbol}.100ms`,
            `book.${this.nativeSymbol}.none.20.100ms`,
            `ticker.${this.nativeSymbol}.100ms`,
          ],
        },
      }),
    );
  }

  protected handleMessage(raw: string): void {
    const msg = JSON.parse(raw);
    if (msg.method !== 'subscription' || !msg.params) return;
    const channel: string = msg.params.channel;
    const data = msg.params.data;

    if (channel.startsWith('trades.')) {
      for (const t of data as Array<{
        trade_id: string;
        price: number;
        amount: number; // USD (inverse contract)
        direction: 'buy' | 'sell';
        timestamp: number;
        liquidation?: 'M' | 'T' | 'MT';
      }>) {
        const quantity = t.amount / t.price;
        this.emitTrade({
          id: `der-${t.trade_id}`,
          venue: this.venue,
          asset: this.asset,
          timestamp: t.timestamp,
          localTimestamp: Date.now(),
          price: t.price,
          quantity,
          quoteVolume: t.price * quantity,
          side: t.direction,
        });
        if (t.liquidation) {
          // "T": the taker was liquidated, "M": the maker, "MT": both.
          const takerSide: OfLiquidationSide = t.direction === 'sell' ? 'long' : 'short';
          const makerSide: OfLiquidationSide = takerSide === 'long' ? 'short' : 'long';
          const sides: OfLiquidationSide[] =
            t.liquidation === 'M' ? [makerSide] : t.liquidation === 'T' ? [takerSide] : [takerSide, makerSide];
          for (const side of sides) {
            this.emitLiquidation({
              id: `der-liq-${t.trade_id}-${side}`,
              timestamp: t.timestamp,
              price: t.price,
              quantity,
              side,
            });
          }
        }
      }
    } else if (channel.startsWith('book.')) {
      // Grouped channel sends full [price, amount] snapshots; the raw channel
      // sends {type, [action, price, amount]} deltas. Support both.
      const d = data as { type?: 'snapshot' | 'change'; bids: DeribitLevel[]; asks: DeribitLevel[] };
      const isDelta = d.bids.concat(d.asks).some((level) => typeof level[0] === 'string');
      if (!isDelta || d.type === 'snapshot') {
        this.bids.clear();
        this.asks.clear();
      }
      for (const [side, levels] of [
        [this.bids, d.bids],
        [this.asks, d.asks],
      ] as const) {
        for (const level of levels) {
          const price = Number(level.length === 3 ? level[1] : level[0]);
          const amount = Number(level.length === 3 ? level[2] : level[1]);
          const removed = level.length === 3 && level[0] === 'delete';
          // Inverse perpetuals quote size in USD; convert to base units.
          if (removed || !(amount > 0) || !(price > 0)) side.delete(price);
          else side.set(price, amount / price);
        }
      }
      this.bookChanged();
    } else if (channel.startsWith('ticker.')) {
      // Inverse perpetual: OI is quoted in USD; funding is continuous (8h equivalent).
      const t = data as {
        open_interest?: number;
        funding_8h?: number;
        mark_price?: number;
        index_price?: number;
        timestamp?: number;
        last?: number;
      };
      const mark = num(t.mark_price);
      const oiUsd = num(t.open_interest);
      this.emitDerivatives({
        openInterest: mark && oiUsd ? oiUsd / mark : undefined,
        fundingRate: num(t.funding_8h),
        fundingIntervalHours: 8,
        markPrice: mark,
        indexPrice: num(t.index_price),
        timestamp: num(t.timestamp),
      });
    }
  }

  protected sendPing(): void {
    this.socket?.send(JSON.stringify({ jsonrpc: '2.0', id: this.reqId++, method: 'public/test', params: {} }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BITGET USDT-M FUTURES
// ═══════════════════════════════════════════════════════════════════════════

const BITGET_WS = 'wss://ws.bitget.com/v2/ws/public';

interface BitgetTradeMsg {
  ts?: string;
  price?: string;
  size?: string;
  side?: 'buy' | 'sell';
  tradeId?: string;
}

interface BitgetBookMsg {
  asks?: [string, string][];
  bids?: [string, string][];
}

interface BitgetTickerMsg {
  lastPr?: string;
  bidPr?: string;
  askPr?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  markPrice?: string;
  indexPrice?: string;
  /** open interest in base units */
  holdingAmount?: string;
  ts?: string;
}

export class BitgetPerpAdapter extends BaseVenueAdapter {
  readonly venue: OfVenueId = 'bitget';

  constructor(asset: OfAsset) {
    super(asset, OF_VENUE_META.bitget.symbol(asset) ?? `${asset}USDT`);
  }

  protected buildWsUrl(): string {
    return BITGET_WS;
  }

  protected subscribe(): void {
    const instType = 'USDT-FUTURES';
    const instId = this.nativeSymbol;
    for (const channel of ['trade', 'books', 'ticker']) {
      this.socket?.send(JSON.stringify({ op: 'subscribe', args: [{ instType, channel, instId }] }));
    }
  }

  protected handleMessage(raw: string): void {
    if (raw === 'pong') return;
    const msg = JSON.parse(raw);
    if (msg.event === 'error') {
      this.reportError(`bitget ${msg.code}: ${msg.msg}`);
      return;
    }
    if (!msg.arg || !msg.action) return;
    const channel: string = msg.arg.channel;
    const data = msg.data as unknown[];
    if (!Array.isArray(data)) return;

    if (channel === 'trade') {
      for (const t of data as BitgetTradeMsg[]) {
        const price = parseFloat(t.price ?? '');
        const qty = parseFloat(t.size ?? '');
        this.emitTrade({
          id: `bg-${t.tradeId}`,
          venue: this.venue,
          asset: this.asset,
          timestamp: num(t.ts) ?? Date.now(),
          localTimestamp: Date.now(),
          price,
          quantity: qty,
          quoteVolume: price * qty,
          side: t.side === 'sell' ? 'sell' : 'buy',
        });
      }
    } else if (channel === 'books') {
      // snapshot = full replace, update = incremental; size 0 removes.
      if (msg.action === 'snapshot') {
        this.bids.clear();
        this.asks.clear();
      }
      for (const d of data as BitgetBookMsg[]) {
        if (d.asks) this.applyLevels(this.asks, d.asks);
        if (d.bids) this.applyLevels(this.bids, d.bids);
      }
      this.bookChanged();
    } else if (channel === 'ticker') {
      for (const t of data as BitgetTickerMsg[]) {
        const next = num(t.nextFundingTime) ?? 0;
        this.emitDerivatives({
          openInterest: num(t.holdingAmount),
          fundingRate: parseFloat(t.fundingRate ?? ''),
          fundingIntervalHours: 8,
          nextFundingTime: next > 0 ? next : undefined,
          markPrice: parseFloat(t.markPrice ?? ''),
          indexPrice: parseFloat(t.indexPrice ?? ''),
          timestamp: num(t.ts) || Date.now(),
        });
      }
    }
  }

  protected sendPing(): void {
    this.socket?.send('ping');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HYPERLIQUID PERPS
// ═══════════════════════════════════════════════════════════════════════════

const HYPERLIQUID_WS = 'wss://api.hyperliquid.xyz/ws';
const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';
const HL_BOOK_POLL_MS = 4_000;

interface HlTrade {
  coin: string;
  side: 'B' | 'S';
  px: string;
  sz: string;
  time: number;
  tid: number;
}

interface HlAssetCtx {
  funding?: string;
  openInterest?: string;
  markPx?: string;
  oraclePx?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  premium?: string;
}

interface HlBookLevel {
  px: string;
  sz: string;
  n: number;
}

export class HyperliquidAdapter extends BaseVenueAdapter {
  readonly venue: OfVenueId = 'hyperliquid';
  private bookTimer: ReturnType<typeof setInterval> | null = null;
  private bookLoading = false;

  constructor(asset: OfAsset) {
    super(asset, OF_VENUE_META.hyperliquid.symbol(asset) ?? asset);
  }

  protected buildWsUrl(): string {
    return HYPERLIQUID_WS;
  }

  protected subscribe(): void {
    const coin = this.nativeSymbol;
    this.socket?.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
    this.socket?.send(
      JSON.stringify({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin } }),
    );
    this.startBookPoll();
  }

  private startBookPoll(): void {
    if (this.bookTimer) return;
    this.bookTimer = setInterval(() => {
      if (this.active) void this.pollBook();
    }, HL_BOOK_POLL_MS);
    void this.pollBook();
  }

  private async pollBook(): Promise<void> {
    if (this.bookLoading) return;
    this.bookLoading = true;
    try {
      const body = await fetchJson<{ levels?: { bids?: HlBookLevel[]; asks?: HlBookLevel[] } }>(
        HYPERLIQUID_INFO,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'l2Book', coin: this.nativeSymbol }) },
      );
      const levels = body?.levels?.[0];
      if (!levels?.bids?.length || !levels?.asks?.length) return;
      // Full aggregated book snapshot each poll: replace and emit.
      this.bids.clear();
      this.asks.clear();
      for (const l of levels.bids) {
        const price = parseFloat(l.px);
        const size = parseFloat(l.sz);
        if (price > 0 && size > 0) this.bids.set(price, size);
      }
      for (const l of levels.asks) {
        const price = parseFloat(l.px);
        const size = parseFloat(l.sz);
        if (price > 0 && size > 0) this.asks.set(price, size);
      }
      this.bookChanged();
    } catch {
      // transient poll failure — the next tick retries
    } finally {
      this.bookLoading = false;
    }
  }

  protected handleMessage(raw: string): void {
    const msg = JSON.parse(raw);
    const channel: string | undefined = msg.channel;
    if (channel === 'trades' && Array.isArray(msg.data)) {
      for (const t of msg.data as HlTrade[]) {
        if (t.coin !== this.nativeSymbol) continue;
        const price = parseFloat(t.px);
        const qty = parseFloat(t.sz);
        this.emitTrade({
          id: `hl-${t.tid}-${t.time}`,
          venue: this.venue,
          asset: this.asset,
          timestamp: t.time,
          localTimestamp: Date.now(),
          price,
          quantity: qty,
          quoteVolume: price * qty,
          side: t.side === 'B' ? 'buy' : 'sell',
        });
      }
    } else if (channel === 'activeAssetCtx') {
      // the push delivers a single {coin, ctx} object (live-verified), but
      // tolerate an array the same way
      const entries = (Array.isArray(msg.data) ? msg.data : [msg.data]) as Array<{
        coin: string;
        ctx: HlAssetCtx;
      }>;
      for (const entry of entries) {
        if (!entry || entry.coin !== this.nativeSymbol) continue;
        const ctx = entry.ctx ?? {};
        this.emitDerivatives({
          // Hyperliquid publishes an hourly funding rate; keep the native
          // value and the 1-hour interval so annualization stays honest.
          fundingRate: parseFloat(ctx.funding ?? ''),
          fundingIntervalHours: 1,
          openInterest: parseFloat(ctx.openInterest ?? ''),
          markPrice: parseFloat(ctx.markPx ?? ''),
          indexPrice: parseFloat(ctx.oraclePx ?? ''),
        });
      }
    }
  }

  protected sendPing(): void {
    this.socket?.send(JSON.stringify({ method: 'ping' }));
  }

  disconnect(): void {
    if (this.bookTimer) clearInterval(this.bookTimer);
    this.bookTimer = null;
    super.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COINBASE SPOT
// ═══════════════════════════════════════════════════════════════════════════

const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';
const COINBASE_REST = 'https://api.exchange.coinbase.com';
const CB_BOOK_POLL_MS = 5_000;

interface CbMatch {
  type: 'match' | 'last_match';
  trade_id: number;
  side: 'buy' | 'sell';
  size: string;
  price: string;
  product_id: string;
  time: string;
}

export class CoinbaseSpotAdapter extends BaseVenueAdapter {
  readonly venue: OfVenueId = 'coinbase';
  private bookTimer: ReturnType<typeof setInterval> | null = null;
  private bookLoading = false;

  constructor(asset: OfAsset) {
    super(asset, OF_VENUE_META.coinbase.symbol(asset) ?? `${asset}-USD`);
  }

  protected buildWsUrl(): string {
    return COINBASE_WS;
  }

  protected subscribe(): void {
    this.socket?.send(
      JSON.stringify({
        type: 'subscribe',
        product_ids: [this.nativeSymbol],
        channels: ['matches', 'ticker', 'heartbeat'],
      }),
    );
    this.startBookPoll();
  }

  private startBookPoll(): void {
    if (this.bookTimer) return;
    this.bookTimer = setInterval(() => {
      if (this.active) void this.pollBook();
    }, CB_BOOK_POLL_MS);
    void this.pollBook();
  }

  private async pollBook(): Promise<void> {
    if (this.bookLoading) return;
    this.bookLoading = true;
    try {
      // level=2: top 50 aggregated levels per side, no auth required.
      const body = await fetchJson<{ bids?: [string, string, number][]; asks?: [string, string, number][] }>(
        `${COINBASE_REST}/products/${encodeURIComponent(this.nativeSymbol)}/book?level=2`,
      );
      if (!body?.bids?.length || !body?.asks?.length) return;
      this.bids.clear();
      this.asks.clear();
      // REST rows are [price, size, num-orders]; keep the first two.
      this.applyLevels(this.bids, body.bids.map((l) => [l[0], l[1]] as [string, string]));
      this.applyLevels(this.asks, body.asks.map((l) => [l[0], l[1]] as [string, string]));
      this.bookChanged();
    } catch {
      // transient poll failure — the next tick retries
    } finally {
      this.bookLoading = false;
    }
  }

  protected handleMessage(raw: string): void {
    const msg = JSON.parse(raw);
    if (msg.type === 'match' || msg.type === 'last_match') {
      if (msg.product_id !== this.nativeSymbol) return;
      const price = parseFloat(msg.price);
      const qty = parseFloat(msg.size);
      // Coinbase's match.side is the MAKER order side (verified empirically
      // 2026-11: matches at the ask report side="sell"); invert to taker side.
      const takerSide: 'buy' | 'sell' = msg.side === 'buy' ? 'sell' : 'buy';
      this.emitTrade({
        id: `cb-${msg.trade_id}`,
        venue: this.venue,
        asset: this.asset,
        timestamp: Date.parse(msg.time) || Date.now(),
        localTimestamp: Date.now(),
        price,
        quantity: qty,
        quoteVolume: price * qty,
        side: takerSide,
      });
    } else if (msg.type === 'ticker') {
      // keep-alive heartbeat for the lastHeartbeat staleness clock
      this.lastHeartbeat = Date.now();
    }
  }

  protected sendPing(): void {
    // the heartbeat channel keeps the socket warm; nothing to send
  }

  disconnect(): void {
    if (this.bookTimer) clearInterval(this.bookTimer);
    this.bookTimer = null;
    super.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createAdapter(venue: OfVenueId, asset: OfAsset): BaseVenueAdapter | null {
  const native = OF_VENUE_META[venue].symbol(asset);
  if (!native) return null;
  switch (venue) {
    case 'binance':
      return new BinancePerpAdapter(asset);
    case 'bybit':
      return new BybitPerpAdapter(asset);
    case 'okx':
      return new OkxPerpAdapter(asset);
    case 'deribit':
      return new DeribitPerpAdapter(asset);
    case 'bitget':
      return new BitgetPerpAdapter(asset);
    case 'hyperliquid':
      return new HyperliquidAdapter(asset);
    case 'coinbase':
      return new CoinbaseSpotAdapter(asset);
    default:
      return null;
  }
}

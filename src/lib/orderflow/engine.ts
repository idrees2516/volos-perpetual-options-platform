// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — per-asset engine
//
// Owns every analytic for one asset across all connected venues:
//   • 1-second flow bars → CVD, volume z-score, realized volatility
//   • footprint candles (1m/5m/15m/30m) with per-price bid×ask volumes
//   • session stats: VWAP ±σ, average print, buy/sell split
//   • resting-liquidity depth history (1 s snapshots, ±3% of mid)
//   • microstructure: absorption + iceberg detectors
//   • cross-venue 250 ms bucket tracker with lead/lag estimation
//   • merged multi-venue book, OBI, depth reach
//
// Flow-bar, volume-z, venue lead/lag and candle designs adapted from the
// open-source order-flow-screener by zadescoxp (Apache-2.0).
// ─────────────────────────────────────────────────────────────────────────────

import { AbsorptionDetector, IcebergDetector } from './microstructure';
import { DepthHistory, type DepthSide } from './depth';
import { autoTick } from './catalog';
import { computeAdvanced, type OfAdvancedAnalytics } from './advanced';
import type { BaseVenueAdapter } from './adapters';
import type {
  OfAsset,
  OfBook,
  OfCandle,
  OfDerivatives,
  OfFlowBar,
  OfFootprintLevel,
  OfMicroEvent,
  OfSessionStats,
  OfVenueId,
  OfVenueStat,
} from './types';

const VENUE_BUCKET_MS = 250;
const VENUE_BUCKETS = 720; // three minutes
const MIN_LEAD_BUCKETS = 120; // 30 s of shared history before estimating lead/lag
const FLOW_BARS = 3600; // one hour of 1 s bars
const MAX_CANDLES = 240;

export const OF_TIMEFRAMES = [60_000, 300_000, 900_000, 1_800_000] as const;
export type OfTimeframe = (typeof OF_TIMEFRAMES)[number];

interface VenueBucket {
  time: number;
  close: number;
  buy: number;
  sell: number;
  trades: number;
}

export interface OfOiPoint {
  time: number; // second bucket ms
  openInterest: number; // summed base units across reporting venues
  price: number;
}

export interface OfDepthStats {
  bid10: number;
  ask10: number;
  bid25: number;
  ask25: number;
  obi10: number;
  obi25: number;
  mid: number;
  spreadBps: number;
}

export interface OfAnalytics {
  cvd: { time: number; value: number }[];
  cvd1m: number;
  delta1m: number;
  volumeZ: number | null;
  realizedVolAnnPct: number | null;
  depth: OfDepthStats | null;
  obiHistory: { time: number; value: number }[];
  /** granular desk-grade studies (impact, toxicity, book shape, vol, profile) */
  advanced: OfAdvancedAnalytics;
  /** confirmed absorption / iceberg markers over the last 15 m */
  micro: { absorption15m: number; iceberg15m: number };
}

export class OrderFlowEngine {
  readonly asset: OfAsset;
  private adapters = new Map<OfVenueId, BaseVenueAdapter>();
  private books = new Map<OfVenueId, OfBook>();
  private derivatives = new Map<OfVenueId, OfDerivatives>();

  // tick ladder
  private _tick = 0;
  get tick(): number {
    return this._tick;
  }

  // session stats
  private _open = 0;
  private _high = 0;
  private _low = Infinity;
  private _last = 0;
  private _volume = 0;
  private _notional = 0;
  private _buyVolume = 0;
  private _sellVolume = 0;
  private _trades = 0;
  private _sumPQ = 0;
  private _sumP2Q = 0;
  private _startedAt = Date.now();
  private sessionCvd = 0;

  // flow bars (1 s)
  private bars: OfFlowBar[] = [];
  private barsStart = 0;

  // footprint candles per timeframe
  private candles = new Map<number, OfCandle[]>();

  // microstructure
  private absorption: AbsorptionDetector;
  private iceberg = new IcebergDetector();
  private microEvents: OfMicroEvent[] = [];
  private microListeners: ((events: OfMicroEvent[]) => void)[] = [];

  // depth history
  readonly depth = new DepthHistory();

  // venue tracker
  private venueBuckets = new Map<OfVenueId, VenueBucket[]>();

  // open interest history (1 s samples)
  private oiHistory: OfOiPoint[] = [];
  private oiVenuesFixed: ReadonlySet<OfVenueId> | null = null;
  private oiVenuesAt: number | null = null;

  // OBI history (1 s samples, ±10 bp)
  private obiHistory: { time: number; value: number }[] = [];

  constructor(asset: OfAsset) {
    this.asset = asset;
    this.absorption = new AbsorptionDetector(0.01);
  }

  attachAdapter(adapter: BaseVenueAdapter): void {
    this.adapters.set(adapter.venue, adapter);
  }

  detachAdapter(venue: OfVenueId): void {
    this.adapters.delete(venue);
    this.books.delete(venue);
    this.derivatives.delete(venue);
    this.venueBuckets.delete(venue);
  }

  onMicroEvent(listener: (events: OfMicroEvent[]) => void): () => void {
    this.microListeners.push(listener);
    return () => {
      this.microListeners = this.microListeners.filter((l) => l !== listener);
    };
  }

  // ── trade path ─────────────────────────────────────────────────────────────

  onTrade(trade: {
    venue: OfVenueId;
    timestamp: number;
    price: number;
    quantity: number;
    quoteVolume: number;
    side: 'buy' | 'sell';
  }): void {
    // tick ladder (recomputed lazily; autoTick is stable across decades)
    if (!(this._tick > 0) || Math.abs(trade.price / (this._last || trade.price) - 1) > 0.25) {
      const newTick = autoTick(trade.price);
      if (newTick !== this._tick) {
        this._tick = newTick;
        this.absorption.setTick(newTick);
      }
    }

    if (!this._open) {
      this._open = trade.price;
      this._startedAt = trade.timestamp;
      this.barsStart = Math.floor(trade.timestamp / 1000) * 1000;
    }
    if (trade.price > this._high) this._high = trade.price;
    if (trade.price < this._low) this._low = trade.price;
    this._last = trade.price;
    this._volume += trade.quantity;
    this._notional += trade.quoteVolume;
    if (trade.side === 'buy') this._buyVolume += trade.quantity;
    else this._sellVolume += trade.quantity;
    this._trades++;
    this._sumPQ += trade.price * trade.quantity;
    this._sumP2Q += trade.price * trade.price * trade.quantity;
    this.sessionCvd += trade.side === 'buy' ? trade.quantity : -trade.quantity;

    this.updateFlowBar(trade);
    this.updateCandles(trade);
    this.updateVenueBuckets(trade);

    // absorption windows close on trade arrival (as trades roll the clock)
    const events = this.absorption.onTrade(trade as never);
    if (events.length) this.pushMicro(events);
    this.iceberg.onTrade(trade as never, this.books.get(trade.venue));
  }

  private updateFlowBar(trade: { timestamp: number; price: number; quantity: number; side: 'buy' | 'sell' }): void {
    const time = Math.floor(trade.timestamp / 1000) * 1000;
    let bar = this.bars[this.bars.length - 1];
    if (bar && time < bar.time) {
      // A late print from a slower venue folds into the latest bar.
      bar.volume += trade.quantity;
      if (trade.side === 'buy') bar.buyVolume += trade.quantity;
      else bar.sellVolume += trade.quantity;
      bar.trades++;
      if (trade.price > bar.high) bar.high = trade.price;
      if (trade.price < bar.low) bar.low = trade.price;
      return;
    }
    if (!bar || bar.time !== time) {
      if (bar && bar.time < time) {
        // fill empty seconds so the series stays contiguous
        for (let t = bar.time + 1000; t < time; t += 1000) {
          this.bars.push({ time: t, open: bar.close, high: bar.close, low: bar.close, close: bar.close, volume: 0, buyVolume: 0, sellVolume: 0, trades: 0, cvd: this.sessionCvd });
        }
      }
      bar = { time, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: 0, buyVolume: 0, sellVolume: 0, trades: 0, cvd: this.sessionCvd };
      this.bars.push(bar);
      if (this.bars.length > FLOW_BARS) this.bars.splice(0, this.bars.length - FLOW_BARS);
    }
    bar.close = trade.price;
    if (trade.price > bar.high) bar.high = trade.price;
    if (trade.price < bar.low) bar.low = trade.price;
    bar.volume += trade.quantity;
    if (trade.side === 'buy') bar.buyVolume += trade.quantity;
    else bar.sellVolume += trade.quantity;
    bar.trades++;
    bar.cvd = this.sessionCvd;
  }

  private updateCandles(trade: { timestamp: number; price: number; quantity: number; side: 'buy' | 'sell'; venue: OfVenueId }): void {
    for (const tf of OF_TIMEFRAMES) {
      let list = this.candles.get(tf);
      if (!list) this.candles.set(tf, (list = []));
      const openTime = Math.floor(trade.timestamp / tf) * tf;
      let candle = list[list.length - 1];
      if (candle && openTime < candle.openTime) {
        // A late print from a slower venue folds into the latest candle.
        candle.volume += trade.quantity;
        candle.delta += trade.side === 'buy' ? trade.quantity : -trade.quantity;
        candle.venueVolumes[trade.venue] = (candle.venueVolumes[trade.venue] ?? 0) + trade.quantity;
        if (trade.price > candle.high) candle.high = trade.price;
        if (trade.price < candle.low) candle.low = trade.price;
        this.stampLevel(candle, trade);
        continue;
      }
      if (!candle || candle.openTime !== openTime) {
        if (candle) candle.complete = openTime > candle.openTime;
        candle = {
          openTime,
          open: trade.price,
          high: trade.price,
          low: trade.price,
          close: trade.price,
          volume: 0,
          delta: 0,
          cumulativeDelta: this.sessionCvd,
          levels: new Map<number, OfFootprintLevel>(),
          complete: false,
          venueVolumes: {},
        };
        list.push(candle);
        if (list.length > MAX_CANDLES) list.splice(0, list.length - MAX_CANDLES);
      }
      candle.close = trade.price;
      if (trade.price > candle.high) candle.high = trade.price;
      if (trade.price < candle.low) candle.low = trade.price;
      candle.volume += trade.quantity;
      candle.delta += trade.side === 'buy' ? trade.quantity : -trade.quantity;
      candle.cumulativeDelta = this.sessionCvd;
      candle.venueVolumes[trade.venue] = (candle.venueVolumes[trade.venue] ?? 0) + trade.quantity;
      this.stampLevel(candle, trade);
    }
  }

  /** Record one print into a candle's price-level footprint. */
  private stampLevel(candle: OfCandle, trade: { price: number; quantity: number; side: 'buy' | 'sell' }): void {
    const tick = this._tick;
    if (!(tick > 0)) return;
    const price = Math.round(trade.price / tick) * tick;
    let level = candle.levels.get(price);
    if (!level) {
      level = { price, bidVolume: 0, askVolume: 0, delta: 0, tradeCount: 0 };
      candle.levels.set(price, level);
    }
    // bid volume = volume traded AT the bid (aggressive sells);
    // ask volume = volume traded AT the ask (aggressive buys).
    if (trade.side === 'sell') level.bidVolume += trade.quantity;
    else level.askVolume += trade.quantity;
    level.delta = level.askVolume - level.bidVolume;
    level.tradeCount++;
  }

  private updateVenueBuckets(trade: { venue: OfVenueId; timestamp: number; price: number; quantity: number; side: 'buy' | 'sell' }): void {
    const time = Math.floor(trade.timestamp / VENUE_BUCKET_MS) * VENUE_BUCKET_MS;
    let list = this.venueBuckets.get(trade.venue);
    if (!list) this.venueBuckets.set(trade.venue, (list = []));
    let bucket = list[list.length - 1];
    if (!bucket || time > bucket.time) {
      bucket = { time, close: trade.price, buy: 0, sell: 0, trades: 0 };
      list.push(bucket);
      if (list.length > VENUE_BUCKETS) list.splice(0, list.length - VENUE_BUCKETS);
    }
    bucket.close = trade.price;
    if (trade.side === 'buy') bucket.buy += trade.quantity;
    else bucket.sell += trade.quantity;
    bucket.trades++;
  }

  private pushMicro(events: OfMicroEvent[]): void {
    this.microEvents.push(...events);
    if (this.microEvents.length > 400) this.microEvents.splice(0, this.microEvents.length - 400);
    for (const l of this.microListeners) l(events);
  }

  // ── book / derivatives path ─────────────────────────────────────────────────

  onBook(book: OfBook): void {
    this.books.set(book.venue, book);
    this.iceberg.onBook(book);
  }

  onDerivatives(update: OfDerivatives): void {
    const prev = this.derivatives.get(update.venue);
    this.derivatives.set(update.venue, prev ? { ...prev, ...update } : update);
  }

  /** Called by the manager once per second. */
  onClock(now: number): void {
    // 1 s depth snapshot across venues
    const mid = this.midPrice();
    if (mid > 0) {
      const sides: DepthSide[] = [];
      for (const adapter of this.adapters.values()) {
        const s = adapter.depthSides();
        if (s) sides.push(s as DepthSide);
      }
      const snap = this.depth.add(now, sides, this._tick || autoTick(mid), mid);
      if (snap) this.onDepthSnapshot?.(snap.time, snap.index, snap.size, this._tick);
    }

    // open interest sample (1 s)
    this.sampleOi(now);

    // OBI sample (±10 bp window)
    const obi = this.depthStats(0.001);
    if (obi) {
      this.obiHistory.push({ time: Math.floor(now / 1000) * 1000, value: obi.obi10 });
      if (this.obiHistory.length > 1800) this.obiHistory.splice(0, this.obiHistory.length - 1800);
    }

    // icebergs
    const events = this.iceberg.evaluate(now, 10 * this.averagePrint());
    if (events.length) this.pushMicro(events);
  }

  /** Optional hook so the manager can stream heatmap columns. */
  onDepthSnapshot?: (time: number, index: Int32Array, size: Float32Array, tick: number) => void;

  private sampleOi(now: number): void {
    const reporting: OfVenueId[] = [];
    let oi = 0;
    for (const d of this.derivatives.values()) {
      if (d.openInterest !== undefined && d.openInterest > 0) {
        oi += d.openInterest;
        reporting.push(d.venue);
      }
    }
    // Fix the summed venue set once every venue has reported (or after 15 s),
    // so a slow venue does not add a step to the series.
    if (!this.oiVenuesFixed && reporting.length > 0) {
      if (reporting.length >= Math.max(1, this.adapters.size) || (this.oiVenuesAt && now - this.oiVenuesAt > 15_000)) {
        this.oiVenuesFixed = new Set(reporting);
      } else if (!this.oiVenuesAt) {
        this.oiVenuesAt = now;
      }
    }
    if (this.oiVenuesFixed) {
      oi = 0;
      for (const v of this.oiVenuesFixed) {
        const d = this.derivatives.get(v);
        if (d?.openInterest && d.openInterest > 0) oi += d.openInterest;
      }
    }
    if (oi > 0 && this._last > 0) {
      this.oiHistory.push({ time: Math.floor(now / 1000) * 1000, openInterest: oi, price: this._last });
      if (this.oiHistory.length > 7200) this.oiHistory.splice(0, this.oiHistory.length - 7200);
    }
  }

  // ── queries ────────────────────────────────────────────────────────────────

  midPrice(): number {
    const book = this.mergedBook(1);
    if (book) return book.mid;
    return this._last;
  }

  sessionStats(): OfSessionStats {
    const vwap = this._volume > 0 ? this._sumPQ / this._volume : 0;
    const variance = this._volume > 0 ? Math.max(0, this._sumP2Q / this._volume - vwap * vwap) : 0;
    return {
      startTime: this._startedAt,
      open: this._open,
      high: this._high,
      low: Number.isFinite(this._low) ? this._low : 0,
      last: this._last,
      volume: this._volume,
      notional: this._notional,
      buyVolume: this._buyVolume,
      sellVolume: this._sellVolume,
      trades: this._trades,
      vwap,
      vwapStd: Math.sqrt(variance),
      averagePrint: this._trades > 0 ? this._volume / this._trades : 0,
    };
  }

  averagePrint(): number {
    return this._trades > 0 ? this._volume / this._trades : 0;
  }

  flowBars(n = 300): OfFlowBar[] {
    return this.bars.slice(-n);
  }

  candlesFor(tf: number): OfCandle[] {
    return this.candles.get(tf) ?? [];
  }

  microEventsSince(sinceMs: number): OfMicroEvent[] {
    return this.microEvents.filter((e) => e.time >= sinceMs);
  }

  allMicroEvents(): OfMicroEvent[] {
    return this.microEvents.slice(-300);
  }

  oiSeries(): OfOiPoint[] {
    return this.oiHistory;
  }

  derivativesOf(venue: OfVenueId): OfDerivatives | undefined {
    return this.derivatives.get(venue);
  }

  allDerivatives(): OfDerivatives[] {
    return [...this.derivatives.values()];
  }

  bookOf(venue: OfVenueId): OfBook | undefined {
    return this.books.get(venue);
  }

  /** Merged (multi-venue) book, levels aggregated at the same price. */
  mergedBook(maxLevels = 50): {
    bids: OfBook['bids'];
    asks: OfBook['asks'];
    mid: number;
    spread: number;
    spreadBps: number;
  } | null {
    const bidMap = new Map<number, number>();
    const askMap = new Map<number, number>();
    let bestBid = 0;
    let bestAsk = Infinity;
    for (const book of this.books.values()) {
      for (const l of book.bids) {
        bidMap.set(l.price, (bidMap.get(l.price) ?? 0) + l.size);
        if (l.price > bestBid) bestBid = l.price;
      }
      for (const l of book.asks) {
        askMap.set(l.price, (askMap.get(l.price) ?? 0) + l.size);
        if (l.price < bestAsk) bestAsk = l.price;
      }
    }
    if (!bidMap.size || !askMap.size || bestBid <= 0 || !Number.isFinite(bestAsk)) return null;
    const bids = [...bidMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, maxLevels)
      .map(([price, size]) => ({ price, size, venue: 'binance' as OfVenueId }));
    const asks = [...askMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, maxLevels)
      .map(([price, size]) => ({ price, size, venue: 'binance' as OfVenueId }));
    const mid = (bestBid + bestAsk) / 2;
    const spread = Math.max(0, bestAsk - bestBid);
    return { bids, asks, mid, spread, spreadBps: mid > 0 ? (spread / mid) * 10_000 : 0 };
  }

  /** Resting liquidity within ±windowFraction of mid, plus OBI. */
  depthStats(windowFraction = 0.001): OfDepthStats | null {
    let bid10 = 0;
    let ask10 = 0;
    let bid25 = 0;
    let ask25 = 0;
    let bestBid = 0;
    let bestAsk = Infinity;
    for (const book of this.books.values()) {
      for (const l of book.bids) {
        if (l.price > bestBid) bestBid = l.price;
      }
      for (const l of book.asks) {
        if (l.price < bestAsk) bestAsk = l.price;
      }
    }
    if (bestBid <= 0 || !Number.isFinite(bestAsk)) return null;
    const mid = (bestBid + bestAsk) / 2;
    const lo10 = mid * (1 - 0.001);
    const hi10 = mid * (1 + 0.001);
    const lo25 = mid * (1 - 0.0025);
    const hi25 = mid * (1 + 0.0025);
    for (const book of this.books.values()) {
      for (const l of book.bids) {
        if (l.price >= hi10 && l.price < mid) continue; // guard against crossed books
        if (l.price >= lo10 && l.price <= mid) bid10 += l.size * l.price;
        if (l.price >= lo25 && l.price <= mid) bid25 += l.size * l.price;
      }
      for (const l of book.asks) {
        if (l.price >= mid && l.price <= hi10) ask10 += l.size * l.price;
        if (l.price >= mid && l.price <= hi25) ask25 += l.size * l.price;
      }
    }
    const total10 = bid10 + ask10;
    const total25 = bid25 + ask25;
    return {
      bid10,
      ask10,
      bid25,
      ask25,
      obi10: total10 > 0 ? (bid10 - ask10) / total10 : 0,
      obi25: total25 > 0 ? (bid25 - ask25) / total25 : 0,
      mid,
      spreadBps: mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0,
    };
  }

  // ── analytics ──────────────────────────────────────────────────────────────

  volumeZ(window = 60): number | null {
    const n = this.bars.length;
    if (n < window + 2) return null;
    const current = this.bars[n - 1].volume;
    let mean = 0;
    for (let i = n - 1 - window; i < n - 1; i++) mean += this.bars[i].volume;
    mean /= window;
    let variance = 0;
    for (let i = n - 1 - window; i < n - 1; i++) variance += (this.bars[i].volume - mean) ** 2;
    variance /= window;
    const std = Math.sqrt(variance);
    return std > 0 ? (current - mean) / std : null;
  }

  /** Annualized close-to-close realized volatility over `window` 1 s bars. */
  realizedVolAnnPct(window = 300): number | null {
    const n = this.bars.length;
    if (n < Math.min(window, 30)) return null;
    const slice = this.bars.slice(-window);
    let sum = 0;
    let count = 0;
    for (let i = 1; i < slice.length; i++) {
      if (slice[i - 1].close > 0 && slice[i].close > 0) {
        const r = Math.log(slice[i].close / slice[i - 1].close);
        sum += r * r;
        count++;
      }
    }
    if (count < 10) return null;
    const barsPerYear = 365 * 24 * 3600;
    return Math.sqrt(sum / count) * Math.sqrt(barsPerYear) * 100;
  }

  analytics(): OfAnalytics {
    const bars = this.bars;
    const now = Date.now();
    const cvd = bars.slice(-300).map((b) => ({ time: b.time, value: b.cvd }));
    const oneMinuteAgo = now - 60_000;
    let cvd1m = 0;
    let delta1m = 0;
    const oneMinuteBars = bars.filter((b) => b.time >= oneMinuteAgo);
    if (oneMinuteBars.length >= 2) {
      cvd1m = oneMinuteBars[oneMinuteBars.length - 1].cvd - oneMinuteBars[0].cvd;
      delta1m = cvd1m;
    } else if (bars.length >= 2) {
      const k = Math.min(bars.length, 60);
      cvd1m = bars[bars.length - 1].cvd - bars[bars.length - k].cvd;
      delta1m = cvd1m;
    }
    const volZ = this.volumeZ();
    const rv = this.realizedVolAnnPct();
    const advanced = computeAdvanced(
      bars,
      this.candlesFor(60_000),
      this.sessionStats(),
      this.mergedBook(50),
      this.obiHistory,
      this._tick,
      this.volumeZ(300),
      rv,
    );
    const since15m = now - 900_000;
    let absorption15m = 0;
    let iceberg15m = 0;
    for (const e of this.microEvents) {
      if (e.time < since15m) continue;
      if (e.kind === 'absorption') absorption15m++;
      else if (e.kind === 'iceberg') iceberg15m++;
    }
    return {
      cvd,
      cvd1m,
      delta1m,
      volumeZ: volZ,
      realizedVolAnnPct: rv,
      depth: this.depthStats(),
      obiHistory: this.obiHistory.slice(-240),
      advanced,
      micro: { absorption15m, iceberg15m },
    };
  }

  // ── cross-venue comparison ─────────────────────────────────────────────────

  venueSummary(now = Date.now()): { stats: OfVenueStat[]; leader: OfVenueStat | null } {
    const series = this.venueBuckets;
    const venues = [...series.keys()].filter((v) => series.get(v)!.length);
    if (!venues.length) return { stats: [], leader: null };
    const lasts = venues.map((v) => series.get(v)![series.get(v)!.length - 1].close).sort((a, b) => a - b);
    const median = lasts[Math.floor(lasts.length / 2)];
    const since = now - 60_000;
    let totalVolume = 0;
    const stats: OfVenueStat[] = venues.map((venue) => {
      const list = series.get(venue)!;
      let volume = 0;
      let delta = 0;
      for (let i = list.length - 1; i >= 0 && list[i].time >= since; i--) {
        volume += list[i].buy + list[i].sell;
        delta += list[i].buy - list[i].sell;
      }
      totalVolume += volume;
      const last = list[list.length - 1].close;
      return { venue, last, premiumBps: median ? ((last - median) / median) * 10_000 : 0, volume, share: 0, delta, leadMs: null, leadCorr: null };
    });
    for (const s of stats) s.share = totalVolume ? s.volume / totalVolume : 0;

    // lead/lag over the history every venue shares (≥30 s, ≤150 s)
    const leadWindowMs = 150_000;
    const sharedStart = Math.max(now - leadWindowMs, ...venues.map((v) => series.get(v)![0].time));
    const from = Math.ceil(sharedStart / VENUE_BUCKET_MS) * VENUE_BUCKET_MS;
    const count = Math.floor((now - from) / VENUE_BUCKET_MS);
    if (venues.length >= 2 && count >= MIN_LEAD_BUCKETS) {
      const r = new Map<OfVenueId, Float64Array>();
      for (const venue of venues) {
        const prices = this.grid(series.get(venue)!, from, count);
        if (prices) r.set(venue, returns(prices));
      }
      const maxLag = 8;
      for (const stat of stats) {
        const own = r.get(stat.venue);
        const others = [...r.entries()].filter(([v]) => v !== stat.venue).map(([, x]) => x);
        if (!own || !others.length) continue;
        const ref = new Float64Array(own.length);
        for (const o of others) for (let i = 0; i < ref.length; i++) ref[i] += o[i] / others.length;
        let bestLag = 0;
        let best = laggedCorrelation(own, ref, 0);
        for (let lag = -maxLag; lag <= maxLag; lag++) {
          if (lag === 0) continue;
          const c = laggedCorrelation(own, ref, lag);
          if (c > best) {
            best = c;
            bestLag = lag;
          }
        }
        if (best < 0.1) continue;
        // own[t] best matches ref[t + lag]: positive lag = this venue moves first
        stat.leadMs = bestLag * VENUE_BUCKET_MS;
        stat.leadCorr = best;
      }
    }

    stats.sort((a, b) => b.volume - a.volume);
    const leaders = stats
      .filter((s) => s.leadMs !== null && s.leadMs > 0)
      .sort((a, b) => b.leadMs! - a.leadMs! || b.leadCorr! - a.leadCorr!);
    return { stats, leader: leaders[0] ?? null };
  }

  /** Forward-filled close prices on a common grid. */
  private grid(list: VenueBucket[], from: number, count: number): Float64Array | null {
    const out = new Float64Array(count);
    let j = 0;
    let last = NaN;
    for (let i = 0; i < count; i++) {
      const t = from + i * VENUE_BUCKET_MS;
      while (j < list.length && list[j].time <= t) last = list[j++].close;
      out[i] = last;
    }
    return Number.isFinite(out[0]) ? out : null;
  }

  icebergCandidate(venue: OfVenueId, side: 'bid' | 'ask', price: number) {
    return this.iceberg.candidateAt(venue, side, price);
  }
}

function returns(prices: Float64Array): Float64Array {
  const r = new Float64Array(prices.length - 1);
  for (let i = 1; i < prices.length; i++) r[i - 1] = Math.log(prices[i] / prices[i - 1]);
  return r;
}

/** corr(a[t], b[t + lag]) over the overlapping range. */
function laggedCorrelation(a: Float64Array, b: Float64Array, lag: number): number {
  let sa = 0,
    sb = 0,
    saa = 0,
    sbb = 0,
    sab = 0,
    n = 0;
  for (let t = Math.max(0, -lag); t < a.length && t + lag < b.length; t++) {
    const x = a[t];
    const y = b[t + lag];
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
    n++;
  }
  if (n < 10) return 0;
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

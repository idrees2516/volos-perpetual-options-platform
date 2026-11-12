// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — manager (process-wide singleton)
//
// Owns one engine + one adapter set per asset, keeps the tape / liquidation /
// micro-event rings, runs the 250 ms trade flush + 1 s clock (depth heatmap
// sampling, OI sampling, alerts, venue stats), serves SSE subscribers and the
// whole-market overview. Adapters are created on demand ("interest") and
// garbage-collected when nobody is watching.
// ─────────────────────────────────────────────────────────────────────────────

import { createAdapter, type BaseVenueAdapter } from './adapters';
import { OrderFlowEngine, type OfTimeframe } from './engine';
import { AlertMonitor, DEFAULT_ALERT_SETTINGS } from './alerts';
import {
  aggregateDerivatives,
  bucketLiquidations,
  fundingRate8h,
  annualizeFunding,
  liquidationState,
  oiWindowChange,
  summarizeLiquidations,
  type OfOIWindowChange,
} from './derivatives';
import { getLevels } from './levels';
import { OF_ASSETS, OF_VENUES, OF_VENUE_META, venuesForAsset } from './catalog';
import type {
  OfAlertEvent,
  OfAlertSettings,
  OfAsset,
  OfBook,
  OfLiquidation,
  OfMicroEvent,
  OfTrade,
  OfVenueConnection,
  OfVenueId,
  OfWireTrade,
} from './types';

const TAPE_CAPACITY = 20_000;
const LIQ_CAPACITY = 5_000;
const MICRO_CAPACITY = 400;
const INTEREST_GRACE_MS = 120_000;
const ALERT_RING = 200;

export interface TapeEntry extends OfWireTrade {
  /** displayed size at the trade price on that venue's book at insert time */
  bookSize?: number;
}

export interface OfSubscriber {
  id: string;
  asset: OfAsset;
  topics: Set<string>;
  minNotional: number;
  send: (event: string, data: unknown) => void;
  close: () => void;
  /** alert settings live on the subscriber (per browser, like the reference) */
  alertSettings?: OfAlertSettings;
}

interface AssetState {
  asset: OfAsset;
  adapters: Map<OfVenueId, BaseVenueAdapter>;
  engine: OrderFlowEngine;
  connections: Map<OfVenueId, OfVenueConnection>;
  tape: TapeEntry[];
  liquidations: OfLiquidation[];
  pendingTrades: OfTrade[];
  pendingLiqs: OfLiquidation[];
  pendingMicro: OfMicroEvent[];
  // analytics-storage bookkeeping ("store now, analyze later")
  lastStoreMicro: number;
  lastStoreBars: number;
  interestUntil: number;
  lastFlush: number;
  lastVenuesPush: number;
  alertRing: OfAlertEvent[];
  alertPointers: Map<string, number>; // subscriberId -> tape index evaluated
}

export interface OfPrintDetail {
  print: TapeEntry;
  venueName: string;
  nativeSymbol: string;
  surrounding: TapeEntry[];
  flowAfter: { t1s: number; t5s: number; t15s: number } | null;
  restingSizeAtPrice: number | null;
  iceberg: { traded: number; displayed: number; refills: number } | null;
  avgPrint: number;
  verdict: string;
}

class OrderFlowManager {
  private states = new Map<OfAsset, AssetState>();
  private subscribers = new Map<string, OfSubscriber>();
  private subSeq = 0;
  private tradeTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.tradeTimer = setInterval(() => this.flushTrades(), 250);
    this.clockTimer = setInterval(() => this.clock(), 1000);
    this.sweepTimer = setInterval(() => this.sweep(), 20_000);
    // don't hold the event loop open for a plain preview
    for (const t of [this.tradeTimer, this.clockTimer, this.sweepTimer]) {
      (t as unknown as { unref?: () => void }).unref?.();
    }
  }

  ensureAsset(asset: OfAsset, interestMs = INTEREST_GRACE_MS): AssetState {
    this.start();
    let state = this.states.get(asset);
    if (!state) {
      const engine = new OrderFlowEngine(asset);
      state = {
        asset,
        adapters: new Map(),
        engine,
        connections: new Map(),
        tape: [],
        liquidations: [],
        pendingTrades: [],
        pendingLiqs: [],
        pendingMicro: [],
        lastStoreMicro: 0,
        lastStoreBars: 0,
        interestUntil: 0,
        lastFlush: Date.now(),
        lastVenuesPush: 0,
        alertRing: [],
        alertPointers: new Map(),
      };
      engine.onMicroEvent((events) => state!.pendingMicro.push(...events));
      engine.onDepthSnapshot = (time, index, size, tick) => {
        // stream the heatmap column to subscribers of this asset
        for (const sub of this.subscribers.values()) {
          if (sub.asset === asset && sub.topics.has('heatmap')) {
            sub.send('heatmap', { t: time, i: Array.from(index), s: Array.from(size), tick });
          }
        }
      };
      this.states.set(asset, state);
    }
    state.interestUntil = Math.max(state.interestUntil, Date.now() + interestMs);
    // (re)connect any missing adapter
    for (const venue of venuesForAsset(asset)) {
      if (!state.adapters.has(venue)) {
        const adapter = createAdapter(venue, asset);
        if (!adapter) continue;
        state.adapters.set(venue, adapter);
        state.engine.attachAdapter(adapter);
        adapter.on('trade', (t: OfTrade) => {
          state!.engine.onTrade(t);
          this.pushTape(state!, t);
        });
        adapter.on('book', (b: OfBook) => state!.engine.onBook(b));
        adapter.on('derivatives', (d) => state!.engine.onDerivatives(d));
        adapter.on('liquidation', (l: OfLiquidation) => {
          state!.liquidations.push(l);
          if (state!.liquidations.length > LIQ_CAPACITY) state!.liquidations.splice(0, state!.liquidations.length - LIQ_CAPACITY);
          state!.pendingLiqs.push(l);
        });
        adapter.on('status', (c: OfVenueConnection) => state!.connections.set(c.venue, c));
        adapter.connect();
      }
    }
    return state;
  }

  isRunning(asset: OfAsset): boolean {
    const state = this.states.get(asset);
    return !!state && state.adapters.size > 0;
  }

  stateOf(asset: OfAsset): AssetState | undefined {
    return this.states.get(asset);
  }

  /** Mark interest in an asset (routes call this on every request). */
  touch(asset: OfAsset, ms = INTEREST_GRACE_MS): void {
    this.ensureAsset(asset, ms);
  }

  touchAll(ms = 300_000): void {
    for (const asset of OF_ASSETS) this.ensureAsset(asset, ms);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [asset, state] of this.states) {
      const watched = [...this.subscribers.values()].some((s) => s.asset === asset);
      if (watched) {
        state.interestUntil = Math.max(state.interestUntil, now + INTEREST_GRACE_MS);
        continue;
      }
      if (state.interestUntil < now) {
        for (const adapter of state.adapters.values()) adapter.disconnect();
        for (const v of [...state.adapters.keys()]) state.engine.detachAdapter(v);
        state.adapters.clear();
        this.states.delete(asset);
      }
    }
  }

  // ── tape ───────────────────────────────────────────────────────────────────

  private pushTape(state: AssetState, t: OfTrade): void {
    const book = state.engine.bookOf(t.venue);
    let bookSize: number | undefined;
    if (book) {
      const side = t.side === 'sell' ? book.bids : book.asks;
      for (const l of side) {
        if (l.price === t.price) {
          bookSize = l.size;
          break;
        }
      }
    }
    const avg = state.engine.averagePrint();
    const entry: TapeEntry = {
      ...t,
      ratio: avg > 0 ? t.quantity / avg : undefined,
      bookSize,
    };
    state.tape.push(entry);
    if (state.tape.length > TAPE_CAPACITY) state.tape.splice(0, state.tape.length - TAPE_CAPACITY);
    state.pendingTrades.push(t);
  }

  // ── periodic jobs ──────────────────────────────────────────────────────────

  private flushTrades(): void {
    const now = Date.now();
    for (const state of this.states.values()) {
      if (!state.adapters.size) continue;
      if (!state.pendingTrades.length && !state.pendingLiqs.length) {
        state.lastFlush = now;
        continue;
      }
      const trades = state.pendingTrades;
      const liqs = state.pendingLiqs;
      state.pendingTrades = [];
      state.pendingLiqs = [];
      state.lastFlush = now;

      for (const sub of this.subscribers.values()) {
        if (sub.asset !== state.asset) continue;
        if (sub.topics.has('trade')) {
          const batch = this.wireTrades(state, trades).filter((t) => t.quoteVolume >= sub.minNotional);
          if (batch.length) sub.send('trade', { batch });
        }
        if (sub.topics.has('liq') && liqs.length) {
          sub.send('liq', { batch: liqs.slice(-40) });
        }
      }
    }
  }

  private clock(): void {
    const now = Date.now();
    for (const state of this.states.values()) {
      if (!state.adapters.size) continue;
      state.engine.onClock(now);

      // analytics storage — microstructure every 30 s, flow bars every minute
      if (now - (state.lastStoreMicro ?? 0) > 30_000) {
        state.lastStoreMicro = now;
        void import('@/lib/store/writer').then(({ recordMicroSnapshot }) =>
          recordMicroSnapshot(state.asset, state.engine),
        );
      }
      if (now - (state.lastStoreBars ?? 0) > 60_000) {
        state.lastStoreBars = now;
        void import('@/lib/store/writer').then(({ recordFlowBars }) =>
          recordFlowBars(state.asset, state.engine),
        );
      }

      const micro = state.pendingMicro;
      state.pendingMicro = [];

      for (const sub of this.subscribers.values()) {
        if (sub.asset !== state.asset) continue;
        if (sub.topics.has('micro') && micro.length) sub.send('micro', { events: micro });
        if (sub.topics.has('stats')) sub.send('stats', this.statsPayload(state));
        if (sub.topics.has('book')) sub.send('book', this.bookPayload(state));
        if (sub.topics.has('deriv')) sub.send('deriv', this.derivPayload(state));
        if (sub.topics.has('venues') && now - state.lastVenuesPush > 5_000) {
          sub.send('venues', this.venuesPayload(state));
        }
        if (sub.topics.has('status')) sub.send('status', { venues: [...state.connections.values()] });
      }
      state.lastVenuesPush = now;

      // alerts — every subscriber with its own settings gets its own monitor pass
      this.runAlerts(state, now, micro);
    }
  }

  private runAlerts(state: AssetState, now: number, micro: OfMicroEvent[]): void {
    if (!state.alertRing) state.alertRing = [];
    const relevant = [...this.subscribers.values()].filter(
      (s) => s.asset === state.asset && s.topics.has('alerts'),
    );
    if (!relevant.length) {
      // still record events with default settings so the ring stays warm
      this.evaluateMonitor(state, 'default', DEFAULT_ALERT_SETTINGS, now, micro);
      return;
    }
    for (const sub of relevant) {
      this.evaluateMonitor(state, sub.id, sub.alertSettings ?? DEFAULT_ALERT_SETTINGS, now, micro);
    }
  }
  private evaluateMonitor(
    state: AssetState,
    key: string,
    settings: OfAlertSettings,
    now: number,
    micro: OfMicroEvent[],
  ): void {
    // fresh trades/liquidations since this monitor's last pass
    let pointer = state.alertPointers.get(key) ?? Math.max(0, state.tape.length - 1);
    const newTrades = state.tape.slice(pointer);
    pointer = state.tape.length;
    state.alertPointers.set(key, pointer);

    let liqPointer = state.alertPointers.get(`${key}:liq`) ?? Math.max(0, state.liquidations.length - 1);
    const newLiqs = state.liquidations.slice(liqPointer);
    state.alertPointers.set(`${key}:liq`, state.liquidations.length);

    const monitor = this.getMonitor(key, settings);
    const events = monitor.evaluate({
      engine: state.engine,
      now,
      newTrades,
      newLiquidations: newLiqs,
      newMicro: micro,
    });
    if (!events.length) return;
    state.alertRing.push(...events);
    if (state.alertRing.length > ALERT_RING) state.alertRing.splice(0, state.alertRing.length - ALERT_RING);
    for (const sub of this.subscribers.values()) {
      if (sub.asset === state.asset && sub.topics.has('alerts') && sub.id === key) {
        sub.send('alert', { events });
      }
    }
  }

  private monitors = new Map<string, AlertMonitor>();

  private getMonitor(key: string, settings: OfAlertSettings): AlertMonitor {
    let m = this.monitors.get(key);
    if (!m || JSON.stringify(m.settings) !== JSON.stringify(settings)) {
      m = new AlertMonitor(settings);
      this.monitors.set(key, m);
    }
    return m;
  }

  // ── payload builders ────────────────────────────────────────────────────────

  private wireTrades(state: AssetState, trades: OfTrade[]): OfWireTrade[] {
    const avg = state.engine.averagePrint();
    return trades.map((t) => {
      const ratio = avg > 0 ? t.quantity / avg : undefined;
      const flags: string[] = [];
      if (ratio !== undefined && ratio >= 5) flags.push('big');
      return { ...t, ratio, flags };
    });
  }

  private statsPayload(state: AssetState) {
    const e = state.engine;
    const analytics = e.analytics();
    return {
      session: e.sessionStats(),
      tick: e.tick,
      analytics: {
        cvd1m: analytics.cvd1m,
        volumeZ: analytics.volumeZ,
        realizedVolAnnPct: analytics.realizedVolAnnPct,
        depth: analytics.depth,
        obi: analytics.obiHistory.slice(-60),
        cvd: analytics.cvd.slice(-120),
      },
      liq: {
        last5m: summarizeLiquidations(state.liquidations, Date.now() - 300_000),
        buckets: bucketLiquidations(state.liquidations, 60_000, 30, Date.now()),
        state: liquidationState(bucketLiquidations(state.liquidations, 15_000, 20, Date.now())),
      },
    };
  }

  private bookPayload(state: AssetState) {
    const merged = state.engine.mergedBook(25);
    const perVenue: Record<string, { bid: number; ask: number; bidSize: number; askSize: number } | null> = {};
    for (const v of OF_VENUES) {
      const b = state.engine.bookOf(v);
      if (b && b.bids[0] && b.asks[0]) {
        perVenue[v] = { bid: b.bids[0].price, ask: b.asks[0].price, bidSize: b.bids[0].size, askSize: b.asks[0].size };
      } else perVenue[v] = null;
    }
    return merged ? { merged: { bids: merged.bids.slice(0, 25), asks: merged.asks.slice(0, 25), mid: merged.mid, spreadBps: merged.spreadBps }, perVenue } : { merged: null, perVenue };
  }

  private derivPayload(state: AssetState) {
    const e = state.engine;
    const snapshots = e.allDerivatives();
    const aggregate = aggregateDerivatives(snapshots, e.midPrice() || undefined);
    const windows: Record<string, OfOIWindowChange | null> = {
      w1m: oiWindowChange(e.oiSeries(), 60_000),
      w5m: oiWindowChange(e.oiSeries(), 300_000),
      w15m: oiWindowChange(e.oiSeries(), 900_000),
    };
    return {
      aggregate,
      perVenue: snapshots.map((s) => ({
        venue: s.venue,
        openInterest: s.openInterest,
        fundingRate: s.fundingRate,
        fundingRate8h: fundingRate8h(s),
        fundingAnnualizedPct: s.fundingRate !== undefined ? annualizeFunding(s.fundingRate, s.fundingIntervalHours ?? 8) * 100 : undefined,
        nextFundingTime: s.nextFundingTime,
        markPrice: s.markPrice,
        indexPrice: s.indexPrice,
        basisBps: s.markPrice && s.indexPrice ? ((s.markPrice - s.indexPrice) / s.indexPrice) * 10_000 : undefined,
      })),
      oiSeries: e.oiSeries().slice(-300),
      windows,
    };
  }

  private venuesPayload(state: AssetState) {
    const summary = state.engine.venueSummary();
    return { stats: summary.stats, leader: summary.leader };
  }

  // ── SSE subscriber registry ────────────────────────────────────────────────

  addSubscriber(sub: Omit<OfSubscriber, 'id'>): OfSubscriber {
    this.start();
    const id = `sub-${++this.subSeq}`;
    const full: OfSubscriber = { ...sub, id };
    this.subscribers.set(id, full);
    this.ensureAsset(sub.asset);
    return full;
  }

  removeSubscriber(id: string): void {
    this.subscribers.delete(id);
  }

  subscriber(id: string): OfSubscriber | undefined {
    return this.subscribers.get(id);
  }

  // ── REST query helpers ──────────────────────────────────────────────────────

  tapeQuery(
    asset: OfAsset,
    opts: { venue?: OfVenueId; minNotional?: number; flags?: string[]; limit?: number; since?: number } = {},
  ): TapeEntry[] {
    const state = this.states.get(asset);
    if (!state) return [];
    const limit = Math.min(opts.limit ?? 120, 500);
    let out = state.tape.slice().reverse(); // newest first
    if (opts.venue) out = out.filter((t) => t.venue === opts.venue);
    if (opts.minNotional) out = out.filter((t) => t.quoteVolume >= opts.minNotional!);
    if (opts.since) out = out.filter((t) => t.timestamp >= opts.since!);
    if (opts.flags?.length) {
      const flags = new Set(opts.flags);
      out = out.filter((t) => {
        if (flags.has('big')) return (t.ratio ?? 0) >= 5;
        if (flags.has('whale')) return t.quoteVolume >= 100_000;
        return false;
      });
    }
    return out.slice(0, limit);
  }

  liquidationQuery(asset?: OfAsset, sinceMs?: number, limit = 200): OfLiquidation[] {
    const states = asset ? [this.states.get(asset)].filter(Boolean) as AssetState[] : [...this.states.values()];
    const out: OfLiquidation[] = [];
    for (const s of states) {
      for (let i = s.liquidations.length - 1; i >= 0; i--) {
        const l = s.liquidations[i];
        if (sinceMs && l.timestamp < sinceMs) break;
        out.push(l);
      }
    }
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out.slice(0, limit);
  }

  microQuery(asset: OfAsset, sinceMs?: number): OfMicroEvent[] {
    const state = this.states.get(asset);
    if (!state) return [];
    const events = state.engine.allMicroEvents();
    return sinceMs ? events.filter((e) => e.time >= sinceMs) : events;
  }

  printDetail(id: string): OfPrintDetail | null {
    for (const state of this.states.values()) {
      const idx = state.tape.findIndex((t) => t.id === id);
      if (idx < 0) continue;
      const print = state.tape[idx];
      const engine = state.engine;
      const surrounding = state.tape
        .filter((t) => Math.abs(t.timestamp - print.timestamp) <= 5_000)
        .slice(-40);
      const bars = engine.flowBars(600);
      const secBar = bars.find((b) => Math.abs(b.time - Math.floor(print.timestamp / 1000) * 1000) <= 1000);
      const at = Math.max(0, bars.findIndex((b) => b.time >= print.timestamp));
      const pick = (off: number) => {
        const target = bars[Math.min(bars.length - 1, at + off)];
        return target && target.close ? ((target.close - print.price) / print.price) * 100 : null;
      };
      const flowAfter = secBar
        ? {
            t1s: pick(1) ?? 0,
            t5s: pick(5) ?? 0,
            t15s: pick(15) ?? 0,
          }
        : null;
      const restingSizeAtPrice = this.depthSizeAt(engine, print.timestamp, print.price);
      const side = print.side === 'sell' ? 'bid' : 'ask';
      const iceberg = engine.icebergCandidate(print.venue, side, print.price);
      let verdict = 'Standard print — visible size, no refill behaviour detected.';
      if (iceberg) verdict = `Iceberg candidate — ${iceberg.traded.toFixed(3)} traded against ${iceberg.displayed.toFixed(3)} displayed with ${iceberg.refills} refills.`;
      else if (print.bookSize !== undefined && print.quantity > 1.5 * print.bookSize) {
        verdict = 'Executed beyond the displayed size at that level — hidden liquidity likely.';
      }
      if (flowAfter && Math.abs(flowAfter.t5s) > 0.07) {
        verdict += ` Price moved ${flowAfter.t5s > 0 ? 'through/up' : 'through/down'} ${(Math.abs(flowAfter.t5s)).toFixed(2)}% within 5s (pass-through).`;
      } else if (flowAfter && Math.abs(flowAfter.t5s) < 0.02) {
        verdict += ' Price held within 0.02% over 5s after the print (absorption-like hold).';
      }
      return {
        print,
        venueName: OF_VENUE_META[print.venue].name,
        nativeSymbol: OF_VENUE_META[print.venue].symbol(state.asset) ?? '',
        surrounding,
        flowAfter,
        restingSizeAtPrice,
        iceberg,
        avgPrint: engine.averagePrint(),
        verdict,
      };
    }
    return null;
  }

  /** Resting size at a price on the snapshot nearest `time` (heatmap lookup). */
  private depthSizeAt(engine: OrderFlowEngine, time: number, price: number): number | null {
    const history = engine.depth;
    if (!history.size || !(history.tick > 0)) return null;
    const seq = Math.min(history.lastSeq, history.seqAtOrAfter(time));
    const snap = history.get(seq);
    if (!snap || Math.abs(snap.time - time) > 2000) return null;
    const target = Math.round(price / history.tick);
    let lo = 0;
    let hi = snap.index.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (snap.index[mid] === target) return snap.size[mid];
      if (snap.index[mid] < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return 0;
  }

  /** One-shot snapshot for the initial SSE payload / REST snapshot route. */
  snapshot(asset: OfAsset, opts: { tf?: OfTimeframe; candles?: number } = {}) {
    const state = this.ensureAsset(asset);
    const engine = state.engine;
    const tf = opts.tf ?? 60_000;
    return {
      asset,
      tsMs: Date.now(),
      tick: engine.tick,
      session: engine.sessionStats(),
      analytics: engine.analytics(),
      book: this.bookPayload(state),
      deriv: this.derivPayload(state),
      venues: this.venuesPayload(state),
      connections: [...state.connections.values()],
      micro: engine.allMicroEvents().slice(-120),
      candles: engine.candlesFor(tf).slice(-(opts.candles ?? 80)),
      liq: {
        recent: state.liquidations.slice(-60),
        last5m: summarizeLiquidations(state.liquidations, Date.now() - 300_000),
        buckets: bucketLiquidations(state.liquidations, 60_000, 30, Date.now()),
      },
    };
  }

  /** Whole-market overview across every tracked asset. */
  overview(): { tsMs: number; assets: OfAssetOverview[] } {
    const now = Date.now();
    const assets = OF_ASSETS.map((asset) => this.assetOverview(asset, now));
    return { tsMs: now, assets };
  }

  assetOverview(asset: OfAsset, now: number) {
    const state = this.states.get(asset);
    if (!state) {
      return {
        asset,
        connected: false,
        venues: OF_VENUES.map((v) => ({ venue: v, status: 'offline' as const })),
      };
    }
    const engine = state.engine;
    const stats = engine.sessionStats();
    const analytics = engine.analytics();
    const bars = engine.flowBars(120);
    let price1mAgo = stats.last;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].time <= now - 60_000) {
        price1mAgo = bars[i].close;
        break;
      }
    }
    const derivPayload = this.derivPayload(state);
    const liqBuckets1h = bucketLiquidations(state.liquidations, 300_000, 12, now); // 5m × 12 = 1h
    const liq24h = summarizeLiquidations(state.liquidations, now - 86_400_000);
    const liq1h = summarizeLiquidations(state.liquidations, now - 3_600_000);
    const liq5m = summarizeLiquidations(state.liquidations, now - 300_000);
    const venueSummary = engine.venueSummary();
    return {
      asset,
      connected: state.adapters.size > 0,
      last: stats.last,
      change1mPct: price1mAgo > 0 ? ((stats.last - price1mAgo) / price1mAgo) * 100 : 0,
      changeSessionPct: stats.open > 0 ? ((stats.last - stats.open) / stats.open) * 100 : 0,
      sessionHigh: stats.high,
      sessionLow: stats.low,
      vwap: stats.vwap,
      vwapDevPct: stats.vwap > 0 ? ((stats.last - stats.vwap) / stats.vwap) * 100 : 0,
      volume1mNotional: bars.filter((b) => b.time >= now - 60_000).reduce((a, b) => a + (b.buyVolume + b.sellVolume) * b.close, 0),
      buyShare1m: (() => {
        const recent = bars.filter((b) => b.time >= now - 60_000);
        const buy = recent.reduce((a, b) => a + b.buyVolume, 0);
        const sell = recent.reduce((a, b) => a + b.sellVolume, 0);
        return buy + sell > 0 ? buy / (buy + sell) : 0.5;
      })(),
      cvd1m: analytics.cvd1m,
      volumeZ: analytics.volumeZ,
      realizedVolAnnPct: analytics.realizedVolAnnPct,
      obi10: analytics.depth?.obi10 ?? null,
      spreadBps: analytics.depth?.spreadBps ?? null,
      depth25Notional: analytics.depth ? analytics.depth.bid25 + analytics.depth.ask25 : null,
      openInterest: derivPayload.aggregate?.openInterest ?? null,
      openInterestValue: derivPayload.aggregate?.openInterestValue ?? null,
      oiChange: derivPayload.windows.w5m,
      oiRegime: derivPayload.windows.w1m?.regime ?? 'neutral',
      funding8h: derivPayload.aggregate?.fundingRate8h ?? null,
      fundingAnnualizedPct:
        derivPayload.aggregate?.fundingRate8h !== null && derivPayload.aggregate?.fundingRate8h !== undefined
          ? annualizeFunding(derivPayload.aggregate.fundingRate8h) * 100
          : null,
      nextFundingTime: derivPayload.aggregate?.nextFundingTime ?? null,
      basisBps: derivPayload.aggregate?.basisBps ?? null,
      liquidations: {
        last5m: liq5m,
        last1h: liq1h,
        last24h: liq24h,
        cascadeActive: liquidationState(bucketLiquidations(state.liquidations, 15_000, 20, now)) === 'cascade',
      },
      micro: {
        absorption: engine.microEventsSince(now - 300_000).filter((m) => m.kind === 'absorption').length,
        icebergs: engine.microEventsSince(now - 300_000).filter((m) => m.kind === 'iceberg').length,
      },
      leaderVenue: venueSummary.leader?.venue ?? null,
      venues: [...state.connections.values()].map((c) => ({
        venue: c.venue,
        status: c.status,
      })),
      venueStats: venueSummary.stats,
    };
  }

  alertRing(asset: OfAsset): OfAlertEvent[] {
    return (this.states.get(asset)?.alertRing ?? []).slice(-60);
  }
}

// ── singleton (survives dev-server module reloads) ──────────────────────────

const globalForOrderflow = globalThis as unknown as { __volosOrderFlow?: OrderFlowManager };

export function getOrderFlowManager(): OrderFlowManager {
  if (!globalForOrderflow.__volosOrderFlow) {
    globalForOrderflow.__volosOrderFlow = new OrderFlowManager();
  }
  return globalForOrderflow.__volosOrderFlow;
}

export type { OrderFlowManager };
export type OfAssetOverview = ReturnType<OrderFlowManager['assetOverview']>;

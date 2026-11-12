// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — microstructure detectors
//
// Absorption: heavy aggressive volume at one price that fails to move price
// through it. Iceberg: a displayed level that keeps refilling after more than
// its displayed size has traded against it. Both are heuristics and are
// labelled as such in the UI.
//
// Adapted from the open-source order-flow-screener by zadescoxp (Apache-2.0).
// ─────────────────────────────────────────────────────────────────────────────

import type { OfBook, OfMicroEvent, OfTrade, OfVenueId } from './types';

export interface AbsorptionOptions {
  windowMs: number;
  /** Level volume must reach this multiple of the average window's total volume. */
  minRatio: number;
  /** ...and this share of the window's volume on that aggressor side. */
  minShare: number;
  /** Price may trade at most this many ticks through the level. */
  slackTicks: number;
  /** Average window volume needs this many prior windows. */
  warmupWindows: number;
}

export const DEFAULT_ABSORPTION: AbsorptionOptions = {
  windowMs: 10_000,
  minRatio: 1,
  minShare: 0.5,
  slackTicks: 1,
  warmupWindows: 6,
};

interface Window {
  start: number;
  buy: Map<number, number>; // tick index -> aggressive buy volume
  sell: Map<number, number>;
  buyTotal: number;
  sellTotal: number;
  high: number;
  low: number;
  close: number;
}

export class AbsorptionDetector {
  private window: Window | null = null;
  private totals: number[] = [];
  private idCounter = 0;

  constructor(private tick: number, private readonly options: AbsorptionOptions = DEFAULT_ABSORPTION) {}

  setTick(tick: number): void {
    if (tick === this.tick) return;
    this.tick = tick;
    this.window = null;
    this.totals = [];
  }

  /** Feed one trade; returns any absorption confirmed by a closing window. */
  onTrade(trade: OfTrade): OfMicroEvent[] {
    if (!(this.tick > 0)) return [];
    const start = Math.floor(trade.timestamp / this.options.windowMs) * this.options.windowMs;
    let events: OfMicroEvent[] = [];
    if (this.window && start > this.window.start) {
      events = this.close(this.window);
      this.window = null;
    }
    if (!this.window) {
      this.window = {
        start,
        buy: new Map(),
        sell: new Map(),
        buyTotal: 0,
        sellTotal: 0,
        high: -Infinity,
        low: Infinity,
        close: 0,
      };
    }
    const w = this.window;
    const index = Math.round(trade.price / this.tick);
    const side = trade.side === 'buy' ? w.buy : w.sell;
    side.set(index, (side.get(index) ?? 0) + trade.quantity);
    if (trade.side === 'buy') w.buyTotal += trade.quantity;
    else w.sellTotal += trade.quantity;
    w.high = Math.max(w.high, index);
    w.low = Math.min(w.low, index);
    w.close = index;
    return events;
  }

  private close(w: Window): OfMicroEvent[] {
    const total = w.buyTotal + w.sellTotal;
    const prior = this.totals;
    const ready = prior.length >= this.options.warmupWindows;
    const average = ready ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
    prior.push(total);
    if (prior.length > 30) prior.shift();
    if (!ready || average <= 0) return [];

    const out: OfMicroEvent[] = [];
    const { minRatio, minShare, slackTicks } = this.options;
    const end = w.start + this.options.windowMs;
    // Sellers hitting one bid price while price holds at or above it.
    for (const [index, volume] of w.sell) {
      if (volume < average * minRatio || volume < w.sellTotal * minShare) continue;
      if (w.low < index - slackTicks || w.close < index) continue;
      const price = index * this.tick;
      out.push({
        id: `abs-${this.venueTag}-${++this.idCounter}`,
        kind: 'absorption',
        side: 'bid',
        price,
        time: end,
        start: w.start,
        volume,
        notional: volume * price,
        ratio: volume / average,
      });
    }
    // Buyers lifting one offer while price holds at or below it.
    for (const [index, volume] of w.buy) {
      if (volume < average * minRatio || volume < w.buyTotal * minShare) continue;
      if (w.high > index + slackTicks || w.close > index) continue;
      const price = index * this.tick;
      out.push({
        id: `abs-${this.venueTag}-${++this.idCounter}`,
        kind: 'absorption',
        side: 'ask',
        price,
        time: end,
        start: w.start,
        volume,
        notional: volume * price,
        ratio: volume / average,
      });
    }
    return out;
  }

  private get venueTag(): string {
    return 'x';
  }
}

export interface IcebergOptions {
  /** Traded volume must exceed the displayed size by this multiple. */
  minTradedRatio: number;
  /** The level must still show at least this share of its first displayed size. */
  minRefillShare: number;
  /** Confirm after this long without a new print at the level. */
  idleMs: number;
  /** Drop a candidate older than this. */
  maxAgeMs: number;
}

export const DEFAULT_ICEBERG: IcebergOptions = {
  minTradedRatio: 1.5,
  minRefillShare: 0.5,
  idleMs: 3_000,
  maxAgeMs: 30_000,
};

interface Candidate {
  venue: OfVenueId;
  side: 'bid' | 'ask';
  price: number;
  displayed: number; // size shown when first hit
  shown: number; // latest displayed size
  traded: number;
  refills: number;
  first: number;
  last: number;
}

function sizeAt(levels: OfBook['bids'], price: number): number {
  for (const level of levels) if (level.price === price) return level.size;
  return 0;
}

export class IcebergDetector {
  private candidates = new Map<string, Candidate>();
  private idCounter = 0;

  constructor(private readonly options: IcebergOptions = DEFAULT_ICEBERG) {}

  reset(): void {
    this.candidates.clear();
  }

  /** A print against a venue's book. `book` is that venue's latest emitted book. */
  onTrade(trade: OfTrade, book: OfBook | undefined): void {
    if (!book) return;
    // An aggressive sell hits the bid; an aggressive buy lifts the offer.
    const side = trade.side === 'sell' ? 'bid' : 'ask';
    const key = `${trade.venue}:${side}:${trade.price}`;
    let c = this.candidates.get(key);
    if (!c) {
      const displayed = sizeAt(side === 'bid' ? book.bids : book.asks, trade.price);
      if (!(displayed > 0)) return; // not a visible level on this venue's book
      c = {
        venue: trade.venue,
        side,
        price: trade.price,
        displayed,
        shown: displayed,
        traded: 0,
        refills: 0,
        first: trade.timestamp,
        last: trade.timestamp,
      };
      this.candidates.set(key, c);
    }
    c.traded += trade.quantity;
    c.last = trade.timestamp;
  }

  /** Track how the hit levels' displayed size evolves. */
  onBook(book: OfBook): void {
    for (const c of this.candidates.values()) {
      if (c.venue !== book.venue) continue;
      const size = sizeAt(c.side === 'bid' ? book.bids : book.asks, c.price);
      if (size > c.shown) c.refills++;
      c.shown = size;
    }
  }

  /** Confirm or drop candidates. `minVolume` filters small prints (10× average). */
  evaluate(now: number, minVolume: number): OfMicroEvent[] {
    const out: OfMicroEvent[] = [];
    const { minTradedRatio, minRefillShare, idleMs, maxAgeMs } = this.options;
    for (const [key, c] of this.candidates) {
      const idle = now - c.last >= idleMs;
      if (!idle && now - c.first < maxAgeMs) continue;
      this.candidates.delete(key);
      if (c.traded < minVolume) continue;
      if (c.traded < c.displayed * minTradedRatio) continue;
      if (c.shown < c.displayed * minRefillShare || c.refills === 0) continue;
      out.push({
        id: `ice-${++this.idCounter}`,
        kind: 'iceberg',
        side: c.side,
        price: c.price,
        time: c.last,
        start: c.first,
        volume: c.traded,
        notional: c.traded * c.price,
        venue: c.venue,
        ratio: c.traded / c.displayed,
      });
    }
    return out;
  }

  /** Live candidate stats for a price (order-detail drawer). */
  candidateAt(venue: OfVenueId, side: 'bid' | 'ask', price: number): { traded: number; displayed: number; refills: number } | null {
    const c = this.candidates.get(`${venue}:${side}:${price}`);
    if (!c) return null;
    return { traded: c.traded, displayed: c.displayed, refills: c.refills };
  }
}

// Unit tests — flow-bar / footprint folding in OrderFlowEngine.
// Synthetic trades (including out-of-order arrival, the production bug that
// once broke candles) drive the engine directly; no adapters or network.

import { describe, expect, it } from 'vitest';
import { OrderFlowEngine } from './engine';
import type { OfVenueId } from './types';

interface SyntheticTrade {
  venue: OfVenueId;
  timestamp: number;
  price: number;
  quantity: number;
  quoteVolume: number;
  side: 'buy' | 'sell';
}

function feed(engine: OrderFlowEngine, trades: SyntheticTrade[]): void {
  for (const t of trades) engine.onTrade(t);
}

describe('OrderFlowEngine candle folding', () => {
  // minute-aligned so floor(ts/tf)·tf == T0 + k·tf
  const T0 = Math.floor(1_700_000_000_000 / 60_000) * 60_000;
  const tf = 60_000;

  it('folds OHLCV + delta per 1-minute candle', () => {
    const engine = new OrderFlowEngine('BTC');
    feed(engine, [
      { venue: 'binance', timestamp: T0 + 1_000, price: 100, quantity: 2, quoteVolume: 200, side: 'buy' },
      { venue: 'binance', timestamp: T0 + 11_000, price: 110, quantity: 3, quoteVolume: 330, side: 'buy' },
      { venue: 'binance', timestamp: T0 + 21_000, price: 90, quantity: 4, quoteVolume: 360, side: 'sell' },
      { venue: 'binance', timestamp: T0 + 31_000, price: 105, quantity: 1, quoteVolume: 105, side: 'sell' },
      // next candle
      { venue: 'binance', timestamp: T0 + 61_000, price: 95, quantity: 2, quoteVolume: 190, side: 'sell' },
    ]);
    const candles = engine.candlesFor(tf);
    expect(candles).toHaveLength(2);
    const c0 = candles[0];
    expect(c0.openTime).toBe(T0);
    expect(c0.open).toBe(100);
    expect(c0.high).toBe(110);
    expect(c0.low).toBe(90);
    expect(c0.close).toBe(105);
    expect(c0.volume).toBe(10);
    expect(c0.delta).toBe(2 + 3 - 4 - 1); // 0
    expect(c0.complete).toBe(true);
    const c1 = candles[1];
    expect(c1.open).toBe(95);
    expect(c1.volume).toBe(2);
    expect(c1.delta).toBe(-2);
  });

  it('folds out-of-order prints into the LATEST candle (slow-venue semantics)', () => {
    const engine = new OrderFlowEngine('BTC');
    feed(engine, [
      { venue: 'binance', timestamp: T0 + 5_000, price: 100, quantity: 1, quoteVolume: 100, side: 'buy' },
      { venue: 'binance', timestamp: T0 + 65_000, price: 120, quantity: 5, quoteVolume: 600, side: 'buy' }, // next bar first
      { venue: 'bybit', timestamp: T0 + 10_000, price: 104, quantity: 2, quoteVolume: 208, side: 'buy' }, // late print
      { venue: 'binance', timestamp: T0 + 70_000, price: 118, quantity: 1, quoteVolume: 118, side: 'sell' },
    ]);
    const candles = engine.candlesFor(tf);
    expect(candles).toHaveLength(2);
    const c0 = candles[0];
    // the first bar closed when the second opened — late prints never reopen it
    expect(c0.volume).toBe(1);
    expect(c0.complete).toBe(true);
    expect(c0.close).toBe(100);
    const c1 = candles[1];
    // the late print folds into the LATEST candle: volume/delta/venue/low
    expect(c1.volume).toBe(5 + 2 + 1);
    expect(c1.delta).toBe(5 + 2 - 1);
    expect(c1.low).toBe(104); // folded low
    expect(c1.high).toBe(120);
    expect(c1.close).toBe(118); // close only advances on in-order prints
    expect(c1.venueVolumes.bybit).toBe(2);
    expect(c1.venueVolumes.binance).toBe(6);
  });

  it('CVD accumulates across candles in trade order', () => {
    const engine = new OrderFlowEngine('BTC');
    feed(engine, [
      { venue: 'binance', timestamp: T0 + 1_000, price: 100, quantity: 1, quoteVolume: 100, side: 'buy' },
      { venue: 'binance', timestamp: T0 + 61_000, price: 100, quantity: 2, quoteVolume: 200, side: 'sell' },
      { venue: 'binance', timestamp: T0 + 121_000, price: 100, quantity: 4, quoteVolume: 400, side: 'buy' },
    ]);
    const candles = engine.candlesFor(tf);
    expect(candles[0].cumulativeDelta).toBe(1);
    expect(candles[1].cumulativeDelta).toBe(-1);
    expect(candles[2].cumulativeDelta).toBe(3);
  });

  it('per-venue volumes land in the right candle buckets', () => {
    const engine = new OrderFlowEngine('BTC');
    feed(engine, [
      { venue: 'binance', timestamp: T0 + 2_000, price: 100, quantity: 3, quoteVolume: 300, side: 'buy' },
      { venue: 'bybit', timestamp: T0 + 3_000, price: 101, quantity: 2, quoteVolume: 202, side: 'sell' },
      { venue: 'okx', timestamp: T0 + 63_000, price: 102, quantity: 7, quoteVolume: 714, side: 'buy' },
    ]);
    const candles = engine.candlesFor(tf);
    expect(candles[0].venueVolumes.binance).toBe(3);
    expect(candles[0].venueVolumes.bybit).toBe(2);
    expect(candles[0].venueVolumes.okx ?? 0).toBe(0);
    expect(candles[1].venueVolumes.okx).toBe(7);
    expect(candles[1].volume).toBe(7);
  });

  it('session stats reflect the whole synthetic feed', () => {
    const engine = new OrderFlowEngine('BTC');
    feed(engine, [
      { venue: 'binance', timestamp: T0 + 1_000, price: 100, quantity: 2, quoteVolume: 200, side: 'buy' },
      { venue: 'binance', timestamp: T0 + 61_000, price: 108, quantity: 3, quoteVolume: 324, side: 'buy' },
      { venue: 'binance', timestamp: T0 + 121_000, price: 96, quantity: 5, quoteVolume: 480, side: 'sell' },
    ]);
    const s = engine.sessionStats();
    expect(s.open).toBe(100);
    expect(s.high).toBe(108);
    expect(s.low).toBe(96);
    expect(s.last).toBe(96);
    expect(s.volume).toBe(10);
    expect(s.buyVolume).toBe(5);
    expect(s.trades).toBe(3);
    // VWAP = Σp·q / Σq = (200+324+480)/10 = 100.4
    expect(s.vwap).toBeCloseTo(100.4, 6);
  });
});

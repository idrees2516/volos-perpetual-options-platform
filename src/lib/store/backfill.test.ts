// Unit tests — backfill planning math: chunk layout, 418 backoff escalation,
// Retry-After parsing, and kline row validation. These guard the exact
// behaviors that keep the worker polite to venue rate limits.

import { describe, expect, it } from 'vitest';
import {
  nextBackoffMs,
  parseBinanceKline,
  planChunks,
  retryAfterMs,
  DEFAULT_BACKFILL_CONFIG,
} from './backfill';

describe('planChunks', () => {
  const DAY = 86_400_000;
  const MIN = 60_000;

  it('tiles [start, end] exactly, walking backwards in maxPerChunk·step windows', () => {
    const start = 1_000_000_000;
    const end = start + 10 * MIN;
    // step 1m, 3 per chunk → spans of 3 minutes
    const chunks = planChunks(start, end, MIN, 3);
    expect(chunks).toHaveLength(4); // ceil(10/3)
    expect(chunks[0][0]).toBe(start);
    expect(chunks[chunks.length - 1][1]).toBe(end);
    // chronological, non-overlapping, gap-free
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i][0]).toBe(chunks[i - 1][1]);
      expect(chunks[i][1]).toBeGreaterThan(chunks[i][0]);
    }
  });

  it('bounds the last chunk at the requested start', () => {
    const start = 0;
    const end = 10;
    const chunks = planChunks(start, end, 1, 4);
    expect(chunks).toHaveLength(3); // [0,4] [4,8] [8,10]
    expect(chunks[0][0]).toBe(0);
    expect(chunks[2][1]).toBe(10);
  });

  it('degrades to empty on inverted or degenerate spans', () => {
    expect(planChunks(100, 10, 1, 5)).toEqual([]);
    expect(planChunks(0, 100, 0, 5)).toEqual([]);
    expect(planChunks(0, 100, 1, 0)).toEqual([]);
  });

  it('plans the documented 30-day 1m depth as 43200 bars / 1500 = 29 chunks', () => {
    const now = 1_800_000_000_000;
    const chunks = planChunks(now - 30 * DAY, now, MIN, 1500);
    expect(chunks).toHaveLength(Math.ceil((30 * DAY) / MIN / 1500));
    expect(chunks[0][0]).toBe(now - 30 * DAY);
    expect(chunks[chunks.length - 1][1]).toBe(now);
  });

  it('default config depths are inside venue caps', () => {
    // 1m: 30d (43200 bars → 29 chunks of 1500)
    expect(DEFAULT_BACKFILL_CONFIG.klineDepthDays[60]).toBe(30);
    // OI history: Binance serves ~30 days at 5m
    expect(DEFAULT_BACKFILL_CONFIG.oiDepthDays).toBeLessThanOrEqual(29);
    // pacing ≥ 1s keeps us far under the klines weight budget
    expect(DEFAULT_BACKFILL_CONFIG.minCallGapMs).toBeGreaterThanOrEqual(1000);
  });
});

describe('nextBackoffMs (418/429 escalation)', () => {
  it('doubles per consecutive hit and respects the ceiling', () => {
    const base = 45_000;
    expect(nextBackoffMs(1, base, 900_000, 0.5)).toBe(base);
    expect(nextBackoffMs(2, base, 900_000, 0.5)).toBe(90_000);
    expect(nextBackoffMs(3, base, 900_000, 0.5)).toBe(180_000);
    // hit 6 → 45s·32 = 1_440_000 → capped at 900_000
    expect(nextBackoffMs(6, base, 900_000, 0.5)).toBe(900_000);
  });

  it('jitter stays within ±min(cap/2, 5s) of the deterministic value', () => {
    const out = nextBackoffMs(2, 45_000, 900_000, 0.99);
    expect(out).toBeGreaterThanOrEqual(85_000);
    expect(out).toBeLessThanOrEqual(95_000);
  });

  it('floors at 1s even with absurd inputs', () => {
    expect(nextBackoffMs(0, 0, 900_000, 0.5)).toBe(1_000);
    expect(nextBackoffMs(-5, 10, 900_000, 0.5)).toBe(1_000);
  });
});

describe('retryAfterMs', () => {
  it('parses seconds form', () => {
    expect(retryAfterMs('60')).toBe(60_000);
    expect(retryAfterMs('0')).toBe(0);
  });

  it('parses HTTP-date form as a future offset', () => {
    const in90s = new Date(Date.now() + 90_000).toUTCString();
    const ms = retryAfterMs(in90s);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(85_000);
    expect(ms!).toBeLessThan(95_000);
  });

  it('null on absent or garbage headers', () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });

  it('caps pathological values at 15 minutes', () => {
    expect(retryAfterMs('99999')).toBe(900_000);
  });
});

describe('parseBinanceKline', () => {
  const row = [
    1700000000000, '42000.1', '42100.5', '41950.2', '42050.7', '123.456', 1700000059999, '42060.0', 321, '61.728', '62.1', '0',
  ];

  it('parses the canonical Binance kline layout', () => {
    const bar = parseBinanceKline(row);
    expect(bar).not.toBeNull();
    expect(bar!.tOpen).toBe(1700000000000);
    expect(bar!.open).toBe(42000.1);
    expect(bar!.high).toBe(42100.5);
    expect(bar!.low).toBe(41950.2);
    expect(bar!.close).toBe(42050.7);
    expect(bar!.volume).toBe(123.456);
    expect(bar!.buyVolume).toBe(61.728); // index 9 = taker buy base volume
    expect(bar!.trades).toBe(321); // index 8 = trade count
  });

  it('rejects malformed rows', () => {
    expect(parseBinanceKline([] as never)).toBeNull();
    expect(parseBinanceKline([1, 'x', '2', '3', '4', '5', 6, '7', 8, '9'] as never)).toBeNull();
    expect(parseBinanceKline([1, '2', '3', '4', '5', '-1', 6, '7', 8, '9'] as never)).toBeNull(); // negative volume
    expect(parseBinanceKline([0, '2', '3', '4', '5', '1', 6, '7', 8, '9'] as never)).toBeNull(); // non-positive time
  });

  it('aggressor delta is recoverable from parsed fields (2·buy − vol)', () => {
    const bar = parseBinanceKline(row)!;
    expect(2 * bar.buyVolume - bar.volume).toBeCloseTo(0, 9); // exactly half buy volume
  });
});

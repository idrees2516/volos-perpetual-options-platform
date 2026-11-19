import { describe, expect, it } from 'vitest';
import { detectWalls } from './walls';
import type { WireHeatmapColumn as C } from './wire';

const T0 = Date.UTC(2026, 10, 17, 10, 0, 0);
const S = 1000; // second
const TICK = 0.1;

function col(t: number, rows: Array<[number, number]>): C {
  const i = rows.map((r) => r[0]);
  const s = rows.map((r) => r[1]);
  return { t, i, s };
}

// background book: 100 units everywhere from row 100..159 (mid row = 129)
function background(): Array<[number, number]> {
  return Array.from({ length: 60 }, (_, k) => [100 + k, 100] as [number, number]);
}

describe('detectWalls', () => {
  it('detects a wall that appears, persists and vanishes', () => {
    const columns: C[] = [
      col(T0, background()),
      col(T0 + S, [...background().filter(([r]) => r !== 150), [150, 5000]]), // row 150 ≥ mid 129 → ask wall
      col(T0 + 2 * S, [...background().filter(([r]) => r !== 150), [150, 5200]]),
      col(T0 + 3 * S, [...background().filter(([r]) => r !== 150), [150, 5100]]),
      col(T0 + 4 * S, background()), // size collapsed to background → vanish (duration 3s > noise floor)
      col(T0 + 10 * S, background()),
    ];
    const scan = detectWalls(columns, TICK, {}, T0 + 10 * S);
    expect(scan.live).toHaveLength(0);
    const ev = scan.events.find((e) => e.row === 150);
    expect(ev).toBeDefined();
    expect(ev!.side).toBe('ask');
    expect(ev!.peakSize).toBe(5200);
    expect(ev!.durationMs).toBeGreaterThanOrEqual(3 * S);
    expect(ev!.durationMs).toBeLessThanOrEqual(4 * S);
  });

  it('live walls: the wall still resting at the scan edge', () => {
    const columns: C[] = [
      col(T0, background()),
      col(T0 + S, [...background().filter(([r]) => r !== 102), [102, 6000]]), // row 102 < mid 105 → bid wall
      col(T0 + 2 * S, [...background().filter(([r]) => r !== 102), [102, 6100]]),
    ];
    const scan = detectWalls(columns, TICK, {}, T0 + 2 * S);
    expect(scan.live).toHaveLength(1);
    expect(scan.live[0].side).toBe('bid');
    expect(scan.live[0].price).toBeCloseTo(102 * TICK, 10);
    expect(scan.live[0].peakSize).toBe(6100);
  });

  it('threshold adapts to the book (robust percentile × median floor)', () => {
    const noisy = Array.from({ length: 20 }, (_, k) => [200 + k, 50 + (k % 3) * 10] as [number, number]);
    const columns: C[] = [
      col(T0, noisy),
      col(T0 + S, [...noisy.filter(([r]) => r !== 205), [205, 400]]), // ~4× median — below the 6× floor
      col(T0 + 2 * S, [...noisy.filter(([r]) => r !== 206), [206, 4000]]), // ~40× median — a real wall
    ];
    const scan = detectWalls(columns, TICK, {}, T0 + 2 * S);
    expect(scan.live.some((w) => w.row === 206)).toBe(true);
    expect(scan.live.some((w) => w.row === 205)).toBe(false);
  });

  it('sub-2s flickers are filtered as noise', () => {
    const columns: C[] = [
      col(T0, background()),
      col(T0 + S, [...background().filter(([r]) => r !== 103), [103, 9000]]), // appears…
      col(T0 + 2 * S, background()), // …gone next second (duration ~1s)
    ];
    const scan = detectWalls(columns, TICK, {}, T0 + 2 * S);
    expect(scan.events.filter((e) => e.row === 103)).toHaveLength(0);
  });

  it('empty input → empty scan, no crash', () => {
    const scan = detectWalls([], TICK);
    expect(scan.live).toEqual([]);
    expect(scan.events).toEqual([]);
    expect(scan.threshold).toBeGreaterThan(0);
    expect(scan.scanned).toBe(0);
  });
});

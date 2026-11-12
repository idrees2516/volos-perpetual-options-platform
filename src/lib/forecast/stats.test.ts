// Unit tests — statistics helpers (quantiles, pinball, season detection).
// Golden values pinned to numpy/pandas semantics ("type 7" linear
// interpolation) so the conformal calibration math stays reference-faithful.

import { describe, expect, it } from 'vitest';
import {
  detectSeasonLength,
  mean,
  pinballLoss,
  quantile,
  quantileSorted,
  seasonalNaiveMae,
  std,
  variance,
} from './stats';

describe('quantile (type 7, numpy default)', () => {
  it('interpolates linearly between order statistics', () => {
    const xs = [1, 2, 3, 4]; // sorted
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(4);
    expect(quantile(xs, 0.5)).toBe(2.5); // pos = 1.5 → 2 + 0.5·(3−2)
    expect(quantile(xs, 0.25)).toBe(1.75); // pos = 0.75
  });

  it('sorts unsorted input', () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
  });

  it('handles single-element and empty arrays', () => {
    expect(quantile([7], 0.3)).toBe(7);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  it('matches numpy on a 5-point golden vector', () => {
    // numpy.quantile([10,20,30,40,50], 0.1) = 14.0 (pos = 0.4 → 10 + .4·10)
    expect(quantile([10, 20, 30, 40, 50], 0.1)).toBeCloseTo(14.0, 10);
    // q=0.8 → pos = 3.2 → 40 + 0.2·10 = 42
    expect(quantile([10, 20, 30, 40, 50], 0.8)).toBeCloseTo(42.0, 10);
  });

  it('quantileSorted agrees with quantile on sorted input', () => {
    const sorted = [1, 3, 5, 7, 9, 11];
    for (const q of [0, 0.1, 0.25, 0.5, 0.666, 0.9, 1]) {
      expect(quantileSorted(sorted, q)).toBeCloseTo(quantile(sorted, q), 12);
    }
  });
});

describe('pinballLoss', () => {
  it('is zero at the quantile itself', () => {
    expect(pinballLoss(100, 100, 0.1)).toBe(0);
    expect(pinballLoss(100, 100, 0.95)).toBe(0);
  });

  it('over-prediction at low quantile costs 2(1−q)|e|, under costs 2q|e|', () => {
    // y=110, yhat=100, q=0.1 → e=+10 (under-forecast the high quantile? e=y−yhat>0)
    expect(pinballLoss(110, 100, 0.1)).toBeCloseTo(2 * 0.1 * 10, 10);
    // y=90, yhat=100, q=0.9 → e=−10 → 2(1−0.9)·10
    expect(pinballLoss(90, 100, 0.9)).toBeCloseTo(2 * 0.1 * 10, 10);
  });

  it('is asymmetric for the median', () => {
    // q=0.5 → both sides cost |e| (×2·0.5)
    expect(pinballLoss(105, 100, 0.5)).toBeCloseTo(5, 10);
    expect(pinballLoss(95, 100, 0.5)).toBeCloseTo(5, 10);
  });
});

describe('moments', () => {
  it('mean/variance/std on a known set', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(xs)).toBe(5);
    expect(variance(xs)).toBe(4); // population variance
    expect(std(xs)).toBe(2);
  });

  it('degenerate inputs', () => {
    expect(mean([])).toBe(0);
    expect(variance([3])).toBe(0);
    expect(std([3])).toBe(0);
  });
});

describe('seasonalNaiveMae + detectSeasonLength', () => {
  it('seasonal naive MAE is zero for an exact seasonal series', () => {
    const y = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3];
    expect(seasonalNaiveMae(y, 3)).toBe(0);
  });

  it('detects a dominant seasonal lag on a periodic signal', () => {
    // sine-ish with period 12 + noise floor
    const y: number[] = [];
    for (let i = 0; i < 96; i++) {
      y.push(Math.sin((2 * Math.PI * i) / 12) * 10 + (i % 3) * 0.01);
    }
    expect(detectSeasonLength(y)).toBe(12);
  });

  it('falls back to 1 for a pure random walk (no clear season)', () => {
    // mulberry32 — properly shuffled increments, no artificial lag structure
    let v = 100;
    let seed = 42;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const y: number[] = [];
    for (let i = 0; i < 200; i++) {
      v += rand() - 0.5;
      y.push(v);
    }
    expect(detectSeasonLength(y)).toBe(1);
  });

  it('short series returns 1 without crashing', () => {
    expect(detectSeasonLength([1, 2])).toBe(1);
  });
});

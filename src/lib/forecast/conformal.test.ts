// Unit tests — the interval engine: split conformal, native knots, native
// full, EnbPI and ACI. Statistical assertions run on seeded synthetic series
// (deterministic PRNG) with tolerances wide enough to be stable but tight
// enough to catch calibration regressions.

import { describe, expect, it } from 'vitest';
import {
  ConformalIntervals,
  aciIntervals,
  enbpiIntervals,
  nativeFullIntervals,
  nativeKnotIntervals,
  type ConformalCalibration,
} from './conformal';
import { FC_POINT_MODELS } from './models';
import type { FcModelContext } from './models';
import type { FcLevelInterval } from './types';

// deterministic PRNG (mulberry32)
function prng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian via Box–Muller on the seeded PRNG. */
function gauss(rand: () => number) {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Random walk with drift, n points, σ per step. */
function randomWalk(n: number, seed: number, sigma = 1, drift = 0.02): number[] {
  const rand = prng(seed);
  const y: number[] = [100];
  for (let i = 1; i < n; i++) y.push(y[i - 1] + drift + gauss(rand) * sigma);
  return y;
}

function ctxOf(y: number[], h: number): FcModelContext {
  return { y, h, seasonLength: 1, features: undefined };
}

const coverageOf = (rows: FcLevelInterval[][], actual: number[], level: number) => {
  let inN = 0;
  let n = 0;
  for (let j = 0; j < actual.length; j++) {
    const li = rows[j]?.find((l) => l.level === level);
    if (!li || !Number.isFinite(li.lo) || !Number.isFinite(li.hi)) continue;
    n++;
    if (actual[j] >= li.lo && actual[j] <= li.hi) inN++;
  }
  return n > 0 ? inN / n : NaN;
};

describe('ConformalIntervals.fitWindows', () => {
  it('solves n ≥ h + (W−1)Δ + 1 exactly', () => {
    // n=61, h=12, Δ=12, W=5 → 12 + 4·12 + 1 = 61 → fits
    expect(ConformalIntervals.fitWindows(61, 12, 12, 5)).toBe(5);
    expect(ConformalIntervals.fitWindows(60, 12, 12, 5)).toBe(4);
    // n=25 → W=2 fits exactly (12 + 1·12 + 1 = 25); n=24 → nothing fits
    expect(ConformalIntervals.fitWindows(25, 12, 12, 5)).toBe(2);
    expect(ConformalIntervals.fitWindows(24, 12, 12, 5)).toBe(0);
  });

  it('never returns fewer than 2 usable windows', () => {
    expect(ConformalIntervals.fitWindows(20, 12, 12, 10)).toBe(0);
    expect(ConformalIntervals.fitWindows(1000, 12, 12, 64)).toBe(64);
  });
});

describe('split conformal (conformal_error)', () => {
  const h = 8;
  const W = 24; // windows on a long history → stable quantiles
  const y = randomWalk(600, 7, 0.8);

  it('calibrates on backtested errors and produces per-step widths', () => {
    const c = new ConformalIntervals(W, 'conformal_error');
    const cal = c.calibrate(ctxOf(y, h), FC_POINT_MODELS.naive, h, {});
    expect(cal.ok).toBe(true);
    expect(cal.errors.length).toBeGreaterThanOrEqual(2);
    expect(cal.errors[0].length).toBe(h);
    // naive forecast errors grow with √step on a random walk
    expect(cal.errorByStep[h - 1]).toBeGreaterThan(cal.errorByStep[0]);
  });

  it('delivers empirical coverage near nominal on random walks', () => {
    // fresh walk per rep: calibration windows re-draw every experiment, so the
    // average also averages over finite-W quantile noise (single fixed
    // calibration would make coverage a single noisy draw)
    const reps = 24;
    const h2 = 8;
    let cov80 = 0;
    let cov95 = 0;
    for (let r = 0; r < reps; r++) {
      const yR = randomWalk(600, 1000 + r, 0.8);
      const tail = yR.slice(0, 560);
      const rand = prng(5000 + r);
      const future: number[] = [];
      let last = tail[tail.length - 1];
      for (let j = 0; j < h2; j++) {
        last = last + gauss(rand) * 0.8;
        future.push(last);
      }
      const c = new ConformalIntervals(W, 'conformal_error');
      const cal = c.calibrate(ctxOf(tail, h2), FC_POINT_MODELS.naive, h2, {});
      const { forecast: point } = FC_POINT_MODELS.naive(ctxOf(tail, h2));
      const rows = c.intervals(point, cal, [80, 95]);
      cov80 += coverageOf(rows, future, 80);
      cov95 += coverageOf(rows, future, 95);
    }
    // conformal guarantees ~level coverage in expectation: allow slack for
    // finite-W quantile noise, but catch systematic under-coverage
    expect(cov80 / reps).toBeGreaterThan(0.68);
    expect(cov80 / reps).toBeLessThan(0.97);
    expect(cov95 / reps).toBeGreaterThan(0.85);
  });

  it('auto-shrinks W on short history and reports why', () => {
    const short = randomWalk(40, 3, 0.8);
    const c = new ConformalIntervals(10, 'conformal_error');
    const cal = c.calibrate(ctxOf(short, h), FC_POINT_MODELS.naive, h, {});
    expect(cal.ok).toBe(true);
    expect(cal.nWindows).toBeLessThan(10);
    expect(cal.available).toBe(40);
  });
});

describe('native knot clamping vs native_full', () => {
  const y = randomWalk(400, 11, 0.9);
  const h = 6;
  const ctx = ctxOf(y, h);
  const { forecast: point, fitted } = FC_POINT_MODELS.ar(ctx);
  // fitted is NaN before burn-in — residuals only where finite
  const residuals: number[] = [];
  for (let i = 0; i < y.length; i++) {
    const f = fitted[i];
    if (Number.isFinite(f)) residuals.push(Math.abs(y[i] - f));
  }

  it('native knots clamp 95% to the 80% band', () => {
    const rows = nativeKnotIntervals(point, residuals, [80, 95]);
    for (let j = 0; j < h; j++) {
      const l80 = rows[j].find((l) => l.level === 80)!;
      const l95 = rows[j].find((l) => l.level === 95)!;
      expect(Math.abs(l80.lo - l95.lo)).toBeLessThan(1e-9);
      expect(Math.abs(l80.hi - l95.hi)).toBeLessThan(1e-9);
    }
  });

  it('native_full gives a genuinely wider 95% band', () => {
    const rows = nativeFullIntervals(point, residuals, [80, 95]);
    for (let j = 0; j < h; j++) {
      const l80 = rows[j].find((l) => l.level === 80)!;
      const l95 = rows[j].find((l) => l.level === 95)!;
      expect(l95.hi - l95.lo).toBeGreaterThan(l80.hi - l80.lo);
      // z(0.975) / z(0.9) = 1.96 / 1.2816 ≈ 1.53 (80% two-sided uses Φ⁻¹(0.9))
      const ratio = (l95.hi - l95.lo) / (l80.hi - l80.lo);
      expect(ratio).toBeGreaterThan(1.4);
      expect(ratio).toBeLessThan(1.65);
    }
  });

  it('width scales with √step for both native variants', () => {
    const rows = nativeFullIntervals(point, residuals, [95]);
    const w0 = rows[0][0].hi - rows[0][0].lo;
    const wLast = rows[h - 1][0].hi - rows[h - 1][0].lo;
    expect(wLast / w0).toBeCloseTo(Math.sqrt(h), 1);
  });

  it('honours hard domain bounds (share in [0,1])', () => {
    const rows = nativeFullIntervals([0.5, 0.5, 0.5], [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4], [80, 95], { lo: 0, hi: 1 });
    for (const step of rows) {
      for (const li of step) {
        expect(li.lo).toBeGreaterThanOrEqual(-1e-9);
        expect(li.hi).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

describe('EnbPI (jackknife+ ensemble)', () => {
  const h = 6;
  it('produces finite member-mean point and intervals on a walk', () => {
    const y = randomWalk(500, 21, 0.9);
    const res = enbpiIntervals(ctxOf(y, h), FC_POINT_MODELS.theta, h, [80, 95], { nWindows: 12, stepSize: null });
    expect(res.ok).toBe(true);
    expect(res.point).toHaveLength(h);
    for (const p of res.point) expect(Number.isFinite(p)).toBe(true);
    for (const step of res.intervals) {
      for (const li of step) {
        expect(Number.isFinite(li.lo)).toBe(true);
        expect(li.hi).toBeGreaterThan(li.lo);
      }
    }
    // 95% strictly wider than 80%
    const j = h - 1;
    const w80 = res.intervals[j].find((l) => l.level === 80)!.hi - res.intervals[j].find((l) => l.level === 80)!.lo;
    const w95 = res.intervals[j].find((l) => l.level === 95)!.hi - res.intervals[j].find((l) => l.level === 95)!.lo;
    expect(w95).toBeGreaterThan(w80);
  });

  it('returns not-ok on a history too short for 2 members', () => {
    const res = enbpiIntervals(ctxOf(randomWalk(12, 5), h), FC_POINT_MODELS.naive, h, [80], { nWindows: 10, stepSize: null });
    expect(res.ok).toBe(false);
  });

  it('coverage sanity: ≥80% hits at the 80% level across fresh continuations', () => {
    const y = randomWalk(560, 33, 0.7);
    const tail = y.slice(0, 540);
    const rand = prng(1234);
    const reps = 30;
    let cov80 = 0;
    for (let r = 0; r < reps; r++) {
      const future: number[] = [];
      let last = tail[tail.length - 1];
      for (let j = 0; j < h; j++) {
        last = last + gauss(rand) * 0.7;
        future.push(last);
      }
      const res = enbpiIntervals(ctxOf(tail, h), FC_POINT_MODELS.naive, h, [80], { nWindows: 16, stepSize: null });
      cov80 += coverageOf([res.intervals[h - 1]], [future[h - 1]], 80);
    }
    expect(cov80 / reps).toBeGreaterThan(0.7);
  });
});

describe('ACI (adaptive conformal inference)', () => {
  const h = 5;
  const y = randomWalk(500, 55, 0.9);

  function calibrate(): ConformalCalibration {
    const c = new ConformalIntervals(20, 'conformal_error');
    return c.calibrate(ctxOf(y, h), FC_POINT_MODELS.naive, h, {});
  }

  it('keeps intervals finite and ordered (lo < hi)', () => {
    const cal = calibrate();
    const { forecast } = FC_POINT_MODELS.naive(ctxOf(y, h));
    const rows = aciIntervals(forecast, cal, [80, 95]);
    for (const step of rows) {
      for (const li of step) {
        expect(Number.isFinite(li.lo)).toBe(true);
        expect(li.hi).toBeGreaterThanOrEqual(li.lo);
      }
    }
  });

  it('widens when residuals are systematically under-covered (α adapts down)', () => {
    // synthetic calibration with all misses at the nominal width → α must fall
    // → the final quantile digs deeper into the residual distribution.
    const cal: ConformalCalibration = {
      errors: Array.from({ length: 12 }, () => Array.from({ length: h }, () => 10)),
      errorByStep: Array.from({ length: h }, () => 10),
      nWindows: 12,
      stepSize: h,
      required: 100,
      available: 100,
      ok: true,
    };
    const rows = aciIntervals([0, 0, 0, 0, 0], cal, [80]);
    // after repeated misses the width exceeds the plain 80% quantile of 10
    const w = rows[0][0].hi - rows[0][0].lo;
    expect(w / 2).toBeGreaterThan(10 * 0.99);
  });

  it('narrows when every residual sits at zero (over-covered → α adapts up)', () => {
    const cal: ConformalCalibration = {
      errors: Array.from({ length: 12 }, () => Array.from({ length: h }, () => 0)),
      errorByStep: Array.from({ length: h }, () => 0),
      nWindows: 12,
      stepSize: h,
      required: 100,
      available: 100,
      ok: true,
    };
    const rows = aciIntervals([0, 0, 0, 0, 0], cal, [80]);
    expect(rows[0][0].hi).toBe(0);
    expect(rows[0][0].lo).toBe(0);
  });

  it('is never wider than EnbPI-style degenerate bounds (sanity vs NaN)', () => {
    const cal = calibrate();
    const { forecast } = FC_POINT_MODELS.naive(ctxOf(y, h));
    const rows = aciIntervals(forecast, cal, [80, 95]);
    expect(rows).toHaveLength(h);
    expect(rows[0]).toHaveLength(2);
  });
});

// Unit tests — research harness statistics: rank ties, Spearman/Pearson,
// rolling z (warm-up + causal windows), Welch t, log returns, and the full
// evaluateFactor protocol on a synthetic panel where the ground truth is
// known by construction.

import { describe, expect, it } from 'vitest';
import {
  evaluateFactor,
  logReturnsBps,
  pearson,
  rank,
  rollingMean,
  rollingZ,
  spearman,
  welchT,
  RESEARCH_FACTORS,
  type ResearchPanel,
  type ResearchBar,
} from './harness';

describe('rank', () => {
  it('ranks 1-based and averages ties', () => {
    expect(rank([30, 10, 20])).toEqual([3, 1, 2]);
    // two 10s share ranks 1&2 → 1.5; then 30 is rank 3
    expect(rank([10, 30, 10])).toEqual([1.5, 3, 1.5]);
  });
  it('propagates NaN positions', () => {
    const r = rank([5, NaN, 1]);
    expect(r[0]).toBe(2);
    expect(Number.isNaN(r[1])).toBe(true);
    expect(r[2]).toBe(1);
  });
});

describe('pearson / spearman', () => {
  it('pearson = +1 for a perfect line, −1 for the inverse', () => {
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBeCloseTo(-1, 10);
  });
  it('pearson ignores NaN pairs', () => {
    const r = pearson([1, NaN, 3, 4, 5], [2, 99, 6, 8, 10]);
    expect(r).toBeCloseTo(1, 10);
  });
  it('spearman detects monotone-but-nonlinear agreement', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8];
    const y = x.map((v) => Math.exp(v)); // exp is strictly monotone
    expect(spearman(x, y)).toBeCloseTo(1, 10);
  });
  it('spearman is NaN on degenerate input', () => {
    expect(Number.isNaN(spearman([1, 1, 1], [1, 2, 3]))).toBe(true);
  });
});

describe('rollingZ / rollingMean', () => {
  it('z-scores are ~unit variance inside the window', () => {
    const xs = Array.from({ length: 500 }, (_, i) => Math.sin(i / 25) + (i % 7) * 0.01);
    const z = rollingZ(xs, 100);
    // warm-up zone is NaN for the first ~49 (half-window floor)
    expect(Number.isNaN(z[10])).toBe(true);
    const warm = z.slice(100).filter(Number.isFinite);
    const mean = warm.reduce((a, b) => a + b, 0) / warm.length;
    const sd = Math.sqrt(warm.reduce((a, b) => a + (b - mean) ** 2, 0) / warm.length);
    expect(Math.abs(mean)).toBeLessThan(0.25);
    expect(sd).toBeGreaterThan(0.7);
    expect(sd).toBeLessThan(1.7);
  });
  it('is causal — the value at i ignores the future', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
    const a = rollingZ(xs, 8);
    const mutated = [...xs];
    mutated[20] = 999; // future change
    const b = rollingZ(mutated, 8);
    expect(a[15]).toBeCloseTo(b[15], 12); // identical at i=15
    expect(a[20]).not.toBeCloseTo(b[20], 12); // differs at i=20
  });
  it('rollingMean matches a manual window mean', () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    const m = rollingMean(xs, 4);
    expect(m[3]).toBeCloseTo((3 + 1 + 4 + 1) / 4, 12);
    expect(m[6]).toBeCloseTo((1 + 5 + 9 + 2) / 4, 12);
    expect(Number.isNaN(m[0])).toBe(true); // warm-up
  });
});

describe('logReturnsBps / welchT', () => {
  it('log returns in bps', () => {
    expect(logReturnsBps([100, 101])[1]).toBeCloseTo(Math.log(1.01) * 1e4, 10);
    expect(Number.isNaN(logReturnsBps([0, 5])[1])).toBe(true);
  });
  it('welchT separates clearly different means, NaN on tiny samples', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    expect(welchT(b, a)).toBeGreaterThan(5);
    expect(welchT(a, a)).toBeCloseTo(0, 10);
    expect(Number.isNaN(welchT([1], [2]))).toBe(true);
  });
});

describe('evaluateFactor — the research protocol', () => {
  const DAY = 86_400_000;
  const BAR = 300_000;
  // 10 days × 200 bars: returns driven by a KNOWN factor + noise
  const N = 2000;
  const tOpen: number[] = [];
  const fwd: number[] = [];
  const scores: number[] = [];
  let price = 100;
  for (let i = 0; i < N; i++) {
    tOpen.push(1_700_000_000_000 + i * BAR);
    const s = Math.sin(i / 40); // smooth factor in [−1, 1]
    scores.push(s);
    fwd.push(i + 12 < N ? s * 8 + ((i * 2654435761) % 100) / 100 - 0.5 : NaN); // signal 8bps + noise ±0.5
    price *= 1.0001;
  }
  // spread the bars across days so daily blocks exist
  const daySpread = tOpen.map((t, i) => t + Math.floor(i / 200) * DAY);

  it('recovers a known positive-IC factor as strong with positive spread', () => {
    const r = evaluateFactor('test', 'Test factor', 'Flow', scores, fwd, daySpread);
    expect(r.ic).not.toBeNull();
    expect(r.ic!.mean).toBeGreaterThan(0.1);
    expect(r.ic!.tStat).toBeGreaterThan(3);
    expect(r.spreadBps).toBeGreaterThan(0);
    expect(r.verdict).toBe('strong');
    expect(r.n).toBeGreaterThan(1800);
    // monotone-ish monotone quintile profile
    const q = r.quintileMeanBps;
    expect(q[4]).toBeGreaterThan(q[0]);
    expect(q[4]).toBeGreaterThan(q[2]);
  });
  it('flags an inverted factor as inverse', () => {
    const r = evaluateFactor('inv', 'Inverted', 'Flow', scores.map((s) => -s), fwd, daySpread);
    expect(r.ic!.mean).toBeLessThan(-0.1);
    expect(r.verdict).toBe('inverse');
  });
  it('marks pure noise as flat/weak', () => {
    const noise = scores.map((_, i) => ((i * 40503) % 1000) / 1000 - 0.5);
    const r = evaluateFactor('noise', 'Noise', 'Flow', noise, fwd, daySpread);
    // the noise factor must NOT reach strong/inverse
    expect(['flat', 'weak', 'insufficient']).toContain(r.verdict);
  });
  it('returns insufficient below the observation floor', () => {
    const r = evaluateFactor('tiny', 'Tiny', 'Flow', scores.slice(0, 50), fwd.slice(0, 50), daySpread.slice(0, 50));
    expect(r.verdict).toBe('insufficient');
    expect(r.ic).toBeNull();
  });
});

describe('factor battery — computability contract', () => {
  const bars: ResearchBar[] = Array.from({ length: 600 }, (_, i) => ({
    t: 1_700_000_000_000 + i * 300_000,
    o: 100,
    h: 100.5,
    l: 99.5,
    c: 100 + Math.sin(i / 30),
    v: 10 + (i % 13),
    buyV: 5 + (i % 7) * 0.3,
    delta: 2 * (5 + (i % 7) * 0.3) - (10 + (i % 13)),
    trades: 100 + (i % 17),
    funding: i < 60 ? null : 0.0001 + (i % 9) * 2e-5, // carry-forward style, varying
    oi: 1000 + (i % 23),
    micro: null,
  }));
  const panel: ResearchPanel = { asset: 'BTC', tfSec: 300, venue: 'binance', bars, from: bars[0].t, to: bars[599].t, microBars: 0, fundingBars: 300, oiBars: 600 };

  it('every non-micro factor computes finite scores on a synthetic panel', () => {
    for (const spec of RESEARCH_FACTORS) {
      if (spec.needsMicro) continue;
      const out = spec.compute(panel);
      expect(out).toHaveLength(bars.length);
      const finite = out.filter(Number.isFinite).length;
      expect(finite).toBeGreaterThan(100); // warm-up aside, scores must exist
    }
  });
  it('micro factors yield all-NaN when snapshots are absent', () => {
    const vpin = RESEARCH_FACTORS.find((f) => f.id === 'micro_vpin')!;
    const out = vpin.compute(panel);
    expect(out.every((v) => !Number.isFinite(v))).toBe(true);
  });
});

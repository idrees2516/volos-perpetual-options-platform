import { describe, expect, it } from 'vitest';
import { alignSeries, correlationColor, divergingColor, legendTicks, pearson, sequentialColor, squarify } from './heatmap';

describe('divergingColor', () => {
  it('teal at positive extreme, rose at negative extreme', () => {
    expect(divergingColor(1, 1)).toBe('rgba(45, 212, 191, 1)');
    expect(divergingColor(-1, 1)).toBe('rgba(251, 113, 133, 1)');
  });
  it('neutral near zero', () => {
    const c = divergingColor(0, 1);
    expect(c).toBe('rgba(24, 28, 39, 1)');
  });
  it('clamps out-of-domain values and handles NaN', () => {
    expect(divergingColor(50, 10)).toBe(divergingColor(10, 10));
    expect(divergingColor(NaN, 10)).toBe('rgba(24, 28, 39, 1)');
  });
  it('correlationColor maps +1/-1/0', () => {
    expect(correlationColor(1)).toBe(divergingColor(1, 1));
    expect(correlationColor(-1)).toBe(divergingColor(-1, 1));
    expect(correlationColor(0)).toBe(divergingColor(0, 1));
  });
});

describe('sequentialColor', () => {
  it('endpoints and NaN handling', () => {
    const lo = sequentialColor(0);
    const hi = sequentialColor(1);
    expect(lo).not.toBe(hi);
    expect(sequentialColor(NaN)).toBe(sequentialColor(0));
    expect(sequentialColor(1.5)).toBe(sequentialColor(1));
  });
});

describe('legendTicks', () => {
  it('evenly spaced, monotone labels', () => {
    const t = legendTicks(-1, 1, 5);
    expect(t).toHaveLength(5);
    expect(t[0].label).toBe('-1.00');
    expect(t[4].label).toBe('1.00');
    expect(t.map((x) => x.t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
  it('degenerate domain collapses to a single tick', () => {
    expect(legendTicks(3, 3, 5)).toHaveLength(1);
    expect(legendTicks(NaN, 1, 5)).toHaveLength(1);
  });
});

describe('squarify', () => {
  const area = (rs: { x: number; y: number; w: number; h: number }[]) =>
    rs.reduce((s, r) => s + r.w * r.h, 0);

  it('covers exactly the whole rect with no overlap', () => {
    const items = Array.from({ length: 24 }, (_, i) => ({ value: 100 - 3 * i, data: i }));
    const rects = squarify(items, 800, 420);
    expect(rects).toHaveLength(24);
    expect(area(rects)).toBeCloseTo(800 * 420, -4);
    // pairwise no overlap (inclusive edges touching is fine)
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i];
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.w).toBeLessThanOrEqual(800 + 1e-6);
      expect(a.y + a.h).toBeLessThanOrEqual(420 + 1e-6);
      for (let j = i + 1; j < rects.length; j++) {
        const b = rects[j];
        const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ix <= 1e-6 || iy <= 1e-6).toBe(true);
      }
    }
  });

  it('largest item gets the largest rect and stays inside bounds', () => {
    const rects = squarify([{ value: 60, data: 'a' }, { value: 30, data: 'b' }, { value: 10, data: 'c' }], 100, 100);
    const byArea = [...rects].sort((x, y) => y.w * y.h - x.w * x.h);
    expect(byArea[0].data).toBe('a');
    expect(byArea[1].data).toBe('b');
    expect(byArea[2].data).toBe('c');
    expect(byArea[0].w * byArea[0].h).toBeGreaterThan(byArea[1].w * byArea[1].h);
  });

  it('degenerate inputs → empty layout', () => {
    expect(squarify([], 100, 100)).toEqual([]);
    expect(squarify([{ value: -5, data: 1 }], 100, 100)).toEqual([]);
    expect(squarify([{ value: 5, data: 1 }], 0, 100)).toEqual([]);
  });
});

describe('pearson / alignSeries', () => {
  it('perfect correlation = 1, inverse = −1, noise ≈ 0', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(pearson(xs, xs.map((x) => 2 * x + 1))).toBeCloseTo(1, 6);
    expect(pearson(xs, xs.map((x) => -x))).toBeCloseTo(-1, 6);
    const ys = [5, 1, 9, 2, 8, 3, 7, 4, 6, 2];
    expect(Math.abs(pearson(xs, ys)!) < 0.6).toBe(true);
  });
  it('too-short / constant series → null', () => {
    expect(pearson([1, 2], [2, 3])).toBeNull();
    expect(pearson([3, 3, 3, 3], [1, 2, 3, 4])).toBeNull();
  });
  it('alignSeries intersects on common timestamps', () => {
    const a = new Map([[1, 10], [2, 20], [3, 30]]);
    const b = new Map([[2, 25], [3, 35], [4, 45]]);
    const { ts, cols } = alignSeries([a, b]);
    expect(ts).toEqual([2, 3]);
    expect(cols).toEqual([[20, 30], [25, 35]]);
  });
});

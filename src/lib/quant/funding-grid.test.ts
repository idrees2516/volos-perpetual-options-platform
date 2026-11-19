import { describe, expect, it } from 'vitest';
import { assembleFundingGrid, aprPct, fundingBucket, type AssetPoints } from './funding-grid';

const H8 = 8 * 3_600_000;

function pts(symbol: string, rates: number[], t0 = Date.UTC(2026, 10, 1)): AssetPoints {
  return { symbol, points: rates.map((rate, i) => ({ ts: t0 + i * H8, rate })) };
}

describe('fundingBucket / aprPct', () => {
  it('buckets timestamps to 8h event starts', () => {
    expect(fundingBucket(0)).toBe(0);
    expect(fundingBucket(H8 - 1)).toBe(0);
    expect(fundingBucket(H8)).toBe(H8);
    expect(fundingBucket(H8 * 3 + 1234)).toBe(H8 * 3);
  });
  it('annualizes the 8h rate into APR percent', () => {
    expect(aprPct(0.0001)).toBeCloseTo(10.95, 1); // 1bp per 8h ≈ 10.95% APR
    expect(aprPct(0)).toBe(0);
    expect(aprPct(-0.0002)).toBeCloseTo(-21.9, 1);
  });
});

describe('assembleFundingGrid', () => {
  it('builds the union time axis and aligned cells', () => {
    const a = pts('BTC', [0.0001, 0.0002, 0.0003, -0.0001]); // t0..t0+3H8
    const b = pts('ETH', [0.0001, 0, 0.0005, 0.0004, 0.0002]); // t0..t0+4H8
    const g = assembleFundingGrid([a, b], 21);
    expect(g.assets).toEqual(['BTC', 'ETH']);
    expect(g.times.length).toBe(5);
    expect(g.aprPct[0]).toHaveLength(5); // BTC row: 4 obs + 1 null
    expect(g.aprPct[0][4]).toBeNull();
    expect(g.aprPct[1][4]).not.toBeNull();
  });

  it('drops assets with too few points but keeps the rest', () => {
    const good = pts('BTC', [0.0001, 0.0001, 0.0001, 0.0001]);
    const thin = pts('DOGE', [0.0001, 0.0002]);
    const g = assembleFundingGrid([good, thin], 21);
    expect(g.assets).toEqual(['BTC']);
    expect(g.rows).toHaveLength(1);
  });

  it('strides the time axis when events exceed maxCols', () => {
    const a = pts('BTC', Array.from({ length: 30 }, (_, i) => i * 1e-5));
    const g = assembleFundingGrid([a], 8);
    expect(g.times.length).toBeLessThanOrEqual(8);
    expect(g.times.length).toBeGreaterThanOrEqual(4); // stride 4 → 8 cols of 30
    expect(g.times).toEqual([...g.times].sort((x, y) => x - y));
    // every kept column still has the asset's value
    for (const t of g.times) expect(g.aprPct[0][g.times.indexOf(t)]).not.toBeNull();
  });

  it('row stats: latest / mean / min / max and census', () => {
    const a = pts('BTC', [0.0001, -0.0002, 0.0003, 0.0002]);
    const b = pts('ETH', [-0.0001, -0.0002, -0.0003, -0.0002]);
    const g = assembleFundingGrid([a, b], 21);
    const btc = g.rows.find((r) => r.symbol === 'BTC')!;
    expect(btc.latestAprPct).toBeCloseTo(aprPct(0.0002), 6);
    expect(btc.minAprPct).toBeCloseTo(aprPct(-0.0002), 6);
    expect(btc.maxAprPct).toBeCloseTo(aprPct(0.0003), 6);
    // hottest = most positive latest, coldest = most negative latest
    expect(g.stats.hottest?.symbol).toBe('BTC');
    expect(g.stats.coldest?.symbol).toBe('ETH');
    // latest APRs: BTC ≈ +21.9% (longsPay), ETH ≈ −21.9% (shortsPay)
    expect(g.stats.longsPay).toBe(1);
    expect(g.stats.shortsPay).toBe(1);
  });

  it('degenerate input → empty grid, not a crash', () => {
    const g = assembleFundingGrid([], 21);
    expect(g.assets).toEqual([]);
    expect(g.times).toEqual([]);
    expect(g.stats.hottest).toBeNull();
  });
});

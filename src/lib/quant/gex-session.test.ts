import { describe, expect, it } from 'vitest';
import { assembleGexSession, pickStrikes, type GexSample } from './gex-session';

function mk(ts: number, spot: number, hvl: number | null, gex: Array<[number, number]>): GexSample {
  return { ts, spot, hvl, gex };
}

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

describe('pickStrikes', () => {
  it('keeps the rows with the largest peak |netGex|, sorted ascending', () => {
    const s = [
      mk(NOW, 100, null, [
        [90, 5e6],
        [100, 40e6],
        [110, -2e6],
      ]),
      mk(NOW + 60_000, 101, null, [
        [95, 30e6],
        [100, 20e6],
      ]),
    ];
    expect(pickStrikes(s, 3)).toEqual([90, 95, 100]); // 100 (40M) + 95 (30M) + 90 (5M)
  });
  it('empty samples → no rows', () => {
    expect(pickStrikes([], 5)).toEqual([]);
  });
});

describe('assembleGexSession', () => {
  it('builds the grid with NaN holes and the spot / zero-gamma traces', () => {
    const s1 = mk(NOW, 100, 98, [
      [90, 1e6],
      [100, 2e6],
      [110, -3e6],
    ]);
    const s2 = mk(NOW + 60_000, 103, 105, [
      [100, 4e6],
      [110, -6e6],
    ]);
    const a = assembleGexSession([s1, s2], 240, 10, 10, NOW + 60_000);
    expect(a.strikes).toEqual([90, 100, 110]);
    expect(a.times).toEqual([NOW, NOW + 60_000]);
    expect(a.netGex[0]).toEqual([1e6, 2e6, -3e6]);
    expect(a.netGex[1][0]).toBeNaN(); // 90 not quoted in sample 2
    expect(a.spot).toEqual([100, 103]);
    expect(a.zeroGamma).toEqual([98, 105]);
    expect(a.maxAbs).toBe(6e6);
    expect(a.regime).toBe('short-gamma'); // latest total 4M − 6M < 0
  });

  it('honors the minutes window (old samples excluded)', () => {
    const old = mk(NOW - 6 * 3_600_000, 90, null, [[80, 1e6]]);
    const fresh = mk(NOW - 30_000, 100, null, [[100, 2e6]]);
    const a = assembleGexSession([old, fresh], 60, 10, 10, NOW);
    expect(a.times).toEqual([fresh.ts]);
    expect(a.strikes).toEqual([100]);
  });

  it('strides columns when samples exceed maxCols', () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(NOW + i * 60_000, 100 + i, null, [[100, i * 1e6]]));
    const a = assembleGexSession(many, 240, 10, 8, NOW + 30 * 60_000);
    expect(a.times.length).toBeLessThanOrEqual(8);
    expect(a.times).toEqual([...a.times].sort((x, y) => x - y));
    // latest sample always survives the stride → latestTotalGex = last pushed
    expect(a.latestTotalGex).toBe(29e6);
  });

  it('degenerate → empty grid, no crash', () => {
    const a = assembleGexSession([], 240, 10, 10, NOW);
    expect(a.strikes).toEqual([]);
    expect(a.times).toEqual([]);
    expect(a.maxAbs).toBe(0);
    expect(a.regime).toBeNull();
  });
});

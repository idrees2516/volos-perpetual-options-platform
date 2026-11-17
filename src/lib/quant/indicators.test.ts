import { describe, expect, it } from 'vitest';
import {
  adx,
  aroon,
  atr,
  bollinger,
  cvd,
  deltaPerBar,
  donchian,
  ema,
  historicalVol,
  ichimoku,
  keltner,
  macd,
  obv,
  rsi,
  sma,
  squeezeOn,
  stoch,
  supertrend,
  takerBuyRatio,
  trueRange,
  vwapAnchored,
  wma,
  type Bar,
} from './indicators';

// bars with a fixed shape for structural tests
const H = 86_400_000;
function mkBar(i: number, c: number, h = c + 1, l = c - 1, v = 100, tb = 50): Bar {
  return { ts: i * H, o: c, h, l, c, v, tb };
}

describe('moving averages', () => {
  it('sma — window mean with null warmup', () => {
    expect(sma([1, 2, 3, 4, 5], 2)).toEqual([null, 1.5, 2.5, 3.5, 4.5]);
    expect(sma([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5]);
  });
  it('ema — SMA seed then α-blend', () => {
    // seed at idx2 = (2+4+6)/3 = 4, α = 0.5: idx3 = 6, idx4 = 8
    expect(ema([2, 4, 6, 8, 10], 3)).toEqual([null, null, 4, 6, 8]);
  });
  it('wma — linearly increasing weights', () => {
    const r = wma([3, 4, 5, 6], 3);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeNull();
    expect(r[2]).toBeCloseTo(26 / 6, 12); // (3·1+4·2+5·3)/6
    expect(r[3]).toBeCloseTo(32 / 6, 12); // (4·1+5·2+6·3)/6
  });
});

describe('rsi — Wilder', () => {
  it('hand-computed mixed series', () => {
    const r = rsi([1, 2, 3, 4, 5, 4, 3, 2, 1], 5);
    expect(r.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(r[5]).toBeCloseTo(80, 10);
    expect(r[6]).toBeCloseTo(64, 10);
    expect(r[7]).toBeCloseTo(51.2, 10);
    expect(r[8]).toBeCloseTo(40.96, 10);
  });
  it('monotone extremes pin to 100 / 0', () => {
    const up = rsi(Array.from({ length: 16 }, (_, i) => i + 1), 14);
    expect(up[14]).toBe(100);
    expect(up[15]).toBe(100);
    const down = rsi(Array.from({ length: 16 }, (_, i) => 16 - i), 14);
    expect(down[14]).toBe(0);
  });
});

describe('macd', () => {
  it('constant series → exactly zero after warmup, null before', () => {
    const closes = new Array(40).fill(5);
    const m = macd(closes, 12, 26, 9);
    expect(m.line[24]).toBeNull();
    expect(m.line[25]).toBe(0);
    expect(m.line[39]).toBe(0);
    expect(m.signal[39]).toBe(0);
    expect(m.hist[39]).toBe(0);
    expect(m.hist[25]).toBeNull(); // signal needs its own warmup
  });
  it('convex series → positive macd line and histogram', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * i);
    const m = macd(closes, 12, 26, 9);
    expect(m.line[40]).toBeGreaterThan(0);
    expect(m.hist[40]).toBeGreaterThan(0);
  });
});

describe('stoch', () => {
  const bars: Bar[] = [
    { ts: 0, o: 9.5, h: 11, l: 9, c: 10, v: 1, tb: 0.5 },
    { ts: H, o: 10.5, h: 12, l: 10, c: 11, v: 1, tb: 0.5 },
    { ts: 2 * H, o: 11.5, h: 13, l: 11, c: 12, v: 1, tb: 0.5 },
    { ts: 3 * H, o: 11.5, h: 12, l: 11, c: 11, v: 1, tb: 0.5 },
    { ts: 4 * H, o: 10.5, h: 11, l: 10, c: 10, v: 1, tb: 0.5 },
  ];
  it('raw %K (kSmooth=1) hand-computed, %D = 2-bar SMA', () => {
    const s = stoch(bars, 3, 1, 2);
    expect(s.k[0]).toBeNull();
    expect(s.k[1]).toBeNull();
    expect(s.k[2]).toBeCloseTo(75, 10); // (12−9)/(13−9)
    expect(s.k[3]).toBeCloseTo(100 / 3, 10); // (11−10)/(13−10)
    expect(s.k[4]).toBeCloseTo(0, 10);
    expect(s.d[3]).toBeCloseTo((75 + 100 / 3) / 2, 10);
    expect(s.d[4]).toBeCloseTo((100 / 3 + 0) / 2, 10);
  });
  it('default 3/3 smoothing delays warmup by exactly its span', () => {
    const s = stoch(bars, 3, 3, 3);
    expect(s.k.slice(0, 4).every((v) => v === null)).toBe(true);
    expect(s.k[4]).toBeCloseTo((75 + 100 / 3 + 0) / 3, 10);
  });
});

describe('true range + atr — Wilder', () => {
  const bars: Bar[] = [
    { ts: 0, o: 9, h: 10, l: 8, c: 9, v: 1, tb: 0.5 },
    { ts: H, o: 10, h: 12, l: 9, c: 11, v: 1, tb: 0.5 },
    { ts: 2 * H, o: 11, h: 11, l: 10, c: 10, v: 1, tb: 0.5 },
    { ts: 3 * H, o: 11, h: 13, l: 12, c: 13, v: 1, tb: 0.5 },
  ];
  it('true range respects gaps vs previous close', () => {
    expect(trueRange(bars)).toEqual([2, 3, 1, 3]);
  });
  it('atr seeds with the mean then Wilder-smooths', () => {
    const a = atr(bars, 3);
    expect(a[2]).toBeCloseTo(2, 12);
    expect(a[3]).toBeCloseTo((2 * 2 + 3) / 3, 12);
  });
});

describe('adx / dmi', () => {
  it('monotone uptrend → +DI dominates, ADX defined after double warmup', () => {
    const bars = Array.from({ length: 40 }, (_, i) => mkBar(i, i + 0.8, i + 1, i, 100, 60));
    const a = adx(bars, 14);
    expect(a.plusDI[39]).not.toBeNull();
    expect(a.plusDI[39]).toBeGreaterThan(a.minusDI[39] as number);
    expect(a.minusDI[39]).toBeCloseTo(0, 10);
    expect(a.adx[39]).not.toBeNull();
    expect(a.adx[39]).toBeGreaterThan(0);
  });
});

describe('aroon', () => {
  it('bars since the period extreme, as percent', () => {
    const highs = [1, 2, 3, 4, 3, 2, 1, 5, 4, 3];
    const bars = highs.map((h, i) => mkBar(i, h - 0.1, h, h - 1));
    const a = aroon(bars, 3);
    expect(a.up[3]).toBe(100); // high made THIS bar
    expect(a.down[3]).toBeCloseTo(0, 10); // low 3 bars ago
    expect(a.up[7]).toBe(100); // new high this bar
    expect(a.down[7]).toBeCloseTo(200 / 3, 10); // low 1 bar back → (3−1)/3
  });
});

describe('supertrend', () => {
  it('trails the trend and flips with the reversal', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 30; i++) bars.push(mkBar(i, 10 + i * 0.5, 10.5 + i * 0.5, 9.5 + i * 0.5));
    for (let i = 0; i < 30; i++) bars.push(mkBar(30 + i, 24.5 - i * 0.5, 25 - i * 0.5, 24 - i * 0.5));
    const st = supertrend(bars, 10, 3);
    expect(st.dir[14]).toBe(1); // up-leg
    expect(st.value[14]).toBeLessThan(bars[14].c); // support below price
    expect(st.dir[59]).toBe(-1); // down-leg
    expect(st.value[59]).toBeGreaterThan(bars[59].c); // resistance above
    // warmup is null until the first ATR
    expect(st.dir[4]).toBeNull();
  });
});

describe('ichimoku', () => {
  it('midpoints of the conv/base/spanB windows', () => {
    const bars = Array.from({ length: 12 }, (_, i) => mkBar(i, i + 0.5, i + 1, i));
    const ic = ichimoku(bars, 3, 4, 5);
    expect(ic.tenkan[1]).toBeNull();
    expect(ic.tenkan[2]).toBeCloseTo(1.5, 12); // (3+0)/2
    expect(ic.kijun[3]).toBeCloseTo(2, 12); // (4+0)/2
    expect(ic.senkouA[3]).toBeCloseTo(2.25, 12); // (tenkan3 2.5 + kijun3 2)/2
    expect(ic.senkouB[4]).toBeCloseTo(2.5, 12); // (5+0)/2
    expect(ic.chikou[0]).toBeCloseTo(bars[0].c, 12); // close plotted 4 back
    expect(ic.chikou[8]).toBeNull(); // not enough future bars
  });
});

describe('bollinger', () => {
  it('hand-computed band geometry, width and %B', () => {
    const b = bollinger([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, 2);
    expect(b.mid[2]).toBe(2);
    const s = Math.sqrt(2 / 3); // population sd of [1,2,3]
    expect(b.upper[2]).toBeCloseTo(2 + 2 * s, 12);
    expect(b.lower[2]).toBeCloseTo(2 - 2 * s, 12);
    expect(b.widthPct[2]).toBeCloseTo((100 * 4 * s) / 2, 8);
    expect(b.pctB[2]).toBeCloseTo(0.5 + 1 / (4 * s), 8); // close=3 sits above mid
    expect(b.mid[1]).toBeNull();
  });
  it('constant series collapses width; %B undefined when bands collapse', () => {
    const b = bollinger(new Array(30).fill(7), 20, 2);
    expect(b.widthPct[29]).toBe(0);
    expect(b.pctB[29]).toBeNull(); // guard: zero-width band → no position
  });
});

describe('keltner + donchian + squeeze', () => {
  it('keltner = EMA ± mult·ATR', () => {
    const bars = Array.from({ length: 24 }, (_, i) => mkBar(i, i % 2 === 0 ? 10 : 10.1, (i % 2 === 0 ? 10 : 10.1) + 1, (i % 2 === 0 ? 10 : 10.1) - 1));
    const k = keltner(bars, 20, 2, 10);
    // TR = 2 on every bar → ATR = 2 → band width = 2·mult·atr = 8
    const mid = k.mid[23] as number;
    expect(k.upper[23]).toBeCloseTo(mid + 4, 8);
    expect(k.lower[23]).toBeCloseTo(mid - 4, 8);
    expect((k.upper[23] as number) - (k.lower[23] as number)).toBeCloseTo(8, 8);
  });
  it('donchian = rolling hi/lo with mid', () => {
    const bars = [1, 2, 3, 4, 3, 2, 1, 5, 4, 3].map((h, i) => mkBar(i, h - 0.1, h, h - 1));
    const d = donchian(bars, 3);
    expect(d.upper[3]).toBe(4); // max h over bars 1–3
    expect(d.lower[3]).toBeCloseTo(1, 12); // min l over bars 1–3
    expect(d.mid[3]).toBeCloseTo(2.5, 12);
  });
  it('squeeze ON when Bollinger sits inside Keltner', () => {
    // tight closes (sd=0.05) but wide 2.0 intraday ranges (ATR=2) → BB ≪ KC
    const bars = Array.from({ length: 24 }, (_, i) => mkBar(i, i % 2 === 0 ? 10 : 10.1, (i % 2 === 0 ? 10 : 10.1) + 1, (i % 2 === 0 ? 10 : 10.1) - 1));
    const sq = squeezeOn(bars);
    expect(sq[19]).toBe(true);
    expect(sq[10]).toBeNull(); // warmup
  });
});

describe('historicalVol', () => {
  it('exact alternating ±g log returns with custom annualizer', () => {
    const closes = [100, 110, 100, 110, 100];
    const hv = historicalVol(closes, 4, 2);
    expect(hv[3]).toBeNull();
    expect(hv[4]).toBeCloseTo(Math.log(1.1) * Math.SQRT2, 10);
  });
  it('flat series → zero realized vol', () => {
    const hv = historicalVol(new Array(10).fill(5), 4, 100);
    expect(hv[9]).toBe(0);
  });
});

describe('volume / orderflow family', () => {
  const bars: Bar[] = [
    { ts: 0, o: 10, h: 10, l: 9, c: 10, v: 100, tb: 60 },
    { ts: H, o: 11, h: 11, l: 10, c: 11, v: 100, tb: 40 },
    { ts: 2 * H, o: 10, h: 10, l: 9, c: 10, v: 100, tb: 70 },
    { ts: 3 * H, o: 10, h: 10, l: 9, c: 10, v: 100, tb: 50 },
  ];
  it('obv follows close direction', () => {
    expect(obv(bars)).toEqual([0, 100, 0, 0]);
  });
  it('delta, cvd and taker ratio', () => {
    expect(deltaPerBar(bars)).toEqual([20, -20, 40, 0]);
    expect(cvd(bars)).toEqual([20, 0, 40, 40]);
    expect(takerBuyRatio(bars)).toEqual([0.6, 0.4, 0.7, 0.5]);
  });
  it('vwap anchors at UTC midnight and resets', () => {
    const v = vwapAnchored([
      { ts: 0, o: 9, h: 10, l: 8, c: 9, v: 100, tb: 50 },
      { ts: 3_600_000, o: 9.5, h: 11, l: 9, c: 10, v: 100, tb: 50 }, // same UTC day
      { ts: 86_400_000, o: 10.5, h: 12, l: 10, c: 11, v: 50, tb: 25 }, // next day
    ]);
    expect(v[0]).toBeCloseTo(9, 12); // (10+8+9)/3
    expect(v[1]).toBeCloseTo(9.5, 12); // (900+1000)/200
    expect(v[2]).toBeCloseTo(11, 12); // new day → reset
  });
});

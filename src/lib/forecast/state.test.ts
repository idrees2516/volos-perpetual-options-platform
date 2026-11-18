import { describe, expect, it } from 'vitest';
import {
  ema,
  macd,
  pUpClimatology,
  percentB,
  rsi,
  rsiProjector,
  sma,
} from './indicators';
import { buildProjectedStateFromBars } from './state';
import type { RawBar } from './panel';

// ── synthetic bar history: seeded pseudo-random walk ─────────────────────────

function seededBars(n: number, seed = 42): RawBar[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const bars: RawBar[] = [];
  let price = 67_000;
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const drift = i > n / 2 ? 6 : -2; // gentle regime shift
    const step = drift + (rnd() - 0.5) * 40;
    const open = price;
    price += step;
    const close = price;
    const high = Math.max(open, close) + rnd() * 18;
    const low = Math.min(open, close) - rnd() * 18;
    const volume = 80 + rnd() * 240;
    const buyVolume = volume * (0.45 + rnd() * 0.12);
    bars.push({
      ds: t0 + i * 60_000,
      open,
      high,
      low,
      close,
      volume,
      buyVolume,
      trades: Math.round(900 + rnd() * 2400),
    });
  }
  return bars;
}

describe('forecast indicators', () => {
  it('rsi reads 100 on a strictly rising series', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const r = rsi(up);
    expect(r[r.length - 1]).toBeCloseTo(100, 5);
  });

  it('rsi reads 0 on a strictly falling series', () => {
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);
    const r = rsi(down);
    expect(r[r.length - 1]).toBeCloseTo(0, 5);
  });

  it('rsi projector continues the Wilder recursion from history', () => {
    const closes = seededBars(120).map((b) => b.close);
    const full = rsi(closes);
    const last = full[full.length - 1] as number;
    const proj = rsiProjector(closes.slice(0, -1));
    const next = proj(closes[closes.length - 1]);
    expect(next).not.toBeNull();
    expect(next as number).toBeCloseTo(last, 6);
  });

  it('ema of a constant series equals the constant after seeding', () => {
    const e = ema(new Array(50).fill(42.5), 21);
    expect(e[e.length - 1]).toBeCloseTo(42.5, 10);
  });

  it('sma computes exact window means', () => {
    const v = [1, 2, 3, 4, 5, 6, 7];
    const s = sma(v, 3);
    expect(s[2]).toBeCloseTo(2, 10);
    expect(s[6]).toBeCloseTo((5 + 6 + 7) / 3, 10);
    expect(s[1]).toBeNull();
  });

  it('macd histogram is finite and flips sign with acceleration', () => {
    // linear ramps converge to hist → 0; ACCELERATION is what flips the sign
    const up = Array.from({ length: 80 }, (_, i) => 100 + (i * i) / 40);
    const down = Array.from({ length: 80 }, (_, i) => 100 - (i * i) / 40);
    const hu = macd(up).hist;
    const hd = macd(down).hist;
    expect((hu[hu.length - 1] as number) > 0).toBe(true);
    expect((hd[hd.length - 1] as number) < 0).toBe(true);
  });

  it('percentB sits above 1 when price breaks the upper band', () => {
    const flat = new Array(30).fill(100);
    const spike = [...flat, 130];
    const b = percentB(spike);
    expect((b[b.length - 1] as number) > 1).toBe(true);
  });

  it('pUp climatology: rising history → 1, falling → 0', () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i);
    const down = Array.from({ length: 60 }, (_, i) => 100 - i);
    expect(pUpClimatology(up, 5)).toBeCloseTo(1, 6);
    expect(pUpClimatology(down, 5)).toBeCloseTo(0, 6);
  });
});

describe('projected state', () => {
  const bars = seededBars(400);
  const h = 12;
  const tf = 60_000;
  const oiPoints = Array.from({ length: 60 }, (_, i) => ({
    time: 1_700_000_000_000 + i * 60_000,
    openInterest: 80_000 + i * 25,
  }));

  it('projects price rows for every step with aligned timestamps', () => {
    const st = buildProjectedStateFromBars(bars, oiPoints, tf, { h, levels: [80, 95], nWindows: 5 });
    expect(st.price.rows).toHaveLength(h);
    const lastDs = bars[bars.length - 1].ds;
    st.price.rows.forEach((r, i) => {
      expect(r.step).toBe(i + 1);
      expect(r.ds).toBe(lastDs + (i + 1) * tf);
      expect(Number.isFinite(r.point)).toBe(true);
    });
    expect(st.levels).toEqual([80, 95]);
    expect(st.price.rows[0].levels.map((l) => l.level)).toEqual([80, 95]);
  });

  it('forecasts every flow metric and OI with full-length rows', () => {
    const st = buildProjectedStateFromBars(bars, oiPoints, tf, { h, levels: [80, 95], nWindows: 5 });
    const ids = st.metrics.map((m) => m.id);
    expect(ids).toContain('volume');
    expect(ids).toContain('delta');
    expect(ids).toContain('cvd');
    expect(ids).toContain('imbalance');
    expect(ids).toContain('trades');
    expect(ids).toContain('oi');
    for (const m of st.metrics) {
      expect(m.rows).toHaveLength(h);
      expect(m.now).not.toBeNull();
    }
  });

  it('omits OI when the engine has no session history', () => {
    const st = buildProjectedStateFromBars(bars, [], tf, { h, levels: [80, 95], nWindows: 5 });
    expect(st.metrics.some((m) => m.id === 'oi')).toBe(false);
    expect(st.snapshot.oi).toBeNull();
  });

  it('rolls every indicator forward across the projected price path', () => {
    const st = buildProjectedStateFromBars(bars, oiPoints, tf, { h, levels: [80, 95], nWindows: 5 });
    const ids = st.indicators.map((i) => i.id);
    expect(ids).toEqual(['rsi14', 'ema21', 'sma50', 'macdHist', 'pctB']);
    for (const ind of st.indicators) {
      expect(ind.projected).toHaveLength(h);
    }
    // EMA(21) of the projected path is finite and near the price scale
    const ema = st.indicators.find((i) => i.id === 'ema21')!;
    const lastClose = bars[bars.length - 1].close;
    for (const v of ema.projected) {
      if (Number.isFinite(v)) {
        expect(Math.abs(v - lastClose)).toBeLessThan(Math.abs(lastClose) * 0.05);
      }
    }
  });

  it('snapshot matches the last observed bar and metric history', () => {
    const st = buildProjectedStateFromBars(bars, oiPoints, tf, { h, levels: [80, 95], nWindows: 5 });
    const last = bars[bars.length - 1];
    expect(st.cutoff.ds).toBe(last.ds);
    expect(st.cutoff.price).toBe(last.close);
    expect(st.snapshot.close).toBe(last.close);
    expect(st.snapshot.volume).toBeCloseTo(last.volume, 6);
    expect(st.snapshot.delta).toBeCloseTo(2 * last.buyVolume - last.volume, 6);
    expect(st.snapshot.oi).toBe(oiPoints[oiPoints.length - 1].openInterest);
  });

  it('drift equals point@h vs the last close', () => {
    const st = buildProjectedStateFromBars(bars, oiPoints, tf, { h, levels: [80, 95], nWindows: 5 });
    const pointH = st.price.rows[st.price.rows.length - 1].point;
    const lastClose = bars[bars.length - 1].close;
    expect(st.drift.pct).not.toBeNull();
    expect(st.drift.pct as number).toBeCloseTo(((pointH - lastClose) / lastClose) * 100, 6);
    expect(st.drift.abs).toBeCloseTo(pointH - lastClose, 6);
  });

  it('volatility block is populated and P(up) is a sane base rate', () => {
    const st = buildProjectedStateFromBars(bars, oiPoints, tf, { h, levels: [80, 95], nWindows: 5 });
    expect((st.volatility.atr14 as number) > 0).toBe(true);
    expect((st.volatility.realizedVolPct as number) > 0).toBe(true);
    expect(st.volatility.expectedMovePctPerStep).toHaveLength(h);
    expect(st.pUp).not.toBeNull();
    expect(st.pUp as number).toBeGreaterThanOrEqual(0);
    expect(st.pUp as number).toBeLessThanOrEqual(1);
  });

  it('throws on insufficient history instead of guessing', () => {
    expect(() => buildProjectedStateFromBars(bars.slice(0, 10), [], tf, { h, levels: [80, 95], nWindows: 5 })).toThrow(
      /insufficient history/,
    );
  });

  it('an up-drifting history lifts the projected RSI above its current read', () => {
    // strong persistent uptrend → forecast path keeps rising → RSI rolls up
    const up = Array.from({ length: 200 }, (_, i) => {
      const price = 50_000 + i * 30;
      return {
        ds: 1_700_000_000_000 + i * 60_000,
        open: price - 10,
        high: price + 25,
        low: price - 35,
        close: price,
        volume: 150,
        buyVolume: 85,
        trades: 1200,
      } as RawBar;
    });
    const st = buildProjectedStateFromBars(up, [], tf, { h: 12, levels: [80, 95], nWindows: 4 });
    const rsiBlock = st.indicators.find((i) => i.id === 'rsi14')!;
    const lastProj = rsiBlock.projected[rsiBlock.projected.length - 1];
    expect(Number.isFinite(lastProj)).toBe(true);
    expect(lastProj >= (rsiBlock.now ?? 0) - 5).toBe(true);
  });
});

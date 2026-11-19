// ─────────────────────────────────────────────────────────────────────────────
// viz tests — transforms, series loaders (synthetic bars) and the model
// runner: the universal chart/model layer under test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { applyTransform, rollingEnvelope, histogramOf, extentsOf, returnsOf, meanOf, sdOf } from './transforms';
import { SERIES_SPECS, SERIES_MAP, loadVizSeries } from './series';
import { MODEL_SPECS, MODEL_MAP, runModel } from './modelrunner';
import type { VizPoint } from './types';
import type { RawBar } from '@/lib/forecast/panel';

// ── synthetic bar history (deterministic, hoisted for the module mock) ───────

const synthBars = vi.hoisted(() => (n: number) => {
  const bars: Array<{ ds: number; open: number; high: number; low: number; close: number; volume: number; buyVolume: number; trades: number }> = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const ret = Math.sin(i / 7) * 0.01 + ((i * 37) % 11 - 5) * 0.001;
    const o = price;
    price = Math.max(1, price * (1 + ret));
    const h = Math.max(o, price) * 1.002;
    const l = Math.min(o, price) * 0.998;
    const volume = 100 + ((i * 53) % 90);
    bars.push({ ds: 1_700_000_000_000 + i * 1_800_000, open: o, high: h, low: l, close: price, volume, buyVolume: volume * (0.4 + 0.2 * Math.sin(i / 5)), trades: 10 + (i % 30) });
  }
  return bars;
});

// every loader that rides loadMergedBars gets the synthetic history
vi.mock('@/lib/forecast/panel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/forecast/panel')>();
  return {
    ...mod,
    loadMergedBars: (async () =>
      ({
        bars: synthBars(400),
        klinesBars: 400,
        engineCount: 0,
        klineError: null,
        klineSource: 'store',
        liveTailFrom: null,
        engineCandles: [],
        oiPoints: [],
      })) as never,
  };
});

const bars = synthBars(400) as RawBar[];
const pts: VizPoint[] = bars.map((b) => ({ t: b.ds, v: b.close }));

// points families that must resolve on the synthetic history (forecast/model
// families may need richer history than the stub provides)
const CORE_POINT_IDS = SERIES_SPECS.filter((s) => ['price', 'indicators', 'flow'].includes(s.group)).map((s) => s.id);

describe('viz transforms', () => {
  it('none is identity', () => {
    expect(applyTransform(pts, 'none')).toBe(pts);
  });

  it('log drops non-positive values and log-transforms', () => {
    const mixed: VizPoint[] = [
      { t: 1, v: 1 },
      { t: 2, v: Math.E },
      { t: 3, v: -5 },
    ];
    const out = applyTransform(mixed, 'log');
    expect(out).toHaveLength(2);
    expect(out[0].v).toBeCloseTo(0);
    expect(out[1].v).toBeCloseTo(1);
  });

  it('diff/pct shrink by one and carry bands', () => {
    const src: VizPoint[] = [
      { t: 1, v: 10, lo: 9, hi: 11 },
      { t: 2, v: 12, lo: 11, hi: 13 },
    ];
    const d = applyTransform(src, 'diff');
    expect(d).toHaveLength(1);
    expect(d[0].v).toBe(2);
    expect(d[0].lo).toBe(2);
    expect(d[0].hi).toBe(2);
    const p = applyTransform(src, 'pct');
    expect(p[0].v).toBeCloseTo(20);
  });

  it('zscore standardizes to ~0 mean / ~1 σ', () => {
    const out = applyTransform(pts, 'zscore');
    expect(Math.abs(meanOf(out.map((p) => p.v)))).toBeLessThan(1e-9);
    expect(Math.abs(sdOf(out.map((p) => p.v)) - 1)).toBeLessThan(1e-9);
  });

  it('minmax maps into 0..1', () => {
    const out = applyTransform(pts, 'minmax');
    const vs = out.map((p) => p.v);
    expect(Math.min(...vs)).toBeCloseTo(0);
    expect(Math.max(...vs)).toBeCloseTo(1);
  });

  it('ema smooths (first value unchanged, later finite)', () => {
    const out = applyTransform(pts, 'ema');
    expect(out[0].v).toBe(pts[0].v);
    for (const p of out) expect(Number.isFinite(p.v)).toBe(true);
  });

  it('cum sums', () => {
    const src: VizPoint[] = [
      { t: 1, v: 1 },
      { t: 2, v: 2 },
      { t: 3, v: 3 },
    ];
    const out = applyTransform(src, 'cum');
    expect(out.map((p) => p.v)).toEqual([1, 3, 6]);
  });

  it('rollingEnvelope adds lo/hi around the line', () => {
    const out = rollingEnvelope(pts, 24);
    expect(out).toHaveLength(pts.length);
    expect(out.every((p) => p.lo! <= p.v && p.hi! >= p.v)).toBe(true);
  });

  it('histogramOf bins all finite values', () => {
    const bins = histogramOf(pts.map((p) => p.v), 12);
    expect(bins).toHaveLength(12);
    const total = bins.reduce((a, b) => a + b.count, 0);
    expect(total).toBe(pts.length);
  });

  it('extentsOf spans values + bands with padding', () => {
    const e = extentsOf([pts]);
    expect(e.lo).toBeLessThan(Math.min(...pts.map((p) => p.v)));
    expect(e.hi).toBeGreaterThan(Math.max(...pts.map((p) => p.v)));
    expect(extentsOf([])).toEqual({ lo: 0, hi: 1 });
  });

  it('returnsOf uses log returns for positive series, diffs otherwise', () => {
    const pos = [100, 110, 121];
    expect(returnsOf(pos)).toEqual([Math.log(1.1), Math.log(1.1)]);
    expect(returnsOf([1, -1, 1])).toEqual([-2, 2]);
  });
});

describe('viz series registry', () => {
  it('every spec id is unique with a group and tags', () => {
    const ids = SERIES_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SERIES_SPECS) {
      expect(s.group).toBeTruthy();
      expect(s.tags.length).toBeGreaterThan(0);
    }
  });

  it('loads every core points family on the synthetic history', async () => {
    for (const id of CORE_POINT_IDS) {
      const vs = await loadVizSeries(id, 'BTC', 1_800_000, 400);
      expect(vs.kind).toBe('points');
      expect(vs.points!.length).toBeGreaterThan(30);
      expect(vs.label).toBeTruthy();
    }
  });

  it('close series carries candle fields and a domain', async () => {
    const vs = await loadVizSeries('close', 'BTC', 1_800_000, 400);
    expect(vs.points![0].o).toBeTypeOf('number');
    expect(vs.points![0].h).toBeGreaterThan(0);
    expect(vs.domain?.lo).toBe(0);
  });

  it('buyShare stays within its hard domain', async () => {
    const vs = await loadVizSeries('buyShare', 'BTC', 1_800_000, 400);
    for (const p of vs.points!) {
      if (Number.isFinite(p.v)) expect(p.v).toBeGreaterThanOrEqual(0);
      if (Number.isFinite(p.v)) expect(p.v).toBeLessThanOrEqual(1);
    }
    expect(vs.domain).toEqual({ lo: 0, hi: 1 });
  });

  it('unknown ids throw', async () => {
    await expect(loadVizSeries('nope', 'BTC', 1_800_000)).rejects.toThrow(/unknown series/);
    expect(SERIES_MAP.get('nope')).toBeUndefined();
  });
});

describe('viz model runner', () => {
  it('every spec has outputs and consumedBy; stats models take a series', () => {
    expect(MODEL_SPECS.length).toBeGreaterThanOrEqual(11);
    for (const m of MODEL_SPECS) {
      expect(m.id).toBeTruthy();
      expect(m.outputs.length).toBeGreaterThan(0);
      expect(m.consumedBy.length).toBeGreaterThan(0);
      if (m.family === 'pricing') expect(m.usesSeries).toBe(false);
      else expect(m.usesSeries).toBe(true);
    }
  });

  it('runs GARCH on a synthetic series with σ verdicts + outputs', async () => {
    const r = await runModel({ model: 'garch', asset: 'BTC', tf: 1_800_000, seriesId: 'close', params: { h: 12 } });
    expect(r.model).toBe('garch');
    expect(r.verdicts.length).toBeGreaterThanOrEqual(4);
    expect(r.verdicts.some((v) => v.label === 'σ now')).toBe(true);
    expect(r.outputs.length).toBe(2);
    expect(r.outputs[0].points!.length).toBeGreaterThan(20);
  });

  it('runs the pricing models without any series', async () => {
    const bs = await runModel({ model: 'bs-price', asset: 'BTC', tf: 1_800_000, params: { S: 100, K: 110, T: 0.25, sigma: 0.5, call: 'call' } });
    expect(bs.verdicts[0].value).toBeTypeOf('string');
    expect(bs.outputs.length).toBe(2);
    expect(bs.outputs.every((o) => (o.points?.length ?? 0) > 30)).toBe(true);

    const hest = await runModel({ model: 'heston', asset: 'BTC', tf: 1_800_000, params: {} });
    expect(hest.outputs[0].points!.length).toBe(25);
    const sabr = await runModel({ model: 'sabr', asset: 'BTC', tf: 1_800_000, params: {} });
    expect(sabr.outputs[0].points!.length).toBe(25);
  });

  it('conformal fan widens with horizon and brackets the level', async () => {
    const r = await runModel({ model: 'conformal', asset: 'BTC', tf: 1_800_000, seriesId: 'close', params: { h: 24, level: 80 } });
    const pts2 = r.outputs[0].points!;
    expect(pts2.length).toBe(25);
    expect(pts2.at(-1)!.hi!).toBeGreaterThan(pts2.at(-1)!.lo!);
    expect(pts2.at(-1)!.hi! - pts2.at(-1)!.lo!).toBeGreaterThan(pts2[1].hi! - pts2[1].lo!);
  });

  it('rejects unknown models', async () => {
    await expect(runModel({ model: 'nope', asset: 'BTC', tf: 1_800_000 })).rejects.toThrow(/unknown model/);
    expect(MODEL_MAP.has('nope')).toBe(false);
  });
});

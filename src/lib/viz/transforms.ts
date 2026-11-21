// ─────────────────────────────────────────────────────────────────────────────
// VIZ · transforms — pure per-series transforms any chart can apply.
//
// Every transform maps VizPoint[] → VizPoint[] preserving timestamps; band
// fields are carried when they survive the transform. `rollingEnvelope`
// derives a ±σ band for plain series (the band chart kind works on ANY
// series), and `histogramOf` bins a window for the histogram kind.
// ─────────────────────────────────────────────────────────────────────────────

import type { VizPoint, VizTransform } from './types';

const finite = (v: number | undefined | null): v is number => Number.isFinite(v as number);

/** mean of finite values */
export function meanOf(xs: number[]): number {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (Number.isFinite(x)) {
      s += x;
      n++;
    }
  }
  return n ? s / n : 0;
}

/** population σ of finite values (0 when degenerate) */
export function sdOf(xs: number[]): number {
  const m = meanOf(xs);
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (Number.isFinite(x)) {
      s += (x - m) ** 2;
      n++;
    }
  }
  return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
}

/**
 * Apply a transform to a point series. Timestamps preserved; the transform
 * may shrink the window (diff/pct lose the first point, log drops non-positive
 * values, zscore/minmax need ≥2 points). Band fields survive when both sides
 * are finite after the transform.
 */
export function applyTransform(points: VizPoint[], transform: VizTransform): VizPoint[] {
  const vals = points.map((p) => p.v);
  switch (transform) {
    case 'none':
      return points;
    case 'log': {
      const out: VizPoint[] = [];
      for (const p of points) {
        if (p.v > 0) out.push({ ...p, v: Math.log(p.v), lo: finite(p.lo) && p.lo > 0 ? Math.log(p.lo) : undefined, hi: finite(p.hi) && p.hi > 0 ? Math.log(p.hi) : undefined });
      }
      return out;
    }
    case 'diff': {
      const out: VizPoint[] = [];
      for (let i = 1; i < points.length; i++) {
        const p = points[i];
        const q = points[i - 1];
        out.push({ t: p.t, v: p.v - q.v, lo: finite(p.lo) && finite(q.lo) ? p.lo! - q.lo! : undefined, hi: finite(p.hi) && finite(q.hi) ? p.hi! - q.hi! : undefined });
      }
      return out;
    }
    case 'pct': {
      const out: VizPoint[] = [];
      for (let i = 1; i < points.length; i++) {
        const p = points[i];
        const q = points[i - 1];
        if (q.v !== 0) {
          out.push({ t: p.t, v: ((p.v - q.v) / Math.abs(q.v)) * 100, lo: finite(p.lo) && q.v !== 0 ? ((p.lo! - q.v) / Math.abs(q.v)) * 100 : undefined, hi: finite(p.hi) && q.v !== 0 ? ((p.hi! - q.v) / Math.abs(q.v)) * 100 : undefined });
        }
      }
      return out;
    }
    case 'zscore': {
      if (vals.length < 2) return points;
      const m = meanOf(vals);
      const sd = sdOf(vals) || 1e-9;
      return points.map((p) => ({ ...p, v: (p.v - m) / sd, lo: finite(p.lo) ? (p.lo! - m) / sd : undefined, hi: finite(p.hi) ? (p.hi! - m) / sd : undefined }));
    }
    case 'minmax': {
      if (vals.length < 2) return points;
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of vals) {
        if (!Number.isFinite(v)) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const span = hi - lo || 1e-9;
      return points.map((p) => ({ ...p, v: (p.v - lo) / span, lo: finite(p.lo) ? (p.lo! - lo) / span : undefined, hi: finite(p.hi) ? (p.hi! - lo) / span : undefined }));
    }
    case 'ema': {
      const a = 2 / 21;
      let e = vals[0] ?? 0;
      const out: VizPoint[] = [];
      for (const p of points) {
        e = Number.isFinite(p.v) ? p.v * a + e * (1 - a) : e;
        out.push({ ...p, v: e });
      }
      return out;
    }
    case 'cum': {
      let s = 0;
      return points.map((p) => {
        if (Number.isFinite(p.v)) s += p.v;
        return { ...p, v: s };
      });
    }
    default:
      return points;
  }
}

/** rolling ±σ envelope around the point line (the band kind on ANY series). */
export function rollingEnvelope(points: VizPoint[], window = 24, k = 1): VizPoint[] {
  const vals = points.map((p) => p.v);
  const out: VizPoint[] = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const seg = vals.slice(Math.max(0, i - window + 1), i + 1);
    const sd = sdOf(seg);
    out[i] = { ...points[i], lo: points[i].v - k * sd, hi: points[i].v + k * sd };
  }
  return out;
}

export interface HistBin {
  x0: number;
  x1: number;
  count: number;
}

/** histogram of the finite values in a window (quantile-bounded extremes). */
export function histogramOf(values: number[], bins = 36): HistBin[] {
  const xs = values.filter(Number.isFinite);
  if (xs.length < 2) return [];
  const sorted = [...xs].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.005)];
  const hi = sorted[Math.floor(sorted.length * 0.995)];
  const span = hi - lo || 1e-9;
  const out: HistBin[] = [];
  for (let i = 0; i < bins; i++) out.push({ x0: lo + (span * i) / bins, x1: lo + (span * (i + 1)) / bins, count: 0 });
  for (const x of xs) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(((x - lo) / span) * bins)));
    out[idx].count++;
  }
  return out;
}

/** min/max of the value + band extents for axis fitting. */
export function extentsOf(seriesList: VizPoint[][]): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const pts of seriesList) {
    for (const p of pts) {
      for (const v of [p.v, p.lo, p.hi]) {
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v as number);
          hi = Math.max(hi, v as number);
        }
      }
    }
  }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
  if (hi <= lo) hi = lo + 1e-9;
  const pad = (hi - lo) * 0.06;
  return { lo: lo - pad, hi: hi + pad };
}

/** log returns of a positive level series; plain diffs when it crosses zero. */
export function returnsOf(values: number[]): number[] {
  const out: number[] = [];
  let positive = true;
  for (const v of values) if (!(v > 0)) positive = false;
  for (let i = 1; i < values.length; i++) {
    if (positive && values[i - 1] > 0) out.push(Math.log(values[i] / values[i - 1]));
    else out.push(values[i] - values[i - 1]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · heatmap — the shared visual system for every heatmap in the
// terminal (breadth treemap, correlation matrix, funding grids, depth maps).
//
// One color language:
//   • diverging  — rose (negative) → deep slate (neutral) → teal (positive)
//                   the SAME semantic as the desk's pos/neg numerals;
//   • sequential — a viridis-class ramp for magnitude maps (volume, OI, GEX).
// Plus the squarified-treemap layout (Bruls, Huizing & van Wijk) so the
// breadth treemap and any future treemap share one proven layout engine.
// All pure functions — unit-tested, no DOM, no client-only APIs.
// ─────────────────────────────────────────────────────────────────────────────

// ── color scales ────────────────────────────────────────────────────────────

/** rose → slate → teal, t ∈ [0,1] (0 = most negative, 1 = most positive). */
const DIVERGING_STOPS: [number, number, number, number][] = [
  [0.0, 251, 113, 133], // rose-400  (#fb7185)
  [0.35, 190, 72, 90], // deep rose
  [0.5, 24, 28, 39], // slate-950 neutral (#181c27)
  [0.65, 22, 138, 124], // deep teal
  [1.0, 45, 212, 191], // teal-400   (#2dd4bf)
];

/** viridis-class ramp, t ∈ [0,1] (dark blue → green → warm yellow). */
const SEQUENTIAL_STOPS: [number, number, number, number][] = [
  [0.0, 12, 26,62], // deep blue
  [0.25, 33, 87, 145], // blue
  [0.5, 40, 125, 129], // teal-green
  [0.75, 92, 177, 90], // green
  [0.93, 224, 199, 82], // yellow-green
  [1.0, 253, 231, 37], // yellow
];

function sample(stops: [number, number, number, number][], t: number): [number, number, number] {
  const c = Math.min(1, Math.max(0, t));
  let k = 1;
  while (k < stops.length - 1 && stops[k][0] < c) k++;
  const [t0, r0, g0, b0] = stops[k - 1];
  const [t1, r1, g1, b1] = stops[k];
  const f = t1 === t0 ? 0 : (c - t0) / (t1 - t0);
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
}

function rgba(r: number, g: number, b: number, a = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

/** Neutral fallback (slate-950) for NaN/zero-domain inputs. */
export const NEUTRAL_TILE = 'rgba(24, 28, 39, 1)';

/**
 * Diverging color for a signed value scaled by `maxAbs` (clamped).
 * v/maxAbs = −1 → rose, 0 → neutral slate, +1 → teal.
 */
export function divergingColor(v: number, maxAbs = 1, alpha = 1): string {
  if (!Number.isFinite(v) || !(maxAbs > 0)) return NEUTRAL_TILE;
  const t = 0.5 + (Math.max(-maxAbs, Math.min(maxAbs, v)) / maxAbs) * 0.5;
  return rgba(...sample(DIVERGING_STOPS, t), alpha);
}

/** Sequential (viridis-class) color for t ∈ [0,1]. */
export function sequentialColor(t: number, alpha = 1): string {
  return rgba(...sample(SEQUENTIAL_STOPS, Number.isFinite(t) ? t : 0), alpha);
}

/** Correlation-specific scale: −1 → rose, 0 → neutral, +1 → teal. */
export function correlationColor(r: number, alpha = 1): string {
  return divergingColor(Number.isFinite(r) ? r : 0, 1, alpha);
}

/** n labeled tick positions from min → max (used by every HeatLegend). */
export function legendTicks(min: number, max: number, n = 5): { t: number; label: string }[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || n < 2) {
    return [{ t: 0, label: min.toFixed(1) }];
  }
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const v = min + (max - min) * t;
    const av = Math.abs(v);
    const label = av >= 100 ? v.toFixed(0) : av >= 10 ? v.toFixed(1) : v.toFixed(2);
    return { t, label };
  });
}

// ── squarified treemap layout ────────────────────────────────────────────────

export interface TreemapItem<T = unknown> {
  value: number; // positive area weight
  data: T;
}

export interface TreemapRect<T = unknown> {
  x: number;
  y: number;
  w: number;
  h: number;
  data: T;
}

interface SmItem {
  value: number;
  idx: number;
}

/** Worst aspect ratio of a strip of items with total area s laid along side L. */
function worstRatio(row: SmItem[], L: number): number {
  const s = row.reduce((acc, it) => acc + it.value, 0);
  if (!(s > 0) || !(L > 0)) return Infinity;
  const t = s / L; // strip thickness
  let worst = Infinity;
  for (const it of row) {
    const r = Math.max(it.value / (t * t), (t * t) / it.value);
    if (r < worst) worst = r;
  }
  return worst;
}

/**
 * Lay items out in [0,w]×[0,h] worst-case-aspect-ratio-optimal (squarify,
 * Bruls–Huizing–van Wijk). Wider rects get horizontal rows; taller rects
 * get vertical columns — each strip is as square as possible.
 */
export function squarify<T>(items: TreemapItem<T>[], w: number, h: number): TreemapRect<T>[] {
  const valid = items.filter((it) => Number.isFinite(it.value) && it.value > 0);
  const total = valid.reduce((s, it) => s + it.value, 0);
  if (!valid.length || !(w > 0) || !(h > 0) || !(total > 0)) return [];

  const scale = (w * h) / total;
  const sm: SmItem[] = valid
    .map((it, idx) => ({ value: it.value * scale, idx }))
    .sort((a, b) => b.value - a.value);

  const rects: Array<{ x: number; y: number; w: number; h: number; idx: number }> = [];
  let x = 0;
  let y = 0;
  let rw = w;
  let rh = h;

  while (sm.length && rw > 0 && rh > 0) {
    const rowW = rw >= rh; // horizontal row when the remainder is wide
    const L = rowW ? rw : rh; // strip runs along the longer side

    // greedily grow the row while the worst aspect ratio improves
    let take = 1;
    let best = worstRatio(sm.slice(0, 1), L);
    for (let k = 2; k <= sm.length; k++) {
      const r = worstRatio(sm.slice(0, k), L);
      if (r <= best) {
        best = r;
        take = k;
      } else break;
    }

    const row = sm.splice(0, take);
    const s = row.reduce((acc, it) => acc + it.value, 0);
    const t = s / L; // strip thickness

    let off = 0;
    for (const it of row) {
      const len = it.value / t; // item extent along L
      rects.push(
        rowW
          ? { x: x + off, y, w: len, h: t, idx: it.idx }
          : { x, y: y + off, w: t, h: len, idx: it.idx },
      );
      off += len;
    }

    if (rowW) {
      y += t;
      rh = Math.max(0, rh - t);
    } else {
      x += t;
      rw = Math.max(0, rw - t);
    }
  }

  return rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, data: valid[r.idx].data }));
}

// ── statistics used by the correlation matrix ────────────────────────────────

/** Pearson correlation of two equal-length series (NaN-safe: null). */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const va = a[i] - ma;
    const vb = b[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const den = Math.sqrt(da * db);
  if (!(den > 0)) return null;
  const r = num / den;
  return Math.max(-1, Math.min(1, r));
}

/** Align several { ts → value } series on their COMMON timestamps, sorted. */
export function alignSeries(series: Array<Map<number, number>>): { ts: number[]; cols: number[][] } {
  if (!series.length) return { ts: [], cols: [] };
  let common: number[] | null = null;
  for (const s of series) {
    const keys = [...s.keys()].sort((x, y) => x - y);
    common = common ? common.filter((k) => s.has(k)) : keys;
  }
  const ts = common ?? [];
  const cols = series.map((s) => ts.map((t) => s.get(t) ?? NaN));
  return { ts, cols };
}

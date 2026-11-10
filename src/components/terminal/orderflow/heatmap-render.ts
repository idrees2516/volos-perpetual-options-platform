// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — resting-liquidity heatmap renderer (client)
//
// Keeps an offscreen grid with one pixel column per 1-second depth snapshot
// and one pixel row per tick, indexed by `t % capacity` so the ring never
// shifts. Because the chart's x-axis is linear in time, the whole visible
// window is a single drawImage stretch — panning and zooming stay cheap.
//
// Colour runs dark blue → cyan → yellow → white, scaled to the recent 98th
// percentile so liquidity walls stand out. Adapted from the open-source
// order-flow-screener by zadescoxp (Apache-2.0).
// ─────────────────────────────────────────────────────────────────────────────

import type { WireHeatmapColumn } from '@/lib/orderflow/wire';

const CAPACITY = 7200; // two hours of seconds
const RANGE_MARGIN = 0.25;
const MAX_ROWS = 4000;
const RESCALE_EVERY = 30; // snapshots between colour-scale checks
const RESCALE_DRIFT = 0.35;

// Dark blue → cyan → yellow → white, the usual depth-heatmap ramp.
const STOPS: [number, number, number, number, number][] = [
  [0.0, 10, 20, 50, 0],
  [0.12, 22, 48, 110, 0.35],
  [0.35, 24, 116, 196, 0.6],
  [0.6, 56, 206, 205, 0.78],
  [0.82, 248, 226, 110, 0.9],
  [1.0, 255, 255, 255, 1],
];

function buildLut(): Uint32Array {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < STOPS.length - 1 && STOPS[k][0] < t) k++;
    const [t0, r0, g0, b0, a0] = STOPS[k - 1];
    const [t1, r1, g1, b1, a1] = STOPS[k];
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    const r = Math.round(r0 + (r1 - r0) * f);
    const g = Math.round(g0 + (g1 - g0) * f);
    const b = Math.round(b0 + (b1 - b0) * f);
    const a = Math.round((a0 + (a1 - a0) * f) * 255);
    lut[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0; // little-endian RGBA
  }
  return lut;
}

export class HeatmapRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private readonly lut = buildLut();
  private tick = 0;
  private minIdx = 0;
  private maxIdx = -1;
  private cap = 0;
  private builtThrough = -Infinity; // last column t painted
  private lastScaleT = -Infinity;
  private lastColumnT = -Infinity;
  private dirty = false;

  get isEmpty(): boolean {
    return !this.canvas;
  }

  get rowRange(): { minIdx: number; maxIdx: number } {
    return { minIdx: this.minIdx, maxIdx: this.maxIdx };
  }

  /** Bring the grid up to date with the store's columns. */
  update(columns: Iterable<WireHeatmapColumn>, tick: number): void {
    if (!(tick > 0)) return;
    let rebuild = this.tick !== tick || !this.canvas;
    const list = [...columns];
    // expand the price range when a snapshot falls outside it
    for (const col of list) {
      if (!col.i.length) continue;
      if (col.i[0] < this.minIdx || col.i[col.i.length - 1] > this.maxIdx || this.maxIdx < this.minIdx) {
        rebuild = true;
        break;
      }
    }
    const latest = list.length ? list[list.length - 1].t : this.lastColumnT;
    if (!rebuild && latest - this.lastScaleT >= RESCALE_EVERY * 1000) {
      const cap = this.percentile(list, 0.98);
      this.lastScaleT = latest;
      if (this.cap > 0 && Math.abs(cap - this.cap) / this.cap > RESCALE_DRIFT) rebuild = true;
    }
    if (rebuild) {
      this.rebuild(list, tick);
      this.builtThrough = -Infinity;
    }
    for (const col of list) {
      if (col.t <= this.builtThrough) continue; // already painted (same second)
      if (col.t > this.builtThrough + 2000 && this.builtThrough > -Infinity) {
        // gap (reset): unpainted columns stay empty
      }
      this.paint(col);
      this.builtThrough = col.t;
    }
    this.lastColumnT = latest;
    this.dirty = true;
  }

  private percentile(list: WireHeatmapColumn[], pct: number, maxCols = 240): number {
    const values: number[] = [];
    const sample = list.length > maxCols ? list.slice(list.length - maxCols) : list;
    for (const col of sample) {
      for (const s of col.s) values.push(s);
    }
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.floor(values.length * pct))];
  }

  private rebuild(list: WireHeatmapColumn[], tick: number): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (const col of list) {
      if (!col.i.length) continue;
      lo = Math.min(lo, col.i[0]);
      hi = Math.max(hi, col.i[col.i.length - 1]);
    }
    if (!Number.isFinite(lo)) return;
    const margin = Math.max(20, Math.ceil((hi - lo) * RANGE_MARGIN));
    this.minIdx = lo - margin;
    this.maxIdx = hi + margin;
    if (this.maxIdx - this.minIdx + 1 > MAX_ROWS) {
      const lastCol = list.length ? list[list.length - 1] : null;
      const mid = lastCol ? lastCol.i[lastCol.i.length >> 1] ?? (lo + hi) / 2 : (lo + hi) / 2;
      this.minIdx = Math.round(mid - MAX_ROWS / 2);
      this.maxIdx = Math.round(mid + MAX_ROWS / 2 - 1);
    }
    this.cap = this.percentile(list, 0.98) || 1;
    this.lastScaleT = list.length ? list[list.length - 1].t : Date.now();
    this.tick = tick;

    if (typeof document === 'undefined') return; // SSR guard
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    }
    this.canvas.width = CAPACITY;
    this.canvas.height = this.maxIdx - this.minIdx + 1;
    for (const col of list) this.paint(col);
  }

  /** Paint one snapshot as a one-pixel column. */
  private paint(col: WireHeatmapColumn): void {
    if (!this.ctx || !this.canvas || !col.i.length) return;
    const rows = this.canvas.height;
    const image = this.ctx.createImageData(1, rows);
    const pixels = new Uint32Array(image.data.buffer);
    const inv = 1 / (this.cap || 1);
    for (let k = 0; k < col.i.length; k++) {
      const row = this.maxIdx - col.i[k];
      if (row < 0 || row >= rows) continue;
      // mild gamma: typical depth stays blue, only walls reach yellow / white
      const t = Math.min(1, Math.pow(col.s[k] * inv, 0.85));
      pixels[row] = this.lut[Math.round(t * 255)];
    }
    this.ctx.putImageData(image, Math.floor(col.t / 1000) % CAPACITY, 0);
  }

  /** Draw the heatmap behind the candles: one stretch over the visible window. */
  draw(
    target: CanvasRenderingContext2D,
    t0: number,
    t1: number,
    xOf: (t: number) => number,
    priceY: (price: number) => number,
    alpha = 0.72,
  ): void {
    if (!this.canvas || !this.ctx || this.maxIdx < this.minIdx || this.tick <= 0) return;
    const sec0 = Math.floor(t0 / 1000);
    const sec1 = Math.floor(t1 / 1000);
    const count = Math.min(sec1 - sec0, CAPACITY);
    if (count <= 0) return;
    const start = ((sec0 % CAPACITY) + CAPACITY) % CAPACITY;
    const firstPart = Math.min(count, CAPACITY - start);
    const top = priceY(this.maxIdx * this.tick);
    const bottom = priceY(this.minIdx * this.tick);
    const height = bottom - top;
    if (!(height > 0)) return;
    const x0 = xOf(sec0 * 1000);
    const width = xOf(sec1 * 1000) - x0;
    const perColumn = width / Math.max(1, count);
    target.save();
    target.imageSmoothingEnabled = false;
    target.globalAlpha = alpha;
    if (firstPart === count) {
      target.drawImage(this.canvas, start, 0, count, this.canvas.height, x0, top, perColumn * count, height);
    } else {
      target.drawImage(this.canvas, start, 0, firstPart, this.canvas.height, x0, top, perColumn * firstPart, height);
      target.drawImage(
        this.canvas,
        0,
        0,
        count - firstPart,
        this.canvas.height,
        x0 + perColumn * firstPart,
        top,
        perColumn * (count - firstPart),
        height,
      );
    }
    target.restore();
    this.dirty = false;
  }

  /** Resting size at a price on the column nearest `time` (tooltips). */
  static sizeAt(columns: Map<number, WireHeatmapColumn>, tick: number, time: number, price: number): number | null {
    if (!(tick > 0) || !columns.size) return null;
    const sec = Math.floor(time / 1000) * 1000;
    let col = columns.get(sec);
    if (!col) {
      // nearest within ±2 s
      for (const off of [1000, -1000, 2000, -2000]) {
        col = columns.get(sec + off);
        if (col) break;
      }
    }
    if (!col) return null;
    const target = Math.round(price / tick);
    let lo = 0;
    let hi = col.i.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (col.i[mid] === target) return col.s[mid];
      if (col.i[mid] < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return 0;
  }
}

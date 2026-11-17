// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW · walls — resting-liquidity wall detection for the depth heatmap.
//
// The depth heatmap paints every resting order; WALLS are the levels that
// matter: price rows whose resting size towers over the book (≥ a robust
// p98 threshold and several × the median level), persist for tens of
// seconds, then vanish (pulled or eaten). The detector is a pure function
// over the same sparse 1-second columns the chart renders — client-side for
// the live markers, server-side (`/api/orderflow/heatmap?walls=1`) so the
// list survives browser reloads mid-session.
//
// Life-cycle per price row: appear (size ≥ TH) → persist (size ≥ decay·TH
// or unseen ≤ gap) → vanish (below decay·TH for > gap or absent > gap).
// Side is inferred from the column mid at appearance: above mid = ask-side
// wall (seller defends), below mid = bid-side wall (buyer defends).
// ─────────────────────────────────────────────────────────────────────────────

import type { WireHeatmapColumn } from './wire';

export interface RestingWall {
  /** price-row index (column `i` units) */
  row: number;
  price: number;
  side: 'bid' | 'ask';
  tStart: number;
  tEnd: number; // == last refresh while alive; frozen at vanish for events
  peakSize: number;
  lastSize: number;
  live: boolean;
}

export interface WallEvent extends RestingWall {
  live: false;
  durationMs: number;
}

export interface WallScan {
  threshold: number;
  live: RestingWall[];
  events: WallEvent[]; // recent vanishes, newest first, capped
  scanned: number; // columns scanned
  note: string;
}

export interface WallOpts {
  percentile?: number; // size percentile for the threshold (default 0.98)
  minMultiple?: number; // threshold must also be ≥ this × median size
  decay?: number; // persistence fraction of the threshold (default 0.6)
  gapMs?: number; // unseen tolerance before a wall is declared vanished
  maxLive?: number;
  maxEvents?: number;
}

/** p-th percentile of a numeric sample (nearest-rank). */
function pct(vals: number[], p: number): number {
  if (!vals.length) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

interface TrackState {
  wall: RestingWall;
  weakSince: number | null; // first time size fell below decay·TH
}

/**
 * Detect resting-liquidity walls over an ascending-time column series.
 * Pure: no DOM, no clock — `nowMs` lets the caller freeze time (tests,
 * server route use the last column's time).
 */
export function detectWalls(columns: WireHeatmapColumn[], tick: number, opts: WallOpts = {}, nowMs?: number): WallScan {
  const {
    percentile = 0.98,
    minMultiple = 6,
    decay = 0.6,
    gapMs = 6_000,
    maxLive = 14,
    maxEvents = 30,
  } = opts;

  const sizes: number[] = [];
  for (const col of columns) for (const s of col.s) if (Number.isFinite(s) && s > 0) sizes.push(s);
  const med = pct(sizes, 0.5);
  const threshold = Math.max(pct(sizes, percentile), med * minMultiple, 1e-9);

  const tracks = new Map<number, TrackState>();
  const finished: WallEvent[] = [];
  const now = nowMs ?? (columns.length ? columns[columns.length - 1].t : 0);

  const close = (state: TrackState, tEnd: number) => {
    const w = state.wall;
    finished.push({ ...w, tEnd: Math.max(w.tEnd, w.tStart), live: false, durationMs: Math.max(0, tEnd - w.tStart) });
  };

  for (const col of columns) {
    // column mid (price-row units) for side inference — robust to unsorted i
    let minRow = Infinity;
    let maxRow = -Infinity;
    for (const r of col.i) {
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
    }
    const midRow = Number.isFinite(minRow) ? (minRow + maxRow) / 2 : 0;

    const seen = new Set<number>();
    for (let k = 0; k < col.i.length; k++) {
      const row = col.i[k];
      const s = col.s[k];
      if (!Number.isFinite(s)) continue;
      seen.add(row);

      if (s >= threshold) {
        const state = tracks.get(row);
        if (state) {
          state.wall.peakSize = Math.max(state.wall.peakSize, s);
          state.wall.lastSize = s;
          state.wall.tEnd = col.t;
          if (state.weakSince != null) state.weakSince = null; // refreshed to full strength
        } else {
          tracks.set(row, {
            wall: {
              row,
              price: row * tick,
              side: row >= midRow ? 'ask' : 'bid',
              tStart: col.t,
              tEnd: col.t,
              peakSize: s,
              lastSize: s,
              live: true,
            },
            weakSince: null,
          });
        }
      } else if (s >= threshold * decay) {
        // wall persists while weakening; refresh lastSeen
        const state = tracks.get(row);
        if (state) {
          state.wall.lastSize = s;
          state.wall.tEnd = col.t;
          if (state.weakSince == null) state.weakSince = col.t;
        }
      } else {
        // size collapsed below the decay band → vanish now
        const state = tracks.get(row);
        if (state) {
          close(state, col.t);
          tracks.delete(row);
        }
      }
    }

    // rows absent from this column: gap logic (data hole vs vanish)
    for (const [row, state] of tracks) {
      if (seen.has(row)) continue;
      if (col.t - state.wall.tEnd > gapMs) {
        close(state, col.t - gapMs > state.wall.tStart ? col.t : state.wall.tEnd + gapMs);
        tracks.delete(row);
      }
    }
  }

  // walls still tracked at the end of the window are LIVE
  const live = [...tracks.values()]
    .map((s) => s.wall)
    .filter((w) => now - w.tEnd <= gapMs)
    .sort((a, b) => b.peakSize - a.peakSize)
    .slice(0, maxLive);

  const events = finished
    .filter((e) => e.durationMs > 2_000) // sub-2s flickers are noise
    .sort((a, b) => b.tEnd - a.tEnd)
    .slice(0, maxEvents);

  return {
    threshold,
    live,
    events,
    scanned: columns.length,
    note: `walls ≥ p${Math.round(percentile * 100)} resting size (${threshold >= 100 ? threshold.toFixed(0) : threshold.toFixed(2)}) · ${live.length} live · ${events.length} recent vanish${events.length === 1 ? '' : 'es'} over ${columns.length} s of depth`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · gex-session — net dealer gamma evolving through the session.
//
// The GEX tab shows the ladder NOW; this module adds the TIME axis: a
// server-side ring buffer samples the chain snapshot's per-strike netGex
// (all-expiry aggregate, USD per 1% move) at most once a minute — pulled
// from the SAME cached snapshot every other panel reads, so sampling adds
// no venue calls — and the route renders the strike × time grid with the
// zero-gamma (HVL) line and the spot trace drawn over it.
//
// Ring: 240 samples/symbol (4 h at 1-min cadence) on the globalThis
// singleton; dev HMR and restarts start a fresh session — columns
// accumulate again within minutes of the view being polled.
// ─────────────────────────────────────────────────────────────────────────────

import { getChainSnapshot } from './engine';

export interface GexSample {
  ts: number;
  spot: number;
  hvl: number | null; // zero-gamma level (engine's gamma flip)
  gex: Array<[number, number]>; // [strike, netGex USD/1%]
}

export interface GexSessionResult {
  symbol: string;
  asOf: number;
  minutes: number;
  strikes: number[]; // row axis, ascending
  times: number[]; // column axis (sample ts), ascending
  netGex: number[][]; // [col][row] → USD per 1% move (NaN = no row that sample)
  spot: number[]; // per column
  zeroGamma: (number | null)[]; // per column
  maxAbs: number;
  latestTotalGex: number | null; // all-expiry net from the newest sample
  regime: 'long-gamma' | 'short-gamma' | null;
  samples: number; // samples in the returned window
  note: string;
}

const SAMPLE_MS = 60_000; // minimum spacing between samples
const MAX_SAMPLES = 240; // ring size (≈4 h)
const MAX_ROWS = 26;
const MAX_COLS = 60;

const g = globalThis as unknown as { __volquantGexSession?: Map<string, { samples: GexSample[]; last: number; inflight: Promise<void> | null }> };
const buffers = g.__volquantGexSession ?? new Map();
g.__volquantGexSession = buffers;

async function sample(symbol: string): Promise<void> {
  const buf = buffers.get(symbol) ?? { samples: [], last: 0, inflight: null };
  buffers.set(symbol, buf);
  if (Date.now() - buf.last < SAMPLE_MS) return; // throttled — the snapshot is shared cache anyway
  if (buf.inflight) return buf.inflight; // single-flight
  const run = (async () => {
    try {
      const snap = await getChainSnapshot(symbol, 30_000);
      buf.samples.push({
        ts: Date.now(),
        spot: snap.spot,
        hvl: snap.levels.hvl,
        gex: snap.strikes
          .filter((s) => Number.isFinite(s.netGex))
          .map((s) => [s.strike, s.netGex] as [number, number]),
      });
      if (buf.samples.length > MAX_SAMPLES) buf.samples.splice(0, buf.samples.length - MAX_SAMPLES);
      buf.last = Date.now();
    } finally {
      buf.inflight = null;
    }
  })();
  buf.inflight = run;
  return run;
}

// ── pure grid assembly (unit-tested) ────────────────────────────────────────

export interface AssembledSession {
  strikes: number[];
  times: number[];
  netGex: number[][];
  spot: number[];
  zeroGamma: (number | null)[];
  maxAbs: number;
  latestTotalGex: number | null;
  regime: 'long-gamma' | 'short-gamma' | null;
}

/** Which strike ROWS the grid keeps: the top `maxRows` strikes by peak
 *  |netGex| across the window (walls and supports earn their rows), then
 *  sorted ascending — the natural price-ladder reading top→bottom. */
export function pickStrikes(samples: GexSample[], maxRows: number): number[] {
  const peak = new Map<number, number>();
  for (const s of samples) {
    for (const [k, v] of s.gex) {
      const a = Math.abs(v);
      const cur = peak.get(k) ?? 0;
      if (a > cur) peak.set(k, a);
    }
  }
  return [...peak.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRows)
    .map((e) => e[0])
    .sort((a, b) => a - b);
}

export function assembleGexSession(samples: GexSample[], minutes: number, maxRows = MAX_ROWS, maxCols = MAX_COLS, now = Date.now()): AssembledSession {
  const from = now - minutes * 60_000;
  const kept = samples.filter((s) => s.ts >= from && s.ts <= now + SAMPLE_MS);

  const strikes = pickStrikes(kept, maxRows);
  const rowIdx = new Map(strikes.map((k, i) => [k, i]));

  // stride the columns when samples exceed maxCols (wide windows)
  let stride = 1;
  while (kept.length / stride > maxCols) stride *= 2;
  const cols = kept.filter((_, i) => i % stride === 0);

  const netGex: number[][] = cols.map((s) => {
    const row = new Array<number>(strikes.length).fill(NaN);
    for (const [k, v] of s.gex) {
      const i = rowIdx.get(k);
      if (i != null) row[i] = v;
    }
    return row;
  });

  const flatAbs = netGex.flat().filter((v) => Number.isFinite(v)).map(Math.abs);
  const maxAbs = flatAbs.length ? Math.max(...flatAbs) : 0;

  const latest = kept.length ? kept[kept.length - 1] : null;
  const latestTotalGex = latest ? latest.gex.reduce((sum, [, v]) => sum + v, 0) : null;

  return {
    strikes,
    times: cols.map((s) => s.ts),
    netGex,
    spot: cols.map((s) => s.spot),
    zeroGamma: cols.map((s) => s.hvl),
    maxAbs,
    latestTotalGex,
    regime: latestTotalGex == null || !Number.isFinite(latestTotalGex) ? null : latestTotalGex >= 0 ? 'long-gamma' : 'short-gamma',
  };
}

// ── the session view ────────────────────────────────────────────────────────

/** Net dealer gamma through the session (samples the shared chain snapshot
 *  at most once a minute — no extra venue calls). */
export async function getGexSession(symbol: string, minutes = 120): Promise<GexSessionResult> {
  await sample(symbol);
  const buf = buffers.get(symbol);
  const samples = buf?.samples ?? [];
  const windowMin = Math.max(15, Math.min(240, minutes));
  const a = assembleGexSession(samples, windowMin);

  const result: GexSessionResult = {
    symbol,
    asOf: Date.now(),
    minutes: windowMin,
    strikes: a.strikes,
    times: a.times,
    netGex: a.netGex,
    spot: a.spot,
    zeroGamma: a.zeroGamma,
    maxAbs: a.maxAbs,
    latestTotalGex: a.latestTotalGex,
    regime: a.regime,
    samples: a.times.length,
    note:
      a.times.length === 0
        ? 'session sampler warming — the strike × time grid accumulates one column per minute while this view is open'
        : `net dealer gamma per strike through the session · ${a.times.length} samples × ${a.strikes.length} strikes · sampled ≤1/min off the shared chain snapshot`,
  };
  return result;
}

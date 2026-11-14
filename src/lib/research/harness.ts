// ─────────────────────────────────────────────────────────────────────────────
// TRACK B — SIGNAL RESEARCH HARNESS ("does this signal actually work?")
//
// Runs the factor battery over the STORED history (klineBar + derivativesPoint
// + microSnapshot — never the live feeds), so every result is reproducible,
// rate-limit-free and survives restarts. For each factor:
//
//   • daily-block Spearman IC — corr(factor score, forward return) computed
//     per UTC day then aggregated (mean, t-stat, positive-day share), the
//     standard event-study style that survives overlapping horizons;
//   • quintile analysis — pooled rank buckets Q1..Q5 with mean forward
//     return per bucket, Q5−Q1 spread (bps) and Welch t-stat;
//   • hit rate — P(forward return > 0 | top quintile), the number a trader
//     actually feels.
//
// Factors are deliberately the same families the live terminal shows: taker
// delta / CVD momentum / divergence, momentum & mean-reversion, volume bursts,
// OI acceleration and OI×price confirmation, funding crowding (contrarian),
// range squeeze, and (as sessions accumulate) stored microstructure — VPIN,
// Kyle lambda. The harness's job is to tell the Copilot WHICH of those have
// measured edge on which horizon, so decisions quote evidence, not vibes.
//
// Every run is persisted to ResearchRun — a track record of what worked,
// when. Pure statistics live in exported functions (unit-tested).
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
import { isOfAsset } from '@/lib/orderflow/catalog';
import type { OfAsset } from '@/lib/orderflow/types';

// ── pure statistics ──────────────────────────────────────────────────────────

/** Rank an array (1-based, average ties). NaN stays NaN. */
export function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).filter((p) => Number.isFinite(p.v));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length).fill(NaN);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const avg = (k + 1 + j + 1) / 2;
    for (let m = k; m <= j; m++) out[idx[m].i] = avg;
    k = j + 1;
  }
  return out;
}

/** Pearson correlation; NaN when degenerate. */
export function pearson(xs: number[], ys: number[]): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  if (n < 3) return NaN;
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (!(vx > 0) || !(vy > 0)) return NaN;
  return cov / Math.sqrt(vx * vy);
}

/** Spearman rank correlation. */
export function spearman(xs: number[], ys: number[]): number {
  return pearson(rank(xs), rank(ys));
}

/** Rolling z-score over window w (causal: uses [i-w+1, i]); NaN until warm. */
export function rollingZ(xs: number[], w: number): number[] {
  const n = xs.length;
  const out = new Array<number>(n).fill(NaN);
  if (w < 2 || n < 2) return out;
  const finite = xs.map((v) => Number.isFinite(v));
  const prefixS = new Float64Array(n + 1);
  const prefixS2 = new Float64Array(n + 1);
  const prefixN = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefixS[i + 1] = prefixS[i] + (finite[i] ? xs[i] : 0);
    prefixS2[i + 1] = prefixS2[i] + (finite[i] ? xs[i] * xs[i] : 0);
    prefixN[i + 1] = prefixN[i] + (finite[i] ? 1 : 0);
  }
  const minCount = Math.max(3, Math.floor(w / 2));
  for (let i = 0; i < n; i++) {
    if (!finite[i]) continue;
    const lo = Math.max(0, i - w + 1);
    const cnt = prefixN[i + 1] - prefixN[lo];
    if (cnt < minCount) continue; // warm-up
    const mean = (prefixS[i + 1] - prefixS[lo]) / cnt;
    const m2 = (prefixS2[i + 1] - prefixS2[lo]) / cnt - mean * mean;
    if (!(m2 > 1e-18)) continue;
    out[i] = (xs[i] - mean) / Math.sqrt(m2);
  }
  return out;
}

/** Rolling mean over window w (causal); NaN until at least half the window. */
export function rollingMean(xs: number[], w: number): number[] {
  const n = xs.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < 2) return out;
  const finite = xs.map((v) => Number.isFinite(v));
  const prefixS = new Float64Array(n + 1);
  const prefixN = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefixS[i + 1] = prefixS[i] + (finite[i] ? xs[i] : 0);
    prefixN[i + 1] = prefixN[i] + (finite[i] ? 1 : 0);
  }
  const minCount = Math.max(2, Math.floor(w / 2));
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w + 1);
    const cnt = prefixN[i + 1] - prefixN[lo];
    if (cnt < minCount) continue;
    out[i] = (prefixS[i + 1] - prefixS[lo]) / cnt;
  }
  return out;
}

/** Log returns in bps (NaN at edges / non-positive prices). */
export function logReturnsBps(close: number[]): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  for (let i = 1; i < close.length; i++) {
    if (!(close[i - 1] > 0) || !(close[i] > 0)) continue;
    out[i] = Math.log(close[i] / close[i - 1]) * 1e4;
  }
  return out;
}

/** Two-sided Welch t-statistic for equal means. */
export function welchT(xs: number[], ys: number[]): number {
  const a = xs.filter((v) => Number.isFinite(v));
  const b = ys.filter((v) => Number.isFinite(v));
  if (a.length < 2 || b.length < 2) return NaN;
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!(se > 1e-18)) return NaN;
  return (ma - mb) / se;
}

// ── panel ────────────────────────────────────────────────────────────────────

export interface ResearchMicro {
  vpin: number | null;
  kyle: number | null;
  obi: number | null;
  takerShare: number | null;
  vwapDist: number | null;
}

export interface ResearchBar {
  t: number; // bar open time (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // base volume
  buyV: number; // taker-buy base volume
  delta: number; // 2·buyV − v
  trades: number;
  funding: number | null; // carry-forward 8h rate
  oi: number | null; // carry-forward OI (base units)
  micro: ResearchMicro | null;
}

export interface ResearchPanel {
  asset: string;
  tfSec: number;
  venue: string;
  bars: ResearchBar[];
  from: number | null;
  to: number | null;
  microBars: number;
  fundingBars: number;
  oiBars: number;
}

/** Carry-forward join of a step series (sorted by ts) onto bar opens. */
function stepJoin(bars: ResearchBar[], points: Array<{ ts: number; v: number }>, field: 'funding' | 'oi'): void {
  let p = 0;
  for (const bar of bars) {
    while (p < points.length && points[p].ts <= bar.t) p++;
    const cur = p > 0 ? points[p - 1] : null;
    bar[field] = cur ? cur.v : null;
  }
}

/** Last stored microstructure snapshot within each bar window. */
function microJoin(
  bars: ResearchBar[],
  snaps: Array<{ ts: number; vpin: number | null; kyle: number | null; obi: number | null; takerShare: number | null; vwapDist: number | null }>,
): void {
  let p = 0;
  for (const bar of bars) {
    let last: (typeof snaps)[number] | null = null;
    while (p < snaps.length && snaps[p].ts < bar.t + 1) {
      if (snaps[p].ts >= bar.t) last = snaps[p];
      p++;
    }
    if (last) {
      bar.micro = {
        vpin: last.vpin,
        kyle: last.kyle,
        obi: last.obi,
        takerShare: last.takerShare,
        vwapDist: last.vwapDist,
      };
    }
  }
}

const MAX_BARS = 80_000;

/** Load the stored-history panel for one asset/timeframe (binance klines are
 *  the aggressor-delta source; funding/OI/micro join as available). */
export async function loadResearchPanel(asset: string, tfSec: number, lookbackDays: number): Promise<ResearchPanel> {
  const from = new Date(Date.now() - Math.max(1, Math.min(365 * 2, lookbackDays)) * 86_400_000);
  const [klines, funding, oi, micro] = await Promise.all([
    db.klineBar.findMany({
      where: { venue: 'binance', asset, tfSec, tOpen: { gte: from } },
      orderBy: { tOpen: 'asc' },
      take: MAX_BARS,
    }),
    db.derivativesPoint.findMany({
      where: { venue: 'binance', asset, kind: 'funding', ts: { gte: from } },
      orderBy: { ts: 'asc' },
      take: 10_000,
    }),
    db.derivativesPoint.findMany({
      where: { venue: 'binance', asset, kind: 'openInterest', ts: { gte: from } },
      orderBy: { ts: 'asc' },
      take: 60_000,
    }),
    db.microSnapshot.findMany({
      where: { asset, ts: { gte: from } },
      orderBy: { ts: 'asc' },
      take: 200_000,
      select: { ts: true, vpin: true, kyleLambda: true, obi: true, takerShare: true, vwapDist: true },
    }),
  ]);
  const bars: ResearchBar[] = klines.map((k) => ({
    t: k.tOpen.getTime(),
    o: k.open,
    h: k.high,
    l: k.low,
    c: k.close,
    v: k.volume,
    buyV: k.buyVolume,
    delta: 2 * k.buyVolume - k.volume,
    trades: k.trades,
    funding: null,
    oi: null,
    micro: null,
  }));
  const panel: ResearchPanel = {
    asset,
    tfSec,
    venue: 'binance',
    bars,
    from: bars.length ? bars[0].t : null,
    to: bars.length ? bars[bars.length - 1].t : null,
    microBars: 0,
    fundingBars: 0,
    oiBars: 0,
  };
  if (!bars.length) return panel;
  stepJoin(bars, funding.map((p) => ({ ts: p.ts.getTime(), v: p.value })), 'funding');
  stepJoin(bars, oi.map((p) => ({ ts: p.ts.getTime(), v: p.value })), 'oi');
  microJoin(
    bars,
    micro.map((s) => ({ ts: s.ts.getTime(), vpin: s.vpin, kyle: s.kyleLambda, obi: s.obi, takerShare: s.takerShare, vwapDist: s.vwapDist })),
  );
  panel.fundingBars = bars.filter((b) => b.funding !== null).length;
  panel.oiBars = bars.filter((b) => b.oi !== null).length;
  panel.microBars = bars.filter((b) => b.micro !== null).length;
  return panel;
}

// ── factor battery ───────────────────────────────────────────────────────────

export interface FactorSpec {
  id: string;
  label: string;
  family: 'Flow' | 'Momentum' | 'Perps' | 'Volatility' | 'Microstructure';
  /** needs micro snapshots on the bars (skipped when the store has none) */
  needsMicro?: boolean;
  compute: (panel: ResearchPanel) => number[];
}

/** Z-score of the per-bar change of a carried step series (Δln), NaN where absent. */
function stepChangeZ(series: Array<number | null>, w: number): number[] {
  const ln = series.map((v) => (v !== null && v > 0 ? Math.log(v) : NaN));
  const ret: number[] = new Array<number>(series.length).fill(NaN);
  for (let i = 1; i < ln.length; i++) {
    ret[i] = Number.isFinite(ln[i]) && Number.isFinite(ln[i - 1]) ? ln[i] - ln[i - 1] : NaN;
  }
  return rollingZ(ret, w);
}

/** Mean |delta| of the panel — normalization constant for CVD momentum. */
function meanAbsDelta(bars: ResearchBar[]): number {
  let s = 0;
  let n = 0;
  for (const b of bars) {
    if (Number.isFinite(b.delta)) {
      s += Math.abs(b.delta);
      n++;
    }
  }
  return n > 0 ? s / n : 1;
}

export const RESEARCH_FACTORS: FactorSpec[] = [
  {
    id: 'delta_z',
    label: 'Taker delta z-score (24 bars)',
    family: 'Flow',
    compute: ({ bars }) => rollingZ(bars.map((b) => b.delta), 24),
  },
  {
    id: 'cvd_mom',
    label: 'Cumulative-delta momentum (36 bars)',
    family: 'Flow',
    compute: ({ bars }) => {
      let cvd = 0;
      const cvdSeries = bars.map((b) => (cvd += b.delta));
      const norm = Math.max(1e-9, meanAbsDelta(bars));
      const out = bars.map((_, i) => (i >= 36 ? (cvdSeries[i] - cvdSeries[i - 36]) / norm : NaN));
      return rollingZ(out, 288);
    },
  },
  {
    id: 'flow_divergence',
    label: 'Price/flow divergence (24 bars)',
    family: 'Flow',
    compute: ({ bars }) => {
      const rets = logReturnsBps(bars.map((b) => b.c));
      const rz = rollingZ(rets, 24);
      const dz = rollingZ(bars.map((b) => b.delta), 24);
      return rz.map((r, i) => (Number.isFinite(r) && Number.isFinite(dz[i]) ? r - dz[i] : NaN));
    },
  },
  {
    id: 'momentum',
    label: 'Price momentum z (24 bars)',
    family: 'Momentum',
    compute: ({ bars }) => rollingZ(logReturnsBps(bars.map((b) => b.c)), 24),
  },
  {
    id: 'mean_reversion',
    label: 'VWAP distance (inverted, 96 bars)',
    family: 'Momentum',
    compute: ({ bars }) => {
      const pv = rollingMean(bars.map((b) => b.c * b.v), 96);
      const vMean = rollingMean(bars.map((b) => b.v), 96);
      const vwap = pv.map((m, i) => (Number.isFinite(m) && Number.isFinite(vMean[i]) && vMean[i] > 0 ? m / vMean[i] : NaN));
      const dist = bars.map((b, i) => (Number.isFinite(vwap[i]) && vwap[i] > 0 ? (b.c - vwap[i]) / vwap[i] : NaN));
      return rollingZ(dist, 96).map((z) => (Number.isFinite(z) ? -z : NaN));
    },
  },
  {
    id: 'volume_burst',
    label: 'Volume burst × aggressor sign',
    family: 'Volatility',
    compute: ({ bars }) => {
      const lv = bars.map((b) => (b.v > 0 ? Math.log(b.v) : NaN));
      const vz = rollingZ(lv, 96);
      const dz = rollingZ(bars.map((b) => b.delta), 24);
      return vz.map((v, i) => (Number.isFinite(v) && Number.isFinite(dz[i]) ? v * Math.sign(dz[i]) : NaN));
    },
  },
  {
    id: 'range_squeeze',
    label: 'Range compression (12 vs prior 12)',
    family: 'Volatility',
    compute: ({ bars }) => {
      const tr = bars.map((b) => b.h - b.l);
      const now = rollingMean(tr, 12);
      const prior = rollingMean(tr, 24);
      return now.map((m, i) => {
        if (!Number.isFinite(m) || !Number.isFinite(prior[i]) || !(prior[i] > 1e-18)) return NaN;
        return -(m / prior[i]); // compressed (small ratio) → high score
      });
    },
  },
  {
    id: 'oi_accel',
    label: 'Open-interest acceleration (24 bars)',
    family: 'Perps',
    compute: ({ bars }) => stepChangeZ(bars.map((b) => b.oi), 24),
  },
  {
    id: 'oi_price_confirm',
    label: 'OI × price confirmation',
    family: 'Perps',
    compute: ({ bars }) => {
      const rz = rollingZ(logReturnsBps(bars.map((b) => b.c)), 24);
      const oz = stepChangeZ(bars.map((b) => b.oi), 24);
      return rz.map((r, i) => (Number.isFinite(r) && Number.isFinite(oz[i]) ? r * oz[i] : NaN));
    },
  },
  {
    id: 'funding_contrarian',
    label: 'Funding crowding (inverted)',
    family: 'Perps',
    // 30 days of 5m bars is the ideal window; shrink adaptively on shorter
    // histories so the factor stays computable (some evidence > none)
    compute: ({ bars }) => {
      const w = Math.min(2880, Math.max(288, Math.floor(bars.length / 4)));
      return rollingZ(
        bars.map((b) => (b.funding === null ? NaN : b.funding)),
        w,
      ).map((z) => (Number.isFinite(z) ? -z : NaN));
    },
  },
  {
    id: 'micro_vpin',
    label: 'Stored VPIN (toxicity)',
    family: 'Microstructure',
    needsMicro: true,
    compute: ({ bars }) => rollingZ(bars.map((b) => b.micro?.vpin ?? NaN), 576),
  },
  {
    id: 'micro_kyle',
    label: 'Stored Kyle lambda (impact)',
    family: 'Microstructure',
    needsMicro: true,
    compute: ({ bars }) => rollingZ(bars.map((b) => b.micro?.kyle ?? NaN), 576),
  },
];

// ── evaluation ───────────────────────────────────────────────────────────────

export interface IcStats {
  mean: number;
  tStat: number;
  posDayShare: number;
  days: number;
}

export interface FactorResult {
  id: string;
  label: string;
  family: string;
  n: number;
  ic: IcStats | null;
  quintileMeanBps: number[]; // Q1..Q5
  spreadBps: number | null;
  spreadT: number | null;
  hitRateQ5: number | null;
  verdict: 'strong' | 'inverse' | 'weak' | 'flat' | 'insufficient';
}

const MIN_OBS = 200;

/** Daily-block Spearman IC + quintile analysis for one aligned factor. */
export function evaluateFactor(
  id: string,
  label: string,
  family: string,
  scores: number[],
  fwd: number[],
  tOpen: number[],
): FactorResult {
  const pairs: Array<{ s: number; f: number; t: number }> = [];
  for (let i = 0; i < scores.length; i++) {
    if (Number.isFinite(scores[i]) && Number.isFinite(fwd[i])) pairs.push({ s: scores[i], f: fwd[i], t: tOpen[i] });
  }
  const base: FactorResult = {
    id,
    label,
    family,
    n: pairs.length,
    ic: null,
    quintileMeanBps: [NaN, NaN, NaN, NaN, NaN],
    spreadBps: null,
    spreadT: null,
    hitRateQ5: null,
    verdict: 'insufficient',
  };
  if (pairs.length < MIN_OBS) return base;

  // daily IC blocks — the standard defense against overlapping-horizon noise
  const byDay = new Map<string, number[][]>();
  for (const p of pairs) {
    const day = new Date(p.t).toISOString().slice(0, 10);
    let d = byDay.get(day);
    if (!d) byDay.set(day, (d = [[], []]));
    d[0].push(p.s);
    d[1].push(p.f);
  }
  const dayIcs: number[] = [];
  for (const [s, f] of byDay.values()) {
    if (s.length < 40) continue; // day too thin to rank
    const ic = spearman(s, f);
    if (Number.isFinite(ic)) dayIcs.push(ic);
  }
  let ic: IcStats | null = null;
  if (dayIcs.length >= 5) {
    const mean = dayIcs.reduce((a, b) => a + b, 0) / dayIcs.length;
    const sd =
      dayIcs.length > 1 ? Math.sqrt(dayIcs.reduce((a, b) => a + (b - mean) ** 2, 0) / (dayIcs.length - 1)) : NaN;
    ic = {
      mean,
      tStat: Number.isFinite(sd) && sd > 1e-12 ? (mean / sd) * Math.sqrt(dayIcs.length) : NaN,
      posDayShare: dayIcs.filter((v) => v > 0).length / dayIcs.length,
      days: dayIcs.length,
    };
  }

  // quintiles on pooled ranks (Q5 = highest factor score)
  const sorted = [...pairs].sort((a, b) => a.s - b.s);
  const q = Math.floor(sorted.length / 5);
  const qs: number[][] = [];
  for (let k = 0; k < 5; k++) {
    const lo = k * q;
    const hi = k === 4 ? sorted.length : (k + 1) * q;
    qs.push(sorted.slice(lo, hi).map((p) => p.f));
  }
  const quintileMeanBps = qs.map((g) => (g.length ? g.reduce((a, b) => a + b, 0) / g.length : NaN));
  const spreadBps = quintileMeanBps[4] - quintileMeanBps[0];
  const spreadT = welchT(qs[4], qs[0]);
  const q5 = qs[4];
  const hitRateQ5 = q5.length ? q5.filter((v) => v > 0).length / q5.length : null;

  let verdict: FactorResult['verdict'] = 'flat';
  const icT = ic ? Math.abs(ic.tStat ?? 0) : 0;
  const spT = Math.abs(spreadT ?? 0);
  if (ic && ic.mean < -0.02 && (icT >= 2 || spT >= 2)) verdict = 'inverse'; // informative, opposite direction
  else if (ic && ic.mean > 0.02 && (icT >= 2 || spT >= 2)) verdict = 'strong';
  else if (icT >= 1.5 || spT >= 1.5) verdict = 'weak';
  return { id, label, family, n: pairs.length, ic, quintileMeanBps, spreadBps, spreadT, hitRateQ5, verdict };
}

// ── report ───────────────────────────────────────────────────────────────────

export interface ResearchReport {
  asset: string;
  tfSec: number;
  horizonBars: number;
  lookbackDays: number;
  venue: string;
  bars: number;
  from: string | null;
  to: string | null;
  coverage: { fundingBars: number; oiBars: number; microBars: number };
  factors: FactorResult[];
  composite: (FactorResult & { members: string[] }) | null;
  notes: string[];
}

export interface RunResearchOptions {
  asset?: string;
  tfSec?: number;
  horizonBars?: number;
  lookbackDays?: number;
  factorIds?: string[];
  persist?: boolean;
}

export async function runResearch(opts: RunResearchOptions = {}): Promise<ResearchReport> {
  const asset = isOfAsset(String(opts.asset ?? 'BTC')) ? (opts.asset as OfAsset) : 'BTC';
  const tfSec = [60, 300, 1800].includes(Number(opts.tfSec)) ? Number(opts.tfSec) : 300;
  const horizonBars = Math.max(1, Math.min(96, Number(opts.horizonBars) || 12));
  const lookbackDays =
    Math.max(1, Math.min(730, Number(opts.lookbackDays) || (tfSec === 300 ? 120 : tfSec === 1800 ? 365 : 30)));
  const wanted = opts.factorIds?.length ? new Set(opts.factorIds) : null;

  const panel = await loadResearchPanel(asset, tfSec, lookbackDays);
  const notes: string[] = [];
  const report: ResearchReport = {
    asset,
    tfSec,
    horizonBars,
    lookbackDays,
    venue: panel.venue,
    bars: panel.bars.length,
    from: panel.from ? new Date(panel.from).toISOString() : null,
    to: panel.to ? new Date(panel.to).toISOString() : null,
    coverage: { fundingBars: panel.fundingBars, oiBars: panel.oiBars, microBars: panel.microBars },
    factors: [],
    composite: null,
    notes,
  };
  if (panel.bars.length < MIN_OBS + horizonBars) {
    notes.push(
      `only ${panel.bars.length} stored ${tfSec}s bars for ${asset} — run the backfill worker (POST /api/store/backfill {"action":"start"}) and retry once history lands`,
    );
    return report;
  }
  notes.push(
    `${panel.bars.length} bars ${report.from?.slice(0, 10)} → ${report.to?.slice(0, 10)}; forward horizon ${horizonBars} bars (${((horizonBars * tfSec) / 3600).toFixed(1)}h)`,
    'overlapping forward windows inflate quintile t-stats ~√h — treat as screening evidence, not confirmation',
  );

  // forward returns
  const closes = panel.bars.map((b) => b.c);
  const tOpen = panel.bars.map((b) => b.t);
  const fwd = new Array<number>(closes.length).fill(NaN);
  for (let i = 0; i + horizonBars < closes.length; i++) {
    if (closes[i] > 0 && closes[i + horizonBars] > 0) fwd[i] = Math.log(closes[i + horizonBars] / closes[i]) * 1e4;
  }

  const results: FactorResult[] = [];
  const scoresById = new Map<string, number[]>();
  for (const spec of RESEARCH_FACTORS) {
    if (wanted && !wanted.has(spec.id)) continue;
    if (spec.needsMicro && panel.microBars < MIN_OBS) {
      notes.push(
        `${spec.id} skipped — ${panel.microBars} bars carry stored microstructure (accumulates with live sessions)`,
      );
      continue;
    }
    const scores = spec.compute(panel);
    const res = evaluateFactor(spec.id, spec.label, spec.family, scores, fwd, tOpen);
    results.push(res);
    scoresById.set(spec.id, scores);
  }

  // composite: direction-adjusted equal weight of factors with |IC| ≥ 0.015
  const eligible = results.filter(
    (r) => r.ic && Math.abs(r.ic.mean) >= 0.015 && Number.isFinite(r.quintileMeanBps[4]) && r.n >= MIN_OBS,
  );
  if (eligible.length >= 2) {
    const compositeScores = panel.bars.map((_, i) => {
      let s = 0;
      let n = 0;
      for (const r of eligible) {
        const sc = scoresById.get(r.id)?.[i];
        if (sc === undefined || !Number.isFinite(sc)) continue; // skip this bar — keep composite strictly clean
        s += Math.sign(r.ic!.mean) * sc;
        n++;
      }
      return n === eligible.length ? s / n : NaN;
    });
    const comp = evaluateFactor(
      'composite',
      `Composite (${eligible.length} factors, IC-directed)`,
      'Composite',
      compositeScores,
      fwd,
      tOpen,
    );
    report.composite = { ...comp, members: eligible.map((r) => r.id) };
  }

  report.factors = results.sort((a, b) => Math.abs(b.ic?.mean ?? 0) - Math.abs(a.ic?.mean ?? 0));
  if (!results.length) notes.push('no factors computable on this panel');

  if (opts.persist !== false) {
    try {
      await db.researchRun.create({
        data: {
          asset,
          tfSec,
          horizonBars,
          lookbackDays,
          venue: panel.venue,
          bars: panel.bars.length,
          factorsJson: JSON.stringify(results).slice(0, 190_000),
          compositeJson: report.composite ? JSON.stringify(report.composite).slice(0, 95_000) : JSON.stringify(null),
        },
      });
    } catch {
      notes.push('persistence failed (storage best-effort) — results still returned');
    }
  }
  return report;
}

// ── listing helpers (API + Copilot) ─────────────────────────────────────────

export interface ResearchRunRow {
  id: string;
  asset: string;
  tfSec: number;
  horizonBars: number;
  lookbackDays: number;
  bars: number;
  createdAt: string;
  topFactors: Array<{ id: string; ic: number; verdict: string }>;
  compositeIc: number | null;
}

function parseRun(r: { id: string; asset: string; tfSec: number; horizonBars: number; lookbackDays: number; bars: number; createdAt: Date; factorsJson: string; compositeJson: string }): ResearchRunRow {
  let factors: FactorResult[] = [];
  let composite: FactorResult | null = null;
  try {
    factors = JSON.parse(r.factorsJson) as FactorResult[];
    composite = JSON.parse(r.compositeJson) as FactorResult | null;
  } catch {
    /* corrupted row — surface emptily */
  }
  return {
    id: r.id,
    asset: r.asset,
    tfSec: r.tfSec,
    horizonBars: r.horizonBars,
    lookbackDays: r.lookbackDays,
    bars: r.bars,
    createdAt: r.createdAt.toISOString(),
    topFactors: factors
      .filter((f) => f.ic)
      .slice(0, 3)
      .map((f) => ({ id: f.id, ic: +(f.ic!.mean ?? 0).toFixed(4), verdict: f.verdict })),
    compositeIc: composite?.ic ? +(composite.ic.mean ?? 0).toFixed(4) : null,
  };
}

/** Recent persisted research runs (compact for UI/Copilot). */
export async function recentResearchRuns(limit = 20, asset?: string): Promise<ResearchRunRow[]> {
  const rows = await db.researchRun.findMany({
    where: asset ? { asset } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(100, limit)),
  });
  return rows.map(parseRun);
}

/** Latest persisted run for one asset, unpacked into a report. */
export async function latestResearchReport(
  asset: string,
): Promise<{ row: ResearchRunRow; report: ResearchReport } | null> {
  const row = await db.researchRun.findFirst({ where: { asset }, orderBy: { createdAt: 'desc' } });
  if (!row) return null;
  const parsed = parseRun(row);
  let composite: FactorResult & { members: string[] } | null = null;
  try {
    composite = JSON.parse(row.compositeJson) as FactorResult & { members: string[] };
  } catch {
    composite = null;
  }
  const factors: FactorResult[] = parsed.topFactors ? (() => {
    try {
      return JSON.parse(row.factorsJson) as FactorResult[];
    } catch {
      return [];
    }
  })() : [];
  return {
    row: parsed,
    report: {
      asset: row.asset,
      tfSec: row.tfSec,
      horizonBars: row.horizonBars,
      lookbackDays: row.lookbackDays,
      venue: row.venue,
      bars: row.bars,
      from: null,
      to: null,
      coverage: { fundingBars: 0, oiBars: 0, microBars: 0 },
      factors,
      composite,
      notes: ['persisted run'],
    },
  };
}

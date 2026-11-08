// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · engine — the native realtime analytics engine.
//
// Pulls the live Deribit option chain (keyless public API) and computes, with
// our own Black-76 math, the full institutional surface: per-contract greeks,
// GEX by strike/expiry, dealer levels (HVL / call wall / put support / max
// pain), strike×expiry heatmaps, IV term structure + 25Δ/10Δ skew + smiles,
// constant-maturity 30d IV vs realized vol (VRP), expected moves, the
// risk-neutral PDF (Breeden–Litzenberger), greek profiles and the TRACE
// forward gamma map (time × price). Everything is REAL, computed from live
// venue data on every refresh — no static/simulated fallbacks.
// ─────────────────────────────────────────────────────────────────────────────

import {
  indexPrice,
  futureBookSummary,
  optionBookSummary,
  parseOptionName,
  historicalVolatility,
} from './deribit';
import { b76Greeks, interp, realizedVol, smooth3 } from './math';
import type { ChainSnapshot, ExpiryAnalytics, GexLevels, OptionRow, ProbabilitySlice, StrikeAgg, TraceMap } from './types';

const YEAR_MS = 365 * 24 * 3600 * 1000;
const OPTIONS_SYMBOLS = new Set(['BTC', 'ETH']);

interface SnapCache {
  snap: ChainSnapshot;
  ts: number;
}
const snapCache = new Map<string, SnapCache>();

function lastFridayOfMonth(d: Date): boolean {
  return d.getUTCDay() === 5 && d.getUTCMonth() !== new Date(d.getTime() + 7 * 864e5).getUTCMonth();
}

function expiryType(dte: number, dateStr: string): ExpiryAnalytics['type'] {
  if (dte < 1) return '0DTE';
  const [y, m, dd] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd));
  if (lastFridayOfMonth(d)) {
    return [2, 5, 8, 11].includes(m - 1) ? 'quarterly' : 'monthly';
  }
  return dte <= 9 ? 'weekly' : 'daily';
}

/** Aggregate rows into per-strike dealer positioning. */
function aggregateStrikes(rows: OptionRow[]): StrikeAgg[] {
  const m = new Map<number, StrikeAgg>();
  for (const r of rows) {
    let a = m.get(r.strike);
    if (!a) {
      a = { strike: r.strike, callOi: 0, putOi: 0, callOiUsd: 0, putOiUsd: 0, callGex: 0, putGex: 0, netGex: 0, callVolumeUsd: 0, putVolumeUsd: 0 };
      m.set(r.strike, a);
    }
    if (r.isCall) {
      a.callOi += r.oi;
      a.callOiUsd += r.oiUsd;
      a.callGex += r.gexUsd1pct;
      a.callVolumeUsd += r.volumeUsd;
    } else {
      a.putOi += r.oi;
      a.putOiUsd += r.oiUsd;
      a.putGex += r.gexUsd1pct;
      a.putVolumeUsd += r.volumeUsd;
    }
    a.netGex = a.callGex - a.putGex;
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

/** Dealer levels from a strike ladder: HVL (gamma flip), walls, max pain. */
function gexLevels(rows: OptionRow[], strikes: StrikeAgg[]): GexLevels {
  const callGex = strikes.reduce((s, a) => s + a.callGex, 0);
  const putGex = strikes.reduce((s, a) => s + a.putGex, 0);
  const total = callGex - putGex;

  // HVL: zero-crossings of the cumulative net GEX curve; use the crossing
  // NEAREST the forward — deep-wing crossings are noise when net GEX ≈ 0.
  let hvl: number | null = null;
  let cum = 0;
  let prev: { k: number; cum: number } | null = null;
  const ref = strikes.length ? rows[0]?.forward ?? 0 : 0;
  let bestDist = Infinity;
  for (const a of strikes) {
    cum += a.netGex;
    if (prev && prev.cum < 0 && cum >= 0) {
      const t = Math.abs(prev.cum) / (Math.abs(prev.cum) + Math.abs(cum) || 1);
      const cross = prev.k + t * (a.strike - prev.k);
      const dist = ref > 0 ? Math.abs(cross - ref) : 0;
      if (dist < bestDist) {
        bestDist = dist;
        hvl = cross;
      }
    }
    prev = { k: a.strike, cum };
  }

  // walls: largest positioning strikes around spot
  let callWall: number | null = null;
  let putSupport: number | null = null;
  let bestCall = 0;
  let bestPut = 0;
  for (const a of strikes) {
    if (a.netGex > bestCall) {
      bestCall = a.netGex;
      callWall = a.strike;
    }
    if (-a.netGex > bestPut) {
      bestPut = -a.netGex;
      putSupport = a.strike;
    }
  }

  // max pain: strike minimizing total open-interest payout
  let maxPain: number | null = null;
  let minPayout = Infinity;
  for (const probe of strikes) {
    const S = probe.strike;
    let payout = 0;
    for (const r of rows) {
      if (r.isCall) payout += r.oi * Math.max(S - r.strike, 0);
      else payout += r.oi * Math.max(r.strike - S, 0);
    }
    if (payout < minPayout) {
      minPayout = payout;
      maxPain = S;
    }
  }

  const topStrikes = [...strikes]
    .sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))
    .slice(0, 12);

  return { hvl, callWall, putSupport, maxPain, totalGexUsd1pct: total, callGexUsd1pct: callGex, putGexUsd1pct: putGex, regime: total >= 0 ? 'long-gamma' : 'short-gamma', topStrikes };
}

/** OTM composite smile for one expiry + ATM/skew stats. */
function expiryAnalytics(rows: OptionRow[], expiry: string): ExpiryAnalytics | null {
  const expRows = rows.filter((r) => r.expiry === expiry);
  if (!expRows.length) return null;
  const expiryTs = expRows[0].expiryTs;
  const dte = expRows[0].dte;
  const F = expRows[0].forward;
  const T = Math.max(expiryTs - Date.now(), 15 * 60_000) / YEAR_MS;

  // OTM composite: calls at/above forward, puts below
  const smile: { strike: number; ivPct: number; delta: number }[] = [];
  for (const r of expRows) {
    const otm = r.isCall ? r.strike >= F : r.strike < F;
    if (!otm || !Number.isFinite(r.iv) || r.iv <= 0) continue;
    smile.push({ strike: r.strike, ivPct: r.iv * 100, delta: Math.abs(r.delta) });
  }
  smile.sort((a, b) => a.strike - b.strike);

  const xs = smile.map((p) => p.strike);
  const ys = smile.map((p) => p.ivPct);
  const atmIvPct = xs.length ? interp(xs, ys, F) : NaN;
  const atmIv = atmIvPct / 100;

  // skew by delta-interpolation on each wing
  const ivAtDelta = (target: number, wing: 'call' | 'put'): number => {
    const pts = smile
      .map((p) => ({ iv: p.ivPct, isCallWing: p.strike >= F, d: p.delta }))
      .filter((p) => (wing === 'call' ? p.isCallWing : !p.isCallWing));
    if (pts.length < 2) return NaN;
    const cand = pts.filter((p) => (wing === 'call' ? p.d <= 0.6 : p.d <= 0.85));
    if (cand.length < 2) return NaN;
    cand.sort((a, b) => b.d - a.d); // delta descending toward ATM
    // interpolate iv at target delta (d decreasing with distance)
    for (let i = 1; i < cand.length; i++) {
      if (cand[i].d <= target && cand[i - 1].d >= target) {
        const t = (target - cand[i].d) / (cand[i - 1].d - cand[i].d || 1);
        return cand[i].iv + t * (cand[i - 1].iv - cand[i].iv);
      }
    }
    return cand[cand.length - 1].d < target ? cand[cand.length - 1].iv : NaN;
  };
  const c25 = ivAtDelta(0.25, 'call');
  const p25 = ivAtDelta(0.25, 'put');
  const c10 = ivAtDelta(0.1, 'call');
  const p10 = ivAtDelta(0.1, 'put');

  // ATM straddle from closest strikes (call+put same strike nearest F)
  const byStrike = new Map<number, { c?: OptionRow; p?: OptionRow }>();
  for (const r of expRows) {
    const e = byStrike.get(r.strike) ?? {};
    if (r.isCall) e.c = r;
    else e.p = r;
    byStrike.set(r.strike, e);
  }
  let bestK = NaN;
  let bestDist = Infinity;
  for (const [k, pair] of byStrike) {
    if (pair.c && pair.p && Math.abs(k - F) < bestDist) {
      bestDist = Math.abs(k - F);
      bestK = k;
    }
  }
  const atmPair = byStrike.get(bestK);
  const straddleUsd = atmPair?.c && atmPair?.p ? (atmPair.c.mid + atmPair.p.mid) * F : NaN;

  const callOi = expRows.filter((r) => r.isCall).reduce((s, r) => s + r.oi, 0);
  const putOi = expRows.filter((r) => !r.isCall).reduce((s, r) => s + r.oi, 0);
  const callVolumeUsd = expRows.filter((r) => r.isCall).reduce((s, r) => s + r.volumeUsd, 0);
  const putVolumeUsd = expRows.filter((r) => !r.isCall).reduce((s, r) => s + r.volumeUsd, 0);
  const oiContracts = callOi + putOi;
  const oiUsd = expRows.reduce((s, r) => s + r.oiUsd, 0);
  const expStrikes = aggregateStrikes(expRows);
  const lv = gexLevels(expRows, expStrikes);

  return {
    expiry,
    expiryTs,
    dte,
    type: expiryType(dte, expiry),
    isAnchor: false,
    forward: F,
    atmIv,
    straddleUsd,
    expectedMove1sUsd: F * atmIv * Math.sqrt(T),
    callOi,
    putOi,
    oiContracts,
    oiUsd,
    callVolumeUsd,
    putVolumeUsd,
    putCallRatioOi: callOi > 0 ? putOi / callOi : NaN,
    putCallRatioVol: callVolumeUsd > 0 ? putVolumeUsd / callVolumeUsd : NaN,
    netGexUsd1pct: lv.totalGexUsd1pct,
    maxPain: lv.maxPain ?? NaN,
    atmIvPct,
    rr25: Number.isFinite(p25) && Number.isFinite(c25) ? p25 - c25 : NaN,
    fly25: Number.isFinite(p25) && Number.isFinite(c25) ? (p25 + c25) / 2 - atmIvPct : NaN,
    rr10: Number.isFinite(p10) && Number.isFinite(c10) ? p10 - c10 : NaN,
    smile,
  };
}

/** Risk-neutral PDF via Breeden–Litzenberger on the OTM composite curve. */
function probabilitySlice(rows: OptionRow[], expiry: string): ProbabilitySlice | null {
  const expRows = rows.filter((r) => r.expiry === expiry);
  if (expRows.length < 8) return null;
  const F = expRows[0].forward;
  const expiryTs = expRows[0].expiryTs;

  // composite call curve in USD: C(K) = call mid (K≥F) | put mid + F − K (K<F)
  const byStrike = new Map<number, { c?: OptionRow; p?: OptionRow }>();
  for (const r of expRows) {
    const e = byStrike.get(r.strike) ?? {};
    if (r.isCall) e.c = r;
    else e.p = r;
    byStrike.set(r.strike, e);
  }
  const pts: { k: number; c: number }[] = [];
  for (const [k, pair] of byStrike) {
    const cMid = pair.c ? pair.c.mid : NaN;
    const pMid = pair.p ? pair.p.mid : NaN;
    let c = NaN;
    if (k >= F && Number.isFinite(cMid) && cMid > 0) c = cMid * F;
    else if (k < F && Number.isFinite(pMid) && pMid > 0) c = (pMid + (F - k)) * F;
    if (Number.isFinite(c) && c > 0 && k > F * 0.62 && k < F * 1.45) pts.push({ k, c });
  }
  pts.sort((a, b) => a.k - b.k);
  if (pts.length < 8) return null;

  // resample onto a UNIFORM strike grid (mixed strike spacing otherwise
  // amplifies quote quantization into the second derivative)
  const lo = Math.max(pts[0].k, F * 0.75);
  const hi = Math.min(pts[pts.length - 1].k, F * 1.25);
  const srcKs = pts.map((p) => p.k);
  const srcCs = pts.map((p) => p.c);
  const gaps: number[] = [];
  for (let i = 1; i < srcKs.length; i++) gaps.push(srcKs[i] - srcKs[i - 1]);
  gaps.sort((a, b) => a - b);
  const step = gaps[Math.floor(gaps.length / 2)] || (hi - lo) / 20;
  const n = Math.max(8, Math.min(80, Math.floor((hi - lo) / step)));
  const grid: number[] = [];
  const cs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const k = lo + ((hi - lo) * i) / n;
    grid.push(k);
    cs.push(interp(srcKs, srcCs, k));
  }

  // second derivative → density; winsorize outliers (4×MAD)
  let dens: number[] = [];
  for (let i = 1; i < grid.length - 1; i++) {
    const h = grid[i + 1] - grid[i];
    dens.push((cs[i + 1] - 2 * cs[i] + cs[i - 1]) / (h * h));
  }
  const inner = grid.slice(1, -1);
  dens = smooth3(
    dens.map((d) => (Number.isFinite(d) ? d : 0)),
    2,
  );
  const absd = dens.map(Math.abs).sort((a, b) => a - b);
  const med = absd[Math.floor(absd.length / 2)] || 1;
  let mass = 0;
  const densPos: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const v = Math.max(Math.min(dens[i], med * 8), -med * 8);
    const dK = i > 0 ? inner[i] - inner[i - 1] : inner[1] - inner[0];
    mass += v * dK;
    densPos.push(Math.max(v, 0));
  }
  // normalize on the positive part
  const trap = (vals: number[]) => {
    let s = 0;
    for (let i = 1; i < grid.length; i++) s += ((vals[i - 1] + vals[i]) / 2) * (grid[i] - grid[i - 1]);
    return s;
  };
  const z = trap(densPos) || 1;
  const density = densPos.map((d) => d / z);
  const cdf: number[] = [];
  let acc = 0;
  for (let i = 0; i < grid.length; i++) {
    if (i > 0) acc += ((density[i - 1] + density[i]) / 2) * (grid[i] - grid[i - 1]);
    cdf.push(Math.min(acc, 1));
  }
  const q = (p: number) => interp(cdf, grid, p);
  let mode = grid[0];
  let best = -1;
  for (let i = 0; i < grid.length; i++) {
    if (density[i] > best) {
      best = density[i];
      mode = grid[i];
    }
  }
  let expected = 0;
  for (let i = 0; i < grid.length; i++) expected += grid[i] * density[i] * (i > 0 ? grid[i] - grid[i - 1] : grid[1] - grid[0]);
  return {
    expiry,
    dte: (expiryTs - Date.now()) / 864e5,
    strikes: grid,
    density,
    cdf,
    mode,
    p1: q(0.25),
    p3: q(0.75),
    mass,
    expected,
  };
}

/** TRACE: net dealer GEX re-projected across spot grid × time decay. */
function traceMap(rows: OptionRow[], spot: number): TraceMap {
  const spotGrid: number[] = [];
  for (let i = 0; i <= 24; i++) spotGrid.push(spot * (0.88 + (i / 24) * 0.24));
  const timeShiftsPct = [0, 0.25, 0.5, 0.75, 1];
  const netGex: number[][] = [];
  const flipByTime: (number | null)[] = [];

  for (const shift of timeShiftsPct) {
    const perSpot: number[] = [];
    for (const S of spotGrid) {
      let total = 0;
      for (const r of rows) {
        const T = Math.max(r.expiryTs - Date.now(), 15 * 60_000) / YEAR_MS;
        const Tn = Math.max(T * (1 - shift), 15 * 60_000 / YEAR_MS);
        const Fn = r.forward * (S / spot);
        const sigma = r.iv > 0 ? r.iv : NaN;
        if (!Number.isFinite(sigma)) continue;
        const g = b76Greeks(Fn, r.strike, Tn, sigma, r.isCall).gamma;
        if (Number.isFinite(g)) total += (r.isCall ? 1 : -1) * g * r.oi * Fn * Fn * 0.01;
      }
      perSpot.push(total);
    }
    netGex.push(perSpot);
    // flip = interpolated zero crossing of the per-spot curve
    let flip: number | null = null;
    for (let i = 1; i < perSpot.length; i++) {
      if (perSpot[i - 1] < 0 && perSpot[i] >= 0) {
        const t = Math.abs(perSpot[i - 1]) / (Math.abs(perSpot[i - 1]) + Math.abs(perSpot[i]) || 1);
        flip = spotGrid[i - 1] + t * (spotGrid[i] - spotGrid[i - 1]);
        break;
      }
    }
    flipByTime.push(flip);
  }
  return { spotGrid, timeShiftsPct, netGex, flipByTime };
}

/** Build the full snapshot for an options symbol. */
export async function getChainSnapshot(symbol: string, maxAgeMs = 4000): Promise<ChainSnapshot> {
  if (!OPTIONS_SYMBOLS.has(symbol)) throw new Error(`no options market for ${symbol} on free venues (Deribit covers BTC/ETH)`);
  const hit = snapCache.get(symbol);
  if (hit && Date.now() - hit.ts < maxAgeMs) return hit.snap;

  const t0 = Date.now();
  const [book, futures, spotRes, histVol] = await Promise.all([
    optionBookSummary(symbol, 4000),
    futureBookSummary(symbol, 15000),
    indexPrice(symbol, 5000).catch(() => null),
    historicalVolatility(symbol, 30 * 60_000)
      .then((r) => r.v)
      .catch(() => [] as [number, number][]),
  ]);

  const spot = spotRes?.v.price || book.v.find((b) => b.underlying_price)?.underlying_price || futures.v.find((f) => f.instrument_name === `${symbol}-PERPETUAL`)?.mark_price || 0;
  if (!spot) throw new Error('spot unavailable');

  const now = Date.now();
  const rows: OptionRow[] = [];
  for (const b of book.v) {
    const p = parseOptionName(b.instrument_name);
    if (!p || p.symbol !== symbol) continue;
    const dteMs = p.expiryTs - now;
    if (dteMs <= 0) continue;
    const T = dteMs / YEAR_MS;
    const F = b.underlying_price && b.underlying_price > 0 ? b.underlying_price : spot;
    const iv = (b.mark_iv ?? 0) / 100;
    const oi = b.open_interest ?? 0;
    const mid = b.mid_price ?? ((b.bid_price ?? 0) + (b.ask_price ?? 0)) / 2;
    const g = b76Greeks(F, p.strike, T, Number.isFinite(iv) && iv > 0 ? iv : 0.0001, p.isCall);
    const gex = Number.isFinite(g.gamma) ? g.gamma * oi * F * F * 0.01 : 0;
    rows.push({
      instrument: b.instrument_name,
      symbol,
      expiry: p.expiry,
      expiryTs: p.expiryTs,
      dte: dteMs / 864e5,
      strike: p.strike,
      isCall: p.isCall,
      bid: b.bid_price ?? 0,
      ask: b.ask_price ?? 0,
      mid,
      mark: b.mark_price,
      midUsd: mid * F,
      markUsd: b.mark_price * F,
      spreadUsd: ((b.ask_price ?? 0) - (b.bid_price ?? 0)) * F,
      iv,
      oi,
      oiUsd: oi * F,
      volume: b.volume ?? 0,
      volumeUsd: b.volume_usd ?? (b.volume ?? 0) * F,
      forward: F,
      delta: g.delta,
      gamma: g.gamma,
      // b76 vega/theta are ALREADY USD-denominated per contract (F·φ·√T per
      // 1.00σ; −F·φ·σ/2√T per year) — convert to per-vol-pt / per-day only.
      vega: g.vega / 100,
      thetaUsd: g.theta / 365,
      vanna: g.vanna,
      charm: g.charm,
      gexUsd1pct: gex,
    });
  }

  const strikes = aggregateStrikes(rows);
  const levels = gexLevels(rows, strikes);

  // 0DTE levels
  const frontExpiry = rows.length ? rows.reduce((min, r) => (r.expiryTs < min.expiryTs ? r : min), rows[0]).expiry : null;
  const rows0 = frontExpiry ? rows.filter((r) => r.expiry === frontExpiry) : [];
  const levels0dte = rows0.length ? gexLevels(rows0, aggregateStrikes(rows0)) : null;

  // per-expiry analytics
  const expirySet = [...new Set(rows.map((r) => r.expiry))].sort((a, b) => (a < b ? -1 : 1));
  const expiries: ExpiryAnalytics[] = [];
  for (const e of expirySet) {
    const a = expiryAnalytics(rows, e);
    if (a) expiries.push({ ...a, isAnchor: a.type === 'monthly' || a.type === 'quarterly' });
  }

  // heatmap grids (strike × expiry) — top 40 strikes by |netGex| for legibility
  const heatStrikes = [...strikes].sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex)).slice(0, 40).map((s) => s.strike).sort((a, b) => a - b);
  const heatExpiries = expiries.slice(0, 14).map((e) => e.expiry);
  const netGexGrid: number[][] = [];
  const oiGrid: number[][] = [];
  const ivGrid: number[][] = [];
  for (const e of heatExpiries) {
    const eRows = rows.filter((r) => r.expiry === e);
    const eMap = new Map<number, OptionRow[]>();
    for (const r of eRows) {
      const arr = eMap.get(r.strike) ?? [];
      arr.push(r);
      eMap.set(r.strike, arr);
    }
    netGexGrid.push(
      heatStrikes.map((k) => {
        const arr = eMap.get(k) ?? [];
        return arr.reduce((s, r) => s + (r.isCall ? 1 : -1) * r.gexUsd1pct, 0);
      }),
    );
    oiGrid.push(heatStrikes.map((k) => (eMap.get(k) ?? []).reduce((s, r) => s + r.oiUsd, 0)));
    ivGrid.push(
      heatStrikes.map((k) => {
        const arr = eMap.get(k) ?? [];
        const otm = arr.find((r) => (r.isCall ? r.strike >= r.forward : r.strike < r.forward));
        return otm && otm.iv > 0 ? otm.iv * 100 : NaN;
      }),
    );
  }

  // probability slices (front 8 expiries)
  const probability: ProbabilitySlice[] = [];
  for (const e of expirySet.slice(0, 8)) {
    const s = probabilitySlice(rows, e);
    if (s) probability.push(s);
  }

  // term structure + CM30
  const termStructure = expiries.map((e) => ({ dte: e.dte, expiry: e.expiry, atmIvPct: e.atmIvPct, oiUsd: e.oiUsd }));
  const tsPts = termStructure.filter((p) => Number.isFinite(p.atmIvPct)).map((p) => ({ t: p.dte / 365, iv: p.atmIvPct }));
  let atmIv30 = NaN;
  if (tsPts.length) {
    if (tsPts.length === 1) atmIv30 = tsPts[0].iv;
    else {
      const target = 30 / 365;
      atmIv30 = interp(
        tsPts.map((p) => p.t),
        tsPts.map((p) => p.iv),
        target,
      );
    }
  }

  // VRP: our CM30 IV vs venue 30d realized vol
  const rvArr = histVol ?? [];
  const rv30 = rvArr.length >= 5 ? rvArr.slice(-30).reduce((s, p) => s + p[1], 0) / Math.min(30, rvArr.length) : NaN;

  // expected moves
  const expectedMoves = expiries.slice(0, 10).map((e) => {
    const oneSigmaUsd = e.expectedMove1sUsd;
    const cal = Number.isFinite(rv30) && Number.isFinite(e.atmIv) ? Math.max(0.55, Math.min(1.45, rv30 / 100 / e.atmIv)) : 1;
    return {
      expiry: e.expiry,
      dte: e.dte,
      straddleUsd: e.straddleUsd,
      oneSigmaUsd,
      oneSigmaPct: (oneSigmaUsd / e.forward) * 100,
      twoSigmaUsd: oneSigmaUsd * 2,
      rangeLow: e.forward - oneSigmaUsd,
      rangeHigh: e.forward + oneSigmaUsd,
      calibrated1sUsd: oneSigmaUsd * cal,
    };
  });

  // futures term structure (basis curve)
  const futuresTerm = futures.v
    .filter((f) => f.instrument_name !== `${symbol}-PERPETUAL`)
    .map((f) => {
      const mm = /^(\w+)-(\d{1,2})([A-Z]{3})(\d{2})$/.exec(f.instrument_name);
      const ts = mm
        ? Date.UTC(
            2000 + +mm[4],
            ({ JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 } as Record<string, number>)[mm[3]] ?? 0,
            +mm[2],
            8,
          )
        : null;
      const dte = ts ? (ts - now) / 864e5 : NaN;
      const basis = ts && dte > 0 ? ((f.mark_price / spot - 1) * 365) / dte : NaN;
      return { instrument: f.instrument_name, expiryTs: ts, mark: f.mark_price, oi: f.open_interest ?? 0, basisPct: basis, dte };
    })
    .filter((f) => Number.isFinite(f.dte))
    .sort((a, b) => a.dte - b.dte);

  const perpMark = futures.v.find((f) => f.instrument_name === `${symbol}-PERPETUAL`)?.mark_price ?? spot;
  const totalOiUsd = rows.reduce((s, r) => s + r.oiUsd, 0);
  const totalVolumeUsd24h = book.v.reduce((s, b) => s + (b.volume_usd ?? 0), 0);
  const callOiAll = rows.filter((r) => r.isCall).reduce((s, r) => s + r.oi, 0);
  const putOiAll = rows.filter((r) => !r.isCall).reduce((s, r) => s + r.oi, 0);

  const snap: ChainSnapshot = {
    symbol,
    asOf: Date.now(),
    spot,
    forwardFront: expiries[0]?.forward ?? spot,
    perpMark,
    rows,
    strikes,
    expiries,
    levels,
    levels0dte,
    heatmap: { strikes: heatStrikes, expiries: heatExpiries, netGex: netGexGrid, oi: oiGrid, iv: ivGrid },
    probability,
    trace: traceMap(rows, spot),
    atmIv30: atmIv30 / 100,
    termStructure,
    totalOiUsd,
    totalVolumeUsd24h,
    putCallRatioOi: callOiAll > 0 ? putOiAll / callOiAll : NaN,
    iv30vsRv30: {
      iv30Pct: atmIv30,
      rv30Pct: rv30,
      vrpPct: Number.isFinite(atmIv30) && Number.isFinite(rv30) ? atmIv30 - rv30 : NaN,
      rvSource: 'deribit 30d realized (daily)',
    },
    expectedMoves,
    sources: [
      { venue: 'deribit', ageMs: Date.now() - book.ts },
      { venue: 'deribit-futures', ageMs: Date.now() - futures.ts },
    ],
  };
  // futures term attached via (undocumented) field for the oi module
  (snap as unknown as { futuresTerm?: typeof futuresTerm }).futuresTerm = futuresTerm;

  snapCache.set(symbol, { snap, ts: Date.now() });
  void t0;
  return snap;
}

/** Symbol → does it have a live options chain here? */
export function hasOptions(symbol: string): boolean {
  return OPTIONS_SYMBOLS.has(symbol);
}

/** Realized vol from candles (fallback/secondary, our own computation). */
export function rvFromCandles(closes: number[]): number {
  return realizedVol(closes);
}

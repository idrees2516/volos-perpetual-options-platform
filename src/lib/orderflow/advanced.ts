// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — advanced microstructure analytics
//
// The granular studies an options/analytics desk expects, computed natively
// from the engine's own 1-second flow bars, footprint candles, session stats
// and merged multi-venue book:
//
//   • Kyle's lambda   — price impact regression (Δp = λ·signed flow), reported
//                       as bps per $100k of aggressor flow over the last 15 m
//   • VPIN           — volume-synchronized probability of informed trading:
//                       mean |buy−sell| per equal-volume bucket over ~10 min
//                       (we have true aggressor sides, no bulk classification)
//   • Amihud         — illiquidity: mean |return| per $1M traded (5 s buckets,
//                       15 m window), in bps
//   • sign autocorr  — aggressor-side persistence (order-flow toxicity proxy)
//   • LOB slope      — resting size per bp of distance from mid, per side
//   • microprice skew — (microprice − mid)/spread, ±1 = one-sided pressure
//   • ATR(14) + Parkinson annualized vol + session percentile + regime
//   • session VWAP distance in σ, in-session POC / VAH / VAL (70% value area)
//   • CVD slope, taker buy share 1 m/5 m, volume z (5 m), trades/s
//
// Every metric degrades to null when the session is too young — no fake
// numbers. All estimators are standard textbook forms, labelled as such.
// ─────────────────────────────────────────────────────────────────────────────

import type { OfBook, OfCandle, OfFlowBar, OfSessionStats } from './types';

export interface OfAdvancedAnalytics {
  // impact & toxicity
  kyleLambdaBpsPer100k: number | null;
  vpin: number | null;
  amihudBpsPer1m: number | null;
  tradeSignAutocorr: number | null;
  // book shape
  micropriceSkew: number | null;
  lobSlopeBidPerBp: number | null;
  lobSlopeAskPerBp: number | null;
  obiMean1m: number | null;
  // volatility
  atr14: number | null;
  atrPct: number | null;
  parkinsonAnnPct: number | null;
  rvSessionPctile: number | null;
  volRegime: 'compressed' | 'normal' | 'elevated' | 'extreme' | null;
  // session profile
  vwapDistSigma: number | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  // flow
  cvdSlopePerMin5m: number | null;
  takerBuyShare1m: number | null;
  takerBuyShare5m: number | null;
  volumeZ5m: number | null;
  tradesPerSec: number | null;
}

interface Bucket5s {
  t: number; // bucket open ms
  buy: number;
  sell: number;
  close: number;
  notional: number;
  trades: number;
}

/** Aggregate 1 s flow bars into 5 s buckets (most recent `windowMs`). */
function bucket5s(bars: OfFlowBar[], windowMs: number): Bucket5s[] {
  const from = bars.length ? bars[bars.length - 1].time - windowMs : 0;
  const out: Bucket5s[] = [];
  let cur: Bucket5s | null = null;
  for (const b of bars) {
    if (b.time < from) continue;
    const t = Math.floor(b.time / 5000) * 5000;
    if (!cur || cur.t !== t) {
      cur = { t, buy: 0, sell: 0, close: b.close, notional: 0, trades: 0 };
      out.push(cur);
    }
    cur.buy += b.buyVolume;
    cur.sell += b.sellVolume;
    cur.close = b.close;
    cur.notional += (b.buyVolume + b.sellVolume) * b.close;
    cur.trades += b.trades;
  }
  return out;
}

/** OLS-through-origin slope: r = λ·q → λ = Σ(q·r)/Σ(q²). */
function originSlope(q: number[], r: number[]): number | null {
  let num = 0;
  let den = 0;
  for (let i = 0; i < q.length; i++) {
    num += q[i] * r[i];
    den += q[i] * q[i];
  }
  return den > 0 ? num / den : null;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function autocorrLag1(xs: number[]): number | null {
  if (xs.length < 8) return null;
  const m = mean(xs)!;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i] - m;
    den += d * d;
    if (i > 0) num += d * (xs[i - 1] - m);
  }
  return den > 0 ? num / den : null;
}

/** In-session volume profile: candle volume spread across its range on the
 * tick ladder (the reference terminal's methodology), POC + 70% value area. */
function sessionProfile(candles: OfCandle[], tick: number): { poc: number; vah: number; val: number } | null {
  if (!candles.length || !(tick > 0)) return null;
  const hist = new Map<number, number>();
  let total = 0;
  for (const c of candles) {
    if (!(c.volume > 0)) continue;
    const lo = Math.floor(c.low / tick) * tick;
    const hi = Math.ceil(c.high / tick) * tick;
    const steps = Math.max(1, Math.round((hi - lo) / tick));
    const per = c.volume / steps;
    for (let i = 0; i < steps; i++) {
      const p = lo + i * tick;
      hist.set(p, (hist.get(p) ?? 0) + per);
      total += per;
    }
  }
  if (!total) return null;
  let poc = 0;
  let best = -1;
  for (const [p, v] of hist) {
    if (v > best) {
      best = v;
      poc = p;
    }
  }
  // expand the value area around the POC until 70% of volume is covered
  const sorted = [...hist.keys()].sort((a, b) => a - b);
  let loIdx = sorted.indexOf(poc);
  let hiIdx = loIdx;
  let acc = hist.get(poc) ?? 0;
  const target = 0.7 * total;
  while (acc < target && (loIdx > 0 || hiIdx < sorted.length - 1)) {
    const down = loIdx > 0 ? hist.get(sorted[loIdx - 1]) ?? 0 : -1;
    const up = hiIdx < sorted.length - 1 ? hist.get(sorted[hiIdx + 1]) ?? 0 : -1;
    if (up >= down) {
      hiIdx++;
      acc += up;
    } else {
      loIdx--;
      acc += down;
    }
  }
  return { poc, vah: sorted[hiIdx], val: sorted[loIdx] };
}

export function computeAdvanced(
  bars: OfFlowBar[],
  candles1m: OfCandle[],
  session: OfSessionStats,
  book: { bids: OfBook['bids']; asks: OfBook['asks']; mid: number } | null,
  obiHistory: { time: number; value: number }[],
  tick: number,
  volumeZ5m: number | null,
  realizedVolAnnPct: number | null,
): OfAdvancedAnalytics {
  const now = bars.length ? bars[bars.length - 1].time + 1000 : Date.now();
  const b5 = bucket5s(bars, 15 * 60_000);

  // ── Kyle's lambda: Δp(bps) regressed on signed base-unit flow ──────────────
  let kyleLambdaBpsPer100k: number | null = null;
  if (b5.length >= 12) {
    const qs: number[] = [];
    const rs: number[] = [];
    for (let i = 1; i < b5.length; i++) {
      const q = b5[i].buy - b5[i].sell;
      if (q === 0) continue;
      const dpBps = ((b5[i].close - b5[i - 1].close) / b5[i - 1].close) * 10_000;
      if (!Number.isFinite(dpBps)) continue;
      qs.push(q);
      rs.push(dpBps);
    }
    const lam = originSlope(qs, rs);
    const price = session.last;
    if (lam !== null && price > 0) {
      // impact of $100k of aggressor flow = λ · ($100k / price) base units
      kyleLambdaBpsPer100k = Math.abs(lam) * (100_000 / price);
    }
  }

  // ── VPIN: equal-volume buckets over the last ~10 minutes ──────────────────
  let vpin: number | null = null;
  {
    const win = bucket5s(bars, 10 * 60_000);
    const totalVol = win.reduce((a, b) => a + b.buy + b.sell, 0);
    const nBuckets = 50;
    if (totalVol > 0 && win.length >= 20) {
      const v = totalVol / nBuckets;
      let acc = 0;
      let bucketBuys = 0;
      let bucketSells = 0;
      let bucketCount = 0;
      let sumAbs = 0;
      for (const b of win) {
        bucketBuys += b.buy;
        bucketSells += b.sell;
        acc += b.buy + b.sell;
        if (acc >= v) {
          sumAbs += Math.abs(bucketBuys - bucketSells);
          bucketCount++;
          acc = 0;
          bucketBuys = 0;
          bucketSells = 0;
        }
      }
      if (bucketCount >= 25) vpin = sumAbs / (bucketCount * v);
    }
  }

  // ── Amihud illiquidity: |r| per $1M traded, 5 s buckets ────────────────────
  let amihudBpsPer1m: number | null = null;
  if (b5.length >= 12) {
    const xs: number[] = [];
    for (let i = 1; i < b5.length; i++) {
      if (!(b5[i].notional > 0)) continue;
      const r = b5[i].close / b5[i - 1].close - 1;
      if (!Number.isFinite(r)) continue;
      xs.push((Math.abs(r) / b5[i].notional) * 1e6 * 10_000); // bps per $1M
    }
    amihudBpsPer1m = mean(xs);
  }

  // ── aggressor-sign persistence over 5 s bucket deltas ─────────────────────
  let tradeSignAutocorr: number | null = null;
  if (b5.length >= 16) {
    const signs = b5.slice(-60).map((b) => Math.sign(b.buy - b.sell)).filter((s) => s !== 0);
    tradeSignAutocorr = autocorrLag1(signs);
  }

  // ── book shape: microprice skew + LOB slopes ──────────────────────────────
  let micropriceSkew: number | null = null;
  let lobSlopeBidPerBp: number | null = null;
  let lobSlopeAskPerBp: number | null = null;
  if (book && book.bids.length && book.asks.length) {
    const bb = book.bids[0];
    const ba = book.asks[0];
    const spread = ba.price - bb.price;
    if (spread > 0) {
      const micro = (ba.price * bb.size + bb.price * ba.size) / (bb.size + ba.size);
      micropriceSkew = (micro - book.mid) / spread;
      // resting size (base units) per bp of distance from mid, per side:
      // slope of cumulative size vs distance via origin regression.
      const qBid: number[] = [];
      const rBid: number[] = [];
      for (const l of book.bids) {
        const distBp = ((book.mid - l.price) / book.mid) * 10_000;
        if (distBp <= 0 || distBp > 100) continue; // within 1%
        qBid.push(distBp);
        rBid.push(l.size);
      }
      const qAsk: number[] = [];
      const rAsk: number[] = [];
      for (const l of book.asks) {
        const distBp = ((l.price - book.mid) / book.mid) * 10_000;
        if (distBp <= 0 || distBp > 100) continue;
        qAsk.push(distBp);
        rAsk.push(l.size);
      }
      // slope of size on distance (how much size is added per bp deeper)
      lobSlopeBidPerBp = qBid.length >= 6 ? originSlope(qBid, rBid) : null;
      lobSlopeAskPerBp = qAsk.length >= 6 ? originSlope(qAsk, rAsk) : null;
    }
  }

  // ── mean OBI(±10bp) over the last minute ──────────────────────────────────
  const obiRecent = obiHistory.filter((o) => o.time >= now - 60_000).map((o) => o.value);
  const obiMean1m = obiRecent.length ? mean(obiRecent) : null;

  // ── ATR(14) on 1 m candles ────────────────────────────────────────────────
  let atr14: number | null = null;
  if (candles1m.length >= 15) {
    const trs: number[] = [];
    for (let i = 1; i < candles1m.length; i++) {
      const c = candles1m[i];
      const pc = candles1m[i - 1].close;
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
    }
    atr14 = mean(trs.slice(-14));
  }
  const atrPct = atr14 !== null && session.last > 0 ? (atr14 / session.last) * 100 : null;

  // ── Parkinson annualized volatility from 1 m candles ───────────────────────
  let parkinsonAnnPct: number | null = null;
  if (candles1m.length >= 20) {
    const xs: number[] = [];
    for (const c of candles1m.slice(-90)) {
      if (!(c.high > 0) || !(c.low > 0) || c.high <= c.low) continue;
      const hl = Math.log(c.high / c.low);
      xs.push((hl * hl) / (4 * Math.LN2));
    }
    const m = mean(xs);
    if (m !== null && m > 0) {
      const barsPerYear = 365 * 24 * 60;
      parkinsonAnnPct = Math.sqrt(m * barsPerYear) * 100;
    }
  }

  // ── realized-vol session percentile + regime ──────────────────────────────
  let rvSessionPctile: number | null = null;
  let volRegime: OfAdvancedAnalytics['volRegime'] = null;
  if (realizedVolAnnPct !== null && bars.length >= 360) {
    // distribution of 5-minute RV estimates sampled every minute this session
    const samples: number[] = [];
    for (let start = bars.length - 300; start >= 0; start -= 60) {
      const slice = bars.slice(start, start + 300);
      if (slice.length < 300) continue;
      let sum = 0;
      let count = 0;
      for (let i = 1; i < slice.length; i++) {
        if (slice[i - 1].close > 0 && slice[i].close > 0) {
          const r = Math.log(slice[i].close / slice[i - 1].close);
          sum += r * r;
          count++;
        }
      }
      if (count > 100) samples.push(Math.sqrt(sum / count) * Math.sqrt(365 * 24 * 3600) * 100);
    }
    if (samples.length >= 5) {
      const below = samples.filter((s) => s <= realizedVolAnnPct).length;
      rvSessionPctile = (below / samples.length) * 100;
      volRegime =
        rvSessionPctile >= 95
          ? 'extreme'
          : rvSessionPctile >= 75
            ? 'elevated'
            : rvSessionPctile >= 25
              ? 'normal'
              : 'compressed';
    }
  }

  // ── session profile / VWAP ────────────────────────────────────────────────
  const vwapDistSigma =
    session.vwap > 0 && session.vwapStd > 0 ? (session.last - session.vwap) / session.vwapStd : null;
  const profile = sessionProfile(candles1m, tick);

  // ── flow slopes and shares ────────────────────────────────────────────────
  let cvdSlopePerMin5m: number | null = null;
  {
    const win = bars.filter((b) => b.time >= now - 300_000);
    if (win.length >= 30) {
      const t0 = win[0].time;
      const t1 = win[win.length - 1].time || t0 + 1;
      // cvd series is cumulative; slope of (cvd_i) vs time
      const xs: number[] = [];
      const ys: number[] = [];
      for (const b of win) {
        xs.push((b.time - t0) / 60_000);
        ys.push(b.cvd);
      }
      const mx = mean(xs)!;
      const my = mean(ys)!;
      let num = 0;
      let den = 0;
      for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) ** 2;
      }
      cvdSlopePerMin5m = den > 0 ? num / den : null;
    }
  }

  const win1m = bars.filter((b) => b.time >= now - 60_000);
  const win5m = bars.filter((b) => b.time >= now - 300_000);
  const takerBuyShare = (w: OfFlowBar[]): number | null => {
    const buy = w.reduce((a, b) => a + b.buyVolume, 0);
    const sell = w.reduce((a, b) => a + b.sellVolume, 0);
    return buy + sell > 0 ? buy / (buy + sell) : null;
  };
  const tradesPerSec = win5m.length ? win5m.reduce((a, b) => a + b.trades, 0) / 300 : null;

  return {
    kyleLambdaBpsPer100k,
    vpin,
    amihudBpsPer1m,
    tradeSignAutocorr,
    micropriceSkew,
    lobSlopeBidPerBp,
    lobSlopeAskPerBp,
    obiMean1m,
    atr14,
    atrPct,
    parkinsonAnnPct,
    rvSessionPctile,
    volRegime,
    vwapDistSigma,
    poc: profile?.poc ?? null,
    vah: profile?.vah ?? null,
    val: profile?.val ?? null,
    cvdSlopePerMin5m,
    takerBuyShare1m: takerBuyShare(win1m),
    takerBuyShare5m: takerBuyShare(win5m),
    volumeZ5m,
    tradesPerSec,
  };
}

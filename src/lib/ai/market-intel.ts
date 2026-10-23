// ---------------------------------------------------------------------------
// market-intel — the server-side market intelligence engine powering the
// agentic research desk. Mirrors the Rust analytics core philosophy
// (market.rs / surface.rs / pricing.rs) so AI agents can reason over the
// same market the terminal renders:
//
//   • multi-timeframe OHLCV history (seeded, regime-switching GBM anchored
//     to live spot — stable within a session, realistic regimes)
//   • technical indicator suite (EMA/SMA, RSI, MACD, Bollinger, ATR, ADX,
//     Stochastic, OBV, VWAP)
//   • candlestick pattern detection (12 classical patterns)
//   • chart-structure analysis (swing points, support/resistance clusters,
//     trendlines, double top/bottom, head & shoulders, triangles, channels,
//     flags, Fibonacci retracements)
//   • volatility regime analysis (HV vs IV, term structure, skew, percentiles)
//   • market environment classification + funding/OI/correlation context
//   • Monte Carlo simulation (GBM with fat tails) for likelihood analysis
// ---------------------------------------------------------------------------

import { VOL_CONFIG, atmVol } from '@/lib/pricing';

// --- seeded PRNG -------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function gauss(rnd: () => number): number {
  // Box–Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// --- live market anchors (mirror MarketSim INIT so UI and agents agree) ------

export interface LiveAssetState {
  spot: number;
  volShift: number;
  fundingRate: number;
  change24h: number;
  openInterest: number;
  volume24h: number;
  atmIv30d: number;
}

const ANCHORS: Record<string, Omit<LiveAssetState, 'change24h' | 'atmIv30d' | 'spot'>> = {
  BTC: { volShift: 0.0, fundingRate: 0.091, openInterest: 4.12e9, volume24h: 1.87e9 },
  ETH: { volShift: 0.02, fundingRate: 0.083, openInterest: 2.31e9, volume24h: 9.6e8 },
  SOL: { volShift: -0.01, fundingRate: 0.104, openInterest: 6.4e8, volume24h: 3.1e8 },
};
const BASE_SPOT: Record<string, number> = { BTC: 97450, ETH: 2462, SOL: 138.4 };
export const ASSET_IDS = ['BTC', 'ETH', 'SOL'] as const;
export type AssetId = (typeof ASSET_IDS)[number];

// --- live exchange anchoring ---------------------------------------------------
//
// `primeLiveMarket()` / `primeLiveCandles()` pull REAL data from the connected
// venues (Deribit index + ATM IV, Bybit perp funding/OI/volume, Bybit spot
// klines) into module-level overrides. When the overrides are fresh, the
// classic synchronous accessors (liveMarketState / getCandles) serve real
// exchange data; otherwise they fall back to the seeded simulation. This means
// every downstream consumer — indicators, patterns, S/R, vol regime, Monte
// Carlo — automatically runs on live market data with zero refactor.

interface LivePrime {
  tsMs: number;
  source: string;
  assets: Record<AssetId, Omit<LiveAssetState, 'volShift'>>;
}

let livePrime: LivePrime | null = null;

interface BybitLinearTicker {
  lastPrice?: string;
  fundingRate?: string;
  openInterest?: string;
  turnover24h?: string;
  price24hPcnt?: string;
}

async function primeFetchJson<T>(url: string, timeoutMs = 6000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/** Real ATM IV (~30d) computed straight from the live Deribit chain summary. */
async function deribitAtmIv30d(asset: AssetId): Promise<number | null> {
  try {
    const { deribitSummary, deribitSpot } = await import('./exchange-feeds');
    const [summary, spot] = await Promise.all([deribitSummary(asset), deribitSpot(asset)]);
    const now = Date.now();
    // group mark IVs by expiry, find the expiry closest to 30 days out
    const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const byExpiry = new Map<number, { strike: number; iv: number }[]>();
    for (const s of summary) {
      const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])/.exec(s.instrument_name ?? '');
      if (!m || m[1] !== asset || !s.mark_iv) continue;
      const ms = Date.UTC(2000 + Number(m[4]), MONTHS.indexOf(m[3]), Number(m[2]), 8);
      const arr = byExpiry.get(ms) ?? [];
      arr.push({ strike: Number(m[5]), iv: s.mark_iv });
      byExpiry.set(ms, arr);
    }
    let bestMs = 0;
    let bestDist = Infinity;
    for (const ms of byExpiry.keys()) {
      const d = Math.abs(ms - now - 30 * 86_400_000);
      if (ms > now && d < bestDist) {
        bestDist = d;
        bestMs = ms;
      }
    }
    if (!bestMs) return null;
    const rows = byExpiry.get(bestMs)!;
    let atm = rows[0];
    let best = Infinity;
    for (const r of rows) {
      const d = Math.abs(r.strike - spot);
      if (d < best) {
        best = d;
        atm = r;
      }
    }
    return atm.iv / 100;
  } catch {
    return null;
  }
}

/**
 * Prime the live-market overrides from the connected venues (best-effort —
 * falls back to simulation when every venue is unreachable). Returns true when
 * at least spot was anchored to live data.
 */
export async function primeLiveMarket(): Promise<boolean> {
  if (livePrime && Date.now() - livePrime.tsMs < 30_000) {
    return livePrime.source !== 'simulated';
  }
  try {
    const { getLiveSpots } = await import('./exchange-feeds');
    const spots = await getLiveSpots();
    if (!spots.BTC) throw new Error('no live spots');
    const assets = {} as LivePrime['assets'];
    let source = `live · ${spots.source}`;
    await Promise.all(
      (ASSET_IDS as readonly AssetId[]).map(async (a) => {
        let fundingRate = ANCHORS[a].fundingRate;
        let openInterest = ANCHORS[a].openInterest;
        let volume24h = ANCHORS[a].volume24h;
        let change24h = 0;
        try {
          const r = await primeFetchJson<{ result: { list: BybitLinearTicker[] } }>(
            `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${a}USDT`,
          );
          const tk = r.result?.list?.[0];
          if (tk?.fundingRate != null) fundingRate = Number(tk.fundingRate) * 100 * 3; // 8h rate → daily % ≈ annualized/365 style anchor
          if (tk?.openInterest != null) openInterest = Number(tk.openInterest) * spots[a];
          if (tk?.turnover24h != null) volume24h = Number(tk.turnover24h);
          if (tk?.price24hPcnt != null) change24h = Number(tk.price24hPcnt) * 100;
        } catch {
          /* keep anchors */
        }
        const atm = await deribitAtmIv30d(a);
        assets[a] = {
          spot: spots[a],
          fundingRate,
          change24h,
          openInterest,
          volume24h,
          atmIv30d: atm ?? 0,
        };
      }),
    );
    livePrime = { tsMs: Date.now(), source, assets };
    return true;
  } catch {
    livePrime = { tsMs: Date.now(), source: 'simulated', assets: null as never };
    return false;
  }
}

/** Whether the market state / candles are currently anchored to live venues. */
export function marketDataSource(): 'live' | 'simulated' {
  return livePrime && livePrime.source !== 'simulated' && Date.now() - livePrime.tsMs < 120_000 ? 'live' : 'simulated';
}

/** Live market state: REAL Deribit index spot, REAL Deribit ATM IV, REAL
 *  Bybit funding/OI/flow when primed; seeded simulation otherwise. */
export function liveMarketState(): Record<AssetId, LiveAssetState> & { tsMs: number } {
  const bucket = Math.floor(Date.now() / 30_000);
  const out = {} as Record<AssetId, LiveAssetState>;
  const primed = livePrime && livePrime.source !== 'simulated' && Date.now() - livePrime.tsMs < 120_000;
  for (const a of ASSET_IDS) {
    const rnd = mulberry32(hashString(`${a}-live-${bucket}`));
    const anchor = ANCHORS[a];
    const base = VOL_CONFIG[a];
    if (primed && livePrime!.assets[a]) {
      const p = livePrime!.assets[a];
      const atmIv = p.atmIv30d > 0 ? p.atmIv30d : atmVol(base, 30 / 365, anchor.volShift);
      // volShift re-centres the whole synthetic surface on the REAL ATM level
      const volShift = atmIv / base.atm30d - 1;
      out[a] = {
        spot: p.spot,
        volShift,
        fundingRate: p.fundingRate,
        change24h: p.change24h,
        openInterest: p.openInterest,
        volume24h: p.volume24h,
        atmIv30d: atmIv,
      };
      continue;
    }
    const spot = BASE_SPOT[a] * (1 + (rnd() - 0.5) * 0.004);
    const change24h = (mulberry32(hashString(`${a}-chg-${bucket}`))() - 0.45) * 6;
    out[a] = {
      spot,
      volShift: anchor.volShift,
      fundingRate: Math.min(Math.max(anchor.fundingRate + (rnd() - 0.5) * 0.01, -0.5), 0.9),
      change24h,
      openInterest: anchor.openInterest * (1 + (rnd() - 0.5) * 0.02),
      volume24h: anchor.volume24h * (1 + (rnd() - 0.5) * 0.05),
      atmIv30d: atmVol(base, 30 / 365, anchor.volShift),
    };
  }
  return { ...out, tsMs: Date.now() };
}

// --- OHLCV history --------------------------------------------------------------
//
// Real Bybit spot klines (primed by `primeLiveCandles`) take priority; the
// seeded regime-switching GBM generator is the offline fallback.

const candlePrime = new Map<string, { tsMs: number; candles: Candle[] }>();

/** Prime REAL spot OHLCV from Bybit for all four timeframes (best-effort). */
export async function primeLiveCandles(asset: AssetId): Promise<boolean> {
  const wanted: Timeframe[] = ['15m', '1h', '4h', '1d'];
  const fresh =
    candlePrime.size > 0 &&
    wanted.every((tf) => {
      const e = candlePrime.get(`${asset}:${tf}`);
      return e && Date.now() - e.tsMs < 300_000;
    });
  if (fresh) return true;
  try {
    const { getHistory } = await import('./exchange-feeds');
    await Promise.all(
      wanted.map(async (tf) => {
        try {
          const bars = await getHistory(asset, tf, 400);
          const candles: Candle[] = bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
          candlePrime.set(`${asset}:${tf}`, { tsMs: Date.now(), candles });
        } catch {
          /* keep synthetic for this timeframe */
        }
      }),
    );
    return wanted.some((tf) => candlePrime.has(`${asset}:${tf}`));
  } catch {
    return false;
  }
}

/** Historical OHLCV: REAL exchange klines when primed, else seeded GBM. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Timeframe = '15m' | '1h' | '4h' | '1d';

const TF_MS: Record<Timeframe, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

interface Regime {
  drift: number;
  volMult: number;
}

const REGIMES: Record<string, Regime> = {
  bull: { drift: 0.0016, volMult: 0.85 },
  bear: { drift: -0.0022, volMult: 1.55 },
  chop: { drift: 0.0000, volMult: 1.0 },
  squeeze: { drift: 0.0004, volMult: 0.55 },
};

/** Historical OHLCV: REAL exchange klines when primed, else seeded GBM
 *  (the generator below anchors its final close to the live spot). */
export function getCandles(asset: AssetId, timeframe: Timeframe, count: number): Candle[] {
  const n = Math.min(Math.max(count, 30), 400);
  const primed = candlePrime.get(`${asset}:${timeframe}`);
  if (primed && Date.now() - primed.tsMs < 300_000 && primed.candles.length >= 30) {
    return primed.candles.slice(-n);
  }
  const dayBucket = Math.floor(Date.now() / 86_400_000);
  const rnd = mulberry32(hashString(`volos-hist-${asset}-${timeframe}-${dayBucket}`));
  const tfMs = TF_MS[timeframe];
  const stepsPerYear = (365 * 86_400_000) / tfMs;
  const baseVol = VOL_CONFIG[asset].atm30d / Math.sqrt(stepsPerYear);

  let regime: keyof typeof REGIMES = 'chop';
  let regimeAge = 0;
  let vol = baseVol;
  const path: number[] = [1];
  const vols: number[] = [baseVol];
  let price = 1;

  for (let i = 0; i < n + 60; i++) {
    // regime switching with persistence
    if (rnd() < 0.025 || regimeAge > 90) {
      const roll = rnd();
      regime = roll < 0.34 ? 'bull' : roll < 0.58 ? 'bear' : roll < 0.88 ? 'chop' : 'squeeze';
      regimeAge = 0;
    }
    regimeAge += 1;
    // volatility clustering (slow mean reversion toward regime level)
    const targetVol = baseVol * REGIMES[regime].volMult;
    vol = vol * 0.94 + targetVol * 0.06 * (1 + 0.5 * (rnd() - 0.5));
    // fat tails: occasional 3σ shocks
    const tail = rnd() < 0.01 ? 3 : 1;
    const z = gauss(rnd) * tail;
    const drift = REGIMES[regime].drift;
    price *= Math.exp(drift - 0.5 * vol * vol + vol * z);
    path.push(price);
    vols.push(vol);
  }

  // rescale so the last close equals the live spot
  const live = liveMarketState()[asset];
  const scale = live.spot / path[path.length - 1];
  const now = Date.now();
  const candles: Candle[] = [];
  const baseVolume = asset === 'BTC' ? 4.2e4 : asset === 'ETH' ? 5.1e5 : 2.2e6;

  for (let i = 1; i < path.length; i++) {
    const o = path[i - 1] * scale;
    const c = path[i] * scale;
    const sigma = vols[i];
    const wickUp = Math.abs(gauss(rnd)) * sigma * 0.7;
    const wickDn = Math.abs(gauss(rnd)) * sigma * 0.7;
    const h = Math.max(o, c) * (1 + wickUp);
    const l = Math.min(o, c) * (1 - wickDn);
    const ret = Math.abs(Math.log(c / o));
    const v = baseVolume * (0.45 + 1.8 * (ret / sigma) + rnd() * 0.7);
    candles.push({
      t: now - (path.length - 1 - i) * tfMs,
      o,
      h,
      l,
      c,
      v: Math.round(v),
    });
  }

  return candles.slice(-n);
}

// --- indicator suite ----------------------------------------------------------

export interface TechnicalSnapshot {
  asset: string;
  timeframe: string;
  lastClose: number;
  changePct: number;
  trend: {
    ema20: number;
    ema50: number;
    ema200: number;
    sma20: number;
    alignment: 'bullish' | 'bearish' | 'mixed';
    ema50SlopePct: number;
    priceVsEma200Pct: number;
  };
  momentum: {
    rsi14: number;
    rsiPrev: number;
    rsiZone: 'oversold' | 'neutral' | 'overbought';
    macd: number;
    macdSignal: number;
    macdHist: number;
    macdCross: 'bullish' | 'bearish' | 'none';
    stochK: number;
    stochD: number;
    roc10: number;
  };
  volatility: {
    atr14: number;
    atrPct: number;
    bbUpper: number;
    bbMid: number;
    bbLower: number;
    bbWidthPct: number;
    bbPercentB: number;
    squeeze: boolean;
  };
  volume: {
    lastVsAvg20: number;
    obvTrend: 'rising' | 'falling' | 'flat';
    vwap20: number;
    priceVsVwapPct: number;
  };
  strength: {
    adx14: number;
    plusDi: number;
    minusDi: number;
    trendStrength: 'strong' | 'weak';
  };
  biasScore: number; // -1..1 composite
  biasLabel: 'strongly bullish' | 'bullish' | 'neutral' | 'bearish' | 'strongly bearish';
  signals: string[];
}

export function ema(vals: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = vals[0];
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function sma(vals: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    out.push(i >= period - 1 ? sum / period : vals[i]);
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const out: number[] = [50];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }
  return out;
}

export function macd(closes: number[]): { macd: number[]; signal: number[]; hist: number[] } {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const m = closes.map((_, i) => e12[i] - e26[i]);
  const s = ema(m, 9);
  return { macd: m, signal: s, hist: m.map((v, i) => v - s[i]) };
}

export function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const from = Math.max(0, i - period + 1);
    const win = closes.slice(from, i + 1);
    const mean = mid[i];
    const variance = win.reduce((a, v) => a + (v - mean) ** 2, 0) / win.length;
    const sd = Math.sqrt(variance);
    upper.push(mean + mult * sd);
    lower.push(mean - mult * sd);
  }
  return { upper, mid, lower };
}

export function atr(candles: Candle[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trs.push(candles[0].h - candles[0].l);
    } else {
      const c = candles[i];
      const p = candles[i - 1].c;
      trs.push(Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p)));
    }
  }
  return ema(trs, period);
}

export function stochastic(candles: Candle[], period = 14) {
  const ks: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const from = Math.max(0, i - period + 1);
    const win = candles.slice(from, i + 1);
    const hh = Math.max(...win.map((c) => c.h));
    const ll = Math.min(...win.map((c) => c.l));
    ks.push(hh === ll ? 50 : ((candles[i].c - ll) / (hh - ll)) * 100);
  }
  const ds = sma(ks, 3);
  return { k: ks, d: ds };
}

export function adx(candles: Candle[], period = 14) {
  const plusDms: number[] = [0];
  const minusDms: number[] = [0];
  const trs: number[] = [candles[0].h - candles[0].l];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const dn = candles[i - 1].l - candles[i].l;
    plusDms.push(up > dn && up > 0 ? up : 0);
    minusDms.push(dn > up && dn > 0 ? dn : 0);
    const c = candles[i];
    const p = candles[i - 1].c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p)));
  }
  const trS = ema(trs, period);
  const pS = ema(plusDms, period);
  const mS = ema(minusDms, period);
  const plusDi = (pS[pS.length - 1] / trS[trS.length - 1]) * 100;
  const minusDi = (mS[mS.length - 1] / trS[trS.length - 1]) * 100;
  const dx = trs.map((_, i) => {
    const pdi = (pS[i] / Math.max(trS[i], 1e-9)) * 100;
    const mdi = (mS[i] / Math.max(trS[i], 1e-9)) * 100;
    const sum = pdi + mdi;
    return sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
  });
  const adxV = ema(dx, period)[dx.length - 1];
  return { adx: adxV, plusDi, minusDi };
}

export function obv(candles: Candle[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = out[i - 1];
    if (candles[i].c > candles[i - 1].c) out.push(prev + candles[i].v);
    else if (candles[i].c < candles[i - 1].c) out.push(prev - candles[i].v);
    else out.push(prev);
  }
  return out;
}

export function vwap(candles: Candle[], period = 20): number {
  const win = candles.slice(-period);
  let pv = 0;
  let vol = 0;
  for (const c of win) {
    const typical = (c.h + c.l + c.c) / 3;
    pv += typical * c.v;
    vol += c.v;
  }
  return vol === 0 ? win[win.length - 1].c : pv / vol;
}

export function computeTechnicalSnapshot(asset: AssetId, timeframe: Timeframe): TechnicalSnapshot {
  const candles = getCandles(asset, timeframe, 240);
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const s20 = sma(closes, 20);
  const r = rsi(closes);
  const m = macd(closes);
  const bb = bollinger(closes);
  const a = atr(candles);
  const st = stochastic(candles);
  const ad = adx(candles);
  const o = obv(candles);
  const vw = vwap(candles);
  const volAvg = candles.slice(-21, -1).reduce((s, c) => s + c.v, 0) / 20;
  const volLast = candles[candles.length - 1].v;
  const i = closes.length - 1;
  const lookback = Math.min(120, closes.length - 1);
  const changePct = ((last - closes[closes.length - 1 - lookback]) / closes[closes.length - 1 - lookback]) * 100;

  const emaBull = e20[i] > e50[i] && e50[i] > e200[i];
  const emaBear = e20[i] < e50[i] && e50[i] < e200[i];
  const alignment = emaBull ? 'bullish' : emaBear ? 'bearish' : 'mixed';

  const rsiV = r[i];
  const macdCross =
    m.hist[i] > 0 && m.hist[i - 1] <= 0 ? 'bullish' : m.hist[i] < 0 && m.hist[i - 1] >= 0 ? 'bearish' : 'none';

  const bbWidth = ((bb.upper[i] - bb.lower[i]) / bb.mid[i]) * 100;
  const bbWidthAvg =
    bollinger(closes.slice(0, -1)).upper.slice(-60).length > 0
      ? (() => {
          const prev = bollinger(closes.slice(0, -1));
          let sum = 0;
          for (let j = Math.max(0, i - 60); j < i; j++) {
            sum += ((prev.upper[j] - prev.lower[j]) / prev.mid[j]) * 100;
          }
          return sum / Math.max(1, i - Math.max(0, i - 60));
        })()
      : bbWidth;
  const percentB = (last - bb.lower[i]) / Math.max(bb.upper[i] - bb.lower[i], 1e-9);

  const obvRising = o[i] > o[Math.max(0, i - 20)] * 1.001;
  const obvFalling = o[i] < o[Math.max(0, i - 20)] * 0.999;

  const signals: string[] = [];
  if (alignment === 'bullish') signals.push('EMA 20/50/200 stacked bullish (uptrend structure)');
  if (alignment === 'bearish') signals.push('EMA 20/50/200 stacked bearish (downtrend structure)');
  if (alignment === 'mixed') signals.push('EMA structure mixed — no clean trend');
  if (rsiV > 70) signals.push(`RSI ${rsiV.toFixed(0)} overbought — momentum stretched`);
  else if (rsiV < 30) signals.push(`RSI ${rsiV.toFixed(0)} oversold — downside exhaustion possible`);
  else signals.push(`RSI ${rsiV.toFixed(0)} neutral zone`);
  if (macdCross === 'bullish') signals.push('MACD fresh bullish crossover');
  if (macdCross === 'bearish') signals.push('MACD fresh bearish crossover');
  if (m.hist[i] > 0) signals.push('MACD histogram positive (bullish momentum)');
  else signals.push('MACD histogram negative (bearish momentum)');
  if (bbWidth < bbWidthAvg * 0.7) signals.push(`Bollinger width ${bbWidth.toFixed(1)}% — volatility squeeze (breakout risk)`);
  if (percentB > 1) signals.push('Price riding above upper Bollinger band');
  if (percentB < 0) signals.push('Price below lower Bollinger band');
  if (obvRising) signals.push('OBV rising — volume confirms buyers');
  else if (obvFalling) signals.push('OBV falling — volume favors sellers');
  if (last > vw) signals.push(`Price above VWAP(${(last / vw - 1) * 100 > 0 ? '+' : ''}${((last / vw - 1) * 100).toFixed(2)}%) — intraday demand`);
  else signals.push(`Price below VWAP (${((last / vw - 1) * 100).toFixed(2)}%) — intraday supply`);
  if (ad.adx > 25) signals.push(`ADX ${ad.adx.toFixed(0)} — ${ad.plusDi > ad.minusDi ? 'strong uptrend' : 'strong downtrend'}`);
  else signals.push(`ADX ${ad.adx.toFixed(0)} — trendless / range regime`);

  let score = 0;
  score += alignment === 'bullish' ? 0.3 : alignment === 'bearish' ? -0.3 : 0;
  score += (rsiV - 50) / 100;
  score += m.hist[i] > 0 ? 0.15 : -0.15;
  score += last > e200[i] ? 0.15 : -0.15;
  score += obvRising ? 0.1 : obvFalling ? -0.1 : 0;
  score += last > vw ? 0.1 : -0.1;
  score += ad.plusDi > ad.minusDi ? 0.1 : -0.1;
  score = Math.max(-1, Math.min(1, score));

  const biasLabel =
    score > 0.45 ? 'strongly bullish' : score > 0.15 ? 'bullish' : score < -0.45 ? 'strongly bearish' : score < -0.15 ? 'bearish' : 'neutral';

  return {
    asset,
    timeframe,
    lastClose: last,
    changePct,
    trend: {
      ema20: e20[i],
      ema50: e50[i],
      ema200: e200[i],
      sma20: s20[i],
      alignment,
      ema50SlopePct: ((e50[i] - e50[Math.max(0, i - 10)]) / e50[Math.max(0, i - 10)]) * 100,
      priceVsEma200Pct: ((last - e200[i]) / e200[i]) * 100,
    },
    momentum: {
      rsi14: rsiV,
      rsiPrev: r[Math.max(0, i - 3)],
      rsiZone: rsiV > 70 ? 'overbought' : rsiV < 30 ? 'oversold' : 'neutral',
      macd: m.macd[i],
      macdSignal: m.signal[i],
      macdHist: m.hist[i],
      macdCross,
      stochK: st.k[i],
      stochD: st.d[i],
      roc10: ((last - closes[Math.max(0, i - 10)]) / closes[Math.max(0, i - 10)]) * 100,
    },
    volatility: {
      atr14: a[i],
      atrPct: (a[i] / last) * 100,
      bbUpper: bb.upper[i],
      bbMid: bb.mid[i],
      bbLower: bb.lower[i],
      bbWidthPct: bbWidth,
      bbPercentB: percentB,
      squeeze: bbWidth < bbWidthAvg * 0.7,
    },
    volume: {
      lastVsAvg20: volLast / Math.max(volAvg, 1),
      obvTrend: obvRising ? 'rising' : obvFalling ? 'falling' : 'flat',
      vwap20: vw,
      priceVsVwapPct: ((last - vw) / vw) * 100,
    },
    strength: {
      adx14: ad.adx,
      plusDi: ad.plusDi,
      minusDi: ad.minusDi,
      trendStrength: ad.adx > 25 ? 'strong' : 'weak',
    },
    biasScore: score,
    biasLabel,
    signals,
  };
}

// --- candlestick patterns -------------------------------------------------------

export interface PatternHit {
  name: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  strength: number; // 0..1
  barsAgo: number;
  detail: string;
}

export function detectCandlestickPatterns(asset: AssetId, timeframe: Timeframe, scan = 40): PatternHit[] {
  const candles = getCandles(asset, timeframe, 240);
  const hits: PatternHit[] = [];
  const n = candles.length;
  const body = (c: Candle) => Math.abs(c.c - c.o);
  const range = (c: Candle) => Math.max(c.h - c.l, 1e-9);
  const upper = (c: Candle) => c.h - Math.max(c.c, c.o);
  const lower = (c: Candle) => Math.min(c.c, c.o) - c.l;
  const bullish = (c: Candle) => c.c > c.o;

  for (let i = Math.max(2, n - scan); i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const p2 = candles[i - 2];
    const barsAgo = n - 1 - i;
    const avgBody = candles.slice(Math.max(0, i - 14), i).reduce((s, x) => s + body(x), 0) / Math.max(1, Math.min(14, i));

    // doji
    if (body(c) / range(c) < 0.08 && range(c) / c.c > 0.002) {
      hits.push({ name: 'Doji', bias: 'neutral', strength: 0.4, barsAgo, detail: 'Indecision — buyers and sellers balanced at this level' });
    }
    // hammer
    if (lower(c) > body(c) * 2 && upper(c) < body(c) * 0.8 && body(c) / range(c) < 0.4 && c.l < p.l) {
      hits.push({ name: 'Hammer', bias: 'bullish', strength: 0.7, barsAgo, detail: 'Long lower wick rejection of lows — demand stepped in' });
    }
    // shooting star
    if (upper(c) > body(c) * 2 && lower(c) < body(c) * 0.8 && body(c) / range(c) < 0.4 && c.h > p.h) {
      hits.push({ name: 'Shooting Star', bias: 'bearish', strength: 0.7, barsAgo, detail: 'Long upper wick rejection of highs — supply absorbed' });
    }
    // engulfing
    if (bullish(c) && !bullish(p) && c.c > p.o && c.o < p.c && body(c) > body(p) * 1.2) {
      hits.push({ name: 'Bullish Engulfing', bias: 'bullish', strength: 0.8, barsAgo, detail: 'Bull body fully engulfs prior bear candle — momentum flip up' });
    }
    if (!bullish(c) && bullish(p) && c.c < p.o && c.o > p.c && body(c) > body(p) * 1.2) {
      hits.push({ name: 'Bearish Engulfing', bias: 'bearish', strength: 0.8, barsAgo, detail: 'Bear body fully engulfs prior bull candle — momentum flip down' });
    }
    // harami
    if (!bullish(p) && bullish(c) && c.h < p.h && c.l > p.l && body(c) < body(p) * 0.6) {
      hits.push({ name: 'Bullish Harami', bias: 'bullish', strength: 0.5, barsAgo, detail: 'Inside bar reversal — selling pressure fading' });
    }
    if (bullish(p) && !bullish(c) && c.h < p.h && c.l > p.l && body(c) < body(p) * 0.6) {
      hits.push({ name: 'Bearish Harami', bias: 'bearish', strength: 0.5, barsAgo, detail: 'Inside bar stall — buying pressure fading' });
    }
    // morning star
    if (i >= 2 && !bullish(p2) && body(p) < avgBody * 0.5 && bullish(c) && c.c > (p2.o + p2.c) / 2) {
      hits.push({ name: 'Morning Star', bias: 'bullish', strength: 0.85, barsAgo, detail: 'Three-bar bottoming structure — capitulation then recovery' });
    }
    // evening star
    if (i >= 2 && bullish(p2) && body(p) < avgBody * 0.5 && !bullish(c) && c.c < (p2.o + p2.c) / 2) {
      hits.push({ name: 'Evening Star', bias: 'bearish', strength: 0.85, barsAgo, detail: 'Three-bar topping structure — euphoria then rejection' });
    }
    // three soldiers / crows
    if (i >= 2 && bullish(c) && bullish(p) && bullish(p2) && c.c > p.c && p.c > p2.c && body(c) > avgBody * 0.8) {
      hits.push({ name: 'Three White Soldiers', bias: 'bullish', strength: 0.75, barsAgo, detail: 'Three consecutive strong up-closes — sustained accumulation' });
    }
    if (i >= 2 && !bullish(c) && !bullish(p) && !bullish(p2) && c.c < p.c && p.c < p2.c && body(c) > avgBody * 0.8) {
      hits.push({ name: 'Three Black Crows', bias: 'bearish', strength: 0.75, barsAgo, detail: 'Three consecutive strong down-closes — sustained distribution' });
    }
    // marubozu
    if (body(c) / range(c) > 0.92 && body(c) > avgBody * 1.8) {
      hits.push({
        name: bullish(c) ? 'Bullish Marubozu' : 'Bearish Marubozu',
        bias: bullish(c) ? 'bullish' : 'bearish',
        strength: 0.65,
        barsAgo,
        detail: 'Full-body candle with almost no wicks — one-sided conviction',
      });
    }
  }

  // keep most recent + strongest, dedupe by name keeping strongest recent
  const byName = new Map<string, PatternHit>();
  for (const h of hits) {
    const prev = byName.get(h.name);
    if (!prev || h.strength * (1 - h.barsAgo * 0.01) > prev.strength * (1 - prev.barsAgo * 0.01)) {
      byName.set(h.name, h);
    }
  }
  return [...byName.values()].sort((a, b) => a.barsAgo - b.barsAgo).slice(0, 8);
}

// --- chart structure -------------------------------------------------------------

export interface SRLevel {
  price: number;
  kind: 'support' | 'resistance';
  touches: number;
  strength: number; // 0..1
  distancePct: number;
}

interface Swing {
  idx: number;
  price: number;
  kind: 'high' | 'low';
}

function findSwings(candles: Candle[], leftRight = 4): Swing[] {
  const swings: Swing[] = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const win = candles.slice(i - leftRight, i + leftRight + 1);
    const c = candles[i];
    if (c.h === Math.max(...win.map((x) => x.h))) swings.push({ idx: i, price: c.h, kind: 'high' });
    if (c.l === Math.min(...win.map((x) => x.l))) swings.push({ idx: i, price: c.l, kind: 'low' });
  }
  return swings;
}

export function detectSupportResistance(asset: AssetId, timeframe: Timeframe): SRLevel[] {
  const candles = getCandles(asset, timeframe, 240);
  const last = candles[candles.length - 1].c;
  const swings = findSwings(candles);
  const levels: SRLevel[] = [];
  // cluster swing points within 0.6% tolerance
  const tol = last * 0.006;
  const clusters: { prices: number[]; idxs: number[]; kind: 'high' | 'low' }[] = [];
  for (const s of swings) {
    const cl = clusters.find((c) => c.kind === s.kind && Math.abs(c.prices[c.prices.length - 1] - s.price) < tol);
    if (cl) {
      cl.prices.push(s.price);
      cl.idxs.push(s.idx);
    } else {
      clusters.push({ prices: [s.price], idxs: [s.idx], kind: s.kind });
    }
  }
  for (const cl of clusters) {
    const avg = cl.prices.reduce((a, b) => a + b, 0) / cl.prices.length;
    const lastTouch = Math.max(...cl.idxs);
    const recency = 1 - Math.min(1, (candles.length - lastTouch) / candles.length);
    const level: SRLevel = {
      price: avg,
      kind: cl.kind === 'high' ? 'resistance' : 'support',
      touches: cl.prices.length,
      strength: Math.min(1, cl.prices.length / 4) * 0.7 + recency * 0.3,
      distancePct: ((avg - last) / last) * 100,
    };
    levels.push(level);
  }
  return levels
    .filter((l) => Math.abs(l.distancePct) < 25)
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
    .slice(0, 6);
}

export interface TrendlineHit {
  kind: 'ascending' | 'descending' | 'horizontal';
  from: number;
  to: number;
  touches: number;
  slopePctPerBar: number;
  note: string;
}

export function detectTrendlines(asset: AssetId, timeframe: Timeframe): TrendlineHit[] {
  const candles = getCandles(asset, timeframe, 240);
  const swings = findSwings(candles);
  const n = candles.length;
  const out: TrendlineHit[] = [];

  const fitLine = (pts: Swing[]): { slope: number; intercept: number } => {
    const xs = pts.map((p) => p.idx);
    const ys = pts.map((p) => p.price);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    return { slope, intercept: my - slope * mx };
  };

  // support trendline from swing lows; resistance from swing highs
  for (const kind of ['low', 'high'] as const) {
    const pts = swings.filter((s) => s.kind === kind).slice(-5);
    if (pts.length >= 2) {
      const { slope, intercept } = fitLine(pts);
      const lastPx = slope * (n - 1) + intercept;
      // count touches: price within 0.4% of the line
      let touches = 0;
      for (let i = 0; i < n; i++) {
        const linePx = slope * i + intercept;
        const px = kind === 'low' ? candles[i].l : candles[i].h;
        if (Math.abs(px - linePx) / linePx < 0.004) touches += 1;
      }
      const slopePct = (slope / lastPx) * 100;
      const isAsc = slopePct > 0.02;
      const isDesc = slopePct < -0.02;
      out.push({
        kind: isAsc ? 'ascending' : isDesc ? 'descending' : 'horizontal',
        from: intercept,
        to: lastPx,
        touches,
        slopePctPerBar: slopePct,
        note:
          kind === 'low'
            ? isAsc
              ? 'Rising support trendline — higher lows structure intact'
              : 'Flat/declining support trendline — watch for breakdown'
            : isDesc
              ? 'Falling resistance trendline — lower highs pressure'
              : 'Flat resistance trendline — supply ceiling',
      });
    }
  }
  return out;
}

export interface ChartPatternHit {
  name: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  detail: string;
  target?: number;
  invalidation?: number;
}

export function detectChartPatterns(asset: AssetId, timeframe: Timeframe): ChartPatternHit[] {
  const candles = getCandles(asset, timeframe, 240);
  const last = candles[candles.length - 1].c;
  const swings = findSwings(candles, 5);
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');
  const out: ChartPatternHit[] = [];

  // double top / bottom (last two comparable swing extremes)
  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    if (Math.abs(a.price - b.price) / b.price < 0.02 && b.idx - a.idx > 8) {
      const neckline = Math.min(...candles.slice(a.idx, b.idx).map((c) => c.l));
      out.push({
        name: 'Double Top',
        bias: 'bearish',
        confidence: 0.7,
        detail: `Two rejections near ${(a.price + b.price) / 2}. Neckline ${neckline.toFixed(0)}.`,
        target: neckline - (neckline - (a.price + b.price) / 2),
        invalidation: b.price * 1.015,
      });
    }
  }
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    if (Math.abs(a.price - b.price) / b.price < 0.02 && b.idx - a.idx > 8) {
      const neckline = Math.max(...candles.slice(a.idx, b.idx).map((c) => c.h));
      out.push({
        name: 'Double Bottom',
        bias: 'bullish',
        confidence: 0.7,
        detail: `Two defenses near ${(a.price + b.price) / 2}. Neckline ${neckline.toFixed(0)}.`,
        target: neckline + (neckline - (a.price + b.price) / 2),
        invalidation: b.price * 0.985,
      });
    }
  }

  // head & shoulders / inverse
  if (highs.length >= 3) {
    const [l, h, r] = highs.slice(-3);
    if (h.price > l.price * 1.01 && h.price > r.price * 1.01 && Math.abs(l.price - r.price) / l.price < 0.03) {
      out.push({
        name: 'Head and Shoulders',
        bias: 'bearish',
        confidence: 0.75,
        detail: `Head ${h.price.toFixed(0)} between shoulders ~${((l.price + r.price) / 2).toFixed(0)} — classic distribution top.`,
        target: h.price - (h.price - (l.price + r.price) / 2) * 2,
        invalidation: h.price * 1.01,
      });
    }
  }
  if (lows.length >= 3) {
    const [l, h, r] = lows.slice(-3);
    if (h.price < l.price * 0.99 && h.price < r.price * 0.99 && Math.abs(l.price - r.price) / l.price < 0.03) {
      out.push({
        name: 'Inverse Head and Shoulders',
        bias: 'bullish',
        confidence: 0.75,
        detail: `Head ${h.price.toFixed(0)} between shoulders ~${((l.price + r.price) / 2).toFixed(0)} — accumulation bottom.`,
        target: h.price + (((l.price + r.price) / 2) - h.price) * 2,
        invalidation: h.price * 0.99,
      });
    }
  }

  // triangles via last 6 swings regression
  if (highs.length >= 2 && lows.length >= 2) {
    const hs = highs.slice(-3);
    const ls = lows.slice(-3);
    const hSlope = (hs[hs.length - 1].price - hs[0].price) / Math.max(1, hs[hs.length - 1].idx - hs[0].idx);
    const lSlope = (ls[ls.length - 1].price - ls[0].price) / Math.max(1, ls[ls.length - 1].idx - ls[0].idx);
    if (hSlope < -last * 0.0002 && lSlope > last * 0.0002) {
      out.push({
        name: 'Symmetrical Triangle',
        bias: 'neutral',
        confidence: 0.6,
        detail: 'Converging highs and lows — coiling for a volatility expansion breakout.',
      });
    } else if (Math.abs(hSlope) < last * 0.0001 && lSlope > last * 0.0002) {
      out.push({
        name: 'Ascending Triangle',
        bias: 'bullish',
        confidence: 0.65,
        detail: 'Flat resistance with rising lows — buyers pressing a supply shelf.',
        target: hs[hs.length - 1].price * 1.04,
      });
    } else if (Math.abs(lSlope) < last * 0.0001 && hSlope < -last * 0.0002) {
      out.push({
        name: 'Descending Triangle',
        bias: 'bearish',
        confidence: 0.65,
        detail: 'Flat support with falling highs — sellers grinding demand down.',
        target: ls[ls.length - 1].price * 0.96,
      });
    }
  }

  // channel detection
  {
    const hs = highs.slice(-4);
    const ls = lows.slice(-4);
    if (hs.length >= 2 && ls.length >= 2) {
      const hSlope = (hs[hs.length - 1].price - hs[0].price) / Math.max(1, hs[hs.length - 1].idx - hs[0].idx);
      const lSlope = (ls[ls.length - 1].price - ls[0].price) / Math.max(1, ls[ls.length - 1].idx - ls[0].idx);
      if (hSlope > last * 0.0003 && lSlope > last * 0.0003) {
        out.push({ name: 'Ascending Channel', bias: 'bullish', confidence: 0.6, detail: 'Parallel higher highs and higher lows — orderly uptrend.' });
      } else if (hSlope < -last * 0.0003 && lSlope < -last * 0.0003) {
        out.push({ name: 'Descending Channel', bias: 'bearish', confidence: 0.6, detail: 'Parallel lower highs and lower lows — orderly downtrend.' });
      }
    }
  }

  // bull/bear flag: strong impulse then tight consolidation
  const win = candles.slice(-30);
  const first10 = win.slice(0, 10);
  const last10 = win.slice(-10);
  const impulse = (first10[first10.length - 1].c - first10[0].o) / first10[0].o;
  const consolidation = (last10[last10.length - 1].c - last10[0].o) / last10[0].o;
  const consRange = (Math.max(...last10.map((c) => c.h)) - Math.min(...last10.map((c) => c.l))) / last;
  if (impulse > 0.05 && Math.abs(consolidation) < 0.015 && consRange < 0.03) {
    out.push({ name: 'Bull Flag', bias: 'bullish', confidence: 0.65, detail: `+${(impulse * 100).toFixed(1)}% impulse into a tight flag — continuation setup.`, target: last * (1 + impulse) });
  }
  if (impulse < -0.05 && Math.abs(consolidation) < 0.015 && consRange < 0.03) {
    out.push({ name: 'Bear Flag', bias: 'bearish', confidence: 0.65, detail: `${(impulse * 100).toFixed(1)}% impulse into a tight flag — continuation setup.`, target: last * (1 + impulse) });
  }

  return out.slice(0, 5);
}

export interface FibLevel {
  ratio: string;
  price: number;
  kind: 'support' | 'resistance';
}

export function fibLevels(asset: AssetId, timeframe: Timeframe): FibLevel[] {
  const candles = getCandles(asset, timeframe, 180);
  const win = candles.slice(-90);
  const hi = Math.max(...win.map((c) => c.h));
  const lo = Math.min(...win.map((c) => c.l));
  const last = candles[candles.length - 1].c;
  const upMove = win[win.length - 1].t > win[0].t && last > (hi + lo) / 2;
  const ratios: [string, number][] = [
    ['0.236', 0.236],
    ['0.382', 0.382],
    ['0.5', 0.5],
    ['0.618', 0.618],
    ['0.786', 0.786],
  ];
  return ratios.map(([ratio, r]) => {
    const price = upMove ? hi - (hi - lo) * r : lo + (hi - lo) * r;
    return { ratio, price, kind: price < last ? 'support' : 'resistance' };
  });
}

// --- volatility regime -------------------------------------------------------------

export interface VolRegime {
  asset: string;
  atmIv7: number;
  atmIv30: number;
  atmIv90: number;
  termStructure: 'contango' | 'backwardation' | 'flat';
  skew25d: number; // put IV - call IV (positive = put skew)
  skewRegime: string;
  hv20: number;
  hv60: number;
  ivHvSpread: number;
  ivPercentile: number; // 0..100 within its own 1y distribution
  regime: 'low-vol' | 'normal' | 'elevated' | 'crisis';
  interpretation: string[];
}

export function analyzeVolRegime(asset: AssetId): VolRegime {
  const cfg = VOL_CONFIG[asset];
  const live = liveMarketState()[asset];
  const candles = getCandles(asset, '1d', 240);
  const closes = candles.map((c) => c.c);
  const hv = (window: number) => {
    const w = closes.slice(-window - 1);
    const rets = w.slice(1).map((c, i) => Math.log(c / w[i]));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(variance * 365);
  };
  const hv20 = hv(20);
  const hv60 = hv(60);
  const atmIv7 = atmVol(cfg, 7 / 365, live.volShift);
  const atmIv30 = live.atmIv30d;
  const atmIv90 = atmVol(cfg, 90 / 365, live.volShift);
  const termStructure = atmIv90 > atmIv30 * 1.03 ? 'contango' : atmIv90 < atmIv30 * 0.97 ? 'backwardation' : 'flat';
  const spot = live.spot;
  const putIv = atmVol(cfg, 30 / 365, live.volShift) * (1 + 0.06 + Math.abs(cfg.skew) * 0.05);
  const callIv = atmVol(cfg, 30 / 365, live.volShift) * (1 - 0.02);
  const skew25d = putIv - callIv;

  // IV percentile: simulated position of current IV in a 1y range
  const ivMin = cfg.atm30d * 0.62;
  const ivMax = cfg.atm30d * 1.75;
  const ivPercentile = Math.min(100, Math.max(0, ((atmIv30 - ivMin) / (ivMax - ivMin)) * 100));

  const regime = ivPercentile > 85 || hv20 > cfg.atm30d * 1.5 ? 'crisis' : ivPercentile > 65 ? 'elevated' : ivPercentile < 25 ? 'low-vol' : 'normal';

  const interp: string[] = [];
  interp.push(`ATM IV: 7d ${(atmIv7 * 100).toFixed(0)}% · 30d ${(atmIv30 * 100).toFixed(0)}% · 90d ${(atmIv90 * 100).toFixed(0)}% — term structure ${termStructure}.`);
  interp.push(`Realized vol 20d ${(hv20 * 100).toFixed(0)}% vs 60d ${(hv60 * 100).toFixed(0)}% — ${hv20 > hv60 ? 'realized vol expanding' : 'realized vol compressing'}.`);
  interp.push(`IV−HV spread: ${((atmIv30 - hv20) * 100).toFixed(1)} vol pts — ${atmIv30 > hv20 * 1.15 ? 'options rich vs realized: premium selling favored' : atmIv30 < hv20 * 0.9 ? 'options cheap vs realized: premium buying favored' : 'options fairly priced vs realized'}.`);
  interp.push(`25-delta skew ${(skew25d * 100).toFixed(1)} vol pts — ${skew25d > 0.04 ? 'meaningful downside put skew (hedging demand)' : 'balanced wing pricing'}.`);
  interp.push(`IV percentile ${ivPercentile.toFixed(0)}% — regime: ${regime}. ${regime === 'low-vol' ? 'Long-vol / structure setups have attractive entry.' : regime === 'crisis' ? 'De-risk premium selling; expect vol mean-reversion only after stabilization.' : 'Standard structure selection applies.'}`);

  return {
    asset,
    atmIv7,
    atmIv30,
    atmIv90,
    termStructure,
    skew25d,
    skewRegime: skew25d > 0.04 ? 'put-skewed' : 'balanced',
    hv20,
    hv60,
    ivHvSpread: atmIv30 - hv20,
    ivPercentile,
    regime,
    interpretation: interp,
  };
}

// --- market environment -------------------------------------------------------------

export interface EnvScenario {
  name: string;
  probability: number;
  spotMovePct: number;
  ivResponsePct: number;
  horizonDays: number;
  description: string;
}

export interface MarketEnvironment {
  asset: string;
  spot: number;
  regime: 'bull-trend' | 'bear-trend' | 'range' | 'high-vol';
  regimeDescription: string;
  funding: { rate: number; annualizedPct: number; stance: string };
  openInterest: { usd: number; trend: string };
  volume24h: number;
  crossAsset: { assets: string[]; matrix: number[][]; interpretation: string };
  macro: string[];
  scenarios: EnvScenario[];
}

export function analyzeMarketEnvironment(asset: AssetId): MarketEnvironment {
  const live = liveMarketState();
  const a = live[asset];
  const snap = computeTechnicalSnapshot(asset, '1d');
  const vol = analyzeVolRegime(asset);

  let regime: MarketEnvironment['regime'];
  if (snap.strength.adx14 > 25 && snap.biasScore > 0.2) regime = 'bull-trend';
  else if (snap.strength.adx14 > 25 && snap.biasScore < -0.2) regime = 'bear-trend';
  else if (vol.regime === 'crisis' || vol.atmIv30 > 0.9) regime = 'high-vol';
  else regime = 'range';

  const regimeDescription = {
    'bull-trend': 'Trending market with directional momentum — trend-following and defined-risk directional structures favored.',
    'bear-trend': 'Downtrend with momentum — downside expressions and hedges favored; watch squeeze risk on crowded shorts.',
    range: 'Mean-reverting, range-bound tape — premium harvesting and range structures favored until a breakout triggers.',
    'high-vol': 'High-volatility regime — long-vol convexity, wider strikes, smaller size; expect violent two-way moves.',
  }[regime];

  // correlations from generated daily histories
  const hist = ASSET_IDS.map((x) => getCandles(x, '1d', 90).map((c) => c.c));
  const rets = hist.map((h) => h.slice(1).map((c, i) => Math.log(c / h[i])));
  const corr = (x: number[], y: number[]) => {
    const mx = x.reduce((a, b) => a + b, 0) / x.length;
    const my = y.reduce((a, b) => a + b, 0) / y.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < x.length; i++) {
      num += (x[i] - mx) * (y[i] - my);
      dx += (x[i] - mx) ** 2;
      dy += (y[i] - my) ** 2;
    }
    return num / Math.sqrt(dx * dy);
  };
  const matrix = ASSET_IDS.map((_, i) => ASSET_IDS.map((_, j) => Number(corr(rets[i], rets[j]).toFixed(2))));
  const avgCorr = (matrix[0][1] + matrix[0][2] + matrix[1][2]) / 3;

  const funding = {
    rate: a.fundingRate,
    annualizedPct: a.fundingRate * 365 * 100,
    stance:
      a.fundingRate > 0.15
        ? 'Elevated positive funding — crowded longs paying up; squeeze risk on bad news'
        : a.fundingRate > 0.03
          ? 'Mildly positive funding — normal long bias'
          : a.fundingRate < -0.03
            ? 'Negative funding — shorts paying longs; contrarian bullish tilt'
            : 'Near-flat funding — balanced positioning',
  };

  const macro = [
    `Cross-asset 90d correlation average ${avgCorr.toFixed(2)} — ${avgCorr > 0.8 ? 'macro-driven tape; diversification within crypto is limited' : avgCorr > 0.5 ? 'moderately correlated; idiosyncratic drivers still matter' : 'dispersed — asset-specific narratives dominate'}.`,
    `${asset} 24h change ${(a.change24h).toFixed(2)}%, open interest $${(a.openInterest / 1e9).toFixed(2)}B, 24h volume $${(a.volume24h / 1e9).toFixed(2)}B.`,
    `Options positioning context: 30d IV at the ${(vol.ivPercentile).toFixed(0)}th percentile — ${vol.ivPercentile > 60 ? 'desk is paying up for protection; consider monetizing elevated premium' : vol.ivPercentile < 35 ? 'protection is cheap; favorable moment to structure long-vol or hedges' : 'premium near fair value'}.`,
    `Perp funding annualizing at ${funding.annualizedPct.toFixed(1)}% — ${funding.stance}.`,
  ];

  // scenario probabilities from regime + vol + bias
  const bull = regime === 'bull-trend' ? 0.4 : regime === 'bear-trend' ? 0.2 : 0.32;
  const bear = regime === 'bear-trend' ? 0.4 : regime === 'bull-trend' ? 0.18 : 0.28;
  const base = 0.9 - bull - bear;
  const move = vol.atmIv30 / Math.sqrt(12);
  const scenarios: EnvScenario[] = [
    { name: 'Bull continuation', probability: bull, spotMovePct: move * 100 * 1.6, ivResponsePct: -10, horizonDays: 30, description: 'Trend extends; spot grinds higher, IV cools as complacency returns.' },
    { name: 'Base / chop', probability: Math.max(base, 0.25), spotMovePct: 0, ivResponsePct: -12, horizonDays: 30, description: 'Range-bound drift; theta harvest environment for premium sellers.' },
    { name: 'Bear leg', probability: bear, spotMovePct: -move * 100 * 1.5, ivResponsePct: 35, horizonDays: 30, description: 'Risk-off drawdown; IV spikes, put skew steepens further.' },
    { name: 'Vol event / tail', probability: 0.08, spotMovePct: -move * 100 * 3, ivResponsePct: 90, horizonDays: 30, description: 'Macro shock or cascade; fat-tail move with massive vol expansion.' },
  ];

  return {
    asset,
    spot: a.spot,
    regime,
    regimeDescription,
    funding,
    openInterest: {
      usd: a.openInterest,
      trend: a.change24h > 3 ? 'OI expanding with price — new money entering' : a.change24h < -3 ? 'OI contracting — deleveraging in progress' : 'OI stable',
    },
    volume24h: a.volume24h,
    crossAsset: {
      assets: [...ASSET_IDS],
      matrix,
      interpretation: `BTC-ETH ${matrix[0][1]}, BTC-SOL ${matrix[0][2]}, ETH-SOL ${matrix[1][2]} (90d daily returns).`,
    },
    macro,
    scenarios,
  };
}

// --- Monte Carlo -------------------------------------------------------------------

export interface MonteCarloResult {
  asset: string;
  spot: number;
  days: number;
  iv: number;
  paths: number;
  driftBpsPerDay: number;
  percentiles: { p5: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number };
  expectedMovePct: number;
  probAbove: { level: number; probability: number }[];
  probBelow: { level: number; probability: number }[];
  probTouch: { level: number; probability: number }[];
  histogram: { bin: number; count: number }[];
  notes: string[];
}

export function monteCarlo(opts: {
  asset: AssetId;
  days?: number;
  paths?: number;
  driftBpsPerDay?: number;
  levels?: number[];
}): MonteCarloResult {
  const asset = opts.asset;
  const days = Math.min(Math.max(opts.days ?? 30, 1), 180);
  const paths = Math.min(Math.max(opts.paths ?? 4000, 500), 20000);
  const live = liveMarketState()[asset];
  const spot = live.spot;
  const iv = live.atmIv30d;
  const drift = (opts.driftBpsPerDay ?? 0) / 10000;
  const seed = hashString(`mc-${asset}-${days}-${Math.floor(Date.now() / 60_000)}`);
  const rnd = mulberry32(seed);
  const dt = 1 / 365;
  const sigma = iv * Math.sqrt(dt);
  const finals: number[] = [];
  const touched = new Map<number, number>();
  const levels = (opts.levels ?? [spot * 0.9, spot * 1.1, spot * 0.8, spot * 1.2]).slice(0, 6);

  for (let p = 0; p < paths; p++) {
    let s = spot;
    let touchedAny = new Set<number>();
    for (let d = 0; d < days; d++) {
      const z = gauss(rnd);
      const jump = rnd() < 0.004 ? gauss(rnd) * sigma * 4 : 0; // rare jump
      s *= Math.exp(drift - 0.5 * sigma * sigma + sigma * (z + jump));
      for (let li = 0; li < levels.length; li++) {
        const lv = levels[li];
        if (!touchedAny.has(li) && ((lv < spot && s <= lv) || (lv > spot && s >= lv))) {
          touchedAny.add(li);
        }
      }
    }
    finals.push(s);
    for (const li of touchedAny) touched.set(li, (touched.get(li) ?? 0) + 1);
  }

  finals.sort((a, b) => a - b);
  const q = (p: number) => finals[Math.min(finals.length - 1, Math.floor(p * finals.length))];
  const probAbove = levels.map((lv) => ({
    level: lv,
    probability: finals.filter((f) => f > lv).length / finals.length,
  }));
  const probBelow = levels.map((lv) => ({
    level: lv,
    probability: finals.filter((f) => f < lv).length / finals.length,
  }));
  const probTouch = levels.map((lv, i) => ({
    level: lv,
    probability: (touched.get(i) ?? 0) / paths,
  }));

  // histogram (20 bins across p1..p99)
  const lo = q(0.01);
  const hi = q(0.99);
  const bins = 24;
  const histogram = Array.from({ length: bins }, (_, i) => ({
    bin: lo + ((hi - lo) * i) / bins,
    count: 0,
  }));
  for (const f of finals) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(((f - lo) / Math.max(hi - lo, 1e-9)) * bins)));
    histogram[idx].count += 1;
  }

  const expectedMovePct = ((q(0.84) - q(0.16)) / 2 / spot) * 100;

  return {
    asset,
    spot,
    days,
    iv,
    paths,
    driftBpsPerDay: drift * 10000,
    percentiles: { p5: q(0.05), p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95) },
    expectedMovePct,
    probAbove,
    probBelow,
    probTouch,
    histogram,
    notes: [
      `${paths.toLocaleString()} GBM paths with fat-tail jumps, ${days}d horizon, IV ${(iv * 100).toFixed(0)}%, drift ${drift * 10000 > 0 ? '+' : ''}${(drift * 10000).toFixed(0)} bps/day.`,
      `1σ expected move ±${expectedMovePct.toFixed(1)}% → spot band ${q(0.16).toFixed(0)} – ${q(0.84).toFixed(0)}.`,
      `P(above ${probAbove[1]?.level.toFixed(0) ?? '-'}) = ${((probAbove[1]?.probability ?? 0) * 100).toFixed(0)}% · P(below ${probBelow[0]?.level.toFixed(0) ?? '-'}) = ${((probBelow[0]?.probability ?? 0) * 100).toFixed(0)}%.`,
      `Touch probabilities matter for barrier/stop logic: P(touch ${probTouch[0]?.level.toFixed(0) ?? '-'}) = ${((probTouch[0]?.probability ?? 0) * 100).toFixed(0)}%.`,
    ],
  };
}

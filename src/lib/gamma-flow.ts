// ─────────────────────────────────────────────────────────────────────────────
// GAMMA & FLOW LAB — native analytics engine.
//
// OpenMarket-style market internals, computed natively on the client:
//   • Gamma exposure (GEX) per strike — dealer gamma book, call/put walls,
//     gamma flip, zero-gamma regime, estimated dealer positioning
//   • Vanna exposure (VEX) per strike — how dealer hedging shifts with IV
//   • Strike-by-strike heatmaps — GEX / VEX / IV / OI / volume, strike × expiry
//   • Options flow — a live tape of prints with sweeps, blocks, 0DTE flags,
//     premium flow totals, buy/sell pressure, largest prints
//   • Contract charts — per-contract price series, IV, greeks
//   • Skew & surface — IV by delta across tenors, term structure
//
// Conventions (standard naive dealer model):
//   • Customers are net buyers of calls and puts; dealers hedge the other
//     side ⇒ dealer gamma = −(callGamma·callOI − putGamma·putOI) per strike
//     (GEX displayed as the dealer-signed net; positive = dealers long
//     gamma = mean-reverting pin regime; negative = short gamma = trending)
//   • Gamma flip = spot level where the cumulative net GEX crosses zero
//   • Call wall  = strike of max positive dealer call gamma (resistance magnet)
//     Put wall   = strike of max negative dealer put gamma (support magnet)
//
// All randomness is deterministic (seeded) — no flicker, stable across
// renders, exactly like the rest of the terminal.
// ─────────────────────────────────────────────────────────────────────────────

import { ivForStrike, bsGreeks, bsPrice } from './pricing';
import type { OptionType } from './pricing';

// ── deterministic RNG (xorshift-ish, seeded) ─────────────────────────────────

export function seededStream(seed: number) {
  let t = (seed + 0x6d2b79f5) | 0;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── US + crypto underlyings for the lab ──────────────────────────────────────

export interface LabSymbol {
  id: string;
  kind: 'us-index' | 'us-etf' | 'us-stock' | 'crypto';
  name: string;
  /** contract multiplier (US equity options: 100) */
  multiplier: number;
  /** anchor spot — deterministic per symbol per day (stable intraday) */
  anchorSpot: number;
  /** typical ATM 30d IV (annualized) */
  atmIv: number;
  /** typical daily realized vol */
  dailyVol: number;
  /** strike grid step */
  strikeStep: number;
  /** typical total options OI (contracts) */
  oiScale: number;
  /** typical daily options volume (contracts) */
  volScale: number;
  /** where the flow prints come from */
  exchanges: string[];
}

export const LAB_SYMBOLS: LabSymbol[] = [
  {
    id: 'SPX', kind: 'us-index', name: 'S&P 500 Index', multiplier: 100,
    anchorSpot: 6025, atmIv: 0.145, dailyVol: 0.0075, strikeStep: 25,
    oiScale: 260_000, volScale: 900_000,
    exchanges: ['CBOE', 'CBOE BZX', 'C2'],
  },
  {
    id: 'SPY', kind: 'us-etf', name: 'SPDR S&P 500 ETF', multiplier: 100,
    anchorSpot: 601, atmIv: 0.142, dailyVol: 0.0072, strikeStep: 1,
    oiScale: 2_400_000, volScale: 6_200_000,
    exchanges: ['CBOE', 'ISE', 'ARCA', 'PHLX', 'NASDAQ', 'BOX', 'MIAX', 'GEMINI'],
  },
  {
    id: 'QQQ', kind: 'us-etf', name: 'Invesco QQQ Trust', multiplier: 100,
    anchorSpot: 521, atmIv: 0.185, dailyVol: 0.0095, strikeStep: 1,
    oiScale: 1_500_000, volScale: 3_400_000,
    exchanges: ['CBOE', 'ISE', 'ARCA', 'PHLX', 'NASDAQ'],
  },
  {
    id: 'NVDA', kind: 'us-stock', name: 'NVIDIA Corp', multiplier: 100,
    anchorSpot: 141, atmIv: 0.52, dailyVol: 0.028, strikeStep: 2.5,
    oiScale: 1_900_000, volScale: 5_100_000,
    exchanges: ['CBOE', 'ISE', 'ARCA', 'PHLX', 'NASDAQ', 'MIAX'],
  },
  {
    id: 'TSLA', kind: 'us-stock', name: 'Tesla Inc', multiplier: 100,
    anchorSpot: 248, atmIv: 0.58, dailyVol: 0.03, strikeStep: 5,
    oiScale: 1_300_000, volScale: 3_800_000,
    exchanges: ['CBOE', 'ISE', 'ARCA', 'PHLX', 'NASDAQ'],
  },
  {
    id: 'AAPL', kind: 'us-stock', name: 'Apple Inc', multiplier: 100,
    anchorSpot: 232, atmIv: 0.28, dailyVol: 0.014, strikeStep: 2.5,
    oiScale: 1_100_000, volScale: 2_600_000,
    exchanges: ['CBOE', 'ISE', 'ARCA', 'PHLX', 'NASDAQ'],
  },
  {
    id: 'BTC', kind: 'crypto', name: 'Bitcoin', multiplier: 1,
    anchorSpot: 97_300, atmIv: 0.53, dailyVol: 0.028, strikeStep: 500,
    oiScale: 120_000, volScale: 380_000,
    exchanges: ['Deribit', 'Bybit', 'OKX', 'Aevo'],
  },
  {
    id: 'ETH', kind: 'crypto', name: 'Ethereum', multiplier: 1,
    anchorSpot: 2_460, atmIv: 0.62, dailyVol: 0.033, strikeStep: 25,
    oiScale: 90_000, volScale: 260_000,
    exchanges: ['Deribit', 'Bybit', 'OKX', 'Aevo'],
  },
  {
    id: 'SOL', kind: 'crypto', name: 'Solana', multiplier: 1,
    anchorSpot: 138.5, atmIv: 0.85, dailyVol: 0.045, strikeStep: 2.5,
    oiScale: 40_000, volScale: 120_000,
    exchanges: ['Deribit', 'Bybit', 'OKX', 'Aevo'],
  },
];

export function labSymbol(id: string): LabSymbol {
  return LAB_SYMBOLS.find((s) => s.id === id) ?? LAB_SYMBOLS[0];
}

/** Deterministic "live" spot for a symbol: day-anchored + slow intraday walk. */
export function labSpot(sym: LabSymbol, tickMs: number): number {
  const day = Math.floor(tickMs / 86_400_000);
  const minute = Math.floor(tickMs / 60_000);
  const r1 = seededStream(hashStr(sym.id) ^ day);
  const base = sym.anchorSpot * (1 + (r1() - 0.5) * 0.05);
  // slow mean-reverting walk anchored to the day's base — intraday range
  // stays within ~±1 daily vol (√time scaling, like a real session)
  const r2 = seededStream(hashStr(sym.id + 'w') ^ minute);
  const sessionFrac = (minute % 390) / 390;
  const walk = (r2() - 0.5) * 2 * sym.dailyVol * Math.sqrt(sessionFrac);
  return Math.max(base * (1 + walk), sym.strikeStep);
}

// ── expiries ─────────────────────────────────────────────────────────────────

export interface LabExpiry {
  id: string;
  label: string;
  dte: number;
  /** share of the symbol's total OI concentrated in this expiry */
  oiWeight: number;
  is0dte: boolean;
}

const US_EXPIRY_WEIGHTS = [0.22, 0.09, 0.07, 0.06, 0.05, 0.07, 0.11, 0.13, 0.09, 0.11];
const CRYPTO_EXPIRY_WEIGHTS = [0.18, 0.12, 0.1, 0.08, 0.14, 0.12, 0.26];

function fmtDte(dte: number): string {
  if (dte === 0) return '0DTE';
  if (dte < 30) return `${dte}d`;
  return `${(dte / 30).toFixed(0)}mo`;
}

export function labExpiries(sym: LabSymbol): LabExpiry[] {
  const isUs = sym.kind !== 'crypto';
  const dtes = isUs
    ? [0, 1, 2, 3, 7, 14, 21, 30, 60, 90]
    : [0, 1, 2, 3, 7, 14, 30];
  const weights = isUs ? US_EXPIRY_WEIGHTS : CRYPTO_EXPIRY_WEIGHTS;
  return dtes.map((dte, i) => ({
    id: String(dte),
    label: fmtDte(dte),
    dte,
    oiWeight: weights[i] ?? 0.05,
    is0dte: dte === 0,
  }));
}

// ── strikes ──────────────────────────────────────────────────────────────────

export interface StrikeOI {
  strike: number;
  callOi: number;
  putOi: number;
}

/**
 * Deterministic open-interest distribution across strikes.
 * Realistic shape: fat at round strikes (walls), peaked slightly OTM,
 * puts skewed below spot, calls skewed above.
 */
export function strikeGrid(sym: LabSymbol, spot: number, count: number, expiries: LabExpiry[]): number[] {
  const step = sym.strikeStep;
  const atm = Math.round(spot / step) * step;
  const half = Math.floor(count / 2);
  const out: number[] = [];
  for (let i = -half; i <= half; i++) out.push(atm + i * step);
  return out;
}

function oiForStrike(
  sym: LabSymbol,
  spot: number,
  strike: number,
  dte: number,
  oiWeight: number,
  seed: number,
): { callOi: number; putOi: number } {
  const rnd = seededStream(seed ^ Math.floor(strike * 100));
  const moneyness = Math.log(strike / spot);
  // base bells — calls peak ABOVE spot, puts BELOW, so the call wall and put
  // wall separate like on a real surface
  const width = 0.035 + dte * 0.0022;
  const callShift = 0.012 + dte * 0.0008;
  const putShift = 0.013 + dte * 0.0009;
  const bellC = Math.exp(-((moneyness - callShift) ** 2) / (2 * width * width));
  const bellP = Math.exp(-((moneyness + putShift) ** 2) / (2 * width * width));
  // round-number wall effect — big round strikes carry multiples of the OI
  const div = strike / sym.strikeStep;
  const wallBoost = div % 10 === 0 ? 3.5 : div % 4 === 0 ? 1.8 : div % 2 === 0 ? 1.15 : 1;
  // customers buy OTM calls above / OTM puts below; dealers hold the other side
  const callBias = moneyness >= 0 ? 1 + moneyness * 7 : 1 / (1 + Math.abs(moneyness) * 6);
  const putBias = moneyness <= 0 ? 1 + Math.abs(moneyness) * 6.5 : 1 / (1 + moneyness * 6);
  const totalOi = sym.oiScale * oiWeight * wallBoost;
  const split = rnd();
  const callOi = Math.round(totalOi * bellC * (0.5 * callBias) * (0.85 + 0.3 * split));
  const putOi = Math.round(totalOi * bellP * (0.5 * putBias) * (0.85 + 0.3 * (1 - split)));
  return { callOi, putOi };
}

// ── per-strike gamma profile ─────────────────────────────────────────────────

export interface GammaRow {
  strike: number;
  callOi: number;
  putOi: number;
  callIv: number;
  putIv: number;
  callGamma: number;
  putGamma: number;
  /** dealer-signed net gamma exposure, $ per 1% spot move (positive = dealers long gamma) */
  netGex: number;
  callGex: number;
  putGex: number;
  /** vanna exposure, $ per 1 vol-point move */
  netVex: number;
  callVex: number;
  putVex: number;
  /** total premium (open interest × mid) */
  callPremium: number;
  putPremium: number;
  callVolume: number;
  putVolume: number;
  isWall: boolean;
}

export interface GammaLevels {
  callWall: number;
  putWall: number;
  gammaFlip: number;
  maxPain: number;
  netGexTotal: number;
  regime: 'long-gamma' | 'short-gamma';
}

export interface DealerPositioning {
  spot: number;
  /** net dealer gamma $/1% at spot */
  netGex: number;
  /** cumulative GEX profile across spot scan */
  curve: { spot: number; gex: number }[];
  /** estimated dealer hedge flow direction over ±2% spot shifts */
  hedgeFlow: { spot: number; hedgeUsd: number }[];
  label: 'LONG GAMMA — pin & suppress vol' | 'SHORT GAMMA — trends amplify';
  interpretation: string;
}

export interface GammaProfile {
  symbol: LabSymbol;
  spot: number;
  rows: GammaRow[];
  levels: GammaLevels;
  dealer: DealerPositioning;
  /** cumulative net GEX from lowest strike up */
  cumulative: { strike: number; cum: number }[];
}

function vanna(s: number, k: number, t: number, iv: number, r: number, ot: OptionType): number {
  // ∂Δ/∂σ — analytic via vega·d1/(s·σ²·√t)
  if (t <= 0 || iv <= 0 || s <= 0 || k <= 0) return 0;
  const sq = iv * Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r + 0.5 * iv * iv) * t) / sq;
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const vega = s * pdf * Math.sqrt(t);
  return ot === 'call'
    ? (vega * d1) / (s * iv * iv * Math.sqrt(t) || 1)
    : (vega * d1) / (s * iv * iv * Math.sqrt(t) || 1);
}

/**
 * Build the full gamma profile for a symbol.
 * @param tickMs  current time (seeds the deterministic tape)
 * @param liveSpot optional live spot override (BTC/ETH/SOL use the market feed)
 */
export function buildGammaProfile(symbolId: string, tickMs: number, liveSpot?: number): GammaProfile {
  const sym = labSymbol(symbolId);
  const spot = liveSpot ?? labSpot(sym, tickMs);
  const expiries = labExpiries(sym);
  const seed = hashStr(sym.id) ^ Math.floor(tickMs / 60_000); // re-seed each minute

  const strikes = strikeGrid(sym, spot, 41, expiries);
  const r = sym.kind === 'crypto' ? 0.05 : 0.045;

  const rows: GammaRow[] = strikes.map((strike) => {
    let callOi = 0, putOi = 0, callGex = 0, putGex = 0, callVex = 0, putVex = 0;
    let callPremium = 0, putPremium = 0, callVolume = 0, putVolume = 0;
    let callIvW = 0, putIvW = 0;

    for (const ex of expiries) {
      const t = Math.max(ex.dte, 0.25) / 365; // 0DTE = 6h of life
      const callIv = ivForStrike(
        { atm30d: sym.atmIv, termSlope: 0.055, curv: 0.3, skew: -0.5, rate: r },
        spot, strike, t, 0,
      );
      const putIv = ivForStrike(
        { atm30d: sym.atmIv, termSlope: 0.055, curv: 0.34, skew: -0.62, rate: r },
        spot, strike, t, 0,
      );
      const oi = oiForStrike(sym, spot, strike, ex.dte, ex.oiWeight, seed + ex.dte);
      const gCall = bsGreeks(spot, strike, t, callIv, r, 'call');
      const gPut = bsGreeks(spot, strike, t, putIv, r, 'put');
      const vCall = vanna(spot, strike, t, callIv, r, 'call');
      const vPut = vanna(spot, strike, t, putIv, r, 'put');

      // GEX in $ per 1% spot move, dealer-signed:
      // dealers short customer calls ⇒ −gamma·OI; short puts too, but put gamma
      // contributes with opposite sign to the market net ⇒ standard display:
      // net = putGex − callGex at dealer side. We show dealer net =
      // (putGamma·putOI − callGamma·callOI)·spot·multiplier·0.01
      const cg = gCall.gamma * oi.callOi;
      const pg = gPut.gamma * oi.putOi;
      callGex += cg * spot * sym.multiplier * 0.01;
      putGex += pg * spot * sym.multiplier * 0.01;
      callVex += vCall * oi.callOi * spot * sym.multiplier * 0.01;
      putVex += vPut * oi.putOi * spot * sym.multiplier * 0.01;

      callOi += oi.callOi;
      putOi += oi.putOi;
      callPremium += bsPrice(spot, strike, t, callIv, r, 'call') * oi.callOi * sym.multiplier;
      putPremium += bsPrice(spot, strike, t, putIv, r, 'put') * oi.putOi * sym.multiplier;

      // volume: ~proportional to OI, heavier for 0DTE
      const volMult = ex.is0dte ? 1.6 : 0.55;
      callVolume += Math.round(oi.callOi * volMult * (0.6 + 0.8 * seededStream(seed + strike + ex.dte)()));
      putVolume += Math.round(oi.putOi * volMult * (0.6 + 0.8 * seededStream(seed + strike * 7 + ex.dte)()));

      callIvW += callIv * (oi.callOi + oi.putOi);
      putIvW += putIv * (oi.callOi + oi.putOi);
    }

    const w = callOi + putOi || 1;
    // dealer net = puts minus calls (dealer is short calls → long-gamma puts side)
    const netGex = putGex - callGex;
    return {
      strike,
      callOi,
      putOi,
      callIv: callIvW / w,
      putIv: putIvW / w,
      callGamma: callGex,
      putGamma: putGex,
      netGex,
      callGex,
      putGex,
      netVex: putVex - callVex,
      callVex,
      putVex,
      callPremium,
      putPremium,
      callVolume,
      putVolume,
      isWall: false,
    };
  });

  // walls: call wall = strike of max call gamma; put wall = strike of max |put gamma|
  const callWallRow = rows.reduce((a, b) => (b.callGex > a.callGex ? b : a), rows[0]);
  const putWallRow = rows.reduce((a, b) => (Math.abs(b.putGex) > Math.abs(a.putGex) ? b : a), rows[0]);
  const callWall = callWallRow.strike;
  const putWall = putWallRow.strike;
  // cumulative → gamma flip where cum crosses zero
  const cumulative: { strike: number; cum: number }[] = [];
  let cum = 0;
  for (const row of rows) {
    cum += row.netGex;
    cumulative.push({ strike: row.strike, cum });
  }
  let gammaFlip = spot;
  for (let i = 1; i < cumulative.length; i++) {
    const a = cumulative[i - 1], b = cumulative[i];
    if (a.cum <= 0 && b.cum > 0) {
      const f = Math.abs(a.cum) / (Math.abs(a.cum) + Math.abs(b.cum) || 1);
      gammaFlip = a.strike + (b.strike - a.strike) * f;
      break;
    }
    if (a.cum >= 0 && b.cum < 0) {
      const f = Math.abs(a.cum) / (Math.abs(a.cum) + Math.abs(b.cum) || 1);
      gammaFlip = a.strike + (b.strike - a.strike) * f;
      break;
    }
  }

  // max pain: strike minimizing total dealer payoff to option holders
  let maxPain = spot, minPain = Infinity;
  for (const kStrike of rows.map((x) => x.strike)) {
    let pain = 0;
    for (const row of rows) {
      pain += Math.max(kStrike - row.strike, 0) * row.callOi + Math.max(row.strike - kStrike, 0) * row.putOi;
    }
    if (pain < minPain) { minPain = pain; maxPain = kStrike; }
  }

  const netGexTotal = cum;
  const levels: GammaLevels = {
    callWall,
    putWall,
    gammaFlip,
    maxPain,
    netGexTotal,
    regime: netGexTotal >= 0 ? 'long-gamma' : 'short-gamma',
  };

  // dealer positioning across a spot scan (re-hedge requirement)
  const curve: { spot: number; gex: number }[] = [];
  const hedgeFlow: { spot: number; hedgeUsd: number }[] = [];
  for (let i = -10; i <= 10; i++) {
    const s = spot * (1 + i * 0.002);
    let gexAt = 0;
    for (const row of rows) {
      // approximate dealer gamma at shifted spot (gamma peaks near strike)
      const m = Math.log(row.strike / s);
      const peak = Math.exp(-(m * m) / (2 * 0.012 * 0.012));
      gexAt += row.netGex * peak;
    }
    curve.push({ spot: s, gex: gexAt });
    hedgeFlow.push({ spot: s, hedgeUsd: -gexAt * (i * 0.2) });
  }

  const dealer: DealerPositioning = {
    spot,
    netGex: netGexTotal,
    curve,
    hedgeFlow,
    label:
      netGexTotal >= 0
        ? 'LONG GAMMA — pin & suppress vol'
        : 'SHORT GAMMA — trends amplify',
    interpretation:
      netGexTotal >= 0
        ? 'Dealers hedge by selling rallies and buying dips — realized vol is suppressed and price pins between the walls. Breakouts tend to fade back toward max pain.'
        : 'Dealers hedge by chasing the move — buying rallies, selling dips. Moves self-amplify through the gamma flip; expect expansion and violent trend days.',
  };

  return { symbol: sym, spot, rows, levels, dealer, cumulative };
}

// ── options flow tape ────────────────────────────────────────────────────────

export type FlowSide = 'buy' | 'sell';
export type FlowAggress = 'ask' | 'bid' | 'mid';

export interface FlowPrint {
  id: string;
  ts: number;
  symbol: string;
  optionType: 'call' | 'put';
  strike: number;
  expiry: string;
  dte: number;
  side: FlowSide;
  price: number;
  qty: number;
  premium: number;
  exchange: string;
  aggressor: FlowAggress;
  isSweep: boolean;
  isBlock: boolean;
  is0dte: boolean;
  iv: number;
  delta: number;
  /** customer side guess for premium flow buckets */
  custSide: 'ask' | 'bid';
}

export interface FlowSummary {
  callPremium: number;
  putPremium: number;
  callBuyPremium: number;
  putBuyPremium: number;
  callSellPremium: number;
  putSellPremium: number;
  totalPremium: number;
  callPutRatio: number;
  buySellPressure: number;
  sweepCount: number;
  blockCount: number;
  d0teShare: number;
  prints: number;
}

const SWEEP_EXCH = ['CBOE', 'ISE', 'ARCA', 'PHLX', 'NASDAQ', 'BOX', 'MIAX', 'GEMINI', 'Deribit', 'Bybit', 'OKX', 'Aevo'];

/**
 * Generate the next deterministic print. Called on a cadence (e.g. 900ms) —
 * each call returns 0–3 prints so the tape feels alive but stays stable.
 */
export function nextPrints(
  profile: GammaProfile,
  tickMs: number,
  seq: number,
  count: number,
): FlowPrint[] {
  const sym = profile.symbol;
  const out: FlowPrint[] = [];
  for (let c = 0; c < count; c++) {
    const seed = hashStr(`${sym.id}:${seq}:${c}`);
    const rnd = seededStream(seed);
    const rows = profile.rows;
    // trades cluster near ATM & walls
    const wallPull = rnd() < 0.35;
    const row =
      wallPull && rnd() < 0.5
        ? rows.reduce((a, b) => (Math.abs(b.strike - profile.levels.callWall) < Math.abs(a.strike - profile.levels.callWall) ? b : a))
        : wallPull
          ? rows.reduce((a, b) => (Math.abs(b.strike - profile.levels.putWall) < Math.abs(a.strike - profile.putWall) ? b : a))
          : rows[Math.floor(rnd() * rows.length)];
    const optionType: 'call' | 'put' = rnd() < 0.545 ? 'call' : 'put';
    const iv = optionType === 'call' ? row.callIv : row.putIv;
    const dte = rnd() < 0.34 ? 0 : [1, 2, 3, 7, 14, 21, 30, 60][Math.floor(rnd() * 8)];
    const tYears = Math.max(dte, 0.25) / 365;
    const r = sym.kind === 'crypto' ? 0.05 : 0.045;
    const px = bsPrice(profile.spot, row.strike, tYears, iv, r, optionType);
    // retail sizes ~1–50, blocks 500–5000
    const isBlock = rnd() < 0.045;
    const isSweep = !isBlock && rnd() < 0.07;
    const qty = isBlock
      ? 500 + Math.floor(rnd() * 4500)
      : isSweep
        ? 80 + Math.floor(rnd() * 420)
        : 1 + Math.floor(rnd() * 49);
    const aggressor: FlowAggress = isSweep
      ? 'ask'
      : rnd() < 0.52
        ? 'ask'
        : rnd() < 0.55
          ? 'bid'
          : 'mid';
    const price = px * (aggressor === 'ask' ? 1.015 : aggressor === 'bid' ? 0.985 : 1);
    const premium = price * qty * sym.multiplier;
    const g = bsGreeks(profile.spot, row.strike, tYears, iv, r, optionType);
    out.push({
      id: `${sym.id}-${seq}-${c}`,
      ts: tickMs - Math.floor(rnd() * 4000),
      symbol: sym.id,
      optionType,
      strike: row.strike,
      expiry: dte === 0 ? '0DTE' : `${dte}d`,
      dte,
      side: aggressor === 'ask' ? 'buy' : aggressor === 'bid' ? 'sell' : 'mid',
      price,
      qty,
      premium,
      exchange: SWEEP_EXCH[Math.floor(rnd() * sym.exchanges.length)] || sym.exchanges[0],
      aggressor,
      isSweep,
      isBlock,
      is0dte: dte === 0,
      iv,
      delta: g.delta,
      custSide: aggressor === 'ask' ? 'ask' : 'bid',
    });
  }
  return out;
}

export function summarizeFlow(prints: FlowPrint[]): FlowSummary {
  let callPremium = 0, putPremium = 0, callBuy = 0, putBuy = 0, callSell = 0, putSell = 0;
  let sweeps = 0, blocks = 0, d0tePremium = 0;
  for (const p of prints) {
    if (p.optionType === 'call') {
      callPremium += p.premium;
      if (p.custSide === 'ask') callBuy += p.premium; else callSell += p.premium;
    } else {
      putPremium += p.premium;
      if (p.custSide === 'ask') putBuy += p.premium; else putSell += p.premium;
    }
    if (p.isSweep) sweeps++;
    if (p.isBlock) blocks++;
    if (p.is0dte) d0tePremium += p.premium;
  }
  const total = callPremium + putPremium || 1;
  const buy = callBuy + putBuy;
  const sell = callSell + putSell;
  return {
    callPremium,
    putPremium,
    callBuyPremium: callBuy,
    putBuyPremium: putBuy,
    callSellPremium: callSell,
    putSellPremium: putSell,
    totalPremium: callPremium + putPremium,
    callPutRatio: callPremium / (putPremium || 1),
    buySellPressure: (buy - sell) / (buy + sell || 1),
    sweepCount: sweeps,
    blockCount: blocks,
    d0teShare: d0tePremium / total,
    prints: prints.length,
  };
}

// ── contract series (chart for a single option) ──────────────────────────────

export interface ContractSeries {
  points: { t: number; price: number; iv: number; delta: number }[];
  strike: number;
  optionType: 'call' | 'put';
  dte: number;
}

export function contractSeries(
  symbolId: string,
  spot: number,
  strike: number,
  optionType: 'call' | 'put',
  dte: number,
  nowMs: number,
): ContractSeries {
  const sym = labSymbol(symbolId);
  const r = sym.kind === 'crypto' ? 0.05 : 0.045;
  const points: { t: number; price: number; iv: number; delta: number }[] = [];
  const n = 80;
  const dayVol = sym.dailyVol;
  const rnd = seededStream(hashStr(`${symbolId}${strike}${optionType}${dte}`));
  // generate the spot path backward from now
  const path: number[] = [spot];
  for (let i = 1; i < n; i++) {
    const step = (rnd() - 0.5) * 2 * dayVol;
    path.push(path[i - 1] / (1 + step));
  }
  path.reverse();
  for (let i = 0; i < n; i++) {
    const tYears = Math.max(dte, 0.25) / 365 + ((n - i) / n) * (Math.min(dte, 5) || 1) / 365;
    const iv = ivForStrike(
      { atm30d: sym.atmIv, termSlope: 0.05, curv: 0.3, skew: -0.5, rate: r },
      path[i], strike, tYears, 0,
    );
    const px = bsPrice(path[i], strike, tYears, iv, r, optionType);
    const g = bsGreeks(path[i], strike, tYears, iv, r, optionType);
    points.push({ t: nowMs - (n - i) * 60_000 * 5, price: px, iv, delta: g.delta });
  }
  return { points, strike, optionType, dte };
}

// ── skew / surface helpers ───────────────────────────────────────────────────

export interface SkewPoint {
  delta: number;
  iv: number;
}

export function skewCurve(symbolId: string, spot: number, dte: number): SkewPoint[] {
  const sym = labSymbol(symbolId);
  const r = sym.kind === 'crypto' ? 0.05 : 0.045;
  const t = Math.max(dte, 0.25) / 365;
  const deltas = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const out: SkewPoint[] = [];
  for (const d of deltas) {
    // strike from delta (call delta ≈ N(d1)): log(K/F) ≈ −z·σ√t
    const z = normCdfInv(d);
    // approximate strike: log(K/F) ≈ −z·σ√t
    const iv0 = sym.atmIv;
    const K = spot * Math.exp(-z * iv0 * Math.sqrt(t));
    const iv = ivForStrike(
      { atm30d: sym.atmIv, termSlope: 0.05, curv: 0.32, skew: -0.55, rate: r },
      spot, K, t, 0,
    );
    out.push({ delta: d, iv });
  }
  return out;
}

export function normCdfInv(p: number): number {
  // Acklam's approximation
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r2: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r2 = q * q;
  return (((((a[0] * r2 + a[1]) * r2 + a[2]) * r2 + a[3]) * r2 + a[4]) * r2 + a[5]) * q /
    (((((b[0] * r2 + b[1]) * r2 + b[2]) * r2 + b[3]) * r2 + b[4]) * r2 + 1);
}

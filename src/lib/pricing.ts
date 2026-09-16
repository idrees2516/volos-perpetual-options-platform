// Client-side pricing engine — a faithful TypeScript mirror of the Rust
// analytics core. Used for 60fps interaction (drag, sliders, animation);
// the Rust engine remains the authoritative source for full analyses.

import type {
  AssetMarket,
  CarryBudget,
  Extreme,
  Greeks,
  Leg,
  LegAnalytics,
  StrategyAnalysis,
  ViewOverrides,
} from './types';

export const DAYS_PER_YEAR = 365;
const SQRT_2PI = 2.5066282746310005024;

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

// ---------------------------------------------------------------------------
// Volatility surface (mirrors surface.rs)
// ---------------------------------------------------------------------------

export interface VolConfig {
  atm30d: number;
  termSlope: number;
  curv: number;
  skew: number;
  rate: number;
}

export const VOL_CONFIG: Record<string, VolConfig> = {
  BTC: { atm30d: 0.52, termSlope: 0.06, curv: 0.42, skew: -0.62, rate: 0.055 },
  ETH: { atm30d: 0.62, termSlope: 0.07, curv: 0.46, skew: -0.66, rate: 0.06 },
  SOL: { atm30d: 0.85, termSlope: 0.05, curv: 0.52, skew: -0.55, rate: 0.075 },
};

export function atmVol(cfg: VolConfig, tYears: number, volShift: number): number {
  const t = Math.max(tYears, (1 / 365) / 8);
  const v = cfg.atm30d * Math.exp(Math.log(t / (30 / DAYS_PER_YEAR)) * cfg.termSlope);
  return Math.min(Math.max(v * (1 + volShift), 0.05), 4);
}

export function ivForStrike(
  cfg: VolConfig,
  spot: number,
  strike: number,
  tYears: number,
  volShift: number,
): number {
  if (strike <= 0 || spot <= 0) return atmVol(cfg, tYears, volShift);
  const t = Math.max(tYears, (1 / 365) / 8);
  const fwd = spot * Math.exp(cfg.rate * t);
  const k = Math.log(strike / fwd);
  const totalVar = atmVol(cfg, t, volShift) ** 2 * t;
  const sigma = 0.28;
  const wingFrac = Math.min(Math.max(cfg.curv, 0.15), 0.6);
  const bSigma = totalVar * wingFrac;
  const b = bSigma / sigma;
  const a = totalVar - bSigma;
  const km = k;
  const w = a + b * (cfg.skew * km + Math.sqrt(km * km + sigma * sigma));
  return Math.min(Math.max(Math.sqrt(Math.max(w / t, 1e-6)), 0.05), 5);
}

export function forwardPrice(cfg: VolConfig, spot: number, tYears: number): number {
  return spot * Math.exp(cfg.rate * tYears);
}

// ---------------------------------------------------------------------------
// Black-Scholes + Greeks
// ---------------------------------------------------------------------------

export type OptionType = 'call' | 'put';

export function intrinsic(s: number, k: number, ot: OptionType): number {
  return ot === 'call' ? Math.max(s - k, 0) : Math.max(k - s, 0);
}

export function bsPrice(s: number, k: number, t: number, iv: number, r: number, ot: OptionType): number {
  if (t <= 0 || iv <= 0) return intrinsic(s, k, ot);
  const sq = iv * Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r + 0.5 * iv * iv) * t) / sq;
  const d2 = d1 - sq;
  const disc = Math.exp(-r * t);
  return ot === 'call'
    ? s * normCdf(d1) - k * disc * normCdf(d2)
    : k * disc * normCdf(-d2) - s * normCdf(-d1);
}

export function bsGreeks(s: number, k: number, t: number, iv: number, r: number, ot: OptionType): Greeks {
  if (t <= 0 || iv <= 0 || s <= 0 || k <= 0) {
    const px = intrinsic(s, k, ot);
    const delta =
      ot === 'call' ? (s > k ? 1 : s < k ? 0 : 0.5) : s < k ? -1 : s > k ? 0 : -0.5;
    return { price: px, delta, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const sq = iv * Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r + 0.5 * iv * iv) * t) / sq;
  const d2 = d1 - sq;
  const pdf1 = normPdf(d1);
  const disc = Math.exp(-r * t);
  if (ot === 'call') {
    const price = s * normCdf(d1) - k * disc * normCdf(d2);
    const thetaY = -(s * pdf1 * iv) / (2 * Math.sqrt(t)) - r * k * disc * normCdf(d2);
    return {
      price,
      delta: normCdf(d1),
      gamma: pdf1 / (s * sq),
      vega: (s * pdf1 * Math.sqrt(t)) / 100,
      theta: thetaY / DAYS_PER_YEAR,
      rho: (k * t * disc * normCdf(d2)) / 100,
    };
  }
  const price = k * disc * normCdf(-d2) - s * normCdf(-d1);
  const thetaY = -(s * pdf1 * iv) / (2 * Math.sqrt(t)) + r * k * disc * normCdf(-d2);
  return {
    price,
    delta: normCdf(d1) - 1,
    gamma: pdf1 / (s * sq),
    vega: (s * pdf1 * Math.sqrt(t)) / 100,
    theta: thetaY / DAYS_PER_YEAR,
    rho: (-k * t * disc * normCdf(-d2)) / 100,
  };
}

// ---------------------------------------------------------------------------
// Everlasting options — Paradigm equivalent-portfolio method:
//   V = Σ 2^-n · BS(S, K, T = n·τ);  funding/period = mark − payoff.
// ---------------------------------------------------------------------------

export function everlastingGreeks(
  s: number,
  k: number,
  fundingPeriodDays: number,
  iv: (tYears: number) => number,
  r: number,
  ot: OptionType,
): Greeks {
  const tau = fundingPeriodDays / DAYS_PER_YEAR;
  const acc: Greeks = { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  let w = 0.5;
  for (let n = 1; n <= 48; n++) {
    const t = n * tau;
    const g = bsGreeks(s, k, t, iv(t), r, ot);
    acc.price += w * g.price;
    acc.delta += w * g.delta;
    acc.gamma += w * g.gamma;
    acc.vega += w * g.vega;
    acc.theta += w * g.theta;
    acc.rho += w * g.rho;
    if (w < 1e-9) break;
    w *= 0.5;
  }
  return acc;
}

export function everlastingFunding(mark: number, s: number, k: number, ot: OptionType): number {
  return mark - intrinsic(s, k, ot);
}

// ---------------------------------------------------------------------------
// Strategy analytics (mirrors payoff.rs)
// ---------------------------------------------------------------------------

export interface MarketCtx {
  cfg: VolConfig;
  asset: AssetMarket;
}

export function makeCtx(underlying: string, asset: AssetMarket): MarketCtx {
  return { cfg: VOL_CONFIG[underlying] ?? VOL_CONFIG.BTC, asset };
}

function legIv(ctx: MarketCtx, strike: number, tYears: number, ivShift: number): number {
  return Math.min(Math.max(ivForStrike(ctx.cfg, ctx.asset.spot, strike, tYears, ctx.asset.volShift) * (1 + ivShift), 0.01), 6);
}

function resolveLeg(leg: Leg, ctx: MarketCtx): LegAnalytics {
  const spot = ctx.asset.spot;
  switch (leg.kind) {
    case 'call':
    case 'put': {
      const t = (leg.expiryDays ?? 30) / DAYS_PER_YEAR;
      const k = leg.strike ?? forwardPrice(ctx.cfg, spot, t);
      const iv = ivForStrike(ctx.cfg, spot, k, t, ctx.asset.volShift);
      const g = bsGreeks(spot, k, t, iv, ctx.cfg.rate, leg.kind);
      return {
        ...analyticsBase(leg),
        strike: k,
        expiryDays: leg.expiryDays,
        iv,
        price: g.price,
        delta: g.delta,
        gamma: g.gamma,
        vega: g.vega,
        theta: g.theta,
        rho: g.rho,
        liquidity: liquidityScore(spot, k, t),
      };
    }
    case 'perp_option': {
      const k = leg.strike ?? spot;
      const fp = leg.fundingPeriodDays ?? 7;
      const ot: OptionType = k >= spot ? 'call' : 'put';
      const ivFn = (t: number) => ivForStrike(ctx.cfg, spot, k, t, ctx.asset.volShift);
      const g = everlastingGreeks(spot, k, fp, ivFn, ctx.cfg.rate, ot);
      const funding = everlastingFunding(g.price, spot, k, ot);
      return {
        ...analyticsBase(leg),
        strike: k,
        fundingPeriodDays: fp,
        iv: ivFn((2 * fp) / DAYS_PER_YEAR),
        price: g.price,
        delta: g.delta,
        gamma: g.gamma,
        vega: g.vega,
        theta: g.theta,
        rho: g.rho,
        liquidity: liquidityScore(spot, k, (2 * fp) / DAYS_PER_YEAR),
        fundingPerDay: funding / fp,
      };
    }
    case 'perp': {
      const px = spot;
      return {
        ...analyticsBase(leg),
        price: px,
        delta: 1,
        gamma: 0,
        vega: 0,
        theta: 0,
        rho: 0,
        liquidity: 99,
        fundingPerDay: (ctx.asset.fundingRate * px) / DAYS_PER_YEAR,
      };
    }
    case 'spot': {
      return {
        ...analyticsBase(leg),
        price: spot,
        delta: 1,
        gamma: 0,
        vega: 0,
        theta: 0,
        rho: 0,
        liquidity: 100,
      };
    }
  }
}

function analyticsBase(leg: Leg): LegAnalytics {
  return {
    id: leg.id,
    kind: leg.kind,
    side: leg.side,
    qty: leg.qty,
    strike: leg.strike,
    expiryDays: leg.expiryDays,
    fundingPeriodDays: leg.fundingPeriodDays,
    iv: undefined,
    price: 0,
    delta: 0,
    gamma: 0,
    vega: 0,
    theta: 0,
    rho: 0,
    cost: 0,
    liquidity: 0,
  };
}

function liquidityScore(spot: number, strike: number, tYears: number): number {
  const m = Math.abs(Math.log(strike / spot));
  const mPen = Math.min(m * 260, 60);
  const t = tYears * 365;
  const tPen = Math.min(Math.abs(t - 30) / 6, 28);
  return Math.min(Math.max(97 - mPen - tPen, 8), 99);
}

function legOptionType(leg: Leg, spot: number): OptionType | null {
  switch (leg.kind) {
    case 'call': return 'call';
    case 'put': return 'put';
    case 'perp_option': return (leg.strike ?? spot) >= spot ? 'call' : 'put';
    default: return null;
  }
}

/** Mark value of one unit of a leg at (spot, years-forward, iv shift). */
function legValue(leg: Leg, entryPrice: number, s: number, tFwd: number, ivShift: number, ctx: MarketCtx): number {
  switch (leg.kind) {
    case 'call':
    case 'put': {
      const t = Math.max(((leg.expiryDays ?? 30) / DAYS_PER_YEAR) - tFwd, 0);
      const k = leg.strike ?? s;
      return bsGreeks(s, k, t, legIv(ctx, k, t, ivShift), ctx.cfg.rate, leg.kind).price;
    }
    case 'perp_option': {
      const k = leg.strike ?? s;
      const fp = leg.fundingPeriodDays ?? 7;
      const ot = legOptionType(leg, s) ?? 'call';
      return everlastingGreeks(s, k, fp, (t) => legIv(ctx, k, t, ivShift), ctx.cfg.rate, ot).price;
    }
    case 'perp':
      return s * (1 + ctx.asset.fundingRate * tFwd);
    case 'spot':
      return s;
  }
}

function legHorizonPnl(leg: Leg, entryPrice: number, s: number, tHorizon: number, ivShift: number, ctx: MarketCtx): number {
  const side = leg.side === 'buy' ? 1 : -1;
  switch (leg.kind) {
    case 'call':
    case 'put': {
      const k = leg.strike ?? s;
      const ot = leg.kind;
      return side * (intrinsic(s, k, ot) - entryPrice);
    }
    default: {
      const v = legValue(leg, entryPrice, s, tHorizon, ivShift, ctx);
      return side * (v - entryPrice);
    }
  }
}

export interface AnalyzeOptions {
  overrides?: ViewOverrides;
  /** Number of points on the spot axis. */
  points?: number;
}

export function analyzeStrategy(
  legs: Leg[],
  underlying: string,
  market: AssetMarket,
  size: number,
  opts: AnalyzeOptions = {},
): StrategyAnalysis {
  const ctx = makeCtx(underlying, market);
  const ov = opts.overrides ?? { spotShiftPct: 0, ivShiftPct: 0, daysForward: 0 };
  const spot = market.spot * (1 + ov.spotShiftPct / 100);
  const ivShift = ov.ivShiftPct / 100;
  const viewCtx: MarketCtx = {
    cfg: ctx.cfg,
    asset: { ...market, spot, volShift: market.volShift },
  };
  const n = opts.points ?? 121;

  // Resolve legs at the *live* market (entry prices) but shifted spot for view.
  const resolved = legs.map((l) => {
    const a = resolveLeg(l, viewCtx);
    return { leg: l, analytics: { ...a, cost: (l.side === 'buy' ? 1 : -1) * l.qty * a.price * size } };
  });

  const hasDated = legs.some((l) => l.expiryDays !== undefined);
  const horizonDays = Math.max(
    ...legs.map((l) => l.expiryDays ?? 0),
    hasDated ? 0 : 30,
  );
  const horizonYears = Math.max(horizonDays / DAYS_PER_YEAR, 1 / 365);

  const sigmaH = atmVol(ctx.cfg, horizonYears, market.volShift) * Math.sqrt(horizonYears);
  const halfSpan = Math.max(spot * 3.2 * sigmaH, spot * 0.08);
  const lo = Math.max(spot - halfSpan, spot * 0.05);
  const hi = spot + halfSpan;
  const spotAxis: number[] = [];
  for (let i = 0; i < n; i++) spotAxis.push(lo + ((hi - lo) * i) / (n - 1));

  const netPremium = resolved.reduce((acc, r) => acc + r.analytics.cost, 0);

  const tFwdYears = Math.min(ov.daysForward / DAYS_PER_YEAR, horizonYears);
  const curves = [
    { label: 'expiry', pnl: [] as number[] },
    { label: 'now', pnl: [] as number[] },
    { label: 't25', pnl: [] as number[] },
    { label: 't50', pnl: [] as number[] },
    { label: 't75', pnl: [] as number[] },
  ];
  for (const s of spotAxis) {
    let e = 0, now = 0, t25 = 0, t50 = 0, t75 = 0;
    for (const r of resolved) {
      const scale = r.leg.qty * size;
      e += scale * legHorizonPnl(r.leg, r.analytics.price, s, horizonYears, ivShift, viewCtx);
      now += scale * (r.leg.side === 'buy' ? 1 : -1) * (legValue(r.leg, r.analytics.price, s, 0, ivShift, viewCtx) - r.analytics.price);
      t25 += scale * (r.leg.side === 'buy' ? 1 : -1) * (legValue(r.leg, r.analytics.price, s, horizonYears * 0.25, ivShift, viewCtx) - r.analytics.price);
      t50 += scale * (r.leg.side === 'buy' ? 1 : -1) * (legValue(r.leg, r.analytics.price, s, horizonYears * 0.5, ivShift, viewCtx) - r.analytics.price);
      t75 += scale * (r.leg.side === 'buy' ? 1 : -1) * (legValue(r.leg, r.analytics.price, s, horizonYears * 0.75, ivShift, viewCtx) - r.analytics.price);
    }
    curves[0].pnl.push(e);
    curves[1].pnl.push(now);
    curves[2].pnl.push(t25);
    curves[3].pnl.push(t50);
    curves[4].pnl.push(t75);
  }

  const expiryPnl = curves[0].pnl;
  const breakevens = findBreakevens(expiryPnl, spotAxis);
  const { maxProfit, maxLoss } = findExtremes(legs, expiryPnl, spotAxis);
  const lnStd = sigmaH;
  const pop = probabilityOfProfit(expiryPnl, spotAxis, spot, lnStd);
  const expectedValue = expectedValueOf(expiryPnl, spotAxis, spot, lnStd);

  let delta = 0, gamma = 0, vega = 0, theta = 0, rho = 0;
  for (const r of resolved) {
    const scale = (r.leg.side === 'buy' ? 1 : -1) * r.leg.qty * size;
    delta += scale * r.analytics.delta;
    gamma += scale * r.analytics.gamma;
    vega += scale * r.analytics.vega;
    theta += scale * r.analytics.theta;
    rho += scale * r.analytics.rho;
  }

  const carry = buildCarry(resolved, size, viewCtx);

  const spotShocks = [-0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.3];
  const ivShocks = [-0.4, -0.2, 0, 0.2, 0.4, 0.8];
  const matrix = ivShocks.map((ivs) =>
    spotShocks.map((ss) => {
      const s2 = spot * (1 + ss);
      let pnl = 0;
      for (const r of resolved) {
        const scale = r.leg.qty * size;
        const v = legValue(r.leg, r.analytics.price, s2, 0, ivs, viewCtx);
        pnl += scale * (r.leg.side === 'buy' ? 1 : -1) * (v - r.analytics.price);
      }
      return pnl;
    }),
  );

  const worst = Math.min(0, ...matrix.flat());
  const marginEstimate = Math.max(-worst * 1.1 + Math.max(netPremium, 0), Math.max(netPremium, 0), 1);

  const riskReward =
    maxProfit.kind === 'value' && maxLoss.kind === 'value' && (maxLoss.value ?? 0) > 0
      ? (maxProfit.value ?? 0) / (maxLoss.value ?? 0)
      : undefined;

  return {
    legs: resolved.map((r) => r.analytics),
    curves,
    spotAxis,
    netPremium,
    isCredit: netPremium < 0,
    maxProfit,
    maxLoss,
    breakevens,
    pop,
    expectedValue,
    riskReward,
    greeks: { delta, gamma, vega, theta, rho, deltaExposureUsd: delta * spot },
    carry,
    liquidity: Math.min(...resolved.map((r) => r.analytics.liquidity), 99),
    marginEstimate,
    scenarioMatrix: { spotShocks, ivShocks, pnl: matrix },
    horizonDays,
  };
}

function findBreakevens(pnl: number[], axis: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pnl.length - 1; i++) {
    const a = pnl[i];
    const b = pnl[i + 1];
    if (a === 0) out.push(axis[i]);
    else if (a * b < 0) {
      out.push(axis[i] + ((axis[i + 1] - axis[i]) * -a) / (b - a));
    }
  }
  return out.filter((v, i, arr) => i === 0 || Math.abs(v - arr[i - 1]) > 1e-6);
}

function findExtremes(legs: Leg[], pnl: number[], axis: number[]): { maxProfit: Extreme; maxLoss: Extreme } {
  let leftSlope = 0;
  let rightSlope = 0;
  for (const l of legs) {
    const scale = (l.side === 'buy' ? 1 : -1) * l.qty;
    if (l.kind === 'call') rightSlope += scale;
    else if (l.kind === 'put') leftSlope -= scale;
    else if (l.kind === 'perp_option') {
      // Everlasting tails: option-like with attenuated slope.
      const spot = axis[Math.floor(axis.length / 2)];
      const ot = legOptionType(l, spot) ?? 'call';
      if (ot === 'call') rightSlope += scale * 0.85;
      else leftSlope -= scale * 0.85;
    } else {
      leftSlope += scale;
      rightSlope += scale;
    }
  }
  const eps = 1e-9;
  let maxV = -Infinity, minV = Infinity, maxAt = 0, minAt = 0;
  for (let i = 0; i < pnl.length; i++) {
    if (pnl[i] > maxV) { maxV = pnl[i]; maxAt = axis[i]; }
    if (pnl[i] < minV) { minV = pnl[i]; minAt = axis[i]; }
  }
  const maxProfit: Extreme =
    rightSlope > eps || leftSlope < -eps
      ? { kind: 'unlimited' }
      : { kind: 'value', value: maxV, atPrice: maxAt };
  const maxLoss: Extreme =
    leftSlope > eps
      ? { kind: 'unlimited' }
      : { kind: 'value', value: minV, atPrice: minAt };
  return { maxProfit, maxLoss };
}

function probabilityOfProfit(pnl: number[], axis: number[], s0: number, lnStd: number): number {
  const mu = Math.log(s0);
  let prob = 0;
  const n = pnl.length;
  for (let i = 0; i < n - 1; i++) {
    const a = pnl[i];
    const b = pnl[i + 1];
    if (a <= 0 && b <= 0) continue;
    const [x0, x1] = [axis[i], axis[i + 1]];
    let lo: number, hi: number;
    if (a >= 0 && b >= 0) {
      lo = x0; hi = x1;
    } else {
      const cross = x0 + ((x1 - x0) * -a) / (b - a);
      if (a >= 0) { lo = x0; hi = cross; } else { lo = cross; hi = x1; }
    }
    if (hi <= lo) continue;
    prob += normCdf((Math.log(hi) - mu) / lnStd) - normCdf((Math.log(lo) - mu) / lnStd);
  }
  if (pnl[0] > 0) prob += normCdf((Math.log(axis[0]) - mu) / lnStd);
  if (pnl[n - 1] > 0) prob += 1 - normCdf((Math.log(axis[n - 1]) - mu) / lnStd);
  return Math.min(Math.max(prob, 0), 1);
}

function expectedValueOf(pnl: number[], axis: number[], s0: number, lnStd: number): number {
  const mu = Math.log(s0);
  const n = pnl.length;
  const dens = axis.map((x) => {
    const z = (Math.log(x) - mu) / lnStd;
    return Math.exp(-0.5 * z * z) / (x * lnStd * SQRT_2PI);
  });
  let ev = 0;
  for (let i = 0; i < n - 1; i++) {
    const dx = axis[i + 1] - axis[i];
    ev += 0.5 * (pnl[i] * dens[i] + pnl[i + 1] * dens[i + 1]) * dx;
  }
  // Tails: linear extrapolation with characteristic width.
  const leftExt = (pnl[1] - pnl[0]) / (axis[1] - axis[0]);
  ev += pnl[0] * normCdf((Math.log(axis[0]) - mu) / lnStd) - leftExt * dens[0];
  const rightExt = (pnl[n - 1] - pnl[n - 2]) / (axis[n - 1] - axis[n - 2]);
  ev += pnl[n - 1] * (1 - normCdf((Math.log(axis[n - 1]) - mu) / lnStd)) + rightExt * dens[n - 1];
  return ev;
}

function buildCarry(
  resolved: { leg: Leg; analytics: LegAnalytics }[],
  size: number,
  ctx: MarketCtx,
): CarryBudget | undefined {
  let daily = 0;
  let any = false;
  for (const r of resolved) {
    const scale = (r.leg.side === 'buy' ? 1 : -1) * r.leg.qty * size;
    if (r.leg.kind === 'perp_option') {
      any = true;
      const k = r.leg.strike ?? ctx.asset.spot;
      const fp = r.leg.fundingPeriodDays ?? 7;
      const ot = legOptionType(r.leg, ctx.asset.spot) ?? 'call';
      const ivFn = (t: number) => ivForStrike(ctx.cfg, ctx.asset.spot, k, t, ctx.asset.volShift);
      const mark = everlastingGreeks(ctx.asset.spot, k, fp, ivFn, ctx.cfg.rate, ot).price;
      const f = everlastingFunding(mark, ctx.asset.spot, k, ot);
      daily -= (scale * f) / fp;
    } else if (r.leg.kind === 'perp') {
      any = true;
      daily -= (scale * ctx.asset.fundingRate * r.analytics.price) / DAYS_PER_YEAR;
    }
  }
  if (!any) return undefined;
  return {
    dailyCarry: daily,
    weeklyCarry: daily * 7,
    monthlyCarry: daily * 30,
    scenarios: [
      { label: 'Low volatility (IV −25%)', carry7d: daily * 7 * 0.72 },
      { label: 'Current conditions', carry7d: daily * 7 },
      { label: 'IV +25%', carry7d: daily * 7 * 1.38 },
      { label: 'High utilization stress', carry7d: daily * 7 * 1.92 },
    ],
  };
}

/** Strike suggestion at ~target delta via bisection (used by templates). */
export function strikeForDelta(
  ctx: MarketCtx,
  tYears: number,
  targetDelta: number,
  isCall: boolean,
): number {
  const f = forwardPrice(ctx.cfg, ctx.asset.spot, tYears);
  let a = f * 0.5;
  let b = f * 2.0;
  for (let i = 0; i < 40; i++) {
    const mid = (a + b) / 2;
    const iv = ivForStrike(ctx.cfg, ctx.asset.spot, mid, tYears, ctx.asset.volShift);
    const g = bsGreeks(ctx.asset.spot, mid, tYears, iv, ctx.cfg.rate, isCall ? 'call' : 'put');
    const d = isCall ? g.delta : -g.delta;
    if (d > targetDelta) a = mid;
    else b = mid;
  }
  return (a + b) / 2;
}

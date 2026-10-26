// Deep options & trading metrics — every quantitative form the Strategies
// workspace surfaces beyond the basic analytics:
//
//   • IV surface    — term structure, 25Δ skew / risk reversal / butterfly
//   • Expected move — 1σ / 2σ horizon bands, implied vs realized premium
//   • Greeks II     — vanna, charm, vomma, speed (finite differences on the
//                     same BS / everlasting engines the terminal already uses)
//   • Risk          — VaR 95/99, CVaR 95, probability-of-touching per breakeven
//   • Execution     — capital, return-on-capital, theta yield, slippage
//
// All functions are pure and cheap enough to recompute on live spot.

import {
  DAYS_PER_YEAR,
  VOL_CONFIG,
  atmVol,
  bsGreeks,
  everlastingGreeks,
  forwardPrice,
  ivForStrike,
  makeCtx,
  normCdf,
  strikeForDelta,
  type MarketCtx,
} from './pricing';
import type { AssetMarket, Greeks, Leg, UnderlyingId } from './types';
import type { StrategyAnalysis } from './types';

// ── IV term structure ───────────────────────────────────────────────────────

export interface TermPoint {
  label: string;
  days: number;
  atm: number;
}

export function termStructure(underlying: UnderlyingId, market: AssetMarket): TermPoint[] {
  const cfg = VOL_CONFIG[underlying] ?? VOL_CONFIG.BTC;
  const tenors = [1, 7, 14, 30, 60, 90, 180, 365];
  return tenors.map((d) => ({
    label: d === 365 ? '1y' : d === 1 ? '1d' : `${d}d`,
    days: d,
    atm: atmVol(cfg, d / DAYS_PER_YEAR, market.volShift),
  }));
}

// ── 25Δ skew / risk reversal / butterfly ───────────────────────────────────

export interface SkewMetrics {
  atmIv: number;
  put25Iv: number;
  call25Iv: number;
  /** Risk reversal: call IV − put IV (negative ⇒ put skew / crash premium). */
  rr25: number;
  /** Butterfly: average wing IV − ATM (smile curvature). */
  fly25: number;
  /** 25Δ strikes resolved on live spot. */
  put25Strike: number;
  call25Strike: number;
}

export function skewMetrics(underlying: UnderlyingId, market: AssetMarket): SkewMetrics {
  const ctx: MarketCtx = makeCtx(underlying, market);
  const t = 30 / DAYS_PER_YEAR;
  const put25Strike = strikeForDelta(ctx, t, -0.25, false);
  const call25Strike = strikeForDelta(ctx, t, 0.25, true);
  const atmIv = atmVol(ctx.cfg, t, market.volShift);
  const put25Iv = ivForStrike(ctx.cfg, market.spot, put25Strike, t, market.volShift);
  const call25Iv = ivForStrike(ctx.cfg, market.spot, call25Strike, t, market.volShift);
  return {
    atmIv,
    put25Iv,
    call25Iv,
    rr25: call25Iv - put25Iv,
    fly25: (put25Iv + call25Iv) / 2 - atmIv,
    put25Strike,
    call25Strike,
  };
}

// ── Expected move & realized-vol proxy ─────────────────────────────────────

export interface ExpectedMove {
  /** 1σ move to horizon, in % of spot. */
  oneSigmaPct: number;
  twoSigmaPct: number;
  lo1: number;
  hi1: number;
  /** Annualized 1-day realized vol proxy from the live 24h change. */
  realized1dAnn: number;
  /** ATM IV minus the realized proxy — the volatility risk premium. */
  ivPremium: number;
}

export function expectedMove(
  underlying: UnderlyingId,
  market: AssetMarket,
  horizonDays: number,
): ExpectedMove {
  const cfg = VOL_CONFIG[underlying] ?? VOL_CONFIG.BTC;
  const t = Math.max(horizonDays, 1) / DAYS_PER_YEAR;
  const iv = atmVol(cfg, t, market.volShift);
  const oneSigma = iv * Math.sqrt(t);
  const realized1dAnn = Math.min(Math.abs(market.change24h ?? 0) * Math.sqrt(DAYS_PER_YEAR), 5);
  return {
    oneSigmaPct: oneSigma * 100,
    twoSigmaPct: oneSigma * 200,
    lo1: market.spot * (1 - oneSigma),
    hi1: market.spot * (1 + oneSigma),
    realized1dAnn,
    ivPremium: iv - realized1dAnn,
  };
}

// ── Second-order greeks (finite differences on the live engines) ──────────

export interface SecondOrderGreeks {
  vanna: number;   // ∂Δ/∂σ  — per 1 vol pt
  vomma: number;   // ∂Vega/∂σ — per 1 vol pt ($/vol pt)
  charm: number;   // ∂Δ/∂t  — per calendar day
  speed: number;   // ΔΓ per 1% spot move
}

const IV_STEP = 0.01;

function legGreeksAt(leg: Leg, ctx: MarketCtx, spot: number, tShiftDays = 0, ivShift = 0): Greeks {
  switch (leg.kind) {
    case 'call':
    case 'put': {
      const t = Math.max(((leg.expiryDays ?? 30) - tShiftDays) / DAYS_PER_YEAR, 1 / (365 * 24));
      const k = leg.strike ?? forwardPrice(ctx.cfg, spot, t);
      const iv = Math.min(
        Math.max(ivForStrike(ctx.cfg, spot, k, t, ctx.asset.volShift) * (1 + ivShift), 0.01),
        6,
      );
      return bsGreeks(spot, k, t, iv, ctx.cfg.rate, leg.kind);
    }
    case 'perp_option': {
      const k = leg.strike ?? spot;
      const fp = leg.fundingPeriodDays ?? 7;
      const ot = k >= spot ? 'call' : 'put';
      const ivFn = (t: number) =>
        Math.min(
          Math.max(ivForStrike(ctx.cfg, spot, k, t, ctx.asset.volShift) * (1 + ivShift), 0.01),
          6,
        );
      return everlastingGreeks(spot, k, fp, ivFn, ctx.cfg.rate, ot);
    }
    default: {
      // perp / spot: linear instruments.
      const d = leg.kind === 'perp' ? 1 : 1;
      return { price: spot, delta: d, gamma: 0, vega: 0, theta: 0, rho: 0 };
    }
  }
}

export function secondOrderGreeks(
  legs: Leg[],
  underlying: UnderlyingId,
  market: AssetMarket,
  size = 1,
): { net: SecondOrderGreeks; perLeg: { id: string; g: SecondOrderGreeks }[] } {
  const ctx: MarketCtx = makeCtx(underlying, market);
  const spot = market.spot;

  let vanna = 0, vomma = 0, charm = 0, speed = 0;
  const perLeg: { id: string; g: SecondOrderGreeks }[] = [];

  for (const leg of legs) {
    const scale = (leg.side === 'buy' ? 1 : -1) * leg.qty * size;

    if (leg.kind === 'perp' || leg.kind === 'spot') {
      perLeg.push({ id: leg.id, g: { vanna: 0, vomma: 0, charm: 0, speed: 0 } });
      continue;
    }

    const base = legGreeksAt(leg, ctx, spot);
    const up = legGreeksAt(leg, ctx, spot, 0, IV_STEP);
    const dn = legGreeksAt(leg, ctx, spot, 0, -IV_STEP);
    const back1d = legGreeksAt(leg, ctx, spot, 1, 0);
    const spotUp = legGreeksAt(leg, ctx, spot * 1.01);
    const spotDn = legGreeksAt(leg, ctx, spot * 0.99);

    const legVanna = (up.delta - dn.delta) / 2; // per 1 vol pt
    const legVomma = (up.vega - dn.vega) / 2;   // $ per vol pt
    // Everlasting options have no expiry → charm ≈ 0 by construction (their
    // selling point: no decay cliff). Dated legs: Δ today minus Δ tomorrow.
    const legCharm = leg.kind === 'perp_option' ? 0 : (base.delta - back1d.delta) / 1;
    const legSpeed = (spotUp.gamma - spotDn.gamma) / 2; // ΔΓ per 1% move

    vanna += scale * legVanna;
    vomma += scale * legVomma;
    charm += scale * legCharm;
    speed += scale * legSpeed;

    perLeg.push({ id: leg.id, g: { vanna: legVanna, vomma: legVomma, charm: legCharm, speed: legSpeed } });
  }

  return { net: { vanna, vomma, charm, speed }, perLeg };
}

// ── Distributional risk — VaR / CVaR / probability of touching ─────────────

export interface RiskMetrics {
  /** 5th percentile of the horizon P&L distribution (negative = loss). */
  var95: number;
  var99: number;
  /** Mean P&L below VaR95 — expected shortfall. */
  cvar95: number;
  /** Probability of profit already lives in analysis.pop; this adds P(touch). */
  touch: { level: number; prob: number }[];
  /** Horizon σ (log-space) used for the distribution. */
  sigmaH: number;
}

function lognormalCdfBetween(axis: number[], spot: number, sigmaH: number): number[] {
  // Probability mass of each axis bucket under ln S ~ N(ln spot, σ²).
  const mu = Math.log(spot);
  const out: number[] = [];
  for (let i = 0; i < axis.length; i++) {
    if (i === 0) {
      out.push(0);
    } else {
      // Bucket (axis[i-1], axis[i]].
      const a = normCdf((Math.log(axis[i - 1]) - mu) / sigmaH);
      const b = normCdf((Math.log(axis[i]) - mu) / sigmaH);
      out.push(Math.max(b - a, 0));
    }
  }
  // Normalize tail leakage outside the axis window.
  const s = out.reduce((x, y) => x + y, 0) || 1;
  return out.map((p) => p / s);
}

export function riskMetrics(
  analysis: StrategyAnalysis,
  spot: number,
  underlying: UnderlyingId,
  market: AssetMarket,
): RiskMetrics {
  const cfg = VOL_CONFIG[underlying] ?? VOL_CONFIG.BTC;
  const t = Math.max(analysis.horizonDays, 1) / DAYS_PER_YEAR;
  const sigmaH = atmVol(cfg, t, market.volShift) * Math.sqrt(t);

  const expiry = analysis.curves[0]?.pnl ?? [];
  const axis = analysis.spotAxis;
  const probs = lognormalCdfBetween(axis, spot, sigmaH);

  // Build the P&L distribution: sort outcomes, walk the CDF for quantiles.
  const points = axis
    .map((s, i) => ({ s, pnl: expiry[i] ?? 0, p: probs[i] ?? 0 }))
    .sort((a, b) => a.pnl - b.pnl);

  let cum = 0;
  let var95 = 0, var99 = 0;
  const tail95: number[] = [];
  let tailWeight = 0;
  for (const pt of points) {
    cum += pt.p;
    if (var99 === 0 && cum >= 0.01) var99 = pt.pnl;
    if (var95 === 0 && cum >= 0.05) var95 = pt.pnl;
    if (cum <= 0.05) {
      tail95.push(pt.pnl * pt.p);
      tailWeight += pt.p;
    }
  }
  const cvar95 = tailWeight > 0 ? tail95.reduce((a, b) => a + b, 0) / tailWeight : var95;

  // Probability of touching a level before horizon (GBM, driftless):
  //   P(touch b) = 2·Φ(−|ln(b/S)| / σ√T)
  const touch = analysis.breakevens.map((b) => ({
    level: b,
    prob: 2 * (1 - normCdf(Math.abs(Math.log(b / spot)) / Math.max(sigmaH, 1e-9))),
  }));

  return { var95, var99, cvar95, touch, sigmaH };
}

// ── Execution & capital efficiency ─────────────────────────────────────────

export interface ExecutionMetrics {
  /** Cash needed up front: premium paid (debits) or margin (credits). */
  capital: number;
  /** Max profit / capital (bounded strategies only). */
  rocAtMax: number | null;
  /** |θ| annualized / capital — the income engine's yield. */
  thetaYieldAnn: number | null;
  /** Est. slippage in bps of premium from structure liquidity. */
  slippageBps: number;
  /** Est. slippage in USD at size 1. */
  slippageUsd: number;
}

export function executionMetrics(analysis: StrategyAnalysis): ExecutionMetrics {
  const premium = Math.abs(analysis.netPremium);
  const capital = analysis.isCredit ? analysis.marginEstimate : Math.max(premium, 1);
  const mp = analysis.maxProfit;
  const rocAtMax =
    mp.kind === 'value' && capital > 0 ? (mp.value ?? 0) / capital : null;
  const thetaYieldAnn =
    analysis.greeks.theta !== 0 && capital > 0
      ? (Math.abs(analysis.greeks.theta) * DAYS_PER_YEAR) / capital
      : null;
  const slippageBps = 6 + (1 - Math.min(analysis.liquidity, 1)) * 54;
  const slippageUsd = (slippageBps / 10_000) * Math.max(premium, 50);
  return { capital, rocAtMax, thetaYieldAnn, slippageBps, slippageUsd };
}

// ── Cheap rail metric — credit/debit sign per strategy at a spot bucket ────

/** Approximate net premium sign & size for a spec without full analysis. */
export function quickPremium(
  spec: { legs: { kind: Leg['kind']; side: Leg['side']; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }[] },
  underlying: UnderlyingId,
  spot: number,
): number {
  const cfg = VOL_CONFIG[underlying] ?? VOL_CONFIG.BTC;
  let net = 0;
  for (const l of spec.legs) {
    let price: number;
    switch (l.kind) {
      case 'call':
      case 'put': {
        const t = Math.max((l.expiryDays ?? 30) / DAYS_PER_YEAR, 1 / 365);
        const k = l.strike !== undefined ? l.strike * spot : forwardPrice(cfg, spot, t);
        const iv = ivForStrike(cfg, spot, k, t, 0);
        price = bsGreeks(spot, k, t, iv, cfg.rate, l.kind).price;
        break;
      }
      case 'perp_option': {
        const k = (l.strike ?? 1) * spot;
        const fp = l.fundingPeriodDays ?? 7;
        const ot = k >= spot ? 'call' : 'put';
        price = everlastingGreeks(spot, k, fp, (t) => ivForStrike(cfg, spot, k, t, 0), cfg.rate, ot).price;
        break;
      }
      default:
        price = spot;
    }
    net += (l.side === 'buy' ? 1 : -1) * l.qty * price;
  }
  return net;
}

// ---------------------------------------------------------------------------
// agent-tools — the toolbelt exposed to the agentic research desk.
// Each tool is a Vercel AI SDK `tool()` with a JSON schema, executed
// server-side against the market intelligence engine, the 118-strategy
// catalog and the pricing analytics core.
// ---------------------------------------------------------------------------

import { tool, jsonSchema } from 'ai';
import type { Leg, LegKind, Side, AssetMarket } from '@/lib/types';
import { STRATEGIES, resolveStrategyLegs, type StrategySpec } from '@/lib/strategies';
import { analyzeStrategy } from '@/lib/pricing';
import {
  ASSET_IDS,
  type AssetId,
  type Timeframe,
  liveMarketState,
  getCandles,
  computeTechnicalSnapshot,
  detectCandlestickPatterns,
  detectSupportResistance,
  detectTrendlines,
  detectChartPatterns,
  fibLevels,
  analyzeVolRegime,
  analyzeMarketEnvironment,
  monteCarlo,
} from './market-intel';

const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d'];

function asAsset(v: unknown, fallback: AssetId = 'BTC'): AssetId {
  const s = String(v ?? '').toUpperCase();
  return (ASSET_IDS as string[]).includes(s) ? (s as AssetId) : fallback;
}

function asTimeframe(v: unknown, fallback: Timeframe = '4h'): Timeframe {
  const s = String(v ?? '');
  return TIMEFRAMES.includes(s as Timeframe) ? (s as Timeframe) : fallback;
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

function liveAssetMarket(asset: AssetId): AssetMarket {
  const s = liveMarketState()[asset];
  return {
    spot: s.spot,
    volShift: s.volShift,
    fundingRate: s.fundingRate,
    change24h: s.change24h,
    openInterest: s.openInterest,
    volume24h: s.volume24h,
  };
}

// --- catalog search helpers -------------------------------------------------------

function scoreStrategy(s: StrategySpec, q: string): number {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 1;
  const hay = `${s.name} ${s.description} ${s.category} ${s.view} ${s.tags.join(' ')}`.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (s.name.toLowerCase().includes(t)) score += 3;
    else if (s.tags.some((tag) => tag.includes(t))) score += 2;
    else if (hay.includes(t)) score += 1;
  }
  return score;
}

export interface StrategyAnalysisResult {
  strategyId?: string;
  name: string;
  underlying: string;
  spot: number;
  size: number;
  legCount: number;
  legs: Array<{
    kind: LegKind;
    side: Side;
    qty: number;
    strike?: number;
    expiryDays?: number;
    fundingPeriodDays?: number;
    iv?: number;
    price: number;
    delta: number;
    vega: number;
    theta: number;
    cost: number;
  }>;
  netPremium: number;
  isCredit: boolean;
  maxProfit: { kind: string; value?: number; atPrice?: number };
  maxLoss: { kind: string; value?: number; atPrice?: number };
  breakevens: number[];
  pop: number;
  expectedValue: number;
  riskReward: number;
  greeks: Record<string, number>;
  marginEstimate: number;
  liquidity: number;
  carryPerDay: number;
  scenarioMatrix: { spotShocks: number[]; ivShocks: number[]; pnl: number[][] };
  verdictNotes: string[];
}

export function analyzeStrategyPayload(args: {
  strategyId?: string;
  name?: string;
  underlying: AssetId;
  legs?: Array<Partial<Leg>>;
  size?: number;
}): StrategyAnalysisResult | { error: string } {
  const underlying = asAsset(args.underlying);
  const market = liveAssetMarket(underlying);
  const size = clampNum(args.size, 0.001, 10000, 1);
  let legs: Leg[] = [];
  let name = args.name ?? 'Custom strategy';
  let strategyId: string | undefined;

  if (args.strategyId) {
    const spec = STRATEGIES.find((s) => s.id === args.strategyId);
    if (!spec) return { error: `unknown strategyId '${args.strategyId}'` };
    legs = resolveStrategyLegs(spec, market.spot);
    name = spec.name;
    strategyId = spec.id;
  } else if (Array.isArray(args.legs) && args.legs.length > 0) {
    const KINDS: LegKind[] = ['call', 'put', 'perp_option', 'perp', 'spot'];
    let seq = 0;
    for (const raw of args.legs.slice(0, 25)) {
      seq += 1;
      const kind = KINDS.includes(raw.kind as LegKind) ? (raw.kind as LegKind) : 'call';
      const leg: Leg = {
        id: `ai-leg-${seq}`,
        kind,
        side: raw.side === 'sell' ? 'sell' : 'buy',
        qty: clampNum(raw.qty, 0.001, 1000, 1),
      };
      if (kind === 'call' || kind === 'put' || kind === 'perp_option') {
        leg.strike = clampNum(raw.strike, market.spot * 0.2, market.spot * 5, market.spot);
      }
      if (kind === 'call' || kind === 'put') {
        leg.expiryDays = clampNum(raw.expiryDays, 1, 365, 30);
      }
      if (kind === 'perp_option') {
        leg.fundingPeriodDays = clampNum(raw.fundingPeriodDays, 1, 90, 7);
      }
      legs.push(leg);
    }
  } else {
    return { error: 'provide either strategyId or a non-empty legs array' };
  }

  const a = analyzeStrategy(legs, underlying, market, size);
  const verdictNotes: string[] = [];
  verdictNotes.push(
    a.isCredit
      ? `Net credit of ${Math.abs(a.netPremium).toFixed(2)} USD per package — premium seller profile.`
      : `Net debit of ${a.netPremium.toFixed(2)} USD per package — premium buyer profile.`,
  );
  verdictNotes.push(
    `Probability of profit ${(a.pop * 100).toFixed(1)}%, expected value ${a.expectedValue >= 0 ? '+' : ''}${a.expectedValue.toFixed(2)} USD.`,
  );
  if (a.breakevens.length > 0) {
    verdictNotes.push(`Breakeven${a.breakevens.length > 1 ? 's' : ''}: ${a.breakevens.map((b) => b.toFixed(0)).join(' / ')} (spot ${market.spot.toFixed(0)}).`);
  }
  verdictNotes.push(
    `Greeks — delta ${a.greeks.delta.toFixed(2)} (${a.greeks.deltaExposureUsd >= 0 ? '+' : ''}$${a.greeks.deltaExposureUsd.toFixed(0)} notional), gamma ${a.greeks.gamma.toFixed(3)}, vega ${a.greeks.vega.toFixed(1)}, theta ${a.greeks.theta.toFixed(2)}/day.`,
  );
  if (a.carry) {
    verdictNotes.push(`Carry budget: theta ${a.carry.dailyCarry.toFixed(2)} USD/day vs funding drag — weekly ${a.carry.weeklyCarry.toFixed(1)} USD.`);
  }

  return {
    strategyId,
    name,
    underlying,
    spot: market.spot,
    size,
    legCount: a.legs.length,
    legs: a.legs.map((l) => ({
      kind: l.kind,
      side: l.side,
      qty: l.qty,
      strike: l.strike,
      expiryDays: l.expiryDays,
      fundingPeriodDays: l.fundingPeriodDays,
      iv: l.iv,
      price: l.price,
      delta: l.delta,
      vega: l.vega,
      theta: l.theta,
      cost: l.cost,
    })),
    netPremium: a.netPremium,
    isCredit: a.isCredit,
    maxProfit: a.maxProfit,
    maxLoss: a.maxLoss,
    breakevens: a.breakevens,
    pop: a.pop,
    expectedValue: a.expectedValue,
    riskReward: a.riskReward ?? (a.maxLoss.kind === 'value' && a.maxLoss.value !== 0 && a.maxProfit.kind === 'value' && a.maxProfit.value !== undefined
      ? Math.abs(a.maxProfit.value / a.maxLoss.value)
      : 0),
    greeks: {
      delta: a.greeks.delta,
      gamma: a.greeks.gamma,
      vega: a.greeks.vega,
      theta: a.greeks.theta,
      rho: a.greeks.rho,
      deltaExposureUsd: a.greeks.deltaExposureUsd,
    },
    marginEstimate: a.marginEstimate,
    liquidity: a.liquidity,
    carryPerDay: a.carry?.dailyCarry ?? 0,
    scenarioMatrix: a.scenarioMatrix,
    verdictNotes,
  };
}

// --- the toolbelt -------------------------------------------------------------------

export const marketTools = {
  get_market_state: tool({
    description:
      'Live market state for BTC, ETH and SOL: spot, 30d ATM IV, funding rate, 24h change, open interest and volume. Use this first to ground every analysis in current prices.',
    parameters: jsonSchema<{ asset?: string }>({
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'], description: 'Optional: restrict to one asset. Omit for all three.' },
      },
    }),
    execute: async ({ asset }) => {
      const s = liveMarketState();
      const pick = asset ? [asAsset(asset)] : (ASSET_IDS as AssetId[]);
      const assets = Object.fromEntries(
        pick.map((a) => [
          a,
          {
            spot: Number(s[a].spot.toFixed(2)),
            atmIv30dPct: Number((s[a].atmIv30d * 100).toFixed(1)),
            fundingRate: Number(s[a].fundingRate.toFixed(4)),
            fundingAnnualizedPct: Number((s[a].fundingRate * 365 * 100).toFixed(1)),
            change24hPct: Number(s[a].change24h.toFixed(2)),
            openInterestUsd: Math.round(s[a].openInterest),
            volume24hUsd: Math.round(s[a].volume24h),
          },
        ]),
      );
      return { tsMs: s.tsMs, assets };
    },
  }),

  get_price_history: tool({
    description:
      'OHLCV candle history (15m / 1h / 4h / 1d timeframes, up to 400 bars) for an asset. Returns the candles plus a compact recent-window summary.',
    parameters: jsonSchema<{ asset: string; timeframe?: string; limit?: number }>({
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        timeframe: { type: 'string', enum: ['15m', '1h', '4h', '1d'], description: 'Default 4h' },
        limit: { type: 'number', description: 'Candle count, 30–400. Default 120.' },
      },
      required: ['asset'],
    }),
    execute: async ({ asset, timeframe, limit }) => {
      const a = asAsset(asset);
      const tf = asTimeframe(timeframe);
      const n = Math.round(clampNum(limit, 30, 400, 120));
      const candles = getCandles(a, tf, n);
      const last = candles[candles.length - 1];
      const first = candles[0];
      return {
        asset: a,
        timeframe: tf,
        bars: candles.length,
        windowSummary: {
          open: first.o,
          close: last.c,
          high: Math.max(...candles.map((c) => c.h)),
          low: Math.min(...candles.map((c) => c.l)),
          changePct: Number((((last.c - first.o) / first.o) * 100).toFixed(2)),
        },
        recentCandles: candles.slice(-24).map((c) => ({
          t: c.t,
          o: Number(c.o.toFixed(2)),
          h: Number(c.h.toFixed(2)),
          l: Number(c.l.toFixed(2)),
          c: Number(c.c.toFixed(2)),
          v: c.v,
        })),
      };
    },
  }),

  compute_technical_indicators: tool({
    description:
      'Full technical indicator snapshot for an asset/timeframe: EMA 20/50/200 structure, RSI, MACD, Stochastic, Bollinger bands, ATR, ADX/DI, OBV, VWAP, plus a composite bias score (-1..1) and human-readable signals.',
    parameters: jsonSchema<{ asset: string; timeframe?: string }>({
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        timeframe: { type: 'string', enum: ['15m', '1h', '4h', '1d'], description: 'Default 4h' },
      },
      required: ['asset'],
    }),
    execute: async ({ asset, timeframe }) => {
      const snap = computeTechnicalSnapshot(asAsset(asset), asTimeframe(timeframe));
      return {
        ...snap,
        trend: { ...snap.trend, ema20: +snap.trend.ema20.toFixed(2), ema50: +snap.trend.ema50.toFixed(2), ema200: +snap.trend.ema200.toFixed(2), sma20: +snap.trend.sma20.toFixed(2), ema50SlopePct: +snap.trend.ema50SlopePct.toFixed(3), priceVsEma200Pct: +snap.trend.priceVsEma200Pct.toFixed(2) },
        momentum: { ...snap.momentum, rsi14: +snap.momentum.rsi14.toFixed(1), rsiPrev: +snap.momentum.rsiPrev.toFixed(1), macd: +snap.momentum.macd.toFixed(2), macdSignal: +snap.momentum.macdSignal.toFixed(2), macdHist: +snap.momentum.macdHist.toFixed(2), stochK: +snap.momentum.stochK.toFixed(1), stochD: +snap.momentum.stochD.toFixed(1), roc10: +snap.momentum.roc10.toFixed(2) },
        volatility: { ...snap.volatility, atr14: +snap.volatility.atr14.toFixed(2), atrPct: +snap.volatility.atrPct.toFixed(2), bbUpper: +snap.volatility.bbUpper.toFixed(2), bbMid: +snap.volatility.bbMid.toFixed(2), bbLower: +snap.volatility.bbLower.toFixed(2), bbWidthPct: +snap.volatility.bbWidthPct.toFixed(2), bbPercentB: +snap.volatility.bbPercentB.toFixed(2) },
        volume: { ...snap.volume, vwap20: +snap.volume.vwap20.toFixed(2), lastVsAvg20: +snap.volume.lastVsAvg20.toFixed(2), priceVsVwapPct: +snap.volume.priceVsVwapPct.toFixed(2) },
        strength: { ...snap.strength, adx14: +snap.strength.adx14.toFixed(1), plusDi: +snap.strength.plusDi.toFixed(1), minusDi: +snap.strength.minusDi.toFixed(1) },
        biasScore: +snap.biasScore.toFixed(2),
      };
    },
  }),

  detect_chart_patterns: tool({
    description:
      'Chart analysis engine: candlestick patterns (doji, hammer, engulfing, stars, soldiers…), support/resistance levels with strength, trendlines, classical chart patterns (double top/bottom, head & shoulders, triangles, channels, flags) and Fibonacci retracements.',
    parameters: jsonSchema<{ asset: string; timeframe?: string }>({
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        timeframe: { type: 'string', enum: ['15m', '1h', '4h', '1d'], description: 'Default 4h' },
      },
      required: ['asset'],
    }),
    execute: async ({ asset, timeframe }) => {
      const a = asAsset(asset);
      const tf = asTimeframe(timeframe);
      const live = liveMarketState()[a];
      return {
        asset: a,
        timeframe: tf,
        spot: live.spot,
        candlestickPatterns: detectCandlestickPatterns(a, tf),
        supportResistance: detectSupportResistance(a, tf).map((l) => ({
          ...l,
          price: +l.price.toFixed(2),
          distancePct: +l.distancePct.toFixed(2),
          strength: +l.strength.toFixed(2),
        })),
        trendlines: detectTrendlines(a, tf).map((t) => ({ ...t, from: +t.from.toFixed(2), to: +t.to.toFixed(2), slopePctPerBar: +t.slopePctPerBar.toFixed(4) })),
        chartPatterns: detectChartPatterns(a, tf),
        fibonacci: fibLevels(a, tf).map((f) => ({ ...f, price: +f.price.toFixed(2) })),
      };
    },
  }),

  analyze_volatility_regime: tool({
    description:
      'Volatility regime analysis: ATM IV term structure (7/30/90d), 25-delta skew, realized vol (20d/60d), IV−HV spread, IV percentile and regime classification with trading implications.',
    parameters: jsonSchema<{ asset: string }>({
      type: 'object',
      properties: { asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] } },
      required: ['asset'],
    }),
    execute: async ({ asset }) => {
      const v = analyzeVolRegime(asAsset(asset));
      return {
        ...v,
        atmIv7: +v.atmIv7.toFixed(4),
        atmIv30: +v.atmIv30.toFixed(4),
        atmIv90: +v.atmIv90.toFixed(4),
        skew25d: +v.skew25d.toFixed(4),
        hv20: +v.hv20.toFixed(4),
        hv60: +v.hv60.toFixed(4),
        ivHvSpread: +v.ivHvSpread.toFixed(4),
        ivPercentile: +v.ivPercentile.toFixed(0),
      };
    },
  }),

  analyze_market_environment: tool({
    description:
      'Fundamental + macro environment for an asset: market regime classification, funding/OI positioning, cross-asset correlations, macro narrative and probability-weighted 30-day scenarios (bull / base / bear / tail) with IV responses.',
    parameters: jsonSchema<{ asset: string }>({
      type: 'object',
      properties: { asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] } },
      required: ['asset'],
    }),
    execute: async ({ asset }) => {
      const env = analyzeMarketEnvironment(asAsset(asset));
      return {
        ...env,
        spot: +env.spot.toFixed(2),
        scenarios: env.scenarios.map((s) => ({ ...s, probability: +s.probability.toFixed(2), spotMovePct: +s.spotMovePct.toFixed(1), ivResponsePct: s.ivResponsePct })),
      };
    },
  }),

  run_monte_carlo: tool({
    description:
      'Monte Carlo likelihood simulation (up to 20k paths, fat-tail jumps): terminal price percentiles, expected move, probability above/below/touching specific price levels over a horizon. Use for probability-of-profit and barrier/stop analysis.',
    parameters: jsonSchema<{
      asset: string;
      days?: number;
      paths?: number;
      driftBpsPerDay?: number;
      levels?: number[];
    }>({
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        days: { type: 'number', description: 'Horizon in days (1–180), default 30' },
        paths: { type: 'number', description: 'Simulation paths (500–20000), default 4000' },
        driftBpsPerDay: { type: 'number', description: 'Optional drift bias in bps/day, default 0' },
        levels: { type: 'array', items: { type: 'number' }, description: 'Up to 6 price levels for prob above/below/touch analysis' },
      },
      required: ['asset'],
    }),
    execute: async ({ asset, days, paths, driftBpsPerDay, levels }) => {
      const mc = monteCarlo({
        asset: asAsset(asset),
        days: Math.round(clampNum(days, 1, 180, 30)),
        paths: Math.round(clampNum(paths, 500, 20000, 4000)),
        driftBpsPerDay: clampNum(driftBpsPerDay, -50, 50, 0),
        levels: Array.isArray(levels) ? levels.filter((l) => Number.isFinite(l)).slice(0, 6).map(Number) : undefined,
      });
      const p = (x: number) => +x.toFixed(2);
      return {
        ...mc,
        percentiles: {
          p5: p(mc.percentiles.p5),
          p10: p(mc.percentiles.p10),
          p25: p(mc.percentiles.p25),
          p50: p(mc.percentiles.p50),
          p75: p(mc.percentiles.p75),
          p90: p(mc.percentiles.p90),
          p95: p(mc.percentiles.p95),
        },
        expectedMovePct: +mc.expectedMovePct.toFixed(2),
        probAbove: mc.probAbove.map((x) => ({ level: p(x.level), probability: +x.probability.toFixed(3) })),
        probBelow: mc.probBelow.map((x) => ({ level: p(x.level), probability: +x.probability.toFixed(3) })),
        probTouch: mc.probTouch.map((x) => ({ level: p(x.level), probability: +x.probability.toFixed(3) })),
      };
    },
  }),

  search_strategies: tool({
    description:
      'Search the 118-strategy catalog (1–25 legs, 7 families: direction, income, volatility, protection, spread, perpetual, multileg) by free-text query and/or filters (market view, category, max complexity). Returns matching strategies with descriptions and tags.',
    parameters: jsonSchema<{
      query?: string;
      view?: string;
      category?: string;
      maxComplexity?: number;
      maxLegs?: number;
      limit?: number;
    }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text, e.g. "income with defined risk"' },
        view: { type: 'string', enum: ['bullish', 'bearish', 'neutral', 'volatile', 'low-vol'] },
        category: { type: 'string', enum: ['direction', 'income', 'volatility', 'protection', 'spread', 'perpetual', 'multileg'] },
        maxComplexity: { type: 'number', description: '1–5' },
        maxLegs: { type: 'number', description: '1–25' },
        limit: { type: 'number', description: 'Max results (default 8, max 15)' },
      },
    }),
    execute: async ({ query, view, category, maxComplexity, maxLegs, limit }) => {
      let pool = STRATEGIES;
      if (view) pool = pool.filter((s) => s.view === view);
      if (category) pool = pool.filter((s) => s.category === category);
      if (maxComplexity != null) pool = pool.filter((s) => s.complexity <= clampNum(maxComplexity, 1, 5, 5));
      if (maxLegs != null) pool = pool.filter((s) => s.legs.length <= clampNum(maxLegs, 1, 25, 25));
      const q = String(query ?? '');
      const scored = pool
        .map((s) => ({ s, score: scoreStrategy(s, q) }))
        .filter((x) => x.score > 0 || !q)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.round(clampNum(limit, 1, 15, 8)));
      return {
        totalCatalogSize: STRATEGIES.length,
        matches: scored.map(({ s }) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          view: s.view,
          complexity: s.complexity,
          legCount: s.legs.length,
          description: s.description,
          tags: s.tags,
        })),
      };
    },
  }),

  get_strategy_details: tool({
    description:
      'Full details of a catalog strategy: description, tags, and all legs resolved against live spot (strikes snapped to the asset grid) so it can be loaded straight into the builder.',
    parameters: jsonSchema<{ strategyId: string; underlying?: string }>({
      type: 'object',
      properties: {
        strategyId: { type: 'string', description: 'Catalog id, e.g. "iron-condor", "perp-income-grid-20"' },
        underlying: { type: 'string', enum: ['BTC', 'ETH', 'SOL'], description: 'Default BTC' },
      },
      required: ['strategyId'],
    }),
    execute: async ({ strategyId, underlying }) => {
      const spec = STRATEGIES.find((s) => s.id === strategyId);
      if (!spec) return { error: `unknown strategyId '${strategyId}'. Use search_strategies to find ids.` };
      const a = asAsset(underlying);
      const spot = liveMarketState()[a].spot;
      const legs = resolveStrategyLegs(spec, spot);
      return {
        id: spec.id,
        name: spec.name,
        category: spec.category,
        view: spec.view,
        complexity: spec.complexity,
        description: spec.description,
        tags: spec.tags,
        underlying: a,
        spot: +spot.toFixed(2),
        legCount: legs.length,
        resolvedLegs: legs.map((l) => ({
          kind: l.kind,
          side: l.side,
          qty: l.qty,
          strike: l.strike != null ? +l.strike.toFixed(2) : undefined,
          expiryDays: l.expiryDays,
          fundingPeriodDays: l.fundingPeriodDays,
        })),
      };
    },
  }),

  analyze_strategy: tool({
    description:
      'Deep analytics for one strategy (catalog id or custom legs) on an asset at live market: pricing, Greeks, net premium, max profit/loss, breakevens, POP, EV, risk/reward, margin estimate, carry, and a spot×IV scenario PnL matrix. The building block for profitability and likelihood analysis.',
    parameters: jsonSchema<{
      strategyId?: string;
      underlying?: string;
      size?: number;
      legs?: Array<{
        kind: string;
        side: string;
        qty: number;
        strike?: number;
        expiryDays?: number;
        fundingPeriodDays?: number;
      }>;
    }>({
      type: 'object',
      properties: {
        strategyId: { type: 'string', description: 'Catalog strategy id (preferred)' },
        underlying: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        size: { type: 'number', description: 'Package size multiplier, default 1' },
        legs: {
          type: 'array',
          description: 'Custom legs (max 25) when no strategyId is given',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['call', 'put', 'perp_option', 'perp', 'spot'] },
              side: { type: 'string', enum: ['buy', 'sell'] },
              qty: { type: 'number' },
              strike: { type: 'number' },
              expiryDays: { type: 'number' },
              fundingPeriodDays: { type: 'number' },
            },
            required: ['kind', 'side', 'qty'],
          },
        },
      },
    }),
    execute: async (args) => {
      const underlying = asAsset(args.underlying, 'BTC');
      const r = analyzeStrategyPayload({ ...args, underlying });
      if ('error' in r) return r;
      return {
        ...r,
        legs: r.legs.map((l) => ({ ...l, price: +l.price.toFixed(4), delta: +l.delta.toFixed(3), vega: +l.vega.toFixed(2), theta: +l.theta.toFixed(3), cost: +l.cost.toFixed(2), iv: l.iv != null ? +l.iv.toFixed(3) : undefined })),
        netPremium: +r.netPremium.toFixed(2),
        pop: +r.pop.toFixed(4),
        expectedValue: +r.expectedValue.toFixed(2),
        riskReward: +r.riskReward.toFixed(2),
        marginEstimate: +r.marginEstimate.toFixed(2),
        liquidity: +r.liquidity.toFixed(1),
        carryPerDay: +r.carryPerDay.toFixed(2),
        greeks: Object.fromEntries(Object.entries(r.greeks).map(([k, v]) => [k, +Number(v).toFixed(3)])),
        scenarioMatrix: r.scenarioMatrix,
      };
    },
  }),

  compare_strategies: tool({
    description:
      'Compare up to 4 strategies (catalog ids) on the same asset at live market: side-by-side POP, EV, risk/reward, net premium, Greeks, margin and liquidity, with a composite ranking for the current regime.',
    parameters: jsonSchema<{ strategyIds: string[]; underlying?: string; size?: number }>({
      type: 'object',
      properties: {
        strategyIds: { type: 'array', items: { type: 'string' }, description: '1–4 catalog strategy ids' },
        underlying: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        size: { type: 'number' },
      },
      required: ['strategyIds'],
    }),
    execute: async ({ strategyIds, underlying, size }) => {
      const ids = (strategyIds ?? []).slice(0, 4);
      if (ids.length === 0) return { error: 'provide 1–4 strategyIds' };
      const u = asAsset(underlying, 'BTC');
      const results = ids
        .map((id) => analyzeStrategyPayload({ strategyId: id, underlying: u, size }))
        .filter((r): r is StrategyAnalysisResult => !('error' in r));
      if (results.length === 0) return { error: 'no valid strategy ids' };
      const ranked = results
        .map((r) => {
          // composite score: EV normalized by margin + POP + R:R shape penalty for undefined risk
          const evPerMargin = r.marginEstimate > 0 ? r.expectedValue / r.marginEstimate : 0;
          const rr = r.riskReward > 0 ? Math.min(r.riskReward, 5) : 0.5;
          const defined = r.maxLoss.kind === 'value';
          const score = r.pop * 0.4 + Math.max(-1, Math.min(1, evPerMargin * 2)) * 0.3 + (rr / 5) * 0.2 + (defined ? 0.1 : 0);
          return { ...r, compositeScore: +score.toFixed(3) };
        })
        .sort((a, b) => b.compositeScore - a.compositeScore);
      return {
        underlying: u,
        spot: ranked[0].spot,
        ranking: ranked.map((r, i) => ({
          rank: i + 1,
          strategyId: r.strategyId,
          name: r.name,
          compositeScore: r.compositeScore,
          legCount: r.legCount,
          netPremium: +r.netPremium.toFixed(2),
          isCredit: r.isCredit,
          popPct: +(r.pop * 100).toFixed(1),
          expectedValue: +r.expectedValue.toFixed(2),
          riskReward: +r.riskReward.toFixed(2),
          maxProfit: r.maxProfit,
          maxLoss: r.maxLoss,
          delta: +r.greeks.delta.toFixed(2),
          vega: +r.greeks.vega.toFixed(1),
          thetaPerDay: +r.greeks.theta.toFixed(2),
          marginEstimate: +r.marginEstimate.toFixed(0),
          liquidity: +r.liquidity.toFixed(0),
        })),
      };
    },
  }),
};

export type MarketToolName = keyof typeof marketTools;

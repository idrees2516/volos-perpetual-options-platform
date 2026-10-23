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
  marketDataSource,
  primeLiveMarket,
  primeLiveCandles,
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
import {
  VENUE_IDS,
  VENUE_META,
  getVenueChain,
  getVenueExpiries,
  getVenueStatuses,
  getCrossVenueQuotes,
  type FeedAsset,
  type VenueId,
} from './exchange-feeds';
import { runBacktest, legsToSpecs, type BacktestLegSpec } from './backtest';
import {
  getPaperAccount,
  placePaperOrder,
  closePaperPosition,
  deployPaperStrategy,
  resolveOptionQuote,
  type PaperKind,
  type PaperSide,
} from './paper';
import { scan0dte, planMultihop, proposeMultileg } from './tactics';

const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d'];

/** Anchor every tool run to REAL exchange data (no-op when already fresh). */
async function ensureLive(asset?: string): Promise<'live' | 'simulated'> {
  await primeLiveMarket();
  if (asset) await primeLiveCandles(asAsset(asset));
  return marketDataSource();
}

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
      const source = await ensureLive(asset);
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
      return { source, tsMs: s.tsMs, assets };
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
      const source = await ensureLive(asset);
      const a = asAsset(asset);
      const tf = asTimeframe(timeframe);
      const n = Math.round(clampNum(limit, 30, 400, 120));
      const candles = getCandles(a, tf, n);
      const last = candles[candles.length - 1];
      const first = candles[0];
      return {
        source,
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
      const source = await ensureLive(asset);
      const snap = computeTechnicalSnapshot(asAsset(asset), asTimeframe(timeframe));
      return {
        source,
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
      const source = await ensureLive(asset);
      const a = asAsset(asset);
      const tf = asTimeframe(timeframe);
      const live = liveMarketState()[a];
      return {
        source,
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
      const source = await ensureLive(asset);
      const v = analyzeVolRegime(asAsset(asset));
      return {
        source,
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
      const source = await ensureLive(asset);
      const env = analyzeMarketEnvironment(asAsset(asset));
      return {
        source,
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
      const source = await ensureLive(asset);
      const mc = monteCarlo({
        asset: asAsset(asset),
        days: Math.round(clampNum(days, 1, 180, 30)),
        paths: Math.round(clampNum(paths, 500, 20000, 4000)),
        driftBpsPerDay: clampNum(driftBpsPerDay, -50, 50, 0),
        levels: Array.isArray(levels) ? levels.filter((l) => Number.isFinite(l)).slice(0, 6).map(Number) : undefined,
      });
      const p = (x: number) => +x.toFixed(2);
      return {
        source,
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
      const source = await ensureLive(args.underlying);
      const underlying = asAsset(args.underlying, 'BTC');
      const r = analyzeStrategyPayload({ ...args, underlying });
      if ('error' in r) return r;
      return {
        source,
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

  // ------------------------------------------------------------------
  // LIVE EXCHANGE CONNECTIVITY — Deribit, Bybit, OKX, Aevo, Paradex, Derive
  // ------------------------------------------------------------------

  get_live_options_chain: tool({
    description:
      'REAL live options chain from the connected exchanges (Deribit, Bybit, OKX, Aevo, Paradex, Derive v3): strikes with live IV, prices, greeks, OI, volume, bid/ask. Also returns the expiry calendar and which venues are live. Use for anything that needs real market quotes.',
    parameters: jsonSchema<{ asset?: string; venue?: string; expiry?: string }>({
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        venue: {
          type: 'string',
          enum: ['deribit', 'bybit', 'okx', 'aevo', 'paradex', 'derive', 'auto'],
          description: 'Which venue to pull; auto picks the best available (default)',
        },
        expiry: { type: 'string', description: 'Optional venue-native expiry label like 27NOV26 (from the expiry calendar)' },
      },
    }),
    execute: async ({ asset, venue, expiry }) => {
      const a = asAsset(asset, 'BTC');
      await ensureLive(a);
      const v: VenueId = venue && venue !== 'auto' && (VENUE_IDS as string[]).includes(venue) ? (venue as VenueId) : 'deribit';
      const { chain, error } = await getVenueChain(v, a as FeedAsset, expiry);
      if (!chain) {
        // fall back through the other venues
        for (const alt of VENUE_IDS.filter((x) => x !== v)) {
          const fb = await getVenueChain(alt, a as FeedAsset, expiry);
          if (fb.chain) {
            return {
              asset: a,
              requestedVenue: v,
              usedVenue: alt,
              note: `${VENUE_META[v].name} unavailable (${error}) — served from ${VENUE_META[alt].name}`,
              ...fb.chain,
            };
          }
        }
        return { error: `no live venue reachable: ${error}` };
      }
      const { expiries } = await getVenueExpiries(chain.venue, a as FeedAsset);
      return {
        asset: a,
        usedVenue: chain.venue,
        venueName: VENUE_META[chain.venue].name,
        quoteSource: chain.quoteSource,
        expiry: chain.expiry,
        daysOut: +chain.daysOut.toFixed(1),
        spot: +chain.spot.toFixed(2),
        forward: +chain.forward.toFixed(2),
        atmIvPct: +chain.atmIv.toFixed(1),
        expiryCalendar: expiries.slice(0, 10).map((e) => ({ label: e.label, daysOut: +e.daysOut.toFixed(1), instruments: e.instruments })),
        rows: chain.rows.slice(0, 40).map((r) => ({
          strike: r.strike,
          callIv: +r.callIv.toFixed(1), callPrice: +r.callPrice.toFixed(1), callDelta: +r.callDelta.toFixed(3),
          callOi: Math.round(r.callOi), callBid: r.callBid ? +r.callBid.toFixed(1) : undefined, callAsk: r.callAsk ? +r.callAsk.toFixed(1) : undefined,
          putIv: +r.putIv.toFixed(1), putPrice: +r.putPrice.toFixed(1), putDelta: +r.putDelta.toFixed(3),
          putOi: Math.round(r.putOi), putBid: r.putBid ? +r.putBid.toFixed(1) : undefined, putAsk: r.putAsk ? +r.putAsk.toFixed(1) : undefined,
          isAtm: r.isAtm,
        })),
      };
    },
  }),

  compare_venues: tool({
    description:
      'Compare ALL connected options exchanges (Deribit, Bybit, OKX, Aevo, Paradex/tradeparadigm, Derive v3) for an asset: live status, latency, instrument count, spot, ATM IV, and the cross-venue best bid/ask on near-ATM options for smart routing. Use before routing any multi-leg order.',
    parameters: jsonSchema<{ asset?: string }>({
      type: 'object',
      properties: { asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] } },
    }),
    execute: async ({ asset }) => {
      const a = asAsset(asset, 'BTC');
      await ensureLive(a);
      const [statuses, xq] = await Promise.all([getVenueStatuses(a as FeedAsset), getCrossVenueQuotes(a as FeedAsset)]);
      const near = xq.quotes.filter((q) => Math.abs(q.strike - xq.spot) / xq.spot < 0.03);
      return {
        asset: a,
        spot: +xq.spot.toFixed(2),
        venues: statuses.map((s) => ({
          venue: s.id,
          name: s.name,
          status: s.status,
          latencyMs: s.latencyMs,
          instruments: s.instruments,
          spot: s.spot ? +s.spot.toFixed(2) : null,
          atmIvPct: s.atmIv ? +s.atmIv.toFixed(1) : null,
          note: s.note,
        })),
        bestExecution: near.slice(0, 8).map((q) => ({
          option: `${q.kind} ${q.strike}`,
          bestBid: +q.bestBid.toFixed(1),
          bestBidVenue: q.bestBidVenue,
          bestAsk: +q.bestAsk.toFixed(1),
          bestAskVenue: q.bestAskVenue,
        })),
        routingNote:
          'sells should hit the best bid venue, buys the best ask venue; all six venues serve native live quotes (Paradex via its SBE stream, Derive v3 via its JSON-RPC tickers)',
      };
    },
  }),

  // ------------------------------------------------------------------
  // 0DTE / MULTIHOP / MULTILEG DESKS
  // ------------------------------------------------------------------

  scan_0dte: tool({
    description:
      'Scan the same-day (0DTE) options expiry across ALL live venues: expected move from the live ATM straddle, gamma/OI profile with pin risk, and ranked 0DTE structures (iron fly, iron condor, credit spreads, straddle) with REAL quotes, POP and expected value. Use for same-day income and gamma plays.',
    parameters: jsonSchema<{ asset?: string }>({
      type: 'object',
      properties: { asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] } },
    }),
    execute: async ({ asset }) => {
      const a = asAsset(asset, 'BTC');
      await ensureLive(a);
      try {
        const scan = await scan0dte(a);
        return {
          asset: scan.asset,
          venue: scan.venue,
          expiry: scan.expiry,
          hoursToExpiry: scan.hoursToExpiry,
          spot: +scan.spot.toFixed(2),
          atmIvPct: scan.atmIv,
          atmStraddle: scan.atmStraddle,
          expectedMove: scan.expectedMove,
          expectedMovePct: scan.expectedMovePct,
          impliedDailyVolPct: scan.impliedDailyVolPct,
          netGammaUsd: scan.netGammaUsd,
          pinRisk: scan.pinRisk,
          gammaByStrike: scan.gammaProfile.slice(0, 14),
          structures: scan.structures.map((s) => ({
            name: s.name,
            legs: s.legs,
            netCredit: s.netCredit,
            maxProfit: s.maxProfit,
            maxLoss: s.maxLoss,
            breakevens: s.breakevens.map((b) => +b.toFixed(1)),
            popPct: s.pop,
            expectedValue: s.expectedValue,
            rationale: s.rationale,
          })),
          timingPlan: scan.timingPlan,
          warnings: scan.warnings,
          quoteSource: scan.quoteSource,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  }),

  backtest_strategy: tool({
    description:
      'Backtest a strategy on REAL exchange history (Bybit spot klines with Deribit live-IV calibration): win rate, profit factor, expectancy, Sharpe, max drawdown, equity curve and sample trades. Accepts a catalog strategy id OR custom legs. Use to validate any recommendation with data before proposing it.',
    parameters: jsonSchema<{
      strategyId?: string;
      asset?: string;
      windowDays?: number;
      legs?: { kind: string; side: string; qty: number; strikeMult: number; expiryDays: number }[];
    }>({
      type: 'object',
      properties: {
        strategyId: { type: 'string', description: 'Catalog strategy id (e.g. iron-condor, 0dte-iron-fly)' },
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        windowDays: { type: 'number', description: 'Backtest window: 90–730 days (default 365)' },
        legs: {
          type: 'array',
          description: 'Custom legs (strike as multiplier of entry spot). Only when strategyId is omitted.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['call', 'put'] },
              side: { type: 'string', enum: ['buy', 'sell'] },
              qty: { type: 'number' },
              strikeMult: { type: 'number' },
              expiryDays: { type: 'number' },
            },
            required: ['kind', 'side', 'qty', 'strikeMult', 'expiryDays'],
          },
        },
      },
    }),
    execute: async ({ strategyId, asset, windowDays, legs }) => {
      const a = asAsset(asset, 'BTC');
      await ensureLive(a);
      try {
        let specs: BacktestLegSpec[] = [];
        let name = 'custom structure';
        if (strategyId) {
          const spec = STRATEGIES.find((s) => s.id === strategyId);
          if (!spec) return { error: `unknown strategy id: ${strategyId}` };
          const spot = liveMarketState()[a].spot;
          const resolved = resolveStrategyLegs(spec, spot);
          specs = legsToSpecs(resolved, spot);
          name = spec.name;
        } else if (legs && legs.length > 0) {
          specs = legs.map((l) => ({
            kind: l.kind === 'put' ? 'put' : 'call',
            side: l.side === 'sell' ? 'sell' : 'buy',
            qty: Math.min(Math.max(l.qty, 0.1), 50),
            strike: Math.min(Math.max(l.strikeMult, 0.5), 2),
            expiryDays: Math.min(Math.max(l.expiryDays, 1), 365),
          }));
        } else {
          return { error: 'provide strategyId or legs' };
        }
        const result = await runBacktest({
          asset: a,
          legs: specs,
          strategyName: name,
          windowDays: windowDays && Number.isFinite(windowDays) ? windowDays : 365,
        });
        return {
          asset: result.asset,
          strategy: result.strategyName,
          windowDays: result.windowDays,
          dataSource: result.dataSource,
          stats: result.stats,
          volModel: result.volModel,
          assumptions: result.assumptions,
          equityCurve: result.equityCurve,
          sampleTrades: result.sampleTrades,
          legs: result.legs,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  }),

  plan_multihop: tool({
    description:
      'Plan a MULTIHOP roll-chain for a strategy: the sequence of entry → roll-out/roll-up hops across expiries with per-hop greeks, expected carry, adjustment triggers and CROSS-VENUE best routing for each leg (which exchange to trade each leg on). Accepts a catalog strategy id or custom legs.',
    parameters: jsonSchema<{
      strategyId?: string;
      asset?: string;
      hops?: number;
      legs?: { kind: string; side: string; qty: number; strikeMult: number; expiryDays: number }[];
    }>({
      type: 'object',
      properties: {
        strategyId: { type: 'string' },
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        hops: { type: 'number', description: 'Number of hops in the roll chain (2–5, default 3)' },
        legs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['call', 'put'] },
              side: { type: 'string', enum: ['buy', 'sell'] },
              qty: { type: 'number' },
              strikeMult: { type: 'number' },
              expiryDays: { type: 'number' },
            },
            required: ['kind', 'side', 'qty', 'strikeMult', 'expiryDays'],
          },
        },
      },
    }),
    execute: async ({ strategyId, asset, hops, legs }) => {
      const a = asAsset(asset, 'BTC');
      await ensureLive(a);
      try {
        let planLegs: { kind: 'call' | 'put'; side: 'buy' | 'sell'; qty: number; strikeMult: number; expiryDays: number }[] = [];
        if (strategyId) {
          const spec = STRATEGIES.find((s) => s.id === strategyId);
          if (!spec) return { error: `unknown strategy id: ${strategyId}` };
          const spot = liveMarketState()[a].spot;
          const resolved = resolveStrategyLegs(spec, spot);
          planLegs = resolved
            .filter((l) => l.kind === 'call' || l.kind === 'put')
            .map((l) => ({
              kind: l.kind as 'call' | 'put',
              side: l.side as 'buy' | 'sell',
              qty: l.qty,
              strikeMult: l.strike != null ? +(l.strike / spot).toFixed(4) : 1,
              expiryDays: l.expiryDays ?? 30,
            }));
        } else if (legs && legs.length > 0) {
          planLegs = legs.map((l) => ({
            kind: l.kind === 'put' ? 'put' : 'call',
            side: l.side === 'sell' ? 'sell' : 'buy',
            qty: l.qty,
            strikeMult: Math.min(Math.max(l.strikeMult, 0.5), 2),
            expiryDays: Math.min(Math.max(l.expiryDays, 1), 365),
          }));
        } else {
          return { error: 'provide strategyId or legs' };
        }
        const plan = await planMultihop(a, planLegs, Math.min(Math.max(hops ?? 3, 2), 5));
        return plan;
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  }),

  build_multileg: tool({
    description:
      'Construct MULTILEG structures for a market view from the live options surface: iron condors, calendars, diagonals, ratio spreads, ZEBRAs, jade lizards, broken wing butterflies, backspreads and more — each priced off the real Deribit chain. Returns leg-by-leg specs (as spot multipliers + expiry days) ready for analysis or the builder.',
    parameters: jsonSchema<{ asset?: string; view?: string }>({
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        view: { type: 'string', enum: ['bullish', 'bearish', 'neutral', 'volatile', 'low-vol'], description: 'Market view the structure should express' },
      },
    }),
    execute: async ({ asset, view }) => {
      const a = asAsset(asset, 'BTC');
      await ensureLive(a);
      try {
        const v = (['bullish', 'bearish', 'neutral', 'volatile', 'low-vol'] as const).includes(view as never)
          ? (view as 'bullish' | 'bearish' | 'neutral' | 'volatile' | 'low-vol')
          : 'neutral';
        const candidates = await proposeMultileg(a, v);
        return {
          asset: a,
          view: v,
          candidates: candidates.map((c) => ({
            name: c.name,
            description: c.description,
            fit: c.fit,
            netEstimate: c.netEstimate,
            legs: c.legs,
          })),
          note: 'strikeMult values are fractions of live spot (e.g. 0.95 = 5% OTM put). Analyze with analyze_strategy or load via load_strategy.',
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  }),

  // ------------------------------------------------------------------
  // PAPER TRADING DESK — execute on the virtual account at REAL quotes
  // ------------------------------------------------------------------

  paper_account: tool({
    description:
      'Show the paper trading account: equity, cash, buying power, margin, unrealized/realized P&L, win rate, every open position (venue, entry, live mark, P&L), resting limit orders and recent fills. All positions are marked to live venue mid prices. Use whenever the user asks about their paper portfolio, positions or P&L.',
    parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: async () => {
      const acct = await getPaperAccount();
      return {
        equity: acct.equity,
        startingCash: acct.startingCash,
        cash: acct.cash,
        buyingPower: acct.buyingPower,
        marginHeld: acct.marginHeld,
        unrealizedPnl: acct.unrealized,
        realizedPnl: acct.realizedTotal,
        feesTotal: acct.feesTotal,
        winRate: `${acct.winRate}% (${acct.wins}W/${acct.losses}L)`,
        positions: acct.positions.map((p) => ({
          id: p.id,
          venue: p.venue,
          instrument: `${p.asset} ${p.expiry} ${p.strike} ${p.kind.toUpperCase()}`,
          side: p.side,
          qty: p.qty,
          entry: +p.entryPrice.toFixed(2),
          mark: +p.markPrice.toFixed(2),
          unrealized: p.unrealized,
          pnlPct: p.pnlPct,
          strategy: p.strategyTag,
        })),
        restingOrders: acct.openOrders.map((o) => ({
          id: o.id,
          order: `${o.side} ${o.qty} ${o.asset} ${o.expiry} ${o.strike} ${o.kind} @ ${o.limitPrice}`,
        })),
        recentFills: acct.fills.slice(0, 12).map((f) => ({
          ts: new Date(f.ts).toISOString().slice(5, 16).replace('T', ' '),
          fill: `${f.side} ${f.qty} ${f.asset} ${f.expiry} ${f.strike} ${f.kind} @ ${+f.price.toFixed(2)}`,
          venue: f.venue,
          fee: +f.fee.toFixed(2),
          strategy: f.strategyTag,
        })),
        note: 'paper account — every fill executes at the real venue best-bid/offer with taker fees',
      };
    },
  }),

  paper_order: tool({
    description:
      'Place a paper order on the virtual account — fills IMMEDIATELY at the REAL best-bid/ask across Deribit/Bybit/OKX/Aevo/Paradex/Derive v3 (venue auto-routes to the best executable price). Market orders fill now; limit orders rest until the market crosses. Charges realistic taker fees. Use whenever the user wants to buy/sell an option in the paper account.',
    parameters: jsonSchema<{
      asset?: string;
      strike: number;
      kind: string;
      side: string;
      qty?: number;
      venue?: string;
      expiry?: string;
      type?: string;
      limitPrice?: number;
    }>({
      type: 'object',
      required: ['strike', 'kind', 'side'],
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'], description: 'Default BTC' },
        strike: { type: 'number', description: 'Strike price (pick a listed strike from the chain)' },
        kind: { type: 'string', enum: ['call', 'put'] },
        side: { type: 'string', enum: ['buy', 'sell'] },
        qty: { type: 'number', description: 'Quantity in underlying units, e.g. 0.1 BTC (default 0.1)' },
        venue: {
          type: 'string',
          enum: ['auto', 'deribit', 'bybit', 'okx', 'aevo', 'paradex', 'derive'],
          description: 'auto = route to the venue with the best executable price (default)',
        },
        expiry: { type: 'string', description: 'Expiry label like 25OCT26 (default: nearest >1.5d)' },
        type: { type: 'string', enum: ['market', 'limit'], description: 'Default market' },
        limitPrice: { type: 'number', description: 'Required for limit orders' },
      },
    }),
    execute: async ({ asset, strike, kind, side, qty, venue, expiry, type, limitPrice }) => {
      try {
        const a = asAsset(asset, 'BTC') as FeedAsset;
        const k: PaperKind = kind === 'put' ? 'put' : 'call';
        const s: PaperSide = side === 'sell' ? 'sell' : 'buy';
        // preview first so the reply includes the cross-venue choice
        const { quote, alternatives } = await resolveOptionQuote(
          (venue as never) ?? 'auto',
          a,
          expiry,
          strike,
          k,
          s,
        );
        const res = await placePaperOrder({
          venue: (venue as never) ?? 'auto',
          asset: a,
          expiry,
          strike,
          kind: k,
          side: s,
          qty: qty && qty > 0 ? qty : 0.1,
          type: type === 'limit' ? 'limit' : 'market',
          limitPrice,
        });
        if (!res.ok) return { error: res.error };
        return {
          filled: res.fill
            ? {
                order: `${res.fill.side} ${res.fill.qty} ${res.fill.asset} ${res.fill.expiry} ${res.fill.strike} ${res.fill.kind.toUpperCase()}`,
                price: +res.fill.price.toFixed(2),
                fee: +res.fill.fee.toFixed(2),
                venue: res.fill.venue,
                spotAtFill: +res.fill.spotAtFill.toFixed(2),
              }
            : null,
          restedLimitOrder: res.rested
            ? { order: `${res.rested.side} ${res.rested.qty} @ ${res.rested.limitPrice}`, venue: res.rested.venue }
            : null,
          route: quote
            ? {
                chosen: quote.venue,
                bid: quote.bid != null ? +quote.bid.toFixed(2) : null,
                ask: quote.ask != null ? +quote.ask.toFixed(2) : null,
                iv: +quote.iv.toFixed(1),
                daysOut: +quote.daysOut.toFixed(1),
                alternatives: alternatives.slice(0, 6).map((x) => ({ venue: x.venue, bid: x.bid, ask: x.ask })),
              }
            : null,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  }),

  paper_close: tool({
    description:
      'Close a paper position (fully or partially) at the real opposite best-bid/offer. Pass the position id from paper_account. Use when the user wants to take profit / cut a loss on a paper position.',
    parameters: jsonSchema<{ positionId: string; qty?: number }>({
      type: 'object',
      required: ['positionId'],
      properties: {
        positionId: { type: 'string', description: 'Position id from paper_account' },
        qty: { type: 'number', description: 'Optional partial close quantity (default: close all)' },
      },
    }),
    execute: async ({ positionId, qty }) => {
      const res = await closePaperPosition(positionId, qty);
      if (!res.ok || !res.fill) return { error: res.error ?? 'close failed' };
      return {
        closed: {
          order: `${res.fill.side} ${res.fill.qty} ${res.fill.asset} ${res.fill.expiry} ${res.fill.strike} ${res.fill.kind.toUpperCase()}`,
          price: +res.fill.price.toFixed(2),
          fee: +res.fill.fee.toFixed(2),
          venue: res.fill.venue,
        },
        note: 'realized P&L has been booked to the account',
      };
    },
  }),

  paper_deploy_strategy: tool({
    description:
      'Deploy a complete multi-leg options strategy to the paper account as ONE package: every leg is priced at real quotes (auto-routed per leg to the venue with the best price), strikes snap to nearest listed, margin is checked in aggregate, and legs fill atomically with a strategy tag. Use whenever the user wants to paper-trade an iron condor, spread, straddle, or any structure they designed.',
    parameters: jsonSchema<{
      name?: string;
      asset?: string;
      venue?: string;
      sizeMultiplier?: number;
      legs: Array<{ kind: string; side: string; qty: number; strike?: number; strikeMult?: number; expiryDays?: number }>;
    }>({
      type: 'object',
      required: ['legs'],
      properties: {
        name: { type: 'string', description: 'Strategy label, e.g. "Iron Condor 25OCT26"' },
        asset: { type: 'string', enum: ['BTC', 'ETH', 'SOL'] },
        venue: { type: 'string', enum: ['auto', 'deribit', 'bybit', 'okx', 'aevo', 'paradex', 'derive'] },
        sizeMultiplier: { type: 'number', description: 'Multiplies every leg qty (default 1)' },
        legs: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          description: 'Option legs; give absolute strike or strikeMult (fraction of spot, e.g. 0.95)',
          items: {
            type: 'object',
            required: ['kind', 'side', 'qty'],
            properties: {
              kind: { type: 'string', enum: ['call', 'put'] },
              side: { type: 'string', enum: ['buy', 'sell'] },
              qty: { type: 'number', description: 'Units of underlying, e.g. 0.1' },
              strike: { type: 'number', description: 'Absolute strike (preferred)' },
              strikeMult: { type: 'number', description: 'Fraction of spot when strike unknown (0.95 = 5% OTM put)' },
              expiryDays: { type: 'number', description: 'Days to expiry — snapped to the nearest listed (default 7)' },
            },
          },
        },
      },
    }),
    execute: async ({ name, asset, venue, sizeMultiplier, legs }) => {
      try {
        const a = asAsset(asset, 'BTC') as FeedAsset;
        // resolve strikeMult → absolute strikes using live spot
        const { chain } = await getVenueChain('deribit', a);
        const spot = chain?.spot ?? 0;
        const resolved = [] as Array<{ kind: 'call' | 'put'; side: 'buy' | 'sell'; qty: number; strike: number; expiryDays: number }>;
        for (const l of legs) {
          let strike = Number(l.strike ?? 0);
          if (!(strike > 0) && l.strikeMult && spot > 0) {
            const step = spot >= 50000 ? 500 : spot >= 4000 ? 50 : 5;
            strike = Math.round((spot * l.strikeMult) / step) * step;
          }
          if (!(strike > 0)) return { error: 'each leg needs strike or strikeMult' };
          resolved.push({
            kind: l.kind === 'put' ? 'put' : 'call',
            side: l.side === 'sell' ? 'sell' : 'buy',
            qty: l.qty,
            strike,
            expiryDays: l.expiryDays ?? 7,
          });
        }
        const res = await deployPaperStrategy({
          name: name ?? 'Copilot Strategy',
          asset: a,
          venue: (venue as never) ?? 'auto',
          sizeMultiplier,
          legs: resolved,
        });
        if (!res.ok) return { error: res.error, partialLegs: res.legs };
        return {
          deployed: res.name,
          legsFilled: res.legs.map((l) => ({ leg: l.leg, venue: l.venue, price: +l.price.toFixed(2), fee: +l.fee.toFixed(2), iv: +l.iv.toFixed(1) })),
          netPremium: res.netPremium != null ? +res.netPremium.toFixed(2) : undefined,
          cashAfter: res.cashAfter != null ? +res.cashAfter.toFixed(2) : undefined,
          note: 'all legs filled at real venue quotes; view positions with paper_account',
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  }),
};

export type MarketToolName = keyof typeof marketTools;

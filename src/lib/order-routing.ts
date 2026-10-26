// ---------------------------------------------------------------------------
// order-routing — per-platform smart order routing & creation engine.
//
// For EVERY venue the strategy can run on (native or synthetic), this module
// scores four routing dimensions with concrete, dollar-denominated numbers:
//
//   EFFICIENCY         — all-in execution cost: taker/maker fees, per-contract
//                        fees, settlement, multi-ticket overhead and modeled
//                        slippage → % of premium burnt per round trip.
//   PERFORMANCE        — order-ack latency, fill probability for THIS ticket
//                        (width vs venue limits, RFQ vs CLOB vs on-chain),
//                        expected time-to-fill and throughput.
//   PRICE & PROFIT     — maker-capture strategy, fee savings vs crossing,
//                        price improvement from passive mid quoting, and the
//                        share of theoretical edge retained after all costs.
//   SAFETY & SECURITY  — custody tier, central clearing / insurance fund,
//                        pre-trade risk checks, kill-switch and failover.
//
// A weighted composite (30/25/25/20) ranks the venues and the winner becomes
// the recommended route. Each fit also carries a full ORDER CREATION PLAN —
// the concrete ticket-by-ticket recipe (instrument selection, pricing offsets,
// order types, TIFs, execution sequence, post-trade guards).
// ---------------------------------------------------------------------------

import type { UnderlyingId } from './types';
import type { StrategySpec } from './strategies';
import { platformsForStrategy, type Platform, type Support } from './platforms';

// ── routing profile per platform ────────────────────────────────────────────

export type ExecModel = 'RFQ dealer basket' | 'CLOB + RFQ' | 'central limit book' | 'complex-order book' | 'futures book' | 'on-chain LP ranges' | 'broker SMART router';

export interface RoutingProfile {
  /** Order-ack latency, ms (median). */
  ackMs: number;
  /** How this venue executes tickets. */
  execModel: ExecModel;
  /** Fraction of a round trip that can realistically be passive/maker, 0–1. */
  makerCapture: number;
  /** Typical top-of-book spread on an ATM-ish option, bps of premium. */
  spreadBps: number;
  /** Base slippage per fill beyond the spread, bps of premium (size/latency driven). */
  baseSlipBps: number;
  /** Who holds the collateral. */
  custody: string;
  /** Custody safety tier 1–5 (5 = best: regulated central clearing). */
  custodyTier: 1 | 2 | 3 | 4 | 5;
  /** Who guarantees settlement / absorbs default. */
  clearing: string;
  /** Clearing safety tier 1–5 (5 = best: OCC/CME-style CCP guarantee). */
  clearingTier: 1 | 2 | 3 | 4 | 5;
  /** Named pre-trade risk controls on this venue. */
  riskChecks: string[];
  /** Broker/exchange kill-switch capability. */
  killSwitch: string;
  /** If this venue fails, where the same structure routes. */
  failover: string;
}

const PROFILES: Record<string, RoutingProfile> = {
  // ── modern · perpetual-native ──────────────────────────────────────────
  derive: {
    ackMs: 250, execModel: 'RFQ dealer basket', makerCapture: 0.35, spreadBps: 25, baseSlipBps: 10,
    custody: 'self-custody — L2 smart-contract wallet', custodyTier: 4,
    clearing: 'Derive margin pool + insurance fund', clearingTier: 3,
    riskChecks: ['real-time portfolio margin', 'sub-account isolation', 'dealer quote mark-outs', 'oracle circuit breakers'],
    killSwitch: 'cancel-all API per sub-account',
    failover: 'Paradex or Aevo for the dated wings; Deribit for the dated version',
  },
  paradex: {
    ackMs: 150, execModel: 'CLOB + RFQ', makerCapture: 0.5, spreadBps: 20, baseSlipBps: 8,
    custody: 'self-custody — StarkEx app-chain', custodyTier: 4,
    clearing: 'Paradex insurance fund + ADL waterfall', clearingTier: 3,
    riskChecks: ['portfolio margin engine', 'auto-deleveraging (ADL)', 'price bands', 'mark-price guards'],
    killSwitch: 'cancel-all + close-all endpoint',
    failover: 'Derive (multileg RFQ) or Deribit (dated legs)',
  },
  aevo: {
    ackMs: 80, execModel: 'CLOB + RFQ', makerCapture: 0.6, spreadBps: 15, baseSlipBps: 7,
    custody: 'self-custody — off-chain matching, on-chain settlement', custodyTier: 4,
    clearing: 'Aevo default fund', clearingTier: 3,
    riskChecks: ['margin engine', 'price bands', 'market-maker obligations'],
    killSwitch: 'cancel-all REST/WS call',
    failover: 'Deribit dated book (daily expiries overlap)',
  },
  hyperliquid: {
    ackMs: 30, execModel: 'futures book', makerCapture: 0.7, spreadBps: 4, baseSlipBps: 3,
    custody: 'self-custody — L1 smart contract', custodyTier: 5,
    clearing: 'HL vault + insurance fund + ADL', clearingTier: 4,
    riskChecks: ['isolated/cross margin tiers', 'ADL', 'oracle guards', 'per-asset position caps'],
    killSwitch: 'cancel-all + immediate market-close',
    failover: 'Binance perps for the hedge leg only',
  },
  panoptic: {
    ackMs: 45_000, execModel: 'on-chain LP ranges', makerCapture: 1.0, spreadBps: 60, baseSlipBps: 35,
    custody: 'non-custodial — UniV3 position NFTs', custodyTier: 3,
    clearing: 'on-chain collateral only (no CCP)', clearingTier: 2,
    riskChecks: ['atomic mints/burns (no partial fills)', 'slippage control via private RPC', 'position range caps'],
    killSwitch: 'burn the LP position (on-chain exit)',
    failover: 'Derive/Paradex for real options books',
  },

  // ── legacy · crypto CEXs ───────────────────────────────────────────────
  deribit: {
    ackMs: 15, execModel: 'central limit book', makerCapture: 0.65, spreadBps: 10, baseSlipBps: 6,
    custody: 'CEX omnibus (cold-wallet majority)', custodyTier: 3,
    clearing: 'Deribit insurance fund — deepest in crypto options', clearingTier: 4,
    riskChecks: ['portfolio margin (HV stress)', 'fat-finger price bands', 'API-key scopes + 2FA', 'real-time surveillance'],
    killSwitch: 'cancel-all + block-trade desk fallback',
    failover: 'OKX/Bybit books for the same dated structure',
  },
  okx: {
    ackMs: 40, execModel: 'central limit book', makerCapture: 0.6, spreadBps: 15, baseSlipBps: 8,
    custody: 'CEX omnibus + proof-of-reserves', custodyTier: 3,
    clearing: 'unified account margin + insurance fund', clearingTier: 3,
    riskChecks: ['unified margin engine', 'price bands', 'sub-account isolation'],
    killSwitch: 'cancel-all per instrument/account',
    failover: 'Deribit for depth; Bybit for dailies',
  },
  bybit: {
    ackMs: 25, execModel: 'central limit book', makerCapture: 0.6, spreadBps: 12, baseSlipBps: 7,
    custody: 'CEX omnibus', custodyTier: 3,
    clearing: 'unified trading account + insurance fund', clearingTier: 3,
    riskChecks: ['unified margin', 'price bands', 'position caps'],
    killSwitch: 'cancel-all endpoint',
    failover: 'Deribit dailies (active 0DTE book)',
  },
  binance: {
    ackMs: 20, execModel: 'futures book', makerCapture: 0.75, spreadBps: 3, baseSlipBps: 3,
    custody: 'CEX omnibus + SAFU fund', custodyTier: 3,
    clearing: 'SAFU insurance + ADL', clearingTier: 3,
    riskChecks: ['tiered margin', 'ADL', 'price limits'],
    killSwitch: 'cancel-all + close-all',
    failover: 'Hyperliquid perps for the hedge leg',
  },
  'cme-crypto': {
    ackMs: 9, execModel: 'central limit book', makerCapture: 0.5, spreadBps: 9, baseSlipBps: 8,
    custody: 'FCM custody (segregated client funds)', custodyTier: 5,
    clearing: 'CME clearing house — CCP guarantee', clearingTier: 5,
    riskChecks: ['Globex price bands', 'position limits', 'FCM pre-trade risk desk', 'base/escalator margins'],
    killSwitch: 'cancel-all via FCM/Globex',
    failover: 'CBOE (ETF proxies) or Deribit (crypto-native)',
  },

  // ── legacy · TradFi ────────────────────────────────────────────────────
  cboe: {
    ackMs: 2, execModel: 'complex-order book', makerCapture: 0.55, spreadBps: 6, baseSlipBps: 5,
    custody: 'broker account → OCC member', custodyTier: 5,
    clearing: 'OCC — AAA-rated central counterparty', clearingTier: 5,
    riskChecks: ['OCC SPAN margin', 'exchange price-protection rules', 'complex-order auto-match', 'Reg-T / portfolio margin', 'broker pre-trade suit & fat-finger checks'],
    killSwitch: 'cancel-all via broker FIX drop; MOC unwind',
    failover: 'complex book is mirrored on MIAX/Nasdaq — route away in seconds',
  },
  'cme-equity': {
    ackMs: 2, execModel: 'central limit book', makerCapture: 0.5, spreadBps: 7, baseSlipBps: 6,
    custody: 'FCM custody (segregated)', custodyTier: 5,
    clearing: 'CME clearing house — CCP guarantee', clearingTier: 5,
    riskChecks: ['Globex price bands', 'position limits', 'FCM pre-trade desk', 'performance bonds'],
    killSwitch: 'Globex cancel-all via FCM',
    failover: 'CBOE SPX book for the index version',
  },
  nasdaq: {
    ackMs: 1, execModel: 'central limit book', makerCapture: 0.5, spreadBps: 8, baseSlipBps: 6,
    custody: 'broker → OCC member', custodyTier: 5,
    clearing: 'OCC — AAA-rated CCP', clearingTier: 5,
    riskChecks: ['OCC margin', 'NBBO protection', 'exchange complex orders', 'broker fat-finger checks'],
    killSwitch: 'cancel-all via broker FIX',
    failover: 'MIAX / CBOE same-structure books',
  },
  miax: {
    ackMs: 2, execModel: 'complex-order book', makerCapture: 0.62, spreadBps: 9, baseSlipBps: 7,
    custody: 'broker → OCC member', custodyTier: 5,
    clearing: 'OCC — AAA-rated CCP', clearingTier: 5,
    riskChecks: ['OCC margin', 'complex-order protections', 'maker-incentive programs'],
    killSwitch: 'cancel-all via broker FIX',
    failover: 'CBOE / Nasdaq books',
  },
  ibkr: {
    ackMs: 300, execModel: 'broker SMART router', makerCapture: 0.5, spreadBps: 12, baseSlipBps: 4,
    custody: 'broker — SIPC + excess insurance', custodyTier: 4,
    clearing: 'OCC + clearing brokers (multi-CCP)', clearingTier: 5,
    riskChecks: ['Risk Navigator pre-trade margin', 'SMART best-execution guarantee', 'portfolio margin', '2FA + permissioned API keys'],
    killSwitch: 'basket cancel-all across venues',
    failover: 'SMART re-routes across all 6 US options exchanges automatically',
  },
};

// ── scoring helpers ─────────────────────────────────────────────────────────

export interface CostBreakdown {
  takerFeesUsd: number;
  makerFeesUsd: number;
  perContractUsd: number;
  settlementUsd: number;
  slippageUsd: number;
  multiTicketUsd: number;
  totalUsd: number;
  /** total cost as % of |premium|. */
  pctOfPremium: number;
}

export interface RoutingDimension {
  score: number; // 0–100
  headline: string;
  detail: string[];
}

export interface CreationStep {
  phase: 'Pre-trade' | 'Ticket' | 'Pricing' | 'Execution' | 'Post-trade';
  title: string;
  detail: string;
}

export interface RoutingFit {
  platform: Platform;
  support: Support;
  routable: boolean;
  /** 0–100 composites. */
  efficiency: RoutingDimension;
  performance: RoutingDimension;
  priceProfit: RoutingDimension;
  safety: RoutingDimension;
  composite: number;
  rank: number;
  cost: CostBreakdown;
  /** Concrete microstructure numbers. */
  ackMs: number;
  fillProb: number;
  estTimeToFillSec: number;
  makerCapturePct: number;
  makerSavingUsd: number;
  priceImprovementUsd: number;
  edgeRetentionPct: number;
  execModel: ExecModel;
  profile: RoutingProfile;
  /** The order creation recipe for THIS strategy on THIS venue. */
  creation: CreationStep[];
}

const clamp = (v: number, lo = 0, hi = 100) => Math.min(Math.max(v, lo), hi);

/** 100 at 0ms → ~10 at 60s on a log₁₀ scale. */
function latencyScore(ms: number): number {
  if (ms <= 1) return 100;
  return clamp(100 - 15 * Math.log10(ms) * 1.35);
}

/** 100 at 0% cost → 50 at ~6% of premium burnt. */
function costCurve(pct: number): number {
  return clamp(100 / (1 + Math.pow(pct / 0.06, 1.6)));
}

// ── the engine ──────────────────────────────────────────────────────────────

export interface RoutingWeights {
  efficiency: number;
  performance: number;
  priceProfit: number;
  safety: number;
}

export const DEFAULT_WEIGHTS: RoutingWeights = { efficiency: 0.3, performance: 0.25, priceProfit: 0.25, safety: 0.2 };

export function routingForStrategy(
  spec: StrategySpec,
  underlying: UnderlyingId,
  premiumUsd: number,
  weights: RoutingWeights = DEFAULT_WEIGHTS,
): RoutingFit[] {
  const legCount = spec.legs.length;
  const prem = Math.max(Math.abs(premiumUsd), 50);
  const fits = platformsForStrategy(spec, underlying, premiumUsd);

  const out = fits.map((fit): RoutingFit => {
    const p = fit.platform;
    const prof = PROFILES[p.id] ?? PROFILES.deribit;
    const routable = fit.support === 'native' || fit.support === 'synthetic';
    const tickets = routable ? Math.max(1, Math.ceil(legCount / p.maxLegsPerTicket)) : 0;

    // ── efficiency: the all-in cost model ────────────────────────────────
    // maker-capture strategy: passive fraction pays maker fee, rest pays taker.
    const makerLegFrac = routable ? prof.makerCapture : 0;
    const takerFees =
      (p.fee.takerBpsPremium / 10_000) * prem * 2 * (1 - makerLegFrac);
    const makerFees =
      (p.fee.makerBpsPremium / 10_000) * prem * 2 * makerLegFrac;
    const perContract = (p.fee.perContractUsd ?? 0) * legCount * 2;
    const settlement = ((p.fee.settlementBps ?? 0) / 10_000) * prem;
    // slippage scales with latency, ticket splitting and leg count.
    const slipBps =
      prof.baseSlipBps * (1 + 0.35 * (tickets - 1)) * (1 + 0.06 * Math.max(0, legCount - 2));
    const slippage = (slipBps / 10_000) * prem * 2 * (1 - makerLegFrac * 0.7);
    const multiTicket = routable ? (tickets - 1) * (0.0015 * prem) : 0;
    const totalUsd = takerFees + makerFees + perContract + settlement + slippage + multiTicket;
    const pctOfPremium = (totalUsd / prem) * 100;
    const cost: CostBreakdown = {
      takerFeesUsd: +takerFees.toFixed(2),
      makerFeesUsd: +makerFees.toFixed(2),
      perContractUsd: +perContract.toFixed(2),
      settlementUsd: +settlement.toFixed(2),
      slippageUsd: +slippage.toFixed(2),
      multiTicketUsd: +multiTicket.toFixed(2),
      totalUsd: +totalUsd.toFixed(2),
      pctOfPremium: +pctOfPremium.toFixed(2),
    };

    const efficiency: RoutingDimension = {
      score: routable ? costCurve(pctOfPremium / 100) : 0,
      headline: routable
        ? `${cost.totalUsd < 100 ? '$' + cost.totalUsd.toFixed(1) : '$' + Math.round(cost.totalUsd)} all-in ≈ ${pctOfPremium.toFixed(1)}% of premium`
        : '—',
      detail: [
        `taker legs: $${cost.takerFeesUsd} · maker legs: $${cost.makerFeesUsd} (${Math.round(makerLegFrac * 100)}% passive)`,
        `per-contract: $${cost.perContractUsd} · settlement: $${cost.settlementUsd}`,
        `slippage @ ~${Math.round(slipBps)}bps: $${cost.slippageUsd}${tickets > 1 ? ` · ${tickets}-ticket overhead: $${cost.multiTicketUsd}` : ''}`,
      ],
    };

    // ── performance: latency + fill probability ──────────────────────────
    const ticketFit = legCount <= p.maxLegsPerTicket;
    const fillBase =
      p.kind === 'perp-native DEX' ? 0.86
      : p.kind === 'on-chain options AMM' ? 0.72
      : p.kind === 'crypto CEX' ? 0.9
      : p.kind === 'broker' ? 0.95
      : 0.92; // TradFi complex books
    const fillProb = clamp(fillBase * (ticketFit ? 1 : 0.9) * (fit.support === 'native' ? 1 : 0.92) * 100, 0, 99) / 100;
    const dealerSecs = prof.execModel.includes('RFQ') ? 3 + tickets * 2 : 0;
    const chainSecs = prof.execModel.includes('on-chain') ? 12 : 0;
    const estTimeToFillSec = prof.ackMs / 1000 + dealerSecs + chainSecs + (tickets - 1) * 0.4;

    const performance: RoutingDimension = {
      score: routable
        ? clamp(0.55 * latencyScore(prof.ackMs) + 0.45 * fillProb * 100)
        : 0,
      headline: routable
        ? `${prof.ackMs < 1000 ? prof.ackMs + 'ms' : (prof.ackMs / 1000).toFixed(0) + 's'} ack · ${(fillProb * 100).toFixed(0)}% fill prob · fill ≈ ${estTimeToFillSec < 1 ? '<1s' : estTimeToFillSec.toFixed(0) + 's'}`
        : '—',
      detail: [
        `execution model: ${prof.execModel}`,
        ticketFit
          ? `whole ${legCount}-leg structure fits one ${p.maxLegsPerTicket}-leg ticket`
          : `needs ${tickets} tickets (${legCount} legs > ${p.maxLegsPerTicket}/ticket)`,
        `throughput: ${p.kind === 'broker' ? 'broker-paced' : prof.ackMs < 100 ? 'institutional' : 'retail-adequate'}`,
      ],
    };

    // ── price & profit optimization ──────────────────────────────────────
    const makerSaving =
      ((p.fee.takerBpsPremium - p.fee.makerBpsPremium) / 10_000) * prem * 2 * makerLegFrac;
    const priceImprovement = ((prof.spreadBps / 2) / 10_000) * prem * 2 * makerLegFrac;
    const grossCost = totalUsd;
    const edgeRetention = routable
      ? clamp(100 - (grossCost / prem) * 100 - (1 - makerLegFrac) * (prof.spreadBps / 100) * 1.2, 5, 99)
      : 0;

    const priceProfit: RoutingDimension = {
      score: routable
        ? clamp(
            0.5 * clamp((makerSaving / prem) * 100 * 18) +
            0.3 * clamp((priceImprovement / prem) * 100 * 14) +
            0.2 * clamp(edgeRetention),
          )
        : 0,
      headline: routable
        ? `${Math.round(makerLegFrac * 100)}% passive → save $${makerSaving.toFixed(1)} + $${priceImprovement.toFixed(1)} price improvement`
        : '—',
      detail: [
        `maker plan: ${makerLegFrac > 0.5 ? 'post the combo at mid and wait' : makerLegFrac > 0.25 ? 'passive on wings, cross the core' : 'cross the spread — speed over price'}`,
        `fee spread taker vs maker: ${p.fee.takerBpsPremium - p.fee.makerBpsPremium}bps × ${Math.round(makerLegFrac * 100)}% of flow`,
        `edge retention: ${edgeRetention.toFixed(0)}% of theoretical P&L survives execution`,
      ],
    };

    // ── safety & security ────────────────────────────────────────────────
    const safetyScore = clamp(
      6.2 * prof.custodyTier + 6.2 * prof.clearingTier + 2.6 * prof.riskChecks.length,
    );

    const safety: RoutingDimension = {
      score: routable ? safetyScore : 0,
      headline: routable ? `${prof.custody.split('—')[0].trim()} · ${prof.clearing.split('—')[0].trim()}` : '—',
      detail: [
        `custody: ${prof.custody} (tier ${prof.custodyTier}/5)`,
        `clearing: ${prof.clearing} (tier ${prof.clearingTier}/5)`,
        `pre-trade checks: ${prof.riskChecks.slice(0, 3).join(' · ')}${prof.riskChecks.length > 3 ? ' …' : ''}`,
        `kill-switch: ${prof.killSwitch} · failover: ${prof.failover}`,
      ],
    };

    const composite = routable
      ? clamp(
          weights.efficiency * efficiency.score +
          weights.performance * performance.score +
          weights.priceProfit * priceProfit.score +
          weights.safety * safety.score,
        )
      : 0;

    // ── the order creation plan ──────────────────────────────────────────
    const creation: CreationStep[] = routable
      ? [
          {
            phase: 'Pre-trade',
            title: 'Risk budget & margin check',
            detail: `Validate the ticket against ${p.margin} margin: net delta/gamma/vega limits, worst-case loss of the ${legCount}-leg package, fat-finger bounds at theo ±${Math.max(10, Math.round(prof.spreadBps * 3 / 10))}% and max notional caps. ${prof.riskChecks[0] ?? 'risk engine'} gates the order.`,
          },
          {
            phase: 'Ticket',
            title: tickets === 1
              ? `One ${legCount}-leg ${fit.support === 'native' ? 'combo' : 'synthetic'} ticket`
              : `Split into ${tickets} combo tickets (${legCount} legs > ${p.maxLegsPerTicket}/ticket)`,
            detail: tickets === 1
              ? `${spec.legs.map((l) => `${l.side === 'buy' ? '+' : '−'}${l.qty}${l.kind === 'perp_option' ? ' everlasting' : ' '}${l.kind}`).join(' ')} as ONE atomic package${p.maxLegsPerTicket >= 8 ? ' via the RFQ basket' : ' on the complex-order book'} — no legging risk.`
              : `Group adjacent strikes into ${tickets} vertical/complex tickets and send them IOC-linked so partial package fills cancel back; balance margin across both.`,
          },
          {
            phase: 'Pricing',
            title: `Limit = theo ${premiumUsd >= 0 ? '−' : '+'} ${Math.round(prof.spreadBps / 2)}bps`,
            detail: `Start passive at mid${makerLegFrac > 0.4 ? ` — ${Math.round(makerLegFrac * 100)}% of this route can fill maker at ${p.fee.makerBpsPremium}bps vs ${p.fee.takerBpsPremium}bps taker (saves $${makerSaving.toFixed(1)}/round-trip)` : ' but this venue favors speed — cross after 2 quote updates'}. Walk the limit toward theo ±${Math.round(prof.spreadBps)}bps max; never market orders.`,
          },
          {
            phase: 'Execution',
            title: `${prof.execModel}${fit.support === 'synthetic' ? ' (synthetic legs)' : ''}`,
            detail: `${estTimeToFillSec < 1 ? 'Immediate' : estTimeToFillSec.toFixed(0) + 's'} expected fill at ${prof.ackMs < 1000 ? prof.ackMs + 'ms' : (prof.ackMs / 1000).toFixed(0) + 's'} ack. ${fit.support === 'synthetic' ? 'Leg-in the roll/hedge component first, then the core package — keep package delta-neutral while building. ' : ''}TIF: DAY with re-quote every ${prof.ackMs < 100 ? '250ms' : '5s'}; on partial fill > 50% hedge immediately.`,
          },
          {
            phase: 'Post-trade',
            title: 'Guard the position',
            detail: `Confirm fills vs theo (reject > ${Math.round(prof.spreadBps)}bps worse), arm ${prof.killSwitch}, monitor ${fit.support === 'synthetic' ? 'roll schedule + ' : ''}margin ratio and greeks vs limits; drawdown halt at 1.5× average cycle loss. Failover: ${prof.failover}.`,
          },
        ]
      : [];

    return {
      platform: p,
      support: fit.support,
      routable,
      efficiency,
      performance,
      priceProfit,
      safety,
      composite: +composite.toFixed(1),
      rank: 0,
      cost,
      ackMs: prof.ackMs,
      fillProb: +fillProb.toFixed(2),
      estTimeToFillSec: +estTimeToFillSec.toFixed(3),
      makerCapturePct: Math.round(makerLegFrac * 100),
      makerSavingUsd: +makerSaving.toFixed(2),
      priceImprovementUsd: +priceImprovement.toFixed(2),
      edgeRetentionPct: +edgeRetention.toFixed(0),
      execModel: prof.execModel,
      profile: prof,
      creation,
    };
  });

  // rank routable venues by composite (desc), non-routables keep 0.
  const ranked = [...out].sort((a, b) => b.composite - a.composite);
  ranked.forEach((f, i) => (f.rank = f.routable ? i + 1 : 0));
  return out;
}

export interface RouteRecommendation {
  best: RoutingFit | null;
  runnerUp: RoutingFit | null;
  cheapest: RoutingFit | null;
  fastest: RoutingFit | null;
  safest: RoutingFit | null;
}

export function routeRecommendation(fits: RoutingFit[]): RouteRecommendation {
  const routable = fits.filter((f) => f.routable);
  if (routable.length === 0) {
    return { best: null, runnerUp: null, cheapest: null, fastest: null, safest: null };
  }
  const byComposite = [...routable].sort((a, b) => b.composite - a.composite);
  const byCost = [...routable].sort((a, b) => a.cost.totalUsd - b.cost.totalUsd);
  const bySpeed = [...routable].sort((a, b) => a.estTimeToFillSec - b.estTimeToFillSec);
  const bySafety = [...routable].sort((a, b) => b.safety.score - a.safety.score);
  return {
    best: byComposite[0],
    runnerUp: byComposite[1] ?? null,
    cheapest: byCost[0],
    fastest: bySpeed[0],
    safest: bySafety[0],
  };
}

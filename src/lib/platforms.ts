// Platform & venue registry — where each of the 131 strategies can actually run.
//
// Two eras of venues, one compatibility engine:
//   • modern  — perpetual-native / on-chain venues (Derive, Paradex, Aevo,
//               Hyperliquid, Lighter, Panoptic) that list everlasting options
//               and can assemble deep multileg baskets in a single RFQ ticket.
//   • legacy  — dated-options venues: crypto CEXs (Deribit, OKX, Bybit,
//               Binance, CME crypto) and the TradFi options exchanges
//               (CBOE, CME equity, Nasdaq/PHLX, MIAX) + brokers (IBKR).
//
// `platformsForStrategy(spec, premiumUsd)` decides, per platform, whether the
// strategy trades NATIVE (one ticket, as listed), SYNTHETIC (replicable with
// rolls / split tickets / futures hedge), PARTIAL (some legs impossible) or
// is UNAVAILABLE — together with the adaptation recipe and an estimated
// round-trip taker fee.

import type { LegKind, UnderlyingId } from './types';
import type { StrategySpec } from './strategies';

export type PlatformEra = 'modern' | 'legacy';
export type PlatformKind =
  | 'perp-native DEX'
  | 'on-chain options AMM'
  | 'crypto CEX'
  | 'TradFi exchange'
  | 'broker';

export interface FeeModel {
  /** Taker fee in bps of premium notional (per side). */
  takerBpsPremium: number;
  /** Maker fee in bps of premium notional (per side). */
  makerBpsPremium: number;
  /** Flat fee per option/futures contract (per side), USD. */
  perContractUsd?: number;
  /** Settlement / exercise fee in bps of notional. */
  settlementBps?: number;
}

export interface Platform {
  id: string;
  name: string;
  short: string;
  era: PlatformEra;
  kind: PlatformKind;
  /** One-line identity shown on the card. */
  tagline: string;
  /** Underlyings from our catalog (BTC/ETH/SOL) the venue lists directly. */
  assets: UnderlyingId[];
  /** TradFi venues trade their own underlyings — the ARCHETYPE maps across. */
  tradfiUnderlyings?: string;
  /** Leg kinds the venue can hold natively. */
  legKinds: LegKind[];
  /** Daily expiries (0DTE) listed? */
  dailyExpiries: boolean;
  /** Shortest dated tenor listed, in days. */
  minTenorDays: number;
  /** Max legs executable in a single ticket / RFQ. */
  maxLegsPerTicket: number;
  margin: 'portfolio (SPAN-style)' | 'classic futures' | 'premium-paid' | 'fully collateralized' | 'cross-margin portfolio';
  latency: 'low' | 'medium' | 'high';
  fee: FeeModel;
  notes: string;
}

export const PLATFORMS: Platform[] = [
  // ── modern · perpetual-native / on-chain ─────────────────────────────────
  {
    id: 'derive',
    name: 'Derive (formerly Lyra)',
    short: 'Derive',
    era: 'modern',
    kind: 'perp-native DEX',
    tagline: 'L2 options DEX with everlasting-style funding + RFQ baskets',
    assets: ['BTC', 'ETH'],
    legKinds: ['call', 'put', 'perp_option', 'perp'],
    dailyExpiries: true,
    minTenorDays: 1,
    maxLegsPerTicket: 25,
    margin: 'cross-margin portfolio',
    latency: 'low',
    fee: { takerBpsPremium: 30, makerBpsPremium: 10, settlementBps: 2 },
    notes: 'The only venue where the full 8–25 leg monsters assemble in one RFQ ticket — the dealer quotes the whole basket.',
  },
  {
    id: 'paradex',
    name: 'Paradex',
    short: 'Paradex',
    era: 'modern',
    kind: 'perp-native DEX',
    tagline: 'App-chain with native perpetual options + perps, portfolio margin',
    assets: ['BTC', 'ETH', 'SOL'],
    legKinds: ['call', 'put', 'perp_option', 'perp'],
    dailyExpiries: true,
    minTenorDays: 1,
    maxLegsPerTicket: 4,
    margin: 'cross-margin portfolio',
    latency: 'low',
    fee: { takerBpsPremium: 35, makerBpsPremium: 12 },
    notes: 'Everlasting options are first-class instruments; deeper baskets need the multi-leg RFQ to be split across tickets.',
  },
  {
    id: 'aevo',
    name: 'Aevo',
    short: 'Aevo',
    era: 'modern',
    kind: 'perp-native DEX',
    tagline: 'High-frequency options DEX with daily expiries',
    assets: ['BTC', 'ETH'],
    legKinds: ['call', 'put', 'perp'],
    dailyExpiries: true,
    minTenorDays: 1,
    maxLegsPerTicket: 4,
    margin: 'portfolio (SPAN-style)',
    latency: 'low',
    fee: { takerBpsPremium: 25, makerBpsPremium: 8 },
    notes: 'Dated-only chain — everlasting legs must be emulated with daily rolls.',
  },
  {
    id: 'hyperliquid',
    name: 'Hyperliquid',
    short: 'Hyperliquid',
    era: 'modern',
    kind: 'perp-native DEX',
    tagline: 'L1 perps order book — deep books, maker rebates',
    assets: ['BTC', 'ETH', 'SOL'],
    legKinds: ['perp', 'spot'],
    dailyExpiries: false,
    minTenorDays: 30,
    maxLegsPerTicket: 1,
    margin: 'classic futures',
    latency: 'low',
    fee: { takerBpsPremium: 12, makerBpsPremium: 0 },
    notes: 'Futures/spot engine (HIP-3 builder-deployed books). Options-heavy strategies land only their hedge legs here.',
  },
  {
    id: 'lighter',
    name: 'Lighter',
    short: 'Lighter',
    era: 'modern',
    kind: 'perp-native DEX',
    tagline: 'zk-rollup with native perpetual options — gas-free, maker-first',
    assets: ['BTC', 'ETH', 'SOL'],
    legKinds: ['perp_option', 'perp', 'spot'],
    dailyExpiries: false,
    minTenorDays: 30,
    maxLegsPerTicket: 4,
    margin: 'cross-margin portfolio',
    latency: 'low',
    fee: { takerBpsPremium: 8, makerBpsPremium: 0 },
    notes: 'Perpetual options are listed instruments (premium paid as funding, no expiry) — everlasting legs are NATIVE here; dated legs approximate as the perpetual twin.',
  },
  {
    id: 'panoptic',
    name: 'Panoptic',
    short: 'Panoptic',
    era: 'modern',
    kind: 'on-chain options AMM',
    tagline: 'UniV3-LP-range options — streams fees instead of paying premium',
    assets: ['BTC', 'ETH'],
    legKinds: ['call', 'put'],
    dailyExpiries: false,
    minTenorDays: 1,
    maxLegsPerTicket: 1,
    margin: 'fully collateralized',
    latency: 'high',
    fee: { takerBpsPremium: 45, makerBpsPremium: 0 },
    notes: 'Options are collateralized LP positions; every leg must be opened as its own range — no combo tickets.',
  },

  // ── legacy · crypto dated-options venues ─────────────────────────────────
  {
    id: 'deribit',
    name: 'Deribit',
    short: 'Deribit',
    era: 'legacy',
    kind: 'crypto CEX',
    tagline: 'The deep dated-options book — dailies out to 365d + USDC perps',
    assets: ['BTC', 'ETH', 'SOL'],
    legKinds: ['call', 'put', 'perp'],
    dailyExpiries: true,
    minTenorDays: 1,
    maxLegsPerTicket: 4,
    margin: 'portfolio (SPAN-style)',
    latency: 'low',
    fee: { takerBpsPremium: 30, makerBpsPremium: 3, settlementBps: 10 },
    notes: 'Gold standard for dated crypto options; combos beyond 4 legs split into multiple spread tickets.',
  },
  {
    id: 'okx',
    name: 'OKX',
    short: 'OKX',
    era: 'legacy',
    kind: 'crypto CEX',
    tagline: 'Dated BTC/ETH options + perps + spot under one portfolio margin',
    assets: ['BTC', 'ETH'],
    legKinds: ['call', 'put', 'perp', 'spot'],
    dailyExpiries: true,
    minTenorDays: 1,
    maxLegsPerTicket: 4,
    margin: 'cross-margin portfolio',
    latency: 'low',
    fee: { takerBpsPremium: 20, makerBpsPremium: 4 },
    notes: 'Covers spot legs natively, which most option venues force you to off-book.',
  },
  {
    id: 'bybit',
    name: 'Bybit',
    short: 'Bybit',
    era: 'legacy',
    kind: 'crypto CEX',
    tagline: 'Dated BTC/ETH options + inverse perps',
    assets: ['BTC', 'ETH'],
    legKinds: ['call', 'put', 'perp', 'spot'],
    dailyExpiries: true,
    minTenorDays: 1,
    maxLegsPerTicket: 4,
    margin: 'portfolio (SPAN-style)',
    latency: 'low',
    fee: { takerBpsPremium: 22, makerBpsPremium: 3 },
    notes: 'Weekly/daily options with an active 0DTE book on BTC and ETH.',
  },
  {
    id: 'binance',
    name: 'Binance',
    short: 'Binance',
    era: 'legacy',
    kind: 'crypto CEX',
    tagline: 'Deepest perps + spot book — no listed options',
    assets: ['BTC', 'ETH', 'SOL'],
    legKinds: ['perp', 'spot'],
    dailyExpiries: false,
    minTenorDays: 30,
    maxLegsPerTicket: 1,
    margin: 'classic futures',
    latency: 'low',
    fee: { takerBpsPremium: 10, makerBpsPremium: 2 },
    notes: 'Futures and spot legs route here at the best fees; any strategy whose core is option legs cannot be expressed.',
  },
  {
    id: 'cme-crypto',
    name: 'CME (crypto futures options)',
    short: 'CME crypto',
    era: 'legacy',
    kind: 'TradFi exchange',
    tagline: 'Cash-settled BTC/ETH futures options — weekly to quarterly serials',
    assets: ['BTC', 'ETH'],
    legKinds: ['call', 'put', 'perp'],
    dailyExpiries: false,
    minTenorDays: 7,
    maxLegsPerTicket: 4,
    margin: 'classic futures',
    latency: 'medium',
    fee: { takerBpsPremium: 40, makerBpsPremium: 12, perContractUsd: 12.5 },
    notes: 'The regulated door for institutions — no dailies, so 0DTE gamma plays map only to the nearest weekly.',
  },

  // ── legacy · TradFi options exchanges (archetype maps across) ────────────
  {
    id: 'cboe',
    name: 'CBOE (SPX · VIX · 0DTE)',
    short: 'CBOE',
    era: 'legacy',
    kind: 'TradFi exchange',
    tagline: 'Index options home — Mon–Fri 0DTE dailies on SPX',
    assets: [],
    tradfiUnderlyings: 'SPX · SPY · VIX · XSP',
    legKinds: ['call', 'put'],
    dailyExpiries: true,
    minTenorDays: 1,
    maxLegsPerTicket: 4,
    margin: 'portfolio (SPAN-style)',
    latency: 'medium',
    fee: { takerBpsPremium: 12, makerBpsPremium: 4, perContractUsd: 0.65 },
    notes: 'The 0DTE category of this catalog is literally the CBOE SPX playbook — same structures, index underlyings.',
  },
  {
    id: 'cme-equity',
    name: 'CME Group (ES · NQ · BTC futures options)',
    short: 'CME equity',
    era: 'legacy',
    kind: 'TradFi exchange',
    tagline: 'Futures options on equity indexes — the original spread market',
    assets: [],
    tradfiUnderlyings: 'ES · NQ · RTY · BTC/ETH futures',
    legKinds: ['call', 'put', 'perp'],
    dailyExpiries: false,
    minTenorDays: 7,
    maxLegsPerTicket: 4,
    margin: 'classic futures',
    latency: 'medium',
    fee: { takerBpsPremium: 15, makerBpsPremium: 5, perContractUsd: 1.25 },
    notes: 'Calendar and futures-hedged structures are native here; every crypto strategy archetype has an ES/NQ twin.',
  },
  {
    id: 'nasdaq',
    name: 'Nasdaq / PHLX',
    short: 'Nasdaq',
    era: 'legacy',
    kind: 'TradFi exchange',
    tagline: 'Equity options — weeklies and monthlies across 5k+ names',
    assets: [],
    tradfiUnderlyings: 'single-name equities · QQQ',
    legKinds: ['call', 'put', 'spot'],
    dailyExpiries: false,
    minTenorDays: 7,
    maxLegsPerTicket: 4,
    margin: 'premium-paid',
    latency: 'medium',
    fee: { takerBpsPremium: 18, makerBpsPremium: 6, perContractUsd: 0.65 },
    notes: 'Single-stock twins of this catalog (covered calls, collars, PMCCs…) with physical-share hedges.',
  },
  {
    id: 'miax',
    name: 'MIAX',
    short: 'MIAX',
    era: 'legacy',
    kind: 'TradFi exchange',
    tagline: 'Options exchange — complex spread book with maker incentives',
    assets: [],
    tradfiUnderlyings: 'single-name equities · ETFs',
    legKinds: ['call', 'put'],
    dailyExpiries: false,
    minTenorDays: 7,
    maxLegsPerTicket: 4,
    margin: 'premium-paid',
    latency: 'medium',
    fee: { takerBpsPremium: 14, makerBpsPremium: 2, perContractUsd: 0.55 },
    notes: 'Known for competitive complex-order matching — the income/credit archetypes route well here.',
  },
  {
    id: 'ibkr',
    name: 'Interactive Brokers (broker)',
    short: 'IBKR',
    era: 'legacy',
    kind: 'broker',
    tagline: 'One account, every legacy book — combos up to 16 legs',
    assets: ['BTC', 'ETH'],
    tradfiUnderlyings: 'global equities · futures · options',
    legKinds: ['call', 'put', 'perp', 'spot'],
    dailyExpiries: true,
    minTenorDays: 1,
    maxLegsPerTicket: 16,
    margin: 'portfolio (SPAN-style)',
    latency: 'medium',
    fee: { takerBpsPremium: 8, makerBpsPremium: 2, perContractUsd: 0.65 },
    notes: 'Not a venue but the router: basket the whole strategy as a single combo and let SMART routing find each fill.',
  },
];

export const ERA_META: Record<PlatformEra, { label: string; hint: string; color: string; chip: string }> = {
  modern: {
    label: 'Modern · perpetual-native',
    hint: 'On-chain venues listing everlasting options & deep multileg RFQs',
    color: 'text-teal-300',
    chip: 'border-teal-500/40 bg-teal-950/30 text-teal-300',
  },
  legacy: {
    label: 'Legacy · dated options',
    hint: 'CEX and TradFi books — expiries, serials and 0DTE dailies',
    color: 'text-amber-300',
    chip: 'border-amber-500/40 bg-amber-950/30 text-amber-300',
  },
};

export type Support = 'native' | 'synthetic' | 'partial' | 'unavailable';

export const SUPPORT_META: Record<Support, { label: string; color: string; chip: string; blurb: string }> = {
  native: {
    label: 'Native',
    color: 'text-emerald-400',
    chip: 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300',
    blurb: 'every leg trades as listed, in one ticket',
  },
  synthetic: {
    label: 'Synthetic',
    color: 'text-sky-400',
    chip: 'border-sky-500/40 bg-sky-950/30 text-sky-300',
    blurb: 'replicable — rolls, split tickets or a futures hedge',
  },
  partial: {
    label: 'Partial',
    color: 'text-amber-400',
    chip: 'border-amber-500/40 bg-amber-950/30 text-amber-300',
    blurb: 'some legs impossible — the structure changes materially',
  },
  unavailable: {
    label: 'Not listed',
    color: 'text-rose-400',
    chip: 'border-rose-500/40 bg-rose-950/30 text-rose-300',
    blurb: 'core legs have no instrument on this venue',
  },
};

export interface PlatformFit {
  platform: Platform;
  support: Support;
  /** Machine reasons for the verdict. */
  reasons: string[];
  /** How to actually run the strategy on that venue. */
  adaptation: string;
  /** Estimated round-trip taker fee in USD at the given premium (null if n/a). */
  estFeeUsd: number | null;
  /** Leg kinds the venue cannot list. */
  missingLegs: LegKind[];
}

// ── capability resolution ───────────────────────────────────────────────────

type LegCapability = 'native' | 'roll' | 'futures-hedge' | 'none';

function legCapability(platform: Platform, kind: LegKind): LegCapability {
  if (platform.legKinds.includes(kind)) return 'native';

  const hasDatedOptions =
    platform.legKinds.includes('call') || platform.legKinds.includes('put');
  const hasFutures = platform.legKinds.includes('perp');

  switch (kind) {
    case 'perp_option':
      // Everlasting option ≈ a strip of dated options refreshed every funding period.
      if (hasDatedOptions && platform.dailyExpiries) return 'roll';
      if (hasDatedOptions) return 'roll';
      return 'none';
    case 'perp':
      if (hasDatedOptions) return 'none'; // no futures book to hedge on
      return 'none';
    case 'spot':
      if (hasFutures) return 'futures-hedge';
      return 'none';
    case 'call':
    case 'put':
      // A dated option can be carried as the venue's perpetual twin when
      // perpetual options are listed (e.g. Lighter) — same payoff family,
      // premium paid as funding instead of upfront.
      if (platform.legKinds.includes('perp_option')) return 'roll';
      return 'none';
  }
}

function canAsset(platform: Platform, underlying: UnderlyingId): boolean {
  if (platform.assets.includes(underlying)) return true;
  // TradFi venues + brokers trade the archetype on their own underlyings.
  return platform.tradfiUnderlyings !== undefined;
}

/** Estimated round-trip taker fee for a strategy ticket. */
export function estimateFee(
  platform: Platform,
  premiumUsd: number,
  legCount: number,
): number {
  const sides = 2; // entry + exit
  const notionalPerSide = Math.max(Math.abs(premiumUsd), 25);
  const bpsFee = (platform.fee.takerBpsPremium / 10_000) * notionalPerSide * sides;
  const contractFee = (platform.fee.perContractUsd ?? 0) * Math.max(legCount, 1) * sides;
  const settle = ((platform.fee.settlementBps ?? 0) / 10_000) * Math.max(Math.abs(premiumUsd), 25);
  return bpsFee + contractFee + settle;
}

const SUPPORT_ORDER: Support[] = ['native', 'synthetic', 'partial', 'unavailable'];
const SUPPORT_RANK: Record<Support, number> = { native: 0, synthetic: 1, partial: 2, unavailable: 3 };

/**
 * Resolve EVERY platform verdict for one strategy.
 * Pure function of the spec (+ premium for the fee line) — memoizable.
 */
export function platformsForStrategy(
  spec: StrategySpec,
  underlying: UnderlyingId,
  premiumUsd: number,
): PlatformFit[] {
  const legCount = spec.legs.length;
  const kinds = new Set<LegKind>(spec.legs.map((l) => l.kind));
  const shortestTenor = Math.min(
    ...spec.legs.map((l) => (l.expiryDays !== undefined ? l.expiryDays : Infinity)),
  );
  const needsDailies = spec.legs.some((l) => (l.expiryDays ?? 1) <= 1 && (l.kind === 'call' || l.kind === 'put'));

  return PLATFORMS.map((platform): PlatformFit => {
    const reasons: string[] = [];
    const missingLegs: LegKind[] = [];
    // Rank-based so TS flow analysis doesn't over-narrow (closures below).
    let worstRank = 0;
    const downgrade = (s: Support) => {
      if (SUPPORT_RANK[s] > worstRank) worstRank = SUPPORT_RANK[s];
    };

    const onAsset = canAsset(platform, underlying);
    if (!onAsset && platform.tradfiUnderlyings === undefined) {
      return {
        platform,
        support: 'unavailable',
        reasons: [`${underlying} is not listed on this venue.`],
        adaptation: '—',
        estFeeUsd: null,
        missingLegs: [...kinds],
      };
    }

    // Per-leg-kind capability.
    for (const kind of kinds) {
      const cap = legCapability(platform, kind);
      if (cap === 'native') continue;
      if (cap === 'roll') {
        downgrade('synthetic');
        reasons.push(
          kind === 'perp_option'
            ? 'everlasting legs → dated roll ladder refreshed each funding period'
            : 'dated legs → perpetual twin (premium as funding, no roll needed)',
        );
      } else if (cap === 'futures-hedge') {
        downgrade('synthetic');
        reasons.push('spot legs → micro-futures proxy');
      } else {
        missingLegs.push(kind);
        downgrade(kind === 'perp' || kind === 'perp_option' ? 'partial' : 'unavailable');
        reasons.push(`${kind} legs have no instrument here`);
      }
    }

    // Ticket width.
    if (legCount > platform.maxLegsPerTicket && worstRank === SUPPORT_RANK.native) {
      downgrade('synthetic');
      reasons.push(`${legCount} legs > ${platform.maxLegsPerTicket}-leg tickets → split into ${Math.ceil(legCount / platform.maxLegsPerTicket)} tickets`);
    } else if (legCount > platform.maxLegsPerTicket && worstRank === SUPPORT_RANK.synthetic) {
      reasons.push(`${legCount} legs also exceed the ${platform.maxLegsPerTicket}-leg ticket → ladder the combos`);
    }

    // Tenor / 0DTE constraints (dated legs only).
    if (Number.isFinite(shortestTenor) && shortestTenor < platform.minTenorDays) {
      if (needsDailies && !platform.dailyExpiries) {
        downgrade('synthetic');
        reasons.push(`0DTE legs → nearest weekly (${platform.minTenorDays}d) approximation`);
      } else {
        reasons.push(`shortest tenor ${shortestTenor}d < listed minimum ${platform.minTenorDays}d → nearest serial`);
      }
    }

    const worst: Support = SUPPORT_ORDER[worstRank];

    // TradFi mapping note.
    if (platform.tradfiUnderlyings) {
      if (worst === 'native' || worst === 'synthetic') {
        reasons.push(`archetype trades as-is on ${platform.tradfiUnderlyings}`);
      }
    }

    // Adaptation recipes.
    let adaptation: string;
    switch (worst) {
      case 'native':
        adaptation = platform.era === 'modern' && platform.maxLegsPerTicket >= legCount
          ? `Load all ${legCount} legs into one ${platform.short} RFQ ticket and work it as a basket.`
          : `Send the ${legCount}-leg structure as${legCount > platform.maxLegsPerTicket ? ' (split) ' : ' '}a combo ticket at mid, leg-in the hedge if the book is thin.`;
        break;
      case 'synthetic': {
        const bits: string[] = [];
        if (kinds.has('perp_option')) bits.push('replace everlasting legs with a dated roll refreshed every funding period');
        if (legCount > platform.maxLegsPerTicket) bits.push(`split into ${Math.ceil(legCount / platform.maxLegsPerTicket)} combo tickets and balance margin across them`);
        if (needsDailies && !platform.dailyExpiries) bits.push('0DTE legs become the nearest weekly');
        adaptation = bits.length
          ? `Replicate: ${bits.join('; ')}.`
          : 'Replicate with the venue’s nearest tenors and a disciplined roll schedule.';
        break;
      }
      case 'partial':
        adaptation = `Drop or proxy the ${missingLegs.join(' + ')} legs — the payoff changes materially; re-price before trading.`;
        break;
      default:
        adaptation = 'No viable replication — route to a modern options venue instead.';
    }

    const estFeeUsd = worst === 'unavailable' || (worst === 'partial' && missingLegs.length >= Math.max(1, Math.ceil(legCount / 2)))
      ? null
      : estimateFee(platform, premiumUsd, legCount);

    return { platform, support: worst, reasons, adaptation, estFeeUsd, missingLegs };
  });
}

/** Counts used by the rail chips & header — cheap enough to memo per (spec, underlying). */
export function platformSummary(fits: PlatformFit[]): { native: number; synthetic: number; partial: number; unavailable: number; total: number } {
  const s = { native: 0, synthetic: 0, partial: 0, unavailable: 0, total: fits.length };
  for (const f of fits) s[f.support] += 1;
  return s;
}

export function platformById(id: string): Platform | undefined {
  return PLATFORMS.find((p) => p.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// VolOS INTELLIGENCE — v1.9 strategy knowledge layer. Generates the
// Intelligence tab content (mechanics, advantages, disadvantages, tags) for
// every strategy in the 131 catalog from its structure + category.
// ─────────────────────────────────────────────────────────────────────────────

import type { Leg } from './types';
import type { StrategySpec } from './strategies';

export interface Intelligence {
  whatIs: string;
  whenToUse: string;
  mechanics: string[];   // paragraphs
  advantages: string[];
  disadvantages: string[];
  tags: string[];
}

const sideWord = (l: Leg) => (l.side === 'long' ? 'buy' : 'sell');
const kRound = (v: number) => Math.round(v * 100) / 100;

function describeLegs(legs: Leg[]): string {
  const parts = legs.map((l) => {
    const off = l.strikeOffsetPct;
    const offStr = off === undefined ? '' : off === 0 ? 'ATM' : `${off > 0 ? '+' : ''}${off}%`;
    if (l.kind === 'perp') return `${sideWord(l)} ${l.ratio > 1 ? l.ratio + '× ' : ''}perp`;
    if (l.kind === 'spot') return `${sideWord(l)} spot`;
    if (l.kind === 'perp_option')
      return `${sideWord(l)} ${l.ratio > 1 ? l.ratio + '× ' : ''}everlasting ${(off ?? 0) >= 0 ? 'call' : 'put'} ${off === 0 ? 'ATM' : offStr}`;
    return `${sideWord(l)} ${l.ratio > 1 ? l.ratio + '× ' : ''}${l.dte}d ${l.kind} ${offStr}`;
  });
  return parts.join(' · ');
}

function strikeSpread(legs: Leg[]): string {
  const offs = legs.map((l) => l.strikeOffsetPct ?? 0);
  const lo = Math.min(...offs), hi = Math.max(...offs);
  if (hi - lo < 0.01) return 'single-strike';
  return `${kRound(hi - lo)}% wide`;
}

const CATEGORY_MECHANICS: Record<string, (s: StrategySpec) => string[]> = {
  direction: (s) => [
    `Structure: ${describeLegs(s.legs)}. The position is a ${strikeSpread(s.legs)} directional expression resolved parametrically against live spot — every strike above is a multiplier of the current price, so the same catalog entry resolves to tradeable levels on BTC, ETH or SOL.`,
    `Delta is the engine here: the structure carries net ${s.legs.some((l) => l.side === 'long') ? 'long' : 'short'} premium convexity that accelerates or decays as spot moves toward and through the strikes. Gamma is largest near the money, so the position's character changes hour by hour as expiry approaches.`,
    `Manage it against the breakevens, not against your entry P&L. The edge in outright direction is entry timing — IV is typically richest overnight and through events, and bleeds through the session unless the move arrives.`,
  ],
  income: (s) => [
    `Structure: ${describeLegs(s.legs)} — a net-premium harvest structure. The catalog resolves each strike as a live multiplier of spot, ${strikeSpread(s.legs)}.`,
    `The trade sells time value and collects decay on every short leg. Theta works for you every session the market stays inside the short strikes; the risk is gap movement through a short strike, where the position flips to directional loss faster than the remaining credit can offset.`,
    `Management discipline IS the edge: take profit at 50% of max credit, cut at 2× credit or a technical break, and roll the challenged side when the market trends. Never hold a challenged income trade to expiry hoping for the last few points of theta.`,
  ],
  volatility: (s) => [
    `Structure: ${describeLegs(s.legs)} — a vol expression. Strikes are live multipliers of spot, ${strikeSpread(s.legs)}.`,
    `The trade is priced off the full smile, not just ATM: wings carry rich IV, the body carries cheap IV, and the structure isolates the difference. Long-vol structures profit when realized movement exceeds the premium priced in; short-vol structures collect the variance risk premium when markets stay tame.`,
    `Watch the term structure roll: a structure pinned to one expiry loses its vol exposure at settlement, while everlasting legs renew it every funding period instead of decaying to zero.`,
  ],
  protection: (s) => [
    `Structure: ${describeLegs(s.legs)} — a hedge. Strikes resolve as live multipliers of spot, ${strikeSpread(s.legs)}.`,
    `The structure buys downside (or tail) convexity while minimizing carry. It is priced against the put skew — crash premium — so the same hedge is cheapest when realized vol is low and skew is flat, and painfully expensive exactly when everyone wants it.`,
    `Treat the hedge as insurance with a renewal date: roll before the expiry cliff eats the gamma, and consider financing it with a far-wing short when carry matters more than the tail.`,
  ],
  spread: (s) => [
    `Structure: ${describeLegs(s.legs)} — a vertical/package spread, ${strikeSpread(s.legs)}. Strikes are live multipliers of spot.`,
    `The spread isolates one slice of the distribution: it buys cheap IV and sells rich IV around a specific price zone. That strips most of the vega and leaves a bounded, defined-risk directional or range position.`,
    `Spreads are entry-price sensitive: the credit or debit you collect is the majority of the edge. Enter when the smile is steep (wings rich versus the body) and avoid paying up for spreads right before events that can flatten the smile against you.`,
  ],
  perpetual: (s) => [
    `Structure: ${describeLegs(s.legs)} — everlasting legs replace the expiry cliff with explicit funding. Strikes are live multipliers of spot.`,
    `Everlasting options amortise their time value through continuous funding instead of decaying into a single settlement date. Premium is pulled toward intrinsic by the funding carry, so the mark you see is a rolling blend of spot distance and paid-in carry.`,
    `Everlasting legs carry zero charm by construction — no expiry cliff, delta drifts only with spot and vol. The trade-off is a funding bill that accrues every period you hold, which caps the "hold forever" appeal when vol is rich.`,
  ],
  multileg: (s) => [
    `Structure: ${describeLegs(s.legs)} — a ${s.legs.length}-leg complex, ${strikeSpread(s.legs)}. Every strike resolves as a live multiplier of spot, so the package re-prices against BTC, ETH or SOL identically.`,
    `The structure composes several slices of the distribution at once: body, wings and tails each carry their own IV off the smile, and the package price is the net of cheap and rich slices. Execution is the story — complex packages route through complex-order books and RFQ networks, not single-leg books.`,
    `Multi-leg risk is path risk: the package's greeks net to something small at entry but decompose as spot travels between the strikes. Re-run the greeks matrix at each zone, not just at entry.`,
  ],
  '0dte': (s) => [
    `Structure: ${describeLegs(s.legs)} — same-day structure: sell the wings, buy protection one step further, all expiring within the session.`,
    `With hours — not weeks — of life, gamma explodes: a 1% move can double or kill the position, and theta completes its full decay within a single session. There is no rolling, no management cadence, no second chance: entry timing IS the strategy.`,
    `Morning IV is typically elevated (overnight uncertainty priced in) and decays through the session unless movement arrives. These are lottery-ticket geometries on both sides — size so that ODTE risk is binary by construction and survives being wrong.`,
  ],
};

const CATEGORY_PROS_CONS: Record<string, { pros: string[]; cons: string[] }> = {
  direction: {
    pros: ['Defined risk on entry — you know the worst case at the ticket', 'Convex payoff — gains accelerate as the move extends', 'No margin/liquidation engine on long-premium structures', 'Cheap leverage versus perps at the same notional', 'Positive gamma near the money — the delta works for you'],
    cons: ['Theta bleed on every long leg, every session', 'Needs the move to arrive before expiry', 'Vol crush after events reprices the whole structure', '100% premium loss is a common outcome', 'Long-dated value decays slowly even when right'],
  },
  income: {
    pros: ['Positive theta from net short premium', 'High probability of keeping some or all credit', 'Strikes placeable at technical boundaries', 'Margin-efficient versus naked shorts', 'Works in mean-reverting and post-event regimes'],
    cons: ['Reward is small relative to max loss (width minus credit)', 'Any trend through a short strike threatens full width', 'Negative gamma near short strikes into expiry', 'Multiple legs of spread cost to enter and exit', 'Whipsaw through a strike then reversal stops you at the worst point'],
  },
  volatility: {
    pros: ['Profits from movement without picking direction', 'Long gamma compounds through trend days', 'Defined-risk expression of the variance premium', 'Strikes resolve live so the structure adapts per asset', 'Everlasting variants renew exposure without rolls'],
    cons: ['Double-sided theta bleed on long-vol structures', 'Needs movement exceeding the priced premium', 'IV crush hits immediately after events', 'Short-vol variants carry gap risk on both tails', 'Skew can move against the structure even when vol is right'],
  },
  protection: {
    pros: ['Tail convexity at known, capped cost', 'Stops portfolio drawdowns at the strike', 'No liquidation engine on the hedge itself', 'Skew tailwind when markets sell off (put IV rises)', 'Can be financed by far-wing shorts when carry matters'],
    cons: ['Persistent carry cost when the tail never arrives', 'Puts are systematically overpriced (crash premium)', 'Hedge expires — must be rolled or it vanishes', 'Deep OTM wings gap in price during stress', 'Over-hedging bleeds a portfolio slowly'],
  },
  spread: {
    pros: ['Defined risk AND defined reward at entry', 'Strips most vega versus the outright', 'Cheaper directional exposure than single legs', 'Credit structures get paid to wait', 'Price-zone precision — profit where you expect it'],
    cons: ['Max profit is capped — winners get truncated', 'Entry credit/debit is most of the edge', 'Leg risk when quotes slip between entries', 'Assignment/pin behavior at the short strike', 'Spreads widen exactly when you need to exit'],
  },
  perpetual: {
    pros: ['No expiry cliff — no theta singularity', 'Zero charm by construction (delta drift is smooth)', 'Renews exposure every funding period automatically', 'One instrument instead of a roll cadence', 'Funding income on short legs is explicit'],
    cons: ['Funding bill accrues every period you hold', 'No gamma explosion event to harvest', 'Liquidity is thinner than dated chains', 'Funding-rate regime shifts reprice the carry', 'Mark is model-blended — wider quotes around events'],
  },
  multileg: {
    pros: ['Composes several distribution slices in one ticket', 'Net cost near zero when wings finance the body', 'Greeks net to a precise target exposure', 'Executes as one package on complex-order books', 'Re-prices live against every asset in the catalog'],
    cons: ['Leg risk across many quotes at entry', 'Greeks decompose as spot travels between strikes', 'Wider all-in spreads on package execution', 'Harder to unwind mid-life without crossing twice', 'Model risk — blended marks move on funding and skew'],
  },
  '0dte': {
    pros: ['Extreme gamma leverage — tiny premium controls the session', 'Full-day theta harvested in hours by sellers', 'Binary risk is fully defined at entry', 'No overnight gap exposure after settlement', 'Morning IV richness favors disciplined entries'],
    cons: ['Full premium decays within hours', 'Binary outcome with no recovery time', 'Gap moves bypass the short strikes entirely', 'Slippage dominates at expiry — wings gap', 'Size discipline is the only real risk control'],
  },
};

const CATEGORY_TAGS: Record<string, string[]> = {
  direction: ['debit', 'directional', 'convexity'],
  income: ['credit', 'income', 'theta'],
  volatility: ['volatility', 'gamma', 'smile'],
  protection: ['hedge', 'defined-risk', 'tail'],
  spread: ['spread', 'defined-risk', 'zone'],
  perpetual: ['everlasting', 'funding', 'no-expiry'],
  multileg: ['complex', 'package', 'multi-zone'],
  '0dte': ['odte', 'same-day', 'binary'],
};

export function intelligenceFor(s: StrategySpec): Intelligence {
  const mech = CATEGORY_MECHANICS[s.category]?.(s) ?? CATEGORY_MECHANICS.direction(s);
  const pc = CATEGORY_PROS_CONS[s.category] ?? CATEGORY_PROS_CONS.direction;
  const tags = [...(CATEGORY_TAGS[s.category] ?? ['defined-risk'])];
  const hasShort = s.legs.some((l) => l.side === 'short');
  const hasLong = s.legs.some((l) => l.side === 'long');
  if (hasShort && hasLong) tags.push('mixed-sign');
  else if (hasShort) tags.push('net-short-premium');
  if (s.legs.length >= 4) tags.push(`${s.legs.length}-leg`);
  if (s.legs.some((l) => l.kind === 'perp_option')) tags.push('everlasting');
  if (s.legs.length >= 8) tags.push('wide-package');
  return {
    whatIs: s.whatIs,
    whenToUse: s.whenToUse,
    mechanics: mech,
    advantages: pc.pros,
    disadvantages: pc.cons,
    tags: Array.from(new Set(tags)).slice(0, 6),
  };
}

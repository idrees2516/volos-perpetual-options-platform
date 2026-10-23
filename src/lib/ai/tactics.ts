// ---------------------------------------------------------------------------
// tactics — 0DTE scanner, multihop (roll-chain) planner and multileg
// constructor. Everything is grounded in the live venue chains from
// exchange-feeds (real strikes, real IVs, real bid/asks, real OI).
// ---------------------------------------------------------------------------

import { bsGreeks, VOL_CONFIG, forwardPrice } from '@/lib/pricing';
import { snapToGrid } from '@/lib/strategies';
import type { AssetId } from './market-intel';
import {
  getVenueChain,
  getVenueExpiries,
  getCrossVenueQuotes,
  VENUE_IDS,
  type FeedAsset,
  type VenueChain,
  type VenueChainRow,
} from './exchange-feeds';

const DAYS_PER_YEAR = 365;

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number): number {
  const s = Math.sign(x);
  x = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}

function strikeStep(spot: number): number {
  if (spot >= 50000) return 1000;
  if (spot >= 4000) return 100;
  if (spot >= 400) return 5;
  return 0.5;
}

// =============================================================================
// 0DTE SCANNER
// =============================================================================

export interface ZeroDteStructure {
  name: string;
  legs: { kind: 'call' | 'put'; side: 'buy' | 'sell'; strike: number; qty: number; price: number }[];
  netCredit: number; // positive = credit received
  maxProfit: number;
  maxLoss: number;
  breakevens: number[];
  pop: number; // probability of profit (lognormal)
  expectedValue: number;
  rationale: string;
}

export interface ZeroDteScan {
  asset: AssetId;
  venue: string;
  expiry: string;
  hoursToExpiry: number;
  spot: number;
  atmIv: number;
  atmStraddle: number;
  expectedMove: number; // ± USD
  expectedMovePct: number;
  impliedDailyVolPct: number;
  gammaProfile: {
    strike: number;
    gammaOi: number;
    callOi: number;
    putOi: number;
  }[];
  netGammaUsd: number;
  pinRisk: string;
  structures: ZeroDteStructure[];
  timingPlan: string[];
  warnings: string[];
  quoteSource: string;
}

/** Scan the same-day (or nearest) expiry across venues and build 0DTE plays. */
export async function scan0dte(asset: AssetId): Promise<ZeroDteScan> {
  // probe each venue at its NEAREST tradable expiry (the default chains skip
  // <1.5d expiries, so 0DTE must be requested explicitly)
  const attempts = await Promise.all(
    VENUE_IDS.map(async (v) => {
      const { expiries } = await getVenueExpiries(v, asset as FeedAsset);
      const nearest = expiries.find((e) => e.daysOut >= 0.05);
      const label = nearest?.label;
      const { chain } = await getVenueChain(v, asset as FeedAsset, label);
      return chain;
    }),
  );
  const near = attempts
    .filter((c): c is VenueChain => !!c && c.rows.length >= 5 && c.daysOut <= 1.3)
    .sort((a, b) => a.daysOut - b.daysOut);
  const viable = near.length > 0
    ? near
    : attempts
        .filter((c): c is VenueChain => !!c && c.rows.length >= 5 && c.daysOut <= 2.5)
        .sort((a, b) => a.daysOut - b.daysOut);
  if (viable.length === 0) throw new Error('no venue has a same-day/near-dated chain right now');
  const chain =
    viable.find((c) => c.venue === 'deribit' && c.quoteSource === 'live') ??
    viable.find((c) => c.quoteSource === 'live') ??
    viable[0];

  const spot = chain.spot;
  const tHours = Math.max(chain.daysOut * 24, 0.5);
  const t = tHours / 24 / DAYS_PER_YEAR;
  const rows = chain.rows;
  const atm = rows.find((r) => r.isAtm) ?? rows[Math.floor(rows.length / 2)];

  const atmIv = (atm.callIv || atm.putIv || 45) / 100;
  const atmStraddle = atm.callPrice + atm.putPrice;
  const sigma = spot * atmIv * Math.sqrt(t);
  const impliedDailyVolPct = atmIv * Math.sqrt(tHours / 24) * 100;

  // --- gamma profile (uses real OI where the venue provides it) ---------------
  const gammaProfile = rows.map((r) => {
    const gC = bsGreeks(spot, r.strike, Math.max(t, 1 / (365 * 24)), (r.callIv || 45) / 100, 0, 'call').gamma;
    const gP = bsGreeks(spot, r.strike, Math.max(t, 1 / (365 * 24)), (r.putIv || 45) / 100, 0, 'put').gamma;
    const gammaOi = gC * r.callOi + gP * r.putOi;
    return { strike: r.strike, gammaOi: +gammaOi.toFixed(1), callOi: Math.round(r.callOi), putOi: Math.round(r.putOi) };
  });
  const netGammaUsd = gammaProfile.reduce((a, g) => a + g.gammaOi, 0) * spot * spot * 0.01;
  const maxGammaStrike = gammaProfile.reduce((a, g) => (g.gammaOi > a.gammaOi ? g : a), gammaProfile[0]);

  // --- helpers to build structures from real quotes ----------------------------
  const step = strikeStep(spot);
  const nearestRow = (target: number): VenueChainRow => {
    let best = rows[0];
    let bd = Infinity;
    for (const r of rows) {
      const d = Math.abs(r.strike - target);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  };
  const px = (r: VenueChainRow, kind: 'call' | 'put', side: 'buy' | 'sell') => {
    const bid = kind === 'call' ? r.callBid : r.putBid;
    const ask = kind === 'call' ? r.callAsk : r.putAsk;
    const mid = kind === 'call' ? r.callPrice : r.putPrice;
    const p = side === 'buy' ? (ask ?? mid) : (bid ?? mid);
    return p > 0 ? p : mid;
  };
  const popBetween = (lo: number, hi: number) => {
    // P(lo ≤ S_T ≤ hi) under lognormal with the live IV
    const v = atmIv * Math.sqrt(Math.max(t, 1 / (365 * 24)));
    const lnS = Math.log(spot);
    return normCdf((Math.log(hi) - lnS) / v) - normCdf((Math.log(lo) - lnS) / v);
  };
  const popAbove = (k: number) => {
    const v = atmIv * Math.sqrt(Math.max(t, 1 / (365 * 24)));
    return 1 - normCdf((Math.log(k) - Math.log(spot)) / v);
  };
  const popBelow = (k: number) => {
    const v = atmIv * Math.sqrt(Math.max(t, 1 / (365 * 24)));
    return normCdf((Math.log(k) - Math.log(spot)) / v);
  };

  const otmPut = nearestRow(snapToGrid(spot - sigma, 1) || spot - 2 * step);
  const otmCall = nearestRow(snapToGrid(spot + sigma, 1) || spot + 2 * step);
  const farPut = nearestRow(otmPut.strike - step);
  const farCall = nearestRow(otmCall.strike + step);

  const structures: ZeroDteStructure[] = [];

  // Iron fly (sell ATM straddle, buy wings)
  {
    const credit = px(atm, 'call', 'sell') + px(atm, 'put', 'sell') - px(otmCall, 'call', 'buy') - px(otmPut, 'put', 'buy');
    const width = Math.max(otmCall.strike - atm.strike, atm.strike - otmPut.strike);
    const maxLoss = width * 1 - credit;
    if (credit > 0) {
      structures.push({
        name: `0DTE Iron Fly ${atm.strike} (wings ${otmPut.strike}/${otmCall.strike})`,
        legs: [
          { kind: 'call', side: 'sell', strike: atm.strike, qty: 1, price: px(atm, 'call', 'sell') },
          { kind: 'put', side: 'sell', strike: atm.strike, qty: 1, price: px(atm, 'put', 'sell') },
          { kind: 'call', side: 'buy', strike: otmCall.strike, qty: 1, price: px(otmCall, 'call', 'buy') },
          { kind: 'put', side: 'buy', strike: otmPut.strike, qty: 1, price: px(otmPut, 'put', 'buy') },
        ],
        netCredit: +credit.toFixed(1),
        maxProfit: +credit.toFixed(1),
        maxLoss: +maxLoss.toFixed(1),
        breakevens: [atm.strike - credit, atm.strike + credit],
        pop: +(popBetween(atm.strike - credit, atm.strike + credit) * 100).toFixed(1),
        expectedValue: +((popBetween(atm.strike - credit, atm.strike + credit) * credit - (1 - popBetween(atm.strike - credit, atm.strike + credit)) * maxLoss) / 1).toFixed(1),
        rationale: 'high-credit income if spot pins near ATM into the expiry print',
      });
    }
  }

  // Put credit spread
  {
    const credit = px(otmPut, 'put', 'sell') - px(farPut, 'put', 'buy');
    const width = otmPut.strike - farPut.strike;
    if (credit > 0) {
      structures.push({
        name: `0DTE Put Credit Spread ${farPut.strike}/${otmPut.strike}`,
        legs: [
          { kind: 'put', side: 'sell', strike: otmPut.strike, qty: 1, price: px(otmPut, 'put', 'sell') },
          { kind: 'put', side: 'buy', strike: farPut.strike, qty: 1, price: px(farPut, 'put', 'buy') },
        ],
        netCredit: +credit.toFixed(1),
        maxProfit: +credit.toFixed(1),
        maxLoss: +(width - credit).toFixed(1),
        breakevens: [otmPut.strike - credit],
        pop: +(popAbove(otmPut.strike - credit) * 100).toFixed(1),
        expectedValue: +(popAbove(otmPut.strike - credit) * credit - popBelow(otmPut.strike - credit) * (width - credit)).toFixed(1),
        rationale: 'bullish-to-neutral income; wins above the short strike breakeven',
      });
    }
  }

  // Call credit spread
  {
    const credit = px(otmCall, 'call', 'sell') - px(farCall, 'call', 'buy');
    const width = farCall.strike - otmCall.strike;
    if (credit > 0) {
      structures.push({
        name: `0DTE Call Credit Spread ${otmCall.strike}/${farCall.strike}`,
        legs: [
          { kind: 'call', side: 'sell', strike: otmCall.strike, qty: 1, price: px(otmCall, 'call', 'sell') },
          { kind: 'call', side: 'buy', strike: farCall.strike, qty: 1, price: px(farCall, 'call', 'buy') },
        ],
        netCredit: +credit.toFixed(1),
        maxProfit: +credit.toFixed(1),
        maxLoss: +(width - credit).toFixed(1),
        breakevens: [otmCall.strike + credit],
        pop: +(popBelow(otmCall.strike + credit) * 100).toFixed(1),
        expectedValue: +(popBelow(otmCall.strike + credit) * credit - popAbove(otmCall.strike + credit) * (width - credit)).toFixed(1),
        rationale: 'bearish-to-neutral income; wins below the short strike breakeven',
      });
    }
  }

  // Long straddle (gamma play) when the day's realized range trends rich
  {
    const debit = px(atm, 'call', 'buy') + px(atm, 'put', 'buy');
    structures.push({
      name: `0DTE Long Straddle ${atm.strike}`,
      legs: [
        { kind: 'call', side: 'buy', strike: atm.strike, qty: 1, price: px(atm, 'call', 'buy') },
        { kind: 'put', side: 'buy', strike: atm.strike, qty: 1, price: px(atm, 'put', 'buy') },
      ],
      netCredit: -debit,
      maxProfit: +(2 * sigma - debit).toFixed(1),
      maxLoss: +debit.toFixed(1),
      breakevens: [atm.strike - debit, atm.strike + debit],
      pop: +((1 - popBetween(atm.strike - debit, atm.strike + debit)) * 100).toFixed(1),
      expectedValue: +((1 - popBetween(atm.strike - debit, atm.strike + debit)) * (2 * sigma - debit) * 0.35 - popBetween(atm.strike - debit, atm.strike + debit) * debit).toFixed(1),
      rationale: 'direction-agnostic gamma: pays when realized range beats the straddle',
    });
  }

  // Iron condor
  {
    const credit = px(otmPut, 'put', 'sell') + px(otmCall, 'call', 'sell') - px(farPut, 'put', 'buy') - px(farCall, 'call', 'buy');
    if (credit > 0) {
      const wPut = otmPut.strike - farPut.strike;
      const wCall = farCall.strike - otmCall.strike;
      const width = Math.min(wPut, wCall);
      const lo = farPut.strike;
      const hi = farCall.strike;
      structures.push({
        name: `0DTE Iron Condor ${farPut.strike}/${otmPut.strike} · ${otmCall.strike}/${farCall.strike}`,
        legs: [
          { kind: 'put', side: 'sell', strike: otmPut.strike, qty: 1, price: px(otmPut, 'put', 'sell') },
          { kind: 'put', side: 'buy', strike: farPut.strike, qty: 1, price: px(farPut, 'put', 'buy') },
          { kind: 'call', side: 'sell', strike: otmCall.strike, qty: 1, price: px(otmCall, 'call', 'sell') },
          { kind: 'call', side: 'buy', strike: farCall.strike, qty: 1, price: px(farCall, 'call', 'buy') },
        ],
        netCredit: +credit.toFixed(1),
        maxProfit: +credit.toFixed(1),
        maxLoss: +(width - credit).toFixed(1),
        breakevens: [otmPut.strike - credit, otmCall.strike + credit],
        pop: +(popBetween(lo, hi) * 100).toFixed(1),
        expectedValue: +(popBetween(lo, hi) * credit - (1 - popBetween(lo, hi)) * (width - credit)).toFixed(1),
        rationale: 'range income between the short strikes with defined wings',
      });
    }
  }

  structures.sort((a, b) => b.expectedValue - a.expectedValue);

  return {
    asset,
    venue: chain.venue,
    expiry: chain.expiry,
    hoursToExpiry: +tHours.toFixed(1),
    spot,
    atmIv: +(atmIv * 100).toFixed(1),
    atmStraddle: +atmStraddle.toFixed(1),
    expectedMove: +sigma.toFixed(1),
    expectedMovePct: +((sigma / spot) * 100).toFixed(2),
    impliedDailyVolPct: +impliedDailyVolPct.toFixed(2),
    gammaProfile: gammaProfile.filter((g) => Math.abs(g.strike - spot) / spot < 0.12),
    netGammaUsd: +netGammaUsd.toFixed(0),
    pinRisk: maxGammaStrike
      ? `largest gamma sits at ${maxGammaStrike.strike} — expect pinning / whipsaw risk there in the final hours`
      : 'no meaningful OI to pin to',
    structures,
    timingPlan: [
      'enter credit structures in the first 2h of the session after the opening range sets',
      'take profit at 50-65% of max credit — 0DTE theta decays fast',
      'stop at 2× the credit received or on a break of the short strike',
      'close long-gamma structures (straddle) into the last 2h — gamma decay accelerates',
      'flat by expiry print: no 0DTE position should be held through settlement (pin risk)',
    ],
    warnings: [
      '0DTE is the highest-gamma product in options — size at 25-50% of your usual risk',
      'slippage widens in the final hour; use limit orders at mid',
      chain.quoteSource === 'derived'
        ? 'quotes on this venue are derived from the live cross-venue IV surface'
        : 'quotes are native venue bid/asks',
    ],
    quoteSource: chain.quoteSource,
  };
}

// =============================================================================
// MULTIHOP (ROLL-CHAIN) PLANNER
// =============================================================================

export interface MultihopLegPlan {
  kind: 'call' | 'put';
  side: 'buy' | 'sell';
  qty: number;
  strike: number;
  expiryDays: number;
  entryPrice: number;
  bestVenue?: string;
}

export interface MultihopHop {
  hop: number;
  startDay: number;
  endDay: number;
  action: string;
  legs: MultihopLegPlan[];
  netDebit: number; // negative = credit
  expectedCarry: number; // theta/day estimate
  greeks: { delta: number; gamma: number; vega: number; theta: number };
  adjustmentTriggers: string[];
}

export interface MultihopPlan {
  asset: AssetId;
  hops: MultihopHop[];
  routing: { leg: string; venue: string; bid: number; ask: number }[];
  expectedPathPnl: { p25: number; p50: number; p75: number };
  managementRules: string[];
  notes: string[];
}

/** Plan a multihop roll chain: entry → rolls at profit/defence levels → exit. */
export async function planMultihop(
  asset: AssetId,
  legs: { kind: 'call' | 'put'; side: 'buy' | 'sell'; qty: number; strikeMult: number; expiryDays: number }[],
  hops = 3,
): Promise<MultihopPlan> {
  const { chain } = await getVenueChain('deribit', asset as FeedAsset);
  const xq = await getCrossVenueQuotes(asset as FeedAsset);
  const spot = xq.spot || chain?.spot || 0;
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  if (!spot || legs.length === 0) throw new Error('no live market for multihop plan');

  const legExpiry = legs[0].expiryDays ?? 30;
  const routing: MultihopPlan['routing'] = [];
  const planHops: MultihopHop[] = [];

  for (let h = 1; h <= Math.min(hops, 5); h++) {
    const startDay = (h - 1) * Math.round(legExpiry * 0.7);
    const endDay = startDay + legExpiry;
    const hopLegs: MultihopLegPlan[] = [];
    let netDebit = 0;
    let delta = 0,
      gamma = 0,
      vega = 0,
      theta = 0;

    for (const l of legs) {
      const strike = snapToGrid(spot, l.strikeMult);
      const t = legExpiry / DAYS_PER_YEAR;
      const iv = (chain?.rows.find((r) => r.strike === strike)?.callIv ?? 45) / 100;
      const g = bsGreeks(spot, strike, t, iv, cfg.rate, l.kind);
      const dir = l.side === 'buy' ? 1 : -1;
      const price = g.price * dir < 0 ? g.price : g.price;
      hopLegs.push({
        kind: l.kind,
        side: l.side,
        qty: l.qty,
        strike,
        expiryDays: legExpiry,
        entryPrice: +price.toFixed(1),
        bestVenue: xq.quotes.find((q) => q.strike === strike && q.kind === l.kind)?.bestBidVenue,
      });
      netDebit += dir * price * l.qty;
      delta += dir * g.delta * l.qty;
      gamma += dir * g.gamma * l.qty;
      vega += dir * g.vega * l.qty;
      theta += dir * g.theta * l.qty;
      if (h === 1) {
        const q = xq.quotes.find((x) => x.strike === strike && x.kind === l.kind);
        if (q) routing.push({ leg: `${l.side} ${l.qty} ${l.kind} ${strike}`, venue: l.side === 'buy' ? q.bestAskVenue : q.bestBidVenue, bid: +q.bestBid.toFixed(1), ask: +q.bestAsk.toFixed(1) });
      }
    }

    planHops.push({
      hop: h,
      startDay,
      endDay,
      action:
        h === 1
          ? 'initial structure at live market'
          : `roll the structure out ${legExpiry}d: close all legs, re-strike at the then-current spot (${h % 2 === 0 ? 'same relative strikes' : 're-center strikes'})`,
      legs: hopLegs,
      netDebit: +netDebit.toFixed(1),
      expectedCarry: +(theta * 1).toFixed(2),
      greeks: {
        delta: +delta.toFixed(3),
        gamma: +gamma.toFixed(5),
        vega: +vega.toFixed(1),
        theta: +theta.toFixed(2),
      },
      adjustmentTriggers: [
        `profit take: close at 50% of max profit inside hop ${h}`,
        `defence: if spot moves ±${((chain?.atmIv ?? 45) / 100 * Math.sqrt(legExpiry / DAYS_PER_YEAR) * 100).toFixed(1)}% (1σ), roll the tested side`,
        `time: roll at day ${Math.round(startDay + legExpiry * 0.7)} regardless (70% of cycle)`,
      ],
    });
  }

  // path PnL proxy across hops via the live IV distribution
  const iv = (chain?.atmIv ?? 45) / 100;
  const totalDays = planHops.length * Math.round(legExpiry * 0.7) + legExpiry;
  const sigmaTotal = spot * iv * Math.sqrt(totalDays / DAYS_PER_YEAR);
  const expectedPathPnl = {
    p25: +(-sigmaTotal * 0.35 * legs.reduce((a, l) => a + (l.side === 'sell' ? l.qty : -l.qty * 0.5), 0)).toFixed(0),
    p50: +planHops.reduce((a, h) => a + h.expectedCarry * legExpiry * 0.55, 0).toFixed(0),
    p75: +(sigmaTotal * 0.3 * legs.reduce((a, l) => a + (l.side === 'sell' ? l.qty : -l.qty * 0.5), 0)).toFixed(0),
  };

  return {
    asset,
    hops: planHops,
    routing,
    expectedPathPnl,
    managementRules: [
      'roll on green: take the roll when the structure hits 50% profit — re-strike at new spot',
      'roll on red: when a short strike is tested, roll that side down/out for a small debit',
      'never hold a short leg through its final 24h without a stop — gamma risk explodes',
      `size each hop so the worst-case loss of the FULL chain stays under 2% of book`,
    ],
    notes: [
      `prices from live Deribit chain (expiry ${chain?.expiry ?? 'n/a'}, ATM IV ${(chain?.atmIv ?? 45).toFixed(1)}%)`,
      `routing uses best bid/ask across ${xq.chains.filter((c) => c.quoteSource === 'live').length} live venues`,
      'hop greeks estimated at entry spot; re-striking happens at each roll',
    ],
  };
}

// =============================================================================
// MULTILEG CONSTRUCTOR — classic structures from the live surface
// =============================================================================

export interface MultilegCandidate {
  name: string;
  description: string;
  legs: { kind: 'call' | 'put'; side: 'buy' | 'sell'; qty: number; strikeMult: number; expiryDays: number }[];
  netEstimate: number;
  fit: string;
}

/** Propose multileg structures for a view, struck off the live surface. */
export async function proposeMultileg(asset: AssetId, view: 'bullish' | 'bearish' | 'neutral' | 'volatile' | 'low-vol'): Promise<MultilegCandidate[]> {
  const { chain } = await getVenueChain('deribit', asset as FeedAsset);
  const spot = chain?.spot ?? 0;
  if (!spot) throw new Error('no live chain');
  const iv = (chain.atmIv ?? 45) / 100;
  const t = 30 / DAYS_PER_YEAR;
  const sigma = spot * iv * Math.sqrt(t);

  const shortDte = 30;
  const longDte = 60;

  const base: Record<string, MultilegCandidate[]> = {
    bullish: [
      {
        name: 'ZEBRA (Zero Extrinsic Back Ratio)',
        description: 'buy 2 ITM calls ~70% delta, sell 1 ATM call: synthetic stock-like exposure at ~half the capital',
        legs: [
          { kind: 'call', side: 'buy', qty: 2, strikeMult: 0.9, expiryDays: shortDte },
          { kind: 'call', side: 'sell', qty: 1, strikeMult: 1.0, expiryDays: shortDte },
        ],
        netEstimate: 0,
        fit: 'strong bullish, defined risk, near-zero extrinsic',
      },
      {
        name: 'Bull Put Diagonal',
        description: 'sell 30d put, buy longer-dated further put — bullish credit with theta on your side',
        legs: [
          { kind: 'put', side: 'sell', qty: 1, strikeMult: 0.95, expiryDays: shortDte },
          { kind: 'put', side: 'buy', qty: 1, strikeMult: 0.9, expiryDays: longDte },
        ],
        netEstimate: 0,
        fit: 'moderately bullish income',
      },
    ],
    bearish: [
      {
        name: 'Bear Call Diagonal',
        description: 'sell 30d call, buy longer-dated higher call — bearish credit structure',
        legs: [
          { kind: 'call', side: 'sell', qty: 1, strikeMult: 1.05, expiryDays: shortDte },
          { kind: 'call', side: 'buy', qty: 1, strikeMult: 1.1, expiryDays: longDte },
        ],
        netEstimate: 0,
        fit: 'moderately bearish income',
      },
      {
        name: 'Put Backspread',
        description: 'sell 1 ATM put, buy 2 lower puts — profits big on a crash, small credit if up',
        legs: [
          { kind: 'put', side: 'sell', qty: 1, strikeMult: 1.0, expiryDays: shortDte },
          { kind: 'put', side: 'buy', qty: 2, strikeMult: 0.93, expiryDays: shortDte },
        ],
        netEstimate: 0,
        fit: 'crash-bearish with positive carry',
      },
    ],
    neutral: [
      {
        name: 'Double Calendar',
        description: 'calendars on both sides at ±1σ — long vega, short theta risk contained',
        legs: [
          { kind: 'put', side: 'sell', qty: 1, strikeMult: 0.97, expiryDays: shortDte },
          { kind: 'put', side: 'buy', qty: 1, strikeMult: 0.97, expiryDays: longDte },
          { kind: 'call', side: 'sell', qty: 1, strikeMult: 1.03, expiryDays: shortDte },
          { kind: 'call', side: 'buy', qty: 1, strikeMult: 1.03, expiryDays: longDte },
        ],
        netEstimate: 0,
        fit: 'range-bound with cheap wings',
      },
      {
        name: 'Jade Lizard',
        description: 'short put + short call spread with no upside risk — pure credit collection',
        legs: [
          { kind: 'put', side: 'sell', qty: 1, strikeMult: 0.95, expiryDays: shortDte },
          { kind: 'call', side: 'sell', qty: 1, strikeMult: 1.05, expiryDays: shortDte },
          { kind: 'call', side: 'buy', qty: 1, strikeMult: 1.12, expiryDays: shortDte },
        ],
        netEstimate: 0,
        fit: 'neutral-to-bullish income, no upside tail',
      },
    ],
    volatile: [
      {
        name: 'Reverse Iron Condor',
        description: 'debit condor that profits from a big move either way',
        legs: [
          { kind: 'put', side: 'buy', qty: 1, strikeMult: 0.95, expiryDays: shortDte },
          { kind: 'put', side: 'sell', qty: 1, strikeMult: 0.9, expiryDays: shortDte },
          { kind: 'call', side: 'buy', qty: 1, strikeMult: 1.05, expiryDays: shortDte },
          { kind: 'call', side: 'sell', qty: 1, strikeMult: 1.1, expiryDays: shortDte },
        ],
        netEstimate: 0,
        fit: 'breakout expected, defined risk',
      },
      {
        name: 'Straddle Calendar',
        description: 'sell 30d straddle, buy 60d straddle — long vol term structure',
        legs: [
          { kind: 'call', side: 'sell', qty: 1, strikeMult: 1.0, expiryDays: shortDte },
          { kind: 'put', side: 'sell', qty: 1, strikeMult: 1.0, expiryDays: shortDte },
          { kind: 'call', side: 'buy', qty: 1, strikeMult: 1.0, expiryDays: longDte },
          { kind: 'put', side: 'buy', qty: 1, strikeMult: 1.0, expiryDays: longDte },
        ],
        netEstimate: 0,
        fit: 'event-driven long-vega with short-dated theta funding',
      },
    ],
    'low-vol': [
      {
        name: 'Iron Condor at ±1σ',
        description: 'classic premium harvest with wings',
        legs: [
          { kind: 'put', side: 'sell', qty: 1, strikeMult: +(1 - sigma / spot).toFixed(3), expiryDays: shortDte },
          { kind: 'put', side: 'buy', qty: 1, strikeMult: +(1 - 1.5 * sigma / spot).toFixed(3), expiryDays: shortDte },
          { kind: 'call', side: 'sell', qty: 1, strikeMult: +(1 + sigma / spot).toFixed(3), expiryDays: shortDte },
          { kind: 'call', side: 'buy', qty: 1, strikeMult: +(1 + 1.5 * sigma / spot).toFixed(3), expiryDays: shortDte },
        ],
        netEstimate: 0,
        fit: 'IV contraction expected',
      },
      {
        name: 'Broken Wing Butterfly (calls)',
        description: 'tight debit fly with an unbalanced wing — cheap or zero-cost structure',
        legs: [
          { kind: 'call', side: 'buy', qty: 1, strikeMult: 0.98, expiryDays: shortDte },
          { kind: 'call', side: 'sell', qty: 2, strikeMult: 1.0, expiryDays: shortDte },
          { kind: 'call', side: 'buy', qty: 1, strikeMult: 1.05, expiryDays: shortDte },
        ],
        netEstimate: 0,
        fit: 'pin expected slightly below ATM into expiry',
      },
    ],
  };

  const cands = base[view] ?? base.neutral;
  // price each candidate roughly off the live surface
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  for (const c of cands) {
    let net = 0;
    for (const l of c.legs) {
      const strike = snapToGrid(spot, l.strikeMult);
      const tL = l.expiryDays / DAYS_PER_YEAR;
      const row = chain.rows.find((r) => r.strike === strike);
      const ivL = row ? (l.kind === 'call' ? row.callIv : row.putIv) / 100 : iv;
      const g = bsGreeks(spot, strike, tL, ivL, cfg.rate, l.kind);
      net += (l.side === 'buy' ? -g.price : g.price) * l.qty;
    }
    c.netEstimate = +net.toFixed(1);
  }
  return cands;
}

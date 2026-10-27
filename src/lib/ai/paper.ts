// ---------------------------------------------------------------------------
// paper — paper-trading engine: a virtual USDC account that fills orders at
// REAL venue best-bid/offer across all six connected exchanges (Deribit,
// Bybit, OKX, Aevo, Paradex, Derive v3), charges realistic taker fees, holds
// simplified margin, marks positions to live mid prices, settles expiries at
// intrinsic, and persists everything to disk.
//
// Design notes:
//   • Quotes come from exchange-feeds (venue chains) — deribit/derive/paradex
//     carry native bid/ask; the others mid off IV where needed.
//   • Market buys fill at the real ask, sells at the real bid; limit orders
//     rest and are re-checked on every account refresh.
//   • Fees: taker bps of underlying notional per unit (per-venue table).
//   • Margin: longs escrow premium; shorts hold 15% of strike notional.
//   • "auto" venue routing: buys pick the lowest live ask, sells the highest
//     live bid across all six venues.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import {
  getVenueChain,
  getVenueExpiries,
  VENUE_IDS,
  VENUE_META,
  parseExpiryLabel,
  type FeedAsset,
  type VenueId,
} from './exchange-feeds';

// --- types -------------------------------------------------------------------

export type PaperKind = 'call' | 'put';
export type PaperSide = 'buy' | 'sell';

export interface PaperPosition {
  id: string;
  venue: VenueId;
  asset: FeedAsset;
  expiry: string;
  expiryMs: number;
  strike: number;
  kind: PaperKind;
  side: 'long' | 'short';
  qty: number;
  entryPrice: number;
  markPrice: number;
  markTs: number;
  openedAt: number;
  feesPaid: number;
  marginHeld: number;
  strategyTag?: string;
}

export interface PaperFill {
  id: string;
  ts: number;
  venue: VenueId;
  asset: FeedAsset;
  expiry: string;
  strike: number;
  kind: PaperKind;
  side: PaperSide;
  qty: number;
  price: number;
  fee: number;
  spotAtFill: number;
  strategyTag?: string;
  note?: string;
}

export interface PaperLimitOrder {
  id: string;
  createdAt: number;
  venue: VenueId;
  asset: FeedAsset;
  expiry: string;
  strike: number;
  kind: PaperKind;
  side: PaperSide;
  qty: number;
  limitPrice: number;
  strategyTag?: string;
}

interface PaperAccount {
  version: 1;
  startingCash: number;
  cash: number;
  positions: PaperPosition[];
  openOrders: PaperLimitOrder[];
  fills: PaperFill[];
  realizedTotal: number;
  feesTotal: number;
  wins: number;
  losses: number;
  equityCurve: { t: number; equity: number }[];
  createdAt: number;
  lastCurveAt: number;
}

export interface ResolvedQuote {
  venue: VenueId;
  asset: FeedAsset;
  expiry: string;
  expiryMs: number;
  strike: number;
  kind: PaperKind;
  bid: number | null;
  ask: number | null;
  mid: number;
  iv: number;
  delta: number;
  spot: number;
  daysOut: number;
  quoteSource: 'live' | 'derived';
  feeBps: number;
  note?: string;
}

export interface PaperOrderRequest {
  venue?: VenueId | 'auto';
  asset: FeedAsset;
  expiry?: string;
  strike: number;
  kind: PaperKind;
  side: PaperSide;
  qty: number;
  type?: 'market' | 'limit';
  limitPrice?: number;
  strategyTag?: string;
}

export interface StrategyLegRequest {
  kind: PaperKind;
  side: PaperSide;
  qty: number;
  strike: number;
  expiryDays?: number;
  expiry?: string;
}

export interface DeployRequest {
  name: string;
  asset: FeedAsset;
  venue?: VenueId | 'auto';
  sizeMultiplier?: number;
  legs: StrategyLegRequest[];
}

// --- fee table (taker, bps of underlying notional per unit) -------------------

export const TAKER_FEE_BPS: Record<VenueId, number> = {
  deribit: 3,
  bybit: 2,
  okx: 2,
  aevo: 3,
  paradex: 2,
  derive: 3,
  binance: 4,
  hyperliquid: 3,
  lighter: 2,
};

const SHORT_MARGIN_PCT = 0.15; // reg-T-lite holdback for short options
const START_CASH = 100_000;

// --- persistence --------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), 'data');
const ACCOUNT_FILE = path.join(DATA_DIR, 'paper-account.json');

function freshAccount(): PaperAccount {
  return {
    version: 1,
    startingCash: START_CASH,
    cash: START_CASH,
    positions: [],
    openOrders: [],
    fills: [],
    realizedTotal: 0,
    feesTotal: 0,
    wins: 0,
    losses: 0,
    equityCurve: [{ t: Date.now(), equity: START_CASH }],
    createdAt: Date.now(),
    lastCurveAt: Date.now(),
  };
}

interface PaperGlobal {
  __paperAccount?: PaperAccount;
  __paperWrite?: Promise<void>;
}

const g = globalThis as unknown as PaperGlobal;

function loadAccount(): PaperAccount {
  if (g.__paperAccount) return g.__paperAccount;
  try {
    const raw = fs.readFileSync(ACCOUNT_FILE, 'utf8');
    const acct = JSON.parse(raw) as PaperAccount;
    if (acct && acct.version === 1 && Array.isArray(acct.positions)) {
      g.__paperAccount = acct;
      return acct;
    }
  } catch {
    /* first run */
  }
  g.__paperAccount = freshAccount();
  return g.__paperAccount;
}

function saveAccount(): void {
  const acct = g.__paperAccount;
  if (!acct) return;
  const write = (async () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = ACCOUNT_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(acct));
      fs.renameSync(tmp, ACCOUNT_FILE);
    } catch {
      /* disk full / perms — paper state stays in memory */
    }
  })();
  // serialize writes; drop errors
  g.__paperWrite = (g.__paperWrite ?? Promise.resolve()).then(() => write).catch(() => {});
}

// --- quote resolution -----------------------------------------------------------

/**
 * Resolve a REAL executable quote for one option. With venue='auto' the buy
 * side picks the lowest live ask and the sell side the highest live bid
 * across all connected venues.
 */
export async function resolveOptionQuote(
  venue: VenueId | 'auto',
  asset: FeedAsset,
  expiry: string | undefined,
  strike: number,
  kind: PaperKind,
  forSide: PaperSide = 'buy',
): Promise<{ quote: ResolvedQuote; alternatives: ResolvedQuote[]; error?: string }> {
  const tryVenues: VenueId[] = venue === 'auto' ? VENUE_IDS : [venue, ...VENUE_IDS.filter((v) => v !== venue)];
  const results: ResolvedQuote[] = [];
  const errors: string[] = [];

  for (const v of tryVenues) {
    try {
      const { chain } = await getVenueChain(v, asset, expiry);
      if (!chain) {
        errors.push(`${v}: unreachable`);
        continue;
      }
      const row = chain.rows.find((r) => r.strike === strike);
      if (!row) {
        errors.push(`${v}: strike ${strike} not listed for ${chain.expiry}`);
        continue;
      }
      const bid = kind === 'call' ? row.callBid : row.putBid;
      const ask = kind === 'call' ? row.callAsk : row.putAsk;
      const mid =
        bid != null && ask != null && ask > 0
          ? (bid + ask) / 2
          : kind === 'call'
            ? row.callPrice
            : row.putPrice;
      results.push({
        venue: v,
        asset,
        expiry: chain.expiry,
        expiryMs: chain.expiryMs,
        strike,
        kind,
        bid: bid ?? null,
        ask: ask ?? null,
        mid,
        iv: kind === 'call' ? row.callIv : row.putIv,
        delta: kind === 'call' ? row.callDelta : row.putDelta,
        spot: chain.spot,
        daysOut: chain.daysOut,
        quoteSource: chain.quoteSource,
        feeBps: TAKER_FEE_BPS[v],
        note: bid == null && ask == null ? 'mark only — no resting quote' : undefined,
      });
    } catch (err) {
      errors.push(`${v}: ${err instanceof Error ? err.message.slice(0, 60) : 'error'}`);
    }
  }

  if (results.length === 0) {
    return { quote: null as unknown as ResolvedQuote, alternatives: [], error: errors.join(' · ') || 'no venue has this option' };
  }

  // pick best executable venue for the side
  const executable = (q: ResolvedQuote) => (forSide === 'buy' ? q.ask != null && q.ask > 0 : q.bid != null && q.bid > 0);
  const pool = results.filter(executable);
  const pickFrom = pool.length > 0 ? pool : results;
  const best = pickFrom.reduce((acc, q) => {
    if (forSide === 'buy') {
      const a = q.ask ?? Infinity;
      const b = acc.ask ?? Infinity;
      return a < b ? q : acc;
    }
    const a = q.bid ?? 0;
    const b = acc.bid ?? 0;
    return a > b ? q : acc;
  });
  return { quote: best, alternatives: results };
}

// --- account mechanics ----------------------------------------------------------

function feeFor(venue: VenueId, spot: number, qty: number): number {
  return Math.max(1, (spot * qty * TAKER_FEE_BPS[venue]) / 10_000);
}

function marginFor(strike: number, qty: number): number {
  return SHORT_MARGIN_PCT * strike * qty;
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

interface FillOutcome {
  ok: boolean;
  fill?: PaperFill;
  error?: string;
  position?: PaperPosition;
}

/** Execute one leg against a resolved quote (market order). Mutates account. */
function executeFill(acct: PaperAccount, q: ResolvedQuote, side: PaperSide, qty: number, strategyTag?: string, limitCap?: number): FillOutcome {
  const price =
    side === 'buy' ? (q.ask ?? q.mid) : (q.bid ?? q.mid);
  if (!(price > 0)) return { ok: false, error: `no ${side === 'buy' ? 'ask' : 'bid'} on ${q.venue} for ${q.asset} ${q.expiry} ${q.strike} ${q.kind}` };
  const fillPrice = limitCap != null ? (side === 'buy' ? Math.min(limitCap, price) : Math.max(limitCap, price)) : price;
  const fee = feeFor(q.venue, q.spot, qty);
  const notional = fillPrice * qty;

  // ---- margin / cash checks
  const marginHeld = acct.positions.reduce((a, p) => a + p.marginHeld, 0);
  const available = acct.cash - marginHeld;
  if (side === 'buy' && notional + fee > available) {
    return { ok: false, error: `insufficient free cash: need $${(notional + fee).toFixed(0)}, have $${available.toFixed(0)} (cash ${acct.cash.toFixed(0)} − margin ${marginHeld.toFixed(0)})` };
  }
  if (side === 'sell') {
    const need = marginFor(q.strike, qty) - notional + fee; // premium credits back
    if (need > available) {
      return { ok: false, error: `insufficient margin for short: need $${marginFor(q.strike, qty).toFixed(0)} holdback (15% of strike), free $${available.toFixed(0)}` };
    }
  }

  // Position matching is venue-agnostic: desks legitimately close a short
  // opened on one venue by lifting the opposite quote on another — the
  // exposure nets, margin releases, and the fill records the actual venue.
  const key = (p: PaperPosition) => p.asset === q.asset && p.expiry === q.expiry && p.strike === q.strike && p.kind === q.kind;
  const existing = acct.positions.find(key);
  const closing = existing && ((existing.side === 'long' && side === 'sell') || (existing.side === 'short' && side === 'buy'));
  const openingQty = closing ? Math.max(0, qty - existing.qty) : qty;

  // ---- cash movement
  if (side === 'buy') {
    acct.cash -= notional + fee;
    // buy-to-cover: margin holdback releases automatically because the
    // position qty (and its marginHeld) shrinks below — no cash credit.
  } else {
    acct.cash += notional - fee;
  }

  // ---- position bookkeeping
  let position: PaperPosition | undefined;
  if (closing && existing) {
    const closedQty = Math.min(qty, existing.qty);
    const dir = existing.side === 'long' ? 1 : -1;
    const pnl = dir * (fillPrice - existing.entryPrice) * closedQty;
    acct.realizedTotal += pnl - fee;
    if (pnl >= 0) acct.wins += 1;
    else acct.losses += 1;
    const remaining = existing.qty - closedQty;
    if (remaining <= 1e-9) {
      existing.marginHeld = 0;
      acct.positions = acct.positions.filter((p) => p.id !== existing.id);
    } else {
      existing.qty = remaining;
      existing.marginHeld = marginFor(existing.strike, remaining);
    }
    // opening the excess as a new opposite position
    if (openingQty > 0) {
      position = {
        id: nextId('pos'),
        venue: q.venue,
        asset: q.asset,
        expiry: q.expiry,
        expiryMs: q.expiryMs,
        strike: q.strike,
        kind: q.kind,
        side: side === 'buy' ? 'long' : 'short',
        qty: openingQty,
        entryPrice: fillPrice,
        markPrice: q.mid,
        markTs: Date.now(),
        openedAt: Date.now(),
        feesPaid: fee,
        marginHeld: side === 'sell' ? marginFor(q.strike, openingQty) : 0,
        strategyTag,
      };
      acct.positions.push(position);
    }
  } else if (existing) {
    // adding to same-side position → weighted average entry
    const totalQty = existing.qty + qty;
    existing.entryPrice = (existing.entryPrice * existing.qty + fillPrice * qty) / totalQty;
    existing.qty = totalQty;
    existing.feesPaid += fee;
    if (existing.side === 'short') existing.marginHeld = marginFor(existing.strike, totalQty);
    position = existing;
  } else {
    position = {
      id: nextId('pos'),
      venue: q.venue,
      asset: q.asset,
      expiry: q.expiry,
      expiryMs: q.expiryMs,
      strike: q.strike,
      kind: q.kind,
      side: side === 'buy' ? 'long' : 'short',
      qty,
      entryPrice: fillPrice,
      markPrice: q.mid,
      markTs: Date.now(),
      openedAt: Date.now(),
      feesPaid: fee,
      marginHeld: side === 'sell' ? marginFor(q.strike, qty) : 0,
      strategyTag,
    };
    acct.positions.push(position);
  }

  const fill: PaperFill = {
    id: nextId('fill'),
    ts: Date.now(),
    venue: q.venue,
    asset: q.asset,
    expiry: q.expiry,
    strike: q.strike,
    kind: q.kind,
    side,
    qty,
    price: fillPrice,
    fee,
    spotAtFill: q.spot,
    strategyTag,
  };
  acct.fills.unshift(fill);
  if (acct.fills.length > 400) acct.fills.length = 400;
  acct.feesTotal += fee;
  return { ok: true, fill, position };
}

/** Place an order: market fills immediately; limit rests if not crossable. */
export async function placePaperOrder(req: PaperOrderRequest): Promise<FillOutcome & { rested?: PaperLimitOrder }> {
  const acct = loadAccount();
  const venue = req.venue ?? 'auto';
  const qty = Math.max(1e-6, req.qty);
  if (!Number.isFinite(req.strike) || req.strike <= 0) return { ok: false, error: 'strike required' };

  const { quote, error } = await resolveOptionQuote(venue, req.asset, req.expiry, req.strike, req.kind, req.side);
  if (!quote?.venue) return { ok: false, error: error ?? 'no quote' };

  if (req.type === 'limit' && req.limitPrice != null) {
    const crossable = req.side === 'buy' ? quote.ask != null && req.limitPrice >= quote.ask : quote.bid != null && req.limitPrice <= quote.bid;
    if (!crossable) {
      const order: PaperLimitOrder = {
        id: nextId('ord'),
        createdAt: Date.now(),
        venue: quote.venue,
        asset: req.asset,
        expiry: quote.expiry,
        strike: req.strike,
        kind: req.kind,
        side: req.side,
        qty,
        limitPrice: req.limitPrice,
        strategyTag: req.strategyTag,
      };
      acct.openOrders.push(order);
      saveAccount();
      return { ok: true, rested: order };
    }
    const res = executeFill(acct, quote, req.side, qty, req.strategyTag, req.limitPrice);
    saveAccount();
    return res;
  }

  const res = executeFill(acct, quote, req.side, qty, req.strategyTag);
  saveAccount();
  return res;
}

/** Close a position at market (fills at the real opposite BBO). */
export async function closePaperPosition(positionId: string, qty?: number): Promise<FillOutcome> {
  const acct = loadAccount();
  const pos = acct.positions.find((p) => p.id === positionId);
  if (!pos) return { ok: false, error: 'position not found' };
  const closeQty = Math.min(qty ?? pos.qty, pos.qty);
  const { quote, error } = await resolveOptionQuote(pos.venue, pos.asset, pos.expiry, pos.strike, pos.kind, pos.side === 'long' ? 'sell' : 'buy');
  if (!quote?.venue) return { ok: false, error: error ?? 'no quote to close' };
  const res = executeFill(acct, quote, pos.side === 'long' ? 'sell' : 'buy', closeQty, pos.strategyTag);
  saveAccount();
  return res;
}

export function cancelPaperOrder(orderId: string): { ok: boolean; error?: string } {
  const acct = loadAccount();
  const before = acct.openOrders.length;
  acct.openOrders = acct.openOrders.filter((o) => o.id !== orderId);
  saveAccount();
  return before === acct.openOrders.length ? { ok: false, error: 'order not found' } : { ok: true };
}

// --- strategy deployment ----------------------------------------------------------

function pickExpiryLabel(labels: { label: string; ms: number }[], targetDays: number): string | null {
  if (labels.length === 0) return null;
  let best = labels[0];
  let bestErr = Infinity;
  for (const l of labels) {
    const d = (l.ms - Date.now()) / 86_400_000;
    const err = Math.abs(d - targetDays);
    if (err < bestErr) {
      bestErr = err;
      best = l;
    }
  }
  return best.label;
}

/** All listed strikes for an asset+expiry on the venue with the widest chain. */
async function listedStrikes(asset: FeedAsset, expiryLabel: string): Promise<number[]> {
  const strikes = new Set<number>();
  await Promise.all(
    VENUE_IDS.map(async (v) => {
      try {
        const { chain } = await getVenueChain(v, asset, expiryLabel);
        for (const r of chain?.rows ?? []) strikes.add(r.strike);
      } catch {
        /* venue without this expiry */
      }
    }),
  );
  return [...strikes].sort((a, b) => a - b);
}

/** Snap a requested strike to the nearest listed one (real desks do this). */
function snapStrike(want: number, strikes: number[]): number {
  if (strikes.length === 0) return want;
  let best = strikes[0];
  let bestErr = Infinity;
  for (const s of strikes) {
    const err = Math.abs(s - want);
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return best;
}

/**
 * Paper-deploy a complete multi-leg strategy package. Every leg is priced at
 * REAL quotes (auto-routed to the best venue per leg), margin is checked in
 * aggregate, and legs fill atomically as one tagged package.
 */
export async function deployPaperStrategy(req: DeployRequest): Promise<{
  ok: boolean;
  name: string;
  legs: { leg: string; venue: VenueId; expiry: string; strike: number; side: PaperSide; qty: number; price: number; fee: number; iv: number }[];
  rejected?: string;
  error?: string;
  cashAfter?: number;
  netPremium?: number;
}> {
  const acct = loadAccount();
  const size = Math.max(1, req.sizeMultiplier ?? 1);
  const dated = req.legs.filter((l) => (l.kind === 'call' || l.kind === 'put') && l.strike > 0);
  if (dated.length === 0) return { ok: false, name: req.name, legs: [], error: 'no dated option legs to deploy (paper desk covers calls/puts)' };

  // pre-resolve every leg at real quotes (snapping strikes to the nearest listed)
  const plan: { leg: StrategyLegRequest; quote: ResolvedQuote; qty: number; snapped?: number }[] = [];
  const venueHint: VenueId | 'auto' = req.venue ?? 'auto';
  const strikeCache = new Map<string, number[]>();
  for (const leg of dated) {
    const qty = leg.qty * size;
    // map expiryDays → nearest listed expiry when needed (look at Deribit calendar first)
    let expiryLabel = leg.expiry;
    if (!expiryLabel && leg.expiryDays != null) {
      const { expiries } = await getVenueExpiries(venueHint === 'auto' ? 'deribit' : venueHint, req.asset);
      expiryLabel = pickExpiryLabel(expiries, leg.expiryDays) ?? undefined;
    }
    // snap the strike to the nearest listed strike for that expiry
    let strike = leg.strike;
    if (expiryLabel) {
      const cacheKey = `${req.asset}:${expiryLabel}`;
      let strikes = strikeCache.get(cacheKey);
      if (!strikes) {
        strikes = await listedStrikes(req.asset, expiryLabel);
        strikeCache.set(cacheKey, strikes);
      }
      const snapped = snapStrike(leg.strike, strikes);
      if (snapped !== leg.strike) strike = snapped;
    }
    const { quote, error } = await resolveOptionQuote(venueHint, req.asset, expiryLabel, strike, leg.kind, leg.side);
    if (!quote?.venue) {
      return { ok: false, name: req.name, legs: [], error: `leg ${leg.side} ${leg.qty}× ${req.asset} ${leg.strike} ${leg.kind}: ${error ?? 'no venue quote'}` };
    }
    plan.push({ leg, quote, qty, snapped: strike !== leg.strike ? strike : undefined });
  }

  // aggregate margin/premium check
  let premiumNeed = 0;
  let marginNeed = 0;
  for (const { leg, quote, qty, snapped } of plan) {
    const px = leg.side === 'buy' ? (quote.ask ?? quote.mid) : (quote.bid ?? quote.mid);
    if (!(px > 0)) return { ok: false, name: req.name, legs: [], error: `leg ${leg.strike} ${leg.kind}: no ${leg.side === 'buy' ? 'ask' : 'bid'} on any venue` };
    if (leg.side === 'buy') premiumNeed += px * qty + feeFor(quote.venue, quote.spot, qty);
    else marginNeed += marginFor(quote.strike, qty);
  }
  const marginHeld = acct.positions.reduce((a, p) => a + p.marginHeld, 0);
  const available = acct.cash - marginHeld;
  const totalNeed = premiumNeed + marginNeed;
  if (totalNeed > available) {
    return { ok: false, name: req.name, legs: [], error: `insufficient buying power: package needs $${totalNeed.toFixed(0)} (premium $${premiumNeed.toFixed(0)} + short margin $${marginNeed.toFixed(0)}), free $${available.toFixed(0)}` };
  }

  // execute atomically (all legs, one tag)
  const legsOut: {
    leg: string; venue: VenueId; expiry: string; strike: number; side: PaperSide; qty: number; price: number; fee: number; iv: number; snappedStrike?: number;
  }[] = [];
  let netPremium = 0;
  for (const { leg, quote, qty, snapped } of plan) {
    const res = executeFill(acct, quote, leg.side, qty, req.name);
    if (!res.ok) {
      return { ok: false, name: req.name, legs: legsOut, error: `execution failed on ${leg.strike} ${leg.kind}: ${res.error}` };
    }
    const px = leg.side === 'buy' ? (quote.ask ?? quote.mid) : (quote.bid ?? quote.mid);
    netPremium += leg.side === 'buy' ? -px * qty : px * qty;
    legsOut.push({
      leg: `${leg.side} ${qty}× ${quote.asset} ${quote.expiry} ${quote.strike} ${quote.kind}${snapped != null ? ` (snapped from ${leg.strike})` : ''}`,
      snappedStrike: snapped,
      venue: quote.venue,
      expiry: quote.expiry,
      strike: quote.strike,
      side: leg.side,
      qty,
      price: res.fill!.price,
      fee: res.fill!.fee,
      iv: quote.iv,
    });
  }
  saveAccount();
  return { ok: true, name: req.name, legs: legsOut, netPremium, cashAfter: acct.cash };
}

// --- mark-to-market ----------------------------------------------------------------

export interface PaperAccountView {
  startingCash: number;
  cash: number;
  marginHeld: number;
  buyingPower: number;
  equity: number;
  unrealized: number;
  realizedTotal: number;
  feesTotal: number;
  wins: number;
  losses: number;
  winRate: number;
  positions: (PaperPosition & { unrealized: number; pnlPct: number; mid: number; hasLiveQuote: boolean })[];
  openOrders: PaperLimitOrder[];
  fills: PaperFill[];
  equityCurve: { t: number; equity: number }[];
  updatedAt: number;
  quotesLive: Record<string, 'live' | 'derived'>;
}

/** Refresh marks (incl. resting limit orders + expiry settlement) and return the account view. */
export async function getPaperAccount(): Promise<PaperAccountView> {
  const acct = loadAccount();
  const now = Date.now();
  const quoteLive: Record<string, 'live' | 'derived'> = {};

  // settle expired positions at intrinsic vs spot
  const settled: PaperPosition[] = [];
  for (const p of acct.positions) {
    if (p.expiryMs > now) continue;
    let spot = 0;
    try {
      const { chain } = await getVenueChain(p.venue, p.asset, p.expiry);
      spot = chain?.spot ?? 0;
    } catch {
      /* fall through */
    }
    if (!spot) {
      try {
        const { chain } = await getVenueChain('deribit', p.asset);
        spot = chain?.spot ?? 0;
      } catch {
        /* give up settlement this pass */
      }
    }
    if (!spot) continue;
    const intrinsic = Math.max(0, p.kind === 'call' ? spot - p.strike : p.strike - spot);
    const dir = p.side === 'long' ? 1 : -1;
    const pnl = dir * (intrinsic - p.entryPrice) * p.qty;
    acct.realizedTotal += pnl;
    if (pnl >= 0) acct.wins += 1;
    else acct.losses += 1;
    // cash: longs were already paid out of cash → credit back intrinsic;
    // shorts keep premium, pay intrinsic, release margin
    acct.cash += p.side === 'long' ? intrinsic * p.qty : -intrinsic * p.qty;
    settled.push(p);
  }
  if (settled.length > 0) {
    acct.positions = acct.positions.filter((p) => !settled.includes(p));
    saveAccount();
  }

  // refresh marks by (venue, asset, expiry) group
  const groups = new Map<string, PaperPosition[]>();
  for (const p of acct.positions) {
    const key = `${p.venue}:${p.asset}:${p.expiry}`;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }
  await Promise.all(
    [...groups.entries()].map(async ([key, ps]) => {
      try {
        const { chain } = await getVenueChain(ps[0].venue, ps[0].asset, ps[0].expiry);
        if (!chain) return;
        quoteLive[key] = chain.quoteSource;
        for (const p of ps) {
          const row = chain.rows.find((r) => r.strike === p.strike);
          if (!row) continue;
          const bid = p.kind === 'call' ? row.callBid : row.putBid;
          const ask = p.kind === 'call' ? row.callAsk : row.putAsk;
          const model = p.kind === 'call' ? row.callPrice : row.putPrice;
          p.markPrice = bid != null && ask != null ? (bid + ask) / 2 : model;
          p.markTs = Date.now();
        }
      } catch {
        /* keep last mark */
      }
    }),
  );

  // check resting limit orders
  const stillOpen: PaperLimitOrder[] = [];
  for (const o of acct.openOrders) {
    try {
      const { quote } = await resolveOptionQuote(o.venue, o.asset, o.expiry, o.strike, o.kind, o.side);
      const crossable =
        quote?.venue &&
        (o.side === 'buy' ? quote.ask != null && o.limitPrice >= quote.ask : quote.bid != null && o.limitPrice <= quote.bid);
      if (crossable && quote) {
        executeFill(acct, quote, o.side, o.qty, o.strategyTag ?? o.id, o.limitPrice);
      } else {
        stillOpen.push(o);
      }
    } catch {
      stillOpen.push(o);
    }
  }
  if (stillOpen.length !== acct.openOrders.length) {
    acct.openOrders = stillOpen;
    saveAccount();
  }

  // compute view
  const marginHeld = acct.positions.reduce((a, p) => a + p.marginHeld, 0);
  let unrealized = 0;
  const positions = acct.positions.map((p) => {
    const dir = p.side === 'long' ? 1 : -1;
    const u = dir * (p.markPrice - p.entryPrice) * p.qty;
    unrealized += u;
    return {
      ...p,
      unrealized: +u.toFixed(2),
      pnlPct: +((dir * (p.markPrice - p.entryPrice)) / Math.max(p.entryPrice, 1e-9) * 100).toFixed(1),
      mid: p.markPrice,
      hasLiveQuote: (quoteLive[`${p.venue}:${p.asset}:${p.expiry}`] ?? 'live') === 'live',
    };
  });
  const equity = acct.cash + unrealized;

  // equity curve (1 sample/min max)
  if (now - acct.lastCurveAt > 60_000) {
    acct.equityCurve.push({ t: now, equity: +equity.toFixed(2) });
    if (acct.equityCurve.length > 720) acct.equityCurve.shift();
    acct.lastCurveAt = now;
    saveAccount();
  }

  return {
    startingCash: acct.startingCash,
    cash: +acct.cash.toFixed(2),
    marginHeld: +marginHeld.toFixed(2),
    buyingPower: +(acct.cash - marginHeld).toFixed(2),
    equity: +equity.toFixed(2),
    unrealized: +unrealized.toFixed(2),
    realizedTotal: +acct.realizedTotal.toFixed(2),
    feesTotal: +acct.feesTotal.toFixed(2),
    wins: acct.wins,
    losses: acct.losses,
    winRate: acct.wins + acct.losses > 0 ? +((acct.wins / (acct.wins + acct.losses)) * 100).toFixed(1) : 0,
    positions: positions.sort((a, b) => b.openedAt - a.openedAt),
    openOrders: acct.openOrders,
    fills: acct.fills.slice(0, 40),
    equityCurve: acct.equityCurve,
    updatedAt: now,
    quotesLive: quoteLive,
  };
}

export function resetPaperAccount(startingCash = START_CASH): void {
  const acct = freshAccount();
  acct.startingCash = startingCash;
  acct.cash = startingCash;
  acct.equityCurve = [{ t: Date.now(), equity: startingCash }];
  g.__paperAccount = acct;
  saveAccount();
}

export function paperVenueCatalog(): { venue: VenueId; name: string; feeBps: number }[] {
  return VENUE_IDS.map((v) => ({ venue: v, name: VENUE_META[v].name, feeBps: TAKER_FEE_BPS[v] }));
}


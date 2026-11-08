// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · tape — the live options tape.
//
// Polls Deribit's cross-instrument option trades (keyless), dedupes by venue
// trade id, persists every print to SQLite (survives restarts, true history)
// and computes window aggregates: premium totals, buy/sell imbalance, put/call
// splits, whale prints, premium by strike and by expiry. An SSE subscriber
// list lets /api/quant/tape/stream push prints to the UI the moment they land.
// ─────────────────────────────────────────────────────────────────────────────

import { optionTrades, parseOptionName } from './deribit';
import { db } from '@/lib/db';
import type { TapeAggregates, TapePrint } from './types';

const TAPE_SYMBOLS = ['BTC', 'ETH'] as const;
const POLL_MS = 5000;
const WHALE_USD = 100_000;

interface TapeState {
  symbol: string;
  running: boolean;
  lastPoll: number;
  prints: TapePrint[]; // newest first, in-memory ring (48h)
  seen: Set<string>; // recent trade ids (dedupe)
  subs: Set<(p: TapePrint[]) => void>;
  timer: ReturnType<typeof setInterval> | null;
  backfilled: boolean;
}

const g = globalThis as unknown as { __volquantTape?: Map<string, TapeState> };
const states: Map<string, TapeState> = g.__volquantTape ?? new Map();
g.__volquantTape = states;

function prune(state: TapeState) {
  const cutoff = Date.now() - 48 * 3600_000;
  while (state.prints.length && state.prints[state.prints.length - 1].ts < cutoff) state.prints.pop();
  if (state.seen.size > 200_000) state.seen.clear();
}

async function persistPrints(symbol: string, prints: TapePrint[]) {
  if (!prints.length) return;
  const data = prints.map((p) => ({
    id: `${p.venue}:${p.id}`,
    symbol,
    ts: new Date(p.ts),
    instrument: p.instrument,
    strike: p.strike,
    expiry: p.expiry,
    isCall: p.isCall,
    side: p.side,
    premiumUsd: p.premiumUsd,
    amount: p.amount,
    iv: p.ivPct,
    indexPrice: p.indexPrice,
    venue: p.venue,
  }));
  try {
    // fast path — SQLite has no skipDuplicates, so a PK clash falls back per-row
    await db.optionTrade.createMany({ data });
  } catch {
    try {
      await Promise.all(
        data.map((d) =>
          db.optionTrade
            .create({ data: d })
            .catch(() => undefined),
        ),
      );
    } catch (e) {
      console.error('[volquant/tape] persist failed:', e instanceof Error ? e.message : e);
    }
  }
}

function toPrint(symbol: string, t: { trade_id: string; instrument_name: string; timestamp: number; iv?: number; price: number; direction: 'buy' | 'sell'; index_price: number; amount: number }): TapePrint | null {
  const p = parseOptionName(t.instrument_name);
  if (!p) return null;
  return {
    id: t.trade_id,
    ts: t.timestamp,
    symbol,
    instrument: t.instrument_name,
    strike: p.strike,
    expiry: p.expiry,
    isCall: p.isCall,
    side: t.direction === 'buy' ? 'buy' : 'sell',
    premiumUsd: t.price * t.index_price * t.amount,
    amount: t.amount,
    ivPct: t.iv ?? null,
    indexPrice: t.index_price,
    venue: 'deribit',
  };
}

async function pollOnce(state: TapeState) {
  try {
    const { trades } = (await optionTrades(state.symbol, 500)).v;
    const fresh: TapePrint[] = [];
    for (const t of trades) {
      if (state.seen.has(t.trade_id)) continue;
      state.seen.add(t.trade_id);
      const p = toPrint(state.symbol, t);
      if (p) fresh.push(p);
    }
    if (fresh.length) {
      fresh.sort((a, b) => b.ts - a.ts);
      state.prints = [...fresh, ...state.prints];
      prune(state);
      void persistPrints(state.symbol, fresh);
      for (const cb of state.subs) {
        try {
          cb(fresh);
        } catch {
          /* subscriber died */
        }
      }
    }
    state.lastPoll = Date.now();
  } catch (e) {
    console.error('[volquant/tape] poll failed:', e instanceof Error ? e.message : e);
  }
}

/** One-shot history backfill from the venue (oldest → newest), persisted. */
async function backfill(state: TapeState) {
  try {
    const cutoff = Date.now() - 48 * 3600_000;
    let endTs: number | undefined = Date.now();
    const collected: TapePrint[] = [];
    for (let page = 0; page < 8; page++) {
      const { trades } = (await optionTrades(state.symbol, 1000, endTs)).v;
      if (!trades.length) break;
      for (const t of trades) {
        if (state.seen.has(t.trade_id)) continue;
        const p = toPrint(state.symbol, t);
        if (p) {
          state.seen.add(t.trade_id);
          collected.push(p);
        }
      }
      const oldest = Math.min(...trades.map((t) => t.timestamp));
      if (oldest <= cutoff) break;
      endTs = oldest - 1;
    }
    collected.sort((a, b) => b.ts - a.ts);
    if (collected.length) {
      state.prints = [...collected, ...state.prints];
      prune(state);
      void persistPrints(state.symbol, collected);
    }
    state.backfilled = true;
    console.log(`[volquant/tape] ${state.symbol} backfill: ${collected.length} prints`);
  } catch (e) {
    console.error('[volquant/tape] backfill failed:', e instanceof Error ? e.message : e);
  }
}

/** Ensure the poller for a symbol is running (idempotent, hot-reload safe). */
export function ensureTape(symbol: string): TapeState {
  let state = states.get(symbol);
  if (state && state.running) return state;
  state = {
    symbol,
    running: true,
    lastPoll: 0,
    prints: state?.prints ?? [],
    seen: state?.seen ?? new Set<string>(),
    subs: state?.subs ?? new Set(),
    timer: null,
    backfilled: state?.backfilled ?? false,
  };
  states.set(symbol, state);
  void backfill(state);
  void pollOnce(state);
  state.timer = setInterval(() => void pollOnce(state), POLL_MS);
  return state;
}

/** Recent prints (newest first), optionally filtered. */
export function tapePrints(symbol: string, opts: { hours?: number; minPremiumUsd?: number; side?: 'buy' | 'sell'; kind?: 'call' | 'put'; limit?: number } = {}): TapePrint[] {
  const state = ensureTape(symbol);
  const cutoff = Date.now() - (opts.hours ?? 24) * 3600_000;
  return state.prints
    .filter(
      (p) =>
        p.ts >= cutoff &&
        p.premiumUsd >= (opts.minPremiumUsd ?? 0) &&
        (!opts.side || p.side === opts.side) &&
        (!opts.kind || (opts.kind === 'call') === p.isCall),
    )
    .slice(0, opts.limit ?? 500);
}

/** Window aggregates over the in-memory tape (+ persisted tail). */
export async function tapeAggregates(symbol: string, hours = 24, whaleUsd = WHALE_USD): Promise<TapeAggregates> {
  const state = ensureTape(symbol);
  const cutoff = Date.now() - hours * 3600_000;
  let prints = state.prints.filter((p) => p.ts >= cutoff);

  // if the in-memory window is shorter than requested, extend from SQLite
  const oldestMem = prints.length ? prints[prints.length - 1].ts : 0;
  if (oldestMem > cutoff + 60_000) {
    try {
      const rowsDb = await db.optionTrade.findMany({
        where: { symbol, ts: { gte: new Date(cutoff), lt: new Date(oldestMem) } },
        orderBy: { ts: 'desc' },
        take: 5000,
      });
      const extra: TapePrint[] = rowsDb.map((r) => ({
        id: r.id.split(':')[1] ?? r.id,
        ts: r.ts.getTime(),
        symbol: r.symbol,
        instrument: r.instrument,
        strike: r.strike,
        expiry: r.expiry,
        isCall: r.isCall,
        side: r.side as 'buy' | 'sell',
        premiumUsd: r.premiumUsd,
        amount: r.amount,
        ivPct: r.iv,
        indexPrice: r.indexPrice,
        venue: r.venue,
      }));
      prints = [...prints, ...extra].sort((a, b) => b.ts - a.ts);
    } catch {
      /* db unavailable — in-memory only */
    }
  }

  let premiumUsd = 0,
    buyPremiumUsd = 0,
    sellPremiumUsd = 0,
    callPremiumUsd = 0,
    putPremiumUsd = 0,
    callBuyUsd = 0,
    putBuyUsd = 0;
  const strikeMap = new Map<number, { buyUsd: number; sellUsd: number; premiumUsd: number }>();
  const expiryMap = new Map<string, { premiumUsd: number; prints: number }>();
  for (const p of prints) {
    premiumUsd += p.premiumUsd;
    if (p.side === 'buy') buyPremiumUsd += p.premiumUsd;
    else sellPremiumUsd += p.premiumUsd;
    if (p.isCall) {
      callPremiumUsd += p.premiumUsd;
      if (p.side === 'buy') callBuyUsd += p.premiumUsd;
    } else {
      putPremiumUsd += p.premiumUsd;
      if (p.side === 'buy') putBuyUsd += p.premiumUsd;
    }
    const sm = strikeMap.get(p.strike) ?? { buyUsd: 0, sellUsd: 0, premiumUsd: 0 };
    if (p.side === 'buy') sm.buyUsd += p.premiumUsd;
    else sm.sellUsd += p.premiumUsd;
    sm.premiumUsd += p.premiumUsd;
    strikeMap.set(p.strike, sm);
    const em = expiryMap.get(p.expiry) ?? { premiumUsd: 0, prints: 0 };
    em.premiumUsd += p.premiumUsd;
    em.prints += 1;
    expiryMap.set(p.expiry, em);
  }
  const whales = prints.filter((p) => p.premiumUsd >= whaleUsd).slice(0, 25);
  const byStrike = [...strikeMap.entries()]
    .map(([strike, v]) => ({ strike, ...v, netUsd: v.buyUsd - v.sellUsd }))
    .sort((a, b) => b.premiumUsd - a.premiumUsd)
    .slice(0, 40);
  const byExpiry = [...expiryMap.entries()].map(([expiry, v]) => ({ expiry, ...v })).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));

  return {
    windowHours: hours,
    prints: prints.length,
    premiumUsd,
    buyPremiumUsd,
    sellPremiumUsd,
    callPremiumUsd,
    putPremiumUsd,
    callBuyUsd,
    putBuyUsd,
    imbalance: premiumUsd > 0 ? (buyPremiumUsd - sellPremiumUsd) / premiumUsd : 0,
    whaleCount: whales.length,
    whales,
    byStrike,
    byExpiry,
  };
}

/** Subscribe to live prints (SSE backbone). Returns unsubscribe. */
export function subscribeTape(symbol: string, cb: (prints: TapePrint[]) => void): () => void {
  const state = ensureTape(symbol);
  state.subs.add(cb);
  return () => state.subs.delete(cb);
}

/** Flow by strike: cumulative aggressor premium on still-open contracts. */
export function flowByStrike(symbol: string, hours = 168, strikeFilter?: number) {
  const state = ensureTape(symbol);
  const cutoff = Date.now() - hours * 3600_000;
  const m = new Map<number, { callBuy: number; callSell: number; putBuy: number; putSell: number }>();
  for (const p of state.prints) {
    if (p.ts < cutoff) continue;
    if (strikeFilter && p.strike !== strikeFilter) continue;
    const e = m.get(p.strike) ?? { callBuy: 0, callSell: 0, putBuy: 0, putSell: 0 };
    if (p.isCall) {
      if (p.side === 'buy') e.callBuy += p.premiumUsd;
      else e.callSell += p.premiumUsd;
    } else {
      if (p.side === 'buy') e.putBuy += p.premiumUsd;
      else e.putSell += p.premiumUsd;
    }
    m.set(p.strike, e);
  }
  return [...m.entries()]
    .map(([strike, v]) => ({ strike, ...v, netUsd: v.callBuy + v.putBuy - v.callSell - v.putSell }))
    .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd));
}

export function tapeInfo() {
  return TAPE_SYMBOLS.map((s) => {
    const st = states.get(s);
    return {
      symbol: s,
      running: Boolean(st?.running),
      backfilled: Boolean(st?.backfilled),
      printsInMemory: st?.prints.length ?? 0,
      lastPollTs: st?.lastPoll ?? null,
      pollMs: POLL_MS,
    };
  });
}

'use client';

// ─────────────────────────────────────────────────────────────────────────────
// paper-store — v1.9 PAPER DESK account ($100,000 paper): order-ticket fills,
// strategy package deploys, positions with live marks, equity/cash/fees.
// Session-scope, in-memory — v1.9 semantics (cleared on reload).
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { UnderlyingId } from '@/lib/types';
import { blackScholes } from '@/lib/pricing';

export interface PaperFill {
  id: string;
  ts: number;
  action: 'BUY' | 'SELL';
  instrument: string;
  kind: 'call' | 'put' | 'perp_option' | 'perp' | 'spot';
  qty: number;
  price: number;
  fee: number;
  venue: string;
  strategyId: string | null;
  strategyName: string | null;
  strike: number | null;
  dte: number | null;
  underlying: UnderlyingId;
  /** entry-side greeks snapshot for the position rollup */
  delta: number;
  vega: number;
  entrySpot: number;
  /** entry IV — used to live-mark the position */
  iv: number;
}

export interface PaperPosition extends PaperFill {
  mark: number;
  uPnl: number;
}

interface PaperState {
  cash: number;
  fills: PaperFill[];
  fees: number;
  realized: number;
  fillsAtRealBbo: boolean;
  wins: number;
  losses: number;
  addFill: (f: Omit<PaperFill, 'id' | 'ts'>) => void;
  closePosition: (id: string, markPrice: number) => void;
  reset: () => void;
  setFillsAtRealBbo: (b: boolean) => void;
}

const fid = () => `f_${Math.random().toString(36).slice(2, 9)}`;
const START_CASH = 100_000;

export const usePaper = create<PaperState>()((set, get) => ({
  cash: START_CASH,
  fills: [],
  fees: 0,
  realized: 0,
  fillsAtRealBbo: true,
  wins: 0,
  losses: 0,

  addFill: (f) =>
    set((s) => {
      const fill: PaperFill = { ...f, id: fid(), ts: Date.now() };
      const debit = (f.action === 'BUY' ? -1 : 1) * f.price * f.qty + f.fee;
      return {
        fills: [fill, ...s.fills],
        cash: s.cash + debit,
        fees: s.fees + f.fee,
      };
    }),

  closePosition: (id, markPrice) =>
    set((s) => {
      const fill = s.fills.find((f) => f.id === id);
      if (!fill) return s;
      const sign = fill.action === 'BUY' ? 1 : -1;
      const pnl = sign * (markPrice - fill.price) * fill.qty;
      return {
        fills: s.fills.filter((f) => f.id !== id),
        cash: s.cash + pnl,
        realized: s.realized + pnl,
        wins: pnl > 0 ? s.wins + 1 : s.wins,
        losses: pnl <= 0 ? s.losses + 1 : s.losses,
      };
    }),

  reset: () => set({ cash: START_CASH, fills: [], fees: 0, realized: 0, wins: 0, losses: 0 }),
  setFillsAtRealBbo: (b) => set({ fillsAtRealBbo: b }),
}));

/** Roll up open fills into live-marked positions. */
export function rollupPositions(fills: PaperFill[], spotOf: (u: UnderlyingId) => number): PaperPosition[] {
  // group by instrument + strategy
  const groups = new Map<string, PaperFill[]>();
  for (const f of fills) {
    const key = `${f.instrument}|${f.venue}|${f.strategyId ?? 'single'}`;
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }
  const out: PaperPosition[] = [];
  for (const arr of groups.values()) {
    const first = arr[0];
    let qty = 0, cost = 0;
    for (const f of arr) {
      const sign = f.action === 'BUY' ? 1 : -1;
      qty += sign * f.qty;
      cost += sign * f.qty * f.price;
    }
    if (Math.abs(qty) < 1e-9) continue;
    const spot = spotOf(first.underlying);
    // mark: re-price the option at current spot with entry IV
    const mark = first.strike !== null
      ? markOption(first, spot)
      : spot;
    const uPnl = (mark - cost / qty) * qty;
    out.push({ ...first, qty, mark, uPnl });
  }
  return out;
}

function markOption(f: PaperFill, spot: number): number {
  if (f.strike === null) return spot;
  const elapsedDays = (Date.now() - f.ts) / 86400000;
  const dte = Math.max((f.dte ?? 1) - elapsedDays, 0.25);
  const kind: 'call' | 'put' =
    f.kind === 'perp_option'
      ? (f.strike >= (f.entrySpot ?? spot) ? 'call' : 'put')
      : (f.kind === 'put' ? 'put' : 'call');
  if (f.kind === 'perp_option') {
    // everlasting: BS at a rolling 30d window, pulled toward intrinsic by funding
    const q = blackScholes(kind, spot, f.strike, Math.max(f.iv, 0.05), 30);
    const intr = kind === 'call' ? Math.max(0, spot - f.strike) : Math.max(0, f.strike - spot);
    return intr + (q.price - intr) * 0.85;
  }
  return blackScholes(kind, spot, f.strike, Math.max(f.iv, 0.05), dte).price;
}

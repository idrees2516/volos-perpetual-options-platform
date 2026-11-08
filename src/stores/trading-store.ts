'use client';

// ─────────────────────────────────────────────────────────────────────────────
// trading-store — v1.9 TRADING view demo account ($1,000,000 demo): orders,
// simulated fills against the engine book, tape prints, perps positions,
// fees and greeks rollup. Session-scope, in-memory.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';

export interface TapeRow {
  id: string;
  ts: number;
  symbol: string;
  price: number;
  qty: number;
  taker: 'buy' | 'sell';
}

export interface TradingPosition {
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entry: number;
}

export interface TradingOrder {
  id: string;
  ts: number;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  price: number | null;
  qty: number;
  status: 'filled' | 'rejected';
  note?: string;
}

interface TradingState {
  balance: number;
  feesPaid: number;
  positions: TradingPosition[];
  tape: TapeRow[];
  orders: TradingOrder[];
  pushTape: (rows: TapeRow[]) => void;
  placeOrder: (o: {
    symbol: string; side: 'buy' | 'sell'; type: string; price: number | null; qty: number;
    fillPrice: number; fee: number; note?: string;
  }) => void;
  reset: () => void;
}

const oid = () => `o_${Math.random().toString(36).slice(2, 9)}`;

export const useTrading = create<TradingState>()((set) => ({
  balance: 1_000_000,
  feesPaid: 0,
  positions: [],
  tape: [],
  orders: [],

  pushTape: (rows) => set((s) => ({ tape: [...rows, ...s.tape].slice(0, 60) })),

  placeOrder: ({ symbol, side, type, price, qty, fillPrice, fee, note }) =>
    set((s) => {
      const pos = s.positions.find((p) => p.symbol === symbol);
      let positions = s.positions;
      if (pos) {
        const signed = (side === 'buy' ? 1 : -1) * qty;
        const newQty = pos.qty + signed;
        if (Math.abs(newQty) < 1e-9) {
          positions = s.positions.filter((p) => p.symbol !== symbol);
        } else {
          const sameSide = Math.sign(newQty) === Math.sign(pos.qty) && Math.abs(newQty) > Math.abs(pos.qty);
          const entry = sameSide
            ? (pos.entry * pos.qty + fillPrice * signed) / newQty
            : fillPrice;
          positions = s.positions.map((p) =>
            p.symbol === symbol ? { ...p, qty: newQty, entry, side: newQty > 0 ? 'long' : 'short' } : p,
          );
        }
      } else {
        positions = [
          ...s.positions,
          { symbol, side: side === 'buy' ? 'long' : 'short', qty: side === 'buy' ? qty : -qty, entry: fillPrice },
        ];
      }
      const order: TradingOrder = {
        id: oid(), ts: Date.now(), symbol, side, type, price, qty, status: 'filled', note,
      };
      return {
        positions,
        feesPaid: s.feesPaid + fee,
        orders: [order, ...s.orders].slice(0, 40),
        tape: [
          { id: oid(), ts: Date.now(), symbol, price: fillPrice, qty, taker: side },
          ...s.tape,
        ].slice(0, 60),
      };
    }),

  reset: () => set({ balance: 1_000_000, feesPaid: 0, positions: [], tape: [], orders: [] }),
}));

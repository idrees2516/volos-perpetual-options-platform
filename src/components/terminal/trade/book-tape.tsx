'use client';

// L2 order book (click a level to load it into the ticket) + live trade tape.

import React, { useEffect, useState } from 'react';
import { engine, type BookResponse, type EngineTrade } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { BookOpen, Activity } from 'lucide-react';

export function BookTape({ instrument, tape }: { instrument: string; tape: EngineTrade[] }) {
  const [book, setBook] = useState<BookResponse | null>(null);
  const [l3open, setL3Open] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      engine
        .book(instrument, 12)
        .then((b) => alive && setBook(b))
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [instrument]);

  const bids = book?.l2.bids ?? [];
  const asks = book?.l2.asks ?? [];
  const maxQty = Math.max(1, ...bids.map((b) => b.qty), ...asks.map((a) => a.qty));
  const instrumentTape = tape.filter((t) => t.instrument === instrument).slice(0, 30);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
      {/* Book */}
      <div className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            <BookOpen className="h-3.5 w-3.5 text-teal-400" /> Order Book · L2
          </p>
          <button
            onClick={() => setL3Open((v) => !v)}
            className={`rounded px-1.5 py-0.5 text-[9px] font-medium transition ${
              l3open ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/40' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            L3 {l3open ? 'on' : 'off'}
          </button>
        </div>

        <div className="grid grid-cols-3 px-1 pb-1 text-[8px] uppercase tracking-wider text-zinc-600">
          <span>Price</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Orders</span>
        </div>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {/* asks (reversed so best ask is at the bottom, near mid) */}
          {[...asks].reverse().map((a, i) => (
            <BookRow key={`a-${i}`} price={a.price} qty={a.qty} orders={a.orders} side="ask" maxQty={maxQty} />
          ))}

          {/* mid */}
          <div className="my-1 flex items-center justify-between rounded bg-zinc-800/60 px-2 py-1 font-mono text-[10px]">
            <span className="text-zinc-400">mid</span>
            <span className="font-semibold text-zinc-100">
              {book ? fmtNum((bids[0]?.price ?? 0) && asks[0]?.price ? (bids[0].price + asks[0].price) / 2 : book.mark, 2) : '—'}
            </span>
            <span className="text-zinc-500">
              {bids[0] && asks[0] ? `spread ${fmtNum(asks[0].price - bids[0].price, 2)}` : ''}
            </span>
          </div>

          {bids.map((b, i) => (
            <BookRow key={`b-${i}`} price={b.price} qty={b.qty} orders={b.orders} side="bid" maxQty={maxQty} />
          ))}
        </div>

        {l3open && (
          <div className="mt-1.5 max-h-32 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-1.5">
            <p className="mb-1 text-[8px] uppercase tracking-wider text-zinc-600">L3 — individual orders</p>
            {(book?.l3 ?? []).slice(0, 14).map((o) => (
              <div key={o.orderId} className="flex items-center justify-between font-mono text-[9px]">
                <span className="text-zinc-600">#{o.orderId}</span>
                <span className={o.side === 'buy' ? 'text-emerald-400/80' : 'text-rose-400/80'}>
                  {o.side} {fmtNum(o.qty, 2)}
                </span>
                <span className="text-zinc-400">@ {fmtNum(o.price, 2)}</span>
              </div>
            ))}
            {(book?.l3 ?? []).length === 0 && <p className="text-[9px] text-zinc-600">no resting orders</p>}
          </div>
        )}
      </div>

      {/* Tape */}
      <div className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
        <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
          <Activity className="h-3.5 w-3.5 text-amber-400" /> Trade Tape
          <span className="ml-auto font-mono text-[9px] normal-case text-zinc-600">{instrument}</span>
        </p>
        <div className="grid grid-cols-4 px-1 pb-1 text-[8px] uppercase tracking-wider text-zinc-600">
          <span>Time</span>
          <span className="text-right">Price</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Taker</span>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {instrumentTape.map((t) => (
            <div key={t.id} className="grid grid-cols-4 rounded px-1 py-0.5 font-mono text-[9px] tabular-nums odd:bg-zinc-900/50">
              <span className="text-zinc-600">{new Date(t.tsMs).toLocaleTimeString([], { hour12: false })}</span>
              <span className={`text-right ${t.takerSide === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>
                {fmtNum(t.price, 2)}
              </span>
              <span className="text-right text-zinc-300">{fmtNum(t.qty, 2)}</span>
              <span className={`text-right ${t.takerSide === 'buy' ? 'text-emerald-400/70' : 'text-rose-400/70'}`}>
                {t.takerSide === 'buy' ? '▲' : '▼'}
              </span>
            </div>
          ))}
          {instrumentTape.length === 0 && (
            <p className="p-3 text-center text-[10px] text-zinc-600">No trades yet on this instrument.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function BookRow({
  price,
  qty,
  orders,
  side,
  maxQty,
}: {
  price: number;
  qty: number;
  orders: number;
  side: 'bid' | 'ask';
  maxQty: number;
}) {
  const pct = Math.min(100, (qty / maxQty) * 100);
  return (
    <div className="relative grid cursor-pointer grid-cols-3 rounded px-2 py-0.5 font-mono text-[10px] tabular-nums transition hover:bg-zinc-800/40">
      <div
        className={`absolute inset-y-0 right-0 rounded ${side === 'bid' ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`}
        style={{ width: `${pct}%` }}
      />
      <span className={`relative ${side === 'bid' ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtNum(price, 2)}</span>
      <span className="relative text-right text-zinc-300">{fmtNum(qty, 2)}</span>
      <span className="relative text-right text-zinc-600">{orders}</span>
    </div>
  );
}

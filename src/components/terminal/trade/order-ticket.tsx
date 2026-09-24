'use client';

// Order ticket — every CLOB order kind the engine supports:
// limit, market, post-only, IOC, FOK, stop-market, stop-limit + STP policy.

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { engine, type L1Dto, type PlaceOrderReq } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { ArrowDownToLine, ArrowUpFromLine, Zap } from 'lucide-react';

type Kind = PlaceOrderReq['kind'];

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'limit', label: 'Limit', hint: 'Rests on the book; may partially fill' },
  { id: 'market', label: 'Market', hint: 'Immediate; collar-protected' },
  { id: 'post_only', label: 'Post-Only', hint: 'Rejected if it would cross (earns rebate)' },
  { id: 'ioc', label: 'IOC', hint: 'Fill what is available, cancel the rest' },
  { id: 'fok', label: 'FOK', hint: 'Fill entirely or not at all' },
  { id: 'stop_market', label: 'Stop-Mkt', hint: 'Parked until trigger trades' },
  { id: 'stop_limit', label: 'Stop-Lmt', hint: 'Parked until trigger, then limit' },
];

const STPS: { id: NonNullable<PlaceOrderReq['stp']>; label: string }[] = [
  { id: 'cancel_newest', label: 'Cancel Newest' },
  { id: 'cancel_oldest', label: 'Cancel Oldest' },
  { id: 'decrement', label: 'Decrement' },
];

interface Props {
  instrument: string;
  l1?: L1Dto;
  onPlaced: () => void;
  notify: (kind: 'ok' | 'err', text: string) => void;
}

export function OrderTicket({ instrument, l1, onPlaced, notify }: Props) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [kind, setKind] = useState<Kind>('limit');
  const [price, setPrice] = useState<string>('');
  const [trigger, setTrigger] = useState<string>('');
  const [qty, setQty] = useState<string>('0.5');
  const [stp, setStp] = useState<NonNullable<PlaceOrderReq['stp']>>('cancel_newest');
  const [busy, setBusy] = useState(false);

  const needsPrice = kind === 'limit' || kind === 'post_only' || kind === 'ioc' || kind === 'fok' || kind === 'stop_limit';
  const needsTrigger = kind === 'stop_market' || kind === 'stop_limit';

  const setFromBook = (p: number) => setPrice(String(p));
  const tickRefine = (dir: 1 | -1) => {
    const cur = parseFloat(price) || l1?.mark || 0;
    const step = Math.max((l1?.mark ?? 1) * 0.0005, 0.01);
    setPrice((cur + dir * step).toFixed(2));
  };

  const submit = () => {
    const q = parseFloat(qty);
    if (!q || q <= 0) return notify('err', 'Quantity must be positive');
    if (needsPrice) {
      const p = parseFloat(price);
      if (!p || p <= 0) return notify('err', 'This order kind needs a positive price');
    }
    if (needsTrigger && !(parseFloat(trigger) > 0)) {
      return notify('err', 'Stop orders need a positive trigger price');
    }
    setBusy(true);
    engine
      .placeOrder({
        instrument,
        side,
        kind,
        price: needsPrice ? parseFloat(price) : undefined,
        trigger: needsTrigger ? parseFloat(trigger) : undefined,
        qty: q,
        stp,
      })
      .then((o) => {
        notify(
          'ok',
          `${side.toUpperCase()} ${q} ${instrument} → ${o.status.replace('_', ' ')}${o.filledLots > 0 ? ` (filled ${o.filledLots} lots @ ${fmtNum(o.avgFillPrice, 2)})` : ''}`,
        );
        onPlaced();
      })
      .catch((e) => notify('err', String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Order Ticket</p>
        <p className="font-mono text-[10px] text-teal-300">{instrument}</p>
      </div>

      {/* Side */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => setSide('buy')}
          className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-bold uppercase tracking-wide transition ${
            side === 'buy'
              ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/50'
              : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <ArrowUpFromLine className="h-3.5 w-3.5" /> Buy / Bid
        </button>
        <button
          onClick={() => setSide('sell')}
          className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-bold uppercase tracking-wide transition ${
            side === 'sell'
              ? 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/50'
              : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" /> Sell / Ask
        </button>
      </div>

      {/* Kind */}
      <div className="mt-2 flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button
            key={k.id}
            title={k.hint}
            onClick={() => setKind(k.id)}
            className={`rounded px-2 py-1 text-[9px] font-semibold uppercase transition ${
              kind === k.id
                ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/40'
                : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Inputs */}
      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <Field label={side === 'buy' ? 'Bid price' : 'Ask price'} disabled={!needsPrice}>
          <div className="flex items-center">
            <button
              disabled={!needsPrice}
              onClick={() => tickRefine(-1)}
              className="px-1 text-zinc-600 hover:text-zinc-300 disabled:opacity-30"
            >
              −
            </button>
            <input
              disabled={!needsPrice}
              type="number"
              step="any"
              value={needsPrice ? price : ''}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={l1 ? fmtNum(side === 'buy' ? (l1.bid ?? l1.mark) : (l1.ask ?? l1.mark), 2) : '0.00'}
              className="w-full bg-transparent text-right font-mono text-xs text-zinc-100 outline-none disabled:text-zinc-600"
            />
            <button
              disabled={!needsPrice}
              onClick={() => tickRefine(1)}
              className="px-1 text-zinc-600 hover:text-zinc-300 disabled:opacity-30"
            >
              +
            </button>
          </div>
        </Field>
        <Field label="Quantity">
          <input
            type="number"
            step="any"
            min={0}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="w-full bg-transparent text-right font-mono text-xs text-zinc-100 outline-none"
          />
        </Field>
        <Field label="Trigger" disabled={!needsTrigger}>
          <input
            disabled={!needsTrigger}
            type="number"
            step="any"
            value={needsTrigger ? trigger : ''}
            onChange={(e) => setTrigger(e.target.value)}
            placeholder="stop price"
            className="w-full bg-transparent text-right font-mono text-xs text-zinc-100 outline-none disabled:text-zinc-600"
          />
        </Field>
        <Field label="Self-trade prevention">
          <select
            value={stp}
            onChange={(e) => setStp(e.target.value as NonNullable<PlaceOrderReq['stp']>)}
            className="w-full cursor-pointer bg-transparent text-right font-mono text-[10px] text-zinc-300 outline-none [&>option]:bg-zinc-950"
          >
            {STPS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* Quick price helpers */}
      <div className="mt-2 flex items-center gap-1.5">
        <span className="text-[9px] uppercase tracking-wide text-zinc-600">Book:</span>
        {l1?.bid !== undefined && (
          <button onClick={() => setFromBook(l1.bid!)} className="rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[9px] text-emerald-400 hover:bg-zinc-800">
            bid {fmtNum(l1.bid, 2)}
          </button>
        )}
        {l1?.ask !== undefined && (
          <button onClick={() => setFromBook(l1.ask!)} className="rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[9px] text-rose-400 hover:bg-zinc-800">
            ask {fmtNum(l1.ask, 2)}
          </button>
        )}
        <button onClick={() => setFromBook(l1?.mark ?? 0)} className="rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 hover:bg-zinc-800">
          mark {fmtNum(l1?.mark ?? 0, 2)}
        </button>
        <span className="ml-auto font-mono text-[9px] text-zinc-600">
          theo {fmtNum(l1?.theo ?? 0, 2)} · last {l1?.last !== undefined ? fmtNum(l1.last, 2) : '—'}
        </span>
      </div>

      <Button
        onClick={submit}
        disabled={busy}
        className={`mt-2.5 h-9 w-full text-xs font-bold uppercase tracking-wide ${
          side === 'buy'
            ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
            : 'bg-rose-500 text-zinc-950 hover:bg-rose-400'
        }`}
      >
        <Zap className="mr-1.5 h-3.5 w-3.5" />
        {busy ? 'Submitting…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${kind.replace('_', ' ')}`}
      </Button>
    </div>
  );
}

function Field({ label, disabled, children }: { label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <label className={`rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-[8px] uppercase tracking-wide text-zinc-500">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

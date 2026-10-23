'use client';

// Trading view — the CLOB + RFQ execution surface for the Rust engine.
// Layout: account bar / instrument list / order ticket + book + tape /
// RFQ desk + venue router / orders + positions + risk tabs.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { engine, openTradingStream, type EngineEvent, type EngineOrder, type EngineTrade, type L1Dto, type TradingState } from '@/lib/api';
import { fmtNum, fmtUsd } from '@/lib/format';
import { OrderTicket } from './trade/order-ticket';
import { BookTape } from './trade/book-tape';
import { OrdersPositions } from './trade/orders-positions';
import { RfqPanel } from './trade/rfq-panel';
import { VenuePanel } from './trade/venue-panel';
import { AlertTriangle, Wifi, WifiOff, Wallet, Shield, Sigma } from 'lucide-react';

interface TradeViewProps {
  onOpenBuilder: () => void;
}

export function TradeView({ onOpenBuilder }: TradeViewProps) {
  const { market } = useMarket();
  const { underlying } = useStrategy();
  const [state, setState] = useState<TradingState | null>(null);
  const [orders, setOrders] = useState<EngineOrder[]>([]);
  const [tape, setTape] = useState<EngineTrade[]>([]);
  const [instrument, setInstrument] = useState<string>('BTC-PERP');
  const [connected, setConnected] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setFlash({ kind, text });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 4200);
  }, []);

  // ---- initial + refresh loads
  const refreshState = useCallback(() => {
    engine.tradingState().then(setState).catch(() => {});
  }, []);
  const refreshOrders = useCallback(() => {
    engine.orders().then(setOrders).catch(() => {});
  }, []);
  const refreshTape = useCallback(
    (inst?: string) => {
      engine.tape(inst).then(setTape).catch(() => {});
    },
    [],
  );

  useEffect(() => {
    refreshState();
    refreshOrders();
    refreshTape();
    const iv = setInterval(() => {
      refreshState();
      refreshOrders();
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  // ---- SSE: live engine events
  useEffect(() => {
    const close = openTradingStream(
      (ev: EngineEvent) => {
        setConnected(true);
        if (ev.type === 'l1_all') {
          setState((s) => (s ? { ...s, l1: ev.data } : s));
        } else if (ev.type === 'trades') {
          setTape((t) => {
            const merged = [...ev.data, ...t];
            const seen = new Set<number>();
            return merged.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))).slice(0, 120);
          });
        } else if (ev.type === 'orders') {
          setOrders((os) => {
            const map = new Map(os.map((o) => [o.id, o]));
            for (const o of ev.data) map.set(o.id, o);
            return Array.from(map.values())
              .sort((a, b) => b.id - a.id)
              .slice(0, 80);
          });
        } else if (ev.type === 'account') {
          refreshState();
        }
      },
      () => setConnected(false),
    );
    return close;
  }, [refreshState]);

  // default instrument follows the selected underlying until user picks one
  const instruments = useMemo(() => state?.l1 ?? [], [state]);
  const forUnderlying = useMemo(
    () => instruments.filter((i) => i.underlying === underlying),
    [instruments, underlying],
  );
  // Derived (no setState-in-effect): if the picked instrument is not in the
  // current universe, fall back to the underlying's perp, else the first row.
  const activeInstrument = instruments.some((i) => i.instrument === instrument)
    ? instrument
    : forUnderlying.find((i) => i.instrument === `${underlying}-PERP`)?.instrument ?? forUnderlying[0]?.instrument ?? 'BTC-PERP';

  const acct = state?.account;
  const greeks = state?.greeks;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Account bar */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-teal-400" />
          <div>
            <p className="text-[9px] uppercase tracking-wider text-zinc-500">Equity (demo)</p>
            <p className="font-mono text-sm font-bold text-zinc-100">{acct ? fmtUsd(acct.equity) : '—'}</p>
          </div>
        </div>
        <Stat label="Balance" value={acct ? fmtUsd(acct.balance) : '—'} />
        <Stat
          label="Unrealized"
          value={acct ? fmtUsd(acct.unrealizedPnl) : '—'}
          tone={(acct?.unrealizedPnl ?? 0) >= 0 ? 'pos' : 'neg'}
        />
        <Stat label="Margin used" value={acct ? fmtUsd(acct.marginUsed) : '—'} />
        <Stat
          label="Margin ratio"
          value={acct ? (acct.marginRatio >= 999 ? '∞' : `${acct.marginRatio.toFixed(2)}×`) : '—'}
          tone={acct && acct.marginRatio < 1.1 ? 'neg' : undefined}
        />
        <Stat label="Fees paid" value={acct ? fmtUsd(acct.feesPaid) : '—'} />
        <div className="flex items-center gap-2 border-l border-zinc-800 pl-4">
          <Sigma className="h-3.5 w-3.5 text-sky-400" />
          <div className="flex gap-3 font-mono text-[10px]">
            <span className={((greeks?.delta ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
              Δ {greeks ? fmtNum(greeks.delta, 2) : '—'}
            </span>
            <span className="text-zinc-400">Γ {greeks ? fmtNum(greeks.gamma, 4) : '—'}</span>
            <span className="text-zinc-400">ν {greeks ? fmtNum(greeks.vega, 1) : '—'}</span>
            <span className="text-amber-400/80">θ {greeks ? fmtNum(greeks.theta, 2) : '—'}</span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-zinc-500">
            {connected ? <Wifi className="h-3 w-3 text-teal-400" /> : <WifiOff className="h-3 w-3 text-amber-400" />}
            {connected ? 'engine live' : 'polling'}
          </span>
        </div>
      </div>

      {/* Flash message */}
      {flash && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
            flash.kind === 'ok'
              ? 'border-teal-500/40 bg-teal-950/40 text-teal-200'
              : 'border-rose-500/40 bg-rose-950/40 text-rose-200'
          }`}
        >
          {flash.kind === 'ok' ? <Shield className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
          {flash.text}
        </div>
      )}

      {/* Main grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[280px_minmax(0,1fr)_400px]">
        {/* Instruments */}
        <InstrumentList
          rows={forUnderlying}
          selected={activeInstrument}
          onSelect={(i) => {
            setInstrument(i);
            refreshTape(i);
          }}
          spot={market.assets[underlying]?.spot ?? 0}
          underlying={underlying}
        />

        {/* Center: ticket + book + tape */}
        <div className="flex min-h-0 flex-col gap-3">
          <OrderTicket
            instrument={activeInstrument}
            l1={instruments.find((i) => i.instrument === activeInstrument)}
            onPlaced={() => {
              refreshOrders();
              refreshState();
            }}
            notify={notify}
          />
          <BookTape instrument={activeInstrument} tape={tape} />
        </div>

        {/* Right: RFQ + venues */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          <RfqPanel notify={notify} onExecuted={refreshState} onOpenBuilder={onOpenBuilder} />
          <VenuePanel instrument={activeInstrument} asset={underlying} />
        </div>
      </div>

      {/* Bottom: orders / positions */}
      <OrdersPositions
        orders={orders}
        state={state}
        onCancel={(id) =>
          engine
            .cancelOrder(id)
            .then(() => notify('ok', `Order #${id} cancelled`))
            .catch((e) => notify('err', String(e.message ?? e)))
            .finally(() => {
              refreshOrders();
              refreshState();
            })
        }
        onCancelAll={() =>
          engine
            .cancelAll()
            .then((r) => notify('ok', `Cancelled ${r.canceled} orders`))
            .catch((e) => notify('err', String(e.message ?? e)))
            .finally(() => {
              refreshOrders();
              refreshState();
            })
        }
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p
        className={`font-mono text-xs font-semibold ${
          tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-200'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function InstrumentList({
  rows,
  selected,
  onSelect,
  spot,
  underlying,
}: {
  rows: L1Dto[];
  selected: string;
  onSelect: (instrument: string) => void;
  spot: number;
  underlying: string;
}) {
  const [q, setQ] = useState('');
  const filtered = rows.filter((r) => r.instrument.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="border-b border-zinc-800 p-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Instruments</p>
          <p className="font-mono text-[10px] text-teal-300">
            {underlying} {spot > 0 ? fmtNum(spot, spot >= 1000 ? 0 : 2) : ''}
          </p>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter…"
          className="mt-2 h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-[11px] text-zinc-300 outline-none focus:border-teal-500/50"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {filtered.map((r) => {
          const active = r.instrument === selected;
          return (
            <button
              key={r.instrument}
              onClick={() => onSelect(r.instrument)}
              className={`mb-1 w-full rounded-md border px-2 py-1.5 text-left transition ${
                active
                  ? 'border-teal-500/50 bg-teal-950/40'
                  : 'border-transparent bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`truncate font-mono text-[10px] ${active ? 'text-teal-200' : 'text-zinc-300'}`}>
                  {r.instrument}
                </span>
                <span className="shrink-0 rounded bg-zinc-800/80 px-1 text-[8px] uppercase text-zinc-400">
                  {r.kind === 'perp_future' ? 'perp' : r.kind === 'perp_option' ? 'evr' : 'dated'}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between font-mono text-[9px] tabular-nums">
                <span className="text-emerald-400/90">{r.bid !== undefined ? fmtNum(r.bid, 2) : '—'}</span>
                <span className="text-zinc-600">{r.mark !== undefined ? fmtNum(r.mark, 2) : ''}</span>
                <span className="text-rose-400/90">{r.ask !== undefined ? fmtNum(r.ask, 2) : '—'}</span>
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="p-3 text-center text-[10px] text-zinc-600">No instruments match.</p>
        )}
      </div>
    </div>
  );
}

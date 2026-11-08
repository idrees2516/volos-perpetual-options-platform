'use client';

// ─────────────────────────────────────────────────────────────────────────────
// TradingView — v1.9 four-column execution terminal: account + instruments ·
// order ticket + L2 book · trade tape · strategy RFQ + connected exchanges.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { Search, Zap, BookOpen, Radio, Quote, LayoutGrid, Activity } from 'lucide-react';
import type { MarketState } from '@/hooks/use-market';
import { spotOf } from '@/hooks/use-market';
import {
  buildBook, instruments, rfqQuotes, tapePrint, ORDER_TYPES, STP_MODES,
  type OrderType,
} from '@/lib/market-sim';
import { analyzeStrategy } from '@/lib/pricing';
import { BASE_IV } from '@/lib/types';
import { VENUES } from '@/lib/venues';
import { useTrading } from '@/stores/trading-store';
import { useStrategy } from '@/stores/strategy-store';
import { fmtUsd, fmtNum } from '@/lib/format';
import { SectionCard } from './bits';

export function TradingView({ market }: { market: MarketState }) {
  const [selected, setSelected] = useState('BTC-PERP');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<OrderType>('LIMIT');
  const [qty, setQty] = useState('0.5');
  const [price, setPrice] = useState('');
  const [trigger, setTrigger] = useState('');
  const [stp, setStp] = useState<string>(STP_MODES[0]);
  const [rfqFrame, setRfqFrame] = useState(0);
  const [rfqOpen, setRfqOpen] = useState(false);

  const trading = useTrading();
  const { legs, underlying, size, anchorSpot, name: stratName } = useStrategy();

  const spots = useMemo(() => ({
    BTC: spotOf(market, 'BTC'),
    ETH: spotOf(market, 'ETH'),
    SOL: spotOf(market, 'SOL'),
  }), [market]);

  const insts = useMemo(() => instruments(spots), [spots]);
  const inst = insts.find((i) => i.symbol === selected) ?? insts[0];
  const tick = inst.underlying === 'SOL' ? 0.01 : inst.underlying === 'ETH' ? 0.1 : 1;
  const book = useMemo(
    () => buildBook(inst.symbol, (inst.bid + inst.ask) / 2, tick),
    [inst.symbol, inst.bid, inst.ask, tick],
  );

  // market prints on the engine book
  useEffect(() => {
    const id = setInterval(() => {
      const print = tapePrint(inst.symbol, Math.floor(Date.now() / 2500), book.mid, tick);
      useTrading.getState().pushTape([{ ...print, symbol: inst.symbol }]);
    }, 2500);
    return () => clearInterval(id);
  }, [inst.symbol, book.mid, tick]);

  const tapeRows = trading.tape.filter((t) => t.symbol === inst.symbol);

  const positionsPnl = trading.positions.reduce((a, p) => {
    const m = insts.find((i) => i.symbol === p.symbol)?.mark ?? p.entry;
    return a + (m - p.entry) * p.qty;
  }, 0);
  const equity = trading.balance + positionsPnl;
  const marginUsed = trading.positions.reduce((a, p) => a + Math.abs(p.qty * p.entry) * 0.05, 0);
  const marginRatio = marginUsed > 0 ? equity / marginUsed : Infinity;
  const netDelta = trading.positions.reduce((a, p) => a + p.qty, 0);

  const maxQty = Math.max(...book.bids.map((b) => b.qty), ...book.asks.map((a) => a.qty));

  // RFQ package pricing
  const pkg = useMemo(
    () => (legs.length ? analyzeStrategy(legs, spots.BTC, 'BTC', anchorSpot ?? undefined, size) : null),
    [legs, spots.BTC, anchorSpot, size],
  );
  const pkgPrice = pkg ? Math.abs(pkg.netPremium) : 0;
  const quotes = useMemo(
    () => rfqQuotes(Math.max(pkgPrice, 50), rfqFrame),
    [pkgPrice, rfqFrame],
  );

  function submit() {
    const q = Math.max(0.001, parseFloat(qty) || 0.5);
    const fillPrice =
      type === 'MARKET' || type === 'IOC' || type === 'FOK'
        ? side === 'buy' ? book.asks[0].price : book.bids[0].price
        : parseFloat(price) || (side === 'buy' ? book.asks[0].price : book.bids[0].price);
    const notional = fillPrice * q;
    const fee = (notional * 2) / 10000; // engine taker 2bps
    useTrading.getState().placeOrder({
      symbol: inst.symbol, side, type, price: type === 'MARKET' ? null : fillPrice, qty: q,
      fillPrice, fee,
      note: type === 'POST-ONLY' ? 'posted as maker' : undefined,
    });
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[230px_310px_1fr_290px] gap-2 overflow-hidden">
      {/* ── column 1: account + instruments ── */}
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <SectionCard title="Account · demo" icon={<LayoutGrid className="h-3.5 w-3.5" />}>
          <div className="grid grid-cols-2 gap-1.5 text-[10px]">
            {[
              ['Equity', fmtUsd(equity), 'text-zinc-100'],
              ['Balance', fmtUsd(trading.balance), 'text-zinc-300'],
              ['Unrealized', fmtUsd(positionsPnl), positionsPnl >= 0 ? 'text-teal-400' : 'text-rose-400'],
              ['Margin used', fmtUsd(marginUsed), 'text-zinc-300'],
              ['Margin ratio', marginRatio === Infinity ? '∞' : fmtNum(marginRatio, 1) + '×', 'text-zinc-300'],
              ['Fees paid', fmtUsd(trading.feesPaid), 'text-zinc-300'],
            ].map(([l, v, c]) => (
              <div key={l} className="rounded border border-zinc-800 bg-zinc-950/70 px-2 py-1">
                <div className="text-[8px] uppercase tracking-wider text-zinc-500">{l}</div>
                <div className={`font-mono text-[11px] font-semibold ${c}`}>{v}</div>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-2 font-mono text-[9px] text-zinc-500">
            <span>Δ {fmtNum(netDelta, 2)}</span>
            <span>Γ 0.00</span>
            <span>ν 0.00</span>
            <span>θ 0.00</span>
          </div>
        </SectionCard>

        <SectionCard title="Instruments" icon={<Search className="h-3.5 w-3.5" />}>
          <div className="mb-1.5 flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/80 px-2 py-1">
            <Search className="h-3 w-3 text-zinc-600" />
            <input placeholder="filter…" className="w-full bg-transparent text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none" />
          </div>
          <div className="space-y-0.5">
            {insts.map((i) => (
              <button
                key={i.symbol}
                type="button"
                onClick={() => setSelected(i.symbol)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[10px] transition-colors ${
                  i.symbol === selected ? 'bg-teal-400/10 ring-1 ring-teal-400/30' : 'hover:bg-zinc-900'
                }`}
              >
                <span className={`font-mono font-semibold ${i.symbol === selected ? 'text-teal-300' : 'text-zinc-200'}`}>
                  {i.symbol}
                </span>
                <span className="ml-auto font-mono text-zinc-500">
                  {i.bid.toLocaleString()} / {i.ask.toLocaleString()}
                </span>
                <span className="rounded bg-zinc-800 px-1 text-[8px] font-bold text-zinc-400">{i.tag}</span>
              </button>
            ))}
          </div>
        </SectionCard>
      </div>

      {/* ── column 2: order ticket + book ── */}
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <SectionCard title="Order ticket" icon={<Zap className="h-3.5 w-3.5" />} right={inst.symbol}>
          <div className="grid grid-cols-2 gap-1">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`rounded py-1 text-[10px] font-bold uppercase transition-colors ${
                  side === s
                    ? s === 'buy' ? 'bg-emerald-500/25 text-emerald-300' : 'bg-rose-500/25 text-rose-300'
                    : 'text-zinc-500 hover:bg-zinc-800'
                }`}
              >
                {s} / {s === 'buy' ? 'bid' : 'ask'}
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-0.5">
            {ORDER_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`rounded px-1.5 py-0.5 text-[8px] font-bold tracking-wide transition-colors ${
                  type === t ? 'bg-teal-400/20 text-teal-300' : 'text-zinc-500 hover:bg-zinc-800'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="mt-2 space-y-1.5">
            {[
              { label: type.includes('STOP-LIM') ? 'Limit price' : 'Price', value: price, set: setPrice, ph: String(Math.round(book.mid / tick) * tick) },
              { label: 'Quantity', value: qty, set: setQty, ph: '0.5' },
              { label: 'Trigger', value: trigger, set: setTrigger, ph: type.startsWith('STOP') ? '—' : '—', disabled: !type.startsWith('STOP') },
            ].map((f) => (
              <label key={f.label} className="block">
                <span className="text-[8px] uppercase tracking-wider text-zinc-500">{f.label}</span>
                <input
                  value={f.value}
                  disabled={f.disabled}
                  placeholder={f.ph}
                  onChange={(e) => f.set(e.target.value)}
                  className="mt-0.5 w-full rounded border border-zinc-800 bg-zinc-950/80 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-700 focus:border-teal-500/60 focus:outline-none disabled:opacity-40"
                />
              </label>
            ))}
            <label className="block">
              <span className="text-[8px] uppercase tracking-wider text-zinc-500">Self-trade prevention</span>
              <select
                value={stp}
                onChange={(e) => setStp(e.target.value)}
                className="mt-0.5 w-full rounded border border-zinc-800 bg-zinc-950/80 px-2 py-1 text-[10px] text-zinc-200 focus:border-teal-500/60 focus:outline-none"
              >
                {STP_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-1.5 font-mono text-[9px] text-zinc-500">
            BOOK: bid {book.bids[0].price.toLocaleString()} ask {book.asks[0].price.toLocaleString()} mark {Math.round(book.mid).toLocaleString()}
          </div>
          <button
            type="button"
            onClick={submit}
            className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded py-2 text-[11px] font-bold uppercase tracking-wide transition-colors ${
              side === 'buy' ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400' : 'bg-rose-500 text-zinc-950 hover:bg-rose-400'
            }`}
          >
            <Zap className="h-3 w-3" />
            {side} {type} {inst.symbol.replace('-PERP', '')}
          </button>
        </SectionCard>

        <SectionCard title="Order book — L2" icon={<BookOpen className="h-3.5 w-3.5" />}>
          <div className="space-y-[2px]">
            {[...book.asks].slice(0, 8).reverse().map((a) => (
              <div key={`a${a.price}`} className="relative flex items-center justify-between px-1.5 py-[2px] font-mono text-[10px]">
                <div className="absolute inset-y-0 right-0 bg-rose-500/10" style={{ width: `${(a.qty / maxQty) * 100}%` }} />
                <span className="relative text-rose-400">{a.price.toLocaleString()}</span>
                <span className="relative text-zinc-300">{fmtNum(a.qty, 2)}</span>
              </div>
            ))}
            <div className="my-0.5 flex items-center justify-between border-y border-zinc-800 px-1.5 py-1 font-mono text-[10px]">
              <span className="text-zinc-500">spread</span>
              <span className="text-amber-400">{fmtNum(book.spread, 2)}</span>
            </div>
            {book.bids.slice(0, 8).map((b) => (
              <div key={`b${b.price}`} className="relative flex items-center justify-between px-1.5 py-[2px] font-mono text-[10px]">
                <div className="absolute inset-y-0 right-0 bg-emerald-500/10" style={{ width: `${(b.qty / maxQty) * 100}%` }} />
                <span className="relative text-emerald-400">{b.price.toLocaleString()}</span>
                <span className="relative text-zinc-300">{fmtNum(b.qty, 2)}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      {/* ── column 3: trade tape ── */}
      <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
        <SectionCard title="Trade tape" icon={<Activity className="h-3.5 w-3.5" />} right={`${inst.symbol} · engine CLOB`} className="flex min-h-0 flex-1 flex-col overflow-hidden [&>div]:min-h-0 [&>div]:flex-1 [&>div]:overflow-y-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-left text-[9px] uppercase tracking-wider text-zinc-500">
                <th className="pb-1">Time</th>
                <th className="pb-1">Price</th>
                <th className="pb-1">Qty</th>
                <th className="pb-1">{inst.symbol}</th>
                <th className="pb-1 text-right">Taker</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {tapeRows.map((t) => (
                <tr key={t.id} className="border-t border-zinc-900">
                  <td className="py-[3px] text-zinc-500">{new Date(t.ts).toLocaleTimeString('en-US', { hour12: false })}</td>
                  <td className={t.taker === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{t.price.toLocaleString()}</td>
                  <td className="text-zinc-300">{fmtNum(t.qty, 2)}</td>
                  <td className="text-zinc-600">{t.symbol.split('-')[1] ?? ''}</td>
                  <td className={`text-right font-semibold ${t.taker === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {t.taker === 'buy' ? '▲' : '▼'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tapeRows.length === 0 && (
            <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">
              No trades yet on this instrument.
            </div>
          )}
        </SectionCard>

        {trading.orders.length > 0 && (
          <SectionCard title="Orders — this session" icon={<Quote className="h-3.5 w-3.5" />} className="shrink-0 max-h-40 overflow-y-auto">
            <table className="w-full text-[10px]">
              <tbody className="font-mono">
                {trading.orders.slice(0, 6).map((o) => (
                  <tr key={o.id} className="border-t border-zinc-900">
                    <td className="py-[3px] text-zinc-500">{new Date(o.ts).toLocaleTimeString('en-US', { hour12: false })}</td>
                    <td className={`px-2 font-semibold ${o.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{o.side.toUpperCase()}</td>
                    <td className="text-zinc-300">{o.symbol}</td>
                    <td className="px-2 text-right text-zinc-300">{fmtNum(o.qty, 2)} @ {o.price?.toLocaleString() ?? 'mkt'}</td>
                    <td className="text-right text-teal-400">{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>
        )}
      </div>

      {/* ── column 4: RFQ + connected exchanges ── */}
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <SectionCard title="Strategy RFQ" icon={<Quote className="h-3.5 w-3.5" />}>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-zinc-100">{stratName || 'Custom strategy'}</span>
            <span className="rounded bg-teal-400/15 px-1.5 py-0.5 text-[8px] font-bold text-teal-300">1× click to add legs</span>
          </div>
          <div className="mt-1 text-[9px] text-zinc-500">
            {underlying} · {legs.length} legs · package {fmtUsd(pkgPrice)} · size {size}×
          </div>
          <div className="mt-2 flex gap-1">
            <button type="button" onClick={() => setRfqOpen(true)} className="flex-1 rounded bg-emerald-500/20 py-1 text-[9px] font-bold text-emerald-300 hover:bg-emerald-500/30">BUY PACKAGE</button>
            <button type="button" onClick={() => setRfqOpen(true)} className="flex-1 rounded bg-rose-500/20 py-1 text-[9px] font-bold text-rose-300 hover:bg-rose-500/30">SELL PACKAGE</button>
          </div>
          <button
            type="button"
            onClick={() => { setRfqOpen(true); setRfqFrame((f) => f + 1); }}
            className="mt-1 w-full rounded border border-zinc-700 py-1 text-[9px] font-semibold text-zinc-300 hover:border-teal-500/50 hover:text-teal-300"
          >
            Request quotes — {legs.length} legs
          </button>
          <p className="mt-2 text-[9px] leading-relaxed text-zinc-500">
            Dealers quote the full package on complex-order books (CBOE · Nasdaq/PHLX · MIAX) and RFQ networks
            (Paradigm · Derive · Paradex) — one fill, no leg risk.
          </p>
          {rfqOpen && (
            <div className="mt-2 space-y-1">
              {quotes.map((q) => (
                <div key={q.dealer} className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/70 px-2 py-1 font-mono text-[9px]">
                  <span className="font-semibold text-zinc-200">{q.dealer}</span>
                  <span className="text-zinc-600">{q.venue}</span>
                  <span className="ml-auto text-teal-300">{fmtUsd(q.price)}</span>
                  <span className="text-zinc-500">{q.size}×</span>
                  <span className="text-amber-400/80">{q.validFor}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Connected exchanges" icon={<Radio className="h-3.5 w-3.5" />} right={`${market.venues.filter((v) => v.live && !v.engine).length} LIVE`}>
          <div className="space-y-1">
            {market.venues.filter((v) => !v.engine && v.venueClass === 'crypto').map((v) => (
              <div key={v.id} className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-[9px]">
                <span className={`h-1.5 w-1.5 rounded-full ${v.live ? 'bg-teal-400' : 'bg-zinc-700'}`} />
                <span className="font-semibold text-zinc-200">{v.name}</span>
                <span className="ml-auto font-mono text-zinc-500">{v.live ? `${v.latencyMs ?? '—'}ms` : 'offline'}</span>
                <span className={`rounded px-1 text-[8px] font-bold ${v.live ? 'bg-teal-400/15 text-teal-300' : 'bg-zinc-800 text-zinc-500'}`}>
                  {v.quoteTag ?? 'NATIVE'}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-500">Engine CLOB venues</div>
          <div className="mt-1 space-y-1">
            {[
              { name: 'VolOS CLOB', ms: 1, tag: 'LIVE' },
              { name: 'Derive', ms: 14, tag: 'SIMULATED' },
              { name: 'Paradex', ms: 21, tag: 'LIVE-MARKETS' },
              { name: 'Paradigm', ms: 39, tag: 'SIMULATED' },
            ].map((e) => (
              <div key={e.name} className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-[9px]">
                <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
                <span className="font-semibold text-zinc-200">{e.name}</span>
                <span className="ml-auto font-mono text-zinc-500">{e.ms}ms</span>
                <span className="rounded bg-zinc-800 px-1 text-[8px] font-bold text-zinc-400">{e.tag}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[9px] text-zinc-600">{VENUES.length} venues wired · engine marks at {fmtUsd(spots.BTC)} BTC</div>
        </SectionCard>
      </div>
    </div>
  );
}

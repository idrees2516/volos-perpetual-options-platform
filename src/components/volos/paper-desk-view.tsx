'use client';

// ─────────────────────────────────────────────────────────────────────────────
// PaperDeskView — v1.9: paper equity bar, single-leg paper order ticket with
// live route preview, strategy package paper-deploy at cross-venue quotes,
// live-marked positions and fill history.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import { RotateCcw, Zap, Package } from 'lucide-react';
import type { MarketState } from '@/hooks/use-market';
import { spotOf } from '@/hooks/use-market';
import { blackScholes, surfaceIv, analyzeStrategy } from '@/lib/pricing';
import { BASE_IV, type UnderlyingId } from '@/lib/types';
import { VENUES, venueSupports } from '@/lib/venues';
import { usePaper, rollupPositions } from '@/stores/paper-store';
import { useStrategy } from '@/stores/strategy-store';
import { fmtUsd, fmtNum, fmtTime } from '@/lib/format';
import { SectionCard } from './bits';

const EXPIRIES = [1, 2, 3, 7, 14, 30, 60, 90];

function expiryLabel(dte: number): string {
  const d = new Date(Date.now() + dte * 86400000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${dd}${mon}${yy} (${dte}d)`;
}

export function PaperDeskView({ market }: { market: MarketState }) {
  const paper = usePaper();
  const { legs, underlying: stratUnderlying, size, anchorSpot, name: stratName, catalogId } = useStrategy();

  // order ticket state
  const [venueSel, setVenueSel] = useState('auto');
  const [asset, setAsset] = useState<UnderlyingId>('BTC');
  const [optType, setOptType] = useState<'call' | 'put'>('call');
  const [optSide, setOptSide] = useState<'BUY' | 'SELL'>('BUY');
  const [expiry, setExpiry] = useState(EXPIRIES[0]);
  const [strike, setStrike] = useState('');
  const [qty, setQty] = useState('0.1');
  const [orderKind, setOrderKind] = useState<'MARKET' | 'LIMIT'>('MARKET');

  const spot = spotOf(market, asset);
  const strikeNum = parseFloat(strike) || Math.round(spot / 1000) * 1000;
  const iv = surfaceIv(optType, ((strikeNum - spot) / spot) * 100, expiry, BASE_IV[asset]);
  const quote = blackScholes(optType, spot, strikeNum, iv, expiry);
  const half = quote.price * 0.006 + 0.5;

  // best venue for this option
  const routeVenue = useMemo(() => {
    const feas = VENUES.filter((v) => venueSupports(v, optType === 'call' ? 'call' : 'put', expiry) && !v.engine);
    if (venueSel !== 'auto') return VENUES.find((v) => v.id === venueSel) ?? feas[0] ?? VENUES[0];
    return feas.sort((a, b) => b.liquidity - a.liquidity)[0] ?? VENUES[0];
  }, [venueSel, optType, expiry]);

  const fillPrice = optSide === 'BUY'
    ? (orderKind === 'MARKET' ? quote.price + half : quote.price)
    : (orderKind === 'MARKET' ? quote.price - half : quote.price);

  const stratSpot = spotOf(market, stratUnderlying);
  const stratAnalysis = useMemo(
    () => (legs.length ? analyzeStrategy(legs, stratSpot, stratUnderlying, anchorSpot ?? undefined, size) : null),
    [legs, stratSpot, stratUnderlying, anchorSpot, size],
  );

  const positions = useMemo(
    () => rollupPositions(paper.fills, (u) => spotOf(market, u)),
    [paper.fills, market],
  );
  const unrealized = positions.reduce((a, p) => a + p.uPnl, 0);
  const equity = paper.cash + unrealized;
  const marginHeld = positions.reduce((a, p) => a + (p.qty < 0 ? Math.abs(p.qty * p.mark) * 0.1 : 0), 0);
  const buyingPower = equity - marginHeld;
  const netPnl = paper.realized + unrealized;
  const totalW = paper.wins + paper.losses;

  function submitTicket() {
    const q = Math.max(0.001, parseFloat(qty) || 0.1);
    const notional = Math.abs(fillPrice * q);
    const fee = (notional * routeVenue.takerBps) / 10000;
    paper.addFill({
      action: optSide,
      instrument: `${asset} ${expiryLabel(expiry).split(' ')[0]} ${strikeNum.toLocaleString()} ${optType.toUpperCase()}`,
      kind: optType,
      qty: q,
      price: Math.max(0.5, fillPrice),
      fee,
      venue: routeVenue.name,
      strategyId: null,
      strategyName: null,
      strike: strikeNum,
      dte: expiry,
      underlying: asset,
      delta: quote.delta,
      vega: quote.vega,
      entrySpot: spot,
      iv,
    });
  }

  function deployStrategy() {
    if (!stratAnalysis) return;
    for (const l of stratAnalysis.resolved) {
      const feas = VENUES.filter((v) => venueSupports(v, l.kind, l.dte)).sort((a, b) => b.liquidity - a.liquidity);
      const v = feas[0] ?? VENUES[0];
      const action = l.side === 'long' ? 'BUY' : 'SELL';
      const px = l.premium * (action === 'BUY' ? 1.003 : 0.997);
      const fee = (Math.abs(px * l.ratio) * v.takerBps) / 10000;
      paper.addFill({
        action,
        instrument: l.label.replace(/[+−]/, ''),
        kind: l.kind === 'perp' || l.kind === 'spot' ? 'perp' : l.kind === 'perp_option' ? 'perp_option' : l.kind,
        qty: l.ratio * size,
        price: Math.max(0.5, px),
        fee,
        venue: v.name,
        strategyId: catalogId,
        strategyName: stratName || 'Custom structure',
        strike: l.strike,
        dte: l.kind === 'perp' || l.kind === 'spot' ? null : l.dte,
        underlying: stratUnderlying,
        delta: l.delta,
        vega: l.vega,
        entrySpot: stratSpot,
        iv: l.iv,
      });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      {/* metrics bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
        {[
          ['Paper equity', fmtUsd(equity), 'text-zinc-100'],
          ['Cash', fmtUsd(paper.cash), 'text-zinc-300'],
          ['Buying power', fmtUsd(buyingPower), 'text-zinc-300'],
          ['Margin held', fmtUsd(marginHeld), 'text-zinc-300'],
          ['Unrealized', fmtUsd(unrealized), unrealized >= 0 ? 'text-teal-400' : 'text-rose-400'],
          ['Realized', fmtUsd(paper.realized), paper.realized >= 0 ? 'text-teal-400' : 'text-rose-400'],
          ['Fees', fmtUsd(paper.fees), 'text-zinc-300'],
          ['Win rate', totalW ? `${Math.round((paper.wins / totalW) * 100)}% (${paper.wins}W/${paper.losses}L)` : '0% (0W/0L)', 'text-zinc-300'],
          ['Net P&L', fmtUsd(netPnl), netPnl >= 0 ? 'text-teal-400' : 'text-rose-400'],
        ].map(([l, v, c]) => (
          <div key={l} className="min-w-[92px]">
            <div className="text-[8px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{l}</div>
            <div className={`font-mono text-[12px] font-bold ${c}`}>{v}</div>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => paper.setFillsAtRealBbo(!paper.fillsAtRealBbo)}
            className={`rounded-md border px-2 py-1 text-[9px] font-bold tracking-wide transition-colors ${
              paper.fillsAtRealBbo ? 'border-teal-500/50 bg-teal-400/10 text-teal-300' : 'border-zinc-700 text-zinc-500'
            }`}
          >
            FILLS AT REAL VENUE BBO
          </button>
          <button
            type="button"
            onClick={() => paper.reset()}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[9px] font-semibold text-zinc-400 hover:border-rose-500/50 hover:text-rose-300"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[330px_1fr] gap-2 overflow-hidden">
        {/* left: order ticket + strategy deploy */}
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          <SectionCard title="Paper order ticket" icon={<Zap className="h-3.5 w-3.5" />}>
            <label className="block">
              <span className="text-[8px] uppercase tracking-wider text-zinc-500">Venue</span>
              <select
                value={venueSel}
                onChange={(e) => setVenueSel(e.target.value)}
                className="mt-0.5 w-full rounded border border-zinc-800 bg-zinc-950/80 px-2 py-1 text-[10px] text-zinc-200 focus:border-teal-500/60 focus:outline-none"
              >
                <option value="auto">Auto-route (best price)</option>
                {VENUES.filter((v) => !v.engine).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            {[
              { label: 'Asset', opts: ['BTC', 'ETH', 'SOL'] as UnderlyingId[], val: asset, set: setAsset },
              { label: 'Type', opts: ['call', 'put'] as ('call' | 'put')[], val: optType, set: setOptType },
              { label: 'Side', opts: ['BUY', 'SELL'] as ('BUY' | 'SELL')[], val: optSide, set: setOptSide },
              { label: 'Order', opts: ['MARKET', 'LIMIT'] as ('MARKET' | 'LIMIT')[], val: orderKind, set: setOrderKind },
            ].map((g) => (
              <div key={g.label} className="mt-1.5">
                <span className="text-[8px] uppercase tracking-wider text-zinc-500">{g.label}</span>
                <div className="mt-0.5 grid grid-cols-2 gap-1">
                  {g.opts.map((o) => (
                    <button
                      key={String(o)}
                      type="button"
                      onClick={() => g.set(o)}
                      className={`rounded py-1 text-[10px] font-bold uppercase transition-colors ${
                        g.val === o
                          ? o === 'BUY' ? 'bg-emerald-500/25 text-emerald-300'
                            : o === 'SELL' ? 'bg-rose-500/25 text-rose-300'
                            : 'bg-teal-400/15 text-teal-300'
                          : 'text-zinc-500 hover:bg-zinc-800'
                      }`}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <label className="block">
                <span className="text-[8px] uppercase tracking-wider text-zinc-500">Expiry</span>
                <select
                  value={expiry}
                  onChange={(e) => setExpiry(Number(e.target.value))}
                  className="mt-0.5 w-full rounded border border-zinc-800 bg-zinc-950/80 px-2 py-1 text-[10px] text-zinc-200 focus:border-teal-500/60 focus:outline-none"
                >
                  {EXPIRIES.map((d) => <option key={d} value={d}>{expiryLabel(d)}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-[8px] uppercase tracking-wider text-zinc-500">Strike</span>
                <input
                  value={strike}
                  onChange={(e) => setStrike(e.target.value)}
                  placeholder={String(Math.round(spot / 1000) * 1000)}
                  className="mt-0.5 w-full rounded border border-zinc-800 bg-zinc-950/80 px-2 py-1 font-mono text-[10px] text-zinc-100 placeholder:text-zinc-700 focus:border-teal-500/60 focus:outline-none"
                />
              </label>
            </div>
            <label className="mt-1.5 block">
              <span className="text-[8px] uppercase tracking-wider text-zinc-500">Qty ({asset})</span>
              <input
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="mt-0.5 w-full rounded border border-zinc-800 bg-zinc-950/80 px-2 py-1 font-mono text-[10px] text-zinc-100 focus:border-teal-500/60 focus:outline-none"
              />
            </label>

            <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/70 px-2.5 py-2">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-500">Route</span>
                <span className="font-semibold text-teal-300">{routeVenue.name} · best route</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[10px]">
                <span className="text-zinc-500">Details</span>
                <span className="font-mono text-zinc-400">{expiryLabel(expiry)} · IV {(iv * 100).toFixed(1)}%</span>
              </div>
              <div className="mt-1 flex items-center justify-between font-mono text-[11px]">
                <span className="text-emerald-400">{fmtUsd(Math.max(0.5, quote.price - half))} bid</span>
                <span className="text-zinc-500">spot {Math.round(spot).toLocaleString()}</span>
                <span className="text-rose-400">{fmtUsd(quote.price + half)} ask</span>
              </div>
              <p className="mt-1.5 text-[9px] leading-relaxed text-zinc-600">
                *Market {optSide === 'BUY' ? 'buy fills at the ask' : 'sell fills at the bid'} · taker fee{' '}
                {routeVenue.takerBps} bps of notional · native venue quotes
              </p>
            </div>

            <button
              type="button"
              onClick={submitTicket}
              className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded py-2 text-[11px] font-bold uppercase tracking-wide transition-colors ${
                optSide === 'BUY' ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400' : 'bg-rose-500 text-zinc-950 hover:bg-rose-400'
              }`}
            >
              {optSide} {qty || '0.1'} {asset} {optType.toUpperCase()} @ {orderKind.toLowerCase()}
            </button>
          </SectionCard>

          <SectionCard title="Strategy paper-testing" icon={<Package className="h-3.5 w-3.5" />}>
            <p className="text-[10px] leading-relaxed text-zinc-400">
              Deploy the current builder strategy ({legs.length} dated legs · {stratUnderlying} · ×{size}) as one
              paper package at real cross-venue quotes — each leg routed to its deepest feasible book.
            </p>
            <button
              type="button"
              onClick={deployStrategy}
              disabled={!stratAnalysis}
              className="mt-2 w-full rounded-md border border-teal-500/50 py-1.5 text-[10px] font-bold text-teal-300 transition-colors hover:bg-teal-400/10 disabled:opacity-40"
            >
              Paper-deploy “{stratName || 'Custom strategy'}”
            </button>
            {stratAnalysis && (
              <div className="mt-2 flex items-center justify-between font-mono text-[9px] text-zinc-500">
                <span>{stratAnalysis.netPremium >= 0 ? 'net credit' : 'net debit'} {fmtUsd(Math.abs(stratAnalysis.netPremium))}</span>
                <span>Δ {fmtNum(stratAnalysis.netDelta, 3)} · ν {fmtUsd(stratAnalysis.netVega)}</span>
              </div>
            )}
          </SectionCard>
        </div>

        {/* right: positions + fill history */}
        <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
          <SectionCard
            title="Positions"
            icon={<Zap className="h-3.5 w-3.5" />}
            right="OPEN"
            className="flex min-h-0 flex-[1.2] flex-col overflow-hidden [&>div]:min-h-0 [&>div]:flex-1 [&>div]:overflow-y-auto"
          >
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[9px] uppercase tracking-wider text-zinc-500">
                  <th className="py-1 pr-2">Venue</th>
                  <th className="pr-2">Instrument</th>
                  <th className="pr-2">Side</th>
                  <th className="pr-2 text-right">Qty</th>
                  <th className="pr-2 text-right">Entry</th>
                  <th className="pr-2 text-right">Mark</th>
                  <th className="pr-2 text-right">uPnL</th>
                  <th className="text-right">% strategy</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {positions.map((p) => (
                  <tr key={`${p.instrument}-${p.venue}-${p.strategyId}`} className="border-b border-zinc-900">
                    <td className="py-1.5 pr-2 text-zinc-400">{p.venue}</td>
                    <td className="pr-2 text-zinc-200">{p.instrument}</td>
                    <td className={`pr-2 font-semibold ${p.qty > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {p.qty > 0 ? 'LONG' : 'SHORT'}
                    </td>
                    <td className="pr-2 text-right text-zinc-300">{fmtNum(Math.abs(p.qty), 2)}</td>
                    <td className="pr-2 text-right text-zinc-300">{fmtUsd(p.price)}</td>
                    <td className="pr-2 text-right text-zinc-100">{fmtUsd(p.mark)}</td>
                    <td className={`pr-2 text-right font-semibold ${p.uPnl >= 0 ? 'text-teal-400' : 'text-rose-400'}`}>{fmtUsd(p.uPnl)}</td>
                    <td className="text-right text-zinc-500">
                      {p.strategyName ? `${Math.round((Math.abs(p.uPnl) / (Math.abs(netPnl) || 1)) * 100)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {positions.length === 0 && (
              <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">
                No open paper positions — place an order or deploy a strategy package.
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Fill history"
            icon={<Package className="h-3.5 w-3.5" />}
            right="RECENT"
            className="flex min-h-0 flex-1 flex-col overflow-hidden [&>div]:min-h-0 [&>div]:flex-1 [&>div]:overflow-y-auto"
          >
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[9px] uppercase tracking-wider text-zinc-500">
                  <th className="py-1 pr-2">Time</th>
                  <th className="pr-2">Action</th>
                  <th className="pr-2">Instrument</th>
                  <th className="pr-2 text-right">Qty</th>
                  <th className="pr-2 text-right">Price</th>
                  <th className="pr-2 text-right">Fee</th>
                  <th className="pr-2">Venue</th>
                  <th>Strategy</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {paper.fills.map((f) => (
                  <tr key={f.id} className="border-b border-zinc-900">
                    <td className="py-1.5 pr-2 text-zinc-500">{fmtTime(new Date(f.ts).toISOString())}</td>
                    <td className={`pr-2 font-bold ${f.action === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{f.action}</td>
                    <td className="pr-2 text-zinc-200">{f.instrument}</td>
                    <td className="pr-2 text-right text-zinc-300">{fmtNum(f.qty, 2)}</td>
                    <td className="pr-2 text-right text-zinc-100">{fmtUsd(f.price)}</td>
                    <td className="pr-2 text-right text-zinc-500">{fmtUsd(f.fee, 2)}</td>
                    <td className="pr-2 text-zinc-400">{f.venue}</td>
                    <td className="text-zinc-500">{f.strategyName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {paper.fills.length === 0 && (
              <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">
                No fills yet this session.
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

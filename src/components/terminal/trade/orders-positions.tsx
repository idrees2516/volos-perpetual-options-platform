'use client';

// Open orders / positions / risk — the account management tabs.

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { EngineOrder, TradingState } from '@/lib/api';
import { fmtNum, fmtUsd } from '@/lib/format';
import { Inbox, Layers3, Shield, X } from 'lucide-react';

const STATUS_STYLE: Record<EngineOrder['status'], string> = {
  pending: 'bg-amber-950/50 text-amber-300',
  open: 'bg-sky-950/50 text-sky-300',
  partially_filled: 'bg-sky-950/50 text-sky-300',
  filled: 'bg-emerald-950/50 text-emerald-300',
  canceled: 'bg-zinc-800 text-zinc-400',
  rejected: 'bg-rose-950/50 text-rose-300',
  expired: 'bg-zinc-800 text-zinc-500',
};

interface Props {
  orders: EngineOrder[];
  state: TradingState | null;
  onCancel: (id: number) => void;
  onCancelAll: () => void;
}

export function OrdersPositions({ orders, state, onCancel, onCancelAll }: Props) {
  const [tab, setTab] = useState<'orders' | 'positions' | 'risk'>('orders');

  const open = orders.filter((o) => ['pending', 'open', 'partially_filled'].includes(o.status));
  const history = orders.filter((o) => !['pending', 'open', 'partially_filled'].includes(o.status));

  return (
    <div className="flex max-h-72 min-h-56 flex-col rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center gap-1 border-b border-zinc-800 p-2">
        {(
          [
            { id: 'orders', label: `Open Orders (${open.length})`, icon: <Inbox className="h-3.5 w-3.5" /> },
            { id: 'positions', label: `Positions (${state?.positions.length ?? 0})`, icon: <Layers3 className="h-3.5 w-3.5" /> },
            { id: 'risk', label: 'Risk & Fees', icon: <Shield className="h-3.5 w-3.5" /> },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] font-medium transition ${
              tab === t.id ? 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
        {tab === 'orders' && open.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 border-rose-900/60 bg-rose-950/30 px-2 text-[9px] text-rose-300 hover:bg-rose-950/50"
            onClick={onCancelAll}
          >
            <X className="mr-1 h-3 w-3" /> Cancel all
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'orders' && (
          <table className="w-full text-left font-mono text-[10px] tabular-nums">
            <thead className="sticky top-0 bg-zinc-950/95 text-[8px] uppercase tracking-wider text-zinc-600">
              <tr>
                <th className="px-2.5 py-1.5">#</th>
                <th>Instrument</th>
                <th>Side</th>
                <th>Kind</th>
                <th className="text-right">Price</th>
                <th className="text-right">Filled / Lots</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...open, ...history].slice(0, 40).map((o) => (
                <tr key={o.id} className="border-b border-zinc-900 hover:bg-zinc-900/60">
                  <td className="px-2.5 py-1.5 text-zinc-600">{o.id}</td>
                  <td className="max-w-44 truncate text-zinc-300">{o.instrument}</td>
                  <td className={o.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{o.side}</td>
                  <td className="text-zinc-500">{o.kind.replace('_', ' ')}</td>
                  <td className="text-right text-zinc-300">
                    {o.priceTicks !== undefined && o.priceTicks > 0 ? fmtNum(o.avgFillPrice || o.priceTicks * 0.5, 2) : 'mkt'}
                  </td>
                  <td className="text-right text-zinc-400">
                    {o.filledLots}/{o.lots}
                  </td>
                  <td>
                    <span className={`rounded px-1.5 py-0.5 text-[8px] font-semibold uppercase ${STATUS_STYLE[o.status]}`}>
                      {o.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="pr-2 text-right">
                    {['pending', 'open', 'partially_filled'].includes(o.status) && (
                      <button
                        onClick={() => onCancel(o.id)}
                        className="rounded p-1 text-zinc-500 hover:bg-rose-950/60 hover:text-rose-400"
                        title="Cancel order"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-4 text-center text-[10px] text-zinc-600">
                    No orders yet — place one from the ticket or execute an RFQ package.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === 'positions' && (
          <table className="w-full text-left font-mono text-[10px] tabular-nums">
            <thead className="sticky top-0 bg-zinc-950/95 text-[8px] uppercase tracking-wider text-zinc-600">
              <tr>
                <th className="px-2.5 py-1.5">Instrument</th>
                <th>Under</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Avg Cost</th>
                <th className="text-right">Mark</th>
                <th className="text-right">Value</th>
                <th className="text-right">uP&L</th>
                <th className="text-right">rP&L</th>
              </tr>
            </thead>
            <tbody>
              {(state?.positions ?? []).map((p) => (
                <tr key={p.instrument} className="border-b border-zinc-900 hover:bg-zinc-900/60">
                  <td className="max-w-48 truncate px-2.5 py-1.5 text-zinc-300">{p.instrument}</td>
                  <td className="text-zinc-600">{p.underlying}</td>
                  <td className={`text-right ${p.qty >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtNum(p.qty, 3)}</td>
                  <td className="text-right text-zinc-400">{fmtNum(p.avgCost, 2)}</td>
                  <td className="text-right text-zinc-400">{fmtNum(p.mark, 2)}</td>
                  <td className="text-right text-zinc-300">{fmtUsd(p.value)}</td>
                  <td className={`text-right ${p.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {fmtUsd(p.unrealizedPnl)}
                  </td>
                  <td className="text-right text-zinc-500">{fmtUsd(p.realizedPnl)}</td>
                </tr>
              ))}
              {(state?.positions ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} className="p-4 text-center text-[10px] text-zinc-600">
                    No open positions. Load a strategy from the library and send it to the RFQ desk.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {tab === 'risk' && (
          <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Portfolio stress margin (SPAN-like)</p>
              <div className="space-y-1.5 font-mono text-[10px]">
                <Row k="Equity" v={state ? fmtUsd(state.account.equity) : '—'} />
                <Row k="Margin used" v={state ? fmtUsd(state.account.marginUsed) : '—'} />
                <Row
                  k="Margin ratio (maint ≥ 1.10×)"
                  v={state ? (state.account.marginRatio >= 999 ? '∞' : `${state.account.marginRatio.toFixed(2)}×`) : '—'}
                  tone={state && state.account.marginRatio < 1.1 ? 'neg' : 'pos'}
                />
                <Row k="Fees paid" v={state ? fmtUsd(state.account.feesPaid) : '—'} />
                <Row k="Funding paid" v={state ? fmtUsd(state.account.fundingPaid) : '—'} />
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Aggregate Greeks</p>
              <div className="space-y-1.5 font-mono text-[10px]">
                <Row k="Delta (units)" v={state ? fmtNum(state.greeks.delta, 3) : '—'} />
                <Row k="Delta ($)" v={state ? fmtUsd(state.greeks.deltaUsd) : '—'} />
                <Row k="Gamma" v={state ? fmtNum(state.greeks.gamma, 5) : '—'} />
                <Row k="Vega (per vol pt)" v={state ? fmtNum(state.greeks.vega, 2) : '—'} />
                <Row k="Theta (per day)" v={state ? fmtUsd(state.greeks.theta) : '—'} />
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 md:col-span-2">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Per-underlying exposure</p>
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(state?.greeks.perUnderlying ?? {}).map(([u, g]) => (
                  <div key={u} className="rounded border border-zinc-800/70 bg-zinc-900/50 px-2.5 py-2">
                    <p className="mb-1 font-mono text-[10px] font-bold text-teal-300">{u}</p>
                    <div className="space-y-0.5 font-mono text-[9px] text-zinc-400">
                      <p>Δ {fmtNum(g.delta, 3)}</p>
                      <p>Γ {fmtNum(g.gamma, 5)}</p>
                      <p>ν {fmtNum(g.vega, 2)}</p>
                      <p>θ {fmtNum(g.theta, 2)}</p>
                    </div>
                  </div>
                ))}
                {Object.keys(state?.greeks.perUnderlying ?? {}).length === 0 && (
                  <p className="col-span-3 p-2 text-center text-[10px] text-zinc-600">No exposure.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-900 pb-1">
      <span className="text-zinc-500">{k}</span>
      <span className={tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-200'}>{v}</span>
    </div>
  );
}

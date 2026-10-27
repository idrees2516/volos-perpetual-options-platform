'use client';

// ─────────────────────────────────────────────────────────────────────────────
// GAMMA LAB — Flow tab: the live options tape. Every print with size,
// premium, exchange, aggressor; sweeps, blocks and 0DTE flags; premium
// flow summary with call/put ratio and buy/sell pressure; largest prints;
// 0DTE activity monitor.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { Flame, Radio, Zap, Crown, Timer, ArrowRight } from 'lucide-react';
import type { FlowPrint, FlowSummary, GammaProfile } from '@/lib/gamma-flow';
import { fmtNum } from '@/lib/format';

function fmtPrem(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

type FlowFilter = 'all' | 'sweeps' | 'blocks' | '0dte' | 'calls' | 'puts';

const FILTERS: { id: FlowFilter; label: string }[] = [
  { id: 'all', label: 'All prints' },
  { id: 'sweeps', label: '⚡ Sweeps' },
  { id: 'blocks', label: '▦ Blocks' },
  { id: '0dte', label: '0DTE' },
  { id: 'calls', label: 'Calls' },
  { id: 'puts', label: 'Puts' },
];

function timeStr(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

interface Props {
  profile: GammaProfile;
  prints: FlowPrint[];
  summary: FlowSummary;
}

export function GammaFlow({ profile, prints, summary }: Props) {
  const [filter, setFilter] = useState<FlowFilter>('all');

  const filtered = useMemo(() => {
    switch (filter) {
      case 'sweeps': return prints.filter((p) => p.isSweep);
      case 'blocks': return prints.filter((p) => p.isBlock);
      case '0dte': return prints.filter((p) => p.is0dte);
      case 'calls': return prints.filter((p) => p.optionType === 'call');
      case 'puts': return prints.filter((p) => p.optionType === 'put');
      default: return prints;
    }
  }, [prints, filter]);

  const largest = useMemo(
    () => [...prints].sort((a, b) => b.premium - a.premium).slice(0, 6),
    [prints],
  );

  const d0te = useMemo(() => prints.filter((p) => p.is0dte), [prints]);
  const d0teCallPrem = d0te.filter((p) => p.optionType === 'call').reduce((a, p) => a + p.premium, 0);
  const d0tePutPrem = d0te.filter((p) => p.optionType === 'put').reduce((a, p) => a + p.premium, 0);

  const callPremBar = 100 * (summary.callPremium / (summary.callPremium + summary.putPremium || 1));
  const buyBar = 100 * ((summary.callBuyPremium + summary.putBuyPremium) / summary.totalPremium || 0);

  const cpm = (v: number) => fmtNum(v, v >= 1000 ? 0 : 2);

  return (
    <div className="space-y-3">
      {/* summary strip */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Total premium" value={fmtPrem(summary.totalPremium)} sub={`${summary.prints} prints on tape`} />
        <Stat
          label="Call / put premium"
          value={`${(summary.callPutRatio).toFixed(2)}`}
          sub={`${fmtPrem(summary.callPremium)} C vs ${fmtPrem(summary.putPremium)} P`}
          bar={{ pct: callPremBar, left: 'calls', right: 'puts' }}
        />
        <Stat
          label="Buy / sell pressure"
          value={`${(summary.buySellPressure * 100).toFixed(0)}%`}
          sub={summary.buySellPressure >= 0 ? 'customers lifting offers' : 'customers hitting bids'}
          bar={{ pct: buyBar, left: 'buy @ ask', right: 'sell @ bid' }}
        />
        <Stat label="Sweeps" value={String(summary.sweepCount)} sub="aggressive cross-exchange" accent="amber" />
        <Stat label="Blocks" value={String(summary.blockCount)} sub="500+ contracts" accent="violet" />
        <Stat label="0DTE share" value={`${(summary.d0teShare * 100).toFixed(0)}%`} sub="of premium traded" accent="rose" />
      </div>

      {/* 0DTE activity */}
      <div className="rounded-xl border border-amber-500/20 bg-amber-950/10 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Timer className="h-3.5 w-3.5 text-amber-300" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-200/90">
            0DTE activity
          </span>
          <span className="font-mono text-[9px] text-zinc-500">
            {d0te.length} prints · {fmtPrem(d0teCallPrem + d0tePutPrem)} premium · expiring today
          </span>
          <span className="ml-auto flex items-center gap-3 font-mono text-[9px]">
            <span className="text-emerald-300">calls {fmtPrem(d0teCallPrem)}</span>
            <span className="text-rose-300">puts {fmtPrem(d0tePutPrem)}</span>
          </span>
        </div>
        {/* call vs put balance bar */}
        <div className="flex h-2 overflow-hidden rounded-full bg-zinc-900">
          <div
            className="bg-emerald-500/70"
            style={{ width: `${100 * (d0teCallPrem / (d0teCallPrem + d0tePutPrem || 1))}%` }}
          />
          <div
            className="bg-rose-500/70"
            style={{ width: `${100 * (d0tePutPrem / (d0teCallPrem + d0tePutPrem || 1))}%` }}
          />
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        {/* tape */}
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60 xl:col-span-2">
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
            <Radio className="h-3.5 w-3.5 animate-pulse text-teal-400" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
              Live tape — every trade
            </span>
            <div className="ml-auto flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`rounded px-2 py-0.5 text-[9px] font-medium transition ${
                    filter === f.id ? 'bg-teal-950/60 text-teal-300' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
                <tr className="text-[8px] uppercase tracking-wider text-zinc-600">
                  <th className="px-2 py-1.5 font-medium">Time</th>
                  <th className="font-medium">Option</th>
                  <th className="font-medium">Expiry</th>
                  <th className="font-medium">Side</th>
                  <th className="text-right font-medium">Qty</th>
                  <th className="text-right font-medium">Price</th>
                  <th className="text-right font-medium">Premium</th>
                  <th className="text-right font-medium">IV</th>
                  <th className="px-2 font-medium">Exchange</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[10px] tabular-nums">
                {filtered.slice(0, 60).map((p) => (
                  <tr
                    key={p.id}
                    className={`border-b border-zinc-800/30 transition hover:bg-zinc-900/40 ${
                      p.isSweep ? 'bg-amber-950/15' : p.isBlock ? 'bg-violet-950/15' : ''
                    }`}
                  >
                    <td className="px-2 py-1 text-zinc-500">{timeStr(p.ts)}</td>
                    <td className="py-1">
                      <span className={p.optionType === 'call' ? 'text-emerald-300' : 'text-rose-300'}>
                        {cpm(p.strike)}{p.optionType === 'call' ? 'C' : 'P'}
                      </span>
                      <span className="ml-1 text-[8px] text-zinc-600">Δ{Math.abs(p.delta).toFixed(2)}</span>
                    </td>
                    <td className="py-1">
                      <span className={p.is0dte ? 'rounded bg-amber-500/15 px-1 py-0.5 text-[8px] font-bold text-amber-300' : 'text-zinc-500'}>
                        {p.expiry}
                      </span>
                    </td>
                    <td className="py-1">
                      <span
                        className={
                          p.side === 'buy'
                            ? 'font-semibold text-emerald-400'
                            : p.side === 'sell'
                              ? 'font-semibold text-rose-400'
                              : 'text-zinc-400'
                        }
                      >
                        {p.side.toUpperCase()}
                      </span>
                      {p.aggressor !== 'mid' && (
                        <span className="ml-1 text-[8px] text-zinc-600">@{p.aggressor}</span>
                      )}
                    </td>
                    <td className="py-1 text-right">
                      {p.qty}
                      {p.isSweep && <Zap className="ml-1 inline h-2.5 w-2.5 text-amber-300" />}
                      {p.isBlock && <span className="ml-1 text-[8px] text-violet-300">▦</span>}
                    </td>
                    <td className="py-1 text-right text-zinc-400">{p.price < 1 ? p.price.toFixed(2) : p.price.toFixed(2)}</td>
                    <td className="py-1 text-right font-semibold text-zinc-100">{fmtPrem(p.premium)}</td>
                    <td className="py-1 text-right text-zinc-500">{(p.iv * 100).toFixed(0)}%</td>
                    <td className="px-2 py-1 text-[9px] text-zinc-500">{p.exchange}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-6 text-center text-[10px] text-zinc-600">
                      no prints match this filter yet — the tape is filling…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* largest prints + flow pulse */}
        <div className="space-y-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="mb-2 flex items-center gap-1.5">
              <Crown className="h-3.5 w-3.5 text-amber-300" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
                Largest prints
              </span>
            </div>
            <div className="space-y-1.5">
              {largest.map((p, i) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-md border border-zinc-800/60 bg-zinc-900/30 px-2 py-1.5"
                >
                  <span className="w-4 text-[9px] font-bold text-zinc-600">{i + 1}</span>
                  <span className={`font-mono text-[10px] font-semibold ${p.optionType === 'call' ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {cpm(p.strike)}{p.optionType === 'call' ? 'C' : 'P'} · {p.expiry}
                  </span>
                  <span className={`text-[9px] font-semibold ${p.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {p.side.toUpperCase()}
                  </span>
                  <span className="ml-auto font-mono text-[9px] text-zinc-500">×{fmtNum(p.qty, 0)}</span>
                  <span className="font-mono text-[10px] font-bold text-zinc-100">{fmtPrem(p.premium)}</span>
                </div>
              ))}
              {largest.length === 0 && (
                <p className="py-4 text-center text-[10px] text-zinc-600">waiting for prints…</p>
              )}
            </div>
          </div>

          {/* premium flow buckets */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="mb-2 flex items-center gap-1.5">
              <Flame className="h-3.5 w-3.5 text-teal-400" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
                Premium flow buckets
              </span>
            </div>
            <div className="space-y-2">
              {[
                { label: 'CALLS bought @ ask', v: summary.callBuyPremium, color: 'bg-emerald-500/70' },
                { label: 'CALLS sold @ bid', v: summary.callSellPremium, color: 'bg-emerald-800/70' },
                { label: 'PUTS bought @ ask', v: summary.putBuyPremium, color: 'bg-rose-500/70' },
                { label: 'PUTS sold @ bid', v: summary.putSellPremium, color: 'bg-rose-800/70' },
              ].map((b) => {
                const pct = 100 * (b.v / summary.totalPremium || 0);
                return (
                  <div key={b.label}>
                    <div className="mb-0.5 flex justify-between text-[9px]">
                      <span className="text-zinc-400">{b.label}</span>
                      <span className="font-mono text-zinc-200">{fmtPrem(b.v)} · {pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
                      <div className={`h-full rounded-full ${b.color}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 border-t border-zinc-800/60 pt-2 text-[8px] leading-relaxed text-zinc-600">
              Customer-side guess: trades printing at the ask are buyers lifting, at the bid sellers
              hitting. Sweeps are cross-exchange aggressors; blocks are 500+ contract negotiated prints.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  bar,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  bar?: { pct: number; left: string; right: string };
  accent?: 'amber' | 'violet' | 'rose';
}) {
  const accentCls =
    accent === 'amber'
      ? 'text-amber-300'
      : accent === 'violet'
        ? 'text-violet-300'
        : accent === 'rose'
          ? 'text-rose-300'
          : 'text-zinc-100';
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{label}</p>
      <p className={`font-mono text-lg font-bold leading-tight ${accentCls}`}>{value}</p>
      {bar && (
        <div className="mt-1">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-zinc-900">
            <div className="bg-emerald-500/70" style={{ width: `${bar.pct}%` }} />
            <div className="bg-rose-500/70" style={{ width: `${100 - bar.pct}%` }} />
          </div>
          <div className="mt-0.5 flex justify-between text-[8px] text-zinc-600">
            <span>{bar.left}</span>
            <span>{bar.right}</span>
          </div>
        </div>
      )}
      {sub && !bar && <p className="mt-0.5 text-[8px] leading-tight text-zinc-600">{sub}</p>}
    </div>
  );
}

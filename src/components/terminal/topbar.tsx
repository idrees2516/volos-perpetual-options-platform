'use client';

// Terminal top bar: brand, navigation, live asset ticker, engine status.

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Waves, Layers, CircleDot, LineChart, Sparkles, FlaskConical } from 'lucide-react';
import type { UnderlyingId } from '@/lib/types';
import { ASSET_META } from '@/lib/types';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { useCopilot } from '@/stores/copilot-store';
import { fmtNum, fmtPctSigned } from '@/lib/format';

export type ViewId = 'strategies' | 'chain' | 'trade' | 'paper';

const NAV: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  { id: 'strategies', label: 'Strategies', icon: <Layers className="h-3.5 w-3.5" /> },
  { id: 'chain', label: 'Option Chain', icon: <CircleDot className="h-3.5 w-3.5" /> },
  { id: 'trade', label: 'Trading', icon: <LineChart className="h-3.5 w-3.5" /> },
  { id: 'paper', label: 'Paper Desk', icon: <FlaskConical className="h-3.5 w-3.5" /> },
];

interface TopBarProps {
  view: ViewId;
  onView: (v: ViewId) => void;
}

export function TopBar({ view, onView }: TopBarProps) {
  const { market, smooth, connected, source, retry } = useMarket();
  const { underlying, setUnderlying } = useStrategy();
  const { open: copilotOpen, toggle: toggleCopilot } = useCopilot();

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-[#05070a]/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        {/* Brand */}
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-emerald-600 shadow-[0_0_18px_rgba(45,212,191,0.35)]">
            <Waves className="h-4 w-4 text-zinc-950" strokeWidth={2.5} />
          </div>
          <div className="leading-none">
            <p className="text-sm font-bold tracking-tight text-zinc-50">
              Vol<span className="text-teal-400">OS</span>
            </p>
            <p className="text-[8px] uppercase tracking-[0.18em] text-zinc-500">perpetual options terminal</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="order-3 flex w-full gap-1 overflow-x-auto md:order-none md:w-auto">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => onView(n.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition ${
                view === n.id
                  ? 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>

        {/* Asset selector */}
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          {(Object.keys(ASSET_META) as UnderlyingId[]).map((a) => {
            const st = smooth[a] ?? market.assets[a];
            const active = underlying === a;
            return (
              <button
                key={a}
                onClick={() => setUnderlying(a)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[11px] transition ${
                  active ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <span className="text-[9px] text-zinc-500">{ASSET_META[a].symbol}</span>
                {fmtNum(st.spot, st.spot >= 1000 ? 0 : 1)}
                <span className={`text-[9px] ${(st.change24h ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {fmtPctSigned(st.change24h ?? 0, 2)}
                </span>
              </button>
            );
          })}
        </div>

        {/* AI Copilot toggle */}
        <button
          onClick={toggleCopilot}
          title="VolOS Agentic Research Desk — AI agents for technical, chart, macro, volatility, profitability and strategy research"
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition ${
            copilotOpen
              ? 'border-violet-500/50 bg-violet-950/60 text-violet-200 shadow-[0_0_14px_rgba(139,92,246,0.25)]'
              : 'border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:border-violet-800/60 hover:text-violet-300'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          AI Copilot
        </button>

        {/* Engine status */}
        <button
          onClick={retry}
          title={connected ? 'Rust engine streaming live' : 'Client-side simulation fallback — click to retry engine'}
          className="flex items-center gap-1.5"
        >
          <span className={`relative flex h-2 w-2`}>
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${connected ? 'bg-teal-400' : 'bg-amber-400'}`} />
            <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? 'bg-teal-400' : 'bg-amber-400'}`} />
          </span>
          <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
            {connected ? 'rust engine · live' : 'local sim · fallback'}
          </span>
        </button>
      </div>
    </header>
  );
}

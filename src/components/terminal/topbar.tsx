'use client';

// Terminal top bar: brand, MAIN navigation tabs (Strategies · Gamma & Flow ·
// Option Chain · Paper Desk — the tab bar itself is collapsible to icons),
// live asset ticker with REAL exchange prices, AI Copilot, engine status.

import React, { useState } from 'react';
import {
  Waves, Sparkles, Layers, Activity, CircleDot, FlaskConical, LineChart,
  ChevronsLeft, ChevronsRight, Radio,
} from 'lucide-react';
import type { UnderlyingId } from '@/lib/types';
import { ASSET_META } from '@/lib/types';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { useCopilot } from '@/stores/copilot-store';
import { fmtNum, fmtPctSigned } from '@/lib/format';

export type ViewId = 'strategies' | 'gamma' | 'chain' | 'trade' | 'paper';

/** The four MAIN tabs + Trading (compact, still one click away). */
export const MAIN_TABS: { id: ViewId; label: string; icon: React.ReactNode; main: boolean; hint: string }[] = [
  {
    id: 'strategies',
    label: 'Strategies',
    icon: <Layers className="h-3.5 w-3.5" />,
    main: true,
    hint: '131-strategy catalog · payoff up front · intelligence · platforms · backtests',
  },
  {
    id: 'gamma',
    label: 'Gamma & Flow',
    icon: <Activity className="h-3.5 w-3.5" />,
    main: true,
    hint: 'GEX · dealer positioning · heatmaps · options flow · 0DTE · skew',
  },
  {
    id: 'chain',
    label: 'Option Chain',
    icon: <CircleDot className="h-3.5 w-3.5" />,
    main: true,
    hint: 'live chains with per-strike BUY / SELL',
  },
  {
    id: 'paper',
    label: 'Paper Desk',
    icon: <FlaskConical className="h-3.5 w-3.5" />,
    main: true,
    hint: 'fills at real venue BBO',
  },
  {
    id: 'trade',
    label: 'Trading',
    icon: <LineChart className="h-3.5 w-3.5" />,
    main: false,
    hint: 'engine CLOB · $1M demo equity',
  },
];

interface TopBarProps {
  view: ViewId;
  onView: (v: ViewId) => void;
  tabsCollapsed: boolean;
  onToggleTabs: () => void;
}

export function TopBar({ view, onView, tabsCollapsed, onToggleTabs }: TopBarProps) {
  const { market, smooth, connected, live, retry } = useMarket();
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

        {/* Asset selector — REAL live exchange prices */}
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
          {live?.ok && (
            <span
              title={`Real prices: ${live.source} · refreshed ${Math.max(0, Math.round((Date.now() - live.tsMs) / 1000))}s ago`}
              className="flex items-center gap-1 rounded-md bg-emerald-950/40 px-1.5 py-1 text-[8px] font-bold uppercase tracking-wider text-emerald-400 ring-1 ring-emerald-500/30"
            >
              <Radio className="h-2.5 w-2.5 animate-pulse" />
              live
            </span>
          )}
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

      {/* ── MAIN tab bar — collapsible to icon-only strip ── */}
      <div className="border-t border-zinc-800/60">
        <div className="mx-auto flex max-w-[1600px] items-center gap-1 px-4 py-1.5">
          {MAIN_TABS.map((t) => {
            const active = view === t.id;
            return (
              <button
                key={t.id}
                onClick={() => onView(t.id)}
                title={`${t.label} — ${t.hint}`}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition ${
                  active
                    ? t.main
                      ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30'
                      : 'bg-zinc-800/80 text-zinc-100 ring-1 ring-zinc-600'
                    : t.main
                      ? 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200'
                      : 'text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300'
                } ${tabsCollapsed ? 'px-2.5' : ''} ${!t.main && !tabsCollapsed ? 'ml-2 border-l border-zinc-800 pl-3' : ''}`}
              >
                <span className={active ? 'text-teal-400' : 'text-zinc-500'}>
                  {t.icon}
                </span>
                {!tabsCollapsed && <span>{t.label}</span>}
                {!t.main && !tabsCollapsed && (
                  <span className="rounded bg-zinc-800 px-1 text-[8px] uppercase tracking-wide text-zinc-500">
                    desk
                  </span>
                )}
              </button>
            );
          })}

          {/* collapse toggle */}
          <button
            onClick={onToggleTabs}
            title={tabsCollapsed ? 'Expand the tab bar labels' : 'Collapse the tab bar to icons'}
            className="ml-auto flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1.5 text-[9px] font-medium uppercase tracking-wider text-zinc-500 transition hover:text-zinc-200"
          >
            {tabsCollapsed ? <ChevronsRight className="h-3 w-3" /> : <ChevronsLeft className="h-3 w-3" />}
            {!tabsCollapsed && 'collapse tabs'}
          </button>
        </div>
      </div>
    </header>
  );
}

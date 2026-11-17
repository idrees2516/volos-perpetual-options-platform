'use client';

// Terminal top bar: brand, live asset ticker with REAL exchange prices,
// density control, AI Copilot and engine status.
//
// The old MAIN tab strip is RETIRED — navigation moved into the unified
// collapsible Workbench rail (Strategies pinned on top, everything else
// below), so the header stays a clean, slim command bar.
//
// v2 chrome pass: token-driven surfaces (bg-volos-bg …), tabular flashing
// numerals (LiveNum — teal up / rose down), and the persisted density
// toggle (compact | comfortable) that resizes every density-aware panel.

import React from 'react';
import { Waves, Sparkles, Radio, Rows3 } from 'lucide-react';
import type { UnderlyingId } from '@/lib/types';
import { ASSET_META } from '@/lib/types';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { useCopilot } from '@/stores/copilot-store';
import { useDensity } from '@/stores/density-store';
import { fmtNum } from '@/lib/format';
import { LiveNum, LivePct } from '@/components/ui/live-num';

export type ViewId = 'strategies' | 'gamma' | 'chain' | 'trade' | 'paper' | 'quant' | 'orderflow' | 'forecast' | 'scriptlab';

export function TopBar() {
  const { market, smooth, connected, live, retry } = useMarket();
  const { underlying, setUnderlying } = useStrategy();
  const { open: copilotOpen, toggle: toggleCopilot } = useCopilot();
  const { density, toggleDensity } = useDensity();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--volos-edge)] bg-[var(--volos-bg)]/95 backdrop-blur">
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

        {/* Asset selector — REAL live exchange prices, flash-on-change */}
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-[var(--volos-edge)] bg-[var(--volos-surface-1)]/60 p-0.5">
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
                <LiveNum
                  value={st.spot}
                  format={(v) => fmtNum(v, v >= 1000 ? 0 : 1)}
                  title={`${a} spot — flashes teal up / rose down`}
                />
                <LivePct value={st.change24h ?? 0} digits={2} />
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

        {/* Density — compact | comfortable (persisted, resizes every panel) */}
        <button
          onClick={toggleDensity}
          title={`density: ${density} — click to switch (${density === 'compact' ? 'more rows on screen' : 'roomier rows, easier scanning'})`}
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition ${
            density === 'compact'
              ? 'border-teal-700/50 bg-teal-950/40 text-teal-200'
              : 'border-[var(--volos-edge-strong)] bg-[var(--volos-surface-2)] text-zinc-300'
          }`}
        >
          <Rows3 className="h-3.5 w-3.5" />
          {density === 'compact' ? 'compact' : 'comfort'}
        </button>

        {/* AI Copilot toggle */}
        <button
          onClick={toggleCopilot}
          title="VolOS Agentic Research Desk — AI agents for technical, chart, macro, volatility, profitability and strategy research"
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition ${
            copilotOpen
              ? 'border-violet-500/50 bg-violet-950/60 text-violet-200 shadow-[0_0_14px_rgba(139,92,246,0.25)]'
              : 'border-[var(--volos-edge)] bg-[var(--volos-surface-1)]/60 text-zinc-400 hover:border-violet-800/60 hover:text-violet-300'
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

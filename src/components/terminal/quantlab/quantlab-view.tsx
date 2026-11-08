'use client';

// -----------------------------------------------------------------------------
// quantlab/quantlab-view — the QUANT LAB workspace: VolOS's own institutional
// options-analytics surface, powered end-to-end by the native VolQuant engine
// (live Deribit chain + Binance/Bybit/OKX perps + CFTC/SEC/Farside macro).
// No external data vendor, no MCP dependency, no demo mode — every panel is
// realtime and interactive, deeply wired into the same engine the AI Copilot
// uses (vq_* tools) and the /api/quant surface.
//
//   Overview        brief: spot vs dealer levels, IV/VRP, EM, perps, tape
//   GEX & Positioning   levels, strike profile, heatmap, ladder, history
//   Chain & OPEX    per-expiry summary, dual-sided chain, OPEX calendar
//   IV Analytics    term, skew, smile, IV-vs-RV, expected move, surface
//   Probability     risk-neutral PDF with interactive level probe
//   Greeks & TRACE  per-greek profiles, surfaces, forward gamma maps
//   OI & Flow       OI by expiry, PCR, premium tide, futures basis
//   Tape · LIVE     SSE-streamed prints, whales, imbalance, strike heat
//   Perps & Liq     cross-venue OI, funding, CVD, liquidation heatmap
//   ETF & Filings   real ETF flows, COT, Form 4, 13F
//   API Catalog     our endpoint registry + live try-it + engine health
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { Atom, LayoutGrid, Activity, Link2, Sigma, Layers3, Waves, Radio, LineChart, Landmark, BookOpen } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Pill } from './quant-viz';
import { useAgeLabel, useQuant } from './use-quant';
import { OverviewPanel } from './panels-overview';
import { GexPanel } from './panels-gex';
import { ChainPanel, OiPanel } from './panels-chain';
import { IvPanel } from './panels-iv';
import { GreeksPanel, ProbabilityPanel } from './panels-prob';
import { TapePanel } from './panels-tape';
import { PerpsPanel } from './panels-perps';
import { MacroPanel } from './panels-macro';
import { CatalogPanel } from './panels-catalog';

const SYMBOLS = [
  { id: 'BTC', label: 'BTC' },
  { id: 'ETH', label: 'ETH' },
  { id: 'SOL', label: 'SOL' },
] as const;

const OPTIONS_SYMBOLS = new Set(['BTC', 'ETH']);

const TABS = [
  { id: 'overview', label: 'Overview', icon: <LayoutGrid className="h-3 w-3" /> },
  { id: 'gex', label: 'GEX & Positioning', icon: <Activity className="h-3 w-3" /> },
  { id: 'chain', label: 'Chain & OPEX', icon: <Link2 className="h-3 w-3" /> },
  { id: 'iv', label: 'IV Analytics', icon: <Sigma className="h-3 w-3" /> },
  { id: 'prob', label: 'Probability', icon: <Atom className="h-3 w-3" /> },
  { id: 'greeks', label: 'Greeks & TRACE', icon: <Layers3 className="h-3 w-3" /> },
  { id: 'oi', label: 'OI & Flow', icon: <Waves className="h-3 w-3" /> },
  { id: 'tape', label: 'Tape · Live', icon: <Radio className="h-3 w-3" /> },
  { id: 'perps', label: 'Perps & Liquidations', icon: <LineChart className="h-3 w-3" /> },
  { id: 'macro', label: 'ETF & Filings', icon: <Landmark className="h-3 w-3" /> },
  { id: 'catalog', label: 'API Catalog', icon: <BookOpen className="h-3 w-3" /> },
] as const;

export function QuantLabView() {
  const [symbol, setSymbol] = useState<string>('BTC');
  const [tab, setTab] = useState<string>('overview');
  const hasOptions = OPTIONS_SYMBOLS.has(symbol);
  const health = useQuant<{ sources: { name: string; ok: boolean; ageMs: number | null }[] }>('/catalog', { view: 'status' }, { pollMs: 20000 });
  const age = useAgeLabel(health.fetchedAt);
  const okCount = (health.data?.sources ?? []).filter((s) => s.ok).length;

  return (
    <div className="space-y-2">
      {/* header bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Atom className="h-4 w-4 text-teal-400" />
          <div className="leading-none">
            <p className="text-[12px] font-bold tracking-tight text-zinc-100">
              Quant<span className="text-teal-400">Lab</span>
            </p>
            <p className="mt-0.5 text-[8px] uppercase tracking-[0.14em] text-zinc-600">
              volquant native engine · dealer positioning · gex · iv · pdf · tape · macro — all realtime, zero vendors
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
          {SYMBOLS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSymbol(s.id)}
              title={OPTIONS_SYMBOLS.has(s.id) ? 'full options analytics' : 'perps & market only (no SOL options on free venues)'}
              className={`rounded-md px-2.5 py-1 font-mono text-[10.5px] font-medium transition ${symbol === s.id ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <Pill tone="emerald" title={`sources: ${(health.data?.sources ?? []).filter((s) => s.ok).map((s) => s.name).join(' · ')}`}>
          live · {okCount}/8 sources · {age}
        </Pill>
        <span className="hidden font-mono text-[8.5px] text-zinc-600 lg:inline">deribit · binance · bybit · okx · cftc · sec · farside</span>
      </div>

      {/* tabs */}
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="h-8 w-full min-w-0 justify-start overflow-x-auto bg-zinc-900/60 p-0.5">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="h-7 shrink-0 gap-1.5 whitespace-nowrap px-3 text-[10.5px] data-[state=active]:bg-zinc-800 data-[state=active]:text-teal-300"
            >
              {t.icon}
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-2">
          <OverviewPanel symbol={symbol} hasOptions={hasOptions} />
        </TabsContent>
        <TabsContent value="gex" className="mt-2">
          <GexPanel symbol={symbol} hasOptions={hasOptions} />
        </TabsContent>
        <TabsContent value="chain" className="mt-2">
          <ChainPanel symbol={symbol} hasOptions={hasOptions} />
        </TabsContent>
        <TabsContent value="iv" className="mt-2">
          <IvPanel symbol={symbol} hasOptions={hasOptions} />
        </TabsContent>
        <TabsContent value="prob" className="mt-2">
          <ProbabilityPanel symbol={symbol} hasOptions={hasOptions} />
        </TabsContent>
        <TabsContent value="greeks" className="mt-2">
          <GreeksPanel symbol={symbol} hasOptions={hasOptions} />
        </TabsContent>
        <TabsContent value="oi" className="mt-2">
          <OiPanel symbol={symbol} hasOptions={hasOptions} />
        </TabsContent>
        <TabsContent value="tape" className="mt-2">
          <TapePanel symbol={symbol} hasOptions={hasOptions} />
        </TabsContent>
        <TabsContent value="perps" className="mt-2">
          <PerpsPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="macro" className="mt-2">
          <MacroPanel />
        </TabsContent>
        <TabsContent value="catalog" className="mt-2">
          <CatalogPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

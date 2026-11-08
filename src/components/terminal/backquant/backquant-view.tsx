'use client';

// -----------------------------------------------------------------------------
// backquant/backquant-view — the BackQuant WORKSPACE.
//
// A full institutional options-analytics surface over the BackQuant v2 data
// plane (live REST when BACKQUANT_API_KEY is set, deterministic demo engine
// otherwise — every panel labeled):
//
//   Overview        brief: spot vs gamma levels, expected move, perps, tape
//   GEX             key levels, strike profile, strike×expiry heatmap, ladder,
//                   dealer hedge flow
//   Chain & OPEX    filtered chain, cross-venue book, expiry summary, calendar
//   IV Analytics    term structure, smiles, skew, constant-maturity, IV-RV,
//                   VRP, expected move, calibrated range
//   Greeks & TRACE  per-greek profiles, 3D surfaces, forward TRACE maps
//   OI & Flow       OI by expiry, PCR, premium tide, futures basis, strike heat
//   Tape            LIVE streaming prints (SSE), whales, imbalance, flow
//   Liquidations    heatmap + distribution
//   Market          bundle (price·OI·funding), CVD, liquidations, funding
//   ETF & Filings   spot ETF flows/AUM/premium, COT, Form 4, 13F
//   API Catalog     all 70 endpoints, parameterized try-it + MCP surface
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { Database, LayoutGrid, Activity, Link2, Sigma, Layers3, Waves, Flame, LineChart, Landmark, BookOpen, Info } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBqMode } from './use-bq';
import { ModeBadge } from './bq-viz';
import { BqOverviewPanel, TapePanel, LiquidationPanel, MarketPanel, MacroPanel } from './bq-panels2';
import { GexPanel, ChainPanel, IvPanel, GreeksPanel, OiPanel } from './bq-panels';
import { CatalogBrowser } from './catalog-browser';

const SYMBOLS = [
  { id: 'BTCUSDT', label: 'BTC' },
  { id: 'ETHUSDT', label: 'ETH' },
  { id: 'SOLUSDT', label: 'SOL' },
] as const;

const TABS = [
  { id: 'overview', label: 'Overview', icon: <LayoutGrid className="h-3 w-3" /> },
  { id: 'gex', label: 'GEX & Positioning', icon: <Activity className="h-3 w-3" /> },
  { id: 'chain', label: 'Chain & OPEX', icon: <Link2 className="h-3 w-3" /> },
  { id: 'iv', label: 'IV Analytics', icon: <Sigma className="h-3 w-3" /> },
  { id: 'greeks', label: 'Greeks & TRACE', icon: <Layers3 className="h-3 w-3" /> },
  { id: 'oi', label: 'OI & Flow', icon: <Waves className="h-3 w-3" /> },
  { id: 'tape', label: 'Tape · Live', icon: <Database className="h-3 w-3" /> },
  { id: 'liquidations', label: 'Liquidations', icon: <Flame className="h-3 w-3" /> },
  { id: 'market', label: 'Market', icon: <LineChart className="h-3 w-3" /> },
  { id: 'macro', label: 'ETF & Filings', icon: <Landmark className="h-3 w-3" /> },
  { id: 'catalog', label: 'API Catalog', icon: <BookOpen className="h-3 w-3" /> },
] as const;

export function BackQuantView() {
  const [symbol, setSymbol] = useState<string>('BTCUSDT');
  const mode = useBqMode();
  const [tab, setTab] = useState<string>('overview');

  return (
    <div className="space-y-2">
      {/* header bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Database className="h-4 w-4 text-teal-400" />
          <div className="leading-none">
            <p className="text-[12px] font-bold tracking-tight text-zinc-100">
              Back<span className="text-teal-400">Quant</span> Analytics
            </p>
            <p className="mt-0.5 text-[8px] uppercase tracking-[0.14em] text-zinc-600">
              dealer positioning · gex · iv · greeks · tape · 70 v2 endpoints · 23 mcp tools
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
          {SYMBOLS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSymbol(s.id)}
              className={`rounded-md px-2.5 py-1 font-mono text-[10.5px] font-medium transition ${
                symbol === s.id ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <ModeBadge mode={mode} />
        {mode === 'demo' ? (
          <span
            className="flex items-center gap-1 text-[8.5px] text-zinc-500"
            title="Set BACKQUANT_API_KEY in .env to switch every panel, tool and the MCP server to the live BackQuant v2 API"
          >
            <Info className="h-3 w-3" />
            demo engine — add BACKQUANT_API_KEY for live data
          </span>
        ) : null}
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
          <BqOverviewPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="gex" className="mt-2">
          <GexPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="chain" className="mt-2">
          <ChainPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="iv" className="mt-2">
          <IvPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="greeks" className="mt-2">
          <GreeksPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="oi" className="mt-2">
          <OiPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="tape" className="mt-2">
          <TapePanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="liquidations" className="mt-2">
          <LiquidationPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="market" className="mt-2">
          <MarketPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="macro" className="mt-2">
          <MacroPanel symbol={symbol} />
        </TabsContent>
        <TabsContent value="catalog" className="mt-2">
          <CatalogBrowser symbol={symbol} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

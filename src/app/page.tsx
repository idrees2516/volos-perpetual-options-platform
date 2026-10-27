'use client';

// VolOS — perpetual options strategy terminal.
// Single-page app with a left SideNav rail for all major functionalities:
// the unified Strategies workspace / Gamma & Flow Lab / Option Chain /
// Trading / Paper Desk, plus the Agentic Research Desk (AI Copilot).

import React, { useState } from 'react';
import { MarketProvider } from '@/hooks/use-market';
import { TopBar, type ViewId } from '@/components/terminal/topbar';
import { SideNav } from '@/components/terminal/side-nav';
import { StrategiesView } from '@/components/terminal/strategies/strategies-view';
import { GammaLabView } from '@/components/terminal/gamma-lab/gamma-lab-view';
import { ChainView } from '@/components/terminal/chain-view';
import { TradeView } from '@/components/terminal/trade-view';
import { PaperView } from '@/components/terminal/paper-view';
import { CopilotPanel, MarketSpotBridge } from '@/components/terminal/copilot/copilot-panel';
import { useCopilot } from '@/stores/copilot-store';

function Terminal() {
  const [view, setView] = useState<ViewId>('strategies');
  const [navCollapsed, setNavCollapsed] = useState(false);
  const copilotOpen = useCopilot((s) => s.open);

  return (
    <div className="flex min-h-screen flex-col bg-[#05070a] text-zinc-200">
      <TopBar view={view} onView={setView} />
      <div className="flex flex-1 overflow-hidden">
        {/* left navigation rail — all major functionalities */}
        <SideNav
          view={view}
          onView={setView}
          collapsed={navCollapsed}
          onToggleCollapsed={() => setNavCollapsed((c) => !c)}
        />
        <main
          className={`min-w-0 flex-1 transition-all ${
            copilotOpen ? 'mx-auto w-full max-w-[1600px] px-4 py-3' : 'mx-auto w-full max-w-[1600px] px-4 py-3'
          }`}
        >
          {view === 'strategies' && <StrategiesView onOpenTrade={() => setView('trade')} />}
          {view === 'gamma' && <GammaLabView />}
          {view === 'chain' && <ChainView onOpenBuilder={() => setView('strategies')} />}
          {view === 'trade' && <TradeView onOpenBuilder={() => setView('strategies')} />}
          {view === 'paper' && <PaperView />}
        </main>
        <CopilotPanel view={view} onView={setView} />
      </div>
      <footer className="border-t border-zinc-800/60 px-4 py-2.5">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 text-[9px] text-zinc-600">
          <p>
            VolOS — perpetual options terminal. Simulated market data; research prototype, not investment advice.
          </p>
          <p className="font-mono">
            rust engine: axum · clob · svi · everlasting · 131 strategies/25 legs &nbsp;|&nbsp; gamma lab: gex ·
            vex · dealer positioning · flow · 0dte &nbsp;|&nbsp; ai desk: vercel ai sdk · 6 agents · glm
            &nbsp;|&nbsp; frontend: next.js 16.3.4
          </p>
        </div>
      </footer>
      <MarketSpotBridge />
    </div>
  );
}

export default function Home() {
  return (
    <MarketProvider>
      <Terminal />
    </MarketProvider>
  );
}

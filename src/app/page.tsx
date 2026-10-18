'use client';

// VolOS — perpetual options strategy terminal.
// Single-page app: Builder / Intent Wizard / Option Chain / Strategy Library /
// Trading + the Agentic Research Desk (AI Copilot) side panel.

import React, { useState } from 'react';
import { MarketProvider } from '@/hooks/use-market';
import { TopBar, type ViewId } from '@/components/terminal/topbar';
import { BuilderView } from '@/components/terminal/builder-view';
import { WizardView } from '@/components/terminal/wizard-view';
import { ChainView } from '@/components/terminal/chain-view';
import { StrategyLibraryView } from '@/components/terminal/strategy-library-view';
import { TradeView } from '@/components/terminal/trade-view';
import { CopilotPanel, MarketSpotBridge } from '@/components/terminal/copilot/copilot-panel';
import { useCopilot } from '@/stores/copilot-store';

function Terminal() {
  const [view, setView] = useState<ViewId>('builder');
  const copilotOpen = useCopilot((s) => s.open);

  return (
    <div className="flex min-h-screen flex-col bg-[#05070a] text-zinc-200">
      <TopBar view={view} onView={setView} />
      <div className="flex flex-1 overflow-hidden">
        <main
          className={`min-w-0 flex-1 transition-all ${
            copilotOpen ? 'mx-auto w-full max-w-[1600px] px-4 py-3' : 'mx-auto w-full max-w-[1600px] px-4 py-3'
          }`}
        >
          {view === 'builder' && <BuilderView />}
          {view === 'wizard' && <WizardView onOpenBuilder={() => setView('builder')} />}
          {view === 'chain' && <ChainView onOpenBuilder={() => setView('builder')} />}
          {view === 'library' && (
            <StrategyLibraryView onOpenBuilder={() => setView('builder')} onOpenTrade={() => setView('trade')} />
          )}
          {view === 'trade' && <TradeView onOpenBuilder={() => setView('builder')} />}
        </main>
        <CopilotPanel view={view} onView={setView} />
      </div>
      <footer className="border-t border-zinc-800/60 px-4 py-2.5">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 text-[9px] text-zinc-600">
          <p>
            VolOS — perpetual options terminal. Simulated market data; research prototype, not investment advice.
          </p>
          <p className="font-mono">
            rust engine: axum · clob · svi · everlasting · 118 strategies/25 legs &nbsp;|&nbsp; ai desk: vercel ai sdk
            · 6 agents · glm &nbsp;|&nbsp; frontend: next.js 16.3.4
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

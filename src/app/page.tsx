'use client';

// VolOS — perpetual options strategy terminal.
// Single-page app: Builder / Intent Wizard / Option Chain / Research.

import React, { useState } from 'react';
import { MarketProvider } from '@/hooks/use-market';
import { TopBar, type ViewId } from '@/components/terminal/topbar';
import { BuilderView } from '@/components/terminal/builder-view';
import { WizardView } from '@/components/terminal/wizard-view';
import { ChainView } from '@/components/terminal/chain-view';
import { ResearchView } from '@/components/terminal/research-view';

function Terminal() {
  const [view, setView] = useState<ViewId>('builder');

  return (
    <div className="flex min-h-screen flex-col bg-[#05070a] text-zinc-200">
      <TopBar view={view} onView={setView} />
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-3">
        {view === 'builder' && <BuilderView />}
        {view === 'wizard' && <WizardView onOpenBuilder={() => setView('builder')} />}
        {view === 'chain' && <ChainView onOpenBuilder={() => setView('builder')} />}
        {view === 'research' && <ResearchView />}
      </main>
      <footer className="border-t border-zinc-800/60 px-4 py-2.5">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 text-[9px] text-zinc-600">
          <p>
            VolOS — perpetual options strategy terminal. Simulated market data; research prototype, not investment advice.
          </p>
          <p className="font-mono">
            rust engine: axum · black-scholes · svi · everlasting baskets &nbsp;|&nbsp; frontend: next.js 16.3.4
          </p>
        </div>
      </footer>
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

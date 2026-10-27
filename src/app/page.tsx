'use client';

// VolOS — perpetual options strategy terminal.
// Single-page app: MAIN tabs (Strategies · Gamma & Flow · Option Chain ·
// Paper Desk, collapsible) plus the left SideNav rail with every
// functionality (incl. Trading) and the Agentic Research Desk (AI Copilot).
//
// The active view, the nav/tab collapse state AND the selected strategy
// (catalog choice + custom strategy legs) all persist across reloads.

import React, { useEffect, useState } from 'react';
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
import { rehydrateStrategy } from '@/stores/strategy-store';

const VALID_VIEWS: ViewId[] = ['strategies', 'gamma', 'chain', 'trade', 'paper'];

/** localStorage-backed state — restored after mount to avoid SSR mismatch. */
function usePersistedFlag(key: string, initial: boolean): [boolean, () => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) setValue(saved === '1');
    } catch {
      /* private mode */
    }
  }, [key]);
  const toggle = () => {
    setValue((v) => {
      const next = !v;
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  return [value, toggle];
}

function Terminal() {
  const [view, setView] = useState<ViewId>('strategies');
  const [navCollapsed, toggleNavCollapsed] = usePersistedFlag('volos-nav-collapsed', false);
  const [tabsCollapsed, toggleTabsCollapsed] = usePersistedFlag('volos-tabs-collapsed', false);
  const copilotOpen = useCopilot((s) => s.open);

  // Restore the persisted view + strategy selection after mount.
  useEffect(() => {
    rehydrateStrategy();
    try {
      const saved = localStorage.getItem('volos-view') as ViewId | null;
      if (saved && VALID_VIEWS.includes(saved)) setView(saved);
    } catch {
      /* private mode */
    }
  }, []);

  // Persist the active main tab.
  useEffect(() => {
    try {
      localStorage.setItem('volos-view', view);
    } catch {
      /* ignore */
    }
  }, [view]);

  return (
    <div className="flex min-h-screen flex-col bg-[#05070a] text-zinc-200">
      <TopBar view={view} onView={setView} tabsCollapsed={tabsCollapsed} onToggleTabs={toggleTabsCollapsed} />
      <div className="flex flex-1 overflow-hidden">
        {/* left navigation rail — all major functionalities */}
        <SideNav
          view={view}
          onView={setView}
          collapsed={navCollapsed}
          onToggleCollapsed={toggleNavCollapsed}
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
            VolOS — perpetual options terminal. Real prices: Binance · Bybit · OKX · Deribit index. Research prototype, not investment advice.
          </p>
          <p className="font-mono">
            rust engine: axum · clob · svi · everlasting · 131 strategies/25 legs &nbsp;|&nbsp; gamma lab: gex ·
            vex · dealer positioning · flow · 0dte &nbsp;|&nbsp; venues: deribit · bybit · okx · aevo · paradex ·
            derive · binance · hyperliquid · lighter &nbsp;|&nbsp; ai desk: vercel ai sdk · 6 agents · glm
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

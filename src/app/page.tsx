'use client';

// VolOS — perpetual options strategy terminal.
//
// TWO-SIDED COLLAPSIBLE WORKBENCH shell:
//   • Left rail  — ANALYTICS     (Gamma & Flow · Option Chain · Trading)
//   • Right rail — STRATEGY LAB  (Strategies · Paper Desk)
//   • Center     — the active workspace under a breadcrumb header
//
// The former top MAIN tab strip is retired; each rail collapses to a slim
// icon strip (keyboard `[` / `]`), and the active view, rail states and the
// selected strategy all persist across reloads. The AI Copilot is grounded
// in the live terminal context via CopilotContextBridge.

import { useEffect, useState } from 'react';
import { MarketProvider } from '@/hooks/use-market';
import { TopBar, type ViewId } from '@/components/terminal/topbar';
import { Workbench, useRailHotkeys } from '@/components/terminal/workbench';
import { StrategiesView } from '@/components/terminal/strategies/strategies-view';
import { GammaLabView } from '@/components/terminal/gamma-lab/gamma-lab-view';
import { QuantLabView } from '@/components/terminal/quantlab/quantlab-view';
import { ChainView } from '@/components/terminal/chain-view';
import { TradeView } from '@/components/terminal/trade-view';
import { PaperView } from '@/components/terminal/paper-view';
import { CopilotPanel, MarketSpotBridge, CopilotContextBridge } from '@/components/terminal/copilot/copilot-panel';
import { useCopilot } from '@/stores/copilot-store';
import { rehydrateStrategy } from '@/stores/strategy-store';
import { usePersistedFlag } from '@/hooks/use-persisted-flag';

const VALID_VIEWS: ViewId[] = ['strategies', 'gamma', 'quant', 'chain', 'trade', 'paper'];

function Terminal() {
  const [view, setView] = useState<ViewId>('strategies');
  const [analyticsCollapsed, toggleAnalytics] = usePersistedFlag('volos-rail-analytics-collapsed', false);
  const [labCollapsed, toggleLab] = usePersistedFlag('volos-rail-lab-collapsed', false);
  const copilotOpen = useCopilot((s) => s.open);
  useRailHotkeys(toggleAnalytics, toggleLab);

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

  // Persist the active workspace.
  useEffect(() => {
    try {
      localStorage.setItem('volos-view', view);
    } catch {
      /* private mode */
    }
  }, [view]);

  return (
    <div className="flex min-h-screen flex-col bg-[#05070a] text-zinc-200">
      <TopBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Workbench
          view={view}
          onView={setView}
          analyticsCollapsed={analyticsCollapsed}
          onToggleAnalytics={toggleAnalytics}
          labCollapsed={labCollapsed}
          onToggleLab={toggleLab}
        >
          {view === 'strategies' && <StrategiesView onOpenTrade={() => setView('trade')} />}
          {view === 'gamma' && <GammaLabView />}
          {view === 'quant' && <QuantLabView />}
          {view === 'chain' && <ChainView onOpenBuilder={() => setView('strategies')} />}
          {view === 'trade' && <TradeView onOpenBuilder={() => setView('strategies')} />}
          {view === 'paper' && <PaperView />}
        </Workbench>
        <CopilotPanel view={view} onView={setView} />
      </div>
      <footer className="border-t border-zinc-800/60 px-4 py-2.5">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 text-[9px] text-zinc-600">
          <p>
            VolOS — perpetual options terminal. Real prices: Binance · Bybit · OKX · Deribit index. Research prototype, not investment advice.
          </p>
          <p className="font-mono">
            rust engine: axum · clob · svi · everlasting · 131 strategies/25 legs &nbsp;|&nbsp; quant lab: volquant native ·
            deribit chain · gex · iv/pdf · sse tape · perps &nbsp;|&nbsp; gamma lab: gex ·
            vex · dealer positioning · flow · 0dte &nbsp;|&nbsp; venues: deribit · bybit · okx · aevo · paradex ·
            derive · binance · hyperliquid · lighter &nbsp;|&nbsp; ai desk: vercel ai sdk · 6 agents · glm
            &nbsp;|&nbsp; frontend: next.js 16.3.4
          </p>
        </div>
      </footer>
      <MarketSpotBridge />
      <CopilotContextBridge view={view} />
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

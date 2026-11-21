'use client';

// VolOS — perpetual options strategy terminal.
//
// UNIFIED COLLAPSIBLE WORKBENCH shell:
//   • One rail   — STRATEGIES pinned on top, then Paper Desk and every
//                  analytics view below (the old left/right panels merged)
//   • Center     — the active workspace under a breadcrumb header
//   • Right      — the AI Copilot drawer (grounded in live terminal context)
//
// The former two-sided shell (left Analytics rail + right Strategy Lab rail)
// is retired; the merged rail collapses to a slim icon strip (keyboard `[` / `]`),
// and the active view, rail state and the selected strategy all persist across
// reloads. The AI Copilot is grounded in the live terminal context via
// CopilotContextBridge.

import { useEffect } from 'react';
import { MarketProvider } from '@/hooks/use-market';
import { usePersistedString } from '@/hooks/use-persisted-state';
import { TopBar, type ViewId } from '@/components/terminal/topbar';
import { Workbench, useRailHotkeys } from '@/components/terminal/workbench';
import { StrategiesView } from '@/components/terminal/strategies/strategies-view';
import { GammaLabView } from '@/components/terminal/gamma-lab/gamma-lab-view';
import { QuantLabView } from '@/components/terminal/quantlab/quantlab-view';
import { OrderFlowView } from '@/components/terminal/orderflow/orderflow-view';
import { ForecastView } from '@/components/terminal/forecast/forecast-view';
import { ChainView } from '@/components/terminal/chain-view';
import { TradeView } from '@/components/terminal/trade-view';
import { PaperView } from '@/components/terminal/paper-view';
import { ScriptLabView } from '@/components/terminal/scriptlab/scriptlab-view';
import { MentalModelsView } from '@/components/terminal/models/mental-models-view';
import { StudioView } from '@/components/terminal/studio/studio-view';
import { CopilotPanel, MarketSpotBridge, CopilotContextBridge } from '@/components/terminal/copilot/copilot-panel';
import { useCopilot } from '@/stores/copilot-store';
import { rehydrateStrategy } from '@/stores/strategy-store';
import { usePersistedFlag } from '@/hooks/use-persisted-flag';

const VALID_VIEWS: ViewId[] = ['strategies', 'models', 'studio', 'gamma', 'quant', 'orderflow', 'forecast', 'chain', 'trade', 'paper', 'scriptlab'];

function Terminal() {
  // The active workspace persisted as an external store — restored without a
  // setState-in-effect (SSR snapshot `strategies`, reconciled after hydration).
  const [savedView, setView] = usePersistedString('volos-view', 'strategies');
  const view: ViewId = VALID_VIEWS.includes(savedView as ViewId) ? (savedView as ViewId) : 'strategies';
  const [railCollapsed, toggleRail] = usePersistedFlag('volos-rail-collapsed', false);
  const copilotOpen = useCopilot((s) => s.open);
  useRailHotkeys(toggleRail);

  // Restore the persisted strategy selection after mount (zustand store — not React state).
  useEffect(() => {
    rehydrateStrategy();
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-[#05070a] text-zinc-200">
      <TopBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Workbench view={view} onView={(v) => setView(v)} collapsed={railCollapsed} onToggleCollapsed={toggleRail}>
          {view === 'strategies' && <StrategiesView onOpenTrade={() => setView('trade')} />}
          {view === 'models' && <MentalModelsView />}
          {view === 'studio' && <StudioView />}
          {view === 'gamma' && <GammaLabView />}
          {view === 'quant' && <QuantLabView />}
          {view === 'orderflow' && <OrderFlowView />}
          {view === 'forecast' && <ForecastView />}
          {view === 'chain' && <ChainView onOpenBuilder={() => setView('strategies')} />}
          {view === 'trade' && <TradeView onOpenBuilder={() => setView('strategies')} />}
          {view === 'paper' && <PaperView />}
          {view === 'scriptlab' && <ScriptLabView />}
        </Workbench>
        <CopilotPanel view={view} onView={setView} />
      </div>
      <footer className="border-t border-zinc-800/60 px-4 py-2.5">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 text-[9px] text-zinc-600">
          <p>
            VolOS — perpetual options terminal. Real prices: Binance · Bybit · OKX · Deribit index. Research prototype, not investment advice.
          </p>
          <p className="font-mono">
            rust engine: axum · clob · svi · everlasting · 131 strategies/25 legs &nbsp;|&nbsp; script lab: volscript · pine-style indicators & strategies · backtests · ai codegen &nbsp;|&nbsp; mental models: course-map · 3D surfaces · bsm/greeks · svi/dupire/varswap · exotics zoo · gamma scalper &nbsp;|&nbsp; quant lab: volquant native ·
            deribit chain · gex · iv/pdf · sse tape · perps &nbsp;|&nbsp; gamma lab: gex ·
            vex · dealer positioning · flow · 0dte &nbsp;|&nbsp; order flow: heatmap · absorption/iceberg · venue comparison ·
            session levels · liquidations &nbsp;|&nbsp; forecast: conformal intervals on flow bars · flowx/ensemble/ar/theta ·
            cross-validated coverage &nbsp;|&nbsp; venues: deribit · bybit · okx · aevo · paradex ·
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

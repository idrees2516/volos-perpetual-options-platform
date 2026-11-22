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
//
// PERFORMANCE: every workspace view and the copilot drawer are lazy-loaded
// (next/dynamic, ssr off, one skeleton) — the initial payload ships only the
// shell + the persisted view's chunk instead of all twelve terminals at once;
// each chunk is browser-cached for later switches.

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import React from 'react';
import { MarketProvider } from '@/hooks/use-market';
import { usePersistedString } from '@/hooks/use-persisted-state';
import { TopBar, type ViewId } from '@/components/terminal/topbar';
import { Workbench, useRailHotkeys } from '@/components/terminal/workbench';
import { useCopilot } from '@/stores/copilot-store';
import { rehydrateStrategy } from '@/stores/strategy-store';
import { usePersistedFlag } from '@/hooks/use-persisted-flag';

/** One shared loading skeleton for every lazily-mounted view. */
function ViewLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
        <p className="font-mono text-[10px] tracking-widest text-zinc-600">LOADING TERMINAL…</p>
      </div>
    </div>
  );
}

/** A view chunk failed to load (dev-server restart mid-session, network
 * hiccup behind the preview proxy…). Without a boundary this leaves either
 * an eternal spinner or a blank workspace; with it the view recovers on the
 * next click — automatic once, then a manual retry button. */
class ViewErrorBoundary extends React.Component<
  { children: React.ReactNode; viewId: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: { viewId: string }) {
    if (prev.viewId !== this.props.viewId && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-5">
          <p className="font-mono text-[10px] tracking-widest text-amber-400/90">TERMINAL CHUNK FAILED TO LOAD</p>
          <p className="text-center text-[11px] leading-relaxed text-zinc-500">
            The dev server was likely restarted mid-session. Switch views or retry —
            the chunk re-fetches fresh.
          </p>
          <button
            onClick={() => this.setState({ failed: false })}
            className="rounded-md border border-teal-700/60 bg-teal-950/50 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-teal-200 transition hover:bg-teal-900/60"
          >
            retry load
          </button>
        </div>
      </div>
    );
  }
}

/** Lazy-load a named view export (every view is a named export in this codebase). */
function lazyNamed<P>(loader: () => Promise<Record<string, unknown>>, pick: string) {
  return dynamic(() => loader().then((m) => ({ default: m[pick] as React.ComponentType<P> })), {
    ssr: false,
    loading: ViewLoading,
  });
}

const StrategiesView = lazyNamed<{ onOpenTrade: () => void }>(() => import('@/components/terminal/strategies/strategies-view'), 'StrategiesView');
const MentalModelsView = lazyNamed<object>(() => import('@/components/terminal/models/mental-models-view'), 'MentalModelsView');
const StudioView = lazyNamed<object>(() => import('@/components/terminal/studio/studio-view'), 'StudioView');
const GammaLabView = lazyNamed<object>(() => import('@/components/terminal/gamma-lab/gamma-lab-view'), 'GammaLabView');
const QuantLabView = lazyNamed<object>(() => import('@/components/terminal/quantlab/quantlab-view'), 'QuantLabView');
const OrderFlowView = lazyNamed<object>(() => import('@/components/terminal/orderflow/orderflow-view'), 'OrderFlowView');
const ForecastView = lazyNamed<object>(() => import('@/components/terminal/forecast/forecast-view'), 'ForecastView');
const ChainView = lazyNamed<{ onOpenBuilder: () => void }>(() => import('@/components/terminal/chain-view'), 'ChainView');
const TradeView = lazyNamed<{ onOpenBuilder: () => void }>(() => import('@/components/terminal/trade-view'), 'TradeView');
const PaperView = lazyNamed<object>(() => import('@/components/terminal/paper-view'), 'PaperView');
const ScriptLabView = lazyNamed<object>(() => import('@/components/terminal/scriptlab/scriptlab-view'), 'ScriptLabView');
const PriceChartView = lazyNamed<object>(() => import('@/components/terminal/chartdesk/price-chart-view'), 'PriceChartView');

const CopilotPanel = lazyNamed<{ view: ViewId; onView: (v: ViewId) => void }>(() => import('@/components/terminal/copilot/copilot-panel'), 'CopilotPanel');
import { MarketSpotBridge, CopilotContextBridge } from '@/components/terminal/copilot/copilot-bridges';

const VALID_VIEWS: ViewId[] = ['strategies', 'models', 'studio', 'gamma', 'quant', 'orderflow', 'forecast', 'chain', 'trade', 'paper', 'scriptlab', 'chartdesk'];

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
    // fixed terminal shell: topbar + scrollable workspace + footer, all inside
    // the viewport (h-dvh) — every view scrolls internally, the footer always
    // sits at the bottom and never floats over content.
    <div className="flex flex-col overflow-hidden bg-[#05070a] text-zinc-200" style={{ height: '100dvh' }}>
      <TopBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Workbench view={view} onView={(v) => setView(v)} collapsed={railCollapsed} onToggleCollapsed={toggleRail}>
          <ViewErrorBoundary key={view} viewId={view}>
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
            {view === 'chartdesk' && <PriceChartView />}
          </ViewErrorBoundary>
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

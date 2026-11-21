'use client';

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED WORKBENCH — single collapsible navigation shell.
//
//   ONE RAIL · Strategies pinned on TOP, then everything else below:
//     Strategy Lab  — Strategies · Paper Desk
//     Analytics     — Gamma & Flow · Order Flow · Forecast · Quant Lab ·
//                     Option Chain · Trading
//
// The former two-sided shell (LEFT Analytics rail + RIGHT Strategy Lab rail)
// is RETIRED — both panels are collapsed into this single rail (keyboard `[`
// or `]` toggles it). The center column renders the active view under a
// professional breadcrumb header; the AI Copilot keeps its own drawer on the (studio edit)
// far right.
//
// The rail also carries two live footers: the loaded strategy (from the old
// Strategy Lab rail) and the live market pulse (real exchange prices, from
// the old Analytics rail) — so the merged rail stays informative even as
// pure navigation. Collapse state persists across reloads.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect } from 'react';
import {
  Activity, Brain, CircleDot, LineChart, ChartLine, Layers, FlaskConical, Atom, Flame, Sigma,
  BarChart3, Dna, ChevronsLeft, ChevronsRight, ChevronRight, Braces,
  TrendingUp, TrendingDown, Radio, ChartCandlestick,
} from 'lucide-react';
import type { ViewId } from './topbar';
import type { UnderlyingId } from '@/lib/types';
import { ASSET_META } from '@/lib/types';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { fmtNum, fmtPctSigned } from '@/lib/format';

export type SideId = 'analytics' | 'lab';

interface RailItem {
  id: ViewId;
  label: string;
  icon: React.ReactNode;
  hint: string;
}

/** Strategy Lab group — pinned to the TOP of the unified rail. */
const LAB_ITEMS: RailItem[] = [
  { id: 'strategies', label: 'Strategies', icon: <Layers className="h-4 w-4" />, hint: '131 catalog · payoff up front · intelligence · builder · backtests' },
  { id: 'paper', label: 'Paper Desk', icon: <FlaskConical className="h-4 w-4" />, hint: 'deploy strategy packages · fills at real venue BBO' },
];

/** Analytics group — everything else, below the Strategy Lab group. */
const ANALYTICS_ITEMS: RailItem[] = [
  { id: 'chartdesk', label: 'Chart Desk', icon: <ChartCandlestick className="h-4 w-4" />, hint: 'tradingview-style candles · openalgo charts · 112 indicators · 90 drawing tools · pine/volscript studies · bar replay' },
  { id: 'studio', label: 'Studio', icon: <ChartLine className="h-4 w-4" />, hint: 'any series × any chart kind · any model on any data · outputs loop back as charts' },
  { id: 'models', label: 'Mental Models', icon: <Brain className="h-4 w-4" />, hint: 'options mental models · 3D surfaces · greeks · vol surface · exotics zoo · gamma scalper · course map' },
  { id: 'gamma', label: 'Gamma & Flow', icon: <Activity className="h-4 w-4" />, hint: 'GEX · dealer positioning · heatmaps · options flow · 0DTE · skew' },
  { id: 'orderflow', label: 'Order Flow', icon: <Flame className="h-4 w-4" />, hint: 'resting-liquidity heatmap · absorption & icebergs · tape · venues · liquidations · OI & funding · whole market' },
  { id: 'forecast', label: 'Forecast', icon: <Sigma className="h-4 w-4" />, hint: 'conformal prediction on flow bars · calibrated intervals · cross-validated coverage · expected move' },
  { id: 'quant', label: 'Quant Lab', icon: <Atom className="h-4 w-4" />, hint: 'native realtime engine · GEX levels · IV/PDF/greeks · live SSE tape · perps · ETF/COT/SEC · /api/quant' },
  { id: 'scriptlab', label: 'Script Lab', icon: <Braces className="h-4 w-4" />, hint: 'pine-style script applied to the chart · editor + backtest + performance in one panel below it · ai writes any indicator' },
  { id: 'chain', label: 'Option Chain', icon: <CircleDot className="h-4 w-4" />, hint: 'live chains with per-strike BUY / SELL' },
  { id: 'trade', label: 'Trading', icon: <LineChart className="h-4 w-4" />, hint: 'engine CLOB · L2 book · $1M demo equity' },
];

export const SIDE_OF_VIEW: Record<ViewId, SideId> = {
  chartdesk: 'analytics',
  studio: 'analytics',
  models: 'analytics',
  gamma: 'analytics',
  orderflow: 'analytics',
  forecast: 'analytics',
  quant: 'analytics',
  scriptlab: 'analytics',
  chain: 'analytics',
  trade: 'analytics',
  strategies: 'lab',
  paper: 'lab',
};

const SIDE_META: Record<SideId, { label: string; icon: React.ReactNode }> = {
  analytics: { label: 'Analytics', icon: <BarChart3 className="h-3.5 w-3.5" /> },
  lab: { label: 'Strategy Lab', icon: <Dna className="h-3.5 w-3.5" /> },
};

const VIEW_LABEL: Record<ViewId, string> = {
  chartdesk: 'Chart Desk',
  studio: 'Studio',
  models: 'Mental Models',
  scriptlab: 'Script Lab',
  gamma: 'Gamma & Flow',
  orderflow: 'Order Flow',
  forecast: 'Forecast',
  quant: 'Quant Lab',
  chain: 'Option Chain',
  trade: 'Trading',
  strategies: 'Strategies',
  paper: 'Paper Desk',
};

interface WorkbenchProps {
  view: ViewId;
  onView: (v: ViewId) => void;
  /** Unified rail collapsed state. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  children: React.ReactNode;
}

export function Workbench({ view, onView, collapsed, onToggleCollapsed, children }: WorkbenchProps) {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* ── UNIFIED RAIL · Strategies on top, then everything else ─────────── */}
      <Rail
        view={view}
        onView={onView}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        footer={
          <>
            <StrategyCard collapsed={collapsed} />
            <AnalyticsPulse collapsed={collapsed} />
          </>
        }
      />

      {/* ── CENTER · active workspace ─────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <BreadcrumbHeader view={view} />
        {view === 'scriptlab' || view === 'chartdesk' || view === 'studio' ? (
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1600px] px-4 py-3">{children}</div>
          </div>
        )}
      </section>
    </div>
  );
}

// ── rail ─────────────────────────────────────────────────────────────────────

interface RailProps {
  view: ViewId;
  onView: (v: ViewId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  footer?: React.ReactNode;
}

function Rail({ view, onView, collapsed, onToggleCollapsed, footer }: RailProps) {
  return (
    <nav
      aria-label="Terminal navigation"
      className={`flex shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/70 transition-[width] duration-200 ${
        collapsed ? 'w-[52px]' : 'w-[52px] md:w-[228px]'
      }`}
    >
      {/* header */}
      <div className={`flex items-center gap-2 px-2 py-2.5 ${collapsed ? 'justify-center' : ''}`}>
        {!collapsed && (
          <span className="flex items-center gap-1.5 px-1 text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-500">
            <Layers className="h-3.5 w-3.5" />
            <span className="hidden md:inline">volos · workbench</span>
          </span>
        )}
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expand navigation — keyboard [ or ]' : 'Collapse navigation to icons — keyboard [ or ]'}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          className={`flex items-center justify-center rounded-md p-1 text-zinc-600 transition hover:bg-zinc-900 hover:text-zinc-300 ${
            collapsed ? 'ml-0' : 'ml-auto'
          }`}
        >
          {collapsed ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* items — Strategy Lab group pinned on top, Analytics group below */}
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
        <GroupLabel side="lab" collapsed={collapsed} />
        {LAB_ITEMS.map((n) => (
          <RailButton key={n.id} item={n} side="lab" view={view} onView={onView} collapsed={collapsed} />
        ))}

        <GroupLabel side="analytics" collapsed={collapsed} />
        {ANALYTICS_ITEMS.map((n) => (
          <RailButton key={n.id} item={n} side="analytics" view={view} onView={onView} collapsed={collapsed} />
        ))}
      </div>

      {/* live footers */}
      {footer}
    </nav>
  );
}

/** Tiny group divider — a hairline when collapsed, an uppercase label when expanded. */
function GroupLabel({ side, collapsed }: { side: SideId; collapsed: boolean }) {
  const meta = SIDE_META[side];
  if (collapsed) {
    return <div aria-hidden className="mx-auto my-1.5 h-px w-6 shrink-0 bg-zinc-800" />;
  }
  return (
    <p
      className={`hidden px-1 pb-0.5 pt-1 text-[8px] font-bold uppercase tracking-[0.18em] md:block ${
        side === 'lab' ? 'text-violet-400' : 'text-teal-400'
      }`}
    >
      <span className="flex items-center gap-1">
        {meta.icon}
        {meta.label}
      </span>
    </p>
  );
}

interface RailButtonProps {
  item: RailItem;
  side: SideId;
  view: ViewId;
  onView: (v: ViewId) => void;
  collapsed: boolean;
}

function RailButton({ item, side, view, onView, collapsed }: RailButtonProps) {
  const active = view === item.id;
  const isLab = side === 'lab';
  return (
    <button
      onClick={() => onView(item.id)}
      title={`${item.label} — ${item.hint}`}
      className={`group flex shrink-0 items-center rounded-lg text-left transition md:w-full ${
        collapsed ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2'
      } ${
        active
          ? isLab
            ? 'bg-violet-950/40 text-violet-300 ring-1 ring-violet-500/30'
            : 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30'
          : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
      }`}
    >
      <span
        className={`shrink-0 ${
          active ? (isLab ? 'text-violet-400' : 'text-teal-400') : 'text-zinc-500 group-hover:text-zinc-300'
        }`}
      >
        {item.icon}
      </span>
      {!collapsed && (
        <span className="hidden min-w-0 flex-col md:flex">
          <span className="text-[11px] font-medium leading-tight">{item.label}</span>
          <span className="truncate text-[8px] leading-tight text-zinc-600">{item.hint}</span>
        </span>
      )}
    </button>
  );
}

// ── rail footers ─────────────────────────────────────────────────────────────

/** Analytics rail footer — live market pulse from real exchange prices. */
function AnalyticsPulse({ collapsed }: { collapsed: boolean }) {
  const { market, smooth, live } = useMarket();
  const ok = live?.ok;

  return (
    <div className={`border-t border-zinc-800/60 px-1.5 py-2 ${collapsed ? '' : 'hidden md:block'}`}>
      {collapsed ? (
        <div className="flex justify-center" title={ok ? `Live prices · ${live?.source}` : 'Market feed'}>
          <span className={`flex items-center ${ok ? 'text-emerald-400' : 'text-zinc-600'}`}>
            <Radio className={`h-3.5 w-3.5 ${ok ? 'animate-pulse' : ''}`} />
          </span>
        </div>
      ) : (
        <div className="space-y-1 px-1">
          <p className="flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.16em] text-zinc-600">
            <Radio className={`h-2.5 w-2.5 ${ok ? 'animate-pulse text-emerald-400' : 'text-zinc-600'}`} />
            live market pulse
          </p>
          {(Object.keys(ASSET_META) as UnderlyingId[]).map((a) => {
            const st = smooth[a] ?? market.assets[a];
            const chg = st.change24h ?? 0;
            return (
              <div key={a} className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-zinc-900/60">
                <span className="text-[9px] text-zinc-500">{ASSET_META[a].symbol}</span>
                <span className="font-mono text-[10px] text-zinc-300">{fmtNum(st.spot, st.spot >= 1000 ? 0 : 1)}</span>
                <span className={`flex items-center gap-0.5 font-mono text-[9px] ${chg >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {chg >= 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                  {fmtPctSigned(chg, 2)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Strategy Lab footer — the currently loaded strategy. */
function StrategyCard({ collapsed }: { collapsed: boolean }) {
  const { strategyName, legs, size, underlying, catalogId } = useStrategy();

  if (collapsed) {
    return (
      <div className="border-t border-zinc-800/60 py-2 text-center" title={`${strategyName} — ${legs.length} legs · ×${size}`}>
        <Layers className="mx-auto h-3.5 w-3.5 text-violet-400/70" />
      </div>
    );
  }

  return (
    <div className="hidden border-t border-zinc-800/60 px-2.5 py-2 md:block">
      <p className="text-[8px] font-semibold uppercase tracking-[0.16em] text-zinc-600">loaded strategy</p>
      <div className="mt-1 rounded-lg border border-violet-500/20 bg-violet-950/20 px-2 py-1.5">
        <p className="truncate text-[10.5px] font-medium text-violet-200" title={strategyName}>
          {strategyName}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[8.5px] text-zinc-500">
          <span className="rounded bg-zinc-800 px-1 text-zinc-400">{underlying}</span>
          <span>{legs.length} legs</span>
          <span>×{size}</span>
        </p>
        <p className="mt-0.5 truncate font-mono text-[8px] text-zinc-700" title={catalogId}>
          {catalogId}
        </p>
      </div>
    </div>
  );
}

// ── center breadcrumb header ─────────────────────────────────────────────────

function BreadcrumbHeader({ view }: { view: ViewId }) {
  const side = SIDE_OF_VIEW[view];
  const meta = SIDE_META[side];
  const isAnalytics = side === 'analytics';
  const item =
    SIDE_OF_VIEW[view] === 'analytics'
      ? ANALYTICS_ITEMS.find((i) => i.id === view)
      : LAB_ITEMS.find((i) => i.id === view);
  const hint = item?.hint ?? '';

  return (
    <div className="flex items-center gap-2 border-b border-zinc-800/60 bg-zinc-950/40 px-4 py-2">
      <span
        className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.14em] ${
          isAnalytics
            ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30'
            : 'bg-violet-950/50 text-violet-300 ring-1 ring-violet-500/30'
        }`}
      >
        {meta.icon}
        {meta.label}
      </span>
      <ChevronRight className="h-3 w-3 text-zinc-700" />
      <span className="text-[12.5px] font-semibold tracking-tight text-zinc-100">{VIEW_LABEL[view]}</span>
      <span className="hidden truncate text-[9.5px] text-zinc-600 lg:inline">— {hint}</span>
      {/* keyboard hints — professional touch */}
      <span className="ml-auto hidden items-center gap-2 font-mono text-[8.5px] text-zinc-700 md:flex">
        <span className="rounded border border-zinc-800 px-1 py-0.5">[</span>
        <span>navigation rail</span>
      </span>
    </div>
  );
}

// ── keyboard shortcuts ───────────────────────────────────────────────────────

/** `[` (or `]`) toggles the unified navigation rail. */
export function useRailHotkeys(onToggleRail: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.getAttribute('data-copilot-input') !== null);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[' || e.key === ']') onToggleRail();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onToggleRail]);
}

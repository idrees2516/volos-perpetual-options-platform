'use client';

// ─────────────────────────────────────────────────────────────────────────────
// DUAL WORKBENCH — the terminal's two-sided collapsible navigation shell.
//
//   LEFT  RAIL · ANALYTICS     Gamma & Flow · Option Chain · Trading
//                             (market internals, live chains, execution data)
//   RIGHT RAIL · STRATEGY LAB  Strategies · Paper Desk
//                             (understanding & creation of strategies)
//
// The former top MAIN tab strip is RETIRED — all navigation now lives in the
// two side panels, each independently collapsible to a slim icon rail
// (keyboard: `[` toggles Analytics, `]` toggles Strategy Lab). The center
// column renders the active view under a professional breadcrumb header.
//
// Each rail also carries a live footer: the Analytics rail shows the live
// market pulse (real exchange prices), the Strategy Lab rail shows the
// currently loaded strategy — so both sides stay informative even as pure
// navigation. Collapse states persist across reloads.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect } from 'react';
import {
  Activity, CircleDot, LineChart, Layers, FlaskConical,
  BarChart3, Dna, ChevronsLeft, ChevronsRight, ChevronRight,
  TrendingUp, TrendingDown, Radio,
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

/** Analytics side — market internals & data views. */
const ANALYTICS_ITEMS: RailItem[] = [
  { id: 'gamma', label: 'Gamma & Flow', icon: <Activity className="h-4 w-4" />, hint: 'GEX · dealer positioning · heatmaps · options flow · 0DTE · skew' },
  { id: 'chain', label: 'Option Chain', icon: <CircleDot className="h-4 w-4" />, hint: 'live chains with per-strike BUY / SELL' },
  { id: 'trade', label: 'Trading', icon: <LineChart className="h-4 w-4" />, hint: 'engine CLOB · L2 book · $1M demo equity' },
];

/** Strategy Lab side — understanding & creation of strategies. */
const LAB_ITEMS: RailItem[] = [
  { id: 'strategies', label: 'Strategies', icon: <Layers className="h-4 w-4" />, hint: '131 catalog · payoff up front · intelligence · builder · backtests' },
  { id: 'paper', label: 'Paper Desk', icon: <FlaskConical className="h-4 w-4" />, hint: 'deploy strategy packages · fills at real venue BBO' },
];

export const SIDE_OF_VIEW: Record<ViewId, SideId> = {
  gamma: 'analytics',
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
  gamma: 'Gamma & Flow',
  chain: 'Option Chain',
  trade: 'Trading',
  strategies: 'Strategies',
  paper: 'Paper Desk',
};

interface WorkbenchProps {
  view: ViewId;
  onView: (v: ViewId) => void;
  /** Analytics rail collapsed state. */
  analyticsCollapsed: boolean;
  onToggleAnalytics: () => void;
  /** Strategy Lab rail collapsed state. */
  labCollapsed: boolean;
  onToggleLab: () => void;
  children: React.ReactNode;
}

export function Workbench({
  view,
  onView,
  analyticsCollapsed,
  onToggleAnalytics,
  labCollapsed,
  onToggleLab,
  children,
}: WorkbenchProps) {
  const side = SIDE_OF_VIEW[view];

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* ── LEFT · ANALYTICS rail ─────────────────────────────────────────── */}
      <Rail
        side="analytics"
        items={ANALYTICS_ITEMS}
        view={view}
        onView={onView}
        collapsed={analyticsCollapsed}
        onToggleCollapsed={onToggleAnalytics}
        footer={<AnalyticsPulse collapsed={analyticsCollapsed} />}
      />

      {/* ── CENTER · active workspace ─────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <BreadcrumbHeader side={side} view={view} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1600px] px-4 py-3">{children}</div>
        </div>
      </section>

      {/* ── RIGHT · STRATEGY LAB rail ─────────────────────────────────────── */}
      <Rail
        side="lab"
        items={LAB_ITEMS}
        view={view}
        onView={onView}
        collapsed={labCollapsed}
        onToggleCollapsed={onToggleLab}
        footer={<StrategyCard collapsed={labCollapsed} />}
      />
    </div>
  );
}

// ── rail ─────────────────────────────────────────────────────────────────────

interface RailProps {
  side: SideId;
  items: RailItem[];
  view: ViewId;
  onView: (v: ViewId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  footer?: React.ReactNode;
}

function Rail({ side, items, view, onView, collapsed, onToggleCollapsed, footer }: RailProps) {
  const meta = SIDE_META[side];
  const isAnalytics = side === 'analytics';

  return (
    <nav
      aria-label={meta.label}
      className={`flex shrink-0 flex-col border-zinc-800/80 bg-zinc-950/70 transition-[width] duration-200 ${
        isAnalytics ? 'border-r' : 'border-l'
      } ${collapsed ? 'w-[52px]' : 'w-[52px] md:w-[228px]'}`}
    >
      {/* header */}
      <div className={`flex items-center gap-2 px-2 py-2.5 ${collapsed ? 'justify-center' : ''}`}>
        {!collapsed && (
          <span
            className={`flex items-center gap-1.5 px-1 text-[9px] font-bold uppercase tracking-[0.18em] ${
              isAnalytics ? 'text-teal-400' : 'text-violet-400'
            }`}
          >
            {meta.icon}
            <span className="hidden md:inline">{meta.label}</span>
          </span>
        )}
        <button
          onClick={onToggleCollapsed}
          title={
            collapsed
              ? `Expand ${meta.label}${isAnalytics ? ' — keyboard [ ' : ' — keyboard ] '}`
              : `Collapse ${meta.label} to icons${isAnalytics ? ' — keyboard [ ' : ' — keyboard ] '}`
          }
          aria-label={collapsed ? `Expand ${meta.label}` : `Collapse ${meta.label}`}
          className={`ml-auto flex items-center justify-center rounded-md p-1 text-zinc-600 transition hover:bg-zinc-900 hover:text-zinc-300 ${
            collapsed ? 'ml-0' : ''
          }`}
        >
          {isAnalytics ? (
            collapsed ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />
          ) : collapsed ? (
            <ChevronsLeft className="h-3.5 w-3.5" />
          ) : (
            <ChevronsRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* items */}
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
        {items.map((n) => {
          const active = view === n.id;
          return (
            <button
              key={n.id}
              onClick={() => onView(n.id)}
              title={`${n.label} — ${n.hint}`}
              className={`group flex shrink-0 items-center rounded-lg text-left transition md:w-full ${
                collapsed ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2'
              } ${
                active
                  ? isAnalytics
                    ? 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30'
                    : 'bg-violet-950/40 text-violet-300 ring-1 ring-violet-500/30'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              <span
                className={`shrink-0 ${
                  active ? (isAnalytics ? 'text-teal-400' : 'text-violet-400') : 'text-zinc-500 group-hover:text-zinc-300'
                }`}
              >
                {n.icon}
              </span>
              {!collapsed && (
                <span className="hidden min-w-0 flex-col md:flex">
                  <span className="text-[11px] font-medium leading-tight">{n.label}</span>
                  <span className="truncate text-[8px] leading-tight text-zinc-600">{n.hint}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* live footer */}
      {footer}
    </nav>
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

/** Strategy Lab rail footer — the currently loaded strategy. */
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

function BreadcrumbHeader({ side, view }: { side: SideId; view: ViewId }) {
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
        <span>analytics</span>
        <span className="rounded border border-zinc-800 px-1 py-0.5">]</span>
        <span>strategy lab</span>
      </span>
    </div>
  );
}

// ── keyboard shortcuts ───────────────────────────────────────────────────────

/** `[` toggles the Analytics rail, `]` toggles the Strategy Lab rail. */
export function useRailHotkeys(onToggleAnalytics: () => void, onToggleLab: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.getAttribute('data-copilot-input') !== null);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[') onToggleAnalytics();
      if (e.key === ']') onToggleLab();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onToggleAnalytics, onToggleLab]);
}

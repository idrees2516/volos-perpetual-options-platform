'use client';

// ─────────────────────────────────────────────────────────────────────────────
// SIDE NAV — the terminal's left navigation rail with every major
// functionality. MAIN = the four primary workspaces (Strategies · Gamma &
// Flow · Option Chain · Paper Desk); DESKS = Trading. Collapsible between
// full labels and icon-only mode.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import {
  Layers, CircleDot, LineChart, FlaskConical, Activity,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import type { ViewId } from './topbar';

const NAV_ITEMS: {
  id: ViewId;
  label: string;
  icon: React.ReactNode;
  hint: string;
  section: 'main' | 'desks';
}[] = [
  {
    id: 'strategies',
    label: 'Strategies',
    icon: <Layers className="h-4 w-4" />,
    hint: '131-strategy catalog · payoff up front · persisted selection',
    section: 'main',
  },
  {
    id: 'gamma',
    label: 'Gamma & Flow',
    icon: <Activity className="h-4 w-4" />,
    hint: 'GEX · dealer positioning · walls & flips · heatmaps · options flow · 0DTE · skew',
    section: 'main',
  },
  {
    id: 'chain',
    label: 'Option Chain',
    icon: <CircleDot className="h-4 w-4" />,
    hint: 'live chains with per-strike BUY / SELL',
    section: 'main',
  },
  {
    id: 'paper',
    label: 'Paper Desk',
    icon: <FlaskConical className="h-4 w-4" />,
    hint: 'fills at real venue BBO',
    section: 'main',
  },
  {
    id: 'trade',
    label: 'Trading',
    icon: <LineChart className="h-4 w-4" />,
    hint: 'engine CLOB · $1M demo equity',
    section: 'desks',
  },
];

interface SideNavProps {
  view: ViewId;
  onView: (v: ViewId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function SideNav({ view, onView, collapsed, onToggleCollapsed }: SideNavProps) {
  const main = NAV_ITEMS.filter((n) => n.section === 'main');
  const desks = NAV_ITEMS.filter((n) => n.section === 'desks');

  const renderItem = (n: (typeof NAV_ITEMS)[number]) => {
    const active = view === n.id;
    return (
      <button
        key={n.id}
        onClick={() => onView(n.id)}
        title={collapsed ? `${n.label} — ${n.hint}` : n.hint}
        className={`group flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition md:w-full ${
          active
            ? 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30'
            : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
        } ${collapsed ? 'md:justify-center md:px-2' : ''}`}
      >
        <span className={active ? 'text-teal-400' : 'text-zinc-500 group-hover:text-zinc-300'}>
          {n.icon}
        </span>
        {!collapsed && (
          <span className="flex min-w-0 flex-col">
            <span className="text-[11px] font-medium leading-tight">{n.label}</span>
            <span className="truncate text-[8px] leading-tight text-zinc-600">{n.hint}</span>
          </span>
        )}
        {collapsed && active && <span className="hidden h-1 w-1 rounded-full bg-teal-400 md:block" />}
      </button>
    );
  };

  return (
    <nav className="flex w-full shrink-0 flex-col gap-1 border-r border-zinc-800/80 bg-zinc-950/60 py-2 md:w-auto md:px-2">
      <div className="flex flex-row gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {!collapsed && (
          <span className="hidden px-2.5 pt-1 text-[8px] font-semibold uppercase tracking-[0.18em] text-zinc-700 md:block">
            main
          </span>
        )}
        {main.map(renderItem)}
        {!collapsed && (
          <span className="hidden px-2.5 pt-2 text-[8px] font-semibold uppercase tracking-[0.18em] text-zinc-700 md:block">
            desks
          </span>
        )}
        {desks.map(renderItem)}
      </div>

      {/* collapse toggle (desktop only) */}
      <button
        onClick={onToggleCollapsed}
        className="mt-auto hidden items-center gap-2 rounded-lg px-2.5 py-2 text-zinc-600 transition hover:bg-zinc-900 hover:text-zinc-300 md:flex"
        title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
      >
        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        {!collapsed && <span className="text-[10px]">Collapse</span>}
      </button>
    </nav>
  );
}

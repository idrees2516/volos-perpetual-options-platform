'use client';

// ─────────────────────────────────────────────────────────────────────────────
// builder-dock — the BUILDER side of "Open in Builder".
//
// Panels pinned from the workspaces (QuantLab · Paper Desk) dock here as LIVE
// cards: a switcher strip to flip between them, drag to reorder the strip,
// unpin individually or clear all — and the active panel keeps rendering its
// real component (live data, live decisions), not a snapshot.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useRef, useState } from 'react';
import { LayoutGrid, PinOff, X } from 'lucide-react';
import { useDockStore, type PinnedPanel } from '@/stores/dock-store';
import { OverviewPanel } from '@/components/terminal/quantlab/panels-overview';
import { SignalsPanel } from '@/components/terminal/quantlab/panels-signals';
import { GexPanel } from '@/components/terminal/quantlab/panels-gex';
import { IvPanel } from '@/components/terminal/quantlab/panels-iv';
import { VolRegimePanel } from '@/components/terminal/quantlab/panels-volregime';
import { TapePanel } from '@/components/terminal/quantlab/panels-tape';
import { PerpsPanel } from '@/components/terminal/quantlab/panels-perps';
import { RiskPanel } from '@/components/terminal/quantlab/panels-risk';
import { PositionIntelligencePanel } from '@/components/terminal/paper/position-intelligence';
import { AutopilotPanel } from '@/components/terminal/paper/autopilot-panel';

/** The live component behind a pinned panel (falls back to a note for unknown kinds). */
function PinnedContent({ p }: { p: PinnedPanel }) {
  const symbol = (p.meta?.symbol as string) ?? 'BTC';
  const hasOptions = symbol !== 'SOL';
  switch (p.kind) {
    case 'quant-overview':
      return <OverviewPanel symbol={symbol} hasOptions={hasOptions} />;
    case 'quant-signals':
      return <SignalsPanel symbol={symbol} />;
    case 'quant-gex':
      return <GexPanel symbol={symbol} hasOptions={hasOptions} />;
    case 'quant-iv':
      return <IvPanel symbol={symbol} hasOptions={hasOptions} />;
    case 'quant-volregime':
      return <VolRegimePanel symbol={symbol} hasOptions={hasOptions} />;
    case 'quant-tape':
      return <TapePanel symbol={symbol} hasOptions={hasOptions} onInspect={undefined} />;
    case 'quant-perps':
      return <PerpsPanel symbol={symbol} />;
    case 'quant-risk':
      return <RiskPanel symbol={symbol} />;
    case 'paper-intelligence':
      // docked copy: close buttons are wired to the Paper Desk (no-op here)
      return <PositionIntelligencePanel onClosePosition={() => {}} />;
    case 'paper-autopilot':
      return <AutopilotPanel />;
    default:
      return (
        <p className="p-3 text-[10px] text-zinc-500">
          This pinned section ({p.kind}) has no live renderer yet — unpin it and pin a supported panel.
        </p>
      );
  }
}

export function BuilderDock({ className = '' }: { className?: string }) {
  const { pinned, activeId, setActive, unpin, movePinned, clear } = useDockStore();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const deep = useRef(0);

  if (pinned.length === 0) return null;

  const active = pinned.find((p) => p.id === activeId) ?? pinned[pinned.length - 1];

  return (
    <section
      className={`mt-2 rounded-lg border border-teal-500/25 bg-teal-950/10 ${className}`}
      title="Panels pinned from the workspaces — switch between them, drag to reorder, unpin to remove"
    >
      {/* switcher strip */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/60 px-2 py-1.5">
        <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-teal-300/80">
          <LayoutGrid className="h-3 w-3" /> Builder docks
          <span className="font-mono text-[8px] text-zinc-600">{pinned.length} pinned</span>
        </span>
        <span className="mx-1 h-3 w-px bg-zinc-800" />
        {pinned.map((p) => {
          const isActive = p.id === active?.id;
          return (
            <span
              key={p.id}
              draggable
              onDragStart={(e) => {
                setDragId(p.id);
                e.dataTransfer.setData('text/plain', p.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
                deep.current = 0;
              }}
              onDragOver={(e) => {
                if (dragId && dragId !== p.id) e.preventDefault();
              }}
              onDragEnter={(e) => {
                if (!dragId || dragId === p.id) return;
                e.preventDefault();
                deep.current += 1;
                setOverId(p.id);
              }}
              onDragLeave={() => {
                deep.current = Math.max(0, deep.current - 1);
                if (deep.current === 0) setOverId(null);
              }}
              onDrop={(e) => {
                if (dragId && dragId !== p.id) {
                  e.preventDefault();
                  movePinned(dragId, p.id);
                }
                setDragId(null);
                setOverId(null);
                deep.current = 0;
              }}
              className={`group flex cursor-grab select-none items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[8.5px] transition ${
                isActive
                  ? 'bg-teal-950/70 text-teal-200 ring-1 ring-teal-500/40'
                  : 'bg-zinc-900/70 text-zinc-500 hover:text-zinc-300'
              } ${overId === p.id ? 'ring-2 ring-teal-500/60' : ''}`}
            >
              <button onClick={() => setActive(p.id)} className="max-w-[160px] truncate font-semibold">
                {p.title}
              </button>
              <button
                onClick={() => unpin(p.id)}
                title="Unpin"
                className="rounded p-0.5 text-zinc-600 opacity-60 transition group-hover:opacity-100 hover:text-rose-400"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          );
        })}
        <button
          onClick={clear}
          title="Unpin all"
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-[8px] uppercase tracking-wider text-zinc-600 transition hover:text-rose-400"
        >
          <PinOff className="h-2.5 w-2.5" /> clear
        </button>
      </div>

      {/* the live active panel */}
      <div className="max-h-[560px] overflow-y-auto p-2">
        {active && <PinnedContent p={active} />}
      </div>
    </section>
  );
}

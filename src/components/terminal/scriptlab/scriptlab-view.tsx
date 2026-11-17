'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — the view. A fully adjustable workspace: every panel is a
// floating window (drag by title bar, resize from any edge/corner, maximize,
// minimize, close & reopen, z-order on focus), with a dock strip, tiling and
// a persisted layout. The toolbar drives the dataset; the status strip shows
// provenance + compile health.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Braces, LineChart, Code2, Library, FlaskConical, Sparkles, Database,
  LayoutGrid, RotateCcw, Plus, Maximize2,
} from 'lucide-react';
import { useScriptLab, SCRIPTLAB_SYMBOLS, SCRIPTLAB_TFS, rehydrateScriptLab, type PanelId } from '@/stores/scriptlab-store';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WindowFrame } from './window-frame';
import { ScriptChart } from './script-chart';
import { EditorPanel } from './editor-panel';
import { LibraryPanel } from './library-panel';
import { BacktestPanel } from './backtest-panel';
import { AiPanel } from './ai-panel';
import { DataPanel } from './data-panel';

const PANEL_META: Record<PanelId, { title: string; icon: React.ReactNode }> = {
  library: { title: 'Script Library', icon: <Library className="h-3.5 w-3.5" /> },
  editor: { title: 'VolScript Editor', icon: <Code2 className="h-3.5 w-3.5" /> },
  chart: { title: 'Chart', icon: <LineChart className="h-3.5 w-3.5" /> },
  backtest: { title: 'Backtest', icon: <FlaskConical className="h-3.5 w-3.5" /> },
  ai: { title: 'AI Script Desk', icon: <Sparkles className="h-3.5 w-3.5" /> },
  data: { title: 'Dataset', icon: <Database className="h-3.5 w-3.5" /> },
};

const PANEL_ORDER: PanelId[] = ['library', 'editor', 'chart', 'backtest', 'ai', 'data'];

export function ScriptLabView() {
  const store = useScriptLab();
  const { symbol, tf, limit, bars, barsSource, barsLoading, result, running, windows, zTop } = store;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ w: 1200, h: 640 });

  // measure workspace bounds (draggable windows live inside it)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setBounds({ w: Math.max(320, r.width), h: Math.max(240, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ensure default layout once bounds are known
  useEffect(() => {
    if (bounds.w > 0) store.ensureWindows(bounds.w, bounds.h);
  }, [bounds.w, bounds.h]);

  // first mount: restore persisted studio state, then fetch bars + scripts
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    rehydrateScriptLab();
    void store.fetchUserScripts();
    void store.refreshBars();
  }, []);

  // dataset changes re-fetch (then auto re-run inside refreshBars)
  const firstDataset = useRef(true);
  useEffect(() => {
    if (firstDataset.current) {
      firstDataset.current = false;
      return;
    }
    void store.refreshBars();
  }, [symbol, tf, limit]);

  const panelBody = useCallback(
    (id: PanelId) => {
      switch (id) {
        case 'library':
          return <LibraryPanel />;
        case 'editor':
          return <EditorPanel />;
        case 'chart':
          return <ScriptChart bars={bars} result={result} />;
        case 'backtest':
          return <BacktestPanel />;
        case 'ai':
          return <AiPanel />;
        case 'data':
          return <DataPanel />;
      }
    },
    [bars, result],
  );

  const sourceBadge =
    barsSource === 'live' ? { label: 'live sweep', cls: 'text-emerald-300 bg-emerald-950/60 ring-emerald-500/30' } : barsSource
      ? { label: 'kline mirror', cls: 'text-teal-300 bg-teal-950/60 ring-teal-500/30' }
      : { label: 'no data', cls: 'text-zinc-400 bg-zinc-900' };

  const closedPanels = windows ? PANEL_ORDER.filter((id) => windows[id].closed || windows[id].minimized) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/70 bg-zinc-950/60 px-3 py-1.5">
        <Braces className="h-3.5 w-3.5 text-teal-400" />
        <span className="text-[11px] font-bold tracking-tight text-zinc-100">
          Vol<span className="text-teal-400">Script</span>
          <span className="ml-1.5 text-[8px] font-semibold uppercase tracking-[0.16em] text-zinc-500">pine-v5-style · backtests · ai codegen</span>
        </span>

        {/* symbol */}
        <div className="ml-2 flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
          {SCRIPTLAB_SYMBOLS.map((s) => (
            <button
              key={s}
              onClick={() => store.setDataset({ symbol: s })}
              className={`rounded-md px-2 py-0.5 font-mono text-[10px] transition ${
                symbol === s ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* tf */}
        <Select value={tf} onValueChange={(v) => store.setDataset({ tf: v as (typeof SCRIPTLAB_TFS)[number] })}>
          <SelectTrigger className="h-6 w-[70px] border-zinc-800 bg-zinc-950 font-mono text-[10px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCRIPTLAB_TFS.map((t) => (
              <SelectItem key={t} value={t} className="font-mono text-[10px]">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* window size */}
        <Select value={String(limit)} onValueChange={(v) => store.setDataset({ limit: Number(v) })}>
          <SelectTrigger className="h-6 w-[64px] border-zinc-800 bg-zinc-950 font-mono text-[10px]" title="Bar window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[240, 500, 1000].map((l) => (
              <SelectItem key={l} value={String(l)} className="font-mono text-[10px]">
                {l} bars
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* status */}
        <span className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider ring-1 ${sourceBadge.cls}`}>
          <Database className="h-2.5 w-2.5" />
          {sourceBadge.label}
          {bars ? ` · ${bars.length} bars` : ''}
        </span>
        {result && (
          <span
            className={`rounded-full px-1.5 py-0.5 font-mono text-[8.5px] font-bold ring-1 ${
              result.ok
                ? 'bg-emerald-950/60 text-emerald-300 ring-emerald-500/30'
                : 'bg-rose-950/60 text-rose-300 ring-rose-500/30'
            }`}
            title={result.ok ? `${result.title} — ${result.runtimeMs}ms` : `line ${result.error?.line}: ${result.error?.message}`}
          >
            {result.ok ? `${result.kind} · ${result.runtimeMs}ms` : `line ${result.error?.line ?? '?'} ✕`}
          </span>
        )}

        {/* layout controls */}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 border-zinc-800 bg-zinc-950 px-2 text-[9px]"
            onClick={() => store.tilePanels(bounds.w, bounds.h)}
            title="Tile open panels into a grid"
          >
            <LayoutGrid className="h-2.5 w-2.5" /> tile
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 border-zinc-800 bg-zinc-950 px-2 text-[9px]"
            onClick={() => store.resetLayout(bounds.w, bounds.h)}
            title="Reset to the default studio layout"
          >
            <RotateCcw className="h-2.5 w-2.5" /> reset
          </Button>
        </div>
      </div>

      {/* ── floating-window workspace ──────────────────────────────────── */}
      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden bg-[#04060a]">
        {/* dot grid backdrop */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.55]"
          style={{
            backgroundImage: 'radial-gradient(rgba(113,113,122,0.14) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />
        {barsLoading && (
          <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950/90 px-2 py-1 text-[9px] text-zinc-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-teal-400" />
            loading bars…
          </div>
        )}
        {windows &&
          PANEL_ORDER.map((id) => {
            const meta = PANEL_META[id];
            const w = windows[id];
            if (!w) return null;
            return (
              <WindowFrame
                key={id}
                id={id}
                title={meta.title}
                icon={meta.icon}
                layout={{ ...w, z: w.maximized ? zTop : w.z }}
                bounds={bounds}
                onMove={(x, y) => store.movePanel(id, x, y)}
                onResize={(rect) => store.resizePanel(id, rect)}
                onClose={() => store.closePanel(id)}
                onMinimize={() => store.minimizePanel(id)}
                onMaximize={() => store.toggleMaximize(id)}
                onFocus={() => store.focusPanel(id)}
              >
                {panelBody(id)}
              </WindowFrame>
            );
          })}

        {/* empty workspace state */}
        {windows && PANEL_ORDER.every((id) => windows[id].closed || windows[id].minimized) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-600">
            <Maximize2 className="h-5 w-5" />
            <p className="text-[11px]">all panels docked</p>
          </div>
        )}
      </div>

      {/* ── dock strip: minimized + closed panels ────────────────────────── */}
      <div className="flex min-h-[34px] items-center gap-1.5 border-t border-zinc-800/70 bg-zinc-950/70 px-2.5 py-1">
        <span className="text-[7.5px] font-bold uppercase tracking-[0.16em] text-zinc-600">dock</span>
        {closedPanels.map((id) => (
          <button
            key={id}
            onClick={() => (windows?.[id].minimized ? store.restorePanel(id) : store.openPanel(id))}
            className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[9.5px] text-zinc-400 transition hover:border-teal-700/50 hover:text-teal-300"
            title={`${windows?.[id].minimized ? 'Restore' : 'Open'} ${PANEL_META[id].title}`}
          >
            {PANEL_META[id].icon}
            {PANEL_META[id].title}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 font-mono text-[8px] text-zinc-600">
          <span className="rounded border border-zinc-800 px-1 py-0.5">drag title bars · resize edges · double-click = maximize</span>
          <span>{running ? 'running…' : 'idle'}</span>
        </span>
      </div>
    </div>
  );
}

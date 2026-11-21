'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — the unified studio. The indicator/strategy applies directly to
// the price chart up top (candles + plots + trade markers), and EVERYTHING
// about that script lives in ONE panel below the chart:
//
//   • Pine Editor    — the PineScript-style code editor with the AI desk
//                     embedded beside it (AI writes / explains / fixes /
//                     translates any indicator or analysis tool)
//   • Backtest      — equity curve, trade list, fills (a strategy applied to
//                     the chart IS the backtest — no separate module)
//   • Performance   — the deep analytics: drawdown, distributions, streaks,
//                     monthly returns, buy & hold comparison
//   • Library       — the 17-category script browser
//   • Dataset       — bar provenance + coverage
//
// The chart/panel split is a draggable divider (double-click resets); the
// panel collapses to its tab strip. Dataset + draft + layout persist.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef } from 'react';
import {
  Braces, Code2, Library, FlaskConical, Sparkles, Database, Gauge,
  ChevronsDown, ChevronsUp, TrendingUp, TrendingDown,
} from 'lucide-react';
import {
  useScriptLab, SCRIPTLAB_SYMBOLS, SCRIPTLAB_TFS, rehydrateScriptLab, type BottomTab,
} from '@/stores/scriptlab-store';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScriptChart } from './script-chart';
import { EditorPanel } from './editor-panel';
import { LibraryPanel } from './library-panel';
import { BacktestPanel } from './backtest-panel';
import { PerformancePanel } from './performance-panel';
import { DataPanel } from './data-panel';

const BOTTOM_TABS: { id: BottomTab; label: string; icon: React.ReactNode; hint: string }[] = [
  { id: 'editor', label: 'Pine Editor', icon: <Code2 className="h-3.5 w-3.5" />, hint: 'pinescript-style code · settings · the AI desk writes it with you' },
  { id: 'backtest', label: 'Backtest', icon: <FlaskConical className="h-3.5 w-3.5" />, hint: 'equity curve · fills · trade list' },
  { id: 'performance', label: 'Performance', icon: <Gauge className="h-3.5 w-3.5" />, hint: 'drawdown · distributions · streaks · monthly returns' },
  { id: 'library', label: 'Library', icon: <Library className="h-3.5 w-3.5" />, hint: '17 categories · templates + saved scripts' },
  { id: 'data', label: 'Dataset', icon: <Database className="h-3.5 w-3.5" />, hint: 'bars provenance · coverage · refresh' },
];

export function ScriptLabView() {
  const {
    symbol, tf, limit, bars, barsSource, barsLoading, result, running,
    bottomTab, setBottomTab, chartSplitPct, setChartSplitPct, resetChartSplit,
    bottomCollapsed, toggleBottomCollapsed, scriptName,
  } = useScriptLab();

  const workspaceRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // first mount: restore persisted studio state, then fetch bars + scripts
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    rehydrateScriptLab();
    void useScriptLab.getState().fetchUserScripts();
    void useScriptLab.getState().refreshBars();
  }, []);

  // dataset changes re-fetch (then auto re-run inside refreshBars)
  const firstDataset = useRef(true);
  useEffect(() => {
    if (firstDataset.current) {
      firstDataset.current = false;
      return;
    }
    void useScriptLab.getState().refreshBars();
  }, [symbol, tf, limit]);

  // ── the chart / panel divider (drag to resize, dbl-click to reset) ───────
  const onDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onDividerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current || !workspaceRef.current) return;
      const r = workspaceRef.current.getBoundingClientRect();
      if (r.height <= 0) return;
      setChartSplitPct(((e.clientY - r.top) / r.height) * 100);
    },
    [setChartSplitPct],
  );
  const onDividerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const sourceBadge =
    barsSource === 'live' ? { label: 'live sweep', cls: 'text-emerald-300 bg-emerald-950/60 ring-emerald-500/30' } : barsSource
      ? { label: 'kline mirror', cls: 'text-teal-300 bg-teal-950/60 ring-teal-500/30' }
      : { label: 'no data', cls: 'text-zinc-400 bg-zinc-900' };

  // glance chip for the tab strip when a strategy is applied to the chart
  const strat = result?.ok && result.kind === 'strategy' ? result.backtest : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/70 bg-zinc-950/60 px-3 py-1.5">
        <Braces className="h-3.5 w-3.5 text-teal-400" />
        <span className="text-[11px] font-bold tracking-tight text-zinc-100">
          Vol<span className="text-teal-400">Script</span>
          <span className="ml-1.5 text-[8px] font-semibold uppercase tracking-[0.16em] text-zinc-500">pine-v5-style · on-chart · ai codegen</span>
        </span>

        {/* symbol */}
        <div className="ml-2 flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
          {SCRIPTLAB_SYMBOLS.map((s) => (
            <button
              key={s}
              onClick={() => useScriptLab.getState().setDataset({ symbol: s })}
              className={`rounded-md px-2 py-0.5 font-mono text-[10px] transition ${
                symbol === s ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* tf */}
        <Select value={tf} onValueChange={(v) => useScriptLab.getState().setDataset({ tf: v as (typeof SCRIPTLAB_TFS)[number] })}>
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

        {/* bar window */}
        <Select value={String(limit)} onValueChange={(v) => useScriptLab.getState().setDataset({ limit: Number(v) })}>
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

        {/* provenance */}
        <span className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider ring-1 ${sourceBadge.cls}`}>
          <Database className="h-2.5 w-2.5" />
          {sourceBadge.label}
          {bars ? ` · ${bars.length} bars` : ''}
        </span>

        {/* compile health */}
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

        {/* applied script */}
        <span className="ml-auto hidden max-w-[260px] items-center gap-1.5 truncate font-mono text-[9px] text-zinc-500 md:flex">
          <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-zinc-400">
            applied
          </span>
          <span className="truncate text-zinc-300">{scriptName}</span>
        </span>
      </div>

      {/* ── workspace: chart on top · the script panel below ────────────── */}
      <div ref={workspaceRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#04060a]">
        {/* chart — the applied indicator/strategy draws right here */}
        <div
          className={`relative min-h-[240px] overflow-hidden ${bottomCollapsed ? 'flex-1' : 'flex-none'}`}
          style={bottomCollapsed ? undefined : { height: `${chartSplitPct}%` }}
        >
          <ScriptChart bars={bars} result={result} />
          {barsLoading && (
            <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950/90 px-2 py-1 text-[9px] text-zinc-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-teal-400" />
              loading bars…
            </div>
          )}
        </div>

        {/* the divider between the chart and the script panel */}
        {!bottomCollapsed && (
          <div
            role="separator"
            aria-label="Resize chart versus script panel"
            aria-orientation="horizontal"
            tabIndex={0}
            className="group relative z-10 h-1.5 shrink-0 cursor-row-resize select-none bg-zinc-900/80 transition-colors hover:bg-teal-700/40"
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onPointerUp={onDividerUp}
            onPointerCancel={onDividerUp}
            onDoubleClick={() => resetChartSplit()}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') setChartSplitPct(chartSplitPct + 2);
              if (e.key === 'ArrowDown') setChartSplitPct(chartSplitPct - 2);
            }}
            title="Drag to resize · double-click resets · ↑/↓ nudges"
          >
            <span className="absolute left-1/2 top-1/2 h-[3px] w-9 -translate-x-1/2 -translate-y-1/2 rounded bg-zinc-700 group-hover:bg-teal-500" />
          </div>
        )}

        {/* ── the panel: code + backtest + performance, all below the chart ─ */}
        <div className={`flex min-h-0 flex-col ${bottomCollapsed ? 'shrink-0' : 'flex-1'}`}>
          {/* tab strip */}
          <div className="flex min-h-[34px] flex-wrap items-center gap-1 border-y border-zinc-800/70 bg-zinc-950/70 px-2 py-1">
            {BOTTOM_TABS.map((t) => {
              const active = !bottomCollapsed && bottomTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => (bottomCollapsed && bottomTab === t.id ? toggleBottomCollapsed() : setBottomTab(t.id))}
                  title={`${t.label} — ${t.hint}`}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium transition ${
                    active
                      ? 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                  }`}
                >
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              );
            })}

            {/* strategy glance — jump straight to the backtest */}
            {strat && (
              <button
                onClick={() => setBottomTab('backtest')}
                className={`ml-1 flex items-center gap-2 rounded-full px-2 py-0.5 font-mono text-[9px] font-bold ring-1 transition ${
                  strat.stats.netProfitPct >= 0
                    ? 'bg-emerald-950/60 text-emerald-300 ring-emerald-500/30 hover:bg-emerald-900/50'
                    : 'bg-rose-950/60 text-rose-300 ring-rose-500/30 hover:bg-rose-900/50'
                }`}
                title={`${strat.stats.trades} trades · win rate ${strat.stats.winRate.toFixed(1)}% · PF ${strat.stats.profitFactor.toFixed(2)} — open the backtest tab`}
              >
                {strat.stats.netProfitPct >= 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                {strat.stats.netProfitPct >= 0 ? '+' : ''}{strat.stats.netProfitPct.toFixed(2)}%
                <span className="font-normal text-zinc-500">{strat.stats.trades} trades</span>
              </button>
            )}

            {/* collapse toggle */}
            <button
              onClick={toggleBottomCollapsed}
              className="ml-auto flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[9px] text-zinc-500 transition hover:text-zinc-200"
              title={bottomCollapsed ? 'Expand the script panel' : 'Collapse the script panel to its tab strip'}
            >
              {bottomCollapsed ? <ChevronsUp className="h-3 w-3" /> : <ChevronsDown className="h-3 w-3" />}
              <span className="hidden sm:inline">{bottomCollapsed ? 'expand' : 'collapse'}</span>
            </button>
          </div>

          {/* tab body */}
          {!bottomCollapsed && (
            <div className="min-h-[240px] flex-1 overflow-hidden">
              {bottomTab === 'editor' && <EditorPanel />}
              {bottomTab === 'backtest' && <BacktestPanel />}
              {bottomTab === 'performance' && <PerformancePanel />}
              {bottomTab === 'library' && <LibraryPanel />}
              {bottomTab === 'data' && <DataPanel />}
            </div>
          )}
        </div>

        {/* running pulse */}
        {running && (
          <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950/90 px-2 py-1 text-[9px] text-zinc-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-teal-400" />
            compiling…
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Chart Desk — the TradingView-style price surface, powered by OpenAlgo Charts
// (npm openalgo-charts, Apache-2.0): full candles widget (top bar with symbol
// search + interval pills + chart types, drawing rail with 90 tools, indicator
// picker with 112 built-ins, objects/data/alerts panels, status line, replay,
// crosshair, touch layout). The deep product loops:
//   • bars ride OUR OWN data plane (/api/chartdesk/bars: SQLite mirror → live)
//   • every saved VolScript/Pine script becomes a registered study in the same
//     picker — AI-written, hand-written or copied from TradingView all run here
//   • a study's legend SOURCE button (hasSource) opens its code in the Script
//     Lab editor — chart → editor in one click
//   • the Script Lab editor pushes the running script onto this chart —
//     editor → chart in one click
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChartCandlestick, Sparkles, Braces, FileCode2 } from 'lucide-react';
import { create } from 'zustand';
import { setPersistedString } from '@/hooks/use-persisted-state';
import { useScriptLab } from '@/stores/scriptlab-store';
import { BUILTIN_SCRIPTS, defaultScript } from '@/lib/scriptlang/library';
import { CHART_TFS, SYMBOL_CATALOG, createVolosFeed } from './volos-feed';
import { getRegisteredScript, registerVolScript, slugifyScript } from './volscript-bridge';

// ── chartdesk store (non-persisted UI state; the widget persists its own) ─────

interface ChartDeskState {
  symbol: string;
  tf: string;
  status: string;
  scripts: string[]; // registered script names
  /** a script pushed while the chart was unmounted — added on next mount */
  pending: { code: string; name: string } | null;
  setDataset: (d: { symbol?: string; tf?: string }) => void;
  setStatus: (s: string) => void;
  pushScriptName: (name: string) => void;
  setPending: (p: { code: string; name: string } | null) => void;
}

export const useChartDesk = create<ChartDeskState>((set) => ({
  symbol: 'BTC',
  tf: '1h',
  status: 'connecting…',
  scripts: [],
  pending: null,
  setDataset: (d) => set((s) => ({ symbol: d.symbol ?? s.symbol, tf: d.tf ?? s.tf })),
  setStatus: (status) => set({ status }),
  pushScriptName: (name) =>
    set((s) => ({ scripts: s.scripts.includes(name) ? s.scripts : [...s.scripts, name] })),
  setPending: (pending) => set({ pending }),
}));

// ── the widget handle Script Lab pushes scripts onto ─────────────────────────

export interface ChartDeskHandle {
  addScriptToChart: (code: string, name?: string) => string | null;
  setSymbol: (symbol: string) => void;
}

let handle: ChartDeskHandle | null = null;
export function setChartDeskHandle(h: ChartDeskHandle | null) {
  handle = h;
}
export function getChartDeskHandle(): ChartDeskHandle | null {
  return handle;
}

/** one-click "open this script's code in the editor" — chart → Script Lab. */
export function openScriptInEditor(descriptorId: string) {
  const script = getRegisteredScript(descriptorId);
  const lab = useScriptLab.getState();
  if (script) {
    lab.loadScript({ name: script.name, code: script.code, category: 'trend', description: 'from the Chart Desk' });
  }
  setPersistedString('volos-view', 'scriptlab');
}

/** one-click "put this script on the price chart" — Script Lab → chart desk.
 *  Works even when the chart is unmounted: the script is queued and the
 *  Chart Desk adds it the moment it boots. */
export function pushScriptToChart(code: string, name?: string) {
  if (handle?.addScriptToChart(code, name)) {
    setPersistedString('volos-view', 'chartdesk');
    return 'pushed' as string | null;
  }
  useChartDesk.getState().setPending({ code, name: name ?? 'Script' });
  setPersistedString('volos-view', 'chartdesk');
  return 'queued';
}

// ── the view ──────────────────────────────────────────────────────────────────

export function PriceChartView() {
  const store = useChartDesk();
  const { symbol, tf, status, scripts } = store;
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);
  const registeredRef = useRef(false);

  // register the builtin script library + the user's saved scripts + the
  // editor draft (REGISTRATION ONLY — descriptors must exist in the registry
  // BEFORE the widget restores its saved layout, or the restore drops them
  // as "unavailable study").
  const registerAllScripts = useCallback(
    async (registerIndicator: (d: never) => void) => {
      let editorScript: { code: string; name: string } | null = null;
      // the product's curated library — registered synchronously, zero fetch
      for (const s of BUILTIN_SCRIPTS) {
        const id = `volscript:${slugifyScript(s.name)}`;
        registerVolScript(registerIndicator as never, id, s.name, s.code);
      }
      // the default editor script too — saved layouts reference it
      {
        const dTitle = defaultScript.match(/(?:indicator|strategy)\("([^\"]+)"\)/)?.[1] ?? 'Default Script';
        registerVolScript(registerIndicator as never, `volscript:${slugifyScript(dTitle)}`, dTitle, defaultScript);
      }
      // the script in the editor right now (unsaved draft) registers FIRST and
      // synchronously — the pending push too (both before any await)
      const pending = useChartDesk.getState().pending;
      if (pending) {
        const title = pending.name || 'Script';
        const id = `volscript:${slugifyScript(title)}`;
        registerVolScript(registerIndicator as never, id, title, pending.code);
        store.pushScriptName(title);
      }
      const lab = useScriptLab.getState();
      if (lab.scriptCode) {
        const name = lab.scriptName || 'Editor script';
        const id = `volscript:${slugifyScript(name)}`;
        registerVolScript(registerIndicator as never, id, name, lab.scriptCode);
        store.pushScriptName(name);
        editorScript = { code: lab.scriptCode, name };
      }
      try {
        const res = await fetch('/api/scriptlab/scripts');
        const j = (await res.json()) as { success?: boolean; data?: { scripts?: Array<{ id: string; name: string; code: string }> } };
        const scriptsList = j?.data?.scripts ?? [];
        for (const s of scriptsList.slice(0, 60)) {
          const id = `volscript:${slugifyScript(s.name)}`;
          registerVolScript(registerIndicator as never, id, s.name, s.code);
          store.pushScriptName(s.name);
        }
      } catch {
        /* library cold — the picker still has the 112 built-ins */
      }
      return editorScript;
    },
    [store],
  );

  useEffect(() => {
    let widget: { destroy: () => void; chart: unknown; on: (e: string, cb: (p: never) => void) => void } | null = null;
    let dead = false;

    const boot = async () => {
      try {
        // lazy tiers: the widget (toolbar/rail/dialogs) + the 112 indicators
        const core = (await import('openalgo-charts')) as typeof import('openalgo-charts');
        const indicators = (await import('openalgo-charts/indicators')) as typeof import('openalgo-charts/indicators');
        const widgetMod = (await import('openalgo-charts/widget')) as typeof import('openalgo-charts/widget');
        if (!registeredRef.current) {
          registeredRef.current = true;
          indicators.registerBuiltinIndicators();
        }
        if (dead || !hostRef.current) return;

        const feed = createVolosFeed({ onStatus: (s) => store.setStatus(s) });
        widget = widgetMod.createWidget(hostRef.current, {
          feed,
          symbol: 'BTC',
          exchange: 'BINANCE',
          interval: '1h',
          intervals: [...CHART_TFS],
          chartType: 'candlestick',
          theme: 'dark',
          persist: 'chartdesk',
          lookbackBars: 800,
          topbar: true,
          statusline: true,
          rail: true,
          panels: true,
          indicators: true,
          locale: 'en-US',
          now: () => Date.now(),
        }) as unknown as typeof widget;

        const w = widget as unknown as {
          on: (e: string, cb: (p: { symbol?: string; interval?: string }) => void) => void;
          ready: Promise<void>;
          chart: {
            addIndicator: (id: string) => unknown;
            on: (e: string, cb: (p: { indicatorId?: string }) => void) => void;
          };
          setSymbol: (s: string) => void;
          symbol: () => string;
          interval: () => string;
        };

        w.on('symbol', (p) => {
          if (p?.symbol) store.setDataset({ symbol: p.symbol.toUpperCase().slice(0, 10) });
        });
        w.on('interval', (p) => {
          if (p?.interval) store.setDataset({ tf: p.interval });
        });
        // the deep loop: a study's SOURCE button opens its code in the editor
        w.chart.on('indicatorSource', (p) => {
          if (p?.indicatorId?.startsWith('volscript:')) openScriptInEditor(p.indicatorId);
        });

        // expose the handle the Script Lab pushes scripts through
        setChartDeskHandle({
          addScriptToChart: (code, name) => {
            try {
              const title = name ?? code.match(/(?:indicator|strategy)\("([^"]+)"/)?.[1] ?? 'Script';
              const id = `volscript:${slugifyScript(title)}`;
              registerVolScript(core.registerIndicator as never, id, title, code);
              store.pushScriptName(title);
              w.chart.addIndicator(id);
              return id;
            } catch {
              return null;
            }
          },
          setSymbol: (s) => {
            w.setSymbol(s);
            store.setDataset({ symbol: s });
          },
        });

        // REGISTER every script descriptor NOW — synchronously for the
        // editor draft and the pending push — so the widget's saved-layout
        // restore (which runs while `ready` settles) finds them in the
        // registry instead of dropping them as "unavailable study"
        const editorScript = await registerAllScripts(core.registerIndicator as never);
        const pending = useChartDesk.getState().pending;
        useChartDesk.getState().setPending(null);

        // the persisted layout + FIRST bar load must land before studies can
        // be ADDED (a chart without series drops them)
        try {
          await w.ready;
        } catch {
          /* storage refused — defaults are up, studies can still be added */
        }

        // add the live instances: the pending push, then the editor draft
        const titleOf = (code: string, fallbackName?: string) =>
          fallbackName || code.match(/(?:indicator|strategy)\("([^"]+)"\)/)?.[1] || 'Script';
        if (pending) {
          try {
            w.chart.addIndicator(`volscript:${slugifyScript(titleOf(pending.code, pending.name))}`);
          } catch {
            /* compile error — the study's data status shows it */
          }
        }
        if (editorScript && !pending) {
          try {
            w.chart.addIndicator(`volscript:${slugifyScript(titleOf(editorScript.code, editorScript.name))}`);
          } catch {
            /* compile error — the editor shows it */
          }
        }

        if (!dead) {
          setReady(true);
          store.setStatus('live');
        }
      } catch (e) {
        if (!dead) setLibError(e instanceof Error ? e.message : 'failed to load OpenAlgo Charts');
      }
    };
    void boot();

    return () => {
      dead = true;
      setChartDeskHandle(null);
      try {
        widget?.destroy();
      } catch {
        /* already gone */
      }
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header strip */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/70 bg-zinc-950/60 px-3 py-1.5">
        <ChartCandlestick className="h-3.5 w-3.5 text-teal-400" />
        <span className="text-[11px] font-bold tracking-tight text-zinc-100">
          Chart<span className="text-teal-400">Desk</span>
        </span>
        <span className="text-[8px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
          openalgo charts · tradingview-style · candles · 112 indicators · 90 drawing tools · pine/volscript studies
        </span>
        <span className="ml-1 rounded-full bg-teal-950/60 px-1.5 py-0.5 font-mono text-[8.5px] font-bold text-teal-300 ring-1 ring-teal-500/30">
          {symbol} · {tf}
        </span>
        {status && (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider ring-1 ${
              status === 'live'
                ? 'bg-emerald-950/60 text-emerald-300 ring-emerald-500/30'
                : 'bg-zinc-900 text-zinc-400 ring-zinc-700/60'
            }`}
          >
            {status}
          </span>
        )}
        {scripts.length > 0 && (
          <span
            className="flex items-center gap-1 rounded-full bg-violet-950/60 px-1.5 py-0.5 text-[8.5px] font-bold text-violet-300 ring-1 ring-violet-500/30"
            title={scripts.join(' · ')}
          >
            <Braces className="h-2.5 w-2.5" />
            {scripts.length} volscript stud{scripts.length === 1 ? 'y' : 'ies'}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 font-mono text-[8px] text-zinc-600">
          <span className="flex items-center gap-1 rounded border border-zinc-800 px-1 py-0.5" title="the AI writes any indicator or strategy — Script Lab → AI Script Desk">
            <Sparkles className="h-2.5 w-2.5 text-violet-400" /> ai codegen → script lab
          </span>
          <span className="flex items-center gap-1 rounded border border-zinc-800 px-1 py-0.5" title="a study's legend ⌥ source button opens its code in the editor">
            <FileCode2 className="h-2.5 w-2.5 text-teal-400" /> source button → editor
          </span>
          <span className="flex items-center gap-1 rounded border border-zinc-800 px-1 py-0.5" title="24 USDT-perps in the symbol box — type to search">
            {SYMBOL_CATALOG.length} symbols
          </span>
        </span>
      </div>

      {/* the chart */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full w-full" />
        {!ready && !libError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#04060a] text-zinc-500">
            <ChartCandlestick className="h-6 w-6 animate-pulse text-teal-400/70" />
            <p className="text-[11px]">loading OpenAlgo Charts…</p>
          </div>
        )}
        {libError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#04060a] text-rose-300">
            <ChartCandlestick className="h-6 w-6" />
            <p className="text-[11px]">chart engine failed to load</p>
            <p className="max-w-[420px] text-center text-[9px] text-zinc-500">{libError}</p>
          </div>
        )}
      </div>
    </div>
  );
}

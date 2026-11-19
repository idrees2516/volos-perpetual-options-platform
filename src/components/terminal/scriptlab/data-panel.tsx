'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — DataPanel. Dataset controls (symbol / timeframe / window) with
// the provenance badge (SQLite kline mirror vs live sweep), coverage readout
// and one-click refresh. Changing the dataset auto re-runs the current script.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { RefreshCw, Database, Radio, Loader2 } from 'lucide-react';
import { useScriptLab, SCRIPTLAB_SYMBOLS, SCRIPTLAB_TFS } from '@/stores/scriptlab-store';
import { Button } from '@/components/ui/button';

const LIMITS = [240, 500, 1000];

export function DataPanel() {
  const {
    symbol,
    tf,
    limit,
    bars,
    barsSource,
    barsAsOf,
    barsLoading,
    barsError,
    setDataset,
    refreshBars,
    result,
  } = useScriptLab();

  const sourceLabel =
    barsSource === 'live'
      ? 'live binance-fapi sweep'
      : barsSource === 'store'
        ? 'sqlite kline mirror (native tf)'
        : barsSource === 'store-agg'
          ? 'sqlite mirror (aggregated)'
          : barsSource === 'store-stale'
            ? 'sqlite mirror (contiguous window)'
            : '—';

  const first = bars?.[0];
  const last = bars?.[bars.length - 1];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-2.5">
      {/* symbol */}
      <div>
        <p className="mb-1 text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-600">symbol</p>
        <div className="flex gap-1">
          {SCRIPTLAB_SYMBOLS.map((s) => (
            <button
              key={s}
              onClick={() => setDataset({ symbol: s })}
              className={`flex-1 rounded-md px-2 py-1.5 font-mono text-[11px] transition ${
                symbol === s ? 'bg-teal-950/70 text-teal-300 ring-1 ring-teal-500/40' : 'bg-zinc-900/60 text-zinc-500 hover:text-zinc-200'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* timeframe */}
      <div>
        <p className="mb-1 text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-600">timeframe</p>
        <div className="grid grid-cols-6 gap-1">
          {SCRIPTLAB_TFS.map((t) => (
            <button
              key={t}
              onClick={() => setDataset({ tf: t })}
              className={`rounded-md px-1 py-1.5 font-mono text-[10px] transition ${
                tf === t ? 'bg-teal-950/70 text-teal-300 ring-1 ring-teal-500/40' : 'bg-zinc-900/60 text-zinc-500 hover:text-zinc-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* window */}
      <div>
        <p className="mb-1 text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-600">bars</p>
        <div className="flex gap-1">
          {LIMITS.map((l) => (
            <button
              key={l}
              onClick={() => setDataset({ limit: l })}
              className={`flex-1 rounded-md px-2 py-1.5 font-mono text-[10px] transition ${
                limit === l ? 'bg-teal-950/70 text-teal-300 ring-1 ring-teal-500/40' : 'bg-zinc-900/60 text-zinc-500 hover:text-zinc-200'
              }`}
            >
              {l}
            </button>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 border-zinc-800 bg-zinc-950 px-2 text-[10px]"
            onClick={() => void refreshBars()}
            disabled={barsLoading}
            title="Re-fetch bars and re-run the script"
          >
            {barsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      {/* provenance */}
      <div className="mt-auto space-y-1.5 rounded-md border border-zinc-800/80 bg-zinc-950/50 px-2.5 py-2">
        <p className="flex items-center gap-1.5 text-[9.5px] font-semibold text-zinc-300">
          {barsSource === 'live' ? (
            <Radio className="h-3 w-3 text-emerald-400" />
          ) : (
            <Database className="h-3 w-3 text-teal-400" />
          )}
          {sourceLabel}
        </p>
        {barsError && <p className="font-mono text-[9px] text-rose-400">{barsError}</p>}
        {bars && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[9px] text-zinc-500">
            <dt>bars loaded</dt>
            <dd className="text-right text-zinc-300">{bars.length}</dd>
            <dt>first (UTC)</dt>
            <dd className="text-right text-zinc-300">{first ? new Date(first.ts).toISOString().slice(0, 16).replace('T', ' ') : '—'}</dd>
            <dt>last (UTC)</dt>
            <dd className="text-right text-zinc-300">{last ? new Date(last.ts).toISOString().slice(0, 16).replace('T', ' ') : '—'}</dd>
            <dt>last spot</dt>
            <dd className="text-right text-zinc-300">{last ? last.c.toFixed(1) : '—'}</dd>
            {result?.ok && (
              <>
                <dt>engine</dt>
                <dd className="text-right text-zinc-300">{result.runtimeMs} ms</dd>
                <dt>output</dt>
                <dd className="text-right text-zinc-300">
                  {result.plots.length + result.shapes.length + result.hlines.length} series
                </dd>
              </>
            )}
          </dl>
        )}
        {barsAsOf && (
          <p className="text-[8px] text-zinc-700">
            fetched {Math.max(0, Math.round((Date.now() - barsAsOf) / 1000))}s ago · orderflow natives available: delta · cvd · buyvol · sellvol
          </p>
        )}
      </div>
    </div>
  );
}

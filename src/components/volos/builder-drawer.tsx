'use client';

// ─────────────────────────────────────────────────────────────────────────────
// BuilderDrawer — v1.9 leg editor: drag strikes, tenors and ratios on the
// current strategy, every metric re-resolving live against spot.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { X, Pencil } from 'lucide-react';
import type { MarketState } from '@/hooks/use-market';
import { spotOf } from '@/hooks/use-market';
import { useUi } from '@/stores/ui-store';
import { useStrategy } from '@/stores/strategy-store';
import { analyzeStrategy, distributionalRisk, strategyHorizon } from '@/lib/pricing';
import { BASE_IV } from '@/lib/types';
import { fmtUsd, fmtNum } from '@/lib/format';
import { LegsPanel } from './legs-panel';
import { Stat } from './bits';

export function BuilderDrawer({ market }: { market: MarketState }) {
  const { builderOpen, setBuilderOpen } = useUi();
  const { legs, updateLeg, addLeg, removeLeg, underlying, size, setSize, name } = useStrategy();
  const spot = spotOf(market, underlying);

  const analysis = useMemo(
    () => (legs.length ? analyzeStrategy(legs, spot, underlying, undefined, size) : null),
    [legs, spot, underlying, size],
  );
  const horizon = legs.length ? Math.max(1, Math.round(strategyHorizon(legs) * 365)) : 1;
  const risk = useMemo(
    () => (analysis ? distributionalRisk(analysis.payoffAt, spot, BASE_IV[underlying], horizon) : null),
    [analysis, spot, underlying, horizon],
  );

  if (!builderOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-950/60 backdrop-blur-sm" role="dialog" aria-label="strategy builder">
      <div className="flex h-full w-[520px] flex-col border-l border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Pencil className="h-4 w-4 text-teal-400" />
          <div>
            <div className="text-sm font-bold text-zinc-50">Builder</div>
            <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-500">
              {name || 'custom structure'} · {underlying} @ {Math.round(spot).toLocaleString()}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setBuilderOpen(false)}
            aria-label="close builder"
            className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <LegsPanel
            legs={legs}
            resolved={analysis?.resolved}
            onChange={updateLeg}
            onAdd={(l) => addLeg(l)}
            onRemove={removeLeg}
          />

          {analysis && risk && (
            <>
              <div className="grid grid-cols-4 gap-2">
                <Stat label={analysis.netPremium >= 0 ? 'Net credit' : 'Net debit'} value={fmtUsd(Math.abs(analysis.netPremium))} tone={analysis.netPremium >= 0 ? 'teal' : 'default'} />
                <Stat label="Max loss" value={fmtUsd(analysis.maxLoss)} tone="neg" />
                <Stat label="Prob. profit" value={`${fmtNum(risk.pop * 100, 1)}%`} tone="pos" />
                <Stat label="Δ / ν" value={`${fmtNum(analysis.netDelta, 3)} / ${fmtUsd(analysis.netVega)}`} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">Size</span>
                {[1, 2, 3, 5, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setSize(n)}
                    className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors ${
                      size === n ? 'bg-teal-400/20 text-teal-300' : 'text-zinc-500 hover:bg-zinc-800'
                    }`}
                  >
                    {n}×
                  </button>
                ))}
                <span className="ml-auto text-[10px] text-zinc-600">every metric updates live at 60fps</span>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2">
          <span className="text-[9px] text-zinc-600">
            strikes are % multipliers of live spot — re-strikable per asset
          </span>
          <button
            type="button"
            onClick={() => setBuilderOpen(false)}
            className="rounded-md bg-teal-400 px-3 py-1.5 text-[11px] font-bold text-zinc-950 hover:bg-teal-300"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

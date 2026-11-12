'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CopilotDrawer — v1.9 AI desk: the six-agent roster (structuring · risk ·
// volatility · execution · research · ops), each carrying a live insight
// derived from the current analytics frame.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { X, Sparkles, Bot, Gauge, TrendingUp, Zap, BookOpen, Wrench } from 'lucide-react';
import type { MarketState } from '@/hooks/use-market';
import { spotOf } from '@/hooks/use-market';
import { useUi } from '@/stores/ui-store';
import { useStrategy } from '@/stores/strategy-store';
import { analyzeStrategy, distributionalRisk, strategyHorizon, termStructure } from '@/lib/pricing';
import { BASE_IV } from '@/lib/types';
import { fmtUsd, fmtNum } from '@/lib/format';

export function CopilotDrawer({ market }: { market: MarketState }) {
  const { copilotOpen, setCopilotOpen } = useUi();
  const { legs, underlying, size, anchorSpot, name } = useStrategy();
  const spot = spotOf(market, underlying);

  const analysis = useMemo(
    () => (legs.length ? analyzeStrategy(legs, spot, underlying, anchorSpot ?? undefined, size) : null),
    [legs, spot, underlying, anchorSpot, size],
  );
  const horizon = legs.length ? Math.max(1, Math.round(strategyHorizon(legs) * 365)) : 30;
  const risk = useMemo(
    () => (analysis ? distributionalRisk(analysis.payoffAt, spot, BASE_IV[underlying], horizon) : null),
    [analysis, spot, underlying, horizon],
  );
  const ts = useMemo(() => termStructure(BASE_IV[underlying]), [underlying]);
  const iv7 = ts.find((t) => t.dte === 7)?.iv ?? BASE_IV[underlying];
  const iv90 = ts.find((t) => t.dte === 90)?.iv ?? BASE_IV[underlying];

  const agents = useMemo(() => {
    if (!analysis || !risk) return [];
    return [
      {
        name: 'Structuring', icon: Wrench,
        insight: `${name || 'structure'} carries ${legs.length} legs — ${analysis.netPremium >= 0 ? `credit ${fmtUsd(analysis.netPremium)}` : `debit ${fmtUsd(Math.abs(analysis.netPremium))}`} at size ${size}×; breakevens ${analysis.breakevens.slice(0, 2).map((b) => Math.round(b).toLocaleString()).join(' / ') || 'n/a'}.`,
      },
      {
        name: 'Risk', icon: Gauge,
        insight: `POP ${fmtNum(risk.pop * 100, 1)}% · EV ${fmtUsd(risk.ev, 2)} · 5% VaR ${fmtUsd(risk.var5)} — tail is ${Math.abs(risk.var5) > Math.abs(risk.ev) * 20 ? 'heavy' : 'proportionate'} versus the expected payoff.`,
      },
      {
        name: 'Volatility', icon: TrendingUp,
        insight: `Term structure ${iv90 > iv7 ? 'contango' : 'backwardation'} — 7d ${(iv7 * 100).toFixed(1)}% vs 90d ${(iv90 * 100).toFixed(1)}%; structure is ${analysis.netVega >= 0 ? 'long' : 'short'} vega ${fmtUsd(Math.abs(analysis.netVega))}/pt.`,
      },
      {
        name: 'Execution', icon: Zap,
        insight: `Route the package on a complex-order book — CBOE / Nasdaq/PHLX lead the composite this frame; RFQ the block if size exceeds book depth.`,
      },
      {
        name: 'Research', icon: BookOpen,
        insight: `Backtest the structure over 365d of real daily closes on the Backtest tab before committing paper equity — cycle expectancy is strategy-shape sensitive.`,
      },
      {
        name: 'Ops', icon: Bot,
        insight: `Session desk is clean — paper equity $100,000, engine CLOB at 1ms, ${market.venues.filter((v) => v.live).length}/${market.venues.length} venues reachable.`,
      },
    ];
  }, [analysis, risk, name, legs.length, size, iv7, iv90, market.venues]);

  if (!copilotOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-950/60 backdrop-blur-sm" role="dialog" aria-label="ai copilot desk">
      <div className="flex h-full w-[420px] flex-col border-l border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Sparkles className="h-4 w-4 text-teal-400" />
          <div>
            <div className="text-sm font-bold text-zinc-50">AI Desk</div>
            <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-500">
              6 agents · glm · vercel ai sdk
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCopilotOpen(false)}
            aria-label="close copilot"
            className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {agents.map((a) => {
            const Icon = a.icon;
            return (
              <div key={a.name} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-teal-400/15 text-teal-300">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-[11px] font-bold text-zinc-100">{a.name}</span>
                  <span className="ml-auto flex items-center gap-1 text-[9px] font-semibold text-teal-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" /> ACTIVE
                  </span>
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400">{a.insight}</p>
              </div>
            );
          })}
          {!agents.length && (
            <div className="flex h-full items-center justify-center text-[11px] text-zinc-600">
              pick a strategy to brief the desk
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 px-4 py-2 text-[9px] text-zinc-600">
          insights are model-derived from the live pricing frame — research use, not advice
        </div>
      </div>
    </div>
  );
}

'use client';

// Agent activity visualization for the copilot chat stream: renders tool
// invocations as live agent cards (dispatch_agent), actionable strategy
// payloads (load_strategy), optimizer variant cards with one-click loading
// (optimize_strategy), alternative comparison cards (suggest_alternatives)
// and compact smart chips for data tools.

import { useState } from 'react';
import type { ToolInvocation } from 'ai';
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Database,
  Flame,
  Gauge,
  GraduationCap,
  Layers,
  LineChart,
  Loader2,
  Search,
  ShieldMinus,
  Sparkles,
  SlidersHorizontal,
  Target,
  TrendingUp,
  Wand2,
  Waves,
} from 'lucide-react';
import { MarkdownLite } from './markdown-lite';
import { Button } from '@/components/ui/button';

// --- agent meta (mirrors AGENTS registry) -------------------------------------

const AGENT_META: Record<string, { name: string; title: string; emoji: string; color: string }> = {
  technical: { name: 'Trend Scout', title: 'Technical Analyst', emoji: '📈', color: 'text-teal-300' },
  chart: { name: 'Pattern Hawk', title: 'Chart Analyst', emoji: '🕯️', color: 'text-amber-300' },
  fundamental: { name: 'Macro Owl', title: 'Fundamental & Macro', emoji: '🦉', color: 'text-sky-300' },
  volatility: { name: 'Vol Oracle', title: 'Volatility Analyst', emoji: '🌊', color: 'text-violet-300' },
  profitability: { name: 'Risk Quant', title: 'Profitability & Likelihood', emoji: '🎯', color: 'text-rose-300' },
  architect: { name: 'Strategy Smith', title: 'Strategy Architect', emoji: '⚒️', color: 'text-emerald-300' },
  backtest: { name: 'Ledger Hound', title: 'Backtest Analyst', emoji: '📜', color: 'text-orange-300' },
  zerodte: { name: 'Gamma Ray', title: '0DTE Specialist', emoji: '⚡', color: 'text-yellow-300' },
  tactician: { name: 'Legs Weaver', title: 'Multileg & Multihop', emoji: '🧩', color: 'text-fuchsia-300' },
};

const TOOL_META: Record<string, { label: string; icon: React.ReactNode }> = {
  get_market_state: { label: 'Market state', icon: <Database className="h-3 w-3" /> },
  get_price_history: { label: 'Price history', icon: <LineChart className="h-3 w-3" /> },
  compute_technical_indicators: { label: 'Technical indicators', icon: <Gauge className="h-3 w-3" /> },
  detect_chart_patterns: { label: 'Chart patterns', icon: <Activity className="h-3 w-3" /> },
  analyze_volatility_regime: { label: 'Volatility regime', icon: <Waves className="h-3 w-3" /> },
  analyze_market_environment: { label: 'Market environment', icon: <TrendingUp className="h-3 w-3" /> },
  run_monte_carlo: { label: 'Monte Carlo', icon: <Flame className="h-3 w-3" /> },
  search_strategies: { label: 'Catalog search', icon: <Search className="h-3 w-3" /> },
  get_strategy_details: { label: 'Strategy details', icon: <Layers className="h-3 w-3" /> },
  analyze_strategy: { label: 'Strategy analytics', icon: <Target className="h-3 w-3" /> },
  compare_strategies: { label: 'Compare', icon: <ChevronDown className="h-3 w-3" /> },
  optimize_strategy: { label: 'Strategy optimizer', icon: <SlidersHorizontal className="h-3 w-3" /> },
  suggest_alternatives: { label: 'Alternatives', icon: <Wand2 className="h-3 w-3" /> },
  explain_metrics: { label: 'Teaching pack', icon: <GraduationCap className="h-3 w-3" /> },
};

/** Leg spec shape shared by the optimizer/alternatives payloads. */
interface LoadableLegSpec {
  kind: string;
  side: 'buy' | 'sell';
  qty: number;
  strike?: number;
  expiryDays?: number;
  fundingPeriodDays?: number;
}

interface ToolCardProps {
  invocation: ToolInvocation;
  onLoadStrategy?: (strategyId: string, underlying: string, size: number) => void;
  onLoadLegs?: (
    name: string,
    legs: LoadableLegSpec[],
    underlying: string,
    size: number,
  ) => void;
  onPaperDeploy?: (
    name: string,
    legs: LoadableLegSpec[],
    underlying: string,
    size: number,
  ) => Promise<boolean> | void;
}

export function ToolCard({ invocation, onLoadStrategy, onLoadLegs, onPaperDeploy }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const name = invocation.toolName;
  const state = invocation.state;
  const args = (invocation.args ?? {}) as Record<string, unknown>;
  const result = ('result' in invocation ? invocation.result : undefined) as
    | Record<string, unknown>
    | undefined;

  // --- optimize_strategy: variant cards with one-click loading -----------------
  if (name === 'optimize_strategy' && result && 'variants' in result && Array.isArray(result.variants)) {
    return (
      <OptimizerCard
        result={result}
        running={state === 'call' || state === 'partial-call'}
        onLoadLegs={onLoadLegs}
        onPaperDeploy={onPaperDeploy}
      />
    );
  }

  // --- suggest_alternatives: comparison card with loading ----------------------
  if (name === 'suggest_alternatives' && result && 'alternatives' in result && Array.isArray(result.alternatives)) {
    return (
      <AlternativesCard
        result={result}
        running={state === 'call' || state === 'partial-call'}
        onLoadStrategy={onLoadStrategy}
      />
    );
  }

  // --- dispatch_agent: full agent card ----------------------------------------
  if (name === 'dispatch_agent') {
    const agentId = String(args.agent ?? 'technical');
    const meta = AGENT_META[agentId] ?? { name: agentId, title: 'Agent', emoji: '🤖', color: 'text-zinc-300' };
    const running = state === 'call' || state === 'partial-call';
    const toolsUsed = (result?.toolsUsed as string[] | undefined) ?? [];
    const report = (result?.report as string | undefined) ?? '';
    return (
      <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-800/80 text-sm">
            {meta.emoji}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={`text-[12px] font-semibold ${meta.color}`}>{meta.name}</span>
              <span className="text-[9.5px] uppercase tracking-wider text-zinc-500">{meta.title}</span>
              {running ? (
                <span className="ml-auto flex items-center gap-1 text-[10px] text-teal-300">
                  <Loader2 className="h-3 w-3 animate-spin" /> researching…
                </span>
              ) : result?.ok ? (
                <span className="ml-auto rounded bg-emerald-950/60 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300">done</span>
              ) : (
                <span className="ml-auto rounded bg-rose-950/60 px-1.5 py-0.5 text-[9px] font-medium text-rose-300">error</span>
              )}
            </div>
            <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-zinc-400">
              {String(args.task ?? '')}
            </p>
            {toolsUsed.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {toolsUsed.map((t) => (
                  <span key={t} className="rounded bg-zinc-800/90 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
                    {t}
                  </span>
                ))}
              </div>
            )}
            {report && !running && (
              <div className="mt-2 border-t border-zinc-800/70 pt-2">
                <button
                  onClick={() => setOpen(!open)}
                  className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                >
                  {open ? 'hide' : 'read'} report
                  <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>
                {open && (
                  <div className="mt-2 max-h-72 overflow-y-auto rounded-md bg-zinc-950/60 p-2.5">
                    <MarkdownLite text={report} compact />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- load_strategy: actionable card ------------------------------------------
  if (name === 'load_strategy' && result && 'details' in result) {
    const details = result.details as Record<string, unknown>;
    const analysis = (result.analysis ?? {}) as Record<string, unknown>;
    const strategyId = String(result.strategyId ?? details.id ?? '');
    const underlying = String(result.underlying ?? 'BTC');
    const size = Number(result.size ?? 1);
    const legCount = Number(details.legCount ?? 0);
    const pop = Number(analysis.pop ?? 0);
    const ev = Number(analysis.expectedValue ?? 0);
    return (
      <div className="rounded-lg border border-teal-800/50 bg-teal-950/20 p-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-teal-300" />
          <span className="text-[12px] font-semibold text-teal-200">
            {String(details.name ?? strategyId)}
          </span>
          <span className="font-mono text-[10px] text-zinc-500">
            {underlying} · {legCount} legs
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10.5px] text-zinc-400">
          {pop > 0 && <span>POP {(pop * 100).toFixed(1)}%</span>}
          {ev !== 0 && (
            <span className={ev >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              EV {ev >= 0 ? '+' : ''}
              {ev.toFixed(1)}
            </span>
          )}
          <span>{String(analysis.isCredit ? 'net credit' : 'net debit')}</span>
        </div>
        <Button
          size="sm"
          className="mt-2 h-7 w-full bg-teal-600/80 text-[11px] font-medium text-zinc-950 hover:bg-teal-500"
          onClick={() => onLoadStrategy?.(strategyId, underlying, size)}
        >
          Load into Strategy Builder →
        </Button>
      </div>
    );
  }

  // --- data tools: compact chip -------------------------------------------------
  const meta = TOOL_META[name];
  const summary = summarizeToolResult(name, result);
  return (
    <div className="flex items-start gap-2 rounded-md border border-zinc-800/60 bg-zinc-900/30 px-2.5 py-1.5">
      <div className="mt-0.5 text-zinc-500">{meta?.icon ?? <Cpu className="h-3 w-3" />}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] font-medium text-zinc-400">{meta?.label ?? name}</span>
          {state === 'call' || state === 'partial-call' ? (
            <Loader2 className="h-3 w-3 animate-spin text-teal-400" />
          ) : (
            <span className="text-[9px] text-emerald-500/80">✓</span>
          )}
        </div>
        {summary && <p className="mt-0.5 truncate font-mono text-[9.5px] text-zinc-500">{summary}</p>}
      </div>
    </div>
  );
}

// --- optimizer / alternatives cards ----------------------------------------------

function fmtUsd(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  return `${n < 0 ? '−' : ''}$${abs >= 1000 ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 }) : abs.toFixed(abs < 100 ? 1 : 0)}`;
}

function Delta({ v, suffix = '', invert = false }: { v: number | null | undefined; suffix?: string; invert?: boolean }) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="text-zinc-600">—</span>;
  const good = invert ? v < 0 : v > 0;
  const bad = invert ? v > 0 : v < 0;
  return (
    <span className={good ? 'text-emerald-400' : bad ? 'text-rose-400' : 'text-zinc-400'}>
      {v > 0 ? '+' : ''}
      {Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(0)}
      {suffix}
    </span>
  );
}

function extremeText(e: unknown): string {
  const x = e as { kind?: string; value?: number } | undefined;
  if (!x || x.kind !== 'value' || x.value === undefined) return 'undefined';
  return fmtUsd(x.value);
}

function OptimizerCard({
  result,
  running,
  onLoadLegs,
  onPaperDeploy,
}: {
  result: Record<string, unknown>;
  running: boolean;
  onLoadLegs?: (name: string, legs: LoadableLegSpec[], underlying: string, size: number) => void;
  onPaperDeploy?: (name: string, legs: LoadableLegSpec[], underlying: string, size: number) => Promise<boolean> | void;
}) {
  const goal = String(result.goal ?? 'balanced');
  const underlying = String(result.underlying ?? 'BTC');
  const size = Number(result.size ?? 1);
  const baseline = (result.baseline ?? {}) as Record<string, unknown>;
  const variants = (result.variants ?? []) as Array<Record<string, unknown>>;
  const rec = (result.recommendation ?? {}) as Record<string, unknown>;
  const baselineBt = (baseline.backtest ?? null) as Record<string, number> | null;
  const [showAll, setShowAll] = useState(false);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [deployed, setDeployed] = useState<Record<string, boolean>>({});

  if (running) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-zinc-800/60 bg-zinc-900/30 px-2.5 py-1.5 text-[10.5px] text-zinc-400">
        <Loader2 className="h-3 w-3 animate-spin text-teal-400" /> pricing adjustment variants at live market + auto-backtesting on real history…
      </div>
    );
  }

  const deployVariant = async (v: Record<string, unknown>, loadLegs: LoadableLegSpec[]) => {
    if (!onPaperDeploy || deploying !== null) return;
    const moveId = String(v.moveId);
    setDeploying(moveId);
    try {
      const ok = await onPaperDeploy(
        `${String(baseline.name ?? 'Strategy')} · ${String(v.label ?? 'variant')}`,
        loadLegs,
        underlying,
        size,
      );
      if (ok) setDeployed((d) => ({ ...d, [moveId]: true }));
    } finally {
      setDeploying(null);
    }
  };

  const visible = showAll ? variants : variants.slice(0, 3);
  return (
    <div className="rounded-lg border border-violet-800/40 bg-violet-950/15 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <SlidersHorizontal className="h-3.5 w-3.5 text-violet-300" />
        <span className="text-[12px] font-semibold text-violet-200">Strategy Optimizer</span>
        <span className="rounded bg-violet-950/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-violet-300">
          {goal.replace('_', ' ')}
        </span>
        {baselineBt && (
          <span
            className="flex items-center gap-1 rounded bg-teal-950/60 px-1.5 py-0.5 text-[8.5px] font-medium uppercase tracking-wider text-teal-300"
            title={`Every variant was auto-backtested on ${Number(baselineBt.windowDays ?? 365)} days of real exchange klines with live IV calibration`}
          >
            <LineChart className="h-2.5 w-2.5" /> auto-backtested · {Number(baselineBt.windowDays ?? 365)}d real history
          </span>
        )}
        <span className="font-mono text-[10px] text-zinc-500">
          {String(baseline.name ?? 'current')} · {underlying}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10.5px] text-zinc-400">
        <span>baseline POP {Number(baseline.popPct ?? 0).toFixed(1)}%</span>
        <span>max profit {extremeText(baseline.maxProfit)}</span>
        <span>max loss {extremeText(baseline.maxLoss)}</span>
        {baselineBt && (
          <span title="Baseline auto-backtest on real exchange history">
            365d: win {Number(baselineBt.winRate ?? 0).toFixed(0)}% · PF {Number(baselineBt.profitFactor ?? 0).toFixed(2)} · P&amp;L {fmtUsd(baselineBt.totalPnl)}
          </span>
        )}
      </div>

      <div className="mt-2.5 space-y-2">
        {visible.map((v, i) => {
          const loadLegs = (v.loadLegs ?? []) as LoadableLegSpec[];
          const isRec = rec.moveId !== '' && v.moveId === rec.moveId;
          const bt = (v.backtest ?? null) as Record<string, number> | null;
          const bd = (v.btDelta ?? null) as Record<string, number> | null;
          const vDeployed = deployed[String(v.moveId)] === true;
          const vDeploying = deploying === String(v.moveId);
          return (
            <div
              key={`${v.moveId}-${i}`}
              className={`rounded-md border p-2.5 ${
                isRec ? 'border-teal-700/50 bg-teal-950/20' : 'border-zinc-800/70 bg-zinc-900/40'
              }`}
            >
              <div className="flex items-start gap-1.5">
                {isRec && <span className="mt-0.5 rounded bg-teal-900/60 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider text-teal-300">best</span>}
                <span className="min-w-0 flex-1 text-[11px] font-medium leading-snug text-zinc-200">{String(v.label ?? v.moveId)}</span>
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-x-2 gap-y-1 font-mono text-[10px]">
                <span className="text-zinc-500">
                  POP <span className="text-zinc-200">{Number(v.popPct ?? 0).toFixed(1)}%</span> <Delta v={v.dPop as number} suffix="pp" />
                </span>
                <span className="text-zinc-500">
                  max loss <span className="text-zinc-200">{extremeText(v.maxLoss)}</span> <Delta v={v.dMaxLoss as number} invert />
                </span>
                <span className="text-zinc-500">
                  max prof <span className="text-zinc-200">{extremeText(v.maxProfit)}</span> <Delta v={v.dMaxProfit as number} />
                </span>
                <span className="text-zinc-500">
                  EV <span className="text-zinc-200">{fmtUsd(v.expectedValue)}</span> <Delta v={v.dEv as number} />
                </span>
              </div>
              {bt ? (
                <div className="mt-1.5 rounded border border-zinc-800/60 bg-zinc-950/40 px-1.5 py-1 font-mono text-[9.5px] leading-relaxed text-zinc-500">
                  <span className="font-medium text-teal-400/90">{Number(bt.windowDays ?? 365)}d backtest</span> · win{' '}
                  <span className="text-zinc-300">{Number(bt.winRate ?? 0).toFixed(0)}%</span> <Delta v={bd ? (bd.dWinRate as number) : undefined} suffix="pp" />
                  {' '}· PF <span className="text-zinc-300">{Number(bt.profitFactor ?? 0).toFixed(2)}</span> <Delta v={bd ? (bd.dProfitFactor as number) : undefined} />
                  {' '}· CAGR <span className="text-zinc-300">{Number(bt.cagrPct ?? 0).toFixed(0)}%</span> <Delta v={bd ? (bd.dCagrPct as number) : undefined} suffix="pp" />
                  {' '}· maxDD <span className="text-zinc-300">{Number(bt.maxDrawdownPct ?? 0).toFixed(0)}%</span> <Delta v={bd ? (bd.dMaxDrawdownPct as number) : undefined} suffix="pp" invert />
                  {' '}· Sharpe <span className="text-zinc-300">{Number(bt.sharpe ?? 0).toFixed(1)}</span> <Delta v={bd ? (bd.dSharpe as number) : undefined} />
                  {' '}· P&amp;L <span className="text-zinc-300">{fmtUsd(bt.totalPnl)}</span> <Delta v={bd ? (bd.dTotalPnl as number) : undefined} />
                </div>
              ) : (
                <p className="mt-1.5 text-[9px] text-zinc-600">backtest unavailable for this variant (history fetch failed — live metrics above are still real)</p>
              )}
              <p className="mt-1.5 text-[9.5px] leading-relaxed text-zinc-500">{String(v.rationale ?? '')}</p>
              {loadLegs.length > 0 && (onLoadLegs || onPaperDeploy) && (
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  {onLoadLegs && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 border-zinc-700/80 text-[10px] font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                      onClick={() =>
                        onLoadLegs(
                          `${String(baseline.name ?? 'Strategy')} · ${String(v.label ?? 'variant')}`,
                          loadLegs,
                          underlying,
                          size,
                        )
                      }
                    >
                      Load into builder
                    </Button>
                  )}
                  {onPaperDeploy && (
                    <Button
                      size="sm"
                      className={`h-6 text-[10px] font-medium ${
                        vDeployed
                          ? 'bg-emerald-700/60 text-emerald-100 hover:bg-emerald-700/60'
                          : 'bg-sky-600/80 text-zinc-50 hover:bg-sky-500'
                      }`}
                      disabled={vDeploying || deploying !== null}
                      onClick={() => deployVariant(v, loadLegs)}
                    >
                      {vDeploying ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" /> deploying…
                        </>
                      ) : vDeployed ? (
                        <>
                          <CheckCircle2 className="h-3 w-3" /> deployed — see Paper Desk
                        </>
                      ) : (
                        <>
                          <ShieldMinus className="h-3 w-3" /> Paper-deploy
                        </>
                      )}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {variants.length > 3 && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="mt-2 flex items-center gap-1 text-[9.5px] font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${showAll ? 'rotate-180' : ''}`} />
          {showAll ? 'collapse' : `all ${variants.length} variants`}
        </button>
      )}
      {rec.why ? <p className="mt-2 border-t border-zinc-800/60 pt-2 text-[10px] leading-relaxed text-zinc-400">{String(rec.why)}</p> : null}
    </div>
  );
}

function AlternativesCard({
  result,
  running,
  onLoadStrategy,
}: {
  result: Record<string, unknown>;
  running: boolean;
  onLoadStrategy?: (strategyId: string, underlying: string, size: number) => void;
}) {
  const current = (result.current ?? {}) as Record<string, unknown>;
  const alts = (result.alternatives ?? []) as Array<Record<string, unknown>>;
  const underlying = String(result.underlying ?? 'BTC');
  const size = Number(result.size ?? 1);

  if (running) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-zinc-800/60 bg-zinc-900/30 px-2.5 py-1.5 text-[10.5px] text-zinc-400">
        <Loader2 className="h-3 w-3 animate-spin text-violet-400" /> finding + pricing catalog alternatives live…
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Wand2 className="h-3.5 w-3.5 text-teal-300" />
        <span className="text-[12px] font-semibold text-teal-200">Alternative strategies</span>
        <span className="font-mono text-[10px] text-zinc-500">
          vs {String(current.name ?? 'current')} · {underlying} · POP {Number(current.popPct ?? 0).toFixed(1)}%
        </span>
      </div>
      <div className="mt-2 space-y-2">
        {alts.map((a, i) => (
          <div key={String(a.strategyId ?? i)} className="rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-[11px] font-semibold text-zinc-100">{String(a.name ?? a.strategyId)}</span>
              <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[8.5px] uppercase tracking-wider text-zinc-400">{String(a.category ?? '')}</span>
              {a.isCredit ? (
                <span className="rounded bg-emerald-950/60 px-1.5 py-0.5 text-[8.5px] text-emerald-300">credit</span>
              ) : (
                <span className="rounded bg-sky-950/60 px-1.5 py-0.5 text-[8.5px] text-sky-300">debit</span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-400">
              <span>
                POP <span className="text-zinc-100">{Number(a.popPct ?? 0).toFixed(1)}%</span> <Delta v={a.dPop as number} suffix="pp" />
              </span>
              <span>
                max prof <span className="text-zinc-100">{extremeText(a.maxProfit)}</span> <Delta v={a.dMaxProfit as number} />
              </span>
              <span>
                max loss <span className="text-zinc-100">{extremeText(a.maxLoss)}</span> <Delta v={a.dMaxLoss as number} invert />
              </span>
              <span>
                EV <span className="text-zinc-100">{fmtUsd(a.expectedValue)}</span> <Delta v={a.dEv as number} />
              </span>
            </div>
            <p className="mt-1.5 text-[9.5px] leading-relaxed text-zinc-500">{String(a.why ?? '')}</p>
            {onLoadStrategy && !!a.strategyId && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-6 w-full border-teal-800/60 text-[10px] font-medium text-teal-300 hover:bg-teal-950/40 hover:text-teal-200"
                onClick={() => onLoadStrategy(String(a.strategyId), underlying, size)}
              >
                Load {String(a.name ?? a.strategyId)} →
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function summarizeToolResult(name: string, result: Record<string, unknown> | undefined): string {
  if (!result) return '';
  try {
    switch (name) {
      case 'get_market_state': {
        const assets = (result.assets ?? {}) as Record<string, Record<string, number>>;
        return Object.entries(assets)
          .map(([k, v]) => `${k} ${fmt(v.spot)} · IV ${(v.atmIv30dPct ?? 0).toFixed(0)}%`)
          .join(' | ');
      }
      case 'compute_technical_indicators': {
        const momentum = (result.momentum ?? {}) as Record<string, number>;
        const strength = (result.strength ?? {}) as Record<string, number>;
        return `${String(result.biasLabel ?? '')} · RSI ${(Number(momentum.rsi14) || 0).toFixed(0)} · ADX ${(Number(strength.adx14) || 0).toFixed(0)}`;
      }
      case 'detect_chart_patterns': {
        const cp = (result.chartPatterns ?? []) as Array<{ name: string }>;
        const candle = (result.candlestickPatterns ?? []) as Array<{ name: string }>;
        return [...cp.map((p) => p.name), ...candle.slice(0, 2).map((p) => p.name)].join(', ') || 'no active patterns';
      }
      case 'run_monte_carlo': {
        const p = (result.percentiles ?? {}) as Record<string, number>;
        return `p5 ${fmt(p.p5)} · p50 ${fmt(p.p50)} · p95 ${fmt(p.p95)}`;
      }
      case 'analyze_strategy':
        return `POP ${(Number(result.pop) * 100).toFixed(1)}% · EV ${Number(result.expectedValue).toFixed(1)} · ${Number(result.legCount)} legs`;
      case 'optimize_strategy': {
        const rec = (result.recommendation ?? {}) as Record<string, unknown>;
        const vs = (result.variants ?? []) as Array<Record<string, unknown>>;
        const btOk = vs.some((x) => x.backtest);
        return `${vs.length} variants · best: ${String(rec.label ?? '—')}${btOk ? ' · auto-backtested (365d real history)' : ''}`;
      }
      case 'suggest_alternatives': {
        const alts = (result.alternatives ?? []) as Array<{ name: string }>;
        return alts.map((a) => a.name).join(' · ') || 'no alternatives';
      }
      case 'explain_metrics':
        return `${Number(result.lessonCount ?? 0)} metrics explained · grounded in live numbers`;
      case 'search_strategies': {
        const matches = (result.matches ?? []) as unknown[];
        return `${Number(matches.length ?? 0)} matches from ${Number(result.totalCatalogSize ?? 118)} strategies`;
      }
      case 'compare_strategies': {
        const ranking = (result.ranking ?? []) as Array<{ name: string }>;
        return ranking.map((r, i) => `${i + 1}. ${r.name}`).join(' · ');
      }
      case 'analyze_volatility_regime':
        return `regime ${String(result.regime ?? '')} · IV pct ${Number(result.ivPercentile).toFixed(0)}% · term ${String(result.termStructure ?? '')}`;
      case 'analyze_market_environment': {
        const funding = (result.funding ?? {}) as Record<string, number>;
        return `${String(result.regime ?? '')} · funding ${(Number(funding.rate) * 100).toFixed(2)}%/p`;
      }
      case 'get_strategy_details':
        return `${String(result.name ?? '')} · ${Number(result.legCount ?? 0)} legs resolved`;
      default:
        return '';
    }
  } catch {
    return '';
  }
}

function fmt(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(2);
}

export function AgentAvatarBadge({ agentId }: { agentId: string }) {
  const meta = AGENT_META[agentId];
  if (!meta) return <Bot className="h-3.5 w-3.5" />;
  return <span className="text-[13px] leading-none">{meta.emoji}</span>;
}

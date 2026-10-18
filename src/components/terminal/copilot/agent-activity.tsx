'use client';

// Agent activity visualization for the copilot chat stream: renders tool
// invocations as live agent cards (dispatch_agent), actionable strategy
// payloads (load_strategy) and compact smart chips for data tools.

import { useState } from 'react';
import type { ToolInvocation } from 'ai';
import {
  Activity,
  Bot,
  ChevronDown,
  Cpu,
  Database,
  Flame,
  Gauge,
  Layers,
  LineChart,
  Loader2,
  Search,
  Sparkles,
  Target,
  TrendingUp,
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
};

interface ToolCardProps {
  invocation: ToolInvocation;
  onLoadStrategy?: (strategyId: string, underlying: string, size: number) => void;
}

export function ToolCard({ invocation, onLoadStrategy }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const name = invocation.toolName;
  const state = invocation.state;
  const args = (invocation.args ?? {}) as Record<string, unknown>;
  const result = invocation.result as Record<string, unknown> | undefined;

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
      case 'compute_technical_indicators':
        return `${String(result.biasLabel ?? '')} · RSI ${(Number(result.momentum?.rsi14) || 0).toFixed(0)} · ADX ${(Number(result.strength?.adx14) || 0).toFixed(0)}`;
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
      case 'search_strategies':
        return `${Number(result.matches?.length ?? 0)} matches from ${Number(result.totalCatalogSize ?? 118)} strategies`;
      case 'compare_strategies': {
        const ranking = (result.ranking ?? []) as Array<{ name: string }>;
        return ranking.map((r, i) => `${i + 1}. ${r.name}`).join(' · ');
      }
      case 'analyze_volatility_regime':
        return `regime ${String(result.regime ?? '')} · IV pct ${Number(result.ivPercentile).toFixed(0)}% · term ${String(result.termStructure ?? '')}`;
      case 'analyze_market_environment':
        return `${String(result.regime ?? '')} · funding ${(Number(result.funding?.rate) * 100).toFixed(2)}%/p`;
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

'use client';

// Deep Research view: the multi-agent pipeline runner + dossier reader.
// Streams NDJSON events from /api/ai/research and renders live agent stages,
// reports, strategy payloads and the final synthesized dossier.

import { useCallback, useRef, useState } from 'react';
import { useCopilot, type AgentStageState } from '@/stores/copilot-store';
import { useStrategy } from '@/stores/strategy-store';
import { useToast } from '@/hooks/use-toast';
import { resolveStrategyLegs, strategyById } from '@/lib/strategies';
import { MarkdownLite } from './markdown-lite';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Play,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type { ViewId } from '@/components/terminal/topbar';

const AGENT_ORDER = [
  'technical',
  'chart',
  'fundamental',
  'volatility',
  'profitability',
  'backtest',
  'zerodte',
  'tactician',
  'architect',
  'director',
];

export function ResearchView({ onView }: { onView: (v: ViewId) => void }) {
  const { runs, activeRunId, startRun, upsertStage, patchRun, appendDossier } = useCopilot();
  const { underlying } = useStrategy();
  const { toast } = useToast();
  const [focus, setFocus] = useState('');
  const [horizon, setHorizon] = useState(30);
  const [risk, setRisk] = useState<'conservative' | 'balanced' | 'aggressive'>('balanced');
  const [desks, setDesks] = useState<'full' | 'core'>('full');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [dataSource, setDataSource] = useState<'live' | 'simulated' | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = activeRunId ? runs[activeRunId] : null;

  const launch = useCallback(async () => {
    if (running) return;
    const runId = startRun({ asset: underlying, focus, horizonDays: horizon, riskAppetite: risk });
    setRunning(true);
    setElapsed(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/ai/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: underlying, focus, horizonDays: horizon, riskAppetite: risk, desks }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`research pipeline failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          handleEvent(runId, evt, { upsertStage, patchRun, appendDossier });
          if (evt.type === 'heartbeat' && typeof evt.elapsedS === 'number') setElapsed(evt.elapsedS);
          if (evt.type === 'start') setDataSource((evt.dataSource as 'live' | 'simulated') ?? null);
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        patchRun(runId, { done: true, error: err instanceof Error ? err.message : String(err) });
        toast({ title: 'Deep research failed', description: err instanceof Error ? err.message : 'unknown error', variant: 'destructive' });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running, underlying, focus, horizon, risk, desks, startRun, upsertStage, patchRun, appendDossier, toast]);

  const stop = () => abortRef.current?.abort();

  const stages = run ? AGENT_ORDER.filter((a) => run.stages[a]) : [];
  const waiting = run && !run.done ? AGENT_ORDER.filter((a) => !run.stages[a]) : [];

  return (
    <div className="flex h-full flex-col">
      {/* launch controls */}
      <div className="space-y-2.5 border-b border-zinc-800/70 bg-zinc-950/40 p-3">
        <div className="flex items-center gap-2">
          <Badge className="bg-violet-950/60 text-violet-300 hover:bg-violet-950/60">
            <Sparkles className="mr-1 h-3 w-3" /> Deep Research
          </Badge>
          <span className="font-mono text-[10px] text-zinc-500">
            {desks === 'full' ? '9 agents · live exchanges · full dossier' : '6 agents · live exchanges · dossier'}
          </span>
          {dataSource && (
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[8.5px] uppercase ${
                dataSource === 'live'
                  ? 'border-teal-700/50 bg-teal-950/40 text-teal-300'
                  : 'border-amber-700/50 bg-amber-950/30 text-amber-300'
              }`}
            >
              {dataSource === 'live' ? 'live exchange data' : 'simulated data'}
            </span>
          )}
          {running && <span className="font-mono text-[10px] text-teal-300">{elapsed}s</span>}
        </div>
        <Input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder={`Optional focus — e.g. "income strategy for chop" (${underlying})`}
          className="h-8 border-zinc-800 bg-zinc-900/70 text-[11px]"
        />
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500">Horizon</span>
            <select
              value={horizon}
              onChange={(e) => setHorizon(Number(e.target.value))}
              className="h-7 rounded-md border border-zinc-800 bg-zinc-900/70 px-1.5 font-mono text-[10.5px] text-zinc-300"
            >
              {[7, 14, 30, 60, 90].map((d) => (
                <option key={d} value={d}>{d}d</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500">Risk</span>
            <select
              value={risk}
              onChange={(e) => setRisk(e.target.value as typeof risk)}
              className="h-7 rounded-md border border-zinc-800 bg-zinc-900/70 px-1.5 font-mono text-[10.5px] text-zinc-300"
            >
              <option value="conservative">conservative</option>
              <option value="balanced">balanced</option>
              <option value="aggressive">aggressive</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500">Desk</span>
            <select
              value={desks}
              onChange={(e) => setDesks(e.target.value as 'full' | 'core')}
              className="h-7 rounded-md border border-zinc-800 bg-zinc-900/70 px-1.5 font-mono text-[10.5px] text-zinc-300"
              title="Full adds Ledger Hound (backtests), Gamma Ray (0DTE) and Legs Weaver (multileg/multihop)"
            >
              <option value="full">full · +backtest/0DTE/multileg</option>
              <option value="core">core · 6 agents</option>
            </select>
          </div>
          {running ? (
            <Button size="sm" variant="destructive" className="ml-auto h-7 px-2.5 text-[10.5px]" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              className="ml-auto h-7 bg-violet-600/90 px-2.5 text-[10.5px] font-medium text-zinc-50 hover:bg-violet-500"
              onClick={launch}
            >
              <Play className="mr-1 h-3 w-3" /> Run pipeline
            </Button>
          )}
        </div>
      </div>

      {/* pipeline + results */}
      <div className="flex-1 overflow-y-auto p-3">
        {!run && (
          <div className="mt-8 space-y-3 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-teal-500/20">
              <Sparkles className="h-6 w-6 text-violet-300" />
            </div>
            <p className="text-[12px] font-medium text-zinc-300">Run the full agentic research desk</p>
            <p className="mx-auto max-w-[320px] text-[10.5px] leading-relaxed text-zinc-500">
              Trend Scout, Pattern Hawk, Macro Owl and Vol Oracle read {underlying} off live exchange data. Risk Quant
              stress-tests likelihood. Ledger Hound backtests on real history, Gamma Ray scans 0DTE, Legs Weaver builds
              multihop/multileg. Strategy Smith designs the trade; the Director writes the dossier.
            </p>
          </div>
        )}

        {run && (
          <div className="space-y-3">
            {/* stage timeline */}
            <div className="space-y-1.5">
              {stages.map((agentId) => {
                const st = run.stages[agentId];
                return <StageRow key={agentId} stage={st} />;
              })}
              {waiting.map((agentId) => (
                <div key={agentId} className="flex items-center gap-2 rounded-md border border-zinc-800/40 bg-zinc-900/20 px-2.5 py-1.5 opacity-50">
                  <span className="h-2 w-2 rounded-full bg-zinc-700" />
                  <span className="text-[10.5px] text-zinc-500">queued: {agentId}</span>
                </div>
              ))}
            </div>

            {run.error && (
              <div className="rounded-md border border-rose-900/60 bg-rose-950/30 p-2 text-[10.5px] text-rose-300">
                {run.error}
              </div>
            )}

            {/* strategies */}
            {run.strategies.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Desk recommendations · load to builder
                </p>
                {run.strategies.map((s) => (
                  <StrategyPayloadCard key={s.strategyId} strategy={s} underlying={run.asset} onView={onView} />
                ))}
              </div>
            )}

            {/* dossier */}
            {run.dossier && (
              <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-teal-300" />
                  <span className="text-[11px] font-semibold text-teal-200">Research Dossier</span>
                  {!run.done && <Loader2 className="h-3 w-3 animate-spin text-teal-400" />}
                </div>
                <MarkdownLite text={run.dossier} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StageRow({ stage }: { stage: AgentStageState }) {
  const [open, setOpen] = useState(false);
  const icon =
    stage.status === 'done' ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    ) : stage.status === 'error' ? (
      <XCircle className="h-3.5 w-3.5 text-rose-400" />
    ) : (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-400" />
    );
  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-900/30 px-2.5 py-1.5">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => stage.report && setOpen(!open)}>
        {icon}
        <span className="text-[11px] font-medium text-zinc-200">{stage.name}</span>
        <span className="text-[9px] uppercase tracking-wider text-zinc-500">{stage.title}</span>
        {stage.report && (
          <ChevronDown className={`ml-auto h-3 w-3 text-zinc-600 transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>
      {open && stage.report && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-zinc-950/60 p-2.5">
          <MarkdownLite text={stage.report} compact />
        </div>
      )}
    </div>
  );
}

function StrategyPayloadCard({
  strategy,
  underlying,
  onView,
}: {
  strategy: NonNullable<ReturnType<typeof useCopilot.getState>['runs'][string]>['strategies'][number];
  underlying: string;
  onView: (v: ViewId) => void;
}) {
  const { loadStrategy } = useStrategy();
  const { toast } = useToast();
  const spec = strategyById(strategy.strategyId);

  const load = () => {
    if (spec) {
      // Rebuild builder legs from the server-resolved payload (anchored to live spot).
      let seq = 0;
      const legs = strategy.resolvedLegs.map((l) => {
        seq += 1;
        const leg = {
          id: `leg-rs-${Date.now().toString(36)}-${seq}`,
          kind: l.kind as never,
          side: l.side as never,
          qty: l.qty,
        } as import('@/lib/types').Leg;
        if (l.strike !== undefined) leg.strike = l.strike;
        if (l.expiryDays !== undefined) leg.expiryDays = l.expiryDays;
        if (l.fundingPeriodDays !== undefined) leg.fundingPeriodDays = l.fundingPeriodDays;
        return leg;
      });
      const n = loadStrategy(strategy.name, legs);
      toast({ title: `Loaded ${strategy.name}`, description: `${n} legs on ${underlying} — strategies workspace updated.` });
      onView('strategies');
    } else {
      toast({ title: 'Strategy not found', description: strategy.strategyId, variant: 'destructive' });
    }
  };

  return (
    <div className="rounded-lg border border-teal-800/50 bg-teal-950/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-teal-200">{strategy.name}</span>
        <Badge variant="outline" className="h-4 border-zinc-700 px-1.5 text-[9px] text-zinc-400">
          {strategy.category}
        </Badge>
        <span className="font-mono text-[10px] text-zinc-500">{strategy.legCount} legs</span>
      </div>
      <p className="mt-1 line-clamp-2 text-[10.5px] leading-snug text-zinc-400">{strategy.description}</p>
      <Button
        size="sm"
        className="mt-2 h-7 w-full bg-teal-600/80 text-[11px] font-medium text-zinc-950 hover:bg-teal-500"
        onClick={load}
      >
        Load into Strategy Builder →
      </Button>
    </div>
  );
}

// --- NDJSON event handling ------------------------------------------------------

function handleEvent(
  runId: string,
  evt: Record<string, unknown>,
  api: {
    upsertStage: (id: string, stage: AgentStageState) => void;
    patchRun: (id: string, patch: Partial<ReturnType<typeof useCopilot.getState>['runs'][string]>) => void;
    appendDossier: (id: string, text: string) => void;
  },
) {
  switch (evt.type) {
    case 'start': {
      api.patchRun(runId, { spot: Number(evt.spot ?? 0), stages: {}, order: [], dossier: '', strategies: [], done: false, error: undefined });
      break;
    }
    case 'stage': {
      const agent = String(evt.agent);
      const prev = useCopilot.getState().runs[runId]?.stages[agent];
      api.upsertStage(runId, {
        agent,
        name: String(evt.name ?? agent),
        title: String(evt.title ?? ''),
        status: (evt.status as AgentStageState['status']) ?? 'running',
        error: evt.error ? String(evt.error) : prev?.error,
        report: prev?.report,
        toolTrace: prev?.toolTrace,
      });
      break;
    }
    case 'agent-report': {
      const agent = String(evt.agent);
      const prev = useCopilot.getState().runs[runId]?.stages[agent];
      api.upsertStage(runId, {
        agent,
        name: String(evt.name ?? agent),
        title: String(evt.title ?? ''),
        status: prev?.status === 'error' ? 'error' : 'done',
        report: String(evt.report ?? ''),
        toolTrace: (evt.toolTrace as AgentStageState['toolTrace']) ?? [],
        error: prev?.error,
      });
      break;
    }
    case 'strategies': {
      const run = useCopilot.getState().runs[runId];
      if (run) {
        api.patchRun(runId, {
          strategies: [
            ...run.strategies,
            ...((evt.strategies as never[]) ?? []).filter(
              (s) => !run.strategies.some((x) => x.strategyId === (s as { strategyId: string }).strategyId),
            ),
          ],
        });
      }
      break;
    }
    case 'dossier-delta': {
      api.appendDossier(runId, String(evt.text ?? ''));
      break;
    }
    case 'done': {
      api.patchRun(runId, { done: true });
      break;
    }
    case 'error': {
      api.patchRun(runId, { done: true, error: String(evt.message ?? 'pipeline error') });
      break;
    }
  }
}

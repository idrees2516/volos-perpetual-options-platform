'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Decision Hub — THE unified decision surface of the whole product.
//
// One panel that answers "what should I do right now" by fusing every data
// family the terminal has: the statistical model room (GARCH, HMM, Kalman,
// OU, Merton tails, ML P(up), Kelly, mixed-process Monte Carlo), the signal
// battery, the vol cycle, the forecast layer, order flow, breadth, funding
// and the live paper book — into stance · confidence · pillars · strategy
// fit · risk sizing · the action battery. Every card carries the numbers
// behind it, and the Ask-AI button hands the whole surface to the copilot.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PanelState } from '@/components/ui/panel-state';
import { useCopilot } from '@/stores/copilot-store';
import { usePersistedState } from '@/hooks/use-persisted-state';
import type { DecisionHubReport, HubAsset, ModelVerdict, Pillar, HubAction, StrategyFit } from '@/lib/decision/hub';
import {
  Activity,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Compass,
  Crosshair,
  Flame,
  Gauge,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Waves,
} from 'lucide-react';

const ASSETS: HubAsset[] = ['BTC', 'ETH', 'SOL'];
const POLL_MS = 30_000;

const STANCE_STYLE = [
  { min: 45, label: 'RISK-ON', cls: 'text-teal-300', bar: 'bg-teal-400' },
  { min: 18, label: 'CONSTRUCTIVE', cls: 'text-emerald-300', bar: 'bg-emerald-400' },
  { min: -18, label: 'TWO-WAY', cls: 'text-zinc-300', bar: 'bg-zinc-400' },
  { min: -45, label: 'DEFENSIVE', cls: 'text-amber-300', bar: 'bg-amber-400' },
  { min: -101, label: 'RISK-OFF', cls: 'text-rose-300', bar: 'bg-rose-400' },
];

function stanceStyle(stance: number) {
  return STANCE_STYLE.find((s) => stance >= s.min) ?? STANCE_STYLE[STANCE_STYLE.length - 1];
}

const PILLAR_ICON: Record<Pillar['id'], React.ComponentType<{ className?: string }>> = {
  trend: TrendingUp,
  models: BrainCircuit,
  flow: Waves,
  derivatives: Crosshair,
  positions: Target,
};

const ACTION_STYLE: Record<HubAction['kind'], { cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  deploy: { cls: 'bg-teal-950/60 text-teal-300 ring-teal-500/30', icon: TrendingUp },
  hedge: { cls: 'bg-amber-950/60 text-amber-300 ring-amber-500/30', icon: ShieldAlert },
  trim: { cls: 'bg-rose-950/60 text-rose-300 ring-rose-500/30', icon: TrendingDown },
  harvest: { cls: 'bg-emerald-950/60 text-emerald-300 ring-emerald-500/30', icon: Sparkles },
  wait: { cls: 'bg-zinc-800/60 text-zinc-300 ring-zinc-600/40', icon: Activity },
};

function scoreBar(score: number, barCls: string): React.ReactElement {
  const w = Math.min(100, Math.abs(score) / 2);
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/70">
      <div className={`absolute left-1/2 h-full ${barCls}`} style={{ width: `${w}%`, transform: score >= 0 ? 'none' : 'scaleX(-1)', transformOrigin: 'left' }} />
      <div className="absolute left-1/2 top-[-2px] h-[10px] w-px bg-zinc-600" />
    </div>
  );
}

function Chip({ children, tone = 'default', title }: { children: React.ReactNode; tone?: 'default' | 'pos' | 'neg' | 'warn' | 'info'; title?: string }) {
  const tones = {
    default: 'bg-zinc-800/60 text-zinc-300 ring-zinc-600/40',
    pos: 'bg-teal-950/60 text-teal-300 ring-teal-500/30',
    neg: 'bg-rose-950/60 text-rose-300 ring-rose-500/30',
    warn: 'bg-amber-950/60 text-amber-300 ring-amber-500/30',
    info: 'bg-sky-950/60 text-sky-300 ring-sky-500/30',
  };
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1 ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Metric({ label, value, tone, hint }: { label: string; value: string; tone?: 'pos' | 'neg' | 'warn'; hint?: string }) {
  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5" title={hint}>
      <p className="text-[8px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`font-mono text-[11px] font-semibold ${tone === 'pos' ? 'text-teal-400' : tone === 'neg' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : 'text-zinc-200'}`}>{value}</p>
    </div>
  );
}

function pctTone(v: number): 'pos' | 'neg' | undefined {
  return v > 0 ? 'pos' : v < 0 ? 'neg' : undefined;
}

// --- pillar card -----------------------------------------------------------------------

function PillarCard({ pillar }: { pillar: Pillar }) {
  const [open, setOpen] = useState(false);
  const Icon = PILLAR_ICON[pillar.id];
  const s = stanceStyle(pillar.score);
  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-950/40 px-2 py-1.5">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
        <Icon className="h-3 w-3 text-zinc-400" />
        <span className="flex-1 truncate text-[10px] font-medium text-zinc-300">{pillar.label}</span>
        {pillar.confidence === 0 && <span className="text-[8px] uppercase text-zinc-600">no data</span>}
        <span className={`font-mono text-[10px] font-bold ${s.cls}`}>{pillar.score > 0 ? '+' : ''}{pillar.score}</span>
      </button>
      <div className="mt-1.5">{scoreBar(pillar.score, s.bar)}</div>
      {open && pillar.drivers.length > 0 && (
        <div className="mt-1.5 space-y-0.5 border-t border-zinc-800/60 pt-1.5">
          {pillar.drivers.map((d, i) => (
            <div key={i} className="flex items-baseline justify-between gap-2 text-[9px]">
              <span className="truncate text-zinc-500">{d.label}</span>
              <span className="font-mono text-zinc-300">
                {Number.isFinite(d.value) ? d.value.toFixed(Math.abs(d.value) < 1 ? 3 : 1) : '—'}
                <span className={`ml-1.5 font-mono ${(d.contribution ?? 0) > 0 ? 'text-teal-500' : 'text-rose-500'}`}>
                  {d.contribution != null ? (d.contribution > 0 ? '+' : '') + d.contribution : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- model verdict card ----------------------------------------------------------------

function ModelCard({ m }: { m: ModelVerdict }) {
  const nums = m.numbers.filter((n) => n.value != null).slice(0, 4);
  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-950/40 px-2 py-1.5">
      <p className="text-[8px] uppercase tracking-wider text-zinc-500">{m.label}</p>
      <p className="mt-0.5 font-mono text-[10px] font-semibold leading-tight text-zinc-200">{m.headline}</p>
      {nums.length > 0 && (
        <div className="mt-1 grid grid-cols-2 gap-1">
          {nums.map((n, i) => (
            <div key={i} className="text-[8px] leading-tight">
              <span className="text-zinc-500">{n.label} </span>
              <span className="font-mono text-zinc-300">{n.value != null && Number.isFinite(n.value) ? n.value : '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- strategy fit row ------------------------------------------------------------------

function FitRow({ s }: { s: StrategyFit }) {
  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-950/40 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <div className="h-6 w-1 rounded-full" style={{ background: `linear-gradient(to top, #2dd4bf ${s.score}%, #27272a ${s.score}%)` }} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-semibold text-zinc-200">{s.name}</p>
          <p className="text-[8px] uppercase tracking-wider text-zinc-500">{s.category} · {s.view} · c{s.complexity}</p>
        </div>
        <span className="font-mono text-[11px] font-bold text-teal-300">{s.score}</span>
      </div>
      {s.why.length > 0 && (
        <ul className="mt-1 space-y-0.5 border-t border-zinc-800/60 pt-1">
          {s.why.map((w, i) => (
            <li key={i} className="truncate text-[9px] text-zinc-500" title={w}>› {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- action card -----------------------------------------------------------------------

function ActionCard({ a }: { a: HubAction }) {
  const style = ACTION_STYLE[a.kind];
  const Icon = style.icon;
  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-950/40 p-2">
      <div className="flex items-center gap-2">
        <Chip tone={a.kind === 'deploy' ? 'pos' : a.kind === 'hedge' ? 'warn' : a.kind === 'trim' ? 'neg' : a.kind === 'harvest' ? 'pos' : 'default'}>
          <Icon className="h-2.5 w-2.5" /> {a.kind}
        </Chip>
        <p className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-100">{a.title}</p>
      </div>
      <p className="mt-1 text-[9px] leading-relaxed text-zinc-400">{a.rationale}</p>
      {a.numbers.filter((n) => n.value != null).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {a.numbers.filter((n) => n.value != null).map((n, i) => (
            <Chip key={i} title={n.label}>{n.label} {n.value != null && Number.isFinite(n.value) ? n.value : '—'}</Chip>
          ))}
        </div>
      )}
      {a.strategyIds.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 border-t border-zinc-800/60 pt-1.5">
          <span className="text-[8px] uppercase tracking-wider text-zinc-600">candidates</span>
          {a.strategyIds.map((id) => (
            <Chip key={id} tone="info">{id}</Chip>
          ))}
        </div>
      )}
    </div>
  );
}

// --- the panel -------------------------------------------------------------------------

export function DecisionHubPanel() {
  const [asset, setAsset] = usePersistedState<HubAsset>('volos-decision-hub-asset', 'BTC');
  const [report, setReport] = useState<DecisionHubReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const askAi = useCopilot((s) => s.askAi);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/decision?asset=${asset}`, { cache: 'no-store', signal: ctl.signal });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `decision hub ${res.status}`);
      setReport(body.report as DecisionHubReport);
      setError(null);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [asset]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [load]);

  const stance = report ? stanceStyle(report.stance) : null;

  const ask = useCallback(() => {
    if (!report) return;
    askAi(
      `Explain the current Decision Hub for ${report.asset}: stance ${report.stance} (${report.stanceLabel}) at ${report.confidence}% confidence, vol verdict ${report.volVerdict ?? '—'}, HMM ${report.context.hmmLabel ?? '—'}. Walk me through which pillar and model verdicts drive it, whether you agree with the top action "${report.actions[0]?.title ?? 'stand aside'}", and what sizing the Kelly/CVaR block allows.`,
    );
  }, [askAi, report]);

  const pUps = useMemo(() => {
    if (!report) return [];
    const r = report.forecast;
    return [
      { label: 'climatology', v: r.pUpClimatology },
      { label: 'ML', v: r.pUpMl },
      { label: 'MC fan', v: r.pUpFan },
    ].filter((x): x is { label: string; v: number } => x.v != null);
  }, [report]);

  return (
    <div className="space-y-2 p-3">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <Compass className="h-4 w-4 text-teal-400" />
        <span className="text-[12px] font-bold tracking-wide text-zinc-100">DECISION HUB</span>
        <span className="text-[9px] uppercase tracking-wider text-zinc-500">
          every data family fused · {report ? `${report.horizonMin} min horizon` : '…'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {ASSETS.map((a) => (
            <button
              key={a}
              onClick={() => setAsset(a)}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold font-mono ${a === asset ? 'bg-teal-950 text-teal-300 ring-1 ring-teal-500/40' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {a}
            </button>
          ))}
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => void load()} title="Refresh">
            {refreshing ? <Loader2 className="h-3 w-3 animate-spin text-zinc-400" /> : <RefreshCw className="h-3 w-3 text-zinc-400" />}
          </Button>
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[9px] text-teal-300" onClick={ask} disabled={!report}>
            <BrainCircuit className="h-3 w-3" /> Ask AI
          </Button>
        </div>
      </div>

      <PanelState loading={loading} error={error} empty={!report && !loading ? 'decision hub unavailable' : null} onRetry={() => void load()} skeletonRows={7}>
        {report && stance && (
          <div className="space-y-2">
            {/* stance header */}
            <div className="rounded border border-zinc-800/70 bg-gradient-to-r from-zinc-950/80 to-zinc-900/40 p-2.5">
              <div className="flex items-baseline gap-2">
                <span className={`font-mono text-2xl font-black ${stance.cls}`}>{report.stance > 0 ? '+' : ''}{report.stance}</span>
                <span className={`text-[12px] font-bold tracking-wider ${stance.cls}`}>{report.stanceLabel}</span>
                <span className="ml-auto text-right font-mono text-[10px] text-zinc-400">
                  {report.asset} @ {report.spot < 10 ? report.spot.toFixed(3) : report.spot.toFixed(0)}
                </span>
              </div>
              <div className="mt-2">{scoreBar(report.stance, stance.bar)}</div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Chip tone={report.confidence >= 60 ? 'pos' : report.confidence >= 40 ? 'warn' : 'default'} title="confidence">
                  <Gauge className="h-2.5 w-2.5" /> conf {report.confidence}% · agree {Math.round(report.agreement * 100)}%
                </Chip>
                {report.volVerdict && (
                  <Chip tone={report.volVerdict === 'CHEAP' ? 'pos' : report.volVerdict === 'RICH' ? 'warn' : 'default'} title="IV vs GARCH forecast">
                    <Flame className="h-2.5 w-2.5" /> vol {report.volVerdict} {report.volEdgePts != null ? `${report.volEdgePts > 0 ? '+' : ''}${report.volEdgePts}pts` : ''}
                  </Chip>
                )}
                {report.context.hmmLabel && (
                  <Chip tone={report.context.hmmLabel === 'extreme' || report.context.hmmLabel === 'volatile' ? 'neg' : 'info'} title="HMM dominant state">
                    HMM {report.context.hmmLabel} {report.context.hmmProb != null ? `${Math.round(report.context.hmmProb * 100)}%` : ''}
                  </Chip>
                )}
                {report.context.trendLabel && <Chip title="Kalman trend">trend {report.context.trendLabel}</Chip>}
                {report.context.ivRank != null && <Chip title="IV rank">IV rank {Math.round(report.context.ivRank)}</Chip>}
                {report.context.fundingPctile != null && <Chip title="funding percentile">funding p{Math.round(report.context.fundingPctile)}</Chip>}
              </div>
            </div>

            {/* actions first — the answer */}
            {report.actions.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">What to do right now</p>
                {report.actions.map((a) => (
                  <ActionCard key={a.id} a={a} />
                ))}
              </div>
            )}

            {/* pillars */}
            <div className="space-y-1.5">
              <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">The five pillars</p>
              <div className="grid gap-1.5 md:grid-cols-2">{report.pillars.map((p) => <PillarCard key={p.id} pillar={p} />)}</div>
            </div>

            {/* model room */}
            {report.models.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Model room ({report.models.length} live verdicts)</p>
                <div className="grid gap-1.5 md:grid-cols-2">{report.models.map((m) => <ModelCard key={m.id} m={m} />)}</div>
              </div>
            )}

            {/* strategy fit */}
            {report.strategyFit.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Top strategy fits (of 131, scored on this context)</p>
                <div className="grid gap-1.5 md:grid-cols-2">{report.strategyFit.map((s) => <FitRow key={s.id} s={s} />)}</div>
              </div>
            )}

            {/* risk + forecast cross-check */}
            <div className="grid gap-2 md:grid-cols-2">
              <div className="space-y-1.5 rounded border border-zinc-800/70 bg-zinc-950/40 p-2">
                <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Sizing & risk (per {report.horizonMin} min trade)</p>
                <div className="grid grid-cols-3 gap-1">
                  <Metric label="f* (Kelly)" value={report.risk.kellyFull != null ? `${(report.risk.kellyFull * 100).toFixed(1)}%` : '—'} />
                  <Metric label="half-Kelly" value={report.risk.kellyHalf != null ? `${(report.risk.kellyHalf * 100).toFixed(1)}%` : '—'} tone={report.risk.kellyHalf != null && report.risk.kellyHalf > 0 ? 'pos' : undefined} hint="the size cap the autopilot respects" />
                  <Metric label="CVaR 95" value={report.risk.cvar95Pct != null ? `${report.risk.cvar95Pct.toFixed(1)}%` : '—'} tone={report.risk.cvar95Pct != null ? 'neg' : undefined} hint="expected shortfall of the h-step distribution" />
                  <Metric label="VaR 95" value={report.risk.var95Pct != null ? `${report.risk.var95Pct.toFixed(1)}%` : '—'} tone="neg" />
                  <Metric label="max DD" value={report.risk.maxDdPct != null ? `${report.risk.maxDdPct.toFixed(1)}%` : '—'} tone="warn" hint="of the fitted window" />
                  <Metric label="margin util" value={report.positions.marginUtilPct != null ? `${report.positions.marginUtilPct.toFixed(1)}%` : '—'} tone={report.positions.marginUtilPct != null && report.positions.marginUtilPct > 60 ? 'warn' : undefined} />
                </div>
              </div>
              <div className="space-y-1.5 rounded border border-zinc-800/70 bg-zinc-950/40 p-2">
                <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Forecast cross-check {report.forecast.modelLabel ? `(${report.forecast.modelLabel})` : ''}</p>
                <div className="grid grid-cols-3 gap-1">
                  <Metric label="drift @ h" value={report.forecast.driftPct != null ? `${report.forecast.driftPct.toFixed(2)}%` : '—'} tone={report.forecast.driftPct != null ? pctTone(report.forecast.driftPct) : undefined} />
                  <Metric label="exp move" value={report.forecast.expectedMovePct != null ? `±${report.forecast.expectedMovePct.toFixed(2)}%` : '—'} />
                  <Metric label="P(up) agree" value={report.forecast.agreementPct != null ? `${report.forecast.agreementPct}%` : '—'} tone={report.forecast.agreementPct != null && report.forecast.agreementPct >= 67 ? 'pos' : 'warn'} hint="climatology vs ML vs Monte Carlo" />
                </div>
                {pUps.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {pUps.map((p) => (
                      <Chip key={p.label} tone={p.v >= 0.5 ? 'pos' : 'neg'}>{p.label} P↑ {(p.v * 100).toFixed(0)}%</Chip>
                    ))}
                    {report.forecast.bandLoPct != null && report.forecast.bandHiPct != null && (
                      <Chip title="mixed-process Monte Carlo band">MC band {report.forecast.bandLoPct.toFixed(1)}%…{report.forecast.bandHiPct.toFixed(1)}%</Chip>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* book + breadth + watch */}
            <div className="grid gap-2 md:grid-cols-2">
              <div className="rounded border border-zinc-800/70 bg-zinc-950/40 p-2">
                <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Paper book</p>
                {report.positions.count === 0 ? (
                  <p className="mt-1 text-[9px] text-zinc-500">flat — the positions pillar sleeps</p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Chip>{report.positions.count} open</Chip>
                    {report.positions.netDeltaUsd != null && (
                      <Chip tone={report.positions.netDeltaUsd > 0 ? 'pos' : 'neg'}>net δ ${Math.round(report.positions.netDeltaUsd).toLocaleString()}</Chip>
                    )}
                    {report.positions.alerts && report.positions.alerts.critical > 0 && <Chip tone="neg">{report.positions.alerts.critical} critical</Chip>}
                    {report.positions.decisionCounts &&
                      Object.entries(report.positions.decisionCounts)
                        .filter(([, n]) => n > 0)
                        .map(([k, n]) => (
                          <Chip key={k} tone={k === 'EXIT' || k === 'TAKE_PROFIT' ? 'warn' : 'info'}>{k} {n}</Chip>
                        ))}
                    {report.positions.healthAvg != null && <Chip tone={report.positions.healthAvg >= 60 ? 'pos' : report.positions.healthAvg >= 40 ? 'warn' : 'neg'}>health {Math.round(report.positions.healthAvg)}</Chip>}
                  </div>
                )}
                {report.breadth && (
                  <div className="mt-1.5 flex flex-wrap gap-1 border-t border-zinc-800/60 pt-1.5">
                    <Chip tone={((report.breadth.advancers ?? 0) > (report.breadth.decliners ?? 0)) ? 'pos' : 'neg'} title="whole-market breadth">
                      {report.breadth.advancers ?? '—'}↑ {report.breadth.decliners ?? '—'}↓
                    </Chip>
                    {report.breadth.medianChangePct != null && <Chip>med {report.breadth.medianChangePct.toFixed(2)}%</Chip>}
                    {report.breadth.avgFundingApr != null && <Chip>funding {report.breadth.avgFundingApr.toFixed(1)}% APR</Chip>}
                  </div>
                )}
              </div>
              <div className="rounded border border-zinc-800/70 bg-zinc-950/40 p-2">
                <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Levels that matter</p>
                {report.watch.length === 0 ? (
                  <p className="mt-1 text-[9px] text-zinc-500">no levels in range</p>
                ) : (
                  <div className="mt-1 space-y-0.5">
                    {report.watch.slice(0, 6).map((w, i) => (
                      <div key={i} className="flex items-baseline justify-between gap-2 text-[9px]">
                        <span className="truncate text-zinc-400">{w.label}</span>
                        <span className="font-mono text-zinc-200">
                          {w.price != null ? (w.price < 10 ? w.price.toFixed(3) : w.price.toFixed(0)) : '—'}
                          {w.distancePct != null && (
                            <span className={`ml-1 ${w.distancePct > 0 ? 'text-teal-500' : 'text-rose-500'}`}>
                              {w.distancePct > 0 ? '+' : ''}{w.distancePct.toFixed(2)}%
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {report.notes.length > 0 && (
                  <p className="mt-1.5 border-t border-zinc-800/60 pt-1 text-[8px] leading-relaxed text-zinc-600" title={report.notes.join(' · ')}>
                    {report.notes.join(' · ')}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </PanelState>
    </div>
  );
}

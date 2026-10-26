'use client';

// Smart Order Routing & Creation — per-platform routing quality for the
// selected strategy: EFFICIENCY (all-in cost), PERFORMANCE (latency & fill),
// PRICE & PROFIT (maker capture, edge retention) and SAFETY & SECURITY
// (custody, clearing, kill-switch), each with concrete numbers, plus the
// concrete order-creation recipe for every routable venue.

import React from 'react';
import {
  Route, Zap, BadgeDollarSign, ShieldCheck, Timer, ChevronDown, CheckCircle2,
  RefreshCw, XCircle, Coins, TrendingDown, Gauge, Lock,
} from 'lucide-react';
import type { StrategySpec } from '@/lib/strategies';
import type { UnderlyingId } from '@/lib/types';
import { fmtUsd } from '@/lib/format';
import { SUPPORT_META } from '@/lib/platforms';
import {
  DEFAULT_WEIGHTS, routeRecommendation, routingForStrategy,
  type RoutingFit, type RoutingWeights,
} from '@/lib/order-routing';

interface RoutingProps {
  spec: StrategySpec;
  underlying: UnderlyingId;
  premiumUsd: number;
}

function ScoreBar({ label, score, icon }: { label: string; score: number; icon: React.ReactNode }) {
  const color = score >= 75 ? 'bg-emerald-400' : score >= 55 ? 'bg-teal-400' : score >= 40 ? 'bg-amber-400' : 'bg-rose-400';
  return (
    <div className="min-w-[86px]">
      <div className="flex items-center justify-between gap-1">
        <span className="flex items-center gap-1 text-[7.5px] font-medium uppercase tracking-wide text-zinc-500">
          {icon} {label}
        </span>
        <span className="font-mono text-[8.5px] tabular-nums text-zinc-300">{score.toFixed(0)}</span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(score, 2)}%` }} />
      </div>
    </div>
  );
}

function CreationPlan({ fit }: { fit: RoutingFit }) {
  const phaseColor: Record<string, string> = {
    'Pre-trade': 'text-violet-300 border-violet-500/40 bg-violet-950/30',
    Ticket: 'text-sky-300 border-sky-500/40 bg-sky-950/30',
    Pricing: 'text-amber-300 border-amber-500/40 bg-amber-950/30',
    Execution: 'text-teal-300 border-teal-500/40 bg-teal-950/30',
    'Post-trade': 'text-emerald-300 border-emerald-500/40 bg-emerald-950/30',
  };
  return (
    <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
      {fit.creation.map((s, i) => (
        <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
          <div className="flex items-center gap-1.5">
            <span className={`rounded border px-1.5 py-0.5 text-[7px] font-semibold uppercase tracking-wide ${phaseColor[s.phase]}`}>
              {s.phase}
            </span>
            <p className="text-[9.5px] font-semibold text-zinc-200">{s.title}</p>
          </div>
          <p className="mt-1 text-[8.5px] leading-relaxed text-zinc-500">{s.detail}</p>
        </div>
      ))}
    </div>
  );
}

function RoutingRow({ fit }: { fit: RoutingFit }) {
  const [open, setOpen] = React.useState(false);
  const p = fit.platform;
  const sm = SUPPORT_META[fit.support];

  if (!fit.routable) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/20 px-2.5 py-2 opacity-70">
        <XCircle className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        <p className="text-[10px] font-medium text-zinc-400">{p.name}</p>
        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[7.5px] font-semibold uppercase tracking-wide text-zinc-500">
          not routable
        </span>
        <p className="ml-auto truncate text-[8px] text-zinc-600">{sm.label} — no viable instrument set</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-2 text-left transition hover:bg-zinc-900/60"
      >
        <span className={`w-4 shrink-0 text-center font-mono text-[9px] ${fit.rank === 1 ? 'text-amber-300' : 'text-zinc-500'}`}>
          {fit.rank === 1 ? '★' : fit.rank}
        </span>
        <div className="min-w-[130px] flex-1">
          <p className="text-[10.5px] font-semibold text-zinc-100">{p.name}</p>
          <p className="text-[7.5px] uppercase tracking-wide text-zinc-600">{fit.execModel}</p>
        </div>
        <ScoreBar label="effic." score={fit.efficiency.score} icon={<Coins className="h-2 w-2" />} />
        <ScoreBar label="perf." score={fit.performance.score} icon={<Zap className="h-2 w-2" />} />
        <ScoreBar label="price" score={fit.priceProfit.score} icon={<BadgeDollarSign className="h-2 w-2" />} />
        <ScoreBar label="safety" score={fit.safety.score} icon={<ShieldCheck className="h-2 w-2" />} />
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className="font-mono text-[11px] font-semibold tabular-nums text-teal-300">{fit.composite.toFixed(0)}</p>
            <p className="text-[6.5px] uppercase tracking-wide text-zinc-600">composite</p>
          </div>
          <ChevronDown className={`h-3.5 w-3.5 text-zinc-600 transition ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="space-y-2 border-t border-zinc-800/70 bg-zinc-950/40 px-2.5 py-2.5">
          {/* quick numbers strip */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[9px] tabular-nums text-zinc-400">
            <span><Timer className="mr-1 inline h-2.5 w-2.5 text-zinc-600" />{fit.ackMs < 1000 ? `${fit.ackMs}ms` : `${(fit.ackMs / 1000).toFixed(0)}s`} ack · fill ≈ {fit.estTimeToFillSec < 1 ? '<1s' : `${fit.estTimeToFillSec.toFixed(0)}s`}</span>
            <span>fill prob {Math.round(fit.fillProb * 100)}%</span>
            <span className="text-amber-300/90">all-in {fmtUsd(fit.cost.totalUsd)} ({fit.cost.pctOfPremium.toFixed(1)}% prem)</span>
            <span className="text-emerald-300/90">{fit.makerCapturePct}% passive · edge kept {fit.edgeRetentionPct}%</span>
          </div>

          {/* dimension details */}
          <div className="grid gap-1.5 md:grid-cols-2">
            {[
              { d: fit.efficiency, icon: <Coins className="h-3 w-3 text-amber-400" />, name: 'Efficiency — all-in cost' },
              { d: fit.performance, icon: <Zap className="h-3 w-3 text-teal-400" />, name: 'Performance — speed & fills' },
              { d: fit.priceProfit, icon: <BadgeDollarSign className="h-3 w-3 text-emerald-400" />, name: 'Price & profit optimization' },
              { d: fit.safety, icon: <ShieldCheck className="h-3 w-3 text-violet-400" />, name: 'Safety & security' },
            ].map(({ d, icon, name }) => (
              <div key={name} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
                <p className="flex items-center gap-1 text-[9px] font-semibold text-zinc-200">
                  {icon} {name} <span className="ml-auto font-mono text-[9px] text-zinc-400">{d.score.toFixed(0)}/100</span>
                </p>
                <p className="mt-1 text-[9px] font-medium text-zinc-300">{d.headline}</p>
                {d.detail.map((t, j) => (
                  <p key={j} className="mt-0.5 text-[8px] leading-relaxed text-zinc-500">› {t}</p>
                ))}
              </div>
            ))}
          </div>

          {/* order creation plan */}
          <div>
            <p className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-zinc-300">
              <Route className="h-3 w-3 text-teal-400" /> Order creation — how to build & send it
            </p>
            <CreationPlan fit={fit} />
          </div>
        </div>
      )}
    </div>
  );
}

export function StrategyRouting({ spec, underlying, premiumUsd }: RoutingProps) {
  const [weights] = React.useState<RoutingWeights>(DEFAULT_WEIGHTS);
  const fits = React.useMemo(
    () => routingForStrategy(spec, underlying, premiumUsd, weights),
    [spec, underlying, premiumUsd, weights],
  );
  const rec = React.useMemo(() => routeRecommendation(fits), [fits]);
  const routable = fits.filter((f) => f.routable).sort((a, b) => b.composite - a.composite);

  if (!rec.best) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-200">
          <Route className="h-4 w-4 text-teal-400" /> Order routing
        </h3>
        <p className="mt-1 text-[9px] text-zinc-500">No venue can route this structure — see the platform verdicts below.</p>
      </section>
    );
  }

  const bestChips: { label: string; value: string; icon: React.ReactNode }[] = [
    { label: 'cheapest', value: `${fmtUsd(rec.cheapest?.cost.totalUsd ?? 0)} all-in`, icon: <Coins className="h-3 w-3" /> },
    { label: 'fastest', value: rec.fastest ? (rec.fastest.estTimeToFillSec < 1 ? '<1s' : `${rec.fastest.estTimeToFillSec.toFixed(0)}s`) : '—', icon: <Timer className="h-3 w-3" /> },
    { label: 'most passive', value: `${rec.best.makerCapturePct}% maker`, icon: <TrendingDown className="h-3 w-3" /> },
    { label: 'safest', value: rec.safest?.platform.short ?? '—', icon: <Lock className="h-3 w-3" /> },
  ];

  return (
    <section className="space-y-2.5">
      {/* recommendation banner */}
      <div className="rounded-lg border border-teal-500/30 bg-gradient-to-r from-teal-950/40 via-zinc-900/60 to-zinc-900/40 p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Route className="h-5 w-5 shrink-0 text-teal-400" />
          <div className="min-w-[200px]">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-100">
              Smart order routing — best route: <span className="text-teal-300">{rec.best.platform.name}</span>
            </h3>
            <p className="mt-0.5 text-[9px] leading-relaxed text-zinc-400">
              composite <span className="font-mono text-teal-300">{rec.best.composite.toFixed(0)}/100</span> ·{' '}
              {rec.best.support === 'native' ? 'one native ticket' : 'synthetic replication'} ·{' '}
              {fmtUsd(rec.best.cost.totalUsd)} all-in ({rec.best.cost.pctOfPremium.toFixed(1)}% of premium) ·{' '}
              {rec.best.estTimeToFillSec < 1 ? 'sub-second' : `${rec.best.estTimeToFillSec.toFixed(0)}s`} fill ·{' '}
              keeps <span className="text-emerald-300">{rec.best.edgeRetentionPct}%</span> of edge
              {rec.runnerUp && <> · runner-up: <span className="text-zinc-300">{rec.runnerUp.platform.short}</span></>}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {bestChips.map((c) => (
              <div key={c.label} className="rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2 py-1 text-center">
                <p className="flex items-center justify-center gap-1 text-[8px] uppercase tracking-wide text-zinc-500">
                  {c.icon} {c.label}
                </p>
                <p className="mt-0.5 font-mono text-[9.5px] font-semibold tabular-nums text-zinc-200">{c.value}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-2 text-[8.5px] leading-relaxed text-zinc-500">
          Weights: efficiency {Math.round(weights.efficiency * 100)}% · performance {Math.round(weights.performance * 100)}% ·
          price &amp; profit {Math.round(weights.priceProfit * 100)}% · safety {Math.round(weights.safety * 100)}%.
          Costs are modeled round-trip on the live premium of <span className="font-mono text-zinc-300">{fmtUsd(Math.abs(premiumUsd))}</span> at size 1 —
          expand any venue for its full cost breakdown and order-creation recipe.
        </p>
      </div>

      {/* routing matrix */}
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
          <Gauge className="h-3.5 w-3.5 text-teal-400" /> Routing matrix — {routable.length} routable venues, ranked
        </p>
        <div className="space-y-1.5">
          {routable.map((f) => <RoutingRow key={f.platform.id} fit={f} />)}
          {fits.filter((f) => !f.routable).map((f) => <RoutingRow key={f.platform.id} fit={f} />)}
        </div>
      </div>

      {/* the best route's creation plan, always visible */}
      <div className="rounded-lg border border-teal-500/25 bg-zinc-900/40 p-2.5">
        <p className="mb-1.5 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-200">
          <CheckCircle2 className="h-3.5 w-3.5 text-teal-400" />
          Recommended order creation on {rec.best.platform.name}
          <RefreshCw className="ml-1 h-2.5 w-2.5 text-zinc-600" />
          <span className="font-mono text-[8px] font-normal normal-case tracking-normal text-zinc-500">
            {spec.legs.length} legs · {spec.legs.length <= rec.best.platform.maxLegsPerTicket ? 'single ticket' : `${Math.ceil(spec.legs.length / rec.best.platform.maxLegsPerTicket)} tickets`}
          </span>
        </p>
        <CreationPlan fit={rec.best} />
      </div>
    </section>
  );
}

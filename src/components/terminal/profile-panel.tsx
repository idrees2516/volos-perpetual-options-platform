'use client';

// Risk & return profile panel — the live metrics dashboard.
// Mirrors the research blueprint: outcome-first numbers a user actually
// decides on, with Greeks beneath for those who want them.

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  ArrowUpRight, ArrowDownRight, Scale, Target, Percent,
  Activity, Flame, ShieldCheck, Zap,
} from 'lucide-react';
import type { StrategyAnalysis } from '@/lib/types';
import { fmtUsd, fmtNum, pnlColor, gammaScaled } from '@/lib/format';

interface ProfilePanelProps {
  analysis: StrategyAnalysis | null;
  spot: number;
  engineBadge?: React.ReactNode;
}

export function ProfilePanel({ analysis, spot, engineBadge }: ProfilePanelProps) {
  if (!analysis || analysis.legs.length === 0) {
    return (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 p-6 text-center">
        <Scale className="h-6 w-6 text-zinc-700" />
        <p className="text-xs text-zinc-500">Risk &amp; return profile appears once you add legs.</p>
      </div>
    );
  }

  const mp = analysis.maxProfit;
  const ml = analysis.maxLoss;
  const pop = analysis.pop;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      {engineBadge}

      {/* Headline metrics */}
      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          label="Max Profit"
          value={mp.kind === 'unlimited' ? 'Unlimited' : fmtUsd(mp.value ?? 0)}
          sub={mp.kind === 'value' && mp.atPrice !== undefined ? `at ${fmtNum(mp.atPrice, 0)}` : 'convex structure'}
          tone="pos"
          icon={<ArrowUpRight className="h-3.5 w-3.5" />}
        />
        <MetricCard
          label="Max Loss"
          value={ml.kind === 'unlimited' ? 'Unlimited' : fmtUsd(ml.value ?? 0)}
          sub={ml.kind === 'value' && ml.atPrice !== undefined ? `at ${fmtNum(ml.atPrice, 0)}` : 'undefined risk — beware'}
          tone={ml.kind === 'unlimited' ? 'warn' : 'neg'}
          icon={<ArrowDownRight className="h-3.5 w-3.5" />}
        />
        <MetricCard
          label="Probability of Profit"
          value={`${(pop * 100).toFixed(1)}%`}
          sub={pop >= 0.6 ? 'favourable odds' : pop >= 0.4 ? 'balanced odds' : 'long-shot payoff'}
          tone={pop >= 0.5 ? 'pos' : 'neutral'}
          icon={<Target className="h-3.5 w-3.5" />}
          progress={pop}
        />
        <MetricCard
          label="Expected Value"
          value={fmtUsd(analysis.expectedValue, { sign: true })}
          sub="risk-neutral, at horizon"
          tone={analysis.expectedValue >= 0 ? 'pos' : 'neg'}
          icon={<Percent className="h-3.5 w-3.5" />}
        />
      </div>

      {/* Net premium / breakevens */}
      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            {analysis.isCredit ? 'Net Credit Received' : 'Net Debit Paid'}
          </span>
          <span className={`font-mono text-sm font-semibold ${analysis.isCredit ? 'text-emerald-400' : 'text-zinc-100'}`}>
            {fmtUsd(Math.abs(analysis.netPremium))}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Breakevens</span>
          <div className="flex flex-wrap justify-end gap-1">
            {analysis.breakevens.length === 0 ? (
              <span className="font-mono text-xs text-zinc-500">none in range</span>
            ) : (
              analysis.breakevens.map((b, i) => (
                <span key={i} className="rounded bg-lime-950/50 px-1.5 py-0.5 font-mono text-xs text-lime-400 ring-1 ring-lime-500/20">
                  {fmtNum(b, b >= 1000 ? 0 : 2)}
                </span>
              ))
            )}
          </div>
        </div>
        {analysis.riskReward !== undefined && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Risk / Reward</span>
            <span className="font-mono text-xs text-zinc-200">1 : {analysis.riskReward.toFixed(2)}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Horizon</span>
          <span className="font-mono text-xs text-zinc-200">{analysis.horizonDays.toFixed(0)} days</span>
        </div>
      </div>

      {/* Greeks */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="mb-2 flex items-center gap-1.5">
          <Activity className="h-3 w-3 text-teal-400" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Portfolio Greeks</span>
          <Badge variant="outline" className="ml-auto border-zinc-700 bg-zinc-950 px-1 py-0 text-[9px] font-normal text-zinc-500">
            live
          </Badge>
        </div>
        <div className="space-y-1.5">
          <GreekRow
            name="Delta" sym="Δ"
            value={analysis.greeks.delta.toFixed(3)}
            sub={`exp ${fmtUsd(analysis.greeks.deltaExposureUsd, { compact: true })}`}
          />
          <GreekRow
            name="Gamma" sym="Γ"
            value={analysis.greeks.gamma.toFixed(5)}
            sub={`≈ ${fmtUsd(gammaScaled(analysis.greeks.gamma, spot))} per 1% move`}
          />
          <GreekRow
            name="Vega" sym="ν"
            value={fmtUsd(analysis.greeks.vega)}
            sub="per 1 vol point"
          />
          <GreekRow
            name="Theta" sym="Θ"
            value={fmtUsd(analysis.greeks.theta, { sign: true })}
            sub="per day"
            tone={analysis.greeks.theta >= 0 ? 'pos' : 'neg'}
          />
          <GreekRow
            name="Rho" sym="ρ"
            value={fmtUsd(analysis.greeks.rho)}
            sub="per 1% rate"
          />
        </div>
      </div>

      {/* Capital & liquidity */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            <ShieldCheck className="h-3 w-3" /> Margin est.
          </div>
          <p className="mt-1 font-mono text-sm font-semibold text-zinc-100">{fmtUsd(analysis.marginEstimate)}</p>
          <p className="text-[9px] text-zinc-500">worst scenario + 10% buffer</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            <Zap className="h-3 w-3" /> Exit liquidity
          </div>
          <p className="mt-1 font-mono text-sm font-semibold text-zinc-100">{analysis.liquidity.toFixed(0)}<span className="text-xs text-zinc-500">/100</span></p>
          <Progress value={analysis.liquidity} className="mt-1.5 h-1 bg-zinc-800" />
        </div>
      </div>

      {/* Carry teaser (full detail in tab) */}
      {analysis.carry && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-950/10 p-3">
          <div className="flex items-center gap-1.5">
            <Flame className="h-3 w-3 text-amber-400" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-500/90">Carry Budget</span>
            <Badge variant="outline" className="ml-auto border-amber-500/30 bg-amber-950/30 px-1 py-0 text-[9px] font-normal text-amber-400/80">
              perpetual legs
            </Badge>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-xs">
            <div>
              <p className="text-[9px] uppercase text-zinc-500">24h</p>
              <p className={pnlColor(-analysis.carry.dailyCarry)}>{fmtUsd(analysis.carry.dailyCarry, { sign: true })}</p>
            </div>
            <div>
              <p className="text-[9px] uppercase text-zinc-500">7d</p>
              <p className={pnlColor(-analysis.carry.weeklyCarry)}>{fmtUsd(analysis.carry.weeklyCarry, { sign: true })}</p>
            </div>
            <div>
              <p className="text-[9px] uppercase text-zinc-500">30d</p>
              <p className={pnlColor(-analysis.carry.monthlyCarry)}>{fmtUsd(analysis.carry.monthlyCarry, { sign: true })}</p>
            </div>
          </div>
          <p className="mt-1.5 text-[9px] leading-tight text-zinc-500">
            Funding = mark − payoff per period. See the Carry tab for Carry-at-Risk scenarios.
          </p>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label, value, sub, tone, icon, progress,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: 'pos' | 'neg' | 'warn' | 'neutral';
  icon: React.ReactNode;
  progress?: number;
}) {
  const toneCls =
    tone === 'pos' ? 'text-emerald-400' :
    tone === 'neg' ? 'text-rose-400' :
    tone === 'warn' ? 'text-amber-400' : 'text-zinc-100';
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {icon}
        {label}
      </div>
      <p className={`mt-1 font-mono text-lg font-bold leading-tight ${toneCls}`}>{value}</p>
      {sub && <p className="text-[9px] leading-tight text-zinc-500">{sub}</p>}
      {progress !== undefined && <Progress value={progress * 100} className="mt-1.5 h-1 bg-zinc-800" />}
    </div>
  );
}

function GreekRow({ name, sym, value, sub, tone }: { name: string; sym: string; value: string; sub?: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-14 shrink-0 font-mono text-[11px] font-semibold text-zinc-300">{sym}&nbsp;<span className="text-[9px] font-normal text-zinc-500">{name}</span></span>
      <span className={`font-mono text-xs ${tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-zinc-200'}`}>{value}</span>
      {sub && <span className="ml-auto truncate font-mono text-[9px] text-zinc-600">{sub}</span>}
    </div>
  );
}

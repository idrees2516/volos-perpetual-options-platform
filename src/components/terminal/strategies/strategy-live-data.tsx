'use client';

// Strategy Live Data tab — pulls the data FOR the selected strategy:
// live market snapshot of the underlying, the strategy's own analytics
// (premium, risk, greeks, carry), per-leg quotes, and the authoritative
// numbers from the Rust engine on demand.

import React, { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Cpu, Loader2, Activity, Flame, Waves, Landmark, BarChart3 } from 'lucide-react';
import type { AssetMarket, Leg, LegAnalytics, StrategyAnalysis, UnderlyingId } from '@/lib/types';
import { fmtUsd, fmtNum, fmtPctSigned } from '@/lib/format';
import { atmVol, VOL_CONFIG } from '@/lib/pricing';
import { engine, RustAnalysis } from '@/lib/api';
import { kindLabel } from '@/lib/types';

interface LiveDataProps {
  analysis: StrategyAnalysis;
  legs: Leg[];
  underlying: UnderlyingId;
  market: AssetMarket;
  legCount: number;
}

function Stat({
  label,
  value,
  sub,
  tone = 'text-zinc-200',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <p className="text-[8px] uppercase tracking-wider text-zinc-600">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${tone}`}>{value}</p>
      {sub && <p className="text-[8px] text-zinc-600">{sub}</p>}
    </div>
  );
}

function ExtremeText({ kind, value }: { kind: string; value?: number }): string {
  if (kind === 'unlimited') return 'unlimited';
  if (value === undefined) return '—';
  return fmtUsd(value, { compact: true });
}

export function StrategyLiveData({ analysis, legs, underlying, market, legCount }: LiveDataProps) {
  const cfg = VOL_CONFIG[underlying] ?? VOL_CONFIG.BTC;
  const atmIv = atmVol(cfg, 30 / 365, market.volShift);

  const [engineState, setEngineState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [engineResult, setEngineResult] = useState<RustAnalysis | null>(null);

  const runEngine = async () => {
    setEngineState('loading');
    try {
      const r = await engine.analyze({ underlying, legs, size: 1 });
      setEngineResult(r);
      setEngineState('ok');
    } catch {
      setEngineState('error');
    }
  };

  const mp = analysis.maxProfit;
  const ml = analysis.maxLoss;
  const g = analysis.greeks;

  return (
    <div className="space-y-3">
      {/* Live market snapshot */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-300">
            <Activity className="h-3.5 w-3.5" />
            Live market data · {underlying}
          </h3>
          <Badge variant="outline" className="border-teal-500/30 bg-teal-950/30 text-[8px] font-normal text-teal-300">
            streaming
          </Badge>
        </div>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          <Stat label="Spot" value={fmtNum(market.spot, market.spot >= 1000 ? 0 : 2)} />
          <Stat
            label="24h change"
            value={fmtPctSigned(market.change24h ?? 0, 2)}
            tone={(market.change24h ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          />
          <Stat label="ATM IV 30d" value={fmtNum(atmIv * 100, 1) + '%'} sub={`vol shift ${fmtNum((market.volShift ?? 0) * 100, 1)}%`} />
          <Stat label="Funding" value={fmtNum((market.fundingRate ?? 0) * 100, 3) + '%'} />
          <Stat label="Open interest" value={fmtUsd(market.openInterest, { compact: true })} />
          <Stat label="24h volume" value={fmtUsd(market.volume24h, { compact: true })} />
        </div>
      </section>

      {/* Strategy metrics — pulled from the pricing engine */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-300">
            <BarChart3 className="h-3.5 w-3.5" />
            Strategy analytics · {legCount} legs resolved on live spot
          </h3>
          <Badge
            variant="outline"
            className={`text-[8px] font-normal ${
              analysis.isCredit
                ? 'border-emerald-500/30 bg-emerald-950/30 text-emerald-300'
                : 'border-rose-500/30 bg-rose-950/30 text-rose-300'
            }`}
          >
            {analysis.isCredit ? 'net credit' : 'net debit'} · {fmtUsd(Math.abs(analysis.netPremium))}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-6">
          <Stat
            label="Max profit"
            value={ExtremeText({ kind: mp.kind, value: mp.value })}
            tone="text-emerald-400"
            sub={mp.atPrice !== undefined ? `@ ${fmtNum(mp.atPrice, 0)}` : undefined}
          />
          <Stat
            label="Max loss"
            value={ExtremeText({ kind: ml.kind, value: ml.value })}
            tone="text-rose-400"
            sub={ml.atPrice !== undefined ? `@ ${fmtNum(ml.atPrice, 0)}` : undefined}
          />
          <Stat label="Prob. of profit" value={fmtNum(analysis.pop * 100, 1) + '%'} tone="text-teal-300" />
          <Stat
            label="Expected value"
            value={fmtUsd(analysis.expectedValue, { compact: true })}
            tone={analysis.expectedValue >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          />
          <Stat
            label="Risk / reward"
            value={analysis.riskReward !== undefined ? `1 : ${fmtNum(analysis.riskReward, 2)}` : '—'}
          />
          <Stat label="Margin est." value={fmtUsd(analysis.marginEstimate, { compact: true })} />
        </div>
        {analysis.breakevens.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-zinc-800/70 bg-zinc-950/50 px-2.5 py-1.5">
            <span className="text-[8px] uppercase tracking-wider text-zinc-600">Breakevens</span>
            {analysis.breakevens.map((b, i) => (
              <span key={i} className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-200">
                {fmtNum(b, b >= 1000 ? 0 : 2)}
              </span>
            ))}
            <span className="ml-auto text-[8px] text-zinc-600">spot {fmtNum(market.spot, market.spot >= 1000 ? 0 : 2)}</span>
          </div>
        )}
      </section>

      {/* Greeks + carry */}
      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">
            <Waves className="h-3.5 w-3.5" />
            Net Greeks (size 1)
          </h3>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
            <Stat label="Delta" value={fmtNum(g.delta, 3)} />
            <Stat label="Gamma" value={fmtNum(g.gamma, 4)} />
            <Stat label="Vega" value={fmtUsd(g.vega)} />
            <Stat label="Theta / day" value={fmtUsd(g.theta)} tone={g.theta >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
            <Stat label="Rho" value={fmtUsd(g.rho)} />
            <Stat label="Δ exposure" value={fmtUsd(g.deltaExposureUsd, { compact: true })} />
          </div>
        </div>

        {analysis.carry ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300">
              <Flame className="h-3.5 w-3.5" />
              Carry budget
            </h3>
            <div className="grid grid-cols-3 gap-1.5">
              <Stat
                label="Daily"
                value={fmtUsd(analysis.carry.dailyCarry)}
                tone={analysis.carry.dailyCarry >= 0 ? 'text-emerald-400' : 'text-rose-400'}
              />
              <Stat
                label="Weekly"
                value={fmtUsd(analysis.carry.weeklyCarry)}
                tone={analysis.carry.weeklyCarry >= 0 ? 'text-emerald-400' : 'text-rose-400'}
              />
              <Stat
                label="Monthly"
                value={fmtUsd(analysis.carry.monthlyCarry)}
                tone={analysis.carry.monthlyCarry >= 0 ? 'text-emerald-400' : 'text-rose-400'}
              />
            </div>
            <div className="mt-2 space-y-1">
              {analysis.carry.scenarios.map((s, i) => (
                <div key={i} className="flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/50 px-2 py-1 text-[10px]">
                  <span className="text-zinc-500">{s.label}</span>
                  <span className={`font-mono tabular-nums ${s.carry7d >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {fmtUsd(s.carry7d)} / 7d
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300">
              <Flame className="h-3.5 w-3.5" />
              Liquidity
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              <Stat label="Structure liquidity" value={fmtNum(analysis.liquidity * 100, 0) + '%'} />
              <Stat
                label="Direction"
                value={g.delta > 0.1 ? 'long' : g.delta < -0.1 ? 'short' : 'neutral'}
                tone={g.delta > 0.1 ? 'text-emerald-400' : g.delta < -0.1 ? 'text-rose-400' : 'text-zinc-300'}
              />
            </div>
          </div>
        )}
      </section>

      {/* Per-leg quotes */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
          <Landmark className="h-3.5 w-3.5" />
          Per-leg quotes (client mirror · 60fps)
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr className="border-b border-zinc-800 text-[8px] uppercase tracking-wider text-zinc-600">
                <th className="py-1.5 pr-2 font-medium">Leg</th>
                <th className="pr-2 font-medium">Side</th>
                <th className="pr-2 font-medium">Qty</th>
                <th className="pr-2 font-medium">Strike</th>
                <th className="pr-2 font-medium">Tenor</th>
                <th className="pr-2 font-medium">IV</th>
                <th className="pr-2 font-medium">Price</th>
                <th className="pr-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[10px] tabular-nums">
              {analysis.legs.map((l: LegAnalytics, i) => (
                <tr key={l.id} className="border-b border-zinc-800/40 text-zinc-300">
                  <td className="py-1.5 pr-2">
                    <span className="text-zinc-500">{i + 1}</span> {kindLabel(l.kind)}
                  </td>
                  <td className="pr-2">
                    <span className={l.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{l.side}</span>
                  </td>
                  <td className="pr-2">×{l.qty}</td>
                  <td className="pr-2">{l.strike !== undefined ? fmtNum(l.strike, l.strike >= 1000 ? 0 : 2) : '—'}</td>
                  <td className="pr-2 text-zinc-500">
                    {l.expiryDays !== undefined
                      ? `${l.expiryDays}d`
                      : l.fundingPeriodDays !== undefined
                        ? `τ${l.fundingPeriodDays}d`
                        : '—'}
                  </td>
                  <td className="pr-2">{l.iv !== undefined ? fmtNum(l.iv * 100, 1) + '%' : '—'}</td>
                  <td className="pr-2">{fmtUsd(l.price)}</td>
                  <td className={`pr-2 text-right ${l.cost >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {l.cost >= 0 ? '−' : '+'}
                    {fmtUsd(Math.abs(l.cost))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Rust engine verification — the authoritative data pull */}
      <section className="rounded-lg border border-zinc-800 bg-gradient-to-br from-zinc-900/80 to-zinc-950 p-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-teal-400" />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
            Rust engine verification
          </h3>
          <Button
            size="sm"
            variant="outline"
            onClick={runEngine}
            disabled={engineState === 'loading'}
            className="ml-auto h-6 border-teal-500/40 bg-teal-950/30 px-2 text-[10px] font-medium text-teal-300 hover:bg-teal-900/40"
          >
            {engineState === 'loading' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Pull authoritative data'}
          </Button>
        </div>
        {engineState === 'idle' && (
          <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
            The numbers above stream from the client-side mirror (identical math, 60fps). Pull the Rust engine for
            authoritative SVI-surface analytics with latency proof — deterministic Black-Scholes + Paradigm
            everlasting basket.
          </p>
        )}
        {engineState === 'error' && (
          <p className="mt-2 text-[10px] leading-relaxed text-amber-500/80">
            Engine unreachable — the client mirror numbers above remain live. Start the Rust service
            (<span className="font-mono">cargo run -p volos-backend</span>) for authoritative analytics.
          </p>
        )}
        {engineState === 'ok' && engineResult && (
          <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <Stat
              label="Max loss (engine)"
              value={engineResult.maxLoss.kind === 'unlimited' ? 'unlimited' : fmtUsd(engineResult.maxLoss.value ?? 0, { compact: true })}
              tone="text-rose-300"
            />
            <Stat label="POP (engine)" value={fmtNum(engineResult.pop * 100, 1) + '%'} tone="text-teal-300" />
            <Stat label="Delta (engine)" value={fmtNum(engineResult.greeks.delta, 3)} />
            <Stat label="Compute" value={`${engineResult.diagnostics.computeUs} µs`} sub={`v${engineResult.diagnostics.serverVersion}`} />
          </div>
        )}
      </section>
    </div>
  );
}

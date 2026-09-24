'use client';

// Builder view — the complete strategy construction workspace.

import React, { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Zap, Cpu, Gauge } from 'lucide-react';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { analyzeStrategy } from '@/lib/pricing';
import { engine, RustAnalysis, EngineUnavailableError } from '@/lib/api';
import { PayoffChart } from './payoff-chart';
import { ChartControls } from './chart-controls';
import { LegsPanel } from './legs-panel';
import { ProfilePanel } from './profile-panel';
import { AnalyticsTabs } from './analytics-tabs';
import { fmtUsd } from '@/lib/format';

export function BuilderView() {
  const { smooth, market } = useMarket();
  const { underlying, legs, size, overrides, showCone, showDecay, showNow, updateLeg } = useStrategy();

  const asset = smooth[underlying] ?? market.assets[underlying];

  // Client-side mirror for 60fps interactivity.
  const analysis = useMemo(
    () => (legs.length ? analyzeStrategy(legs, underlying, asset, size, { overrides }) : null),
    [legs, underlying, asset, size, overrides],
  );

  const onStrikeDrag = (legId: string, strike: number) => updateLeg(legId, { strike });

  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-[290px_minmax(0,1fr)_310px]">
      {/* Left: legs */}
      <section className="order-2 min-h-80 min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 lg:order-1 lg:max-h-[calc(100vh-140px)]">
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <Zap className="h-3.5 w-3.5 text-teal-400" /> Structure
        </h2>
        <div className="h-[calc(100%-28px)]">
          <LegsPanel spot={asset.spot} analysis={analysis} />
        </div>
      </section>

      {/* Center: chart + analytics */}
      <section className="order-1 flex min-w-0 flex-col gap-3 lg:order-2">
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
          <div className="px-4 pt-3">
            <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              <Gauge className="h-3.5 w-3.5 text-teal-400" /> Payoff &amp; Risk Profile
              <span className="ml-2 font-mono text-[9px] font-normal normal-case tracking-normal text-zinc-600">
                drag strike handles · hover for P&amp;L
              </span>
            </h2>
          </div>
          {legs.length === 0 ? (
            <div className="flex h-[420px] flex-col items-center justify-center gap-3">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-teal-500/30 bg-teal-950/20">
                <Gauge className="h-7 w-7 text-teal-500/70" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-zinc-300">Build any structure — static or perpetual</p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
                  Start from a template or mix your own legs: dated calls &amp; puts, everlasting options, perps and spot.
                  The payoff, Greeks and risk metrics update live as the market moves.
                </p>
              </div>
            </div>
          ) : (
            <PayoffChart
              analysis={analysis!}
              legs={legs}
              spot={asset.spot}
              overrides={overrides}
              showCone={showCone}
              showDecay={showDecay}
              showNow={showNow}
              horizonDays={analysis?.horizonDays ?? 30}
              onStrikeDrag={onStrikeDrag}
            />
          )}
          <ChartControls horizonDays={analysis?.horizonDays ?? 30} hasLegs={legs.length > 0} />
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
          <AnalyticsTabs
            analysis={analysis}
            legs={legs}
            underlying={underlying}
            market={asset}
            size={size}
          />
        </div>
      </section>

      {/* Right: profile */}
      <section className="order-3 min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 lg:max-h-[calc(100vh-140px)]">
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <Cpu className="h-3.5 w-3.5 text-teal-400" /> Risk &amp; Return
        </h2>
        <div className="h-[calc(100%-28px)] overflow-y-auto">
          <ProfilePanel analysis={analysis} spot={asset.spot} engineBadge={<EngineBadge underlying={underlying} legs={legs} size={size} localAnalysis={analysis} />} />
        </div>
      </section>
    </div>
  );
}

/** Cross-check button: runs the same strategy through the Rust engine
 *  and displays authoritative numbers + latency. */
function EngineBadge({
  underlying, legs, size, localAnalysis,
}: {
  underlying: string;
  legs: { id: string; kind: string; side: string; qty: number; strike?: number; expiryDays?: number; fundingPeriodDays?: number }[];
  size: number;
  localAnalysis: ReturnType<typeof analyzeStrategy> | null;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [result, setResult] = useState<RustAnalysis | null>(null);

  const run = async () => {
    if (!legs.length) return;
    setState('loading');
    try {
      const r = await engine.analyze({ underlying: underlying as 'BTC', legs: legs as never, size });
      setResult(r);
      setState('ok');
    } catch (e) {
      if (e instanceof EngineUnavailableError || /fetch|network/i.test(String(e))) setState('error');
      else setState('error');
    }
  };

  if (!legs.length) return null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-gradient-to-br from-zinc-900/80 to-zinc-950 p-3">
      <div className="flex items-center gap-2">
        <Cpu className="h-3.5 w-3.5 text-teal-400" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">Rust Engine Verification</span>
        <Button
          size="sm"
          variant="outline"
          onClick={run}
          disabled={state === 'loading'}
          className="ml-auto h-6 border-teal-500/40 bg-teal-950/30 px-2 text-[10px] font-medium text-teal-300 hover:bg-teal-900/40"
        >
          {state === 'loading' ? 'computing…' : 'Verify'}
        </Button>
      </div>
      {state === 'error' && (
        <p className="mt-2 text-[10px] leading-relaxed text-amber-500/80">
          Engine unreachable — running on the client mirror. Start the Rust service for authoritative analytics.
        </p>
      )}
      {state === 'ok' && result && localAnalysis && (
        <div className="mt-2 space-y-1 font-mono text-[10px]">
          <div className="flex justify-between text-zinc-400">
            <span>max loss (engine)</span>
            <span className="text-rose-300">{result.maxLoss.kind === 'unlimited' ? 'unlimited' : fmtUsd(result.maxLoss.value ?? 0)}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>POP (engine)</span>
            <span className="text-teal-300">{(result.pop * 100).toFixed(1)}%</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>delta (engine)</span>
            <span className="text-zinc-200">{result.greeks.delta.toFixed(3)}</span>
          </div>
          <div className="flex items-center justify-between text-zinc-500">
            <span>compute time</span>
            <Badge variant="outline" className="border-teal-500/30 bg-teal-950/40 px-1 py-0 text-[9px] text-teal-300">
              {result.diagnostics.computeUs} µs
            </Badge>
          </div>
          <p className="pt-1 text-[9px] leading-tight text-zinc-600">
            volos-rust v{result.diagnostics.serverVersion} — deterministic Black-Scholes + SVI surface, Paradigm everlasting basket.
          </p>
        </div>
      )}
    </div>
  );
}

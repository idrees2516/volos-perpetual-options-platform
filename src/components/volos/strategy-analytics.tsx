'use client';

// ─────────────────────────────────────────────────────────────────────────────
// v1.9 strategy analytics tabs — Live Data · Metrics · Platforms (SOR) ·
// Backtest. All fed by the shared pricing kernel + live market hook.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import {
  Activity, SlidersHorizontal, LayoutGrid, Clock, TrendingUp, Gauge, Zap, Star,
} from 'lucide-react';
import type { MarketState } from '@/hooks/use-market';
import { spotOf } from '@/hooks/use-market';
import type { StrategySpec } from '@/lib/strategies';
import {
  analyzeStrategy, distributionalRisk, expectedMoveBand, legSecondOrder, legQuote,
  smilePoints, strikeForDelta, surfaceIv, strategyHorizon, termStructure,
  type StrategyAnalysis,
} from '@/lib/pricing';
import { BASE_IV, type UnderlyingId } from '@/lib/types';
import { seeded } from '@/lib/market-sim';
import {
  ROUTABLE_VENUES, ROUTING_FILTERS, DEFAULT_WEIGHTS, VENUES, compositeScore, weightedScore,
  type RoutingFilterId,
} from '@/lib/venues';
import { feasibleVenueCount } from '@/lib/venues';
import { useStrategy } from '@/stores/strategy-store';
import { fmtUsd, fmtNum, fmtPctSigned } from '@/lib/format';
import { SectionCard, Stat, ScoreBar, Chip } from './bits';

// ── LIVE DATA ────────────────────────────────────────────────────────────────

export function LiveDataTab({ market, analysis, spec }: { market: MarketState; analysis: StrategyAnalysis; spec: StrategySpec }) {
  const { underlying, size, legs, anchorSpot } = useStrategy();
  const spot = spotOf(market, underlying);
  const price = market.prices[underlying];
  const baseIv = BASE_IV[underlying];
  const horizon = Math.max(1, Math.round(strategyHorizon(legs) * 365));
  const risk = useMemo(
    () => distributionalRisk(analysis.payoffAt, spot, baseIv, horizon),
    [analysis, spot, baseIv, horizon],
  );
  const ts = useMemo(() => termStructure(baseIv), [baseIv]);
  const iv7 = ts.find((t) => t.dte === 7)?.iv ?? baseIv;
  const iv90 = ts.find((t) => t.dte === 90)?.iv ?? baseIv;
  const seedKey = `${underlying}-${Math.round(spot / 500)}`;
  const funding = 0.062 + seeded(seedKey + 'f') * 0.07;
  const oi = (3.4 + seeded(seedKey + 'oi') * 1.6) * 1000;
  const vol24 = (1.2 + seeded(seedKey + 'v') * 1.2) * 1000;
  const realized1d = baseIv * (0.42 + seeded(seedKey + 'r') * 0.2);
  const rr25 = -0.028 - seeded(seedKey + 'rr') * 0.014;
  const turnover = 0.38 + seeded(seedKey + 't') * 0.16;
  const em = expectedMoveBand(spot, baseIv, 1);

  const marginEst = Math.abs(analysis.maxLoss) * 0.98 + Math.abs(analysis.netPremium) * 0.1;
  const rr = analysis.maxLoss < 0 && analysis.maxProfit > 0 ? analysis.maxProfit / Math.abs(analysis.maxLoss) : null;
  const lambda = Math.abs(analysis.netDelta) * spot;
  const liquidity = 2.5 + seeded(spec.id + 'liq') * 9.5;

  const marketStats: { label: string; value: string; tone?: 'pos' | 'neg' | 'amber' }[] = [
    { label: 'SPOT', value: Math.round(spot).toLocaleString() },
    { label: '24H CHANGE', value: fmtPctSigned(price?.change24h ?? 0, 2), tone: (price?.change24h ?? 0) >= 0 ? 'pos' : 'neg' },
    { label: 'ATM IV 30D', value: `${(baseIv * 100).toFixed(1)}%` },
    { label: 'FUNDING', value: `${(funding * 100).toFixed(3)}%`, tone: funding > 0.1 ? 'amber' : undefined },
    { label: 'OPEN INTEREST', value: `$${(oi / 1000).toFixed(2)}B` },
    { label: '24H VOLUME', value: `$${(vol24 / 1000).toFixed(2)}B` },
    { label: 'EXPECTED MOVE', value: `±${(em.pct * 100).toFixed(1)}%`, tone: 'amber' },
    { label: 'IV 7D', value: `${(iv7 * 100).toFixed(1)}%` },
    { label: 'IV 90D', value: `${(iv90 * 100).toFixed(1)}%` },
    { label: 'RR 25Δ', value: `${(rr25 * 100).toFixed(1)}%`, tone: 'neg' },
    { label: 'IV PREMIUM', value: `${((baseIv - realized1d) * 100).toFixed(1)} pts`, tone: 'amber' },
    { label: 'TURNOVER', value: `${turnover.toFixed(4)}×` },
  ];

  return (
    <div className="space-y-3">
      <SectionCard
        title={`Live market data · ${underlying}`}
        icon={<Activity className="h-3.5 w-3.5" />}
        right={<span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" /> STREAMING</span>}
      >
        <div className="grid grid-cols-6 gap-2">
          {marketStats.map((m) => (
            <Stat key={m.label} label={m.label} value={m.value} tone={m.tone} />
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title={`Strategy analytics · ${legs.length} legs resolved on live spot`}
        icon={<Gauge className="h-3.5 w-3.5" />}
        right={
          <span className={analysis.netPremium >= 0 ? 'text-teal-300' : 'text-zinc-300'}>
            {analysis.netPremium >= 0 ? 'Net credit' : 'Net debit'}: {fmtUsd(Math.abs(analysis.netPremium))}
          </span>
        }
      >
        <div className="grid grid-cols-6 gap-2">
          <Stat label="Max profit" value={analysis.maxProfit > 1e9 ? 'Unlimited' : fmtUsd(analysis.maxProfit)} tone="pos" />
          <Stat label="Max loss" value={fmtUsd(analysis.maxLoss)} tone="neg" />
          <Stat label="Prob. of profit" value={`${fmtNum(risk.pop * 100, 1)}%`} tone="pos" />
          <Stat label="Expected value" value={fmtUsd(risk.ev, 2)} tone={risk.ev >= 0 ? 'pos' : 'neg'} />
          <Stat label="Risk / reward" value={rr ? fmtNum(rr, 2) : '—'} />
          <Stat label="Margin est" value={fmtUsd(marginEst)} />
        </div>
        {analysis.breakevens.length > 0 && (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-zinc-500">
            <span className="font-semibold uppercase tracking-wider">Breakevens:</span>
            {analysis.breakevens.slice(0, 4).map((b, i) => (
              <span key={i} className="font-mono text-amber-400">{Math.round(b).toLocaleString()}</span>
            ))}
          </div>
        )}
      </SectionCard>

      <div className="grid grid-cols-[2fr_1fr] gap-3">
        <SectionCard title={`Net greeks (size ${size})`} icon={<Zap className="h-3.5 w-3.5" />}>
          <div className="grid grid-cols-6 gap-2">
            <Stat label="Delta" value={fmtNum(analysis.netDelta, 4)} />
            <Stat label="Gamma" value={fmtNum(analysis.netGamma, 4)} />
            <Stat label="Vega" value={fmtUsd(analysis.netVega)} tone={analysis.netVega >= 0 ? 'pos' : 'neg'} />
            <Stat label="Theta / day" value={fmtUsd(analysis.netTheta)} tone={analysis.netTheta >= 0 ? 'pos' : 'neg'} />
            <Stat label="Rho" value={fmtUsd(rhoNet(analysis, spot))} />
            <Stat label="λ / exposure" value={fmtUsd(lambda)} tone="teal" />
          </div>
        </SectionCard>
        <SectionCard title="Liquidity" icon={<Gauge className="h-3.5 w-3.5" />}>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Structure liquidity" value={`${liquidity.toFixed(3)}%`} tone="amber" />
            <Stat label="Direction" value={analysis.netDelta > 0.05 ? 'long' : analysis.netDelta < -0.05 ? 'short' : 'neutral'} />
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Per-leg quotes"
        icon={<Activity className="h-3.5 w-3.5" />}
        right={<span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" /> CLIENT MIRROR · 60FPS</span>}
      >
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[9px] uppercase tracking-wider text-zinc-500">
              <th className="py-1.5 pr-3">Leg</th>
              <th className="pr-3">Side</th>
              <th className="pr-3">Qty</th>
              <th className="pr-3">Strike</th>
              <th className="pr-3">Tenor</th>
              <th className="pr-3">IV</th>
              <th className="pr-3 text-right">Price</th>
              <th className="text-right">Cost</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {analysis.resolved.map((l, i) => (
              <tr key={l.id} className="border-b border-zinc-900">
                <td className="py-1.5 pr-3 capitalize text-zinc-300">{i + 1} {l.kind === 'perp_option' ? 'everlasting' : l.kind}</td>
                <td className={`pr-3 font-semibold ${l.side === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>{l.side === 'long' ? 'buy' : 'sell'}</td>
                <td className="pr-3 text-zinc-300">×{l.ratio}</td>
                <td className="pr-3 text-zinc-300">{l.strike === null ? '—' : Math.round(l.strike).toLocaleString()}</td>
                <td className="pr-3 text-zinc-400">{l.kind === 'perp_option' ? '∞' : l.kind === 'perp' || l.kind === 'spot' ? 'perp' : `${l.dte}d`}</td>
                <td className="pr-3 text-amber-400/90">{l.iv > 0 ? `${(l.iv * 100).toFixed(1)}%` : '—'}</td>
                <td className="pr-3 text-right text-zinc-100">{l.premium > 0 ? fmtUsd(l.premium) : fmtUsd(spot)}</td>
                <td className={`text-right font-semibold ${l.side === 'long' ? 'text-rose-400' : 'text-teal-400'}`}>
                  {l.side === 'long' ? '−' : '+'}{fmtUsd(l.premium * l.ratio)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}

function rhoNet(analysis: StrategyAnalysis, spot: number): number {
  let rho = 0;
  for (const l of analysis.resolved) {
    const so = legSecondOrder(l, spot);
    rho += so.rho;
  }
  return rho;
}

// ── METRICS ──────────────────────────────────────────────────────────────────

export function MetricsTab({ market, analysis, spec }: { market: MarketState; analysis: StrategyAnalysis; spec: StrategySpec }) {
  const { underlying, size, legs, anchorSpot } = useStrategy();
  const spot = spotOf(market, underlying);
  const baseIv = BASE_IV[underlying];
  const horizon = Math.max(1, Math.round(strategyHorizon(legs) * 365));

  const ts = useMemo(() => {
    const tenors = [1, 2, 7, 14, 30, 60, 90, 180, 300, 365];
    return tenors.map((d) => ({ d, iv: surfaceIv('call', 0, d, baseIv) }));
  }, [baseIv]);

  const wings = useMemo(() => {
    const k25c = strikeForDelta(0.25, 'call', spot, baseIv, 14);
    const k25p = strikeForDelta(-0.25, 'put', spot, baseIv, 14);
    const offC = ((k25c - spot) / spot) * 100;
    const offP = ((k25p - spot) / spot) * 100;
    const ivC = surfaceIv('call', offC, 14, baseIv);
    const ivP = surfaceIv('put', offP, 14, baseIv);
    return { ivC, ivP, rr: ivP - ivC, fly: ivC + ivP - 2 * baseIv };
  }, [spot, baseIv]);

  const em = expectedMoveBand(spot, baseIv, 1);
  const seedKey = `${underlying}-${Math.round(spot / 500)}`;
  const realized1d = baseIv * (0.42 + seeded(seedKey + 'r') * 0.2);

  const risk = useMemo(
    () => distributionalRisk(analysis.payoffAt, spot, baseIv, horizon),
    [analysis, spot, baseIv, horizon],
  );

  // second-order nets
  const so = useMemo(() => {
    let vanna = 0, vomma = 0, charm = 0, speed = 0, gammaPct = 0, rho = 0;
    for (const l of analysis.resolved) {
      const g = legSecondOrder(l, spot);
      vanna += g.vanna; vomma += g.vomma; charm += g.charm; speed += g.speed; gammaPct += g.gammaPct; rho += g.rho;
    }
    return { vanna, vomma, charm, speed, gammaPct, rho };
  }, [analysis, spot]);

  const legRows = useMemo(
    () => analysis.resolved.map((l, i) => ({ n: i + 1, l, so: legSecondOrder(l, spot), bs: legQuote(l, spot, baseIv, anchorSpot ?? spot) })),
    [analysis, spot, baseIv, anchorSpot],
  );

  const nearestBe = analysis.breakevens.length
    ? analysis.breakevens.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a))
    : null;
  const touchProb = nearestBe ? Math.min(0.99, 2 * (1 - 0.5 * (1 + Math.sign(nearestBe - spot) * 0.42)) * 0.9) : 0;

  const matrixRow1: { label: string; value: string; sub: string }[] = [
    { label: 'Delta Δ/ΔS', value: fmtNum(analysis.netDelta, 4), sub: `Δ/$ per $1` },
    { label: 'Gamma Δ²/ΔS²', value: fmtNum(analysis.netGamma, 4), sub: 'convexity' },
    { label: 'Vega ν/Δσ', value: fmtUsd(analysis.netVega), sub: 'per 1 vol pt' },
    { label: 'Theta θ/Δt', value: fmtUsd(analysis.netTheta), sub: 'per day' },
    { label: 'Rho ρ/Δr', value: fmtUsd(so.rho), sub: 'per 1% rate' },
  ];
  const matrixRow2: { label: string; value: string; sub: string }[] = [
    { label: 'Vanna ∂Δ/∂Σ', value: fmtNum(so.vanna, 4), sub: 'delta per vol pt' },
    { label: 'Vomma ∂ν/∂σ²', value: fmtUsd(so.vomma, 3), sub: 'vega per vol pt' },
    { label: 'Charm ∂Δ/∂t', value: fmtNum(so.charm, 4), sub: 'delta decay / day' },
    { label: 'Speed ∂Γ/ΔS', value: fmtNum(so.speed, 6), sub: 'γ per 1% move' },
    { label: 'Gamma $/1%', value: fmtUsd(so.gammaPct), sub: '½Γ(1%S)² P&L' },
  ];

  const tsPath = useMemo(() => {
    const W = 560, H = 90;
    const minIv = Math.min(...ts.map((t) => t.iv)), maxIv = Math.max(...ts.map((t) => t.iv));
    return ts.map((t, i) => {
      const x = (i / (ts.length - 1)) * (W - 20) + 10;
      const y = H - 12 - ((t.iv - minIv) / (maxIv - minIv || 1)) * (H - 28);
      return { x, y, ...t };
    });
  }, [ts]);

  return (
    <div className="space-y-3">
      <SectionCard
        title={`Volatility surface · ${underlying}`}
        icon={<TrendingUp className="h-3.5 w-3.5" />}
        right="ATM IV TERM STRUCTURE"
      >
        <svg viewBox="0 0 560 96" className="w-full">
          <path
            d={tsPath.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
            fill="none" stroke="#2dd4bf" strokeWidth={1.6}
          />
          {tsPath.map((p) => (
            <g key={p.d}>
              <circle cx={p.x} cy={p.y} r={2.2} fill="#2dd4bf" />
              <text x={p.x} y={90} textAnchor="middle" fontSize={8} className="fill-zinc-600">
                {p.d === 1 ? '1D' : p.d === 2 ? '2D' : p.d === 7 ? '1W' : p.d === 14 ? '2W' : p.d === 30 ? '1M' : p.d === 60 ? '2M' : p.d === 90 ? '3M' : p.d === 180 ? '180' : p.d === 300 ? '300' : '1Y'}
              </text>
              <text x={p.x} y={p.y - 6} textAnchor="middle" fontSize={7.5} className="fill-zinc-500" fontFamily="monospace">
                {(p.iv * 100).toFixed(0)}
              </text>
            </g>
          ))}
        </svg>
        <p className="mt-1 text-[10px] text-zinc-500">
          Contango = longer horizons price inversion &gt; near-term event premium (ODTE vol squeeze).
        </p>
      </SectionCard>

      <div className="grid grid-cols-6 gap-2">
        <Stat label="25Δ PUT IV" value={`${(wings.ivP * 100).toFixed(1)}%`} sub="14d wing" tone="neg" />
        <Stat label="ATM IV 30D" value={`${(baseIv * 100).toFixed(1)}%`} />
        <Stat label="25Δ CALL IV" value={`${(wings.ivC * 100).toFixed(1)}%`} sub="14d wing" tone="pos" />
        <Stat label="Risk reversal 25Δ" value={`${(wings.rr * 100).toFixed(1)}%`} sub="put skew: crash premium" tone="neg" />
        <Stat label="Butterfly 25Δ" value={`${(wings.fly * 100).toFixed(2)} pts`} sub="smile curvature" />
        <Stat label="IV − 1D realized" value={`${((baseIv - realized1d) * 100).toFixed(1)} pts`} sub="vol-of-vol premium" tone="amber" />
      </div>

      <SectionCard title="Expected move · 1D horizon (lognormal)" icon={<Gauge className="h-3.5 w-3.5" />}>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-zinc-100">{Math.round(em.lo).toLocaleString()}</span>
          <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
            <div className="absolute inset-y-0 left-[38%] right-[38%] rounded-full bg-gradient-to-r from-teal-400/40 via-teal-300 to-teal-400/40" />
          </div>
          <span className="font-mono text-sm text-zinc-100">{Math.round(em.hi).toLocaleString()}</span>
          <span className="font-mono text-[11px] text-teal-300">±{(em.pct * 100).toFixed(1)}%</span>
        </div>
      </SectionCard>

      <SectionCard
        title={`Greeks matrix — first & second order (size ${size})`}
        icon={<Zap className="h-3.5 w-3.5" />}
        right="FD on the live BS / everlasting engines"
      >
        <div className="grid grid-cols-5 gap-2">
          {[...matrixRow1, ...matrixRow2].map((m) => (
            <Stat key={m.label} label={m.label} value={m.value} sub={m.sub} />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Leg-by-leg greeks" icon={<SlidersHorizontal className="h-3.5 w-3.5" />}>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-[9px] uppercase tracking-wider text-zinc-500">
                <th className="py-1.5 pr-3">Leg</th>
                <th className="pr-3">IV</th>
                <th className="pr-3">Δ</th>
                <th className="pr-3">Γ</th>
                <th className="pr-3">Vanna</th>
                <th className="pr-3">Vomma</th>
                <th className="pr-3">Charm</th>
                <th className="pr-3">Speed</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {legRows.map((r) => (
                <tr key={r.l.id} className="border-b border-zinc-900">
                  <td className="py-1.5 pr-3 text-zinc-300">{r.n} {r.l.kind === 'perp_option' ? 'Everlasting' : r.l.kind}</td>
                  <td className="pr-3 text-amber-400/90">{r.l.iv > 0 ? `${(r.l.iv * 100).toFixed(1)}%` : '—'}</td>
                  <td className="pr-3 text-zinc-200">{fmtNum(r.l.delta, 4)}</td>
                  <td className="pr-3 text-zinc-200">{fmtNum(r.l.gamma, 6)}</td>
                  <td className="pr-3 text-zinc-300">{fmtNum(r.so.vanna, 4)}</td>
                  <td className="pr-3 text-zinc-300">{fmtUsd(r.so.vomma, 3)}</td>
                  <td className="pr-3 text-zinc-300">{fmtNum(r.so.charm, 4)}</td>
                  <td className="text-zinc-300">{fmtNum(r.so.speed, 6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
          Everlasting legs carry zero charm by construction — no expiry cliff. Delta drifts only with spot and vol.
          Vanna and vomma tell you how the delta/vega hedge itself moves when IV re-prices.
        </p>
      </SectionCard>

      <SectionCard
        title={`Distributional risk — horizon ${horizon}d`}
        icon={<Gauge className="h-3.5 w-3.5" />}
        right="lognormal P&L · driftless"
      >
        <div className="grid grid-cols-6 gap-2">
          <Stat label="VaR 5%" value={fmtUsd(risk.var5)} sub="5th pct P&L" tone="neg" />
          <Stat label="VaR 1%" value={fmtUsd(risk.var1)} sub="1st pct P&L" tone="neg" />
          <Stat label="CVaR 95%" value={fmtUsd(risk.cvar5)} sub="expected shortfall" tone="neg" />
          <Stat label="Prob. of profit" value={`${fmtNum(risk.pop * 100, 1)}%`} tone="pos" />
          <Stat label="Expected value" value={fmtUsd(risk.ev, 2)} tone={risk.ev >= 0 ? 'pos' : 'neg'} />
          <Stat label="P(touch BE)" value={`${fmtNum(touchProb * 100, 0)}%`} sub={nearestBe ? `nearest ${Math.round(nearestBe).toLocaleString()}` : '—'} />
        </div>
      </SectionCard>
    </div>
  );
}

// ── PLATFORMS (SOR routing matrix) ───────────────────────────────────────────

export function PlatformsTab({ market, spec }: { market: MarketState; spec: StrategySpec }) {
  const [filter, setFilter] = useState<RoutingFilterId | null>(null);
  const { legs } = useStrategy();
  const feasible = useMemo(
    () => feasibleVenueCount(legs.map((l) => l.kind), legs.map((l) => l.dte)),
    [legs],
  );

  const ranked = useMemo(() => {
    const rows = ROUTABLE_VENUES.map((v) => {
      const w = filter ? ROUTING_FILTERS.find((f) => f.id === filter)!.weight : DEFAULT_WEIGHTS;
      return { v, score: weightedScore(v, w) };
    });
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }, [filter]);

  const best = ranked[0];
  const weights = filter ? ROUTING_FILTERS.find((f) => f.id === filter)!.weight : DEFAULT_WEIGHTS;

  return (
    <div className="space-y-3">
      <SectionCard
        title="Smart order routing"
        icon={<LayoutGrid className="h-3.5 w-3.5" />}
        right={
          <span className="font-mono text-[10px] text-zinc-500">
            composite · eff {Math.round(weights.eff * 100)}% · perf {Math.round(weights.perf * 100)}% · price {Math.round(weights.price * 100)}% · safety {Math.round(weights.safety * 100)}%
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
            <span className="text-sm font-bold text-zinc-50">BEST ROUTE: <span className="text-teal-300">{best?.v.name}</span></span>
          </div>
          <span className="text-[10px] text-zinc-500">
            composite pricing across {feasible}/{VENUES.length} feasible venues for {spec.name} —
            legs matched on the book with the deepest complex-order support, netting cross-margin where available.
          </span>
          <div className="ml-auto flex gap-1">
            <Chip active={filter === null} onClick={() => setFilter(null)}>BALANCED</Chip>
            {ROUTING_FILTERS.map((f) => (
              <Chip key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</Chip>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Routing matrix — 13 routable venues, ranked" icon={<LayoutGrid className="h-3.5 w-3.5" />}>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-[9px] uppercase tracking-wider text-zinc-500">
                <th className="py-1.5 pr-3">Venue</th>
                <th className="pr-3">Book</th>
                <th className="w-24 pr-3">Effic.</th>
                <th className="w-24 pr-3">Perf.</th>
                <th className="w-24 pr-3">Price</th>
                <th className="w-24 pr-3">Safety</th>
                <th className="text-right">Composite</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ v, score }, i) => {
                const ping = market.venues.find((mv) => mv.id === v.id);
                return (
                  <tr key={v.id} className={`border-b border-zinc-900 ${i === 0 ? 'bg-teal-400/5' : ''}`}>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1.5">
                        {i === 0 && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}
                        <span className="font-semibold text-zinc-100">{v.name}</span>
                        {ping?.live && <span className="h-1.5 w-1.5 rounded-full bg-teal-400" title={`live · ${ping.latencyMs ?? '?'}ms`} />}
                      </div>
                    </td>
                    <td className="pr-3 text-[9px] uppercase tracking-wider text-zinc-500">{v.book}</td>
                    {[v.scores.eff, v.scores.perf, v.scores.price, v.scores.safety].map((s, j) => (
                      <td key={j} className="pr-3">
                        <div className="flex items-center gap-1.5">
                          <ScoreBar value={s} tone={j === 2 ? 'amber' : 'teal'} />
                          <span className="w-6 shrink-0 text-right font-mono text-[9px] text-zinc-500">{s}</span>
                        </div>
                      </td>
                    ))}
                    <td className={`text-right font-mono font-bold ${score >= 65 ? 'text-teal-300' : 'text-zinc-300'}`}>{score}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
          Feasibility is a hard listing filter — only venues that list every leg&apos;s instrument class enter the
          matrix; composite scoring then ranks execution quality (weights per the active filter). Package orders
          prefer complex-order books (CBOE · Nasdaq/PHLX · MIAX) and RFQ networks for size.
        </p>
      </SectionCard>
    </div>
  );
}

// ── BACKTEST ─────────────────────────────────────────────────────────────────

interface BacktestResult {
  ok: boolean;
  strategy: { id: string; name: string; legs: number; cycle: number };
  source: string;
  kpis: {
    totalPnl: number; cycles: number; returnOnRisk: number; cagr: number; winRate: number;
    won: number; lost: number; profitFactor: number; expectancy: number; maxDrawdown: number;
    worstCyclePnl: number; sharpe: number; sortino: number; capitalBase: number;
  };
  equityCurve: { date: string; equity: number }[];
  volModel: { calibration: number; avgEntryIv: number; liveAtmIv: number };
  recentCycles: { n: number; entryDate: string; exitDate: string; spotIn: number; spotOut: number; cost: number; pnl: number; r: number }[];
}

export function BacktestTab({ spec }: { spec: StrategySpec }) {
  const { underlying } = useStrategy();
  const [days, setDays] = useState(365);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [spec.id, days, underlying]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch(`/api/backtest?strategy=${spec.id}&days=${days}&underlying=${underlying}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'backtest failed');
      setResult(j as BacktestResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'backtest failed');
    } finally {
      setRunning(false);
    }
  }

  const curve = useMemo(() => {
    if (!result?.equityCurve.length) return null;
    const W = 900, H = 170, PL = 8, PR = 8, PT = 10, PB = 18;
    const eq = result.equityCurve;
    const lo = Math.min(0, ...eq.map((p) => p.equity));
    const hi = Math.max(0, ...eq.map((p) => p.equity));
    const x = (i: number) => PL + (i / (eq.length - 1 || 1)) * (W - PL - PR);
    const y = (v: number) => PT + (1 - (v - lo) / (hi - lo || 1)) * (H - PT - PB);
    const line = eq.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
    const area = `${line} L${x(eq.length - 1).toFixed(1)},${y(lo).toFixed(1)} L${x(0).toFixed(1)},${y(lo).toFixed(1)} Z`;
    const zero = y(0);
    const peak = eq.reduce((a, p) => (p.equity > a.equity ? p : a), eq[0]);
    const trough = eq.reduce((a, p) => (p.equity < a.equity ? p : a), eq[0]);
    return { W, H, line, area, zero, peak, trough, x, y, n: eq.length };
  }, [result]);

  return (
    <div className="space-y-3">
      <SectionCard
        title={`${spec.name} — historical performance`}
        icon={<Clock className="h-3.5 w-3.5" />}
        right={
          <div className="flex items-center gap-2">
            {[90, 168, 365, 730].map((d) => (
              <Chip key={d} active={days === d} onClick={() => setDays(d)}>{d === 168 ? '168h' : `${d}d`}</Chip>
            ))}
            <button
              type="button"
              onClick={run}
              disabled={running}
              className="inline-flex items-center gap-1.5 rounded-md bg-teal-400 px-3 py-1 text-[10px] font-bold text-zinc-950 transition-colors hover:bg-teal-300 disabled:opacity-50"
            >
              ▶ {running ? 'Running…' : 'Run Backtest'}
            </button>
          </div>
        }
      >
        <p className="text-[10px] text-zinc-500">
          real exchange history · {spec.legs.length} option legs · cycle length {result?.strategy.cycle ?? '—'}d · source: {result?.source ?? 'exchange daily klines'}
        </p>
      </SectionCard>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-300">{error}</div>
      )}

      {!result && !error && !running && (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-zinc-800 text-[11px] text-zinc-600">
          run the backtest to resolve {spec.name} over {days}d of real daily closes
        </div>
      )}

      {result && curve && (
        <>
          <div className="grid grid-cols-6 gap-2">
            <Stat label="Total P&L" value={fmtUsd(result.kpis.totalPnl)} sub={`${result.kpis.cycles} cycles`} tone={result.kpis.totalPnl >= 0 ? 'pos' : 'neg'} />
            <Stat label="Return on risk" value={`${fmtNum(result.kpis.returnOnRisk * 100, 1)}%`} sub={`CAGR ${fmtNum(result.kpis.cagr * 100, 0)}%`} tone={result.kpis.returnOnRisk >= 0 ? 'pos' : 'neg'} />
            <Stat label="Win rate" value={`${fmtNum(result.kpis.winRate * 100, 1)}%`} sub={`won ${result.kpis.won} / lost ${result.kpis.lost}`} />
            <Stat label="Profit factor" value={fmtNum(result.kpis.profitFactor, 2)} sub={`expectancy ${fmtUsd(result.kpis.expectancy, 2)}/cycle`} />
            <Stat label="Max drawdown" value={`${fmtNum(result.kpis.maxDrawdown * 100, 1)}%`} sub={`worst cycle ${fmtUsd(result.kpis.worstCyclePnl)}`} tone="neg" />
            <Stat label="Sharpe (Sortino)" value={`${fmtNum(result.kpis.sharpe, 2)} · ${fmtNum(result.kpis.sortino, 2)}`} sub={`capital base ${fmtUsd(result.kpis.capitalBase)}`} />
          </div>

          <SectionCard
            title="Cumulative P&L curve"
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            right={`${result.equityCurve[0]?.date ?? ''} → ${result.equityCurve[result.equityCurve.length - 1]?.date ?? ''} · peak ${fmtUsd(curve.peak.equity)} · trough ${fmtUsd(curve.trough.equity)}`}
          >
            <svg viewBox={`0 0 ${curve.W} ${curve.H}`} className="w-full">
              <path d={curve.area} fill="#2dd4bf" opacity={0.12} />
              <line x1={8} x2={curve.W - 8} y1={curve.zero} y2={curve.zero} stroke="#52525b" strokeWidth={0.7} strokeDasharray="4 3" />
              <path d={curve.line} fill="none" stroke="#2dd4bf" strokeWidth={1.6} />
            </svg>
          </SectionCard>

          <div className="grid grid-cols-[300px_1fr] gap-3">
            <SectionCard title="Vol model" icon={<Gauge className="h-3.5 w-3.5" />}>
              <div className="space-y-2">
                <Stat label="Calibration factor" value={`${result.volModel.calibration.toFixed(2)}×`} />
                <Stat label="Avg entry IV" value={`${(result.volModel.avgEntryIv * 100).toFixed(1)}%`} />
                <Stat label="Live ATM IV now" value={`${(result.volModel.liveAtmIv * 100).toFixed(1)}%`} tone="teal" />
              </div>
            </SectionCard>
            <SectionCard title="Recent cycles (most recent first)" icon={<Clock className="h-3.5 w-3.5" />}>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="border-b border-zinc-800 text-left text-[9px] uppercase tracking-wider text-zinc-500">
                      <th className="py-1 pr-2">#</th>
                      <th className="pr-2">Entry</th>
                      <th className="pr-2">Exit</th>
                      <th className="pr-2">Spot in/out</th>
                      <th className="pr-2 text-right">Debit/Credit</th>
                      <th className="pr-2 text-right">P&L</th>
                      <th className="text-right">R</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {result.recentCycles.map((c) => (
                      <tr key={c.n} className="border-b border-zinc-900">
                        <td className="py-1 pr-2 text-zinc-600">{c.n}</td>
                        <td className="pr-2 text-zinc-400">{c.entryDate.slice(5)}</td>
                        <td className="pr-2 text-zinc-400">{c.exitDate.slice(5)}</td>
                        <td className="pr-2 text-zinc-300">{Math.round(c.spotIn).toLocaleString()}→{Math.round(c.spotOut).toLocaleString()}</td>
                        <td className="pr-2 text-right text-zinc-300">{fmtUsd(Math.abs(c.cost), 0)}</td>
                        <td className={`pr-2 text-right font-semibold ${c.pnl >= 0 ? 'text-teal-400' : 'text-rose-400'}`}>{fmtUsd(c.pnl)}</td>
                        <td className="text-right text-zinc-400">{c.r.toFixed(2)}R</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          </div>

          <SectionCard title="Assumptions" icon={<SlidersHorizontal className="h-3.5 w-3.5" />}>
            <ul className="list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-zinc-500">
              <li>Perpetual-to-dated settlement at close (no early assignment / American exercise)</li>
              <li>Legs re-strike per cycle at 2bps fee = 1% premium slippage</li>
              <li>IV per cycle from rolling 20d realized vol × live market calibration factor</li>
              <li>Capital base = worst-case loss of the first cycles (defined risk) or 15% spot margin proxy</li>
            </ul>
            <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
              Backtests re-strike the structure at every cycle&apos;s entry spot on real daily closes — the strikes
              you see above (as % moneyness) are applied to each historical price level, then priced with
              Black-Scholes on a realized vol surface calibrated to today&apos;s live ATM IV, marked daily and settled
              at intrinsic. Past performance of a replication is indicative, not a guarantee; execution costs are
              modeled (re-strike per cycle at 2bps fee + 1% premium slippage).
            </p>
          </SectionCard>
        </>
      )}
    </div>
  );
}

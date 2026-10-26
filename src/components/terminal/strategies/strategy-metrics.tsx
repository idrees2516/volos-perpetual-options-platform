'use client';

// Strategy Metrics tab — the deep quantitative layer: IV surface (term
// structure, 25Δ skew, expected move), the full greeks matrix including
// second-order (vanna / charm / vomma / speed), distributional risk
// (VaR · CVaR · probability-of-touching), the spot×IV stress grid, and
// execution economics (capital, ROC, theta yield, slippage).

import React from 'react';
import {
  Waves, TrendingUp, ShieldAlert, Landmark, Gauge, Activity, Percent, Sigma,
} from 'lucide-react';
import type { AssetMarket, Leg, StrategyAnalysis, UnderlyingId } from '@/lib/types';
import { fmtNum, fmtUsd, fmtPctSigned, heatColor } from '@/lib/format';
import {
  executionMetrics,
  expectedMove,
  riskMetrics,
  secondOrderGreeks,
  skewMetrics,
  termStructure,
} from '@/lib/metrics';
import { kindLabel } from '@/lib/types';

interface MetricsProps {
  analysis: StrategyAnalysis;
  legs: Leg[];
  underlying: UnderlyingId;
  market: AssetMarket;
  specName: string;
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

function SectionTitle({ icon, title, accent, right }: { icon: React.ReactNode; title: string; accent: string; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${accent}`}>
        {icon}
        {title}
      </h3>
      {right}
    </div>
  );
}

export function StrategyMetrics({ analysis, legs, underlying, market, specName }: MetricsProps) {
  const spot = market.spot;

  // IV surface.
  const term = termStructure(underlying, market);
  const skew = skewMetrics(underlying, market);
  const em = expectedMove(underlying, market, analysis.horizonDays);
  const maxTermIv = Math.max(...term.map((t) => t.atm));

  // Greeks II.
  const g2 = secondOrderGreeks(legs, underlying, market, 1);
  const g = analysis.greeks;

  // Risk.
  const risk = riskMetrics(analysis, spot, underlying, market);
  const exec = executionMetrics(analysis);

  // Stress grid from the analysis scenario matrix.
  const sm = analysis.scenarioMatrix;
  const flat = sm.pnl.flat();
  const maxAbs = Math.max(...flat.map(Math.abs), 1);

  return (
    <div className="space-y-3">
      {/* ── Volatility surface ─────────────────────────────────────────── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <SectionTitle
          icon={<Waves className="h-3.5 w-3.5" />}
          title={`Volatility surface · ${underlying}`}
          accent="text-teal-300"
          right={
            <span className="font-mono text-[8px] text-zinc-600">
              horizon {analysis.horizonDays}d · σH {(risk.sigmaH * 100).toFixed(1)}% log-space
            </span>
          }
        />
        <div className="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
          {/* term structure bars */}
          <div className="rounded-md border border-zinc-800/70 bg-zinc-950/50 p-2.5">
            <p className="mb-1.5 text-[8px] uppercase tracking-wider text-zinc-600">ATM IV term structure</p>
            <div className="flex h-24 items-end gap-1.5">
              {term.map((t) => {
                const h = Math.max((t.atm / maxTermIv) * 100, 4);
                const hot = t.atm === maxTermIv;
                return (
                  <div key={t.label} className="flex flex-1 flex-col items-center gap-1">
                    <span className="font-mono text-[8px] tabular-nums text-zinc-500">
                      {(t.atm * 100).toFixed(0)}
                    </span>
                    <div
                      className={`w-full rounded-t-sm ${hot ? 'bg-teal-500/80' : 'bg-teal-800/50'}`}
                      style={{ height: `${h}%` }}
                      title={`${t.label} ATM IV ${(t.atm * 100).toFixed(1)}%`}
                    />
                    <span className="text-[7px] uppercase tracking-wide text-zinc-600">{t.label}</span>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[8px] leading-relaxed text-zinc-600">
              Contango ⇒ longer horizons pricier; inversion ⇒ near-term event premium (0DTE vol squeeze).
            </p>
          </div>
          {/* skew + expected move */}
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-1.5">
              <Stat label="25Δ put IV" value={fmtNum(skew.put25Iv * 100, 1) + '%'} sub={`K ${fmtNum(skew.put25Strike, 0)}`} tone="text-rose-300" />
              <Stat label="ATM IV 30d" value={fmtNum(skew.atmIv * 100, 1) + '%'} tone="text-zinc-100" />
              <Stat label="25Δ call IV" value={fmtNum(skew.call25Iv * 100, 1) + '%'} sub={`K ${fmtNum(skew.call25Strike, 0)}`} tone="text-emerald-300" />
              <Stat
                label="Risk reversal 25Δ"
                value={fmtPctSigned(skew.rr25, 1)}
                tone={skew.rr25 < 0 ? 'text-rose-400' : 'text-emerald-400'}
                sub={skew.rr25 < 0 ? 'put skew / crash premium' : 'call skew / squeeze'}
              />
              <Stat label="Butterfly 25Δ" value={fmtNum(skew.fly25 * 100, 2) + ' pts'} sub="smile curvature" />
              <Stat label="IV − 1d realized" value={fmtNum((skew.atmIv - em.realized1dAnn) * 100, 1) + ' pts'} tone={em.ivPremium > 0 ? 'text-amber-300' : 'text-emerald-300'} sub="vol risk premium" />
            </div>
            <div className="rounded-md border border-zinc-800/70 bg-zinc-950/50 px-2.5 py-2">
              <p className="mb-1 flex items-center gap-1 text-[8px] uppercase tracking-wider text-zinc-600">
                <Sigma className="h-3 w-3" /> Expected move · {analysis.horizonDays}d horizon (lognormal)
              </p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-zinc-500">{fmtNum(em.lo1, 0)}</span>
                <div className="relative h-4 flex-1 overflow-hidden rounded-sm bg-zinc-800/60">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-500" />
                  <div
                    className="absolute inset-y-0 bg-teal-900/50 ring-1 ring-teal-700/60"
                    style={{ left: '25%', right: '25%' }}
                  />
                  <div className="absolute inset-0 flex items-center justify-center font-mono text-[8px] text-teal-200">
                    ±1σ {fmtNum(em.oneSigmaPct, 1)}% · ±2σ {fmtNum(em.twoSigmaPct, 0)}%
                  </div>
                </div>
                <span className="font-mono text-[10px] text-zinc-500">{fmtNum(em.hi1, 0)}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Greeks matrix — first + second order ────────────────────────── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <SectionTitle
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          title="Greeks matrix — first & second order (size 1)"
          accent="text-amber-300"
          right={<span className="font-mono text-[8px] text-zinc-600">FD on the live BS / everlasting engines</span>}
        />
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
          <Stat label="Delta ∂V/∂S" value={fmtNum(g.delta, 3)} sub={`Δ$ ${fmtUsd(g.deltaExposureUsd, { compact: true })}`} tone={g.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
          <Stat label="Gamma ∂Δ/∂S" value={fmtNum(g.gamma, 4)} sub="convexity" />
          <Stat label="Vega ∂V/∂σ" value={fmtUsd(g.vega)} sub="per 1 vol pt" />
          <Stat label="Theta ∂V/∂t" value={fmtUsd(g.theta)} sub="per day" tone={g.theta >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
          <Stat label="Rho ∂V/∂r" value={fmtUsd(g.rho)} sub="per 1% rate" />
          <Stat
            label="Vanna ∂Δ/∂σ"
            value={fmtNum(g2.net.vanna, 3)}
            sub="delta per vol pt"
            tone={Math.abs(g2.net.vanna) > 0.1 ? 'text-sky-300' : 'text-zinc-400'}
          />
          <Stat
            label="Vomma ∂²V/∂σ²"
            value={fmtUsd(g2.net.vomma)}
            sub="vega per vol pt"
            tone={Math.abs(g2.net.vomma) > 1 ? 'text-sky-300' : 'text-zinc-400'}
          />
          <Stat
            label="Charm ∂Δ/∂t"
            value={fmtNum(g2.net.charm, 3)}
            sub="delta decay / day"
            tone={Math.abs(g2.net.charm) > 0.05 ? 'text-violet-300' : 'text-zinc-400'}
          />
          <Stat
            label="Speed ∂Γ/∂S"
            value={fmtNum(g2.net.speed, 5)}
            sub="γ per 1% move"
            tone={Math.abs(g2.net.speed) > 1e-4 ? 'text-violet-300' : 'text-zinc-400'}
          />
          <Stat
            label="Gamma $ / 1%"
            value={fmtUsd(0.5 * g.gamma * (0.01 * spot) ** 2)}
            sub="P&L of a 1% wiggle"
          />
        </div>

        {/* per-leg second-order table */}
        {legs.length <= 12 && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left">
              <thead>
                <tr className="border-b border-zinc-800 text-[8px] uppercase tracking-wider text-zinc-600">
                  <th className="py-1.5 pr-2 font-medium">Leg</th>
                  <th className="pr-2 font-medium">IV</th>
                  <th className="pr-2 font-medium">Δ</th>
                  <th className="pr-2 font-medium">Γ</th>
                  <th className="pr-2 font-medium">Vanna</th>
                  <th className="pr-2 font-medium">Vomma</th>
                  <th className="pr-2 font-medium">Charm</th>
                  <th className="pr-2 text-right font-medium">Speed</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[10px] tabular-nums">
                {analysis.legs.map((l, i) => {
                  const sg = g2.perLeg.find((p) => p.id === l.id)?.g;
                  return (
                    <tr key={l.id} className="border-b border-zinc-800/40 text-zinc-300">
                      <td className="py-1.5 pr-2"><span className="text-zinc-600">{i + 1}</span> {kindLabel(l.kind)}</td>
                      <td className="pr-2">{l.iv !== undefined ? fmtNum(l.iv * 100, 1) + '%' : '—'}</td>
                      <td className="pr-2">{fmtNum(l.delta, 3)}</td>
                      <td className="pr-2">{fmtNum(l.gamma, 4)}</td>
                      <td className="pr-2">{sg ? fmtNum(sg.vanna, 3) : '—'}</td>
                      <td className="pr-2">{sg ? fmtUsd(sg.vomma) : '—'}</td>
                      <td className="pr-2">{sg ? fmtNum(sg.charm, 3) : '—'}</td>
                      <td className="pr-2 text-right">{sg ? fmtNum(sg.speed, 5) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1.5 text-[8px] leading-relaxed text-zinc-600">
              Everlasting legs carry zero charm by construction — no expiry cliff, delta drifts only with spot and vol.
              Vanna and vomma tell you how the delta/vega hedge itself moves when IV re-prices.
            </p>
          </div>
        )}
      </section>

      {/* ── Distributional risk ─────────────────────────────────────────── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <SectionTitle
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          title={`Distributional risk · horizon ${analysis.horizonDays}d`}
          accent="text-rose-300"
          right={<span className="font-mono text-[8px] text-zinc-600">lognormal P&amp;L law · driftless</span>}
        />
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          <Stat label="VaR 95%" value={fmtUsd(risk.var95, { compact: true })} tone="text-rose-400" sub="5th pct P&L" />
          <Stat label="VaR 99%" value={fmtUsd(risk.var99, { compact: true })} tone="text-rose-400" sub="1st pct P&L" />
          <Stat label="CVaR 95%" value={fmtUsd(risk.cvar95, { compact: true })} tone="text-rose-300" sub="expected shortfall" />
          <Stat label="Prob. of profit" value={fmtNum(analysis.pop * 100, 1) + '%'} tone="text-teal-300" />
          <Stat label="Expected value" value={fmtUsd(analysis.expectedValue, { compact: true })} tone={analysis.expectedValue >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
          <Stat
            label="P(touch BE)"
            value={risk.touch.length ? fmtNum(Math.min(...risk.touch.map((t) => t.prob)) * 100, 0) + '%' : '—'}
            sub={risk.touch.length ? `nearest ${fmtNum(risk.touch.reduce((a, b) => (b.prob < a.prob ? b : a)).level, 0)}` : 'no breakevens'}
          />
        </div>
        {risk.touch.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-zinc-800/70 bg-zinc-950/50 px-2.5 py-1.5">
            <span className="text-[8px] uppercase tracking-wider text-zinc-600">Prob. of touching</span>
            {risk.touch.map((t, i) => (
              <span key={i} className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-200">
                {fmtNum(t.level, t.level >= 1000 ? 0 : 2)} · {fmtNum(t.prob * 100, 0)}%
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── Stress grid: spot × IV ───────────────────────────────────────── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <SectionTitle
          icon={<Gauge className="h-3.5 w-3.5" />}
          title="Stress grid — P&L by spot shock × IV shock"
          accent="text-sky-300"
          right={<span className="font-mono text-[8px] text-zinc-600">instantaneous · {specName}</span>}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-center">
            <thead>
              <tr className="text-[8px] uppercase tracking-wider text-zinc-600">
                <th className="py-1 pr-1 text-left font-medium">IV ↓ \ spot →</th>
                {sm.spotShocks.map((s) => (
                  <th key={s} className="px-1 font-medium">
                    {fmtPctSigned(s, 0)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-[10px] tabular-nums">
              {sm.ivShocks.map((ivs, r) => (
                <tr key={ivs}>
                  <td className="py-1 pr-1 text-left text-[9px] text-zinc-500">
                    {ivs === 0 ? 'IV —' : ivs > 0 ? `IV +${(ivs * 100).toFixed(0)}pts` : `IV −${Math.abs(ivs * 100).toFixed(0)}pts`}
                  </td>
                  {sm.pnl[r].map((pnl, c) => (
                    <td
                      key={c}
                      className={`rounded-sm px-1 py-1.5 ${c === sm.spotShocks.indexOf(0) && ivs === 0 ? 'ring-1 ring-zinc-600' : ''}`}
                      style={{ backgroundColor: heatColor(pnl, maxAbs) }}
                      title={`spot ${fmtPctSigned(sm.spotShocks[c], 0)} · IV ${fmtPctSigned(ivs, 0)} → ${fmtUsd(pnl)}`}
                    >
                      <span className={pnl >= 0 ? 'text-emerald-200' : 'text-rose-200'}>
                        {fmtUsd(pnl, { compact: true })}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[8px] leading-relaxed text-zinc-600">
          Ringed cell = current market. The left edge maps the short-vol crash scenario; the right edge the melt-up.
        </p>
      </section>

      {/* ── Execution economics ─────────────────────────────────────────── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <SectionTitle
          icon={<Landmark className="h-3.5 w-3.5" />}
          title="Execution & capital economics"
          accent="text-violet-300"
          right={
            <span className="font-mono text-[8px] text-zinc-600">
              structure liquidity {fmtNum(analysis.liquidity * 100, 0)}%
            </span>
          }
        />
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          <Stat
            label="Capital required"
            value={fmtUsd(exec.capital, { compact: true })}
            sub={analysis.isCredit ? 'margin (credit structure)' : 'premium paid'}
          />
          <Stat
            label="Return on capital"
            value={exec.rocAtMax !== null ? fmtNum(exec.rocAtMax * 100, 1) + '%' : '∞'}
            tone="text-emerald-400"
            sub="at max profit"
          />
          <Stat
            label="Θ yield (ann.)"
            value={exec.thetaYieldAnn !== null ? fmtNum(exec.thetaYieldAnn * 100, 1) + '%' : '—'}
            tone="text-violet-300"
            sub="|θ|·365 / capital"
          />
          <Stat label="Est. slippage" value={fmtNum(exec.slippageBps, 0) + ' bps'} sub={fmtUsd(exec.slippageUsd) + ' est.'} />
          <Stat label="Margin est." value={fmtUsd(analysis.marginEstimate, { compact: true })} sub="10% stress buffer" />
          <Stat
            label="Funding APR"
            value={fmtNum((market.fundingRate ?? 0) * 365 * 100, 1) + '%'}
            tone={(market.fundingRate ?? 0) >= 0 ? 'text-amber-300' : 'text-emerald-300'}
            sub="perp carry drag"
          />
        </div>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
          <div className="rounded-md border border-zinc-800/70 bg-zinc-950/50 px-2.5 py-1.5">
            <p className="flex items-center gap-1 text-[8px] uppercase tracking-wider text-zinc-600"><Activity className="h-3 w-3" /> Microstructure</p>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-300">
              OI {fmtUsd(market.openInterest, { compact: true })} · 24h vol {fmtUsd(market.volume24h, { compact: true })} · turnover{' '}
              {fmtNum(market.volume24h / Math.max(market.openInterest, 1), 2)}×
            </p>
          </div>
          <div className="rounded-md border border-zinc-800/70 bg-zinc-950/50 px-2.5 py-1.5">
            <p className="flex items-center gap-1 text-[8px] uppercase tracking-wider text-zinc-600"><Percent className="h-3 w-3" /> Basis & carry</p>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-300">
              funding {(fmtNum((market.fundingRate ?? 0) * 100, 3) + '%')}/period · 24h Δ {fmtPctSigned(market.change24h ?? 0, 2)}
            </p>
          </div>
          <div className="rounded-md border border-zinc-800/70 bg-zinc-950/50 px-2.5 py-1.5">
            <p className="flex items-center gap-1 text-[8px] uppercase tracking-wider text-zinc-600"><Waves className="h-3 w-3" /> Vol regime</p>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-300">
              vol shift {fmtPctSigned(market.volShift, 1)} · IV premium {fmtNum(em.ivPremium * 100, 1)} pts over 1d realized
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

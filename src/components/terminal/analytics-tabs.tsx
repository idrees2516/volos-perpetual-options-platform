'use client';

// Bottom analytics tabs: scenario matrix (spot × IV heatmap), Greeks-vs-spot
// chart, carry budget with Carry-at-Risk, and the strategy-level RFQ panel.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Grid3x3, Activity, Flame, Radio, RefreshCw, Loader2, CheckCircle2, Timer,
} from 'lucide-react';
import type { Leg, StrategyAnalysis, UnderlyingId } from '@/lib/types';
import { fmtUsd, fmtNum, heatColor, pnlColor } from '@/lib/format';
import { analyzeStrategy } from '@/lib/pricing';
import { engine, RustQuote } from '@/lib/api';
import { useStrategy, type BuilderTab } from '@/stores/strategy-store';

interface AnalyticsTabsProps {
  analysis: StrategyAnalysis | null;
  legs: Leg[];
  underlying: UnderlyingId;
  market: { spot: number; volShift: number; fundingRate: number };
  size: number;
}

export function AnalyticsTabs({ analysis, legs, underlying, market, size }: AnalyticsTabsProps) {
  const { activeTab, setActiveTab } = useStrategy();
  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as BuilderTab)} className="w-full">
      <TabsList className="h-8 w-full min-w-0 justify-start overflow-x-auto bg-zinc-900/60 p-0.5">
        <TabsTrigger value="scenario" className="h-7 shrink-0 gap-1.5 whitespace-nowrap px-3 text-xs data-[state=active]:bg-zinc-800 data-[state=active]:text-teal-300">
          <Grid3x3 className="h-3 w-3" /> Scenario Matrix
        </TabsTrigger>
        <TabsTrigger value="greeks" className="h-7 shrink-0 gap-1.5 whitespace-nowrap px-3 text-xs data-[state=active]:bg-zinc-800 data-[state=active]:text-teal-300">
          <Activity className="h-3 w-3" /> Greeks Exposure
        </TabsTrigger>
        <TabsTrigger value="carry" className="h-7 shrink-0 gap-1.5 whitespace-nowrap px-3 text-xs data-[state=active]:bg-zinc-800 data-[state=active]:text-teal-300">
          <Flame className="h-3 w-3" /> Carry Budget
        </TabsTrigger>
        <TabsTrigger value="quote" className="h-7 shrink-0 gap-1.5 whitespace-nowrap px-3 text-xs data-[state=active]:bg-zinc-800 data-[state=active]:text-teal-300">
          <Radio className="h-3 w-3" /> Strategy RFQ
        </TabsTrigger>
      </TabsList>
      <TabsContent value="scenario" className="mt-2">
        <ScenarioMatrix analysis={analysis} />
      </TabsContent>
      <TabsContent value="greeks" className="mt-2">
        <GreeksExposure legs={legs} underlying={underlying} market={market} size={size} />
      </TabsContent>
      <TabsContent value="carry" className="mt-2">
        <CarryBudgetPanel analysis={analysis} />
      </TabsContent>
      <TabsContent value="quote" className="mt-2">
        <QuotePanel legs={legs} underlying={underlying} size={size} disabled={!analysis || legs.length === 0} />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------

function ScenarioMatrix({ analysis }: { analysis: StrategyAnalysis | null }) {
  if (!analysis || !analysis.scenarioMatrix.pnl.length) {
    return <EmptyTab text="Add legs to stress-test the structure across spot and IV shocks." />;
  }
  const { spotShocks, ivShocks, pnl } = analysis.scenarioMatrix;
  const maxAbs = Math.max(...pnl.flat().map(Math.abs), 1);
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-[10px] text-zinc-500">Instantaneous P&amp;L revaluation — spot shock × IV shock</p>
          <div className="flex items-center gap-2 text-[9px] text-zinc-500">
            <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ background: heatColor(-maxAbs / 2, maxAbs) }} /> loss</span>
            <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-zinc-800" /> flat</span>
            <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm" style={{ background: heatColor(maxAbs / 2, maxAbs) }} /> profit</span>
          </div>
        </div>
        <table className="w-full border-separate border-spacing-0.5 font-mono text-[10px]">
          <thead>
            <tr>
              <th className="w-20 text-right font-normal text-zinc-500">IV \ Spot</th>
              {spotShocks.map((s) => (
                <th key={s} className={`px-1 py-1 text-center font-semibold ${s === 0 ? 'text-zinc-200' : 'text-zinc-500'}`}>
                  {s > 0 ? '+' : ''}{(s * 100).toFixed(0)}%
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ivShocks.map((iv, i) => (
              <tr key={iv}>
                <td className={`pr-2 text-right font-semibold ${iv === 0 ? 'text-zinc-200' : 'text-zinc-500'}`}>
                  {iv > 0 ? '+' : ''}{(iv * 100).toFixed(0)}%
                </td>
                {pnl[i].map((v, j) => (
                  <td
                    key={j}
                    className="rounded px-1 py-1.5 text-center tabular-nums transition-transform hover:scale-105"
                    style={{
                      background: Math.abs(v) < maxAbs * 0.01 ? 'rgba(39,39,42,0.5)' : heatColor(v, maxAbs),
                      color: Math.abs(v) < maxAbs * 0.01 ? '#71717a' : v >= 0 ? '#d1fae5' : '#ffe4e6',
                      outline: iv === 0 && spotShocks[j] === 0 ? '1px solid rgba(45,212,191,0.5)' : 'none',
                    }}
                    title={`spot ${spotShocks[j] > 0 ? '+' : ''}${(spotShocks[j] * 100).toFixed(0)}%, IV ${iv > 0 ? '+' : ''}${(iv * 100).toFixed(0)}%`}
                  >
                    {fmtUsd(v, { compact: true, sign: true })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">
          SCAN-style scenario grid (Paradex uses 24 simultaneous spot/IV shocks). Margin estimate derives from the worst cell plus a buffer —
          offsets between legs are recognized rather than margining every leg independently.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function GreeksExposure({ legs, underlying, market, size }: { legs: Leg[]; underlying: UnderlyingId; market: { spot: number; volShift: number; fundingRate: number }; size: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { spot: mktSpot, volShift: mktVolShift, fundingRate: mktFunding } = market;

  const data = useMemo(() => {
    if (!legs.length) return null;
    const n = 60;
    const spot = mktSpot;
    const half = Math.max(spot * 0.3, spot * 0.08);
    const axis: number[] = [];
    for (let i = 0; i < n; i++) axis.push(spot - half + (2 * half * i) / (n - 1));
    const rows = axis.map((s) => {
      const a = analyzeStrategy(legs, underlying, { spot: s, volShift: mktVolShift, fundingRate: mktFunding, change24h: 0, openInterest: 0, volume24h: 0 }, size, { points: 3 });
      return { s, delta: a.greeks.delta, vega: a.greeks.vega, theta: a.greeks.theta };
    });
    return { axis, rows };
  }, [legs, underlying, mktSpot, mktVolShift, mktFunding, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !data) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = 170;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 44, padR = 10, padT = 10, padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const series: { key: 'delta' | 'vega' | 'theta'; color: string; label: string }[] = [
      { key: 'delta', color: '#2dd4bf', label: 'Δ delta' },
      { key: 'vega', color: '#fbbf24', label: 'ν vega $/vol pt' },
      { key: 'theta', color: '#f472b6', label: 'Θ theta $/day' },
    ];
    let lo = Infinity, hi = -Infinity;
    for (const r of data.rows) for (const s of series) {
      const v = r[s.key];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    lo = Math.min(lo, 0); hi = Math.max(hi, 0);
    const span = hi - lo || 1;
    lo -= span * 0.1; hi += span * 0.1;
    const X = (v: number) => padL + ((v - data.axis[0]) / (data.axis[data.axis.length - 1] - data.axis[0])) * plotW;
    const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;

    // grid + zero line
    ctx.strokeStyle = 'rgba(148,163,184,0.08)';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(padL + plotW, Y(0)); ctx.stroke();

    // spot marker
    const sx = X(Math.min(Math.max(market.spot, data.axis[0]), data.axis[data.axis.length - 1]));
    ctx.strokeStyle = 'rgba(248,250,252,0.3)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(sx, padT); ctx.lineTo(sx, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);

    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      data.rows.forEach((r, i) => {
        const x = X(r.s), y = Y(r[s.key]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // axis labels
    ctx.fillStyle = '#71717a';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 5; i++) {
      const v = data.axis[0] + ((data.axis[data.axis.length - 1] - data.axis[0]) * i) / 5;
      ctx.fillText(fmtNum(v, v >= 1000 ? 0 : 2), X(v), h - 6);
    }
    ctx.textAlign = 'right';
    ctx.fillText(fmtNum(lo, 1), padL - 4, padT + plotH);
    ctx.fillText(fmtNum(hi, 1), padL - 4, padT + 8);

    // legend
    ctx.textAlign = 'left';
    let lx = padL + 6;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, 6, 8, 2.5);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '9px ui-sans-serif';
      ctx.fillText(s.label, lx + 11, 10);
      lx += ctx.measureText(s.label).width + 34;
    }
  }, [data, market.spot]);

  if (!data) return <EmptyTab text="Add legs to see how Greeks evolve across spot prices." />;

  return (
    <div>
      <div ref={wrapRef} className="w-full">
        <canvas ref={canvasRef} className="w-full" />
      </div>
      <p className="mt-1 text-[9px] leading-relaxed text-zinc-600">
        How the position&apos;s risk changes as spot moves — the second-order view most platforms never show interactively.
        Notice gamma flipping near strikes and vega concentrating around ATM.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CarryBudgetPanel({ analysis }: { analysis: StrategyAnalysis | null }) {
  const carry = analysis?.carry;
  if (!carry) {
    return (
      <EmptyTab
        text="Carry budgets apply to everlasting options and perps — add a perpetual leg to see funding projections and Carry-at-Risk."
        icon={<Flame className="h-5 w-5 text-zinc-700" />}
      />
    );
  }
  const maxScenario = Math.max(...carry.scenarios.map((s) => Math.abs(s.carry7d)), 1);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <StatBox label="Daily carry" value={fmtUsd(carry.dailyCarry, { sign: true })} tone={carry.dailyCarry <= 0 ? 'neg' : 'pos'} />
          <StatBox label="7-day carry" value={fmtUsd(carry.weeklyCarry, { sign: true })} tone={carry.weeklyCarry <= 0 ? 'neg' : 'pos'} />
          <StatBox label="30-day carry" value={fmtUsd(carry.monthlyCarry, { sign: true })} tone={carry.monthlyCarry <= 0 ? 'neg' : 'pos'} />
        </div>
        <div className="rounded-lg border border-amber-500/25 bg-amber-950/10 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-500/90">Funding mechanism</p>
          <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
            Everlasting funding = <span className="font-mono text-amber-300">mark − payoff</span>, paid once per funding period τ.
            Longs pay shorts when the mark exceeds intrinsic — the cost of maintaining convexity without an expiry.
            The position behaves like a dated option with ~2τ effective duration (Paradigm everlasting-options paper, 2021).
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Order type this enables</p>
          <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
            <span className="font-medium text-zinc-300">Max-Carry Order:</span> maintain this exposure only while projected 7-day
            carry stays under your budget; auto-convert to the cheapest dated structure when perpetual carry becomes more expensive.
          </p>
        </div>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Carry-at-Risk — next 7 days</p>
        <div className="mt-3 space-y-3">
          {carry.scenarios.map((s) => (
            <div key={s.label}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[10px] text-zinc-400">{s.label}</span>
                <span className={`font-mono text-xs ${s.carry7d <= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {fmtUsd(Math.abs(s.carry7d))}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full rounded-full ${s.carry7d <= 0 ? 'bg-rose-500/70' : 'bg-emerald-500/70'}`}
                  style={{ width: `${(Math.abs(s.carry7d) / maxScenario) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[9px] leading-relaxed text-zinc-600">
          Like Value-at-Risk, but for the cost of maintaining the position. Funding can explode when IV or utilization spikes —
          a single &ldquo;$15/day&rdquo; estimate is misleading, so the platform always shows the distribution.
        </p>
      </div>
    </div>
  );
}

function StatBox({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-center">
      <p className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold ${tone === 'neg' ? 'text-rose-400' : tone === 'pos' ? 'text-emerald-400' : 'text-zinc-100'}`}>{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function QuotePanel({ legs, underlying, size, disabled }: { legs: Leg[]; underlying: UnderlyingId; size: number; disabled: boolean }) {
  const [quote, setQuote] = useState<RustQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!quote) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [quote]);

  const fetchQuote = async () => {
    setLoading(true);
    setError(null);
    try {
      const q = await engine.quote({ underlying, legs, size });
      setQuote(q);
      setElapsed(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'engine unreachable');
    } finally {
      setLoading(false);
    }
  };

  const expired = quote ? elapsed > quote.quotes[0]?.validSeconds : false;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={fetchQuote}
          disabled={disabled || loading}
          className="h-8 gap-1.5 bg-teal-600 text-xs font-semibold text-zinc-950 hover:bg-teal-500"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
          Request strategy-level RFQ
        </Button>
        {quote && (
          <Badge variant="outline" className="gap-1 border-zinc-700 bg-zinc-900 text-[10px] font-normal text-zinc-400">
            <Timer className="h-3 w-3" />
            {expired ? 'quotes expired' : `${Math.max((quote.quotes[0]?.validSeconds ?? 8) - elapsed, 0)}s validity`}
          </Badge>
        )}
        {quote && (
          <Badge variant="outline" className="border-teal-500/30 bg-teal-950/30 text-[10px] font-normal text-teal-300">
            <CheckCircle2 className="h-3 w-3" /> engine responded in {quote.computeUs}µs
          </Badge>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-rose-500/30 bg-rose-950/20 px-3 py-2 text-[11px] text-rose-300">
          Rust engine unreachable ({error}). Start it with <code className="font-mono">cargo run --release</code> in rust-backend/.
        </p>
      )}

      {!quote && !error && (
        <EmptyTab
          text="Request quotes for the entire package — makers price the strategy, not individual legs. All legs settle atomically or the block is rejected (Paradigm-style)."
          icon={<Radio className="h-5 w-5 text-zinc-700" />}
        />
      )}

      {quote && (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <StatBox label="Theoretical net" value={fmtUsd(quote.theoreticalNet)} />
            <StatBox label="Strategy hash" value={quote.strategyHash.slice(0, 12)} />
            <StatBox label="Settlement" value="Atomic" />
          </div>
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/60 text-[9px] uppercase tracking-wider text-zinc-500">
                  <th className="px-3 py-2 text-left font-medium">Maker</th>
                  <th className="px-3 py-2 text-left font-medium">Venue</th>
                  <th className="px-3 py-2 text-right font-medium">Net package price</th>
                  <th className="px-3 py-2 text-right font-medium">vs theo</th>
                  <th className="px-3 py-2 text-right font-medium">Fee</th>
                </tr>
              </thead>
              <tbody>
                {quote.quotes.map((q, i) => (
                  <tr key={q.maker} className={`border-b border-zinc-800/50 ${i === 0 ? 'bg-teal-950/15' : ''}`}>
                    <td className="px-3 py-2 text-zinc-200">
                      {q.maker}
                      {i === 0 && <Badge className="ml-2 bg-teal-600/20 text-[8px] text-teal-300 hover:bg-teal-600/20">BEST</Badge>}
                    </td>
                    <td className="px-3 py-2 text-zinc-500">{q.venue}</td>
                    <td className="px-3 py-2 text-right font-semibold text-zinc-100">{fmtUsd(q.netPrice)}</td>
                    <td className={`px-3 py-2 text-right ${q.improvementBps >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {q.improvementBps >= 0 ? '+' : ''}{q.improvementBps.toFixed(1)} bps
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-500">{q.feeBps.toFixed(1)} bps</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[9px] leading-relaxed text-zinc-600">
            {quote.settlement}. Quote ID {quote.quoteId}. Makers compete on the packaged payoff — the router&apos;s objective is
            best executable price for the entire structure, including hedge legs, never per-leg optimization.
          </p>
        </div>
      )}
    </div>
  );
}

function EmptyTab({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 p-6 text-center">
      {icon ?? <Grid3x3 className="h-5 w-5 text-zinc-700" />}
      <p className="max-w-md text-[11px] leading-relaxed text-zinc-500">{text}</p>
    </div>
  );
}

export { RefreshCw };

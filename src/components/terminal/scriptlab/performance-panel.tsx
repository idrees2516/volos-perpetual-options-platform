'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — PerformancePanel. The deep analytics for whatever indicator/
// strategy is applied to the chart above. For strategies: the extended metric
// grid (profit factors, streaks, recovery, sortino, buy & hold comparison),
// the equity + drawdown canvas, the trade P&L distribution histogram and the
// monthly returns table. For indicators: readout statistics for every plotted
// series (last / mean / stdev / range / coverage).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gauge, TrendingUp, TrendingDown, Sparkles } from 'lucide-react';
import { useScriptLab } from '@/stores/scriptlab-store';
import type { BacktestResult, ScriptBar } from '@/lib/scriptlang/types';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

function fmtMoney(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

function pct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

// ── equity + drawdown canvas ─────────────────────────────────────────────────

function EquityDrawdown({ equity, initial }: { equity: number[]; initial: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(420);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(260, e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c || equity.length < 2) return;
    const h = 148;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const lo = Math.min(...equity, initial);
    const hi = Math.max(...equity, initial);
    const pad = (hi - lo) * 0.08 || hi * 0.01;
    const dLo = lo - pad;
    const dHi = hi + pad;
    const x = (i: number) => (w * (i + 0.5)) / equity.length;
    const y = (v: number) => ((dHi - v) / (dHi - dLo || 1)) * h;
    // peak series for the drawdown shading
    let peak = -Infinity;
    const peaks = equity.map((e) => (peak = Math.max(peak, e)));
    // drawdown fill between peak and equity
    ctx.fillStyle = 'rgba(251, 113, 133, 0.16)';
    ctx.beginPath();
    ctx.moveTo(x(0), y(peaks[0]));
    for (let i = 0; i < equity.length; i++) ctx.lineTo(x(i), y(peaks[i]));
    for (let i = equity.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(equity[i]));
    ctx.closePath();
    ctx.fill();
    // baseline (initial capital)
    ctx.strokeStyle = 'rgba(113, 113, 122, 0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(initial));
    ctx.lineTo(w, y(initial));
    ctx.stroke();
    ctx.setLineDash([]);
    // equity line
    const up = equity[equity.length - 1] >= initial;
    ctx.strokeStyle = up ? '#2dd4bf' : '#fb7185';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < equity.length; i++) {
      if (!started) {
        ctx.moveTo(x(i), y(equity[i]));
        started = true;
      } else ctx.lineTo(x(i), y(equity[i]));
    }
    ctx.stroke();
    // labels
    ctx.font = '500 8px var(--font-geist-mono), ui-monospace, monospace';
    ctx.fillStyle = '#71717a';
    ctx.textBaseline = 'top';
    ctx.fillText(`peak ${fmtMoney(dHi)}`, 4, 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`trough ${fmtMoney(dLo)}`, 4, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(`final ${fmtMoney(equity[equity.length - 1])}`, w - 4, h - 2);
  }, [equity, initial, w]);

  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <div ref={wrap} className="w-full">
      <canvas ref={canvas} />
    </div>
  );
}

// ── trade P&L distribution histogram ─────────────────────────────────────────

function PnlHistogram({ pcts }: { pcts: number[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(240);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(180, e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c || pcts.length === 0) return;
    const h = 148;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    let lo = Math.min(-1, ...pcts);
    let hi = Math.max(1, ...pcts);
    if (hi - lo < 4) {
      lo -= 2;
      hi += 2;
    }
    const N = 15;
    const bw = (hi - lo) / N;
    const buckets = new Array<number>(N).fill(0);
    for (const p of pcts) buckets[Math.min(N - 1, Math.max(0, Math.floor((p - lo) / bw)))]++;
    const maxC = Math.max(...buckets, 1);
    const chartH = h - 16;
    const barW = (w - 8) / N;
    // zero line
    const zeroX = 4 + ((0 - lo) / (hi - lo)) * (w - 8);
    ctx.strokeStyle = 'rgba(113,113,122,0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(zeroX, 0);
    ctx.lineTo(zeroX, chartH);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let i = 0; i < N; i++) {
      const mid = lo + (i + 0.5) * bw;
      const bh = (buckets[i] / maxC) * chartH;
      ctx.fillStyle = mid >= 0 ? 'rgba(45, 212, 191, 0.75)' : 'rgba(251, 113, 133, 0.75)';
      ctx.fillRect(4 + i * barW, chartH - bh, Math.max(1, barW - 1.5), bh);
    }
    // axis labels
    ctx.font = '500 8px var(--font-geist-mono), ui-monospace, monospace';
    ctx.fillStyle = '#71717a';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(pct(lo), 2, chartH + 2);
    ctx.textAlign = 'right';
    ctx.fillText(pct(hi), w - 2, chartH + 2);
    ctx.textAlign = 'center';
    ctx.fillText('0', zeroX, chartH + 2);
  }, [pcts, w]);

  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <div ref={wrap} className="w-full">
      <canvas ref={canvas} />
    </div>
  );
}

// ── derived statistics ────────────────────────────────────────────────────────

interface Derived {
  grossProfit: number;
  grossLoss: number;
  avgWin: number;
  avgLoss: number;
  payoff: number;
  maxWinStreak: number;
  maxLossStreak: number;
  maxDDAmount: number;
  recovery: number;
  sortino: number;
  buyHoldPct: number;
  months: Array<{ label: string; pnl: number; trades: number; wins: number }>;
}

function deriveStats(bt: BacktestResult, bars: ScriptBar[] | null): Derived {
  const wins = bt.trades.filter((t) => t.pnl >= 0);
  const losses = bt.trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  // streaks
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let cur = 0;
  for (const t of bt.trades) {
    if (t.pnl >= 0) cur = cur > 0 ? cur + 1 : 1;
    else cur = cur < 0 ? cur - 1 : -1;
    maxWinStreak = Math.max(maxWinStreak, cur);
    maxLossStreak = Math.min(maxLossStreak, cur);
  }
  maxLossStreak = Math.abs(maxLossStreak);
  // drawdown amount + per-bar sortino
  let peak = -Infinity;
  let maxDDAmount = 0;
  for (const e of bt.equity) {
    peak = Math.max(peak, e);
    maxDDAmount = Math.max(maxDDAmount, peak - e);
  }
  const rets: number[] = [];
  for (let i = 1; i < bt.equity.length; i++) rets.push(bt.equity[i] / bt.equity[i - 1] - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const downside = rets.filter((r) => r < 0);
  const dsDev = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / (downside.length || 1));
  const sortino = dsDev > 0 ? mean / dsDev : 0;
  // buy & hold over the same window
  const buyHoldPct = bars && bars.length > 1 ? (bars[bars.length - 1].c / bars[0].c - 1) * 100 : 0;
  // monthly buckets (entry month of each trade)
  const monthMap = new Map<string, { pnl: number; trades: number; wins: number; order: number }>();
  for (const t of bt.trades) {
    const ts = bars?.[t.entryIdx]?.ts;
    if (!ts) continue;
    const d = new Date(ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const m = monthMap.get(key) ?? { pnl: 0, trades: 0, wins: 0, order: d.getUTCFullYear() * 12 + d.getUTCMonth() };
    m.pnl += t.pnl;
    m.trades += 1;
    if (t.pnl >= 0) m.wins += 1;
    monthMap.set(key, m);
  }
  const months = [...monthMap.entries()]
    .sort((a, b) => b[1].order - a[1].order)
    .slice(0, 12)
    .map(([k, m]) => {
      const [y, mo] = k.split('-');
      const label = new Date(Number(y), Number(mo) - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      return { label, pnl: m.pnl, trades: m.trades, wins: m.wins };
    });
  return {
    grossProfit,
    grossLoss,
    avgWin,
    avgLoss,
    payoff: avgLoss > 0 ? avgWin / avgLoss : 0,
    maxWinStreak,
    maxLossStreak,
    maxDDAmount,
    recovery: maxDDAmount > 0 ? bt.stats.netProfit / maxDDAmount : 0,
    sortino,
    buyHoldPct,
    months,
  };
}

// ── indicator readout stats (when an indicator is applied, not a strategy) ──

function plotStats(data: number[]): { last: number; mean: number; stdev: number; min: number; max: number; coverage: number } {
  const fin = data.filter((v) => Number.isFinite(v));
  if (!fin.length) return { last: NaN, mean: NaN, stdev: NaN, min: NaN, max: NaN, coverage: 0 };
  const mean = fin.reduce((a, b) => a + b, 0) / fin.length;
  const stdev = Math.sqrt(fin.reduce((a, b) => a + (b - mean) ** 2, 0) / fin.length);
  return {
    last: fin[fin.length - 1],
    mean,
    stdev,
    min: Math.min(...fin),
    max: Math.max(...fin),
    coverage: (fin.length / (data.length || 1)) * 100,
  };
}

// ── the panel ────────────────────────────────────────────────────────────────

export function PerformancePanel() {
  const { result, bars, symbol, tf } = useScriptLab();

  const bt = result?.ok && result.kind === 'strategy' ? result.backtest : null;
  const derived = useMemo(() => (bt ? deriveStats(bt, bars) : null), [bt, bars]);

  if (!result || !result.ok) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
        <Gauge className="h-5 w-5 opacity-60" />
        <p className="text-[11px]">performance analytics</p>
        <p className="max-w-[260px] text-center text-[9px] leading-relaxed text-zinc-700">
          apply an indicator or strategy to the chart above — readout statistics arrive here for indicators, the full
          performance lab (equity, drawdown, distributions, monthly returns) for strategies.
        </p>
      </div>
    );
  }

  // ── indicator: readout statistics for every plotted series ─────────────────
  if (!bt) {
    const stats = result.plots.map((p) => ({ title: p.title, color: p.color, style: p.style, s: plotStats(p.data) }));
    const first = bars?.[0];
    const last = bars?.[bars.length - 1];
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2.5">
        <div className="flex flex-wrap items-center gap-2 text-[9px] text-zinc-500">
          <span className="rounded-full bg-teal-950/60 px-2 py-0.5 font-bold uppercase tracking-wider text-teal-300 ring-1 ring-teal-500/30">
            indicator readout
          </span>
          <span className="font-mono">
            {symbol} · {tf} · {bars?.length ?? 0} bars
            {first && last ? ` · ${new Date(first.ts).toISOString().slice(0, 10)} → ${new Date(last.ts).toISOString().slice(0, 10)}` : ''}
          </span>
          <span className="ml-auto hidden items-center gap-1 text-zinc-600 md:flex">
            <Sparkles className="h-2.5 w-2.5 text-violet-400" />
            ask the AI desk (Pine Editor tab) to turn any readout into a strategy()
          </span>
        </div>
        <ScrollArea className="min-h-0 flex-1 rounded-md border border-zinc-800/80">
          <table className="w-full border-collapse text-left font-mono text-[9.5px]">
            <thead className="sticky top-0 bg-zinc-950/95 text-[7.5px] uppercase tracking-wider text-zinc-600">
              <tr>
                <th className="px-2 py-1.5">plot</th>
                <th className="px-2 py-1.5">style</th>
                <th className="px-2 py-1.5 text-right">last</th>
                <th className="px-2 py-1.5 text-right">mean</th>
                <th className="px-2 py-1.5 text-right">stdev</th>
                <th className="px-2 py-1.5 text-right">min</th>
                <th className="px-2 py-1.5 text-right">max</th>
                <th className="px-2 py-1.5 text-right">coverage</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s, i) => (
                <tr key={i} className="border-t border-zinc-800/60 hover:bg-zinc-900/40">
                  <td className="px-2 py-1.5 text-zinc-300">
                    <span className="mr-1.5 inline-block h-[3px] w-2.5 rounded align-middle" style={{ background: s.color }} />
                    {s.title}
                  </td>
                  <td className="px-2 py-1.5 text-zinc-600">{s.style}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-100">{Number.isFinite(s.s.last) ? s.s.last.toFixed(2) : '—'}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-400">{Number.isFinite(s.s.mean) ? s.s.mean.toFixed(2) : '—'}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-400">{Number.isFinite(s.s.stdev) ? s.s.stdev.toFixed(2) : '—'}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-500">{Number.isFinite(s.s.min) ? s.s.min.toFixed(2) : '—'}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-500">{Number.isFinite(s.s.max) ? s.s.max.toFixed(2) : '—'}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-500">{s.s.coverage.toFixed(0)}%</td>
                </tr>
              ))}
              {stats.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-2 py-3 text-center text-zinc-600">
                    this script plots nothing — add plot() / plotshape() calls
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    );
  }

  if (!derived) return null;
  const s = bt.stats;
  const vsHold = s.netProfitPct - derived.buyHoldPct;

  const metric = (label: string, value: string, tone?: 'up' | 'down') => (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-950/50 px-2 py-1.5">
      <p className="text-[7.5px] font-bold uppercase tracking-[0.14em] text-zinc-600">{label}</p>
      <p className={`font-mono text-[12px] font-semibold ${tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-rose-400' : 'text-zinc-200'}`}>
        {value}
      </p>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2.5">
      {/* header */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-[9px] text-zinc-500">
        <span className="rounded-full bg-violet-950/60 px-2 py-0.5 font-bold uppercase tracking-wider text-violet-300 ring-1 ring-violet-500/30">
          strategy performance
        </span>
        <span className="font-mono">
          {symbol} · {tf} · {bars?.length ?? 0} bars · initial {fmtMoney(s.initialCapital)}
        </span>
        <span className={`ml-auto font-mono font-bold ${s.netProfitPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {s.netProfitPct >= 0 ? <TrendingUp className="inline h-2.5 w-2.5" /> : <TrendingDown className="inline h-2.5 w-2.5" />} {pct(s.netProfitPct)}
        </span>
      </div>

      {/* metrics — the extended grid */}
      <div className="grid shrink-0 grid-cols-4 gap-1.5 md:grid-cols-8">
        {metric('net profit', pct(s.netProfitPct), s.netProfitPct >= 0 ? 'up' : 'down')}
        {metric('final equity', fmtMoney(s.finalEquity))}
        {metric('vs buy & hold', `${vsHold >= 0 ? '+' : ''}${vsHold.toFixed(1)}pp`, vsHold >= 0 ? 'up' : 'down')}
        {metric('buy & hold', pct(derived.buyHoldPct), derived.buyHoldPct >= 0 ? 'up' : 'down')}
        {metric('trades', String(s.trades))}
        {metric('win rate', `${s.winRate.toFixed(1)}%`)}
        {metric('profit factor', s.profitFactor >= 99 ? '∞' : s.profitFactor.toFixed(2))}
        {metric('expectancy', pct(s.expectancyPct))}
        {metric('max drawdown', `-${s.maxDrawdownPct.toFixed(1)}%`, 'down')}
        {metric('dd amount', `-${fmtMoney(derived.maxDDAmount)}`, 'down')}
        {metric('sharpe', s.sharpe.toFixed(2))}
        {metric('sortino (bar)', derived.sortino.toFixed(2))}
        {metric('recovery', derived.recovery.toFixed(2))}
        {metric('payoff (w/l)', derived.payoff.toFixed(2))}
        {metric('avg win / loss', `${fmtMoney(derived.avgWin)} / -${fmtMoney(derived.avgLoss)}`)}
        {metric('streaks w/l', `${derived.maxWinStreak} / ${derived.maxLossStreak}`)}
      </div>

      {/* charts row: equity+drawdown · P&L distribution */}
      <div className="flex min-h-[164px] shrink-0 flex-col gap-2 overflow-hidden lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col rounded-md border border-zinc-800/80 bg-[#07090d] p-1">
          <p className="px-1 pt-0.5 text-[7.5px] font-bold uppercase tracking-[0.14em] text-zinc-600">
            equity curve · drawdown shading
          </p>
          <EquityDrawdown equity={bt.equity} initial={s.initialCapital} />
        </div>
        <div className="flex w-full shrink-0 flex-col rounded-md border border-zinc-800/80 bg-[#07090d] p-1 lg:w-[300px]">
          <p className="px-1 pt-0.5 text-[7.5px] font-bold uppercase tracking-[0.14em] text-zinc-600">
            trade P&amp;L distribution
          </p>
          <PnlHistogram pcts={bt.trades.map((t) => t.pnlPct)} />
          <p className="px-1 pb-0.5 font-mono text-[8px] text-zinc-600">
            {bt.trades.length} closed trades · best {pct(s.bestTradePct)} · worst {pct(s.worstTradePct)}
          </p>
        </div>
      </div>

      {/* bottom row: monthly returns · gross flow */}
      <div className="flex min-h-[140px] shrink-0 flex-col gap-2 overflow-hidden lg:flex-row">
        <ScrollArea className="min-h-0 flex-1 rounded-md border border-zinc-800/80">
          <p className="sticky top-0 bg-zinc-950/95 px-2 py-1 text-[7.5px] font-bold uppercase tracking-[0.14em] text-zinc-600">
            monthly returns (entry month)
          </p>
          <table className="w-full border-collapse text-left font-mono text-[9px]">
            <thead className="sticky top-[17px] bg-zinc-950/95 text-[7.5px] uppercase tracking-wider text-zinc-600">
              <tr>
                <th className="px-2 py-1">month</th>
                <th className="px-2 py-1 text-right">net pnl</th>
                <th className="px-2 py-1 text-right">trades</th>
                <th className="px-2 py-1 text-right">win rate</th>
              </tr>
            </thead>
            <tbody>
              {derived.months.map((m) => (
                <tr key={m.label} className="border-t border-zinc-800/60 hover:bg-zinc-900/40">
                  <td className="px-2 py-1 text-zinc-300">{m.label}</td>
                  <td className={`px-2 py-1 text-right font-bold ${m.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {fmtMoney(m.pnl)}
                  </td>
                  <td className="px-2 py-1 text-right text-zinc-500">{m.trades}</td>
                  <td className="px-2 py-1 text-right text-zinc-500">
                    {m.trades ? `${((m.wins / m.trades) * 100).toFixed(0)}%` : '—'}
                  </td>
                </tr>
              ))}
              {derived.months.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-2 py-3 text-center text-zinc-600">
                    no closed trades in this window
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollArea>
        <div className="grid w-full shrink-0 grid-cols-2 gap-1.5 lg:w-[300px] lg:grid-cols-1">
          {metric('gross profit', fmtMoney(derived.grossProfit), 'up')}
          {metric('gross loss', `-${fmtMoney(derived.grossLoss)}`, 'down')}
          {metric('avg hold', `${s.avgHoldBars.toFixed(0)} bars`)}
          {metric('exposure', `${s.exposurePct.toFixed(0)}%`)}
        </div>
      </div>
    </div>
  );
}

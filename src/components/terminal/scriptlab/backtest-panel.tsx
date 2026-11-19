'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — BacktestPanel. Strategy results: metric cards, equity curve
// (canvas, drawdown-tinted), the trade list with exit reasons, and the
// append-only run history from /api/scriptlab/runs.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlaskConical, TrendingUp, TrendingDown } from 'lucide-react';
import { useScriptLab } from '@/stores/scriptlab-store';
import type { StrategyStats } from '@/lib/scriptlang/types';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

interface RunRow {
  id: string;
  scriptName: string;
  symbol: string;
  tf: string;
  bars: number;
  metrics: StrategyStats;
  createdAt: string;
}

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

/** small equity-curve canvas */
function EquityCurve({ equity, initial }: { equity: number[]; initial: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(300);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(220, e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c || equity.length < 2) return;
    const h = 120;
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
    // baseline (initial capital)
    ctx.strokeStyle = 'rgba(113, 113, 122, 0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(initial));
    ctx.lineTo(w, y(initial));
    ctx.stroke();
    ctx.setLineDash([]);
    // drawdown tint
    let peak = -Infinity;
    const peaks = equity.map((e) => (peak = Math.max(peak, e)));
    ctx.fillStyle = 'rgba(251, 113, 133, 0.10)';
    ctx.beginPath();
    ctx.moveTo(x(0), y(peaks[0]));
    for (let i = 0; i < equity.length; i++) ctx.lineTo(x(i), y(peaks[i]));
    for (let i = equity.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(equity[i]));
    ctx.closePath();
    ctx.fill();
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

export function BacktestPanel() {
  const { result } = useScriptLab();
  const [runs, setRuns] = useState<RunRow[]>([]);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/scriptlab/runs?limit=8');
      const j = (await res.json()) as { ok?: boolean; data?: RunRow[] };
      if (j.ok && j.data) setRuns(j.data);
    } catch {
      /* offline-tolerant */
    }
  }, []);

  useEffect(() => {
    // deferred (timer callback) so state updates stay outside the effect body
    const t = setTimeout(() => void loadRuns(), 250);
    return () => clearTimeout(t);
  }, [loadRuns, result]);

  const bt = result?.ok ? result.backtest : null;

  if (!result || result.ok !== true || result.kind !== 'strategy') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
        <FlaskConical className="h-5 w-5 opacity-60" />
        <p className="text-[11px]">backtest panel</p>
        <p className="max-w-[240px] text-center text-[9px] leading-relaxed text-zinc-700">
          run a <span className="text-violet-300">strategy()</span> script and the equity curve, trade list and
          stats appear here — orders fill at the next bar open, stops/limits intrabar, commission honored.
        </p>
      </div>
    );
  }

  if (!bt) {
    return (
      <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">
        strategy declared — no orders produced (add strategy.entry signals)
      </div>
    );
  }

  const s = bt.stats;
  const metric = (label: string, value: string, tone?: 'up' | 'down') => (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-950/50 px-2 py-1.5">
      <p className="text-[7.5px] font-bold uppercase tracking-[0.14em] text-zinc-600">{label}</p>
      <p className={`font-mono text-[12px] font-semibold ${tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-rose-400' : 'text-zinc-200'}`}>
        {value}
      </p>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2.5">
      {/* metrics */}
      <div className="grid shrink-0 grid-cols-4 gap-1.5 md:grid-cols-6">
        {metric('net profit', pct(s.netProfitPct), s.netProfitPct >= 0 ? 'up' : 'down')}
        {metric('final equity', fmtMoney(s.finalEquity))}
        {metric('trades', String(s.trades))}
        {metric('win rate', `${s.winRate.toFixed(1)}%`)}
        {metric('profit factor', s.profitFactor >= 99 ? '∞' : s.profitFactor.toFixed(2))}
        {metric('max drawdown', `-${s.maxDrawdownPct.toFixed(1)}%`, 'down')}
        {metric('sharpe', s.sharpe.toFixed(2))}
        {metric('avg hold', `${s.avgHoldBars.toFixed(0)} bars`)}
        {metric('expectancy', pct(s.expectancyPct))}
        {metric('exposure', `${s.exposurePct.toFixed(0)}%`)}
        {metric('best trade', pct(s.bestTradePct), 'up')}
        {metric('worst trade', pct(s.worstTradePct), 'down')}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        {/* equity */}
        <div className="shrink-0 rounded-md border border-zinc-800/80 bg-[#07090d] p-1">
          <EquityCurve equity={bt.equity} initial={s.initialCapital} />
        </div>

        {/* trades */}
        <ScrollArea className="min-h-0 flex-1 rounded-md border border-zinc-800/80">
          <table className="w-full border-collapse text-left font-mono text-[9px]">
            <thead className="sticky top-0 bg-zinc-950/95 text-[7.5px] uppercase tracking-wider text-zinc-600">
              <tr>
                <th className="px-2 py-1.5">#</th>
                <th className="px-2 py-1.5">side</th>
                <th className="px-2 py-1.5">entry</th>
                <th className="px-2 py-1.5">exit</th>
                <th className="px-2 py-1.5">reason</th>
                <th className="px-2 py-1.5 text-right">bars</th>
                <th className="px-2 py-1.5 text-right">pnl</th>
              </tr>
            </thead>
            <tbody>
              {bt.trades.map((t) => (
                <tr key={t.id} className="border-t border-zinc-800/60 hover:bg-zinc-900/40">
                  <td className="px-2 py-1 text-zinc-500">{t.id}</td>
                  <td className={`px-2 py-1 font-bold ${t.side === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {t.side === 'long' ? <TrendingUp className="inline h-2.5 w-2.5" /> : <TrendingDown className="inline h-2.5 w-2.5" />} {t.side}
                  </td>
                  <td className="px-2 py-1 text-zinc-300">
                    {t.entryPrice.toFixed(1)} <span className="text-zinc-600">@{t.entryIdx}</span>
                  </td>
                  <td className="px-2 py-1 text-zinc-300">
                    {t.exitPrice.toFixed(1)} <span className="text-zinc-600">@{t.exitIdx}</span>
                  </td>
                  <td className="px-2 py-1">
                    <span
                      className={`rounded px-1 py-px text-[7.5px] font-bold uppercase ${
                        t.reason === 'stop'
                          ? 'bg-rose-950/60 text-rose-300'
                          : t.reason === 'limit'
                            ? 'bg-emerald-950/60 text-emerald-300'
                            : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {t.reason}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right text-zinc-500">{t.bars}</td>
                  <td className={`px-2 py-1 text-right font-bold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {pct(t.pnlPct)}
                  </td>
                </tr>
              ))}
              {bt.trades.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-2 py-3 text-center text-zinc-600">
                    no fills — signals never fired on this window
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>

        {/* run history */}
        {runs.length > 0 && (
          <div className="shrink-0 rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2 py-1">
            <p className="text-[7.5px] font-bold uppercase tracking-[0.14em] text-zinc-600">run history (auto-logged)</p>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[8.5px] text-zinc-500">
              {runs.map((r) => (
                <span key={r.id} className="flex items-center gap-1">
                  <span className="text-zinc-300">{r.scriptName}</span>
                  <span className="text-zinc-600">{r.symbol}/{r.tf}</span>
                  <span className={r.metrics?.netProfitPct >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                    {pct(r.metrics?.netProfitPct ?? 0)}
                  </span>
                  <span className="text-zinc-700">{new Date(r.createdAt).toISOString().slice(5, 16).replace('T', ' ')}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

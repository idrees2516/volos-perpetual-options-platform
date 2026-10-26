'use client';

// Backtest tab — how THIS strategy has actually performed in the past.
//
// Runs the catalog spec through the real-history backtest engine:
//   • Bybit spot klines (public, real) for the underlying path
//   • live Deribit IV calibration for the vol surface per cycle
//   • legs re-struck at every cycle's entry spot, BS daily mark-to-market,
//     settled at intrinsic on expiry, fees + slippage per leg
// and renders the full record: equity curve, stats, sample trades, the
// vol model and every assumption that produced the numbers.

import React from 'react';
import { History, Play, Loader2, TriangleAlert, Database, Info } from 'lucide-react';
import type { StrategySpec } from '@/lib/strategies';
import type { UnderlyingId } from '@/lib/types';
import { fmtNum, fmtUsd } from '@/lib/format';
import type { BacktestLegSpec, BacktestResult } from '@/lib/ai/backtest';

interface BacktestProps {
  spec: StrategySpec;
  underlying: UnderlyingId;
}

interface PreparedLegs {
  legs: BacktestLegSpec[];
  notes: string[];
  maxExpiry: number;
}

/** Catalog spec legs → backtest leg specs (strike = multiplier of entry spot). */
function prepareLegs(spec: StrategySpec): PreparedLegs {
  const legs: BacktestLegSpec[] = [];
  const notes: string[] = [];
  let everlasting = 0;
  let hedge = 0;

  for (const l of spec.legs) {
    if (l.kind === 'call' || l.kind === 'put') {
      legs.push({
        kind: l.kind,
        side: l.side,
        qty: l.qty,
        strike: l.strike ?? 1,
        expiryDays: Math.max(1, l.expiryDays ?? 30),
      });
    } else if (l.kind === 'perp_option') {
      everlasting += 1;
      // an everlasting option ≈ a dated option re-struck & rolled every funding period
      legs.push({
        kind: (l.strike ?? 1) >= 1 ? 'call' : 'put',
        side: l.side,
        qty: l.qty,
        strike: l.strike ?? 1,
        expiryDays: Math.max(1, l.fundingPeriodDays ?? 7),
      });
    } else {
      hedge += 1; // perp / spot hedge legs
    }
  }
  if (everlasting > 0) {
    notes.push(`${everlasting} everlasting leg${everlasting > 1 ? 's' : ''} modeled as dated option${everlasting > 1 ? 's' : ''} rolled every funding period — the standard dated-venue replication.`);
  }
  if (hedge > 0) {
    notes.push(`${hedge} perpetual/spot hedge leg${hedge > 1 ? 's' : ''} excluded — option P&L only (hedges are delta-neutral overlays).`);
  }
  const maxExpiry = legs.length ? Math.max(...legs.map((l) => l.expiryDays)) : 0;
  return { legs, notes, maxExpiry };
}

const WINDOWS = [90, 180, 365, 730];

// ── equity curve (self-contained SVG) ───────────────────────────────────────

function EquityCurve({ data, height = 170 }: { data: { t: number; v: number }[]; height?: number }) {
  if (data.length < 2) return null;
  const W = 900;
  const H = height;
  const pad = { l: 6, r: 6, t: 10, b: 14 };
  const xs = data.map((d) => d.t);
  const vs = data.map((d) => d.v);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, ...vs);
  const maxY = Math.max(...vs, minY + 1e-9);
  const x = (t: number) => pad.l + ((t - minX) / (maxX - minX || 1)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - ((v - minY) / (maxY - minY || 1)) * (H - pad.t - pad.b);

  const zeroY = y(0);
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(maxX).toFixed(1)},${zeroY.toFixed(1)} L${x(minX).toFixed(1)},${zeroY.toFixed(1)} Z`;
  const positive = vs[vs.length - 1] >= 0;
  const stroke = positive ? '#2dd4bf' : '#fb7185';
  const fill = positive ? 'rgba(45,212,191,0.10)' : 'rgba(251,113,133,0.10)';

  const start = new Date(minX).toISOString().slice(0, 10);
  const end = new Date(maxX).toISOString().slice(0, 10);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" preserveAspectRatio="none">
      <line x1={pad.l} y1={zeroY} x2={W - pad.r} y2={zeroY} stroke="#3f3f46" strokeWidth={0.7} strokeDasharray="3 3" />
      <path d={area} fill={fill} />
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" />
      <text x={pad.l + 2} y={11} fill="#71717a" fontSize={9} fontFamily="monospace">{start} → {end} · peak {fmtUsd(maxV, { compact: true })} · trough {fmtUsd(minV, { compact: true })}</text>
    </svg>
  );
}

// ── stats grid ──────────────────────────────────────────────────────────────

function Stat({ label, value, tone = 'default', hint }: { label: string; value: string; tone?: 'default' | 'up' | 'down'; hint?: string }) {
  const color = tone === 'up' ? 'text-emerald-300' : tone === 'down' ? 'text-rose-300' : 'text-zinc-100';
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-2 py-1.5">
      <p className="text-[7.5px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`font-mono text-[13px] font-semibold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[7px] leading-tight text-zinc-600">{hint}</p>}
    </div>
  );
}

// ── the tab ─────────────────────────────────────────────────────────────────

export function StrategyBacktest({ spec, underlying }: BacktestProps) {
  const prepared = React.useMemo(() => prepareLegs(spec), [spec]);
  const [windowDays, setWindowDays] = React.useState(365);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BacktestResult | null>(null);
  const [ranFor, setRanFor] = React.useState<string | null>(null);

  const canRun = prepared.legs.length > 0;

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/strategies/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset: underlying,
          strategyName: spec.name,
          windowDays,
          legs: prepared.legs,
        }),
      });
      const json = (await res.json()) as BacktestResult | { error: string };
      if (!res.ok || 'error' in json) {
        throw new Error('error' in json ? json.error : `backtest failed (${res.status})`);
      }
      setResult(json);
      setRanFor(`${underlying} · ${windowDays}d`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'backtest failed');
    } finally {
      setRunning(false);
    }
  }

  const s = result?.stats;

  return (
    <div className="space-y-3">
      {/* header / controls */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-teal-400" />
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-200">
                {spec.name} — historical performance
              </h3>
              <p className="text-[9px] text-zinc-500">
                real exchange history · {prepared.legs.length} option legs · cycle length {prepared.maxExpiry}d
                {result ? ` · ${result.stats.cycles} completed cycles on ${ranFor}` : ''}
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-zinc-700">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  onClick={() => setWindowDays(w)}
                  disabled={running}
                  className={`px-2 py-1 font-mono text-[9px] transition ${
                    windowDays === w ? 'bg-teal-500 font-semibold text-zinc-950' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  {w}d
                </button>
              ))}
            </div>
            <button
              onClick={run}
              disabled={!canRun || running}
              className="flex items-center gap-1.5 rounded-md bg-teal-500 px-3 py-1.5 text-[10px] font-semibold text-zinc-950 transition hover:bg-teal-400 disabled:opacity-50"
            >
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {running ? 'Running…' : 'Run Backtest'}
            </button>
          </div>
        </div>
        {prepared.notes.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {prepared.notes.map((n, i) => (
              <p key={i} className="flex items-start gap-1 text-[8.5px] leading-relaxed text-zinc-500">
                <Info className="mt-0.5 h-2.5 w-2.5 shrink-0 text-zinc-600" /> {n}
              </p>
            ))}
          </div>
        )}
      </section>

      {!canRun && (
        <section className="rounded-lg border border-amber-500/25 bg-amber-950/20 p-3">
          <p className="flex items-center gap-1.5 text-[10px] font-medium text-amber-200">
            <TriangleAlert className="h-3.5 w-3.5" /> No backtestable option legs in this strategy.
          </p>
          <p className="mt-1 text-[9px] text-amber-200/70">
            This structure is built from perpetual/spot instruments only — there is no option payoff to test against history.
          </p>
        </section>
      )}

      {error && (
        <section className="rounded-lg border border-rose-500/25 bg-rose-950/20 p-3">
          <p className="flex items-center gap-1.5 text-[10px] font-medium text-rose-200">
            <TriangleAlert className="h-3.5 w-3.5" /> Backtest failed
          </p>
          <p className="mt-1 font-mono text-[9px] text-rose-200/70">{error}</p>
          <p className="mt-1 text-[8.5px] text-rose-200/60">
            The engine pulls real klines from Bybit — if the feed is unreachable from this network, retry in a moment.
          </p>
        </section>
      )}

      {result && s && (
        <>
          {/* stats grid */}
          <section className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-6">
            <Stat label="total P&L" value={fmtUsd(s.totalPnl, { sign: true })} tone={s.totalPnl >= 0 ? 'up' : 'down'} hint={`${fmtNum(s.cycles, 0)} cycles`} />
            <Stat label="return on risk" value={`${fmtNum(s.returnPct, 1)}%`} tone={s.returnPct >= 0 ? 'up' : 'down'} hint={`CAGR ${fmtNum(s.cagrPct, 1)}%`} />
            <Stat label="win rate" value={`${fmtNum(s.winRate, 1)}%`} hint={`avg win ${fmtUsd(s.avgWin)} · loss ${fmtUsd(s.avgLoss)}`} />
            <Stat label="profit factor" value={fmtNum(s.profitFactor, 2)} tone={s.profitFactor >= 1 ? 'up' : 'down'} hint={`expectancy ${fmtUsd(s.expectancy, { sign: true })}/cycle`} />
            <Stat label="max drawdown" value={`${fmtNum(s.maxDrawdownPct, 1)}%`} tone="down" hint={`worst cycle ${fmtUsd(s.worstTrade)}`} />
            <Stat label="sharpe · sortino" value={`${fmtNum(s.sharpe, 2)} · ${fmtNum(s.sortino, 2)}`} hint={`avg hold ${s.avgHoldDays}d`} />
          </section>

          {/* equity curve */}
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">Cumulative P&L curve</h4>
              <span className="font-mono text-[8.5px] text-zinc-500">
                {result.asset} · {result.windowDays}d window · cycle = {prepared.maxExpiry}d hold · capital base = worst-case loss
              </span>
              <span className="ml-auto flex items-center gap-1 text-[8px] text-zinc-500">
                <Database className="h-2.5 w-2.5" /> {result.dataSource}
              </span>
            </div>
            <EquityCurve data={result.equityCurve} />
          </section>

          {/* vol model + recent trades */}
          <section className="grid gap-2 lg:grid-cols-5">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 lg:col-span-2">
              <h4 className="text-[9.5px] font-semibold uppercase tracking-wider text-zinc-300">Vol model</h4>
              <div className="mt-1.5 space-y-1 font-mono text-[9px] tabular-nums text-zinc-400">
                <p>calibration factor <span className="text-zinc-200">{fmtNum(result.volModel.calibrationFactor, 2)}×</span></p>
                <p>avg entry IV <span className="text-zinc-200">{fmtNum(result.volModel.avgEntryIv, 1)}%</span></p>
                <p>live ATM IV now <span className="text-zinc-200">{fmtNum(result.volModel.liveAtmIv, 1)}%</span></p>
              </div>
              <h4 className="mt-2.5 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-300">Assumptions</h4>
              <ul className="mt-1 space-y-1">
                {result.assumptions.map((a, i) => (
                  <li key={i} className="text-[8px] leading-relaxed text-zinc-500">› {a}</li>
                ))}
              </ul>
            </div>
            <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 lg:col-span-3">
              <h4 className="px-2.5 pt-2 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-300">Recent cycles (most recent first)</h4>
              <table className="mt-1 w-full font-mono text-[8.5px] tabular-nums">
                <thead>
                  <tr className="border-b border-zinc-800 text-left text-zinc-500">
                    <th className="px-2 py-1 font-normal">#</th>
                    <th className="px-1 py-1 font-normal">entry</th>
                    <th className="px-1 py-1 font-normal">exit</th>
                    <th className="px-1 py-1 font-normal">spot in→out</th>
                    <th className="px-1 py-1 font-normal">debit/credit</th>
                    <th className="px-1 py-1 font-normal">P&L</th>
                    <th className="px-2 py-1 font-normal">R</th>
                  </tr>
                </thead>
                <tbody>
                  {result.sampleTrades.map((t) => (
                    <tr key={t.cycle} className="border-b border-zinc-800/50">
                      <td className="px-2 py-1 text-zinc-500">{t.cycle}</td>
                      <td className="px-1 py-1 text-zinc-400">{t.entryDate.slice(5)}</td>
                      <td className="px-1 py-1 text-zinc-400">{t.exitDate.slice(5)}</td>
                      <td className="px-1 py-1 text-zinc-400">{fmtNum(t.entrySpot, 0)}→{fmtNum(t.exitSpot, 0)}</td>
                      <td className={`px-1 py-1 ${t.entryDebit > 0 ? 'text-amber-300' : 'text-teal-300'}`}>{fmtUsd(t.entryDebit, { compact: true })}</td>
                      <td className={`px-1 py-1 font-semibold ${t.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtUsd(t.pnl, { sign: true })}</td>
                      <td className={`px-2 py-1 ${t.rMultiple != null && t.rMultiple >= 0 ? 'text-emerald-300/80' : 'text-rose-300/80'}`}>
                        {t.rMultiple != null ? `${t.rMultiple > 0 ? '+' : ''}${fmtNum(t.rMultiple, 2)}R` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="text-[8px] leading-relaxed text-zinc-600">
            Backtests re-strike the structure at every cycle&apos;s entry spot on real daily closes — the strikes you see above
            (as % moneyness) are applied to each historical price level, then priced with Black-Scholes on a realized-vol
            surface calibrated to today&apos;s live Deribit IV, marked daily and settled at intrinsic. Past performance of a
            replication is indicative, not a guarantee; execution costs are modeled ({result.assumptions[1] ?? ''}).
          </p>
        </>
      )}
    </div>
  );
}

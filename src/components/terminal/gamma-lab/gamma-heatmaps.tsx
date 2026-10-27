'use client';

// ─────────────────────────────────────────────────────────────────────────────
// GAMMA LAB — Heatmaps tab: strike-by-strike grids across expiries for
// GEX / VEX / IV / OI / volume, with call/put split and intensity legends.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { Grid3x3 } from 'lucide-react';
import type { GammaProfile } from '@/lib/gamma-flow';
import { fmtNum } from '@/lib/format';

type HeatMetric = 'gex' | 'vex' | 'iv' | 'oi' | 'volume';

const METRICS: { id: HeatMetric; label: string; desc: string; unit: string; signed: boolean }[] = [
  { id: 'gex', label: 'GEX', desc: 'net dealer gamma exposure', unit: '$/1%', signed: true },
  { id: 'vex', label: 'VEX', desc: 'net dealer vanna exposure', unit: '$/vol-pt', signed: true },
  { id: 'iv', label: 'IV', desc: 'implied volatility', unit: '%', signed: false },
  { id: 'oi', label: 'Open Interest', desc: 'contracts open', unit: 'ct', signed: false },
  { id: 'volume', label: 'Volume', desc: 'contracts traded today', unit: 'ct', signed: false },
];

/** color scale: signed (teal↔rose) or magnitude (zinc→teal) */
function heatColor(v: number, max: number, signed: boolean): string {
  if (max <= 0) return 'rgba(39,39,42,0.3)';
  const f = Math.min(Math.abs(v) / max, 1);
  if (!signed) {
    // zinc → teal intensity
    const a = 0.12 + f * 0.78;
    return `rgba(45,212,191,${a.toFixed(3)})`;
  }
  const a = 0.14 + f * 0.8;
  return v >= 0 ? `rgba(16,185,129,${a.toFixed(3)})` : `rgba(244,63,94,${a.toFixed(3)})`;
}

function fmtHeat(v: number, metric: HeatMetric): string {
  switch (metric) {
    case 'gex':
    case 'vex': {
      const a = Math.abs(v);
      if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
      if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
      if (a >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
      return v.toFixed(0);
    }
    case 'iv':
      return (v * 100).toFixed(1);
    case 'oi':
    case 'volume': {
      const a = Math.abs(v);
      if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
      if (a >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
      return v.toFixed(0);
    }
  }
}

// synthetic per-expiry split of the aggregate row values
function expirySplit(profile: GammaProfile) {
  // weight of each expiry bucket (mirrors labExpiries weights)
  const sym = profile.symbol;
  const isUs = sym.kind !== 'crypto';
  const dtes = isUs ? [0, 1, 2, 3, 7, 14, 21, 30, 60, 90] : [0, 1, 2, 3, 7, 14, 30];
  const weights = isUs
    ? [0.22, 0.09, 0.07, 0.06, 0.05, 0.07, 0.11, 0.13, 0.09, 0.11]
    : [0.18, 0.12, 0.1, 0.08, 0.14, 0.12, 0.26];
  return dtes.map((dte, i) => ({ dte, w: weights[i] ?? 0.05 }));
}

export function GammaHeatmaps({ profile }: { profile: GammaProfile }) {
  const [metric, setMetric] = useState<HeatMetric>('gex');
  const [split, setSplit] = useState<'net' | 'call' | 'put'>('net');
  const { rows, spot, symbol } = profile;

  const expiries = useMemo(() => expirySplit(profile), [profile]);

  // cell value for strike × expiry
  const cellValue = (rowIdx: number, exW: number): number => {
    const row = rows[rowIdx];
    switch (metric) {
      case 'gex':
        return (split === 'net' ? row.netGex : split === 'call' ? -row.callGex : row.putGex) * exW;
      case 'vex':
        return (split === 'net' ? row.netVex : split === 'call' ? -row.callVex : row.putVex) * exW;
      case 'iv':
        return split === 'put' ? row.putIv : row.callIv;
      case 'oi':
        return (split === 'net' ? row.callOi + row.putOi : split === 'call' ? row.callOi : row.putOi) * exW;
      case 'volume':
        return (split === 'net' ? row.callVolume + row.putVolume : split === 'call' ? row.callVolume : row.putVolume) * exW;
    }
  };

  const meta = METRICS.find((m) => m.id === metric)!;

  const values = rows.flatMap((_, i) => expiries.map((e) => cellValue(i, e.w)));
  const maxAbs = Math.max(...values.map(Math.abs)) || 1;

  // condensed strike rows: show ~21 strikes centered on ATM
  const half = 10;
  const atmIdx = rows.reduce(
    (best, r, i) => (Math.abs(r.strike - spot) < Math.abs(rows[best].strike - spot) ? i : best),
    0,
  );
  const visible = rows.slice(Math.max(0, atmIdx - half), Math.min(rows.length, atmIdx + half + 1));

  return (
    <div className="space-y-3">
      {/* controls */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Grid3x3 className="h-3.5 w-3.5 text-teal-400" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
            Strike × Expiry Heatmap
          </span>
        </div>
        <div className="flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
          {METRICS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMetric(m.id)}
              className={`rounded px-2 py-1 text-[10px] font-medium transition ${
                metric === m.id ? 'bg-teal-950/60 text-teal-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
          {(['net', 'call', 'put'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSplit(s)}
              className={`rounded px-2 py-1 text-[10px] font-medium uppercase transition ${
                split === s
                  ? s === 'call'
                    ? 'bg-emerald-950/60 text-emerald-300'
                    : s === 'put'
                      ? 'bg-rose-950/60 text-rose-300'
                      : 'bg-zinc-800 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[9px] text-zinc-500">
          {meta.desc} · {meta.unit} · {symbol.id} {fmtNum(spot, spot >= 1000 ? 0 : 2)}
        </span>
      </div>

      {/* heatmap grid */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
        <table className="w-full min-w-[860px] border-separate border-spacing-[2px] text-center">
          <thead>
            <tr>
              <th className="w-20 text-[8px] font-medium uppercase tracking-wider text-zinc-600">strike</th>
              {expiries.map((e) => (
                <th
                  key={e.dte}
                  className={`px-1 py-1 text-[9px] font-semibold font-mono ${
                    e.dte === 0 ? 'text-amber-300' : 'text-zinc-500'
                  }`}
                >
                  {e.dte === 0 ? '0DTE' : `${e.dte}d`}
                </th>
              ))}
              <th className="px-1 text-[8px] font-medium uppercase tracking-wider text-zinc-600">Σ row</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const idx = rows.indexOf(row);
              const isAtm = Math.abs(row.strike - spot) < symbol.strikeStep / 2;
              const isCallWall = row.strike === profile.levels.callWall;
              const isPutWall = row.strike === profile.levels.putWall;
              const rowSum = expiries.reduce((a, e) => a + cellValue(idx, e.w), 0);
              return (
                <tr key={row.strike}>
                  <td
                    className={`rounded px-1 py-1 font-mono text-[9px] ${
                      isAtm
                        ? 'bg-zinc-800 font-bold text-zinc-100'
                        : isCallWall
                          ? 'text-emerald-300'
                          : isPutWall
                            ? 'text-rose-300'
                            : 'text-zinc-500'
                    }`}
                    title={`${row.strike}${isAtm ? ' — ATM' : ''}${isCallWall ? ' — call wall' : ''}${isPutWall ? ' — put wall' : ''}`}
                  >
                    {fmtNum(row.strike, row.strike >= 1000 ? 0 : row.strike >= 100 ? 1 : 2)}
                    {isAtm && <span className="ml-0.5 text-teal-300">◄</span>}
                  </td>
                  {expiries.map((e) => {
                    const v = cellValue(idx, e.w);
                    return (
                      <td
                        key={e.dte}
                        className="rounded px-1 py-1.5 font-mono text-[9px] tabular-nums text-zinc-100"
                        style={{ background: heatColor(v, maxAbs, meta.signed) }}
                        title={`K ${row.strike} · ${e.dte === 0 ? '0DTE' : `${e.dte}d`} · ${fmtHeat(v, metric)} ${meta.unit}`}
                      >
                        {fmtHeat(v, metric)}
                      </td>
                    );
                  })}
                  <td
                    className="rounded px-1 py-1.5 font-mono text-[9px] font-bold tabular-nums text-zinc-100"
                    style={{ background: heatColor(rowSum, maxAbs, meta.signed), outline: '1px solid rgba(148,163,184,0.12)' }}
                  >
                    {fmtHeat(rowSum, metric)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* legend */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[9px] text-zinc-500">
          {meta.signed ? (
            <>
              <span className="flex items-center gap-1">
                <i className="h-2.5 w-5 rounded-sm" style={{ background: 'rgba(244,63,94,0.9)' }} /> negative
                {metric === 'gex' ? ' (dealers short)' : ''}
              </span>
              <span className="flex items-center gap-1">
                <i className="h-2.5 w-5 rounded-sm" style={{ background: 'rgba(63,63,70,0.4)' }} /> near zero
              </span>
              <span className="flex items-center gap-1">
                <i className="h-2.5 w-5 rounded-sm" style={{ background: 'rgba(16,185,129,0.9)' }} /> positive
                {metric === 'gex' ? ' (dealers long)' : ''}
              </span>
            </>
          ) : (
            <span className="flex items-center gap-1">
              <i className="h-2.5 w-5 rounded-sm" style={{ background: 'rgba(63,63,70,0.35)' }} /> 0
              <i className="h-2.5 w-5 rounded-sm" style={{ background: 'rgba(45,212,191,0.45)' }} />
              <i className="h-2.5 w-5 rounded-sm" style={{ background: 'rgba(45,212,191,0.9)' }} /> max {fmtHeat(maxAbs, metric)}
            </span>
          )}
          <span className="ml-auto font-mono text-[8px] text-zinc-600">
            deterministic OI surface · {expiries.length} expiries · ATM◄ · walls colored in strike column
          </span>
        </div>
      </div>

      {/* biggest absolute strikes table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
        <div className="px-4 pt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            Top strikes by |{meta.label}| — all expiries
          </h3>
        </div>
        <table className="w-full min-w-[720px] text-left">
          <thead>
            <tr className="border-b border-zinc-800 text-[8px] uppercase tracking-wider text-zinc-600">
              <th className="px-3 py-1.5 font-medium">Strike</th>
              <th className="font-medium">Call OI</th>
              <th className="font-medium">Put OI</th>
              <th className="font-medium">Call IV</th>
              <th className="font-medium">Put IV</th>
              <th className="font-medium">Net GEX</th>
              <th className="font-medium">Net VEX</th>
              <th className="font-medium">Call $</th>
              <th className="font-medium">Put $</th>
              <th className="px-3 font-medium">Vol</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[10px] tabular-nums">
            {[...rows]
              .sort((a, b) =>
                Math.abs(split === 'net' ? b.netGex : split === 'call' ? b.callGex : b.putGex) -
                Math.abs(split === 'net' ? a.netGex : split === 'call' ? a.callGex : a.putGex),
              )
              .slice(0, 10)
              .map((r) => (
                <tr key={r.strike} className="border-b border-zinc-800/40 text-zinc-300">
                  <td className="px-3 py-1.5 font-semibold text-zinc-100">
                    {fmtNum(r.strike, r.strike >= 1000 ? 0 : 1)}
                  </td>
                  <td className="text-emerald-400/80">{fmtNum(r.callOi, 0)}</td>
                  <td className="text-rose-400/80">{fmtNum(r.putOi, 0)}</td>
                  <td>{(r.callIv * 100).toFixed(1)}%</td>
                  <td>{(r.putIv * 100).toFixed(1)}%</td>
                  <td className={r.netGex >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                    {fmtHeat(r.netGex, 'gex')}
                  </td>
                  <td className={r.netVex >= 0 ? 'text-emerald-300/70' : 'text-rose-300/70'}>
                    {fmtHeat(r.netVex, 'vex')}
                  </td>
                  <td className="text-emerald-400/60">{fmtHeat(r.callPremium, 'oi')}</td>
                  <td className="text-rose-400/60">{fmtHeat(r.putPremium, 'oi')}</td>
                  <td className="px-3 text-zinc-500">{fmtNum(r.callVolume + r.putVolume, 0)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

'use client';

// ─────────────────────────────────────────────────────────────────────────────
// GAMMA LAB — Contracts tab: pick any contract → price/IV/delta chart;
// volatility skew by delta across tenors; IV term structure.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { LineChart, Waves } from 'lucide-react';
import { contractSeries, skewCurve, labExpiries, labSymbol } from '@/lib/gamma-flow';
import type { GammaProfile } from '@/lib/gamma-flow';
import { fmtNum } from '@/lib/format';

const C = {
  grid: 'rgba(148,163,184,0.08)',
  gridStrong: 'rgba(148,163,184,0.16)',
  text: '#94a3b8',
  textBright: '#e2e8f0',
  price: '#2dd4bf',
  iv: '#fbbf24',
  delta: '#818cf8',
  skew0: '#2dd4bf',
  term: '#34d399',
};

export function GammaContracts({ profile }: { profile: GammaProfile }) {
  const { rows, spot, symbol, levels } = profile;
  const expiries = useMemo(() => labExpiries(symbol), [symbol]);

  // default selection: ATM call, 7d
  const [strikeIdx, setStrikeIdx] = useState(() => {
    const i = rows.reduce(
      (best, r, idx) => (Math.abs(r.strike - spot) < Math.abs(rows[best].strike - spot) ? idx : best),
      0,
    );
    return i;
  });
  const [optionType, setOptionType] = useState<'call' | 'put'>('call');
  const [dte, setDte] = useState(7);

  const strike = rows[strikeIdx]?.strike ?? spot;
  const now = Date.now();
  const series = useMemo(
    () => contractSeries(symbol.id, spot, strike, optionType, dte, now),
    [symbol.id, spot, strike, optionType, dte, now],
  );

  const last = series.points[series.points.length - 1];
  const first = series.points[0];
  const chg = last && first ? last.price - first.price : 0;
  const chgPct = last && first ? (last.price / first.price - 1) * 100 : 0;

  const skews = useMemo(
    () =>
      [0, 7, 30, 90]
        .filter((d) => expiries.some((e) => e.dte === d) || d === 90)
        .map((d) => ({ dte: d, pts: skewCurve(symbol.id, spot, d) })),
    [symbol.id, spot, expiries],
  );

  return (
    <div className="space-y-3">
      {/* contract selector */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <LineChart className="h-3.5 w-3.5 text-teal-400" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
            Contract chart
          </span>
        </div>
        <select
          value={strikeIdx}
          onChange={(e) => setStrikeIdx(Number(e.target.value))}
          className="h-7 rounded-md border border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px] text-zinc-200 outline-none focus:border-teal-500/50"
        >
          {rows.map((r, i) => (
            <option key={r.strike} value={i}>
              {fmtNum(r.strike, r.strike >= 1000 ? 0 : r.strike >= 100 ? 1 : 2)}
              {r.strike === levels.callWall ? ' — call wall' : r.strike === levels.putWall ? ' — put wall' : ''}
            </option>
          ))}
        </select>
        <div className="flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
          {(['call', 'put'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setOptionType(t)}
              className={`rounded px-2.5 py-1 text-[10px] font-semibold uppercase transition ${
                optionType === t
                  ? t === 'call'
                    ? 'bg-emerald-950/60 text-emerald-300'
                    : 'bg-rose-950/60 text-rose-300'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
          {expiries.slice(0, 7).map((e) => (
            <button
              key={e.dte}
              onClick={() => setDte(e.dte)}
              className={`rounded px-2 py-1 font-mono text-[10px] transition ${
                dte === e.dte
                  ? 'bg-teal-950/60 text-teal-300'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {e.label}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px]">
          <span className="text-zinc-400">
            {symbol.id} {fmtNum(strike, strike >= 1000 ? 0 : 1)}{optionType === 'call' ? 'C' : 'P'} · {dte === 0 ? '0DTE' : `${dte}d`}
          </span>
          <span className={chg >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
            {chg >= 0 ? '+' : ''}{chg.toFixed(2)} ({chgPct.toFixed(1)}%)
          </span>
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {/* price chart */}
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 lg:col-span-2">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              Contract price — last 6.5h (5m bars)
            </h3>
            <div className="flex gap-3 text-[9px]">
              <span className="flex items-center gap-1"><i className="h-0.5 w-3" style={{ background: C.price }} /> price</span>
              <span className="flex items-center gap-1"><i className="h-0.5 w-3" style={{ background: C.iv }} /> IV ×10</span>
              <span className="flex items-center gap-1"><i className="h-0.5 w-3" style={{ background: C.delta }} /> delta</span>
            </div>
          </div>
          <ContractChart series={series} />
          <div className="mt-2 grid grid-cols-4 gap-2 border-t border-zinc-800/60 pt-2 font-mono text-[10px]">
            <div><p className="text-[8px] uppercase text-zinc-600">last</p><p className="text-zinc-100">{last?.price.toFixed(2)}</p></div>
            <div><p className="text-[8px] uppercase text-zinc-600">IV</p><p className="text-amber-300">{((last?.iv ?? 0) * 100).toFixed(1)}%</p></div>
            <div><p className="text-[8px] uppercase text-zinc-600">delta</p><p className="text-indigo-300">{(last?.delta ?? 0).toFixed(3)}</p></div>
            <div><p className="text-[8px] uppercase text-zinc-600">vega proxy</p><p className="text-zinc-300">{(last ? (last.price / Math.max(last.iv, 0.01) * 0.01) : 0).toFixed(2)}</p></div>
          </div>
        </div>

        {/* skew */}
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              <Waves className="h-3.5 w-3.5 text-teal-400" /> Volatility skew — IV by delta
            </h3>
          </div>
          <SkewChart skews={skews} />
          <p className="mt-1 text-[8px] leading-relaxed text-zinc-600">
            Put-side wing (low delta) premium over calls = crash insurance demand. 0DTE skew tightens
            fastest as decay completes.
          </p>
        </div>
      </div>

      {/* term structure */}
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
          ATM IV term structure
        </h3>
        <TermChart symbolId={symbol.id} spot={spot} />
      </div>
    </div>
  );
}

function ContractChart({ series }: { series: ReturnType<typeof contractSeries> }) {
  const W = 760, H = 240;
  const PAD = { l: 52, r: 44, t: 12, b: 22 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const pts = series.points;
  if (pts.length < 2) return <div className="h-[240px]" />;
  const pMax = Math.max(...pts.map((p) => p.price)) * 1.05 || 1;
  const pMin = Math.min(...pts.map((p) => p.price)) * 0.95;
  const ivMax = Math.max(...pts.map((p) => p.iv * 10));
  const dMin = Math.min(...pts.map((p) => p.delta), -0.05);
  const dMax = Math.max(...pts.map((p) => p.delta), 0.05);

  const x = (i: number) => PAD.l + (i / (pts.length - 1)) * iw;
  const yP = (v: number) => PAD.t + ih - ((v - pMin) / (pMax - pMin || 1)) * ih;
  const yI = (v: number) => PAD.t + ih - (v / ivMax) * ih;
  const yD = (v: number) => PAD.t + ih - ((v - dMin) / (dMax - dMin || 1)) * ih;

  const line = (get: (p: typeof pts[0]) => number, y: (v: number) => number) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join(' ');

  const areaP = `${line((p) => p.price, yP)} L${x(pts.length - 1).toFixed(1)},${yP(pMin).toFixed(1)} L${x(0).toFixed(1)},${yP(pMin).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ display: 'block' }}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + f * ih} y2={PAD.t + f * ih} stroke={C.grid} />
      ))}
      <path d={areaP} fill="rgba(45,212,191,0.07)" />
      <path d={line((p) => p.price, yP)} fill="none" stroke={C.price} strokeWidth={1.8} />
      <path d={line((p) => p.iv * 10, yI)} fill="none" stroke={C.iv} strokeWidth={1.2} strokeDasharray="4,3" opacity={0.8} />
      <path d={line((p) => p.delta, yD)} fill="none" stroke={C.delta} strokeWidth={1.2} opacity={0.7} />
      {/* axes */}
      {[pMin, (pMin + pMax) / 2, pMax].map((v) => (
        <text key={v} x={PAD.l - 6} y={yP(v) + 3} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="end">
          {v.toFixed(v < 10 ? 2 : 0)}
        </text>
      ))}
      <text x={W - PAD.r + 6} y={yI(ivMax) + 3} fill={C.iv} fontSize={8} fontFamily="monospace">{(ivMax * 10).toFixed(0)}%</text>
      <text x={W - PAD.r + 6} y={yD(0) + 3} fill={C.delta} fontSize={8} fontFamily="monospace">Δ0</text>
      {['-6.5h', '-4h', '-2h', 'now'].map((l, i) => (
        <text key={l} x={PAD.l + (i / 3) * iw} y={H - 6} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="middle">{l}</text>
      ))}
    </svg>
  );
}

function SkewChart({ skews }: { skews: { dte: number; pts: { delta: number; iv: number }[] }[] }) {
  const W = 360, H = 240;
  const PAD = { l: 40, r: 10, t: 12, b: 22 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const colors = ['#2dd4bf', '#fbbf24', '#818cf8', '#f472b6'];
  const ivMax = Math.max(...skews.flatMap((s) => s.pts.map((p) => p.iv))) * 1.05;
  const ivMin = Math.min(...skews.flatMap((s) => s.pts.map((p) => p.iv))) * 0.95;

  const x = (d: number) => PAD.l + ((0.9 - d) / 0.8) * iw; // put delta 0.1 (left) → call 0.9 (right)
  const y = (v: number) => PAD.t + ih - ((v - ivMin) / (ivMax - ivMin || 1)) * ih;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ display: 'block' }}>
      {[0, 0.5, 1].map((f) => (
        <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + f * ih} y2={PAD.t + f * ih} stroke={C.grid} />
      ))}
      {skews.map((s, i) => (
        <path
          key={s.dte}
          d={s.pts.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.delta).toFixed(1)},${y(p.iv).toFixed(1)}`).join(' ')}
          fill="none"
          stroke={colors[i % colors.length]}
          strokeWidth={1.6}
        />
      ))}
      {[0.1, 0.25, 0.5, 0.75, 0.9].map((d) => (
        <text key={d} x={x(d)} y={H - 6} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="middle">
          {d}Δ
        </text>
      ))}
      {[ivMin, (ivMin + ivMax) / 2, ivMax].map((v) => (
        <text key={v} x={PAD.l - 6} y={y(v) + 3} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="end">
          {(v * 100).toFixed(0)}%
        </text>
      ))}
      {skews.map((s, i) => (
        <text key={s.dte} x={PAD.l + 6 + i * 38} y={PAD.t + 10} fill={colors[i % colors.length]} fontSize={8} fontFamily="monospace">
          {s.dte === 0 ? '0DTE' : `${s.dte}d`}
        </text>
      ))}
      <text x={W - PAD.r} y={PAD.t + 10} fill={C.text} fontSize={7} fontFamily="monospace" textAnchor="end">puts ← Δ → calls</text>
    </svg>
  );
}

function TermChart({ symbolId, spot }: { symbolId: string; spot: number }) {
  const sym = labSymbol(symbolId);
  const W = 1100, H = 150;
  const PAD = { l: 40, r: 10, t: 10, b: 22 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const dtes = [0, 1, 2, 3, 7, 14, 21, 30, 60, 90];
  const ivs = dtes.map((d) => {
    const t = Math.max(d, 0.25) / 365;
    const r = sym.kind === 'crypto' ? 0.05 : 0.045;
    // inline mini-surface
    const atm = sym.atmIv * Math.exp(Math.log(t / (30 / 365)) * 0.055);
    return Math.min(Math.max(atm, 0.05), 4);
  });
  const ivMax = Math.max(...ivs) * 1.08, ivMin = Math.min(...ivs) * 0.92;

  const x = (i: number) => PAD.l + (i / (dtes.length - 1)) * iw;
  const y = (v: number) => PAD.t + ih - ((v - ivMin) / (ivMax - ivMin || 1)) * ih;

  const path = ivs.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(dtes.length - 1).toFixed(1)},${y(ivMin).toFixed(1)} L${x(0).toFixed(1)},${y(ivMin).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ display: 'block' }}>
      {[0, 0.5, 1].map((f) => (
        <line key={f} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + f * ih} y2={PAD.t + f * ih} stroke={C.grid} />
      ))}
      <path d={area} fill="rgba(52,211,153,0.08)" />
      <path d={path} fill="none" stroke={C.term} strokeWidth={1.8} />
      {ivs.map((v, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(v)} r={2.5} fill={C.term} />
          <text x={x(i)} y={H - 6} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="middle">
            {dtes[i] === 0 ? '0D' : `${dtes[i]}d`}
          </text>
          <text x={x(i)} y={y(v) - 7} fill={C.textBright} fontSize={8} fontFamily="monospace" textAnchor="middle">
            {(v * 100).toFixed(0)}%
          </text>
        </g>
      ))}
      <text x={PAD.l - 6} y={y(ivMax) + 8} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="end">
        {(ivMax * 100).toFixed(0)}%
      </text>
      <text x={PAD.l - 6} y={y(ivMin) + 8} fill={C.text} fontSize={8} fontFamily="monospace" textAnchor="end">
        {(ivMin * 100).toFixed(0)}%
      </text>
    </svg>
  );
}

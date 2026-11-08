'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-screener — WHOLE MARKET: every tradable symbol side-by-side
// with cross-symbol z-scores, leaderboards, live sparklines and regime scores.
// Click a row to refocus the entire Quant Lab on that market — the "see the
// whole market and dive in" surface, replacing any multi-asset screener.
// -----------------------------------------------------------------------------

import React, { useMemo, useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant, useAgeLabel } from './use-quant';
import { EmptyNote, ErrNote, LiveDot, Panel, Pill, Sparkline } from './quant-viz';
import { AnimatedNumber } from './viz-deep';

interface Row {
  symbol: string;
  spot: number;
  chg48hPct: number;
  chg24hPct: number;
  spark: number[];
  perpOiUsd: number;
  fundingApr: number;
  fundingPctile: number | null;
  basisPct: number;
  rv30Pct: number;
  options: boolean;
  iv30Pct: number | null;
  vrpPct: number | null;
  ivRank: number | null;
  pcrOi: number | null;
  gexRegime: string | null;
  netGexUsd1pct: number | null;
  hvlDistPct: number | null;
  em1sPct: number | null;
  tape12hUsd: number | null;
  tapeImbalance: number | null;
  liqAbovePct: number | null;
  liqBelowPct: number | null;
  regimeScore: number;
  regimeLabel: string;
  z: Record<string, number>;
}

interface ScreenerData {
  asOf: number;
  rows: Row[];
  rankings: { label: string; symbol: string; value: number; format: string }[];
  note: string;
}

const COLUMNS: { key: keyof Row; label: string; render: (r: Row) => React.ReactNode; zKey?: string; num?: (r: Row) => number | null }[] = [
  {
    key: 'symbol',
    label: 'market',
    render: (r) => (
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] font-bold text-zinc-100">{r.symbol}</span>
        {r.options ? <span className="rounded bg-teal-500/10 px-1 text-[7px] font-bold uppercase text-teal-400">opts</span> : <span className="rounded bg-zinc-800/60 px-1 text-[7px] uppercase text-zinc-500">perps</span>}
      </span>
    ),
  },
  { key: 'spot', label: 'spot', render: (r) => <AnimatedNumber value={r.spot} format={(v) => fmtNum(v, v >= 1000 ? 0 : 2)} className="font-mono text-zinc-100" /> },
  {
    key: 'chg24hPct',
    label: '24h',
    zKey: 'chg24hPct',
    num: (r) => r.chg24hPct,
    render: (r) => (
      <span className={`font-mono ${r.chg24hPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
        {r.chg24hPct >= 0 ? '+' : ''}
        {r.chg24hPct.toFixed(2)}%
      </span>
    ),
  },
  {
    key: 'spark',
    label: '8h trend',
    render: (r) => (r.spark.length > 2 ? <div className="w-20"><Sparkline data={r.spark} height={18} tone={r.chg48hPct >= 0 ? 'emerald' : 'rose'} /></div> : <span className="text-zinc-600">—</span>),
  },
  {
    key: 'fundingApr',
    label: 'funding apr',
    zKey: 'fundingApr',
    num: (r) => r.fundingApr,
    render: (r) => (
      <span className={`font-mono ${r.fundingApr >= 0.25 ? 'text-rose-300' : r.fundingApr <= -0.2 ? 'text-emerald-300' : 'text-zinc-300'}`}>
        {r.fundingApr >= 0 ? '+' : ''}
        {(r.fundingApr * 100).toFixed(1)}%
        {r.fundingPctile != null && <span className="ml-1 text-[7.5px] text-zinc-600">p{r.fundingPctile}</span>}
      </span>
    ),
  },
  { key: 'perpOiUsd', label: 'perp oi', render: (r) => <span className="font-mono text-zinc-300">{fmtUsd(r.perpOiUsd, { compact: true })}</span> },
  {
    key: 'iv30Pct',
    label: 'iv30',
    zKey: 'iv30Pct',
    num: (r) => r.iv30Pct,
    render: (r) => (
      <span className="font-mono text-zinc-300">
        {r.iv30Pct != null ? `${r.iv30Pct.toFixed(1)}%` : '—'}
        {r.ivRank != null && <span className={`ml-1 text-[7.5px] ${r.ivRank >= 65 ? 'text-amber-400' : r.ivRank <= 35 ? 'text-emerald-400' : 'text-zinc-600'}`}>r{r.ivRank}</span>}
      </span>
    ),
  },
  {
    key: 'vrpPct',
    label: 'vrp',
    zKey: 'vrpPct',
    num: (r) => r.vrpPct,
    render: (r) => (r.vrpPct != null ? <span className={`font-mono ${r.vrpPct >= 2.5 ? 'text-rose-300' : r.vrpPct <= -1 ? 'text-emerald-300' : 'text-zinc-300'}`}>{r.vrpPct >= 0 ? '+' : ''}{r.vrpPct.toFixed(1)}</span> : <span className="text-zinc-600">—</span>),
  },
  {
    key: 'gexRegime',
    label: 'gamma',
    zKey: 'netGexUsd1pct',
    num: (r) => r.netGexUsd1pct,
    render: (r) =>
      r.gexRegime ? (
        <span className={`rounded px-1 py-0.5 text-[7.5px] font-bold uppercase ${r.gexRegime === 'long-gamma' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
          {r.gexRegime === 'long-gamma' ? 'LONG γ' : 'SHORT γ'}
        </span>
      ) : (
        <span className="text-zinc-600">—</span>
      ),
  },
  {
    key: 'hvlDistPct',
    label: 'hvl dist',
    render: (r) =>
      r.hvlDistPct != null ? (
        <span className={`font-mono ${Math.abs(r.hvlDistPct) <= 1.2 ? 'font-bold text-amber-300' : r.hvlDistPct >= 0 ? 'text-emerald-300/80' : 'text-rose-300/80'}`}>
          {r.hvlDistPct >= 0 ? '+' : ''}
          {r.hvlDistPct.toFixed(1)}%
        </span>
      ) : (
        <span className="text-zinc-600">—</span>
      ),
  },
  {
    key: 'em1sPct',
    label: '1σ em',
    render: (r) => (r.em1sPct != null ? <span className="font-mono text-zinc-300">{r.em1sPct.toFixed(2)}%</span> : <span className="text-zinc-600">—</span>),
  },
  {
    key: 'tapeImbalance',
    label: 'tape 12h',
    zKey: 'tapeImbalance',
    num: (r) => r.tapeImbalance,
    render: (r) =>
      r.tapeImbalance != null ? (
        <span className={`font-mono ${r.tapeImbalance >= 0.18 ? 'text-emerald-300' : r.tapeImbalance <= -0.18 ? 'text-rose-300' : 'text-zinc-400'}`}>
          {(r.tapeImbalance * 100).toFixed(0)}%
          {r.tape12hUsd ? <span className="ml-1 text-[7.5px] text-zinc-600">{fmtUsd(r.tape12hUsd, { compact: true })}</span> : null}
        </span>
      ) : (
        <span className="text-zinc-600">—</span>
      ),
  },
  {
    key: 'liqAbovePct',
    label: 'liq magnets',
    render: (r) => (
      <span className="font-mono text-[8.5px] text-zinc-400">
        {r.liqAbovePct != null ? <span className="text-rose-300/80">↑{r.liqAbovePct.toFixed(1)}%</span> : '↑—'} <span className="text-zinc-700">/</span> {r.liqBelowPct != null ? <span className="text-emerald-300/80">↓{Math.abs(r.liqBelowPct).toFixed(1)}%</span> : '↓—'}
      </span>
    ),
  },
  {
    key: 'regimeScore',
    label: 'regime',
    num: (r) => r.regimeScore,
    render: (r) => (
      <span className="flex items-center justify-end gap-1.5">
        <span className="relative h-1.5 w-10 overflow-hidden rounded-full bg-zinc-800">
          <span className={`absolute inset-y-0 rounded-full ${r.regimeScore >= 0 ? 'left-1/2 bg-emerald-400' : 'right-1/2 bg-rose-400'}`} style={{ width: `${Math.min(50, Math.abs(r.regimeScore) / 2)}%` }} />
          <span className="absolute left-1/2 top-0 h-full w-px bg-zinc-600" />
        </span>
        <span className={`font-mono text-[9px] font-bold ${r.regimeScore >= 45 ? 'text-emerald-300' : r.regimeScore >= 18 ? 'text-teal-300' : r.regimeScore > -18 ? 'text-zinc-300' : r.regimeScore > -45 ? 'text-amber-300' : 'text-rose-300'}`}>
          {r.regimeScore >= 0 ? '+' : ''}
          {r.regimeScore}
        </span>
      </span>
    ),
  },
];

function zTint(z: number | undefined): string {
  if (z == null || !Number.isFinite(z) || Math.abs(z) < 0.85) return '';
  return z > 0 ? 'bg-emerald-500/[0.07]' : 'bg-rose-500/[0.07]';
}

export function ScreenerPanel({ onFocusSymbol }: { onFocusSymbol?: (symbol: string) => void }) {
  const scan = useQuant<ScreenerData>('/screener', undefined, { pollMs: 15000 });
  const age = useAgeLabel(scan.fetchedAt);
  const [sortKey, setSortKey] = useState<string>('symbol');
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const rows = useMemo(() => {
    const rs = [...(scan.data?.rows ?? [])];
    const col = COLUMNS.find((c) => c.key === sortKey);
    if (col?.num) {
      rs.sort((a, b) => {
        const va = col.num!(a) ?? -Infinity;
        const vb = col.num!(b) ?? -Infinity;
        return (va - vb) * sortDir;
      });
    }
    return rs;
  }, [scan.data, sortKey, sortDir]);

  return (
    <div className="space-y-2">
      <ErrNote error={scan.error} />
      {!scan.data && scan.loading && <EmptyNote>scanning every market — live venue sweep takes a few seconds…</EmptyNote>}
      {scan.data && (
        <>
          <Panel
            title="Whole-Market Leaderboards"
            sub="cross-symbol scan · where is the edge right now"
            right={<LiveDot ok={!scan.error} label={`live · ${age}`} />}
          >
            <div className="flex flex-wrap gap-1.5">
              {scan.data.rankings.map((r) => (
                <button
                  key={r.label}
                  onClick={() => onFocusSymbol?.(r.symbol)}
                  className="group flex items-center gap-1.5 rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-2 py-1.5 transition hover:border-teal-700/60 hover:bg-teal-950/20"
                >
                  <span className="text-[8px] font-semibold uppercase tracking-[0.1em] text-zinc-500 group-hover:text-teal-400/70">{r.label}</span>
                  <span className="font-mono text-[10px] font-bold text-zinc-100">{r.symbol}</span>
                  <span className="font-mono text-[9px] text-teal-300/90">{r.format}</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel
            title="Market Screener"
            sub="z-score tinted (green = richest of the group, red = most extreme negative) · click headers to sort · click a market to focus every tab"
            right={<Pill tone="teal">{rows.length} markets</Pill>}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[9.5px]">
                <thead>
                  <tr className="border-b border-zinc-800/70 text-[7.5px] uppercase tracking-[0.1em] text-zinc-600">
                    {COLUMNS.map((c) => (
                      <th
                        key={String(c.key)}
                        onClick={() => {
                          if (!c.num) return;
                          if (sortKey === c.key) setSortDir((d) => (d === 1 ? -1 : 1));
                          else {
                            setSortKey(String(c.key));
                            setSortDir(-1);
                          }
                        }}
                        className={`whitespace-nowrap px-1.5 py-1 font-semibold ${c.key === 'symbol' ? 'text-left' : 'text-right'} ${c.num ? 'cursor-pointer hover:text-zinc-300' : ''}`}
                      >
                        {c.label}
                        {sortKey === c.key ? (sortDir === 1 ? ' ↑' : ' ↓') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.symbol}
                      className="cursor-pointer border-b border-zinc-900/60 transition hover:bg-zinc-900/50"
                      onClick={() => onFocusSymbol?.(r.symbol)}
                    >
                      {COLUMNS.map((c) => (
                        <td key={String(c.key)} className={`whitespace-nowrap px-1.5 py-1.5 ${c.key === 'symbol' ? 'text-left' : 'text-right'} ${c.zKey ? zTint(r.z[c.zKey]) : ''}`}>
                          {c.render(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[8.5px] text-zinc-600">{scan.data.note}</p>
          </Panel>
        </>
      )}
    </div>
  );
}

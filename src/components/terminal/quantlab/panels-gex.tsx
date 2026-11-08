'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-gex — GEX & Positioning: dealer levels, strike profile,
// strike×expiry heatmap, ladder, per-expiry GEX and dealer-flow history.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant } from './use-quant';
import { ChartLegend, DivergingBars, EmptyNote, ErrNote, HeatMatrix, LineChart, Panel, Pill, Segmented, StatGrid } from './quant-viz';

interface Levels {
  hvl: number | null;
  callWall: number | null;
  putSupport: number | null;
  maxPain: number | null;
  regime: string;
  totalGexUsd1pct: number;
  callGexUsd1pct: number;
  putGexUsd1pct: number;
  topStrikes: { strike: number; callGex: number; putGex: number; netGex: number; callOi: number; putOi: number }[];
}
interface GexLevelsData {
  spot: number;
  levels: Levels;
  levels0dte: Levels | null;
  unit: string;
  note: string;
}
interface HeatData {
  spot: number;
  strikes: number[];
  expiries: string[];
  netGex: number[][];
  oiUsd: number[][];
}
interface LadderData {
  spot: number;
  ladder: { strike: number; netGex: number; cumNetGex: number; callOi: number; putOi: number }[];
}
interface HistData {
  points: { ts: number; value: number }[];
  meta: { unit: string; snapshots: number };
}

export function GexPanel({ symbol, hasOptions }: { symbol: string; hasOptions: boolean }) {
  const [scope, setScope] = useState<'all' | '0dte'>('all');
  const levels = useQuant<GexLevelsData>('/gex', { symbol, view: 'levels', expiry: scope }, { pollMs: 8000 });
  const strike = useQuant<{ topStrikes: { strike: number; callGex: number; putGex: number; netGex: number; callOi: number; putOi: number; callOiUsd: number; putOiUsd: number }[] }>('/gex', { symbol, view: 'strike' }, { pollMs: 15000 });
  const heat = useQuant<HeatData>('/gex', { symbol, view: 'heatmap' }, { pollMs: 20000 });
  const ladder = useQuant<LadderData>('/gex', { symbol, view: 'ladder' }, { pollMs: 15000 });
  const hist = useQuant<HistData>('/history', { symbol, metric: 'gex', days: 7 }, { pollMs: 60000 });
  const flow = useQuant<{ points: { ts: number; hedgeFlowUsd: number }[]; model: string }>('/history', { symbol, metric: 'dealer-flow', days: 3 }, { pollMs: 60000 });

  if (!hasOptions) return <EmptyNote>{symbol} has no options chain on free venues — open the Perps & Market tab for live futures analytics.</EmptyNote>;

  const lv = levels.data;
  const lvs = scope === '0dte' ? lv?.levels0dte : lv?.levels;
  const maxGex = Math.max(...(strike.data?.topStrikes ?? []).map((s) => Math.abs(s.netGex)), 1);

  return (
    <div className="space-y-2">
      <ErrNote error={levels.error} />
      {lv && lvs && (
        <Panel
          title="Dealer Key Levels"
          sub={scope === '0dte' ? '0DTE (front expiry)' : 'all-expiry'}
          right={
            <>
              <Segmented value={scope} onChange={setScope} options={[{ id: 'all', label: 'All' }, { id: '0dte', label: '0DTE' }]} />
              <Pill tone={lvs.regime === 'long-gamma' ? 'emerald' : 'rose'}>{lvs.regime}</Pill>
            </>
          }
        >
          <StatGrid
            stats={[
              { label: 'spot', value: fmtNum(lv.spot, lv.spot >= 1000 ? 0 : 2), sub: 'deribit index' },
              { label: 'gamma flip · hvl', value: lvs.hvl != null ? fmtNum(lvs.hvl, 0) : '—', tone: 'teal', sub: 'cumulative gex zero-cross' },
              { label: 'call wall', value: lvs.callWall != null ? fmtNum(lvs.callWall, 0) : '—', tone: 'amber', sub: 'largest +gex strike' },
              { label: 'put support', value: lvs.putSupport != null ? fmtNum(lvs.putSupport, 0) : '—', tone: 'rose', sub: 'largest −gex strike' },
              { label: 'max pain', value: lvs.maxPain != null ? fmtNum(lvs.maxPain, 0) : '—', sub: 'expiry pin magnet' },
              { label: 'net gex', value: fmtUsd(lvs.totalGexUsd1pct, { compact: true, sign: true }), sub: 'USD per 1% move', tone: lvs.totalGexUsd1pct >= 0 ? 'emerald' : 'rose' },
              { label: 'call gex', value: fmtUsd(lvs.callGexUsd1pct, { compact: true }), sub: 'USD per 1% move' },
              { label: 'put gex', value: fmtUsd(lvs.putGexUsd1pct, { compact: true }), sub: 'USD per 1% move' },
            ]}
          />
          <p className="mt-2 text-[8.5px] leading-relaxed text-zinc-600">{lv.note}</p>
        </Panel>
      )}

      <div className="grid gap-2 xl:grid-cols-2">
        <Panel title="GEX by Strike" sub="net dealer gamma per strike · USD / 1% move" right={<Pill tone="teal">live</Pill>}>
          {strike.data?.topStrikes?.length ? (
            <DivergingBars rows={strike.data.topStrikes.slice(0, 14).map((s) => ({ label: fmtNum(s.strike, 0), value: s.netGex, alt: `${fmtNum(s.callOi, 0)}c/${fmtNum(s.putOi, 0)}p` }))} unit="$" />
          ) : (
            <EmptyNote>{strike.loading ? 'computing…' : 'no strike data'}</EmptyNote>
          )}
        </Panel>

        <Panel title="Strike Ladder" sub="cumulative net gex around spot ±10%">
          {ladder.data?.ladder?.length ? (
            <DivergingBars rows={ladder.data.ladder.slice(0, 16).map((s) => ({ label: fmtNum(s.strike, 0), value: s.cumNetGex }))} unit="$" />
          ) : (
            <EmptyNote>{ladder.loading ? 'computing…' : '—'}</EmptyNote>
          )}
        </Panel>
      </div>

      <Panel title="Strike × Expiry GEX Heatmap" sub="USD per 1% move · dealer-signed" right={<Pill>top 24 strikes × 12 expiries</Pill>}>
        {heat.data?.strikes?.length ? (
          <HeatMatrix
            rows={heat.data.strikes.slice(0, 24).map((s) => fmtNum(s, 0))}
            cols={heat.data.expiries.slice(0, 12).map((e) => e.slice(5))}
            values={heat.data.netGex.slice(0, 12).map((row) => row.slice(0, 24))}
            format={(v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}` : `${(v / 1e3).toFixed(0)}k`)}
          />
        ) : (
          <EmptyNote>{heat.loading ? 'computing…' : '—'}</EmptyNote>
        )}
      </Panel>

      <div className="grid gap-2 xl:grid-cols-2">
        <Panel title="Total GEX · 7d History" sub={hist.data?.meta?.unit ?? 'USD per 1% move'} right={<Pill>{hist.data?.meta?.snapshots ?? 0} snapshots</Pill>}>
          {hist.data?.points?.length ? (
            <LineChart
              height={150}
              yFormat={(v) => `${(v / 1e6).toFixed(1)}M`}
              series={[{ label: 'net gex', points: hist.data.points.map((p) => ({ x: p.ts, y: p.value })) }]}
              xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              yZero
            />
          ) : (
            <EmptyNote>history accrues every ~2 min — check back soon</EmptyNote>
          )}
        </Panel>

        <Panel title="Estimated Dealer Hedge Flow" sub="−GEX × Δspot% from snapshots" right={<Pill tone="amber">estimate</Pill>}>
          {flow.data?.points?.length ? (
            <LineChart
              height={150}
              yFormat={(v) => `${(v / 1e6).toFixed(1)}M`}
              series={[{ label: 'hedge flow', points: flow.data.points.map((p) => ({ x: p.ts, y: p.hedgeFlowUsd })) }]}
              xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              yZero
            />
          ) : (
            <EmptyNote>{flow.loading ? 'loading…' : 'needs ≥2 snapshots'}</EmptyNote>
          )}
          <ChartLegend series={[{ label: 'positive = dealers sold into rally', color: '#2dd4bf' }]} />
        </Panel>
      </div>
      <p className="text-[8.5px] text-zinc-600">
        Model: dealers short customer calls / long puts on the live Deribit chain — the standard dealer-positioning convention. All values in USD per 1% spot move.
      </p>
    </div>
  );
}

/** Compact cross-symbol table for the overview tab. */
export function MultiSymbolTable() {
  const { data } = useQuant<{ symbols: { symbol: string; spot: number; hvl: number | null; callWall: number | null; putSupport: number | null; totalGexUsd1pct: number; regime: string; atmIv30Pct: number; putCallRatioOi: number }[] }>('/gex', { view: 'multi' }, { pollMs: 15000 });
  if (!data?.symbols?.length) return <EmptyNote>loading cross-symbol levels…</EmptyNote>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[9.5px]">
        <thead>
          <tr className="border-b border-zinc-800/70 text-[8px] uppercase tracking-[0.1em] text-zinc-600">
            {['sym', 'spot', 'hvl', 'call wall', 'put support', 'net gex', 'regime', 'cm30 iv', 'pcr'].map((h) => (
              <th key={h} className="px-1.5 py-1 text-right font-semibold first:text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.symbols.map((s) => (
            <tr key={s.symbol} className="border-b border-zinc-900/60 hover:bg-zinc-900/40">
              <td className="px-1.5 py-1 text-left font-mono font-semibold text-teal-300">{s.symbol}</td>
              <td className="px-1.5 py-1 text-right font-mono text-zinc-200">{fmtNum(s.spot, 0)}</td>
              <td className="px-1.5 py-1 text-right font-mono text-zinc-300">{s.hvl != null ? fmtNum(s.hvl, 0) : '—'}</td>
              <td className="px-1.5 py-1 text-right font-mono text-amber-300">{s.callWall != null ? fmtNum(s.callWall, 0) : '—'}</td>
              <td className="px-1.5 py-1 text-right font-mono text-rose-300">{s.putSupport != null ? fmtNum(s.putSupport, 0) : '—'}</td>
              <td className={`px-1.5 py-1 text-right font-mono ${s.totalGexUsd1pct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtUsd(s.totalGexUsd1pct, { compact: true, sign: true })}</td>
              <td className="px-1.5 py-1 text-right"><Pill tone={s.regime === 'long-gamma' ? 'emerald' : 'rose'}>{s.regime}</Pill></td>
              <td className="px-1.5 py-1 text-right font-mono text-zinc-300">{Number.isFinite(s.atmIv30Pct) ? `${s.atmIv30Pct.toFixed(1)}%` : '—'}</td>
              <td className="px-1.5 py-1 text-right font-mono text-zinc-300">{Number.isFinite(s.putCallRatioOi) ? s.putCallRatioOi.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

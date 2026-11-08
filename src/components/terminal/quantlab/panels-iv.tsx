'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-iv — IV Analytics: term structure, 25Δ/10Δ skew, smiles,
// constant-maturity, IV-vs-RV (VRP), expected moves and the surface grid.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant } from './use-quant';
import { ChartLegend, DataTable, EmptyNote, ErrNote, HeatMatrix, LineChart, Panel, Pill, Segmented, StatGrid } from './quant-viz';

export function IvPanel({ symbol, hasOptions }: { symbol: string; hasOptions: boolean }) {
  const [view, setView] = useState<'term' | 'skew' | 'smile' | 'vrp' | 'em' | 'surface'>('term');
  if (!hasOptions) return <EmptyNote>{symbol} has no options chain — IV analytics need the Deribit chain (BTC/ETH).</EmptyNote>;
  const term = useQuant<{ termStructure: { dte: number; expiry: string; atmIvPct: number; oiUsd: number }[]; cm30Pct: number; vrp: { iv30Pct: number; rv30Pct: number; vrpPct: number; rvSource: string } }>('/iv', { symbol, view: 'term' }, { pollMs: 10000 });
  const skew = useQuant<{ byExpiry: { expiry: string; dte: number; atmIvPct: number; rr25: number; fly25: number; rr10: number }[] }>('/iv', { symbol, view: 'skew' }, { pollMs: 15000 });
  const smile = useQuant<{ expiry: string; dte: number; forward: number; smile: { strike: number; ivPct: number; delta: number }[] }>('/iv', { symbol, view: 'smile' }, { pollMs: 10000 });
  const vrp = useQuant<{ iv30Pct: number; rv30Pct: number; vrpPct: number; realizedSeries: { ts: number; rvPct: number }[] }>('/iv', { symbol, view: 'vrp' }, { pollMs: 60000 });
  const em = useQuant<{ spot: number; byExpiry: { expiry: string; dte: number; straddleUsd: number; oneSigmaUsd: number; oneSigmaPct: number; twoSigmaUsd: number; rangeLow: number; rangeHigh: number; calibrated1sUsd: number }[] }>('/iv', { symbol, view: 'em' }, { pollMs: 15000 });
  const surface = useQuant<{ spot: number; strikes: number[]; expiries: string[]; ivPct: number[][] }>('/iv', { symbol, view: 'surface' }, { pollMs: 30000 });

  const t = term.data;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { id: 'term', label: 'Term' },
            { id: 'skew', label: 'Skew' },
            { id: 'smile', label: 'Smile' },
            { id: 'vrp', label: 'IV vs RV' },
            { id: 'em', label: 'Expected Move' },
            { id: 'surface', label: 'Surface' },
          ]}
        />
        {t && <Pill tone="teal">cm30 {Number.isFinite(t.cm30Pct) ? `${t.cm30Pct.toFixed(1)}%` : '—'}</Pill>}
        {t?.vrp && Number.isFinite(t.vrp.vrpPct) && <Pill tone={t.vrp.vrpPct >= 0 ? 'emerald' : 'amber'}>vrp {t.vrp.vrpPct >= 0 ? '+' : ''}{t.vrp.vrpPct.toFixed(1)}pts</Pill>}
      </div>

      {view === 'term' && (
        <Panel title="ATM IV Term Structure" sub="live implied vol by tenor (OTM composite at forward)" right={<Pill tone="teal">live</Pill>}>
          <ErrNote error={term.error} />
          {t?.termStructure?.length ? (
            <>
              <LineChart
                height={190}
                yFormat={(v) => `${v.toFixed(0)}%`}
                series={[{ label: 'atm iv', points: t.termStructure.filter((p) => Number.isFinite(p.atmIvPct)).map((p) => ({ x: p.dte, y: p.atmIvPct })) }]}
                xFormat={(v) => `${v.toFixed(0)}d`}
                markers={Number.isFinite(t.cm30Pct) ? [{ x: 30, label: 'cm30' }] : undefined}
              />
              <ChartLegend series={[{ label: `constant-maturity 30d = ${t.cm30Pct.toFixed(1)}% (our own DVOL-equivalent)`, color: '#2dd4bf' }]} />
            </>
          ) : (
            <EmptyNote>{term.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}

      {view === 'skew' && (
        <Panel title="Skew · 25Δ / 10Δ" sub="rr = put IV − call IV (risk reversal) · fly = mid(wings) − ATM">
          <ErrNote error={skew.error} />
          {skew.data?.byExpiry?.length ? (
            <DataTable
              rows={skew.data.byExpiry}
              maxRows={12}
              rowKey={(r) => r.expiry}
              columns={[
                { key: 'expiry', label: 'expiry', align: 'l', render: (r) => r.expiry },
                { key: 'dte', label: 'dte', render: (r) => r.dte.toFixed(1) },
                { key: 'atm', label: 'atm iv', render: (r) => (Number.isFinite(r.atmIvPct) ? `${r.atmIvPct.toFixed(1)}%` : '—') },
                { key: 'rr25', label: '25Δ rr', render: (r) => (Number.isFinite(r.rr25) ? <span className={r.rr25 >= 0 ? 'text-rose-300' : 'text-emerald-300'}>{r.rr25.toFixed(2)}</span> : '—') },
                { key: 'fly25', label: '25Δ fly', render: (r) => (Number.isFinite(r.fly25) ? r.fly25.toFixed(2) : '—') },
                { key: 'rr10', label: '10Δ rr', render: (r) => (Number.isFinite(r.rr10) ? r.rr10.toFixed(2) : '—') },
              ]}
            />
          ) : (
            <EmptyNote>{skew.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}

      {view === 'smile' && (
        <Panel title="OTM Composite Smile" sub={smile.data ? `${smile.data.expiry} · ${smile.data.dte.toFixed(1)}d · forward ${fmtNum(smile.data.forward ?? 0, 0)}` : 'front expiry'}>
          <ErrNote error={smile.error} />
          {smile.data?.smile?.length ? (
            <LineChart
              height={190}
              yFormat={(v) => `${v.toFixed(0)}%`}
              series={[{ label: 'iv', points: smile.data.smile.map((p) => ({ x: p.strike, y: p.ivPct })) }]}
              xFormat={(v) => fmtNum(v, 0)}
              markers={Number.isFinite(smile.data.forward) ? [{ x: smile.data.forward, label: 'ATM' }] : undefined}
            />
          ) : (
            <EmptyNote>{smile.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}

      {view === 'vrp' && (
        <Panel title="IV vs Realized Vol · VRP" sub={t?.vrp?.rvSource ?? 'deribit 30d realized'} right={vrp.data && Number.isFinite(vrp.data.vrpPct) ? <Pill tone={vrp.data.vrpPct >= 0 ? 'emerald' : 'amber'}>{vrp.data.vrpPct >= 0 ? 'rich' : 'cheap'}</Pill> : null}>
          <ErrNote error={vrp.error} />
          {vrp.data ? (
            <>
              <StatGrid
                cols={4}
                stats={[
                  { label: 'cm30 implied', value: `${vrp.data.iv30Pct.toFixed(1)}%`, tone: 'teal', sub: 'our constant-maturity iv' },
                  { label: 'rv30 realized', value: `${vrp.data.rv30Pct.toFixed(1)}%`, sub: 'venue 30d realized' },
                  { label: 'variance risk premium', value: `${vrp.data.vrpPct >= 0 ? '+' : ''}${vrp.data.vrpPct.toFixed(1)} pts`, tone: vrp.data.vrpPct >= 0 ? 'emerald' : 'rose', sub: 'implied − realized' },
                  { label: 'verdict', value: vrp.data.vrpPct >= 1 ? 'vol sellers paid' : vrp.data.vrpPct <= -1 ? 'options cheap' : 'fairly priced', sub: 'vs 30d history' },
                ]}
              />
              {vrp.data.realizedSeries?.length > 3 && (
                <div className="mt-2">
                  <LineChart
                    height={150}
                    yFormat={(v) => `${v.toFixed(0)}%`}
                    series={[{ label: 'rv30', points: vrp.data.realizedSeries.map((p) => ({ x: p.ts, y: p.rvPct })) }]}
                    xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    markers={Number.isFinite(vrp.data.iv30Pct) ? [{ x: vrp.data.realizedSeries.at(-1)!.ts, label: `iv ${vrp.data.iv30Pct.toFixed(0)}%` }] : undefined}
                  />
                </div>
              )}
            </>
          ) : (
            <EmptyNote>{vrp.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}

      {view === 'em' && (
        <Panel title="Expected Move" sub="1σ lognormal + ATM straddle · calibrated = VRP-rescaled">
          <ErrNote error={em.error} />
          {em.data?.byExpiry?.length ? (
            <DataTable
              rows={em.data.byExpiry}
              maxRows={10}
              rowKey={(r) => r.expiry}
              columns={[
                { key: 'expiry', label: 'expiry', align: 'l', render: (r) => r.expiry },
                { key: 'dte', label: 'dte', render: (r) => r.dte.toFixed(1) },
                { key: 'sigma', label: '1σ', render: (r) => fmtUsd(r.oneSigmaUsd, { compact: true }) },
                { key: 'sigmapct', label: '1σ %', render: (r) => `${r.oneSigmaPct.toFixed(2)}%` },
                { key: 'two', label: '2σ', render: (r) => fmtUsd(r.twoSigmaUsd, { compact: true }) },
                { key: 'straddle', label: 'straddle', render: (r) => (Number.isFinite(r.straddleUsd) ? fmtUsd(r.straddleUsd, { compact: true }) : '—') },
                { key: 'range', label: '68% range', align: 'l', render: (r) => <span className="text-zinc-400">{fmtNum(r.rangeLow, 0)} – {fmtNum(r.rangeHigh, 0)}</span> },
                { key: 'cal', label: 'calibrated 1σ', render: (r) => (Number.isFinite(r.calibrated1sUsd) ? fmtUsd(r.calibrated1sUsd, { compact: true }) : '—') },
              ]}
            />
          ) : (
            <EmptyNote>{em.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}

      {view === 'surface' && (
        <Panel title="IV Surface · strike × expiry" sub="OTM composite IV grid (% annualized)">
          <ErrNote error={surface.error} />
          {surface.data?.strikes?.length ? (
            <HeatMatrix
              rows={surface.data.strikes.slice(0, 22).map((s) => fmtNum(s, 0))}
              cols={surface.data.expiries.slice(0, 12).map((e) => e.slice(5))}
              values={surface.data.ivPct.slice(0, 12).map((row) => row.slice(0, 22))}
              format={(v) => (Number.isFinite(v) ? v.toFixed(0) : '·')}
              colorFn={(v) => {
                const t = Math.min(Math.max((v - 25) / 60, 0), 1);
                return `rgba(45, 212, 191, ${(0.08 + t * 0.72).toFixed(3)})`;
              }}
            />
          ) : (
            <EmptyNote>{surface.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}
    </div>
  );
}

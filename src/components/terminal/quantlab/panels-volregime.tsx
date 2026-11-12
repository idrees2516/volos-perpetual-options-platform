'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-volregime — VOL REGIME: where we are in the vol cycle.
// IV rank/percentile from our own persisted history (with p25/p50/p75 bands),
// the IV history chart with crosshair probe, the realized-vol cone, the DVOL
// index vs our CM30, and the IV-vs-DVOL-vs-RV triangle. Everything the "vol
// is cheap or rich?" question needs, in one live place.
// -----------------------------------------------------------------------------

import React from 'react';
import { fmtNum } from '@/lib/format';
import { useQuant, useAgeLabel } from './use-quant';
import { EmptyNote, ErrNote, LiveDot, Panel, Pill, StatGrid } from './quant-viz';
import { CrosshairChart, RankBar, VolCone } from './viz-deep';

interface VolData {
  symbol: string;
  asOf: number;
  spot: number;
  ivStats: {
    currentPct: number;
    minPct: number;
    maxPct: number;
    meanPct: number;
    p25Pct: number;
    p50Pct: number;
    p75Pct: number;
    rank: number;
    windowDays: number;
    points: number;
    series: { ts: number; ivPct: number }[];
    note: string;
  } | null;
  cone: { days: number; currentPct: number; minPct: number; p25Pct: number; p50Pct: number; p75Pct: number; maxPct: number; cheap: boolean; rich: boolean }[];
  dvol: { currentPct: number; changePct: number | null; series: { ts: number; v: number }[]; source: string } | null;
  triangle: { iv30Pct: number | null; dvolPct: number | null; rv30Pct: number | null; spreadIvRv: number | null; spreadIvDvol: number | null };
  termFrontPct: number | null;
  termCm30Pct: number | null;
  verdict: string;
}

export function VolRegimePanel({ symbol, hasOptions }: { symbol: string; hasOptions: boolean }) {
  const vol = useQuant<VolData>('/vol', { symbol }, { pollMs: 20000, enabled: hasOptions });
  const age = useAgeLabel(vol.fetchedAt);
  const d = vol.data;

  if (!hasOptions) return <EmptyNote>{symbol} has no options — perp realized vol lives in the Perps tab.</EmptyNote>;

  return (
    <div className="space-y-2">
      <ErrNote error={vol.error} />
      {!d && vol.loading && <EmptyNote>loading the vol-cycle brief…</EmptyNote>}
      {d && (
        <>
          <Panel
            title={`${symbol} Volatility Regime`}
            sub={d.verdict}
            right={
              <>
                <LiveDot ok={!vol.error} label={`live · ${age}`} />
                {d.dvol && <Pill tone="teal">dvol {d.dvol.currentPct.toFixed(1)}%</Pill>}
              </>
            }
          >
            <StatGrid
              cols={4}
              stats={[
                { label: 'cm30 iv (ours)', value: d.triangle.iv30Pct != null ? `${d.triangle.iv30Pct.toFixed(1)}%` : '—', tone: 'teal', sub: d.termFrontPct != null ? `front ${d.termFrontPct.toFixed(1)}%` : '' },
                { label: 'dvol index', value: d.triangle.dvolPct != null ? `${d.triangle.dvolPct.toFixed(1)}%` : '—', sub: d.dvol?.changePct != null ? `${d.dvol.changePct >= 0 ? '+' : ''}${d.dvol.changePct.toFixed(1)}% session` : 'deribit 30d implied' },
                { label: 'rv30', value: d.triangle.rv30Pct != null ? `${d.triangle.rv30Pct.toFixed(1)}%` : '—', sub: 'realized (daily)' },
                { label: 'iv − rv spread', value: d.triangle.spreadIvRv != null ? `${d.triangle.spreadIvRv >= 0 ? '+' : ''}${d.triangle.spreadIvRv.toFixed(1)} pts` : '—', tone: (d.triangle.spreadIvRv ?? 0) >= 0 ? 'rose' : 'emerald', sub: (d.triangle.spreadIvRv ?? 0) >= 0 ? 'insurance rich' : 'options cheap vs moves' },
              ]}
            />
          </Panel>

          <div className="grid gap-2 xl:grid-cols-[minmax(280px,360px)_1fr]">
            <Panel title="IV Rank" sub={d.ivStats?.note ?? 'own snapshot history'}>
              {d.ivStats ? (
                <>
                  <RankBar rank={d.ivStats.rank} label="cm30 percentile" sub={`current ${d.ivStats.currentPct.toFixed(1)}% · mean ${Number.isFinite(d.ivStats.meanPct) ? d.ivStats.meanPct.toFixed(1) : '—'}% · range ${Number.isFinite(d.ivStats.minPct) ? `${d.ivStats.minPct.toFixed(1)}–${d.ivStats.maxPct.toFixed(1)}%` : '—'}`} />
                  <div className="mt-3 space-y-1">
                    {[
                      { label: 'p75', v: d.ivStats.p75Pct, cls: 'bg-amber-500/40' },
                      { label: 'p50', v: d.ivStats.p50Pct, cls: 'bg-zinc-400/50' },
                      { label: 'p25', v: d.ivStats.p25Pct, cls: 'bg-emerald-500/40' },
                    ].map((b) =>
                      Number.isFinite(b.v) ? (
                        <div key={b.label} className="flex items-center gap-2">
                          <span className="w-6 font-mono text-[8px] text-zinc-600">{b.label}</span>
                          <div className="h-1.5 flex-1 rounded-full bg-zinc-900">
                            <div className={`h-full rounded-full ${b.cls}`} style={{ width: `${Math.min(100, (b.v / (d.ivStats!.maxPct || 100)) * 100)}%` }} />
                          </div>
                          <span className="w-10 text-right font-mono text-[8.5px] text-zinc-400">{b.v.toFixed(1)}%</span>
                        </div>
                      ) : null,
                    )}
                  </div>
                </>
              ) : (
                <EmptyNote>history is accumulating — the engine persists a snapshot every 2 minutes</EmptyNote>
              )}
            </Panel>

            <Panel title="CM30 IV History" sub="our own constant-maturity 30d IV · hover to probe">
              {d.ivStats && d.ivStats.series.length > 3 ? (
                <CrosshairChart
                  height={190}
                  yFormat={(v) => `${v.toFixed(1)}%`}
                  xFormat={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  bands={Number.isFinite(d.ivStats.p25Pct) && Number.isFinite(d.ivStats.p75Pct) ? [{ y: d.ivStats.p25Pct, y2: d.ivStats.p75Pct, color: '#2dd4bf', label: 'p25–p75' }] : undefined}
                  series={[{ label: 'cm30 iv', points: d.ivStats.series.map((p) => ({ x: p.ts, y: p.ivPct })) }]}
                />
              ) : (
                <EmptyNote>{d.ivStats ? `${d.ivStats.points} snapshots so far — grows every 2 minutes while the engine runs` : 'collecting…'}</EmptyNote>
              )}
            </Panel>
          </div>

          <div className="grid gap-2 xl:grid-cols-2">
            <Panel title="Realized-Vol Cone" sub="each window vs its own history — is realized itself cheap or rich?">
              <VolCone windows={d.cone} ivPct={d.triangle.iv30Pct} />
            </Panel>

            <Panel
              title="DVOL vs our CM30"
              sub={d.dvol?.source ?? 'deribit volatility index'}
              right={d.dvol && d.dvol.series.length > 3 ? <Pill tone="teal">{d.dvol.series.length} prints</Pill> : undefined}
            >
              {d.dvol && d.dvol.series.length > 3 ? (
                <CrosshairChart
                  height={190}
                  yFormat={(v) => v.toFixed(1)}
                  xFormat={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  series={[{ label: 'dvol', points: d.dvol.series.map((p) => ({ x: p.ts, y: p.v })) }]}
                />
              ) : (
                <EmptyNote>
                  {d.dvol ? 'DVOL trading history is still building up (cached across refreshes)' : 'DVOL unavailable right now'}
                  {d.dvol && d.dvol.series.length <= 3 ? ` · current ${d.dvol.currentPct.toFixed(1)}%` : ''}
                </EmptyNote>
              )}
              {d.triangle.spreadIvDvol != null && Number.isFinite(d.triangle.spreadIvDvol) && (
                <p className="mt-1.5 font-mono text-[9px] text-zinc-500">
                  our cm30 − dvol: <span className={d.triangle.spreadIvDvol >= 0 ? 'text-teal-300' : 'text-amber-300'}>{d.triangle.spreadIvDvol >= 0 ? '+' : ''}{d.triangle.spreadIvDvol.toFixed(2)} pts</span> — the index tracks the 30d implied we compute independently
                </p>
              )}
            </Panel>
          </div>

          <Panel title="Term Anchor" sub="front ATM vs constant-maturity 30d — the shape signal">
            <StatGrid
              cols={3}
              stats={[
                { label: 'front atm iv', value: d.termFrontPct != null ? `${d.termFrontPct.toFixed(1)}%` : '—' },
                { label: 'cm30 iv', value: d.termCm30Pct != null ? `${d.termCm30Pct.toFixed(1)}%` : '—', tone: 'teal' },
                {
                  label: 'shape',
                  value: d.termFrontPct != null && d.termCm30Pct != null ? (d.termFrontPct - d.termCm30Pct > 1.5 ? 'BACKWARDATION' : d.termCm30Pct - d.termFrontPct > 1.5 ? 'CONTANGO' : 'FLAT') : '—',
                  tone: d.termFrontPct != null && d.termCm30Pct != null && d.termFrontPct - d.termCm30Pct > 1.5 ? 'rose' : 'zinc',
                  sub: d.termFrontPct != null && d.termCm30Pct != null ? `${(d.termFrontPct - d.termCm30Pct >= 0 ? '+' : '')}${(d.termFrontPct - d.termCm30Pct).toFixed(1)} pts` : '',
                },
              ]}
            />
          </Panel>
        </>
      )}
    </div>
  );
}

'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-prob — Probability: the risk-neutral PDF (Breeden–
// Litzenberger) with an interactive price-level probe + surface across
// expiries. Also the greeks/TRACE panel.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { fmtNum } from '@/lib/format';
import { useQuant } from './use-quant';
import { ChartLegend, EmptyNote, ErrNote, HeatMatrix, LineChart, Panel, Pill, Segmented, StatGrid } from './quant-viz';

interface ProbSlice {
  expiry: string;
  dte: number;
  strikes: number[];
  density: number[];
  cdf: number[];
  mode: number;
  p1: number;
  p3: number;
  expected: number;
  mass: number;
  levelPrice?: number;
  pAbove?: number;
  pBelow?: number;
}
interface ProbData {
  spot: number;
  perExpiry: ProbSlice[];
  surface: { strikes: number[]; slices: { expiry: string; dte: number; density: number[] }[] };
  method: string;
}

function interpCdf(slice: ProbSlice, x: number): number {
  const k = slice.strikes;
  const c = slice.cdf;
  if (!k.length) return NaN;
  if (x <= k[0]) return 0;
  if (x >= k[k.length - 1]) return 1;
  let lo = 0,
    hi = k.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k[mid] > x) hi = mid;
    else lo = mid;
  }
  const t = (x - k[lo]) / (k[hi] - k[lo] || 1);
  return c[lo] + t * (c[hi] - c[lo]);
}

export function ProbabilityPanel({ symbol, hasOptions }: { symbol: string; hasOptions: boolean }) {
  if (!hasOptions) return <EmptyNote>{symbol} has no options chain — the risk-neutral PDF needs live marks (BTC/ETH).</EmptyNote>;
  const [expiry, setExpiry] = useState('');
  const { data, loading, error } = useQuant<ProbData>('/probability', { symbol }, { pollMs: 10000 });
  const slices = data?.perExpiry ?? [];
  const active = expiry ? slices.find((s) => s.expiry === expiry) : slices[0];
  const spot = data?.spot ?? 0;
  const [level, setLevel] = useState<string>('');

  const probe = Number(level.replace(/,/g, ''));
  const pBelow = active && Number.isFinite(probe) && probe > 0 ? interpCdf(active, probe) : null;

  return (
    <div className="space-y-2">
      <ErrNote error={error} />
      {slices.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {slices.slice(0, 8).map((s) => (
            <button
              key={s.expiry}
              onClick={() => setExpiry(s.expiry)}
              className={`rounded-md px-2 py-0.5 font-mono text-[9.5px] transition ${(expiry ? s.expiry === expiry : s === slices[0]) ? 'bg-zinc-800 text-teal-300 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {s.expiry.slice(5)} · {s.dte.toFixed(1)}d
            </button>
          ))}
        </div>
      )}
      {active && (
        <Panel
          title={`Risk-Neutral PDF · ${active.expiry}`}
          sub={`${active.dte.toFixed(1)}d · Breeden–Litzenberger on live marks`}
          right={<Pill tone="teal">market-implied</Pill>}
        >
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <label className="text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-600">probe level</label>
            <input
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              placeholder={fmtNum(active.mode ?? spot, 0)}
              inputMode="decimal"
              className="w-28 rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-1 font-mono text-[10.5px] text-zinc-200 outline-none focus:border-teal-700"
            />
            {pBelow != null && (
              <span className="flex items-center gap-2 font-mono text-[10px]">
                <span className="text-emerald-300">P(above) {(100 * (1 - pBelow)).toFixed(1)}%</span>
                <span className="text-zinc-600">·</span>
                <span className="text-rose-300">P(below) {(100 * pBelow).toFixed(1)}%</span>
              </span>
            )}
          </div>
          <LineChart
            height={200}
            yFormat={(v) => v.toFixed(2)}
            series={[{ label: 'density', points: active.strikes.map((k, i) => ({ x: k, y: active.density[i] })) }]}
            xFormat={(v) => fmtNum(v, 0)}
            markers={[
              ...(Number.isFinite(active.mode) ? [{ x: active.mode, label: `mode ${fmtNum(active.mode, 0)}` }] : []),
              ...(Number.isFinite(probe) && probe > 0 ? [{ x: probe, label: 'probe' }] : []),
            ]}
          />
          <StatGrid
            cols={4}
            stats={[
              { label: 'mode', value: fmtNum(active.mode, 0), tone: 'teal', sub: 'peak of the distribution' },
              { label: 'risk-neutral mean', value: fmtNum(active.expected, 0), sub: 'forward-implied' },
              { label: '50% confidence band', value: `${fmtNum(active.p1, 0)} – ${fmtNum(active.p3, 0)}`, sub: 'interquartile' },
              { label: 'raw mass', value: active.mass.toFixed(2), sub: '<1 flags clipped arbitrage noise' },
            ]}
          />
          <p className="mt-2 text-[8.5px] leading-relaxed text-zinc-600">{data?.method}</p>
        </Panel>
      )}
      {!active && <EmptyNote>{loading ? 'computing density…' : 'no probability slice'}</EmptyNote>}
      {data?.surface?.slices?.length ? (
        <Panel title="Probability Surface" sub="density across expiries (darker = higher density)">
          <HeatMatrix
            rows={data.surface.strikes.slice(0, 24).map((s) => fmtNum(s, 0))}
            cols={data.surface.slices.slice(0, 8).map((s) => s.expiry.slice(5))}
            values={data.surface.slices.slice(0, 8).map((s) => s.density.slice(0, 24))}
            format={(v) => (v >= 0.001 ? v.toFixed(3) : '')}
            colorFn={(v) => {
              const t = Math.min(v / 0.004, 1);
              return `rgba(167, 139, 250, ${(0.05 + t * 0.8).toFixed(3)})`;
            }}
          />
        </Panel>
      ) : null}
    </div>
  );
}

// ── greeks & TRACE ───────────────────────────────────────────────────────────

const GREEK_OPTS = [
  { id: 'gamma', label: 'Γ Gamma' },
  { id: 'vanna', label: 'Vanna' },
  { id: 'charm', label: 'Charm' },
  { id: 'vega', label: 'Vega' },
  { id: 'theta', label: 'Θ Theta' },
  { id: 'delta', label: 'Δ Delta' },
] as const;

export function GreeksPanel({ symbol, hasOptions }: { symbol: string; hasOptions: boolean }) {
  const [greek, setGreek] = useState<'gamma' | 'vanna' | 'charm' | 'vega' | 'theta' | 'delta'>('gamma');
  const [view, setView] = useState<'profile' | 'trace' | 'surface'>('profile');
  if (!hasOptions) return <EmptyNote>{symbol} has no options chain — greeks need the Deribit chain (BTC/ETH).</EmptyNote>;
  const profile = useQuant<{ greek: string; spot: number; profile: { strike: number; call: number; put: number; net: number }[]; unit: string }>('/greeks', { symbol, greek, view: 'profile' }, { pollMs: 12000, enabled: view === 'profile' });
  const trace = useQuant<{ greek: string; spot: number; spotGrid: number[]; timeShiftsPct: number[]; net: number[][]; flips: (number | null)[]; note: string }>('/greeks', { symbol, greek: 'gamma', view: 'trace' }, { pollMs: 20000, enabled: view === 'trace' });
  const surface = useQuant<{ greek: string; spot: number; strikes: number[]; expiries: string[]; grid: number[][] }>('/greeks', { symbol, greek, view: 'surface' }, { pollMs: 25000, enabled: view === 'surface' });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={greek} onChange={setGreek} options={GREEK_OPTS.map((g) => ({ id: g.id, label: g.label }))} />
        <Segmented value={view} onChange={setView} options={[{ id: 'profile', label: 'Profile' }, { id: 'trace', label: 'TRACE Map' }, { id: 'surface', label: 'Surface' }]} />
      </div>

      {view === 'profile' && (
        <Panel title={`Dealer ${greek} Exposure by Strike`} sub="calls + / puts − (customer-flow convention)" right={<Pill tone="teal">live</Pill>}>
          <ErrNote error={profile.error} />
          {profile.data?.profile?.length ? (
            <div className="space-y-0.5">
              {profile.data.profile
                .filter((p) => Math.abs(p.net) > 0)
                .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
                .slice(0, 18)
                .map((p) => {
                  const max = Math.max(...profile.data!.profile.map((x) => Math.abs(x.net)), 1);
                  const w = (Math.abs(p.net) / max) * 50;
                  return (
                    <div key={p.strike} className="flex items-center gap-1.5">
                      <span className="w-16 shrink-0 text-right font-mono text-[9px] text-zinc-500">{fmtNum(p.strike, 0)}</span>
                      <div className="relative h-3 flex-1">
                        <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
                        {p.net >= 0 ? (
                          <div className="absolute left-1/2 top-0 h-full rounded-sm bg-teal-500/70" style={{ width: `${w}%` }} />
                        ) : (
                          <div className="absolute right-1/2 top-0 h-full rounded-sm bg-rose-500/70" style={{ width: `${w}%` }} />
                        )}
                      </div>
                      <span className={`w-24 shrink-0 text-right font-mono text-[9px] ${p.net >= 0 ? 'text-teal-300' : 'text-rose-300'}`}>
                        {(Math.abs(p.net) >= 1e6 ? `${(p.net / 1e6).toFixed(2)}M` : `${(p.net / 1e3).toFixed(1)}k`)}
                      </span>
                    </div>
                  );
                })}
            </div>
          ) : (
            <EmptyNote>{profile.loading ? 'computing…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}

      {view === 'trace' && (
        <Panel title="Greek TRACE · Gamma Forward Map" sub="net dealer gamma (USD / 1% move) across spot ±12% × time decay" right={<Pill tone="violet">projection</Pill>}>
          <ErrNote error={trace.error} />
          {trace.data?.spotGrid?.length ? (
            <>
              <HeatMatrix
                rows={trace.data.spotGrid.map((s) => `${((s / trace.data!.spot - 1) * 100).toFixed(0)}%`)}
                cols={trace.data.timeShiftsPct.map((t) => `t+${(t * 100).toFixed(0)}%`)}
                values={trace.data.net}
                format={(v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}` : `${(v / 1e3).toFixed(0)}k`)}
                height={16}
              />
              <div className="mt-2 space-y-1">
                {trace.data.flips.map((f, i) => (
                  <p key={i} className="font-mono text-[9px] text-zinc-400">
                    <span className="text-violet-300">t+{(trace.data!.timeShiftsPct[i] * 100).toFixed(0)}%</span> flip →{' '}
                    <span className={f != null ? 'text-amber-300' : 'text-zinc-600'}>{f != null ? fmtNum(f, 0) : 'outside grid'}</span>
                  </p>
                ))}
              </div>
              <p className="mt-1 text-[8.5px] text-zinc-600">{trace.data.note}</p>
            </>
          ) : (
            <EmptyNote>{trace.loading ? 'projecting…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}

      {view === 'surface' && (
        <Panel title={`Dealer ${greek} Surface`} sub="strike × expiry exposure grid">
          <ErrNote error={surface.error} />
          {surface.data?.strikes?.length ? (
            <HeatMatrix
              rows={surface.data.strikes.slice(0, 22).map((s) => fmtNum(s, 0))}
              cols={surface.data.expiries.slice(0, 12).map((e) => e.slice(5))}
              values={surface.data.grid.slice(0, 12).map((row) => row.slice(0, 22))}
              format={(v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(1))}
            />
          ) : (
            <EmptyNote>{surface.loading ? 'computing…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}
      <ChartLegend series={[{ label: 'teal = dealers long (stabilizing)', color: '#2dd4bf' }, { label: 'rose = dealers short (amplifying)', color: '#fb7185' }]} />
    </div>
  );
}

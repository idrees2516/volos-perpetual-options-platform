'use client';

// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — ProjectionPanel ("what everything will be at that price")
//
// The companion readout for the forward fan: for the projected price path,
// every related part of the market at ¼ / ½ / ¾ / full horizon —
//
//   price      point, conformal band lo/hi, Ensemble cross-check
//   momentum   RSI(14) · MACD hist · Bollinger %B
//   trend      EMA(21) · SMA(50)
//   volatility ATR(14) · realized σ · expected-move % per step
//   flow       volume · aggressor delta · CVD · buy share · prints · OI
//
// All values are "based on current and previous data": history rolls the
// indicator state forward through the forecast path; flow targets carry
// their own conformal bands; P(up) is the empirical h-step climatology.
// ─────────────────────────────────────────────────────────────────────────────

import { Crosshair, Sigma } from 'lucide-react';
import type { FcIndicatorBlock, FcMetricBlock, FcProjectedState } from '@/lib/forecast/state';
import { useProjection, type ProjectionConfig } from './use-projection';

interface Props {
  /** externally supplied state (orderflow view shares the chart's fetch) */
  data?: FcProjectedState | null;
  loading?: boolean;
  error?: string | null;
  /** self-fetch mode (forecast view passes its config) */
  ownConfig?: ProjectionConfig;
}

const DEFAULT_CFG: ProjectionConfig = { asset: 'BTC', tf: 60_000, h: 30, levels: [80, 95], nWindows: 10 };

interface Row {
  id: string;
  label: string;
  unit: string;
  now: number | null;
  vals: (number | null)[];
  deltaPct: number | null;
  note?: string;
}

function fmt(unit: string, v: number | null, id?: string): string {
  if (v === null || !Number.isFinite(v)) return '–';
  if (id === 'imbalance' || unit === 'share') return `${(v * 100).toFixed(1)}%`;
  switch (unit) {
    case 'usd': {
      const a = Math.abs(v);
      if (a >= 10_000) return v.toFixed(0);
      if (a >= 100) return v.toFixed(1);
      return v.toFixed(2);
    }
    case 'base': {
      const a = Math.abs(v);
      if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
      if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
      if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
      if (a >= 100) return v.toFixed(0);
      return v.toFixed(2);
    }
    case 'count':
      return v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(0);
    case 'ratio':
      return v.toFixed(2);
    default:
      return v.toFixed(1);
  }
}

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '–';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function indicatorRow(b: FcIndicatorBlock, quarters: number[]): Row {
  const at = (step: number) => {
    const i = Math.min(step, b.projected.length) - 1;
    const v = b.projected[i];
    return Number.isFinite(v) ? v : null;
  };
  const last = at(quarters[quarters.length - 1]);
  return {
    id: b.id,
    label: b.label,
    unit: b.unit,
    now: b.now,
    vals: quarters.map(at),
    deltaPct:
      b.now !== null && last !== null && b.now !== 0 && b.unit === 'usd' ? ((last - b.now) / b.now) * 100 : null,
    note: b.note,
  };
}

function metricRow(b: FcMetricBlock, quarters: number[]): Row {
  const at = (step: number) => {
    const r = b.rows[Math.min(step, b.rows.length) - 1];
    const v = r?.v;
    return v !== undefined && Number.isFinite(v) ? v : null;
  };
  const last = at(quarters[quarters.length - 1]);
  return {
    id: b.id,
    label: b.label,
    unit: b.unit,
    now: b.now,
    vals: quarters.map(at),
    deltaPct:
      b.now !== null && last !== null && b.now !== 0 && b.unit !== 'ratio' ? ((last - b.now) / Math.abs(b.now)) * 100 : null,
    note: b.note,
  };
}

const GROUPS: Array<{ label: string; ids?: string[]; unit?: string }> = [
  { label: 'price', unit: 'price-group' },
  { label: 'momentum', ids: ['rsi14', 'macdHist', 'pctB'] },
  { label: 'trend', ids: ['ema21', 'sma50'] },
  { label: 'volatility', ids: ['atr14', 'rvol', 'expmove'] },
  {
    label: 'flow',
    ids: ['volume', 'delta', 'cvd', 'imbalance', 'trades', 'oi'],
  },
];

export function ProjectionPanel({ data, loading, error, ownConfig }: Props) {
  const own = useProjection(ownConfig ?? DEFAULT_CFG, !!ownConfig && !data);
  const st = data ?? own.data;
  const err = error ?? own.error;
  const ld = loading ?? (ownConfig ? own.loading : false);

  const quarters = st ? [1, 2, 3, 4].map((q) => Math.max(1, Math.round((st.h * q) / 4))) : [];

  const rows: Row[] = [];
  if (st) {
    const s = st;
    const widest = s.levels[s.levels.length - 1] ?? 95;
    const rowAt = (step: number, sel: (r: (typeof s.price.rows)[number]) => number) => {
      const r = s.price.rows[Math.min(step, s.price.rows.length) - 1];
      const v = r ? sel(r) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    const pointAt = (step: number) => rowAt(step, (r) => r.point);
    const loAt = (step: number) => rowAt(step, (r) => r.lo);
    const hiAt = (step: number) => rowAt(step, (r) => r.hi);
    rows.push(
      {
        id: 'point',
        label: 'point',
        unit: 'price-group',
        now: st.cutoff.price,
        vals: quarters.map((q) => pointAt(q)),
        deltaPct: st.drift.pct,
        note: `${st.price.primary} · ${st.price.modelLabel}`,
      },
      {
        id: 'band-lo',
        label: `band lo ${widest}%`,
        unit: 'price-group',
        now: null,
        vals: quarters.map((q) => loAt(q)),
        deltaPct: null,
        note: 'conformal lower bound',
      },
      {
        id: 'band-hi',
        label: `band hi ${widest}%`,
        unit: 'price-group',
        now: null,
        vals: quarters.map((q) => hiAt(q)),
        deltaPct: null,
        note: 'conformal upper bound',
      },
    );
    if (st.price.ensemble.length) {
      const ensAt = (step: number) => {
        const i = Math.min(step, st.price.ensemble.length) - 1;
        const v = st.price.ensemble[i];
        return Number.isFinite(v) ? v : null;
      };
      rows.push({
        id: 'ensemble',
        label: 'ensemble point',
        unit: 'price-group',
        now: st.cutoff.price,
        vals: quarters.map((q) => ensAt(q)),
        deltaPct: null,
        note: `cross-check · ${st.price.ensembleNote || 'Ensemble-error'}`,
      });
    }
    for (const b of st.indicators) rows.push(indicatorRow(b, quarters));
    rows.push(
      {
        id: 'atr14',
        label: 'ATR(14)',
        unit: 'usd',
        now: st.volatility.atr14,
        vals: quarters.map(() => st.volatility.atr14),
        deltaPct: null,
        note: 'carried flat — future range is unknown, bands carry the dispersion',
      },
      {
        id: 'rvol',
        label: 'realized σ',
        unit: 'ratio',
        now: st.volatility.realizedVolPct,
        vals: quarters.map(() => st.volatility.realizedVolPct),
        deltaPct: null,
        note: 'per-bar σ of log returns, % — historical, carried flat',
      },
      {
        id: 'expmove',
        label: 'exp move %/step',
        unit: 'ratio',
        now: null,
        vals: quarters.map((q) => {
          const i = Math.min(q, st.volatility.expectedMovePctPerStep.length) - 1;
          const v = st.volatility.expectedMovePctPerStep[i];
          return Number.isFinite(v) ? v : null;
        }),
        deltaPct: null,
        note: 'band width ÷ point per step, %',
      },
    );
    for (const b of st.metrics) rows.push(metricRow(b, quarters));
  }

  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/70 px-2 py-1.5">
        <span className="flex items-center gap-1.5">
          <Sigma className="h-3.5 w-3.5 text-teal-400" />
          <span className="text-[11px] font-semibold tracking-tight text-zinc-100">Projected state</span>
        </span>
        {st && (
          <span className="font-mono text-[9px] text-zinc-500">
            {st.asset} · {st.tf / 60_000}m · h={st.h} ({(st.h * st.tf) / 60_000}m ahead) · {st.price.primary}
          </span>
        )}
        {st?.expectedMove && (
          <span className="rounded bg-amber-950/50 px-1.5 py-0.5 font-mono text-[9px] text-amber-300 ring-1 ring-amber-500/30">
            expected move ±{st.expectedMove.widthPct?.toFixed(2)}% · {fmt('usd', st.expectedMove.lo)}–{fmt('usd', st.expectedMove.hi)} ({st.expectedMove.level}%)
          </span>
        )}
        {st && st.pUp !== null && (
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400" title="empirical share of historical h-step moves that ended up">
            P(up) {(st.pUp * 100).toFixed(0)}%
          </span>
        )}
        {st && st.drift.pct !== null && (
          <span className={`font-mono text-[9px] ${st.drift.pct >= 0 ? 'text-teal-300' : 'text-rose-400'}`}>
            drift {pct(st.drift.pct)} ({st.drift.abs !== null ? fmt('usd', st.drift.abs) : '–'})
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[8.5px] text-zinc-600">
          {ld && <span className="animate-pulse text-amber-400">building…</span>}
          {err && !st && <span className="text-rose-400">{err}</span>}
          {st && (
            <span title={`klines ${st.provenance.klinesBars} · engine ${st.provenance.engineBars} · ${st.provenance.klineSource}`}>
              {st.provenance.klinesBars + st.provenance.engineBars} bars
              {st.provenance.klineError ? ' · kline ✕' : ''}
              {st.provenance.oiBars ? ` · oi ${st.provenance.oiBars}` : ''}
            </span>
          )}
        </span>
      </div>

      {!st && !ld && err && (
        <div className="flex items-center gap-2 px-3 py-3 text-[10px] text-zinc-500">
          <Crosshair className="h-3.5 w-3.5 text-rose-400" />
          projected state unavailable — {err}
        </div>
      )}
      {!st && !err && ld && <div className="px-3 py-3 text-[10px] text-zinc-600">building projected state…</div>}

      {/* table */}
      {st && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse font-mono text-[9.5px]">
            <thead>
              <tr className="text-zinc-600">
                <th className="px-2 py-1 text-left font-normal">metric</th>
                <th className="px-2 py-1 text-right font-normal">now</th>
                {quarters.map((q, i) => (
                  <th key={q + `${i}`} className="px-2 py-1 text-right font-normal" title={`step ${q}`}>
                    +{q}
                    {i === quarters.length - 1 ? ' (h)' : ''}
                  </th>
                ))}
                <th className="px-2 py-1 text-right font-normal">Δ</th>
              </tr>
            </thead>
            <tbody>
              {GROUPS.flatMap((g) => {
                const gr = g.unit
                  ? rows.filter((r) => r.unit === g.unit)
                  : rows.filter((r) => g.ids!.includes(r.id));
                if (!gr.length) return [];
                return [
                  <tr key={`g-${g.label}`} className="bg-zinc-900/40">
                    <td colSpan={3 + quarters.length} className="px-2 py-0.5 text-[8px] uppercase tracking-[0.14em] text-teal-500/80">
                      {g.label}
                    </td>
                  </tr>,
                  ...gr.map((r) => (
                    <tr key={r.label} className="border-t border-zinc-900/60 hover:bg-zinc-900/30">
                      <td className="px-2 py-[3px] text-zinc-400" title={r.note ?? ''}>
                        {r.label}
                      </td>
                      <td className="px-2 py-[3px] text-right text-zinc-200">{fmt(r.unit, r.now, r.id)}</td>
                      {r.vals.map((v, i) => (
                        <td
                          key={i}
                          className={`px-2 py-[3px] text-right ${
                            r.id === 'band-lo' ? 'text-rose-300/80' : r.id === 'band-hi' ? 'text-teal-300/80' : 'text-zinc-200'
                          }`}
                        >
                          {fmt(r.unit, v, r.id)}
                        </td>
                      ))}
                      <td
                        className={`px-2 py-[3px] text-right ${
                          r.deltaPct === null ? 'text-zinc-600' : r.deltaPct >= 0 ? 'text-teal-300' : 'text-rose-400'
                        }`}
                      >
                        {r.deltaPct === null ? '–' : pct(r.deltaPct)}
                      </td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
          <div className="px-2 py-1 text-[8px] text-zinc-600">
            values roll history forward through the projected price path · flow targets carry their own conformal bands ·
            P(up) = empirical climatology of {st.h}-step moves · built{' '}
            {st.builtAt ? new Date(st.builtAt).toLocaleTimeString() : '–'}
          </div>
        </div>
      )}
    </div>
  );
}

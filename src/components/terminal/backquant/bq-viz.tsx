'use client';

// -----------------------------------------------------------------------------
// backquant/bq-viz — shared visualization primitives for the BackQuant
// workspace: panel shells, stat tiles, heat matrices (strike × expiry grids),
// level strips (spot vs HVL/walls), recharts series charts and mode badges.
// Styled to match the VolOS terminal (zinc-950, teal accents, dense mono).
// -----------------------------------------------------------------------------

import React from 'react';
import { Loader2, RefreshCw, Radio, FlaskConical, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import {
  ResponsiveContainer, LineChart as RLineChart, AreaChart as RAreaChart, ComposedChart,
  Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Bar, ReferenceLine,
} from 'recharts';
import type { BqState } from './use-bq';

// ── formatting ───────────────────────────────────────────────────────────────

export const fmtUsd = (v: unknown): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}k`;
  return `${sign}$${a.toFixed(0)}`;
};

export const fmtNum = (v: unknown, dp = 2): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return n.toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: 0 });
};

export const fmtPx = (v: unknown): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 });
};

export const fmtPct = (v: unknown, dp = 1): string => {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(dp)}%` : '—';
};

export const fmtTime = (ts: unknown): string => {
  if (typeof ts !== 'string' && typeof ts !== 'number') return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-US', { hour12: false });
};

export const fmtDate = (ts: unknown): string => {
  if (typeof ts !== 'string') return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// ── panel shell ──────────────────────────────────────────────────────────────

export function Panel({
  title,
  subtitle,
  right,
  mode,
  children,
  className = '',
  loading,
  error,
  onRefresh,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  mode?: 'live' | 'demo' | 'unknown';
  children: React.ReactNode;
  className?: string;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}) {
  return (
    <section className={`overflow-hidden rounded-lg border border-zinc-800/70 bg-zinc-900/30 ${className}`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800/60 bg-zinc-900/50 px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-300">{title}</p>
          {subtitle ? <p className="truncate text-[9px] text-zinc-500">{subtitle}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {right}
          {mode ? <ModeBadge mode={mode} /> : null}
          {onRefresh ? (
            <button
              onClick={onRefresh}
              title="Refresh"
              className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </header>
      <div className="relative min-h-[60px] p-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[10px] text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading BackQuant data…
          </div>
        ) : error ? (
          <div className="rounded border border-rose-900/50 bg-rose-950/20 px-2 py-1.5 text-[10px] text-rose-300">{error}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export function ModeBadge({ mode, small }: { mode: 'live' | 'demo' | 'unknown'; small?: boolean }) {
  if (mode === 'unknown') return null;
  const live = mode === 'live';
  return (
    <span
      title={live ? 'Live BackQuant API (BACKQUANT_API_KEY active)' : 'Demo engine — BackQuant-compatible simulation anchored on live spot. Add BACKQUANT_API_KEY for live data.'}
      className={`flex items-center gap-1 rounded-full px-1.5 py-px font-bold uppercase tracking-wider ring-1 ${
        small ? 'text-[7.5px]' : 'text-[8px]'
      } ${live ? 'bg-emerald-950/50 text-emerald-400 ring-emerald-500/30' : 'bg-amber-950/40 text-amber-400 ring-amber-500/30'}`}
    >
      {live ? <Radio className="h-2 w-2 animate-pulse" /> : <FlaskConical className="h-2 w-2" />}
      {live ? 'live' : 'demo'}
    </span>
  );
}

export function EmptyNote({ text }: { text: string }) {
  return <p className="py-4 text-center text-[10px] text-zinc-600">{text}</p>;
}

// ── stat tiles ───────────────────────────────────────────────────────────────

export function StatTiles({ stats, columns }: {
  stats: Array<{ label: string; value: string; delta?: string; deltaPositive?: boolean; hint?: string }>;
  columns?: number;
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns ?? Math.min(stats.length, 4)}, minmax(0, 1fr))` }}>
      {stats.map((s, i) => (
        <div key={i} className="rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-2">
          <p className="truncate text-[8.5px] font-medium uppercase tracking-wider text-zinc-500" title={s.label}>{s.label}</p>
          <p className="mt-0.5 truncate font-mono text-[15px] font-semibold tabular-nums text-zinc-100" title={s.value}>{s.value}</p>
          {s.delta ? (
            <p className={`mt-0.5 flex items-center gap-0.5 text-[9px] font-medium tabular-nums ${s.deltaPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {s.deltaPositive ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
              {s.delta}
            </p>
          ) : null}
          {s.hint ? <p className="mt-0.5 truncate text-[8.5px] leading-tight text-zinc-600" title={s.hint}>{s.hint}</p> : null}
        </div>
      ))}
    </div>
  );
}

// ── heat matrix (strike × expiry style grids) ────────────────────────────────

export function BqHeatMatrix({
  rowLabels,
  colLabels,
  matrix,
  unit,
  diverging = true,
  format,
  rowTitle,
}: {
  rowLabels: string[];
  colLabels: string[];
  matrix: number[][];
  unit?: string;
  diverging?: boolean;
  format?: (v: number) => string;
  rowTitle?: string;
}) {
  const flat = matrix.flat().filter((v) => Number.isFinite(v));
  if (!flat.length) return <EmptyNote text="no matrix data" />;
  const maxAbs = Math.max(...flat.map(Math.abs), 1e-9);
  const fmt = format ?? ((v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : `${Math.round(v * 100) / 100}`));
  const cellStyle = (v: number): React.CSSProperties => {
    if (!Number.isFinite(v)) return { background: 'rgba(63,63,70,0.25)' };
    if (diverging) {
      const t = Math.min(Math.abs(v) / maxAbs, 1);
      return { background: v >= 0 ? `rgba(45,212,191,${0.1 + t * 0.6})` : `rgba(251,113,133,${0.1 + t * 0.6})` };
    }
    const t = Math.min(Math.max(v / maxAbs, 0), 1);
    return { background: `rgba(251,191,36,${0.06 + t * 0.66})` };
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] border-separate border-spacing-[2px] text-[9px]">
        <thead>
          <tr>
            <th className="px-1 text-left text-[8px] font-medium uppercase tracking-wider text-zinc-600">{rowTitle ?? 'strike'}</th>
            {colLabels.map((c, i) => (
              <th key={i} className="px-1 font-medium text-zinc-500" title={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowLabels.map((r, ri) => (
            <tr key={ri}>
              <td className="whitespace-nowrap px-1 text-right font-mono tabular-nums text-zinc-400" title={r}>{r}</td>
              {colLabels.map((_, ci) => {
                const v = matrix[ri]?.[ci];
                return (
                  <td
                    key={ci}
                    className="rounded-[2px] px-1 py-[4px] text-center font-mono tabular-nums text-zinc-200"
                    style={cellStyle(v)}
                    title={`${r} × ${colLabels[ci]}: ${v != null ? fmt(v) : '—'}${unit ? ` ${unit}` : ''}`}
                  >
                    {v != null ? fmt(v) : '·'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {unit ? (
        <p className="mt-1.5 text-[8px] text-zinc-600">
          unit: {unit} · {diverging ? <><span className="text-teal-400">teal positive</span> / <span className="text-rose-400">rose negative</span></> : 'intensity scale'}
        </p>
      ) : null}
    </div>
  );
}

// ── level strip (spot vs HVL / walls / support) ──────────────────────────────

const LEVEL_TONES: Record<string, { bar: string; text: string; label: string }> = {
  wall: { bar: 'bg-rose-500/80', text: 'text-rose-300', label: 'call wall' },
  support: { bar: 'bg-teal-500/80', text: 'text-teal-300', label: 'put support' },
  flip: { bar: 'bg-amber-500/80', text: 'text-amber-300', label: 'gamma flip' },
  magnet: { bar: 'bg-violet-500/80', text: 'text-violet-300', label: 'max pain' },
};

export function BqLevelStrip({
  spot,
  levels,
  height = 150,
}: {
  spot: number;
  levels: Array<{ label: string; price: number; tone?: keyof typeof LEVEL_TONES }>;
  height?: number;
}) {
  const valid = levels.filter((l) => Number.isFinite(l.price) && l.price > 0);
  if (!valid.length || !Number.isFinite(spot)) return <EmptyNote text="no levels" />;
  const all = [...valid.map((l) => l.price), spot];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = (max - min) * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const pos = (p: number) => ((p - lo) / (hi - lo)) * 100;
  const gridCount = 5;
  return (
    <div className="select-none">
      <div className="relative w-full" style={{ height }}>
        {/* horizontal gridlines with price labels */}
        {Array.from({ length: gridCount }, (_, i) => {
          const p = lo + ((hi - lo) * i) / (gridCount - 1);
          return (
            <div key={i} className="absolute left-0 right-0 flex items-center" style={{ bottom: `${(i / (gridCount - 1)) * 100}%` }}>
              <div className="h-px flex-1 bg-zinc-800/50" />
              <span className="ml-1 font-mono text-[8px] tabular-nums text-zinc-600">{fmtPx(p)}</span>
            </div>
          );
        })}
        {/* level bars */}
        {valid.map((l, i) => {
          const tone = LEVEL_TONES[l.tone ?? ''] ?? { bar: 'bg-zinc-500/70', text: 'text-zinc-300' };
          const bottomPct = Math.min(Math.max(pos(l.price), 2), 98);
          return (
            <div key={i} className="absolute left-0 right-[46px]" style={{ bottom: `${bottomPct}%`, transform: 'translateY(50%)' }}>
              <div className={`h-[3px] w-full rounded-full ${tone.bar} opacity-80`} />
              <span className={`absolute left-1 -translate-y-[130%] whitespace-nowrap rounded bg-zinc-900/90 px-1 text-[8.5px] font-medium ${tone.text}`}>
                {l.label} · <span className="font-mono tabular-nums">{fmtPx(l.price)}</span>
              </span>
            </div>
          );
        })}
        {/* spot */}
        <div className="absolute bottom-0 top-0 right-[46px]" style={{ left: `${Math.min(Math.max(pos(spot), 0), 100)}%`, width: 0 }}>
          <div className="h-full w-[2px] bg-zinc-100 shadow-[0_0_8px_rgba(255,255,255,0.55)]" />
          <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-zinc-100 px-1.5 py-px text-[9px] font-bold text-zinc-950">
            SPOT {fmtPx(spot)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2.5 text-[8.5px] text-zinc-500">
        {Object.entries(LEVEL_TONES).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1">
            <span className={`h-[3px] w-4 rounded-full ${v.bar} opacity-80`} /> {v.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── recharts series chart ────────────────────────────────────────────────────

const AXIS_STYLE = { fontSize: 9, fill: '#71717a', fontFamily: 'ui-monospace, monospace' };
const GRID_STROKE = '#27272a';
const TOOLTIP_STYLE = {
  backgroundColor: '#09090b',
  border: '1px solid #3f3f46',
  borderRadius: 6,
  fontSize: 10,
  padding: '4px 8px',
};

export interface SeriesDef {
  key: string;
  color: string;
  name?: string;
  type?: 'line' | 'area' | 'bar';
  yAxis?: 'left' | 'right';
  dashed?: boolean;
  dot?: boolean;
}

export function BqSeriesChart({
  points,
  series,
  xKey = 'ts',
  xFormatter,
  height = 190,
  legend = true,
  yFormatter,
  rightFormatter,
  referenceY,
}: {
  points: Array<Record<string, unknown>>;
  series: SeriesDef[];
  xKey?: string;
  xFormatter?: (v: unknown, i: number) => string;
  height?: number;
  legend?: boolean;
  yFormatter?: (v: number) => string;
  rightFormatter?: (v: number) => string;
  referenceY?: number;
}) {
  if (!points.length || !series.length) return <EmptyNote text="no series data" />;
  const hasRight = series.some((s) => s.yAxis === 'right');
  const Chart = series.some((s) => s.type === 'area') ? RAreaChart : series.some((s) => s.type === 'bar') ? ComposedChart : RLineChart;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <Chart data={points} margin={{ top: 6, right: hasRight ? 6 : 10, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey={xKey}
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={{ stroke: GRID_STROKE }}
          tickFormatter={(v: unknown, i: number) => (xFormatter ? xFormatter(v, i) : String(v ?? ''))}
          minTickGap={40}
        />
        <YAxis
          yAxisId="left"
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={(v: number) => (yFormatter ? yFormatter(v) : fmtNum(v, 1))}
        />
        {hasRight ? (
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => (rightFormatter ? rightFormatter(v) : fmtNum(v, 2))}
          />
        ) : null}
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelStyle={{ color: '#a1a1aa', fontSize: 9 }}
          formatter={(v: unknown, n: string) => [typeof v === 'number' ? (yFormatter ? yFormatter(v) : fmtNum(v, 2)) : String(v), n]}
        />
        {legend ? <Legend wrapperStyle={{ fontSize: 9, paddingTop: 2 }} iconSize={8} /> : null}
        {referenceY != null ? <ReferenceLine y={referenceY} yAxisId="left" stroke="#52525b" strokeDasharray="4 3" /> : null}
        {series.map((s) =>
          s.type === 'bar' ? (
            <Bar key={s.key} yAxisId={s.yAxis ?? 'left'} dataKey={s.key} name={s.name ?? s.key} fill={s.color} isAnimationActive={false} />
          ) : s.type === 'area' ? (
            <Area
              key={s.key}
              yAxisId={s.yAxis ?? 'left'}
              dataKey={s.key}
              name={s.name ?? s.key}
              stroke={s.color}
              fill={s.color}
              fillOpacity={0.16}
              strokeWidth={1.6}
              isAnimationActive={false}
              dot={false}
            />
          ) : (
            <Line
              key={s.key}
              yAxisId={s.yAxis ?? 'left'}
              dataKey={s.key}
              name={s.name ?? s.key}
              stroke={s.color}
              strokeWidth={1.6}
              strokeDasharray={s.dashed ? '5 3' : undefined}
              dot={s.dot ? { r: 1.5, fill: s.color } : false}
              isAnimationActive={false}
            />
          ),
        )}
      </Chart>
    </ResponsiveContainer>
  );
}

export const CHART_COLORS = {
  teal: '#2dd4bf',
  rose: '#fb7185',
  amber: '#fbbf24',
  violet: '#a78bfa',
  sky: '#38bdf8',
  zinc: '#a1a1aa',
  emerald: '#34d399',
};

// ── small table helper ───────────────────────────────────────────────────────

export function BqTable({
  columns,
  rows,
  maxHeight = 320,
  dense = true,
}: {
  columns: Array<{ key: string; label: string; align?: 'left' | 'right'; render?: (row: Record<string, unknown>, v: unknown) => React.ReactNode }>;
  rows: Array<Record<string, unknown>>;
  maxHeight?: number;
  dense?: boolean;
}) {
  return (
    <div className="overflow-auto rounded-md border border-zinc-800/60" style={{ maxHeight }}>
      <table className="w-full text-[9.5px]">
        <thead className="sticky top-0 z-[1] bg-zinc-900/95 backdrop-blur">
          <tr className="border-b border-zinc-800/60 text-zinc-500">
            {columns.map((c) => (
              <th key={c.key} className={`whitespace-nowrap px-2 py-1 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-zinc-800/30 text-zinc-300 last:border-0 hover:bg-zinc-900/40">
              {columns.map((c) => {
                const v = r[c.key];
                return (
                  <td key={c.key} className={`whitespace-nowrap px-2 ${dense ? 'py-[3px]' : 'py-1'} tabular-nums ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                    {c.render ? c.render(r, v) : typeof v === 'number' ? fmtNum(v, 2) : v == null ? '—' : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <EmptyNote text="no rows" /> : null}
    </div>
  );
}

/** Helper: derive panel props from a useBq state. */
export function panelProps<T>(s: BqState<T>) {
  return {
    mode: s.mode === 'unknown' ? undefined : s.mode,
    loading: s.loading && !s.data,
    error: s.error,
    onRefresh: s.refresh,
  };
}

'use client';

// -----------------------------------------------------------------------------
// quantlab/quant-viz — shared visual primitives for the Quant Lab panels.
// Self-contained SVG charts (line/bar/heatmap/sparkline) in the terminal's
// dark teal design language — no chart library, no client data deps.
// -----------------------------------------------------------------------------

import React from 'react';
import { fmtUsd, fmtNum, heatColor } from '@/lib/format';

// ── chrome ───────────────────────────────────────────────────────────────────

export function Panel({ title, sub, right, children, className = '' }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-zinc-800/70 bg-zinc-900/30 ${className}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800/60 px-3 py-2">
        <h3 className="text-[11px] font-semibold tracking-tight text-zinc-200">{title}</h3>
        {sub && <span className="truncate text-[9px] text-zinc-600">{sub}</span>}
        <span className="ml-auto flex items-center gap-2">{right}</span>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Pill({ children, tone = 'zinc', title }: { children: React.ReactNode; tone?: 'zinc' | 'teal' | 'amber' | 'rose' | 'emerald' | 'violet'; title?: string }) {
  const tones: Record<string, string> = {
    zinc: 'bg-zinc-800/70 text-zinc-400 ring-zinc-700/50',
    teal: 'bg-teal-950/60 text-teal-300 ring-teal-500/30',
    amber: 'bg-amber-950/50 text-amber-300 ring-amber-500/30',
    rose: 'bg-rose-950/50 text-rose-300 ring-rose-500/30',
    emerald: 'bg-emerald-950/50 text-emerald-300 ring-emerald-500/30',
    violet: 'bg-violet-950/50 text-violet-300 ring-violet-500/30',
  };
  return (
    <span title={title} className={`rounded px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.12em] ring-1 ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function LiveDot({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className="flex items-center gap-1 text-[8.5px] font-bold uppercase tracking-[0.14em]">
      <span className={`relative flex h-1.5 w-1.5`}>
        {ok && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-500'}`} />
      </span>
      <span className={ok ? 'text-emerald-400' : 'text-rose-400'}>{label ?? (ok ? 'live' : 'offline')}</span>
    </span>
  );
}

export function ErrNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="rounded-md border border-rose-900/50 bg-rose-950/30 px-2 py-1.5 text-[10px] text-rose-300">{error}</p>;
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[10px] text-zinc-600">{children}</p>;
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-950/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`rounded px-2 py-0.5 text-[9.5px] font-medium transition ${value === o.id ? 'bg-zinc-800 text-teal-300 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── stats ────────────────────────────────────────────────────────────────────

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'teal' | 'rose' | 'amber' | 'emerald' | 'violet' | 'zinc' }) {
  const toneCls = tone === 'teal' ? 'text-teal-300' : tone === 'rose' ? 'text-rose-300' : tone === 'amber' ? 'text-amber-300' : tone === 'emerald' ? 'text-emerald-300' : tone === 'violet' ? 'text-violet-300' : 'text-zinc-100';
  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-2">
      <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-600">{label}</p>
      <p className={`mt-0.5 font-mono text-[13px] font-semibold leading-tight ${toneCls}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[8.5px] leading-tight text-zinc-500">{sub}</p>}
    </div>
  );
}

export interface StatSpec {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'teal' | 'rose' | 'amber' | 'emerald' | 'violet' | 'zinc';
}

export function StatGrid({ stats, cols = 4 }: { stats: StatSpec[]; cols?: number }) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${cols >= 4 ? 118 : 150}px, 1fr))` }}>
      {stats.map((s) => (
        <Stat key={s.label} {...s} />
      ))}
    </div>
  );
}

// ── level strip: spot vs key prices ─────────────────────────────────────────

export function LevelStrip({ spot, levels }: { spot: number; levels: { label: string; price: number | null | undefined; tone: 'teal' | 'rose' | 'amber' | 'violet' | 'zinc' }[] }) {
  const valid = levels.filter((l) => l.price != null && Number.isFinite(l.price)) as { label: string; price: number; tone: string }[];
  if (!valid.length || !(spot > 0)) return null;
  const lo = Math.min(spot, ...valid.map((l) => l.price)) * 0.998;
  const hi = Math.max(spot, ...valid.map((l) => l.price)) * 1.002;
  const pos = (p: number) => `${Math.max(1, Math.min(99, ((p - lo) / (hi - lo)) * 100))}%`;
  const toneBar: Record<string, string> = { teal: 'bg-teal-500', rose: 'bg-rose-500', amber: 'bg-amber-500', violet: 'bg-violet-500', zinc: 'bg-zinc-500' };
  const toneText: Record<string, string> = { teal: 'text-teal-300', rose: 'text-rose-300', amber: 'text-amber-300', violet: 'text-violet-300', zinc: 'text-zinc-300' };
  return (
    <div className="relative h-14">
      <div className="absolute left-0 right-0 top-6 h-0.5 rounded bg-zinc-800" />
      <div className="absolute top-[18px] -translate-x-1/2 -translate-y-1/2" style={{ left: pos(spot) }}>
        <div className="flex flex-col items-center">
          <span className="whitespace-nowrap rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-zinc-950 shadow">{fmtNum(spot, spot >= 1000 ? 0 : 2)}</span>
          <div className="mt-0.5 h-3 w-0.5 bg-zinc-100" />
        </div>
      </div>
      {valid.map((l) => (
        <div key={l.label} className="absolute top-6 -translate-x-1/2" style={{ left: pos(l.price) }}>
          <div className={`h-2.5 w-1 rounded-sm ${toneBar[l.tone] ?? 'bg-zinc-500'}`} />
          <p className={`mt-0.5 whitespace-nowrap text-center font-mono text-[8.5px] ${toneText[l.tone] ?? 'text-zinc-400'}`}>
            {l.label}
            <br />
            {fmtNum(l.price, l.price >= 1000 ? 0 : 2)}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── charts (pure SVG) ────────────────────────────────────────────────────────

export function Sparkline({ data, height = 28, tone = 'teal' }: { data: number[]; height?: number; tone?: 'teal' | 'rose' | 'emerald' }) {
  const vals = data.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return <div style={{ height }} />;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const w = 100;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${height - 2 - ((v - min) / (max - min || 1)) * (height - 4)}`).join(' ');
  const stroke = tone === 'rose' ? '#fb7185' : tone === 'emerald' ? '#34d399' : '#2dd4bf';
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface Series {
  label: string;
  color?: string;
  points: { x: number; y: number }[];
  dashed?: boolean;
}

export function LineChart({ series, height = 170, yFormat = (v: number) => fmtNum(v, 2), xFormat, yZero = false, markers }: { series: Series[]; height?: number; yFormat?: (v: number) => string; xFormat?: (v: number) => string; yZero?: boolean; markers?: { x: number; label: string }[] }) {
  const all = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (all.length < 2) return <EmptyNote>not enough data yet</EmptyNote>;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  let yMin = Math.min(...ys, yZero ? 0 : Math.min(...ys));
  let yMax = Math.max(...ys, yZero ? 0 : Math.max(...ys));
  if (yMax === yMin) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad;
  yMax += pad;
  const W = 640;
  const H = height;
  const L = 46;
  const B = 16;
  const px = (x: number) => L + ((x - xMin) / (xMax - xMin || 1)) * (W - L - 6);
  const py = (y: number) => H - B - ((y - yMin) / (yMax - yMin || 1)) * (H - B - 6);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMin + t * (yMax - yMin));
  const palette = ['#2dd4bf', '#a78bfa', '#fbbf24', '#fb7185', '#60a5fa'];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={L} x2={W - 6} y1={py(t)} y2={py(t)} stroke="rgba(63,63,70,0.4)" strokeWidth="0.5" />
          <text x={L - 4} y={py(t) + 3} textAnchor="end" className="fill-zinc-500" style={{ fontSize: 8, fontFamily: 'ui-monospace, monospace' }}>
            {yFormat(t)}
          </text>
        </g>
      ))}
      {yZero && yMin < 0 && yMax > 0 && <line x1={L} x2={W - 6} y1={py(0)} y2={py(0)} stroke="rgba(113,113,122,0.7)" strokeWidth="0.8" />}
      {series.map((s, si) => {
        const c = s.color ?? palette[si % palette.length];
        const d = s.points
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
          .join('');
        return <path key={s.label} d={d} fill="none" stroke={c} strokeWidth="1.6" strokeDasharray={s.dashed ? '4 3' : undefined} />;
      })}
      {markers?.map((m) => (
        <g key={m.label}>
          <line x1={px(m.x)} x2={px(m.x)} y1={6} y2={H - B} stroke="rgba(167,139,250,0.6)" strokeWidth="0.8" strokeDasharray="3 2" />
          <text x={px(m.x) + 3} y={12} className="fill-violet-300" style={{ fontSize: 8 }}>
            {m.label}
          </text>
        </g>
      ))}
      {xFormat && (
        <>
          <text x={L} y={H - 4} className="fill-zinc-500" style={{ fontSize: 7.5, fontFamily: 'ui-monospace, monospace' }}>
            {xFormat(xMin)}
          </text>
          <text x={W - 6} y={H - 4} textAnchor="end" className="fill-zinc-500" style={{ fontSize: 7.5, fontFamily: 'ui-monospace, monospace' }}>
            {xFormat(xMax)}
          </text>
        </>
      )}
    </svg>
  );
}

export function ChartLegend({ series }: { series: { label: string; color?: string }[] }) {
  const palette = ['#2dd4bf', '#a78bfa', '#fbbf24', '#fb7185', '#60a5fa'];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {series.map((s, i) => (
        <span key={s.label} className="flex items-center gap-1 text-[8.5px] text-zinc-400">
          <span className="h-1.5 w-3 rounded-sm" style={{ background: s.color ?? palette[i % palette.length] }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function BarRow({ label, value, max, tone, right, sub }: { label: string; value: number; max: number; tone?: 'teal' | 'rose' | 'zinc'; right?: React.ReactNode; sub?: React.ReactNode }) {
  const w = Math.max(0, Math.min(100, (Math.abs(value) / (max || 1)) * 100));
  const bg = tone === 'rose' ? 'bg-rose-500/70' : tone === 'teal' ? 'bg-teal-500/70' : 'bg-zinc-500/70';
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="w-16 shrink-0 truncate text-right font-mono text-[9.5px] text-zinc-400" title={label}>
        {label}
      </span>
      <div className="relative h-3.5 flex-1 rounded-sm bg-zinc-900/70">
        <div className={`absolute inset-y-0 rounded-sm ${bg}`} style={{ width: `${w}%` }} />
      </div>
      <span className="w-20 shrink-0 font-mono text-[9.5px] text-zinc-300">{right ?? fmtUsd(value, { compact: true })}</span>
      {sub}
    </div>
  );
}

/** Diverging horizontal bars (positive teal right / negative rose left). */
export function DivergingBars({ rows, unit = '' }: { rows: { label: string; value: number; alt?: string }[]; unit?: string }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <div className="space-y-0.5">
      {rows.map((r) => {
        const w = (Math.abs(r.value) / max) * 50;
        return (
          <div key={r.label} className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 truncate text-right font-mono text-[9px] text-zinc-500" title={r.label}>
              {r.label}
            </span>
            <div className="relative h-3 flex-1">
              <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
              {r.value >= 0 ? (
                <div className="absolute left-1/2 top-0 h-full rounded-lsm bg-teal-500/70" style={{ width: `${w}%` }} />
              ) : (
                <div className="absolute right-1/2 top-0 h-full rounded-rsm bg-rose-500/70" style={{ width: `${w}%` }} />
              )}
            </div>
            <span className={`w-20 shrink-0 text-right font-mono text-[9px] ${r.value >= 0 ? 'text-teal-300' : 'text-rose-300'}`}>
              {r.value >= 0 ? '+' : ''}
              {unit === '$' ? fmtUsd(r.value, { compact: true, sign: true }) : fmtNum(r.value, 2)}
              {unit && unit !== '$' ? unit : ''}
            </span>
            {r.alt && <span className="w-16 shrink-0 font-mono text-[8.5px] text-zinc-600">{r.alt}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Heat matrix with row/col labels. */
export function HeatMatrix({ rows, cols, values, format = (v: number) => fmtNum(v, 1), colorFn, height = 18, titleFn }: { rows: string[]; cols: string[]; values: number[][]; format?: (v: number) => string; colorFn?: (v: number, maxAbs: number) => string; height?: number; titleFn?: (v: number, r: number, c: number) => string }) {
  const flat = values.flat().filter((v) => Number.isFinite(v));
  const maxAbs = Math.max(...flat.map(Math.abs), 1);
  const cf = colorFn ?? heatColor;
  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-[2px] text-[8px]">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c} className="px-0.5 pb-0.5 font-mono font-medium text-zinc-500" style={{ minWidth: 34 }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((rLabel, ri) => (
            <tr key={rLabel}>
              <td className="pr-1 text-right font-mono text-zinc-500">{rLabel}</td>
              {cols.map((_, ci) => {
                const v = values[ci]?.[ri];
                const txt = Number.isFinite(v) ? format(v) : '';
                return (
                  <td
                    key={ci}
                    title={titleFn ? titleFn(v, ri, ci) : `${rLabel} · ${cols[ci]}: ${txt}`}
                    className="rounded-[3px] px-1 text-center font-mono text-[7.5px] leading-none"
                    style={{ background: Number.isFinite(v) ? cf(v, maxAbs) : 'rgba(39,39,42,0.35)', height, minWidth: 34, color: Math.abs(v) / maxAbs > 0.55 ? '#0b0e13' : '#a1a1aa' }}
                  >
                    {txt}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compact data table. */
export interface ColumnDef<T> {
  key: string;
  label: string;
  render: (row: T) => React.ReactNode;
  align?: string;
}

export function DataTable<T>({
  rows,
  columns,
  maxRows = 14,
  rowKey,
  highlight,
}: {
  rows: T[];
  columns: ColumnDef<T>[];
  maxRows?: number;
  rowKey: (row: T, i: number) => string;
  highlight?: (row: T) => boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[9.5px]">
        <thead>
          <tr className="border-b border-zinc-800/70 text-[8px] uppercase tracking-[0.1em] text-zinc-600">
            {columns.map((c) => (
              <th key={c.key} className={`px-1.5 py-1 font-semibold ${c.align === 'l' ? 'text-left' : 'text-right'}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, maxRows).map((row, i) => (
            <tr key={rowKey(row, i)} className={`border-b border-zinc-900/60 hover:bg-zinc-900/40 ${highlight?.(row) ? 'bg-teal-950/20' : ''}`}>
              {columns.map((c) => (
                <td key={c.key} className={`px-1.5 py-1 font-mono ${c.align === 'l' ? 'text-left text-zinc-300' : 'text-right text-zinc-200'}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

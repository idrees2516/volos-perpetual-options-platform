'use client';

// -----------------------------------------------------------------------------
// quantlab/viz-deep — DEEP dynamic visualizations for the Quant Lab depth
// layer: a rotatable 3D surface (drag to orbit, hover to probe), crosshair
// charts with live tooltips, spot×vol scenario heatmaps with cell readout,
// a regime gauge, animated numbers, the realized-vol cone and IV rank bar.
// Pure SVG + React state — no chart library, works with the SSE/poll feeds.
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtNum, fmtUsd, heatColor } from '@/lib/format';

// ── animated number ─────────────────────────────────────────────────────────

export function AnimatedNumber({ value, format = (v: number) => fmtNum(v, 0), className = '', ms = 550 }: { value: number; format?: (v: number) => string; className?: string; ms?: number }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const from = Number.isFinite(fromRef.current) ? fromRef.current : value;
    const to = value;
    if (!Number.isFinite(to)) return;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const eased = 1 - (1 - k) ** 3;
      setDisplay(from + (to - from) * eased);
      if (k < 1) rafRef.current = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      fromRef.current = to;
    };
  }, [value, ms]);
  return <span className={className}>{Number.isFinite(display) ? format(display) : '—'}</span>;
}

// ── regime gauge ────────────────────────────────────────────────────────────

export function Gauge({ score, label, size = 168 }: { score: number; label: string; size?: number }) {
  const clamped = Math.max(-100, Math.min(100, score));
  const W = size;
  const H = size * 0.62;
  const cx = W / 2;
  const cy = H * 0.92;
  const r = W / 2 - 14;
  const angle = Math.PI * (1 - (clamped + 100) / 200);
  const nx = cx + Math.cos(angle) * (r - 6);
  const ny = cy - Math.sin(angle) * (r - 6);
  const arc = (a0: number, a1: number, color: string) => {
    const x0 = cx + Math.cos(Math.PI * (1 - a0)) * r;
    const y0 = cy - Math.sin(Math.PI * (1 - a0)) * r;
    const x1 = cx + Math.cos(Math.PI * (1 - a1)) * r;
    const y1 = cy - Math.sin(Math.PI * (1 - a1)) * r;
    return <path d={`M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" />;
  };
  const tone = clamped >= 45 ? 'text-emerald-300' : clamped >= 18 ? 'text-teal-300' : clamped > -18 ? 'text-zinc-200' : clamped > -45 ? 'text-amber-300' : 'text-rose-300';
  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: W, height: H }}>
        {arc(0, 0.2, 'rgba(244,63,94,0.75)')}
        {arc(0.2, 0.42, 'rgba(251,146,60,0.55)')}
        {arc(0.42, 0.58, 'rgba(113,113,122,0.5)')}
        {arc(0.58, 0.8, 'rgba(45,212,191,0.6)')}
        {arc(0.8, 1, 'rgba(52,211,153,0.8)')}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#e4e4e7" strokeWidth="2" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="3.5" fill="#e4e4e7" />
      </svg>
      <div className="-mt-6 text-center">
        <p className={`font-mono text-[22px] font-bold leading-none ${tone}`}>
          <AnimatedNumber value={clamped} format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}`} />
        </p>
        <p className={`mt-1 text-[9px] font-bold uppercase tracking-[0.18em] ${tone}`}>{label}</p>
      </div>
    </div>
  );
}

// ── 3D surface (rotatable, hover-probe) ─────────────────────────────────────

export interface Surface3DProps {
  xLabels: string[];
  yLabels: string[];
  values: number[][]; // [x][y]
  height?: number;
  zLabel?: string;
  formatValue?: (v: number) => string;
  diverging?: boolean;
  yHighlight?: number | null; // row index to mark (e.g. spot strike)
}

export function Surface3D({ xLabels, yLabels, values, height = 300, zLabel = '', formatValue = (v) => fmtNum(v, 1), diverging = true, yHighlight = null }: Surface3DProps) {
  const [yaw, setYaw] = useState(0.62);
  const [pitch, setPitch] = useState(0.5);
  const [probe, setProbe] = useState<{ x: number; y: number; v: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

  const nx = xLabels.length;
  const ny = yLabels.length;
  const flat = values.flat().filter((v) => Number.isFinite(v));
  const zMin = flat.length ? Math.min(...flat) : 0;
  const zMax = flat.length ? Math.max(...flat) : 1;
  const maxAbs = Math.max(Math.abs(zMin), Math.abs(zMax), 1e-9);

  const W = 640;
  const H = height;
  const tile = Math.min(150 / Math.max(nx, 1), 90 / Math.max(ny, 1)) + 8;
  const zH = H * 0.36 * pitch;

  const proj = (gx: number, gy: number, z: number) => {
    const sx = (gx - gy) * Math.cos(yaw);
    const sy = (gx + gy) * Math.sin(yaw);
    return {
      x: W / 2 + sx * tile,
      y: H * 0.52 + sy * tile * 0.42 - z * zH,
    };
  };

  const cells = useMemo(() => {
    const out: { xi: number; yi: number; v: number; pts: string; depth: number }[] = [];
    for (let xi = 0; xi < nx; xi++) {
      for (let yi = 0; yi < ny; yi++) {
        const v = values[xi]?.[yi];
        if (!Number.isFinite(v)) continue;
        const zN = diverging ? v / maxAbs : (v - zMin) / (zMax - zMin || 1);
        const corners: [number, number][] = [];
        for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][]) {
          const gx = xi + dx;
          const gy = yi + dy;
          // neighbor-aware z for smooth terrain
          const vi = values[Math.min(gx, nx - 1)]?.[Math.min(gy, ny - 1)];
          const zAvg = Number.isFinite(vi) ? (diverging ? vi / maxAbs : (vi - zMin) / (zMax - zMin || 1)) : zN;
          const p = proj(gx, gy, zAvg);
          corners.push([p.x, p.y]);
        }
        out.push({
          xi,
          yi,
          v,
          pts: corners.map((c) => `${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' '),
          depth: xi + yi,
        });
      }
    }
    return out.sort((a, b) => a.depth - b.depth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nx, ny, values, yaw, pitch, maxAbs, zMin, zMax, diverging, tile, zH]);

  const axisColor = 'rgba(113,113,122,0.65)';
  const labelEvery = Math.max(1, Math.ceil(ny / 12));

  return (
    <div className="relative select-none">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full cursor-grab active:cursor-grabbing"
        style={{ height }}
        onPointerDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, yaw, pitch };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          setYaw(d.yaw + (e.clientX - d.x) * 0.008);
          setPitch(Math.max(0.2, Math.min(1.4, d.pitch - (e.clientY - d.y) * 0.006)));
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerLeave={() => {
          dragRef.current = null;
        }}
      >
        {/* base grid outline */}
        {(() => {
          const c0 = proj(0, 0, 0);
          const c1 = proj(nx, 0, 0);
          const c2 = proj(nx, ny, 0);
          const c3 = proj(0, ny, 0);
          return <polygon points={`${c0.x},${c0.y} ${c1.x},${c1.y} ${c2.x},${c2.y} ${c3.x},${c3.y}`} fill="rgba(9,9,11,0.35)" stroke={axisColor} strokeWidth="0.6" />;
        })()}
        {cells.map((c) => {
          const hi = probe?.xi === c.xi && probe?.yi === c.yi;
          const rowHi = yHighlight != null && c.yi === yHighlight;
          return (
            <polygon
              key={`${c.xi}-${c.yi}`}
              points={c.pts}
              fill={heatColor(c.v, maxAbs)}
              fillOpacity={diverging ? 0.82 : 0.9}
              stroke={hi ? '#ffffff' : rowHi ? 'rgba(45,212,191,0.9)' : 'rgba(9,9,11,0.5)'}
              strokeWidth={hi ? 1.6 : rowHi ? 0.8 : 0.3}
              onPointerEnter={() => setProbe({ x: c.xi, y: c.yi, v: c.v })}
              onPointerLeave={() => setProbe(null)}
              style={{ pointerEvents: 'stroke' }}
            />
          );
        })}
        {/* x axis labels (expiries) */}
        {xLabels.map((xl, xi) => {
          if (xi % Math.max(1, Math.ceil(nx / 10)) !== 0) return null;
          const p = proj(xi + 0.5, ny, 0);
          return (
            <text key={xl} x={p.x} y={p.y + 9} textAnchor="middle" className="fill-zinc-500" style={{ fontSize: 7.5, fontFamily: 'ui-monospace, monospace' }}>
              {xl}
            </text>
          );
        })}
        {/* y axis labels (strikes) */}
        {yLabels.map((yl, yi) => {
          if (yi % labelEvery !== 0) return null;
          const p = proj(0, yi + 0.5, 0);
          return (
            <text key={yl} x={p.x - 8} y={p.y + 2.5} textAnchor="end" className={yHighlight === yi ? 'fill-teal-300' : 'fill-zinc-500'} style={{ fontSize: 7.5, fontFamily: 'ui-monospace, monospace' }}>
              {yl}
            </text>
          );
        })}
        <text x={W - 8} y={14} textAnchor="end" className="fill-zinc-600" style={{ fontSize: 8 }}>
          drag to orbit · {zLabel}
        </text>
      </svg>
      {probe && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-md border border-zinc-700/60 bg-zinc-950/90 px-2 py-1 font-mono text-[9px] text-zinc-200 shadow-lg">
          <span className="text-zinc-500">{xLabels[probe.x]}</span> · <span className="text-zinc-400">{yLabels[probe.y]}</span> →{' '}
          <span className="font-bold text-teal-300">{formatValue(probe.v)}</span>
        </div>
      )}
    </div>
  );
}

// ── crosshair chart (hover tooltip + animated last point) ────────────────────

export interface XSeries {
  label: string;
  color?: string;
  points: { x: number; y: number }[];
  dashed?: boolean;
  area?: boolean;
}

export function CrosshairChart({
  series,
  height = 190,
  yFormat = (v: number) => fmtNum(v, 2),
  xFormat,
  yZero = false,
  bands,
  spot,
}: {
  series: XSeries[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  yZero?: boolean;
  bands?: { y: number; y2?: number; color: string; label?: string }[];
  spot?: { x: number; y: number } | null;
}) {
  const [hover, setHover] = useState<{ px: number; py: number; x: number; nearest: { label: string; y: number; color: string }[] } | null>(null);
  const all = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (all.length < 2) return <p className="py-6 text-center text-[10px] text-zinc-600">not enough data yet</p>;

  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  let yMin = Math.min(...ys, yZero ? 0 : Infinity);
  let yMax = Math.max(...ys, yZero ? 0 : -Infinity);
  if (yMax === yMin) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad;
  yMax += pad;

  const W = 640;
  const H = height;
  const L = 48;
  const B = 18;
  const px = (x: number) => L + ((x - xMin) / (xMax - xMin || 1)) * (W - L - 8);
  const py = (y: number) => H - B - ((y - yMin) / (yMax - yMin || 1)) * (H - B - 8);
  const palette = ['#2dd4bf', '#a78bfa', '#fbbf24', '#fb7185', '#60a5fa'];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    if (relX < L || relX > W - 8) {
      setHover(null);
      return;
    }
    const xVal = xMin + ((relX - L) / (W - L - 8)) * (xMax - xMin);
    const nearest = series
      .map((s, i) => {
        const pts = s.points.filter((p) => Number.isFinite(p.y));
        if (!pts.length) return null;
        let best = pts[0];
        let bd = Math.abs(pts[0].x - xVal);
        for (const p of pts) {
          const d = Math.abs(p.x - xVal);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        return { label: s.label, y: best.y, color: s.color ?? palette[i % palette.length] };
      })
      .filter((v): v is { label: string; y: number; color: string } => v !== null);
    setHover({ px: relX, py: ((e.clientY - rect.top) / rect.height) * H, x: xVal, nearest });
  };

  const lastPts = series.map((s, i) => {
    const pts = s.points.filter((p) => Number.isFinite(p.y));
    return pts.length ? { ...pts[pts.length - 1], color: s.color ?? palette[i % palette.length] } : null;
  });

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {bands?.map((b, i) => (
          <g key={i}>
            <rect x={L} y={py(b.y2 ?? b.y)} width={W - L - 8} height={Math.abs(py(b.y) - py(b.y2 ?? b.y))} fill={b.color} opacity={0.12} />
            {b.label && (
              <text x={W - 10} y={py(b.y) - 2} textAnchor="end" style={{ fontSize: 7.5, fontFamily: 'ui-monospace, monospace' }} className="fill-zinc-500">
                {b.label}
              </text>
            )}
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const yv = yMin + t * (yMax - yMin);
          return (
            <g key={t}>
              <line x1={L} x2={W - 8} y1={py(yv)} y2={py(yv)} stroke="rgba(63,63,70,0.4)" strokeWidth="0.5" />
              <text x={L - 4} y={py(yv) + 3} textAnchor="end" className="fill-zinc-500" style={{ fontSize: 8, fontFamily: 'ui-monospace, monospace' }}>
                {yFormat(yv)}
              </text>
            </g>
          );
        })}
        {yZero && yMin < 0 && yMax > 0 && <line x1={L} x2={W - 8} y1={py(0)} y2={py(0)} stroke="rgba(113,113,122,0.7)" strokeWidth="0.8" />}
        {spot && (
          <g>
            <line x1={px(spot.x)} x2={px(spot.x)} y1={6} y2={H - B} stroke="rgba(226,232,240,0.75)" strokeWidth="0.9" strokeDasharray="2 2" />
            <circle cx={px(spot.x)} cy={py(spot.y)} r="3" fill="#e2e8f0" />
          </g>
        )}
        {series.map((s, si) => {
          const c = s.color ?? palette[si % palette.length];
          const pts = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join('');
          return (
            <g key={s.label}>
              {s.area && pts.length > 1 && <path d={`${d} L${px(pts[pts.length - 1].x)},${py(yZero ? 0 : yMin)} L${px(pts[0].x)},${py(yZero ? 0 : yMin)} Z`} fill={c} opacity={0.09} />}
              <path d={d} fill="none" stroke={c} strokeWidth="1.7" strokeDasharray={s.dashed ? '4 3' : undefined} />
            </g>
          );
        })}
        {lastPts.map((p, i) =>
          p ? (
            <g key={i}>
              <circle cx={px(p.x)} cy={py(p.y)} r="7" fill={p.color} opacity={0.18}>
                <animate attributeName="r" values="4;8;4" dur="2.2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.28;0.05;0.28" dur="2.2s" repeatCount="indefinite" />
              </circle>
              <circle cx={px(p.x)} cy={py(p.y)} r="2.4" fill={p.color} />
            </g>
          ) : null,
        )}
        {hover && (
          <g>
            <line x1={hover.px} x2={hover.px} y1={6} y2={H - B} stroke="rgba(161,161,170,0.5)" strokeWidth="0.7" strokeDasharray="3 2" />
            {hover.nearest.map((n, i) => (
              <circle key={i} cx={hover.px} cy={py(n.y)} r="3" fill={n.color} stroke="#09090b" strokeWidth="1" />
            ))}
          </g>
        )}
        {xFormat && (
          <>
            <text x={L} y={H - 5} className="fill-zinc-500" style={{ fontSize: 7.5, fontFamily: 'ui-monospace, monospace' }}>
              {xFormat(xMin)}
            </text>
            <text x={W - 8} y={H - 5} textAnchor="end" className="fill-zinc-500" style={{ fontSize: 7.5, fontFamily: 'ui-monospace, monospace' }}>
              {xFormat(xMax)}
            </text>
          </>
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 min-w-[120px] rounded-md border border-zinc-700/60 bg-zinc-950/95 px-2 py-1 font-mono text-[9px] shadow-lg"
          style={{ left: `${Math.min((hover.px / W) * 100, 72)}%`, top: 4 }}
        >
          {xFormat && <p className="text-zinc-500">{xFormat(hover.x)}</p>}
          {hover.nearest.map((n) => (
            <p key={n.label} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1 text-zinc-400">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: n.color }} />
                {n.label}
              </span>
              <span className="text-zinc-100">{yFormat(n.y)}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── scenario heatmap (spot × vol → P&L) ─────────────────────────────────────

export function ScenarioHeatmap({
  spot,
  spotSteps,
  volSteps,
  pnlUsd,
  onSelect,
  height = 22,
}: {
  spot: number;
  spotSteps: number[];
  volSteps: number[];
  pnlUsd: number[][];
  onSelect?: (spotStep: number, volStep: number, pnl: number) => void;
  height?: number;
}) {
  const [sel, setSel] = useState<{ s: number; v: number; pnl: number } | null>(null);
  const flat = pnlUsd.flat().filter((v) => Number.isFinite(v));
  const maxAbs = Math.max(...flat.map(Math.abs), 1);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-[2px] text-[8.5px]">
          <thead>
            <tr>
              <th className="pr-1 text-right font-mono font-medium text-zinc-600">vol \ spot</th>
              {spotSteps.map((s) => {
                const price = spot * (1 + s / 100);
                const isCur = s === 0;
                return (
                  <th key={s} className={`px-1 pb-0.5 text-center font-mono font-semibold ${isCur ? 'text-teal-300' : 'text-zinc-500'}`} style={{ minWidth: 46 }}>
                    {s > 0 ? '+' : ''}
                    {s}%<br />
                    <span className="text-[7px] font-normal text-zinc-600">{fmtNum(price, price >= 1000 ? 0 : 2)}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {volSteps.map((v, vi) => (
              <tr key={v}>
                <td className={`pr-1 text-right font-mono ${v === 0 ? 'font-bold text-teal-300' : 'text-zinc-500'}`}>
                  {v > 0 ? '+' : ''}
                  {v}pt
                </td>
                {spotSteps.map((s, si) => {
                  const pnl = pnlUsd[vi]?.[si];
                  if (!Number.isFinite(pnl)) return <td key={s} className="rounded-[3px] bg-zinc-900/40" style={{ height, minWidth: 46 }} />;
                  const isCur = v === 0 && s === 0;
                  const isSel = sel && sel.s === s && sel.v === v;
                  return (
                    <td
                      key={s}
                      onClick={() => {
                        setSel({ s, v, pnl });
                        onSelect?.(s, v, pnl);
                      }}
                      title={`spot ${s > 0 ? '+' : ''}${s}% (${fmtNum(spot * (1 + s / 100), 0)}) · vol ${v > 0 ? '+' : ''}${v}pt → ${fmtUsd(pnl, { compact: true, sign: true })}`}
                      className={`cursor-pointer rounded-[3px] text-center font-mono text-[8px] leading-none transition ${isCur ? 'outline outline-1 outline-teal-400/80' : ''} ${isSel ? 'outline outline-1 outline-white' : ''}`}
                      style={{ background: heatColor(pnl, maxAbs), height, minWidth: 46, color: Math.abs(pnl) / maxAbs > 0.55 ? '#0b0e13' : '#a1a1aa' }}
                    >
                      {fmtUsd(pnl, { compact: true, sign: true })}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sel && (
        <p className="mt-1.5 font-mono text-[9px] text-zinc-400">
          selected: spot {sel.s > 0 ? '+' : ''}
          {sel.s}% ({fmtNum(spot * (1 + sel.s / 100), 0)}) · vol {sel.v > 0 ? '+' : ''}
          {sel.v}pt → P&L <span className={sel.pnl >= 0 ? 'font-bold text-emerald-300' : 'font-bold text-rose-300'}>{fmtUsd(sel.pnl, { sign: true })}</span>
        </p>
      )}
    </div>
  );
}

// ── vol cone ────────────────────────────────────────────────────────────────

export interface ConeWindowView {
  days: number;
  currentPct: number;
  minPct: number;
  p25Pct: number;
  p50Pct: number;
  p75Pct: number;
  maxPct: number;
}

export function VolCone({ windows, ivPct }: { windows: ConeWindowView[]; ivPct: number | null }) {
  if (!windows.length) return <p className="py-4 text-center text-[10px] text-zinc-600">collecting realized-vol history…</p>;
  const lo = Math.min(...windows.map((w) => w.minPct), ivPct ?? Infinity);
  const hi = Math.max(...windows.map((w) => w.maxPct), ivPct ?? -Infinity);
  const pos = (v: number) => `${((v - lo) / (hi - lo || 1)) * 100}%`;
  return (
    <div className="space-y-1.5">
      {windows.map((w) => (
        <div key={w.days} className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-right font-mono text-[9px] text-zinc-500">{w.days}d</span>
          <div className="relative h-5 flex-1 rounded-sm bg-zinc-900/70">
            {/* p25–p75 core band */}
            <div className="absolute inset-y-[3px] rounded-sm bg-teal-500/25" style={{ left: pos(w.p25Pct), width: `calc(${pos(w.p75Pct)} - ${pos(w.p25Pct)})` }} />
            {/* min–max whiskers */}
            <div className="absolute top-1/2 h-px bg-zinc-600" style={{ left: pos(w.minPct), width: `calc(${pos(w.maxPct)} - ${pos(w.minPct)})` }} />
            <div className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-zinc-400" style={{ left: pos(w.minPct) }} />
            <div className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-zinc-400" style={{ left: `calc(${pos(w.maxPct)} - 6px)` }} />
            {/* median tick */}
            <div className="absolute inset-y-[3px] w-0.5 bg-teal-300/70" style={{ left: pos(w.p50Pct) }} />
            {/* current marker */}
            <div className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${w.cheap ? 'border-emerald-400 bg-emerald-950' : w.rich ? 'border-amber-400 bg-amber-950' : 'border-zinc-100 bg-zinc-800'}`} style={{ left: pos(w.currentPct) }} title={`current ${w.currentPct.toFixed(1)}%`} />
          </div>
          <span className={`w-16 shrink-0 text-right font-mono text-[9px] ${w.cheap ? 'text-emerald-300' : w.rich ? 'text-amber-300' : 'text-zinc-300'}`}>{w.currentPct.toFixed(1)}%</span>
        </div>
      ))}
      <p className="pt-0.5 text-[8.5px] text-zinc-600">
        teal band = 25th–75th pct of each window's own history · line = min–max · dot = current · {ivPct != null && Number.isFinite(ivPct) ? <>iv30 <span className="text-teal-300">{ivPct.toFixed(1)}%</span></> : ''}
      </p>
    </div>
  );
}

// ── IV rank bar ─────────────────────────────────────────────────────────────

export function RankBar({ rank, label, sub }: { rank: number; label: string; sub?: string }) {
  const valid = Number.isFinite(rank);
  const tone = !valid ? 'bg-zinc-600' : rank >= 65 ? 'bg-amber-400' : rank <= 35 ? 'bg-emerald-400' : 'bg-teal-400';
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
        <p className="font-mono text-[12px] font-bold text-zinc-100">{valid ? `${Math.round(rank)}/100` : '—'}</p>
      </div>
      <div className="relative mt-1 h-2.5 rounded-full bg-zinc-900">
        <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/15" style={{ width: '35%' }} />
        <div className="absolute inset-y-0 rounded-full bg-amber-500/15" style={{ left: '65%', width: '35%' }} />
        {valid && <div className="absolute inset-y-0 w-[3px] rounded-full shadow" style={{ left: `calc(${Math.min(98, Math.max(1, rank))}% - 1px)`, background: 'currentColor' }} />}
        {valid && <span className={`absolute -translate-x-1/2 ${tone.replace('bg-', 'text-')}`} style={{ left: `${Math.min(98, Math.max(2, rank))}%`, top: '3px' }}>▼</span>}
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[7.5px] text-zinc-600">
        <span>cheap 0</span>
        <span>mid 50</span>
        <span>rich 100</span>
      </div>
      {sub && <p className="mt-0.5 text-[8.5px] text-zinc-500">{sub}</p>}
    </div>
  );
}

// ── strength meter for signal cards ─────────────────────────────────────────

export function StrengthMeter({ strength, state }: { strength: number; state: string }) {
  const tone = state.includes('bull') ? (state.includes('extreme') ? 'bg-emerald-400' : 'bg-emerald-500/80') : state.includes('bear') ? (state.includes('extreme') ? 'bg-rose-400' : 'bg-rose-500/80') : 'bg-zinc-500/70';
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className={`h-full rounded-full transition-all duration-700 ${tone}`} style={{ width: `${Math.min(100, Math.max(4, strength))}%` }} />
    </div>
  );
}

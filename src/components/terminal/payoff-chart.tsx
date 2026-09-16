'use client';

// Canvas payoff chart — the interactive heart of the strategy builder.
// Features: expiry + current-value curves, time-decay intermediates,
// probability cone, breakevens, live spot line, draggable strike handles,
// hover crosshair with P&L readout. Custom canvas for 60fps interaction.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Leg, StrategyAnalysis, ViewOverrides } from '@/lib/types';
import { fmtUsd, fmtNum } from '@/lib/format';

interface PayoffChartProps {
  analysis: StrategyAnalysis;
  legs: Leg[];
  spot: number;
  overrides: ViewOverrides;
  showCone: boolean;
  showDecay: boolean;
  showNow: boolean;
  horizonDays: number;
  onStrikeDrag: (legId: string, strike: number) => void;
  height?: number;
}

interface DragState {
  legId: string;
  kind: 'strike' | 'spot';
}

const COLORS = {
  expiry: '#2dd4bf',
  expiryGlow: 'rgba(45, 212, 191, 0.16)',
  now: '#fbbf24',
  decay: 'rgba(148, 163, 184, 0.55)',
  cone1: 'rgba(45, 212, 191, 0.070)',
  cone2: 'rgba(45, 212, 191, 0.035)',
  grid: 'rgba(148, 163, 184, 0.08)',
  gridStrong: 'rgba(148, 163, 184, 0.16)',
  text: '#94a3b8',
  textBright: '#e2e8f0',
  spot: '#f8fafc',
  breakeven: '#a3e635',
  buy: '#10b981',
  sell: '#f43f5e',
};

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const rough = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function fmtAxisPrice(v: number): string {
  if (Math.abs(v) >= 100000) return `${(v / 1000).toFixed(0)}k`;
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(1)}k`;
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

export function PayoffChart({
  analysis,
  legs,
  spot,
  overrides,
  showCone,
  showDecay,
  showNow,
  horizonDays,
  onStrikeDrag,
  height = 420,
}: PayoffChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [size, setSize] = useState({ w: 800, h: height });
  const animRef = useRef<number>(0);
  const drawStateRef = useRef({ analysis, legs, spot, overrides, showCone, showDecay, showNow, horizonDays, hover });

  useEffect(() => {
    drawStateRef.current = { analysis, legs, spot, overrides, showCone, showDecay, showNow, horizonDays, hover };
  }, [analysis, legs, spot, overrides, showCone, showDecay, showNow, horizonDays, hover]);

  // Resize observer.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  // Geometry helpers bound to current draw state.
  const geom = useMemo(() => {
    const padL = 64;
    const padR = 18;
    const padT = 18;
    const padB = 34;
    const w = size.w;
    const h = size.h;
    const plotW = Math.max(w - padL - padR, 10);
    const plotH = Math.max(h - padT - padB, 10);
    return { padL, padR, padT, padB, plotW, plotH, w, h };
  }, [size]);

  const computeScales = useCallback(() => {
    const { analysis: a, overrides: ov } = drawStateRef.current;
    const axis = a.spotAxis;
    if (!axis || axis.length === 0) return null;
    let minPnl = Infinity;
    let maxPnl = -Infinity;
    for (const c of a.curves) {
      for (const v of c.pnl) {
        if (v < minPnl) minPnl = v;
        if (v > maxPnl) maxPnl = v;
      }
    }
    // Padding, include 0.
    minPnl = Math.min(minPnl, 0);
    maxPnl = Math.max(maxPnl, 0);
    const span = maxPnl - minPnl || 1;
    minPnl -= span * 0.12;
    maxPnl += span * 0.14;
    return { xLo: axis[0], xHi: axis[axis.length - 1], yLo: minPnl, yHi: maxPnl };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const { w, h } = size;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const st = drawStateRef.current;
    const a = st.analysis;
    const scales = computeScales();
    if (!scales) return;
    const { padL, padR, padT, padB, plotW, plotH } = geom;
    const { xLo, xHi, yLo, yHi } = scales;
    const X = (v: number) => padL + ((v - xLo) / (xHi - xLo)) * plotW;
    const Y = (v: number) => padT + (1 - (v - yLo) / (yHi - yLo)) * plotH;

    const axis = a.spotAxis;

    // ---- Grid ----
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const xTicks = niceTicks(xLo, xHi, Math.max(4, Math.floor(plotW / 110)));
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    for (const t of xTicks) {
      const x = X(t);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillText(fmtAxisPrice(t), x, padT + plotH + 14);
    }
    const yTicks = niceTicks(yLo, yHi, Math.max(3, Math.floor(plotH / 60)));
    ctx.textAlign = 'right';
    for (const t of yTicks) {
      const y = Y(t);
      ctx.strokeStyle = Math.abs(t) < 1e-9 ? COLORS.gridStrong : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.fillText(fmtUsd(t, { compact: true }), padL - 8, y);
    }

    // ---- Probability cone ----
    if (st.showCone && st.horizonDays > 0) {
      const viewSpot = st.spot * (1 + st.overrides.spotShiftPct / 100);
      const sigma = a.horizonDays > 0 ? Math.abs(Math.log(axis[Math.floor(axis.length / 2) + 8] / viewSpot)) : 0.2;
      // Use ATM vol directly:
      const atmIv = a.curves?.length ? null : null;
      void sigma; void atmIv;
      // Compute sigma from greeks-independent route: reuse iv from analysis legs is complex;
      // approximate with realized span (3.2 sigma) instead.
      const spanSigma = (xHi - viewSpot) / 3.2;
      const coneT = st.horizonDays / 365;
      const s1 = viewSpot * Math.exp(spanSigma * Math.sqrt(coneT) * 0.31);
      const s1lo = viewSpot * Math.exp(-spanSigma * Math.sqrt(coneT) * 0.31);
      // ±1σ ≈ 31% of the ±3.2σ span
      const drawConeBand = (hiP: number, loP: number, fill: string) => {
        const yTop = Y(yHi * 0.98);
        const yBot = Y(yLo);
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(X(viewSpot), yTop);
        ctx.lineTo(X(hiP), yBot);
        ctx.lineTo(X(loP), yBot);
        ctx.closePath();
        ctx.fill();
      };
      drawConeBand(s1, s1lo, COLORS.cone1);
      const s2 = viewSpot * Math.exp(spanSigma * Math.sqrt(coneT) * 0.62);
      const s2lo = viewSpot * Math.exp(-spanSigma * Math.sqrt(coneT) * 0.62);
      drawConeBand(s2, s2lo, COLORS.cone2);
    }

    // ---- Curves ----
    const drawCurve = (pnl: number[], color: string, width: number, dash?: number[], glow = false) => {
      ctx.save();
      if (dash) ctx.setLineDash(dash);
      if (glow) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < axis.length; i++) {
        const x = X(axis[i]);
        const y = Y(pnl[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };

    if (st.showDecay) {
      const t25 = a.curves.find((c) => c.label === 't25');
      const t50 = a.curves.find((c) => c.label === 't50');
      const t75 = a.curves.find((c) => c.label === 't75');
      if (t25) drawCurve(t25.pnl, COLORS.decay, 1, [3, 4]);
      if (t50) drawCurve(t50.pnl, COLORS.decay, 1, [3, 4]);
      if (t75) drawCurve(t75.pnl, COLORS.decay, 1, [3, 4]);
    }
    if (st.showNow) {
      const now = a.curves.find((c) => c.label === 'now');
      if (now) drawCurve(now.pnl, COLORS.now, 1.8, [6, 4]);
    }
    const expiry = a.curves.find((c) => c.label === 'expiry');
    if (expiry) {
      // Fill profit region above zero with subtle teal.
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < axis.length; i++) {
        const x = X(axis[i]);
        const y = Y(expiry.pnl[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(X(axis[axis.length - 1]), Y(0));
      ctx.lineTo(X(axis[0]), Y(0));
      ctx.closePath();
      ctx.fillStyle = 'rgba(45, 212, 191, 0.05)';
      ctx.fill();
      ctx.restore();
      drawCurve(expiry.pnl, COLORS.expiry, 2.2, undefined, true);
    }

    // ---- Live spot line ----
    const viewSpot = st.spot * (1 + st.overrides.spotShiftPct / 100);
    const sx = X(Math.min(Math.max(viewSpot, xLo), xHi));
    ctx.save();
    ctx.strokeStyle = COLORS.spot;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(sx, padT);
    ctx.lineTo(sx, padT + plotH);
    ctx.stroke();
    ctx.restore();
    // Spot pill.
    const spotLabel = fmtAxisPrice(viewSpot);
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = ctx.measureText(spotLabel).width + 12;
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.35)';
    ctx.beginPath();
    ctx.roundRect(sx - tw / 2, padT - 8, tw, 16, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.textBright;
    ctx.textAlign = 'center';
    ctx.fillText(spotLabel, sx, padT);

    // ---- Breakevens ----
    for (const be of a.breakevens) {
      if (be < xLo || be > xHi) continue;
      const bx = X(be);
      ctx.fillStyle = COLORS.breakeven;
      ctx.beginPath();
      ctx.arc(bx, Y(0), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(163, 230, 53, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(bx, Y(0), 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(163, 230, 53, 0.9)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`BE ${fmtAxisPrice(be)}`, bx, Y(0) - 14);
    }

    // ---- Strike handles ----
    const handleLegs = st.legs.filter((l) => l.strike !== undefined);
    const seen = new Set<number>();
    for (const l of handleLegs) {
      const k = l.strike!;
      const key = Math.round(k * 100);
      const off = seen.has(key) ? 1 : 0;
      seen.add(key);
      const hx = X(Math.min(Math.max(k, xLo), xHi));
      const hy = padT + plotH - 10 - off * 22;
      const color = l.side === 'buy' ? COLORS.buy : COLORS.sell;
      ctx.save();
      // Strike vertical hint line.
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, hy - 4);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();
      ctx.restore();
      // Handle.
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Grip dots.
      ctx.fillStyle = color;
      for (let d = 0; d < 3; d++) {
        ctx.beginPath();
        ctx.arc(hx - 2 + d * 2, hy, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = color;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const prefix = l.side === 'buy' ? '+' : '−';
      ctx.fillText(`${prefix}${fmtAxisPrice(k)}`, hx, hy + 17);
    }

    // ---- Hover crosshair ----
    if (st.hover) {
      const { x, y } = st.hover;
      if (x >= padL && x <= padL + plotW && y >= padT && y <= padT + plotH) {
        const price = xLo + ((x - padL) / plotW) * (xHi - xLo);
        ctx.save();
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.restore();

        // Readout box.
        const pnlAt = (pnl: number[]) => {
          const idx = Math.min(Math.max(Math.round(((price - xLo) / (xHi - xLo)) * (axis.length - 1)), 0), axis.length - 1);
          return pnl[idx];
        };
        const lines: [string, string][] = [];
        if (expiry) lines.push(['At horizon', fmtUsd(pnlAt(expiry.pnl), { sign: true })]);
        const nowC = a.curves.find((c) => c.label === 'now');
        if (nowC && st.showNow) lines.push(['Mark now', fmtUsd(pnlAt(nowC.pnl), { sign: true })]);
        lines.push(['Price', fmtNum(price, price >= 1000 ? 0 : 2)]);
        ctx.font = '10px ui-monospace, monospace';
        const bw = Math.max(...lines.map(([k2, v]) => ctx.measureText(`${k2}  ${v}`).width)) + 20;
        const bh = lines.length * 15 + 10;
        let bxx = x + 12;
        if (bxx + bw > padL + plotW) bxx = x - bw - 12;
        const byy = Math.min(Math.max(y - bh / 2, padT), padT + plotH - bh);
        ctx.fillStyle = 'rgba(13, 18, 28, 0.94)';
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
        ctx.beginPath();
        ctx.roundRect(bxx, byy, bw, bh, 6);
        ctx.fill();
        ctx.stroke();
        lines.forEach(([k2, v], i) => {
          ctx.textAlign = 'left';
          ctx.fillStyle = COLORS.text;
          ctx.fillText(k2, bxx + 8, byy + 13 + i * 15);
          ctx.textAlign = 'right';
          const isPnl = v.includes('$');
          const neg = v.includes('−');
          ctx.fillStyle = isPnl ? (neg ? '#fb7185' : '#34d399') : COLORS.textBright;
          ctx.fillText(v, bxx + bw - 8, byy + 13 + i * 15);
        });
      }
    }

    // ---- Axis titles ----
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.font = '9px ui-sans-serif, system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(`${a.horizonDays.toFixed(0)}d horizon P&L (USD)`, padL + plotW, padT - 8);
    ctx.textAlign = 'left';
    ctx.fillText('underlying price', padL, padT + plotH + 28);
  }, [geom, computeScales, size]);

  // Continuous render loop (charts animate with market data).
  useEffect(() => {
    const loop = () => {
      draw();
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  // ---- Interaction ----
  const hitTest = useCallback((mx: number, my: number): DragState | null => {
    const scales = computeScales();
    if (!scales) return null;
    const { padL, padT, plotW, plotH } = geom;
    const { xLo, xHi } = scales;
    const st = drawStateRef.current;
    const handleLegs = st.legs.filter((l) => l.strike !== undefined);
    for (const l of handleLegs) {
      const hx = padL + ((Math.min(Math.max(l.strike!, xLo), xHi) - xLo) / (xHi - xLo)) * plotW;
      const hy = padT + plotH - 10;
      if (Math.hypot(mx - hx, my - hy) < 14) return { legId: l.id, kind: 'strike' };
    }
    return null;
  }, [geom, computeScales]);

  const toLocal = (e: React.MouseEvent | React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = toLocal(e);
    const hit = hitTest(x, y);
    if (hit) {
      dragRef.current = hit;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = toLocal(e);
    if (dragRef.current?.kind === 'strike') {
      const scales = computeScales();
      if (!scales) return;
      const { padL, plotW } = geom;
      const { xLo, xHi } = scales;
      const price = xLo + ((x - padL) / plotW) * (xHi - xLo);
      const step = xHi > 50000 ? 500 : xHi > 4000 ? 50 : xHi > 400 ? 5 : 0.5;
      const snapped = Math.round(price / step) * step;
      onStrikeDrag(dragRef.current.legId, Math.min(Math.max(snapped, xLo), xHi));
    } else {
      setHover({ x, y });
      setCursor(hitTest(x, y) ? 'grab' : 'crosshair');
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    dragRef.current = null;
  };

  const [cursor, setCursor] = useState<'crosshair' | 'grab'>('crosshair');

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', cursor, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setHover(null); dragRef.current = null; }}
      />
      {/* Legend */}
      <div className="pointer-events-none absolute left-16 top-2 flex flex-wrap gap-3 text-[10px] font-medium text-zinc-400">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-teal-400" />Payoff at horizon</span>
        {showNow && <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-amber-400" style={{ backgroundImage: 'repeating-linear-gradient(90deg,#fbbf24 0 4px,transparent 4px 7px)' }} />Mark now</span>}
        {showDecay && <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-slate-400" style={{ backgroundImage: 'repeating-linear-gradient(90deg,#94a3b8 0 3px,transparent 3px 6px)' }} />Time decay</span>}
        {showCone && <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-teal-400/15" />Probability cone</span>}
      </div>
    </div>
  );
}

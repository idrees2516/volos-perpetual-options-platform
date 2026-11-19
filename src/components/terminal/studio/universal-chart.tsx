'use client';

// ─────────────────────────────────────────────────────────────────────────────
// STUDIO · universal-chart — one canvas, ANY series, ANY kind.
//
// line · area · band · bars · histogram · scatter · step · candles, with
// overlays, per-series left/right axes (or 0–1 normalized), crosshair
// tooltip reading every series at the hovered step. Same dark-teal canvas
// language as the terminal's other hand-rolled charts — no chart library.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChartKind, VizPoint, VizSeries } from '@/lib/viz/types';
import { histogramOf } from '@/lib/viz/transforms';

export interface StudioSeries extends VizSeries {
  color: string;
  axis?: 'left' | 'right';
}

interface Props {
  kind: ChartKind;
  series: StudioSeries[];
  normalize?: boolean;
  height?: number;
  onHoverStep?: (step: number) => void;
}

const PAD = { l: 56, r: 56, t: 18, b: 26 };

function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 100_000) return `${(v / 1000).toFixed(0)}k`;
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtT(t: number): string {
  if (t > 1e12 || (t > 1e9 && t < 1e11)) return new Date(t).toISOString().slice(11, 16);
  if (t >= 1e11) return new Date(t).toISOString().slice(5, 16).replace('T', ' ');
  return fmtVal(t);
}

export function UniversalChart({ kind, series, normalize = false, height = 380 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapW, setWrapW] = useState(900);
  const [, bump] = useState(0);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 900;
      setWrapW(Math.max(360, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = wrapW;
    const H = height;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, W, H);

    const plotL = PAD.l;
    const plotR = W - (series.some((s) => s.axis === 'right') && !normalize ? PAD.r : 30);
    const plotW = plotR - plotL;
    const plotT = PAD.t;
    const plotH = H - PAD.t - PAD.b;
    if (plotW <= 10 || plotH <= 10) return;

    const paletteSeries = series.filter((s) => s.points && s.points.length > 0);
    if (paletteSeries.length === 0) {
      ctx.fillStyle = 'rgba(113,113,122,0.8)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('no data — pick a series', W / 2, H / 2);
      return;
    }

    // per-series transformed values (normalize → 0..1 on each own window)
    const norm = (pts: VizPoint[]): VizPoint[] => {
      if (!normalize) return pts;
      const vals = pts.map((p) => p.v).filter(Number.isFinite);
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of vals) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const span = hi - lo || 1e-9;
      return pts.map((p) => ({ ...p, v: (p.v - lo) / span, lo: p.lo != null ? (p.lo - lo) / span : undefined, hi: p.hi != null ? (p.hi - lo) / span : undefined }));
    };
    const drawn = paletteSeries.map((s) => ({ s: { ...s, points: norm(s.points!) } }));

    // x domain across all series (shared time index when comparable; else per-series slotting)
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const d of drawn) {
      for (const p of d.s.points) {
        t0 = Math.min(t0, p.t);
        t1 = Math.max(t1, p.t);
      }
    }
    if (!Number.isFinite(t0)) return;
    if (t1 <= t0) t1 = t0 + 1;
    const xOf = (t: number) => plotL + ((t - t0) / (t1 - t0)) * plotW;

    // y domains: left (first series) + right (axis:'right' series)
    const domOf = (pts: VizPoint[]): { lo: number; hi: number } => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pts) {
        for (const v of [p.v, p.lo, p.hi] as (number | undefined)[]) {
          if (v != null && Number.isFinite(v)) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
      }
      if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
      if (hi <= lo) hi = lo + 1e-9;
      const pad = (hi - lo) * 0.07;
      return { lo: lo - pad, hi: hi + pad };
    };
    const leftDom = domOf(drawn.filter((d) => d.s.axis !== 'right').flatMap((d) => d.s.points) || drawn[0].s.points);
    const rightPts = drawn.filter((d) => d.s.axis === 'right').flatMap((d) => d.s.points);
    const rightDom = rightPts.length ? domOf(rightPts) : null;
    const yOf = (v: number, axis: 'left' | 'right') => {
      const d = axis === 'right' && rightDom ? rightDom : leftDom;
      return plotT + (1 - (v - d.lo) / (d.hi - d.lo)) * plotH;
    };

    // ── grid + axes ──────────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(39,39,42,0.55)';
    ctx.fillStyle = 'rgba(113,113,122,0.9)';
    ctx.font = '8.5px ui-monospace, monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = plotT + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(plotL, y);
      ctx.lineTo(plotR, y);
      ctx.stroke();
      ctx.fillText(fmtVal(leftDom.hi - ((leftDom.hi - leftDom.lo) * i) / 4), plotL - 6, y + 3);
    }
    if (rightDom) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(139,139,148,0.85)';
      for (let i = 0; i <= 4; i++) {
        const y = plotT + (plotH * i) / 4;
        ctx.fillText(fmtVal(rightDom.hi - ((rightDom.hi - rightDom.lo) * i) / 4), plotR + 6, y + 3);
      }
    }
    ctx.fillStyle = 'rgba(113,113,122,0.9)';
    ctx.textAlign = 'center';
    const xTicks = Math.min(6, Math.max(2, Math.floor(plotW / 130)));
    for (let i = 0; i <= xTicks; i++) {
      const t = t0 + ((t1 - t0) * i) / xTicks;
      ctx.fillText(fmtT(t), xOf(t), H - 10);
    }

    // ── the drawing pass per series ────────────────────────────────────────
    const candleCapable = paletteSeries[0]?.points?.some((p) => Number.isFinite(p.c));
    const effKind: ChartKind = kind === 'candles' && !candleCapable ? 'line' : kind;

    if (effKind === 'histogram') {
      // distribution of the FIRST series, overlaid per-series as outlines
      for (let si = 0; si < drawn.length; si++) {
        const d = drawn[si];
        const vals = d.s.points.map((p) => p.v).filter(Number.isFinite);
        const bins = histogramOf(vals, si === 0 ? 40 : 24);
        if (!bins.length) continue;
        const maxC = Math.max(...bins.map((b) => b.count)) || 1;
        const bLo = bins[0].x0;
        const bHi = bins.at(-1)!.x1;
        const bx = (v: number) => plotL + ((v - bLo) / (bHi - bLo || 1e-9)) * plotW;
        for (const b of bins) {
          const w = Math.max(1, (plotW / bins.length) - 1);
          const h = (b.count / maxC) * plotH;
          if (si === 0) {
            ctx.fillStyle = `${d.s.color}55`;
            ctx.fillRect(bx(b.x0) + 0.5, plotT + plotH - h, w, h);
            ctx.strokeStyle = d.s.color;
            ctx.lineWidth = 0.8;
            ctx.strokeRect(bx(b.x0) + 0.5, plotT + plotH - h, w, h);
          } else {
            ctx.strokeStyle = d.s.color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(bx(b.x0) + plotW / bins.length / 2, plotT + plotH);
            ctx.lineTo(bx(b.x0) + plotW / bins.length / 2, plotT + plotH - (b.count / maxC) * plotH);
            ctx.stroke();
          }
        }
      }
    } else if (effKind === 'candles') {
      const d = drawn[0];
      const pts = d.s.points;
      const cw = Math.max(1.5, (plotW / pts.length) * 0.7);
      for (const p of pts) {
        if (!Number.isFinite(p.c)) continue;
        const x = xOf(p.t);
        const up = p.c! >= p.o!;
        ctx.strokeStyle = up ? '#2dd4bf' : '#fb7185';
        ctx.fillStyle = up ? 'rgba(45,212,191,0.85)' : 'rgba(251,113,133,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, yOf(p.h!, 'left'));
        ctx.lineTo(x, yOf(p.l!, 'left'));
        ctx.stroke();
        const yC = yOf(p.c!, 'left');
        const yO = yOf(p.o!, 'left');
        const top = Math.min(yO, yC);
        const hh = Math.max(1, Math.abs(yO - yC));
        ctx.fillRect(x - cw / 2, top, cw, hh);
        ctx.strokeRect(x - cw / 2, top, cw, hh);
      }
    } else {
      for (const d of drawn) {
        const pts = d.s.points.filter((p) => Number.isFinite(p.v));
        if (pts.length === 0) continue;
        const axis = d.s.axis === 'right' ? 'right' : 'left';
        const color = d.s.color;

        // band fill (lo..hi) or derived ±σ envelope
        const bandPts = pts.filter((p) => p.lo != null && Number.isFinite(p.lo) && p.hi != null && Number.isFinite(p.hi));
        if (effKind === 'band' && bandPts.length > 1) {
          ctx.fillStyle = `${color}1f`;
          ctx.beginPath();
          ctx.moveTo(xOf(bandPts[0].t), yOf(bandPts[0].hi!, axis));
          for (const p of bandPts) ctx.lineTo(xOf(p.t), yOf(p.hi!, axis));
          for (let i = bandPts.length - 1; i >= 0; i--) ctx.lineTo(xOf(bandPts[i].t), yOf(bandPts[i].lo!, axis));
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = `${color}55`;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          for (const p of bandPts) ctx.lineTo(xOf(p.t), yOf(p.hi!, axis));
          ctx.moveTo(xOf(bandPts[0].t), yOf(bandPts[0].lo!, axis));
          for (const p of bandPts) ctx.lineTo(xOf(p.t), yOf(p.lo!, axis));
          ctx.stroke();
        }
        if (effKind === 'area') {
          const base = leftDom.lo;
          ctx.fillStyle = `${color}26`;
          ctx.beginPath();
          ctx.moveTo(xOf(pts[0].t), yOf(base, axis));
          for (const p of pts) ctx.lineTo(xOf(p.t), yOf(p.v, axis));
          ctx.lineTo(xOf(pts.at(-1)!.t), yOf(base, axis));
          ctx.closePath();
          ctx.fill();
        }

        ctx.strokeStyle = color;
        ctx.lineWidth = pts.length > 800 ? 0.9 : 1.4;
        if (effKind === 'scatter') {
          ctx.fillStyle = color;
          for (const p of pts) {
            ctx.beginPath();
            ctx.arc(xOf(p.t), yOf(p.v, axis), 1.5, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (effKind === 'bars') {
          ctx.fillStyle = color;
          const bw = Math.max(0.8, (plotW / pts.length) * 0.6);
          const zeroY = yOf(Math.max(leftDom.lo, Math.min(leftDom.hi, 0)), axis);
          for (const p of pts) {
            const y = yOf(p.v, axis);
            ctx.fillRect(xOf(p.t) - bw / 2, Math.min(y, zeroY), bw, Math.max(1, Math.abs(zeroY - y)));
          }
        } else if (effKind === 'step') {
          ctx.beginPath();
          let prevY = yOf(pts[0].v, axis);
          ctx.moveTo(xOf(pts[0].t), prevY);
          for (const p of pts) {
            const x = xOf(p.t);
            const y = yOf(p.v, axis);
            ctx.lineTo(x, prevY);
            ctx.lineTo(x, y);
            prevY = y;
          }
          ctx.stroke();
        } else {
          // line / band point line
          ctx.beginPath();
          for (const p of pts) ctx.lineTo(xOf(p.t), yOf(p.v, axis));
          ctx.stroke();
          // last-point dot
          const last = pts.at(-1)!;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(xOf(last.t), yOf(last.v, axis), 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ── crosshair + tooltip ────────────────────────────────────────────────
    const hov = hoverRef.current;
    if (hov && hov.x >= plotL && hov.x <= plotR) {
      ctx.strokeStyle = 'rgba(139,149,165,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hov.x + 0.5, plotT);
      ctx.lineTo(hov.x + 0.5, plotT + plotH);
      ctx.stroke();
      const lines: string[] = [];
      for (const d of drawn) {
        const pts = d.s.points;
        if (!pts.length) continue;
        let best = pts[0];
        let bestD = Math.abs(xOf(pts[0].t) - hov.x);
        for (const p of pts) {
          const dd = Math.abs(xOf(p.t) - hov.x);
          if (dd < bestD) {
            bestD = dd;
            best = p;
          }
        }
        lines.push(`${d.s.label.slice(0, 22).padEnd(22)} ${fmtVal(best.v)}${Number.isFinite(best.lo) ? ` (${fmtVal(best.lo!)}…${fmtVal(best.hi!)})` : ''}`);
      }
      if (lines.length) {
        const wBox = Math.min(300, Math.max(...lines.map((l) => l.length)) * 5.4 + 16);
        const hBox = lines.length * 13 + 8;
        const bx = Math.min(hov.x + 12, plotR - wBox - 4);
        const by = Math.min(Math.max(plotT + 4, hov.y - 14), plotT + plotH - hBox - 4);
        ctx.fillStyle = 'rgba(5,7,10,0.93)';
        ctx.strokeStyle = 'rgba(63,74,90,0.8)';
        ctx.beginPath();
        ctx.roundRect(bx, by, wBox, hBox, 5);
        ctx.fill();
        ctx.stroke();
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'left';
        lines.forEach((l, i) => {
          ctx.fillStyle = i === 0 ? 'rgba(228,234,242,0.95)' : 'rgba(161,161,170,0.95)';
          ctx.fillText(l, bx + 8, by + 14 + i * 13);
        });
      }
    }

    // kind watermark
    ctx.font = '8px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(82,82,91,0.7)';
    ctx.fillText(`${effKind}${normalize ? ' · 0–1 per series' : ''}`, 8, 11);
  }, [kind, series, normalize, height, wrapW]);

  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden rounded-lg border border-zinc-800/80 bg-[#05070a]">
      <canvas
        ref={canvasRef}
        className="block w-full cursor-crosshair"
        onMouseMove={(e) => {
          const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
          hoverRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
          bump((v) => v + 1);
        }}
        onMouseLeave={() => {
          hoverRef.current = null;
          bump((v) => v + 1);
        }}
      />
    </div>
  );
}

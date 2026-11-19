'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — ScriptChart. Canvas candle chart + the live VolScript output:
// overlay plots (line/area/histogram/circles) on the price pane, non-overlay
// plots in an auto-scaled sub pane, hlines, plotshape markers, backtest trade
// markers (▲ entry / ✕ exit), crosshair + OHLCV tooltip + legend values.
// Same visual language as the rest of the terminal (teal/rose, hairline grid).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunResult, ScriptBar } from '@/lib/scriptlang/types';

const UP = '#2dd4bf';
const DOWN = '#fb7185';
const GRID = 'rgba(63, 63, 70, 0.35)';
const TXT = '#71717a';

interface Props {
  bars: ScriptBar[] | null;
  result: RunResult | null;
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 10_000) return v.toFixed(0);
  if (a >= 1000) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}

function fmtTime(ts: number, tfSec: number): string {
  const d = new Date(ts);
  if (tfSec >= 86_400) return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return tfSec >= 3600 ? `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}h` : `${hh}:${mm}`;
}

function drawSeries(
  ctx: CanvasRenderingContext2D,
  vals: number[],
  x: (i: number) => number,
  y: (v: number) => number,
  color: string,
  alpha: number,
  width: number,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.beginPath();
  let drawing = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!Number.isFinite(v)) {
      drawing = false;
      continue;
    }
    if (!drawing) {
      ctx.moveTo(x(i), y(v));
      drawing = true;
    } else ctx.lineTo(x(i), y(v));
  }
  ctx.stroke();
  ctx.restore();
}

interface Hover {
  x: number;
  y: number;
  bar: number;
}

export function ScriptChart({ bars, result }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [size, setSize] = useState({ w: 0, h: 300 });

  const n = bars?.length ?? 0;
  const tfSec = useMemo(() => {
    if (!bars || bars.length < 2) return 3600;
    const gap = Math.round((bars[bars.length - 1].ts - bars[0].ts) / (bars.length - 1) / 1000);
    return gap > 0 ? gap : 3600;
  }, [bars]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(280, r.width), h: Math.max(220, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const indexAt = useCallback(
    (px: number, w: number) => {
      if (!n || !w) return null;
      const AXIS_W = 56;
      const plotW = w - AXIS_W;
      if (px < 0 || px > plotW) return null;
      const i = Math.floor((px / plotW) * n);
      return i >= 0 && i < n ? i : null;
    },
    [n],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w <= 0 || size.h <= 0 || !n || !bars) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const AXIS_W = 56;
    const TIME_H = 16;
    const plotW = size.w - AXIS_W;
    const plots = result?.plots ?? [];
    const shapes = result?.shapes ?? [];
    const hlines = result?.hlines ?? [];
    const markers = result?.backtest?.markers ?? [];
    const overlayPlots = plots.filter((p) => p.overlay);
    const subPlots = plots.filter((p) => !p.overlay);
    const subShapes = shapes.filter((s) => !s.overlay);
    const subHlines = hlines.filter((h) => !h.overlay);
    const hasSub = subPlots.length + subShapes.length + subHlines.length > 0;

    const bodyH = size.h - TIME_H;
    const SUB_GAP = 10;
    const subH = hasSub ? Math.max(70, Math.round(bodyH * 0.28)) : 0;
    const priceH = bodyH - subH - (hasSub ? SUB_GAP : 0);

    // ── price domain ────────────────────────────────────────────────────────
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of bars) {
      if (b.l < lo) lo = b.l;
      if (b.h > hi) hi = b.h;
    }
    for (const p of overlayPlots) {
      if (p.style === 'histogram') continue; // own mini scale
      for (const v of p.data) {
        if (Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    for (const h of hlines) {
      if (h.overlay && Number.isFinite(h.price)) {
        if (h.price < lo) lo = h.price;
        if (h.price > hi) hi = h.price;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const padP = (hi - lo) * 0.05 || hi * 0.01;
    lo -= padP;
    hi += padP;

    const x = (i: number) => (plotW * (i + 0.5)) / n;
    const bw = Math.max(1, Math.min(14, (plotW / n) * 0.66));
    const yP = (v: number) => ((hi - v) / (hi - lo)) * priceH;

    // ── grid + price axis ──────────────────────────────────────────────────
    ctx.font = '500 9px var(--font-geist-mono), ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let g = 0; g <= 4; g++) {
      const gy = (g / 4) * priceH;
      const val = hi - (g / 4) * (hi - lo);
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, gy + 0.5);
      ctx.lineTo(plotW, gy + 0.5);
      ctx.stroke();
      ctx.fillStyle = TXT;
      ctx.fillText(fmtNum(val), plotW + 6, gy);
    }

    // ── volume shadow ───────────────────────────────────────────────────────
    const volMax = Math.max(...bars.map((b) => b.v), 1e-9);
    const volH = priceH * 0.14;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const vh = (b.v / volMax) * volH;
      ctx.fillStyle = b.c >= b.o ? 'rgba(45, 212, 191, 0.20)' : 'rgba(251, 113, 133, 0.20)';
      ctx.fillRect(x(i) - bw / 2, priceH - vh, bw, vh);
    }

    // ── overlay histograms (own mini scale at the pane bottom) ────────────
    for (const p of overlayPlots) {
      if (p.style !== 'histogram') continue;
      let mx = 0;
      for (const v of p.data) if (Number.isFinite(v)) mx = Math.max(mx, Math.abs(v));
      if (mx === 0) continue;
      const zone = priceH * 0.22;
      for (let i = 0; i < n; i++) {
        const v = p.data[i];
        if (!Number.isFinite(v)) continue;
        const h = (Math.abs(v) / mx) * zone;
        ctx.fillStyle = v >= 0 ? p.color : DOWN;
        ctx.globalAlpha = p.alpha * 0.55;
        ctx.fillRect(x(i) - bw / 2, priceH - h, bw, h);
      }
      ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, priceH);
    ctx.clip();

    // ── overlay plots ──────────────────────────────────────────────────────
    for (const p of overlayPlots) {
      if (p.style === 'histogram') continue;
      if (p.style === 'area') {
        ctx.save();
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.alpha * 0.12;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < p.data.length; i++) {
          const v = p.data[i];
          if (!Number.isFinite(v)) continue;
          if (!started) {
            ctx.moveTo(x(i), yP(v));
            started = true;
          } else ctx.lineTo(x(i), yP(v));
        }
        ctx.lineTo(plotW, priceH);
        ctx.lineTo(0, priceH);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        drawSeries(ctx, p.data, x, yP, p.color, p.alpha, p.width);
        continue;
      }
      if (p.style === 'circles' || p.style === 'cross') {
        ctx.save();
        ctx.strokeStyle = p.color;
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.alpha;
        for (let i = 0; i < p.data.length; i++) {
          const v = p.data[i];
          if (!Number.isFinite(v)) continue;
          const cx = x(i);
          const cy = yP(v);
          if (p.style === 'circles') {
            ctx.beginPath();
            ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.moveTo(cx - 3, cy - 3);
            ctx.lineTo(cx + 3, cy + 3);
            ctx.moveTo(cx + 3, cy - 3);
            ctx.lineTo(cx - 3, cy + 3);
            ctx.stroke();
          }
        }
        ctx.restore();
        continue;
      }
      drawSeries(ctx, p.data, x, yP, p.color, p.alpha, p.width);
    }

    // ── hlines (price pane) ────────────────────────────────────────────────
    for (const h of hlines) {
      if (!h.overlay || !Number.isFinite(h.price)) continue;
      const cy = yP(h.price);
      ctx.save();
      ctx.strokeStyle = h.color;
      ctx.globalAlpha = h.alpha * 0.8;
      ctx.lineWidth = 1;
      if (h.dashed) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, cy + 0.5);
      ctx.lineTo(plotW, cy + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = h.color;
      ctx.textAlign = 'left';
      ctx.font = '600 8.5px var(--font-geist-mono), ui-monospace, monospace';
      ctx.fillText(`${h.title} ${fmtNum(h.price)}`, 6, Math.max(8, Math.min(priceH - 8, cy - 6)));
      ctx.restore();
    }

    // ── candles ─────────────────────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const up = b.c >= b.o;
      const col = up ? UP : DOWN;
      const cx = x(i);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, yP(b.h));
      ctx.lineTo(cx, yP(b.l));
      ctx.stroke();
      const yo = yP(b.o);
      const yc = yP(b.c);
      const top = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillStyle = col;
      ctx.globalAlpha = up ? 0.9 : 0.95;
      ctx.fillRect(cx - bw / 2, top, bw, bh);
      ctx.globalAlpha = 1;
    }

    // ── shapes on the price pane ────────────────────────────────────────────
    const drawShape = (style: string, cx: number, cy: number, color: string, alpha: number, below: boolean) => {
      const dir = below ? 1 : -1;
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      switch (style) {
        case 'triangleup':
          ctx.moveTo(cx, cy + dir * 4);
          ctx.lineTo(cx - 4, cy + dir * 9);
          ctx.lineTo(cx + 4, cy + dir * 9);
          break;
        case 'triangledown':
          ctx.moveTo(cx, cy - dir * 4);
          ctx.lineTo(cx - 4, cy - dir * 9);
          ctx.lineTo(cx + 4, cy - dir * 9);
          break;
        case 'square':
          ctx.rect(cx - 3.2, cy - 3.2, 6.4, 6.4);
          break;
        case 'diamond':
          ctx.moveTo(cx, cy - 4);
          ctx.lineTo(cx + 4, cy);
          ctx.lineTo(cx, cy + 4);
          ctx.lineTo(cx - 4, cy);
          break;
        case 'cross':
          ctx.moveTo(cx - 3.5, cy - 3.5);
          ctx.lineTo(cx + 3.5, cy + 3.5);
          ctx.moveTo(cx + 3.5, cy - 3.5);
          ctx.lineTo(cx - 3.5, cy + 3.5);
          ctx.stroke();
          break;
        default:
          ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
    };
    for (const s of shapes) {
      if (!s.overlay) continue;
      for (let i = 0; i < n; i++) {
        if (!s.cond[i]) continue;
        const b = bars[i];
        const cy = s.location === 'belowbar' ? yP(b.l) + 12 : yP(b.h) - 12;
        drawShape(s.style, x(i), Math.max(10, Math.min(priceH - 10, cy)), s.color, s.alpha, s.location === 'belowbar');
      }
    }

    // ── backtest trade markers ────────────────────────────────────────────
    for (const m of markers) {
      const cx = x(m.idx);
      const cy = yP(m.price);
      ctx.save();
      if (m.kind === 'entry') {
        ctx.fillStyle = m.side === 'long' ? '#4ade80' : '#fb7185';
        ctx.beginPath();
        if (m.side === 'long') {
          ctx.moveTo(cx, cy - 5);
          ctx.lineTo(cx - 4.5, cy - 12);
          ctx.lineTo(cx + 4.5, cy - 12);
        } else {
          ctx.moveTo(cx, cy + 5);
          ctx.lineTo(cx - 4.5, cy + 12);
          ctx.lineTo(cx + 4.5, cy + 12);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.strokeStyle = m.reason === 'stop' ? '#fb7185' : m.reason === 'limit' ? '#4ade80' : '#a1a1aa';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy - 4);
        ctx.lineTo(cx + 4, cy + 4);
        ctx.moveTo(cx + 4, cy - 4);
        ctx.lineTo(cx - 4, cy + 4);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore(); // price clip

    // ── sub pane ───────────────────────────────────────────────────────────
    if (hasSub) {
      const subTop = priceH + SUB_GAP;
      ctx.strokeStyle = 'rgba(82, 82, 91, 0.5)';
      ctx.beginPath();
      ctx.moveTo(0, subTop - SUB_GAP / 2 + 0.5);
      ctx.lineTo(size.w, subTop - SUB_GAP / 2 + 0.5);
      ctx.stroke();

      // sub domain
      let sLo = Infinity;
      let sHi = -Infinity;
      let any = false;
      for (const p of subPlots) {
        if (p.style === 'histogram') {
          for (const v of p.data) {
            if (Number.isFinite(v)) {
              any = true;
              if (v < sLo) sLo = v;
              if (v > sHi) sHi = v;
            }
          }
          continue;
        }
        for (const v of p.data) {
          if (Number.isFinite(v)) {
            any = true;
            if (v < sLo) sLo = v;
            if (v > sHi) sHi = v;
          }
        }
      }
      for (const h of subHlines) {
        any = true;
        if (h.price < sLo) sLo = h.price;
        if (h.price > sHi) sHi = h.price;
      }
      if (!any) {
        sLo = 0;
        sHi = 1;
      }
      if (sLo === sHi) {
        sLo -= 1;
        sHi += 1;
      }
      const sPad = (sHi - sLo) * 0.08;
      sLo -= sPad;
      sHi += sPad;
      if (sLo > 0 && sLo < (sHi - sLo) * 0.5) sLo = 0; // histograms want a zero baseline
      const yS = (v: number) => subTop + subH - ((v - sLo) / (sHi - sLo || 1)) * subH;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, subTop, plotW, subH);
      ctx.clip();

      // zero line if in domain
      if (sLo <= 0 && sHi >= 0) {
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(0, yS(0) + 0.5);
        ctx.lineTo(plotW, yS(0) + 0.5);
        ctx.stroke();
      }

      // histograms
      for (const p of subPlots) {
        if (p.style !== 'histogram') continue;
        const base = sLo <= 0 ? yS(0) : subTop + subH;
        for (let i = 0; i < n; i++) {
          const v = p.data[i];
          if (!Number.isFinite(v)) continue;
          const vy = yS(v);
          ctx.fillStyle = v >= 0 ? p.color : DOWN;
          ctx.globalAlpha = p.alpha * 0.6;
          const top = Math.min(vy, base);
          const h = Math.max(1, Math.abs(base - vy));
          ctx.fillRect(x(i) - bw / 2, top, bw, h);
        }
        ctx.globalAlpha = 1;
      }

      // lines / circles / area
      for (const p of subPlots) {
        if (p.style === 'histogram') continue;
        if (p.style === 'area') {
          ctx.save();
          ctx.fillStyle = p.color;
          ctx.globalAlpha = p.alpha * 0.14;
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < p.data.length; i++) {
            const v = p.data[i];
            if (!Number.isFinite(v)) continue;
            if (!started) {
              ctx.moveTo(x(i), yS(v));
              started = true;
            } else ctx.lineTo(x(i), yS(v));
          }
          ctx.lineTo(plotW, subTop + subH);
          ctx.lineTo(0, subTop + subH);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        if (p.style === 'circles' || p.style === 'cross') {
          ctx.save();
          ctx.fillStyle = p.color;
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = p.alpha;
          for (let i = 0; i < p.data.length; i++) {
            const v = p.data[i];
            if (!Number.isFinite(v)) continue;
            if (p.style === 'circles') {
              ctx.beginPath();
              ctx.arc(x(i), yS(v), 2.4, 0, Math.PI * 2);
              ctx.fill();
            } else {
              ctx.beginPath();
              ctx.moveTo(x(i) - 3, yS(v) - 3);
              ctx.lineTo(x(i) + 3, yS(v) + 3);
              ctx.moveTo(x(i) + 3, yS(v) - 3);
              ctx.lineTo(x(i) - 3, yS(v) + 3);
              ctx.stroke();
            }
          }
          ctx.restore();
          continue;
        }
        drawSeries(ctx, p.data, x, yS, p.color, p.alpha, p.width);
      }

      // sub hlines
      for (const h of subHlines) {
        if (!Number.isFinite(h.price)) continue;
        const cy = yS(h.price);
        ctx.save();
        ctx.strokeStyle = h.color;
        ctx.globalAlpha = h.alpha * 0.75;
        ctx.lineWidth = 1;
        if (h.dashed) ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, cy + 0.5);
        ctx.lineTo(plotW, cy + 0.5);
        ctx.stroke();
        ctx.restore();
      }

      // sub shapes
      for (const s of subShapes) {
        for (let i = 0; i < n; i++) {
          if (!s.cond[i]) continue;
          const cy = s.location === 'belowbar' ? subTop + subH - 8 : subTop + 8;
          ctx.save();
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(x(i), cy, 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
      ctx.restore();

      // sub axis labels
      ctx.fillStyle = TXT;
      ctx.font = '500 9px var(--font-geist-mono), ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(fmtNum(sHi), plotW + 6, subTop + 6);
      ctx.fillText(fmtNum(sLo), plotW + 6, subTop + subH - 6);
    }

    // ── time axis ─────────────────────────────────────────────────────────
    ctx.fillStyle = TXT;
    ctx.font = '500 8.5px var(--font-geist-mono), ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += step) {
      ctx.fillText(fmtTime(bars[i].ts, tfSec), x(i), size.h - TIME_H + 2);
    }

    // ── crosshair ──────────────────────────────────────────────────────────
    if (hover && hover.bar >= 0 && hover.bar < n) {
      const cx = x(hover.bar);
      ctx.strokeStyle = 'rgba(161, 161, 170, 0.45)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, size.h - TIME_H);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, hover.y);
      ctx.lineTo(plotW, hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hover.y < priceH) {
        const val = hi - (hover.y / priceH) * (hi - lo);
        ctx.fillStyle = '#3f3f46';
        ctx.fillRect(plotW + 2, hover.y - 8, AXIS_W - 4, 16);
        ctx.fillStyle = '#e4e4e7';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '600 9px var(--font-geist-mono), ui-monospace, monospace';
        ctx.fillText(fmtNum(val), plotW + 6, hover.y);
      }
    }
  }, [bars, result, size, hover, n, tfSec]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ── tooltip + legend values at the hovered (or last) bar ─────────────────
  const view = useMemo(() => {
    if (!bars || !n) return null;
    const i = hover ? hover.bar : n - 1;
    const b = bars[Math.max(0, Math.min(n - 1, i))];
    const plotVals = (result?.plots ?? []).map((p) => ({
      title: p.title,
      color: p.color,
      value: p.data[Math.max(0, Math.min(n - 1, i))] ?? NaN,
    }));
    return { i, bar: b, plotVals, chg: i > 0 ? (b.c / bars[i - 1].c - 1) * 100 : 0 };
  }, [bars, result, hover, n]);

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      {bars && n > 0 ? (
        <>
          <canvas
            ref={canvasRef}
            className="cursor-crosshair"
            onMouseMove={(e) => {
              const r = canvasRef.current?.getBoundingClientRect();
              if (!r) return;
              const idx = indexAt(e.clientX - r.left, r.width);
              setHover(idx == null ? null : { x: e.clientX, y: e.clientY - r.top, bar: idx });
            }}
            onMouseLeave={() => setHover(null)}
          />
          {/* legend — script title + plot values at the hovered bar */}
          {view && (
            <div className="pointer-events-none absolute left-2 top-1.5 max-w-[70%] space-y-0.5">
              <p className="flex items-center gap-1.5 text-[10.5px] font-semibold text-zinc-200">
                {result?.title ?? 'Script'}
                {result?.kind === 'strategy' && (
                  <span className="rounded bg-violet-950/70 px-1 py-px text-[7.5px] font-bold uppercase tracking-wider text-violet-300 ring-1 ring-violet-500/30">
                    strategy
                  </span>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                {view.plotVals.slice(0, 6).map((p, k) => (
                  <span key={k} className="flex items-center gap-1 font-mono text-[9px] text-zinc-400">
                    <span className="inline-block h-[3px] w-2.5 rounded" style={{ background: p.color }} />
                    {p.title}
                    <span className="text-zinc-200">{fmtNum(p.value)}</span>
                  </span>
                ))}
                {result?.hlines?.filter((h) => h.overlay).slice(0, 2).map((h, k) => (
                  <span key={`h${k}`} className="flex items-center gap-1 font-mono text-[9px] text-zinc-400">
                    <span className="inline-block h-[2px] w-2.5" style={{ background: h.color }} />
                    {h.title}
                    <span className="text-zinc-200">{fmtNum(h.price)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {hover && view && (
            <div
              className="pointer-events-none fixed z-50 rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 shadow-xl"
              style={{ left: Math.min(hover.x + 14, window.innerWidth - 220), top: Math.max(8, hover.y - 96) }}
            >
              <p className="font-mono text-[8.5px] text-zinc-500">
                {new Date(view.bar.ts).toISOString().replace('T', ' ').slice(0, 16)}Z
              </p>
              <p className="mt-0.5 font-mono text-[11px] font-bold text-zinc-100">
                {fmtNum(view.bar.c)}{' '}
                <span className={`text-[9px] ${view.chg >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {view.chg >= 0 ? '+' : ''}
                  {view.chg.toFixed(2)}%
                </span>
              </p>
              <div className="mt-0.5 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[8.5px] text-zinc-400">
                <span>
                  o <span className="text-zinc-200">{fmtNum(view.bar.o)}</span>
                </span>
                <span>
                  h <span className="text-zinc-200">{fmtNum(view.bar.h)}</span>
                </span>
                <span>
                  l <span className="text-zinc-200">{fmtNum(view.bar.l)}</span>
                </span>
                <span>
                  v{' '}
                  <span className="text-zinc-200">
                    {view.bar.v >= 1e6 ? `${(view.bar.v / 1e6).toFixed(2)}M` : view.bar.v >= 1e3 ? `${(view.bar.v / 1e3).toFixed(1)}K` : view.bar.v.toFixed(0)}
                  </span>
                </span>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
          <p className="text-[11px]">no bars loaded</p>
          <p className="text-[9px] text-zinc-700">pick a symbol + timeframe in the toolbar</p>
        </div>
      )}
    </div>
  );
}

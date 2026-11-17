'use client';

// -----------------------------------------------------------------------------
// quantlab/indicator-chart — <IndicatorChart> (V2 P2): the candlestick chart
// core with the indicator battery rendered on canvas, in ONE visual language
// with the rest of the terminal (teal/rose diverging palette, hairline grid,
// token-driven chrome, no chart library).
//
//   price pane : candles + volume shadow + overlays (EMA20/50/200, Bollinger,
//                VWAP, Supertrend, Ichimoku lines + forward cloud, Donchian)
//   sub pane   : aggressor delta histogram + CVD · RSI · MACD · Stochastic ·
//                ADX/DMI · OBV
//   chrome     : right price axis, bottom time axis, hover crosshair + OHLCV
//                tooltip, warmup-aware (nulls never drawn)
//
// Data shape comes straight from GET /api/quant/indicators — the same numbers
// the copilot will read (P3 wires the AI into this battery).
// -----------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IndicatorSnapshot } from '@/lib/quant/indicator-service';

export type SubPane = 'delta' | 'rsi' | 'macd' | 'stoch' | 'adx' | 'obv';

export interface IndicatorChartProps {
  bars: IndicatorSnapshot['bars'];
  series: Record<string, (number | null)[]>;
  overlays: Record<string, boolean>;
  subpane: SubPane;
  tfSec: number;
  height?: number;
}

const UP = '#2dd4bf';
const DOWN = '#fb7185';
const GRID = 'rgba(63, 63, 70, 0.35)';
const TXT = '#71717a';
const C = {
  ema20: '#fbbf24',
  ema50: '#a78bfa',
  ema200: '#38bdf8',
  bb: '#8b8b96',
  vwap: '#22d3ee',
  supertrendUp: '#4ade80',
  supertrendDown: '#fb7185',
  tenkan: '#38bdf8',
  kijun: '#fb923c',
  donchian: '#64748b',
  cvd: '#fbbf24',
  rsi: '#c4b5fd',
  macdLine: '#38bdf8',
  macdSignal: '#fb923c',
  stochK: '#38bdf8',
  stochD: '#fb923c',
  adx: '#fbbf24',
  obv: '#22d3ee',
};

function fmtNum(v: number): string {
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

/** polyline with null gaps — moveTo after every gap */
function drawSeries(
  ctx: CanvasRenderingContext2D,
  vals: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
  color: string,
  width = 1.25,
  dash: number[] = [],
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash.length) ctx.setLineDash(dash);
  ctx.beginPath();
  let drawing = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null || !Number.isFinite(v)) {
      drawing = false;
      continue;
    }
    const px = x(i);
    const py = y(v);
    if (!drawing) {
      ctx.moveTo(px, py);
      drawing = true;
    } else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

interface Hover {
  x: number;
  y: number;
  bar: number;
}

export function IndicatorChart({ bars, series, overlays, subpane, tfSec, height = 400 }: IndicatorChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [size, setSize] = useState({ w: 0, h: height });

  const n = bars.length;
  const ICH_FWD = 26;
  const slots = useMemo(() => (overlays.ichimoku ? n + ICH_FWD : n), [n, overlays.ichimoku]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(280, r.width), h: Math.max(240, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // hover → bar index mapping (shared with draw for the crosshair)
  const indexAt = useCallback(
    (px: number, w: number) => {
      if (!n || !w) return null;
      const AXIS_W = 58;
      const plotW = w - AXIS_W;
      if (px < 0 || px > plotW) return null;
      const i = Math.floor((px / plotW) * slots);
      return i >= 0 && i < n ? i : null;
    },
    [n, slots],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !(size.w > 0) || !(size.h > 0) || !n) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const AXIS_W = 58;
    const TIME_H = 16;
    const SUB_GAP = 8;
    const plotW = size.w - AXIS_W;
    const bodyH = size.h - TIME_H;
    const subH = Math.max(64, Math.round(bodyH * 0.3));
    const priceH = bodyH - subH - SUB_GAP;

    // ── domains ────────────────────────────────────────────────────────────
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of bars) {
      if (b.l < lo) lo = b.l;
      if (b.h > hi) hi = b.h;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const padP = (hi - lo) * 0.05 || hi * 0.01;
    lo -= padP;
    hi += padP;

    const x = (i: number) => (plotW * (i + 0.5)) / slots;
    const bw = Math.max(1, (plotW / slots) * 0.66);
    const yP = (v: number) => ((hi - v) / (hi - lo)) * priceH;

    // ── grid + right price axis ───────────────────────────────────────────
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

    // ── volume shadow (bottom 16% of the price pane) ───────────────────────
    const volMax = Math.max(...bars.map((b) => b.v), 1e-9);
    const volH = priceH * 0.16;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const vh = (b.v / volMax) * volH;
      ctx.fillStyle = b.c >= b.o ? 'rgba(45, 212, 191, 0.22)' : 'rgba(251, 113, 133, 0.22)';
      ctx.fillRect(x(i) - bw / 2, priceH - vh, bw, vh);
    }

    // ── overlays (BEHIND candles except bands fill) ─────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, priceH);
    ctx.clip();

    if (overlays.ichimoku) {
      // kumo cloud between senkouA/B projected ICH_FWD bars forward —
      // teal where A≥B (bullish), rose where B>A, split into contiguous runs
      const shiftX = (i: number) => x(i + ICH_FWD);
      const sA = series.senkouA ?? [];
      const sB = series.senkouB ?? [];
      let runStart = -1;
      for (let i = 0; i <= sA.length; i++) {
        const ok = i < sA.length && sA[i] != null && sB[i] != null;
        if (ok && runStart < 0) runStart = i;
        if (!ok && runStart >= 0) {
          const end = i - 1;
          const above = (sA[end] as number) >= (sB[end] as number);
          ctx.fillStyle = above ? 'rgba(45, 212, 191, 0.08)' : 'rgba(251, 113, 133, 0.08)';
          ctx.beginPath();
          for (let j = runStart; j <= end; j++) ctx.lineTo(shiftX(j), yP(sA[j] as number));
          for (let j = end; j >= runStart; j--) ctx.lineTo(shiftX(j), yP(sB[j] as number));
          ctx.closePath();
          ctx.fill();
          runStart = -1;
        }
      }
      drawSeries(ctx, sA, shiftX, yP, 'rgba(45, 212, 191, 0.35)', 1);
      drawSeries(ctx, sB, shiftX, yP, 'rgba(251, 113, 133, 0.35)', 1);
      drawSeries(ctx, series.tenkan ?? [], x, yP, C.tenkan, 1.1);
      drawSeries(ctx, series.kijun ?? [], x, yP, C.kijun, 1.1);
    }

    if (overlays.bb) {
      const u = series.bbUpper ?? [];
      const l = series.bbLower ?? [];
      // subtle band fill
      ctx.fillStyle = 'rgba(139, 139, 150, 0.05)';
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < u.length; i++) {
        const v = u[i];
        if (v == null) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(x(i), yP(v));
          started = true;
        } else ctx.lineTo(x(i), yP(v));
      }
      for (let i = l.length - 1; i >= 0; i--) {
        const v = l[i];
        if (v == null) continue;
        ctx.lineTo(x(i), yP(v));
      }
      ctx.closePath();
      ctx.fill();
      drawSeries(ctx, u, x, yP, C.bb, 1, [4, 3]);
      drawSeries(ctx, l, x, yP, C.bb, 1, [4, 3]);
      drawSeries(ctx, series.bbMid ?? [], x, yP, 'rgba(139, 139, 150, 0.5)', 1, [2, 4]);
    }

    if (overlays.vwap) drawSeries(ctx, series.vwap ?? [], x, yP, C.vwap, 1.25, [5, 3]);

    if (overlays.donchian) {
      drawSeries(ctx, series.donchUpper ?? [], x, yP, C.donchian, 1, [3, 3]);
      drawSeries(ctx, series.donchLower ?? [], x, yP, C.donchian, 1, [3, 3]);
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

    // ── overlays IN FRONT of candles ────────────────────────────────────────
    if (overlays.ema) {
      drawSeries(ctx, series.ema20 ?? [], x, yP, C.ema20, 1.25);
      drawSeries(ctx, series.ema50 ?? [], x, yP, C.ema50, 1.25);
      drawSeries(ctx, series.ema200 ?? [], x, yP, C.ema200, 1.25);
    }
    if (overlays.supertrend) {
      const stv = series.supertrend ?? [];
      const dir = series.supertrendDir ?? [];
      // colored segments — a new path whenever the trend flips
      for (const dsign of [1, -1]) {
        ctx.save();
        ctx.strokeStyle = dsign === 1 ? C.supertrendUp : C.supertrendDown;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        let drawing = false;
        for (let i = 0; i < stv.length; i++) {
          const v = stv[i];
          const dv = dir[i];
          const mine = dv != null && (dv as number) === dsign;
          if (v == null || !mine) {
            drawing = false;
            continue;
          }
          if (!drawing) {
            ctx.moveTo(x(i), yP(v as number));
            drawing = true;
          } else ctx.lineTo(x(i), yP(v as number));
        }
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore(); // end price-pane clip

    // ── sub pane ───────────────────────────────────────────────────────────
    const subTop = priceH + SUB_GAP;
    ctx.strokeStyle = 'rgba(82, 82, 91, 0.5)';
    ctx.beginPath();
    ctx.moveTo(0, subTop - SUB_GAP / 2 + 0.5);
    ctx.lineTo(size.w, subTop - SUB_GAP / 2 + 0.5);
    ctx.stroke();

    const subLabel = (s: string) => {
      ctx.fillStyle = TXT;
      ctx.font = '600 8.5px var(--font-geist-mono), ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(s, 4, subTop + 8);
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, subTop, plotW, subH);
    ctx.clip();

    const yS = (v: number, sLo: number, sHi: number) => subTop + subH - ((v - sLo) / (sHi - sLo || 1)) * subH;

    if (subpane === 'delta') {
      const d = series.delta ?? [];
      const dm = Math.max(...d.map((v) => Math.abs(v ?? 0)), 1e-9);
      for (let i = 0; i < n; i++) {
        const v = d[i];
        if (v == null) continue;
        const h = (Math.abs(v) / dm) * (subH * 0.8);
        ctx.fillStyle = v >= 0 ? 'rgba(45, 212, 191, 0.55)' : 'rgba(251, 113, 133, 0.55)';
        const base = subTop + subH;
        ctx.fillRect(x(i) - bw / 2, base - h, bw, h);
      }
      // CVD on its own scale (shape is the signal)
      const cv = series.cvd ?? [];
      const vals = cv.filter((v): v is number => v != null);
      if (vals.length > 2) {
        const cLo = Math.min(...vals);
        const cHi = Math.max(...vals);
        drawSeries(ctx, cv, x, (v) => yS(v, cLo, cHi), C.cvd, 1.4);
        subLabel('aggressor delta · CVD (own scale)');
      } else subLabel('aggressor delta');
    } else if (subpane === 'rsi') {
      const r = series.rsi14 ?? [];
      const yRSI = (v: number) => yS(v, 0, 100);
      for (const lvl of [30, 50, 70]) {
        ctx.strokeStyle = lvl === 50 ? GRID : 'rgba(63, 63, 70, 0.5)';
        ctx.setLineDash(lvl === 50 ? [] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(0, yRSI(lvl));
        ctx.lineTo(plotW, yRSI(lvl));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      drawSeries(ctx, r, x, yRSI, C.rsi, 1.4);
      subLabel('RSI 14 — 30 / 50 / 70 guides');
    } else if (subpane === 'macd') {
      const line = series.macdLine ?? [];
      const sig = series.macdSignal ?? [];
      const hist = series.macdHist ?? [];
      const m = Math.max(...[...line, ...sig, ...hist].map((v) => Math.abs(v ?? 0)), 1e-9);
      const yM = (v: number) => yS(v, -m * 1.1, m * 1.1);
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(0, yM(0));
      ctx.lineTo(plotW, yM(0));
      ctx.stroke();
      for (let i = 0; i < n; i++) {
        const v = hist[i];
        if (v == null) continue;
        const h = Math.abs(yM(v) - yM(0));
        ctx.fillStyle = v >= 0 ? 'rgba(45, 212, 191, 0.5)' : 'rgba(251, 113, 133, 0.5)';
        ctx.fillRect(x(i) - bw / 2, Math.min(yM(0), yM(v)), bw, Math.max(1, h));
      }
      drawSeries(ctx, line, x, yM, C.macdLine, 1.3);
      drawSeries(ctx, sig, x, yM, C.macdSignal, 1.1);
      subLabel('MACD 12/26/9');
    } else if (subpane === 'stoch') {
      const yK = (v: number) => yS(v, 0, 100);
      for (const lvl of [20, 50, 80]) {
        ctx.strokeStyle = lvl === 50 ? GRID : 'rgba(63, 63, 70, 0.5)';
        ctx.setLineDash(lvl === 50 ? [] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(0, yK(lvl));
        ctx.lineTo(plotW, yK(lvl));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      drawSeries(ctx, series.stochK ?? [], x, yK, C.stochK, 1.3);
      drawSeries(ctx, series.stochD ?? [], x, yK, C.stochD, 1.1);
      subLabel('Stochastic 14/3/3 — 20 / 80 guides');
    } else if (subpane === 'adx') {
      const ad = series.adx14 ?? [];
      const pd = series.plusDI ?? [];
      const md = series.minusDI ?? [];
      const mx = Math.max(100, ...[...ad, ...pd, ...md].map((v) => v ?? 0));
      const yA = (v: number) => yS(v, 0, mx);
      for (const lvl of [25]) {
        ctx.strokeStyle = 'rgba(63, 63, 70, 0.5)';
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(0, yA(lvl));
        ctx.lineTo(plotW, yA(lvl));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      drawSeries(ctx, ad, x, yA, C.adx, 1.5);
      drawSeries(ctx, pd, x, yA, UP, 1);
      drawSeries(ctx, md, x, yA, DOWN, 1);
      subLabel('ADX 14 · +DI / −DI — 25 trend threshold');
    } else if (subpane === 'obv') {
      const o = series.obv ?? [];
      const vals = o.filter((v): v is number => v != null);
      const oLo = Math.min(...vals, 0);
      const oHi = Math.max(...vals, 0);
      drawSeries(ctx, o, x, (v) => yS(v, oLo, oHi), C.obv, 1.4);
      subLabel('On-Balance Volume');
    }
    ctx.restore();

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
  }, [bars, series, overlays, subpane, size, hover, n, slots, tfSec]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ── tooltip contents at the hovered bar ───────────────────────────────────
  const tip = useMemo(() => {
    if (!hover || hover.bar < 0 || hover.bar >= n) return null;
    const i = hover.bar;
    const b = bars[i];
    const g = (k: string) => {
      const s = series[k];
      const v = s ? s[i] : null;
      return v == null ? null : fmtNum(v);
    };
    return {
      time: new Date(b.ts).toISOString().replace('T', ' ').slice(0, 16) + 'Z',
      o: fmtNum(b.o),
      h: fmtNum(b.h),
      l: fmtNum(b.l),
      c: fmtNum(b.c),
      chg: i > 0 ? ((b.c - bars[i - 1].c) / bars[i - 1].c) * 100 : null,
      v: b.v >= 1e6 ? `${(b.v / 1e6).toFixed(2)}M` : b.v >= 1e3 ? `${(b.v / 1e3).toFixed(1)}K` : b.v.toFixed(0),
      rsi: g('rsi14'),
      ema20: g('ema20'),
      ema50: g('ema50'),
      macd: g('macdLine'),
      delta: g('delta'),
      cvd: g('cvd'),
      supertrend: g('supertrend'),
    };
  }, [hover, bars, series, n]);

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      <canvas
        ref={canvasRef}
        className="cursor-crosshair"
        onMouseMove={(e) => {
          const r = canvasRef.current?.getBoundingClientRect();
          if (!r) return;
          const px = e.clientX - r.left;
          const i = indexAt(px, r.width);
          setHover(i == null ? null : { x: e.clientX, y: e.clientY - r.top, bar: i });
        }}
        onMouseLeave={() => setHover(null)}
      />
      {hover && tip && (
        <div
          className="pointer-events-none fixed z-50 rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 shadow-xl"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 210), top: Math.max(8, hover.y - 90) }}
        >
          <p className="font-mono text-[8.5px] text-zinc-500">{tip.time}</p>
          <p className="mt-0.5 font-mono text-[11px] font-bold text-zinc-100">
            {tip.c} <span className={`text-[9px] ${tip.chg == null ? '' : tip.chg >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{tip.chg == null ? '' : `${tip.chg >= 0 ? '+' : ''}${tip.chg.toFixed(2)}%`}</span>
          </p>
          <div className="mt-0.5 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[8.5px] text-zinc-400">
            <span>o <span className="text-zinc-200">{tip.o}</span></span>
            <span>h <span className="text-zinc-200">{tip.h}</span></span>
            <span>l <span className="text-zinc-200">{tip.l}</span></span>
            <span>v <span className="text-zinc-200">{tip.v}</span></span>
            {tip.rsi && <span>rsi <span className="text-zinc-200">{tip.rsi}</span></span>}
            {tip.ema20 && <span>ema20 <span className="text-amber-300">{tip.ema20}</span></span>}
            {tip.ema50 && <span>ema50 <span className="text-violet-300">{tip.ema50}</span></span>}
            {tip.macd && <span>macd <span className="text-sky-300">{tip.macd}</span></span>}
            {tip.delta && <span className={tip.delta.startsWith('-') ? '' : 'col-span-2'}>delta <span className={tip.delta.startsWith('-') ? 'text-rose-300' : 'text-emerald-300'}>{tip.delta}</span></span>}
            {tip.cvd && <span>cvd <span className="text-amber-300">{tip.cvd}</span></span>}
            {tip.supertrend && <span>st <span className="text-emerald-300">{tip.supertrend}</span></span>}
          </div>
        </div>
      )}
    </div>
  );
}

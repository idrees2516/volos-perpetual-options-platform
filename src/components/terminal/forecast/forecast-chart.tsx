'use client';

// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — conformal fan chart (canvas)
//
// The docs' "Plot forecast" equivalent, drawn on our flow-bar history:
//
//   x: time — linear. Left ⅔ = observed history (flow bars), right third =
//      the forecast horizon (h steps past the cutoff).
//   y: value — auto range from visible window ∪ every visible band.
//
// Layers, back to front:
//   1. level band polygons for the PRIMARY model (80 / 95 … requested levels,
//      inner levels darker; conformal bands genuinely widen past 80 when
//      calibrated — native clamped bands visibly stop)
//   2. point-forecast lines: primary model (bright) + every toggled overlay
//   3. history line (engine tail highlighted)
//   4. cutoff divider ("now" marker) + horizon guides every ¼ h
//   5. crosshair + tooltip (point + band bounds per level)
//
// A small model legend on the canvas top-left mirrors the reference's
// per-model plot; the expected-move readout sits top-right for price targets.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useReducer, useRef } from 'react';
import type { FcConfig, FcFeedState } from './use-forecast';

const C = {
  bg: '#06090f',
  grid: '#141b26',
  axis: '#3f4a5a',
  text: '#8b95a5',
  dim: '#5b6575',
  teal: '#2dd4bf',
  amber: '#fbbf24',
  violet: '#a78bfa',
  rose: '#fb7185',
  ice: '#7dd3fc',
  white: '#e4eaf2',
  hist: '#93a4bd',
  histLive: '#e4eaf2',
};

/** per-model overlay color cycle (primary takes teal) */
const MODEL_COLORS = [C.teal, C.amber, C.violet, C.ice, C.rose, '#4ade80', '#f472b6', '#60a5fa'];

export interface ForecastChartOptions {
  /** history bars visible left of the cutoff */
  historyBars: number;
  /** overlay point lines for these aliases (besides the primary) */
  overlays: string[];
  /** show level band polygons */
  showBands: boolean;
}

interface Props {
  state: FcFeedState;
  config: FcConfig;
  primaryAlias: string;
  options: ForecastChartOptions;
  height?: number;
}

function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 10_000) return v.toFixed(0);
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtTime(ds: number): string {
  const d = new Date(ds);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ForecastChart({ state, config, primaryAlias, options, height = 430 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  // hover bumps a local counter so the draw effect re-runs (crosshair follows the pointer)
  const [hoverTick, bumpHover] = useReducer((x: number) => x + 1, 0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const optsRef = useRef(options);
  optsRef.current = options;
  const cfgRef = useRef(config);
  cfgRef.current = config;
  const primaryRef = useRef(primaryAlias);
  primaryRef.current = primaryAlias;

  // redraw on every state mutation + resize; canvas draw is idempotent
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let raf = 0;

    const draw = () => {
      raf = 0;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const st = stateRef.current;
      const opts = optsRef.current;
      const cfg = cfgRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = wrap.getBoundingClientRect();
      const cw = Math.max(320, rect.width);
      const ch = height;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        canvas.style.width = `${cw}px`;
        canvas.style.height = `${ch}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // paint base
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, cw, ch);

      const series = st.panel?.series?.[0];
      const models = st.models ?? [];
      if (!series || !series.points.length || !models.length) {
        ctx.fillStyle = C.dim;
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(st.error ? `error: ${st.error}` : st.loading ? 'building flow-bar panel…' : 'no series', cw / 2, ch / 2);
        return;
      }

      const hist = series.points.slice(-Math.max(40, opts.historyBars));
      const primary = models.find((m) => m.alias === primaryRef.current) ?? models[0];
      const overlays = models.filter((m) => m.alias !== primary.alias && opts.overlays.includes(m.alias));
      const levels = cfg.levels;

      // ── scales ────────────────────────────────────────────────────────
      const t0 = hist[0].ds;
      const tHistEnd = hist[hist.length - 1].ds;
      const hSteps = primary.rows.length;
      const tEnd = primary.rows.length ? primary.rows[primary.rows.length - 1].ds : tHistEnd + hSteps * cfg.tf;
      const padL = 8;
      const padR = 64;
      const padT = 34;
      const padB = 22;
      const plotW = cw - padL - padR;
      const plotH = ch - padT - padB;
      const xOf = (ds: number) => padL + ((ds - t0) / Math.max(1, tEnd - t0)) * plotW;

      // y range from history + visible bands + overlay points
      let vLo = Infinity;
      let vHi = -Infinity;
      for (const p of hist) {
        if (!Number.isFinite(p.y)) continue;
        vLo = Math.min(vLo, p.y);
        vHi = Math.max(vHi, p.y);
      }
      const considerBand = (m: typeof models[number]) => {
        for (const r of m.rows) {
          if (!opts.showBands || m.alias !== primary.alias) {
            if (Number.isFinite(r.point)) {
              vLo = Math.min(vLo, r.point);
              vHi = Math.max(vHi, r.point);
            }
            continue;
          }
          for (const li of r.levels) {
            if (Number.isFinite(li.lo)) vLo = Math.min(vLo, li.lo);
            if (Number.isFinite(li.hi)) vHi = Math.max(vHi, li.hi);
          }
        }
      };
      considerBand(primary);
      for (const m of overlays) considerBand(m);
      if (!Number.isFinite(vLo) || !Number.isFinite(vHi)) {
        ctx.fillStyle = C.dim;
        ctx.textAlign = 'center';
        ctx.fillText('insufficient data', cw / 2, ch / 2);
        return;
      }
      if (vHi === vLo) {
        vHi += Math.abs(vHi) * 0.005 + 1;
        vLo -= Math.abs(vLo) * 0.005 + 1;
      }
      const vPad = (vHi - vLo) * 0.06;
      vLo -= vPad;
      vHi += vPad;
      const yOf = (v: number) => padT + (1 - (v - vLo) / (vHi - vLo)) * plotH;

      // ── grid + y labels ───────────────────────────────────────────────
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      const yTicks = 6;
      for (let i = 0; i <= yTicks; i++) {
        const v = vLo + ((vHi - vLo) * i) / yTicks;
        const y = yOf(v);
        ctx.beginPath();
        ctx.moveTo(padL, y + 0.5);
        ctx.lineTo(cw - padR + 40, y + 0.5);
        ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.fillText(fmtVal(v), cw - padR + 46, y + 3);
      }

      // x grid: coarse time ticks over history + horizon
      ctx.textAlign = 'center';
      const xTicks = Math.max(4, Math.min(10, Math.floor(plotW / 90)));
      for (let i = 0; i <= xTicks; i++) {
        const ds = t0 + ((tEnd - t0) * i) / xTicks;
        const x = xOf(ds);
        ctx.strokeStyle = C.grid;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, padT);
        ctx.lineTo(x + 0.5, padT + plotH);
        ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.fillText(fmtTime(ds), x, ch - 8);
      }

      // ── horizon shading (right of cutoff) ─────────────────────────────
      const xCut = xOf(tHistEnd);
      if (Number.isFinite(xCut)) {
        ctx.fillStyle = 'rgba(45, 212, 191, 0.03)';
        ctx.fillRect(xCut, padT, cw - padR - xCut + 40, plotH);
      }

      // ── level band polygons (primary only, inner→outer) ───────────────
      if (opts.showBands && primary.rows.length) {
        const perLevel = [...levels].sort((a, b) => a - b);
        // draw widest first so inner bands sit on top
        for (let li = perLevel.length - 1; li >= 0; li--) {
          const level = perLevel[li];
          const alpha = 0.05 + 0.09 * (li + 1) * (perLevel.length > 1 ? 1 : 1.6);
          ctx.fillStyle = `rgba(45, 212, 191, ${alpha.toFixed(3)})`;
          ctx.strokeStyle = `rgba(45, 212, 191, ${(0.25 + 0.16 * li).toFixed(2)})`;
          ctx.lineWidth = 1;
          // polygon: hi forward then lo backward, anchored at last history y
          const anchorX = xCut;
          const anchorY = yOf(hist[hist.length - 1].y);
          ctx.beginPath();
          let started = false;
          for (const r of primary.rows) {
            const band = r.levels.find((b) => b.level === level);
            if (!band || !Number.isFinite(band.hi)) continue;
            const x = xOf(r.ds);
            const y = yOf(band.hi);
            if (!started) {
              ctx.moveTo(anchorX, anchorY);
              started = true;
            }
            ctx.lineTo(x, y);
          }
          for (let i = primary.rows.length - 1; i >= 0; i--) {
            const r = primary.rows[i];
            const band = r.levels.find((b) => b.level === level);
            if (!band || !Number.isFinite(band.lo)) continue;
            ctx.lineTo(xOf(r.ds), yOf(band.lo));
          }
          if (started) {
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
        }
      }

      // ── point forecast lines ──────────────────────────────────────────
      const drawModelLine = (m: typeof models[number], color: string, bright: boolean) => {
        if (!m.rows.length) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = bright ? 2 : 1.25;
        ctx.setLineDash(bright ? [] : [4, 3]);
        ctx.beginPath();
        ctx.moveTo(xCut, yOf(hist[hist.length - 1].y));
        for (const r of m.rows) {
          if (!Number.isFinite(r.point)) continue;
          ctx.lineTo(xOf(r.ds), yOf(r.point));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        // terminal dot
        const last = m.rows[m.rows.length - 1];
        if (last && Number.isFinite(last.point)) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(xOf(last.ds), yOf(last.point), bright ? 3 : 2, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      for (const m of overlays) drawModelLine(m, MODEL_COLORS[(models.indexOf(m) + 1) % MODEL_COLORS.length], false);
      drawModelLine(primary, C.teal, true);

      // ── history line ─────────────────────────────────────────────────
      ctx.strokeStyle = C.hist;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let first = true;
      for (const p of hist) {
        const x = xOf(p.ds);
        const y = yOf(p.y);
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // engine live tail emphasis
      if (series.liveTailFrom && hist.some((p) => p.ds >= series.liveTailFrom!)) {
        ctx.strokeStyle = C.histLive;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let f2 = true;
        for (const p of hist) {
          if (p.ds < series.liveTailFrom!) continue;
          const x = xOf(p.ds);
          const y = yOf(p.y);
          if (f2) {
            ctx.moveTo(x, y);
            f2 = false;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // ── cutoff divider ────────────────────────────────────────────────
      ctx.strokeStyle = 'rgba(227, 232, 240, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xCut + 0.5, padT - 4);
      ctx.lineTo(xCut + 0.5, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.dim;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('now', xCut + 4, padT - 8);
      ctx.textAlign = 'right';
      ctx.fillText(`h=${cfg.h} steps · ${(cfg.h * cfg.tf) / 60_000}m`, xCut - 4, padT - 8);

      // ── header: model legend + expected move ─────────────────────────
      ctx.textAlign = 'left';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = C.teal;
      ctx.fillText(primary.alias, padL + 4, 12);
      ctx.fillStyle = C.dim;
      const calib = primary.calibration;
      const calibTxt = calib
        ? calib.ok
          ? `W=${calib.nWindows} · Δ=${calib.stepSize} · ${primary.intervals}`
          : `calibration short (${calib.available}/${calib.required})`
        : primary.intervals === 'native'
          ? 'native knots {0.1,0.5,0.9}'
          : primary.intervals;
      ctx.fillText(calibTxt, padL + 4 + ctx.measureText(primary.alias).width + 10, 12);

      const em = primary.expectedMove;
      ctx.textAlign = 'right';
      if (em) {
        ctx.fillStyle = C.amber;
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(`expected move ${em.widthPct ? em.widthPct.toFixed(2) : '?'}% · ${fmtVal(em.lo)}–${fmtVal(em.hi)} (${em.level}%)`, cw - padR + 40, 12);
      } else {
        ctx.fillStyle = C.dim;
        ctx.fillText(`${cfg.target} · levels ${levels.join('/')}%`, cw - padR + 40, 12);
      }

      // ── crosshair + tooltip ─────────────────────────────────────────
      const hov = hoverRef.current;
      if (hov && hov.x >= padL && hov.x <= cw - padR + 40 && hov.y >= padT && hov.y <= padT + plotH) {
        ctx.strokeStyle = 'rgba(139, 149, 165, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hov.x + 0.5, padT);
        ctx.lineTo(hov.x + 0.5, padT + plotH);
        ctx.stroke();

        // nearest row
        const dsAt = t0 + ((hov.x - padL) / plotW) * (tEnd - t0);
        let rows: { label: string; color: string; row: (typeof primary.rows)[number] }[] = [];
        let histPt: { ds: number; y: number } | null = null;
        if (dsAt <= tHistEnd) {
          let best = hist[0];
          for (const p of hist) if (Math.abs(p.ds - dsAt) < Math.abs(best.ds - dsAt)) best = p;
          histPt = best;
        } else {
          let best = primary.rows[0];
          for (const r of primary.rows) if (Math.abs(r.ds - dsAt) < Math.abs(best.ds - dsAt)) best = r;
          rows = [
            { label: primary.alias, color: C.teal, row: best },
            ...overlays.map((m) => {
              let bm = m.rows[0];
              for (const r of m.rows) if (Math.abs(r.ds - dsAt) < Math.abs(bm.ds - dsAt)) bm = r;
              return { label: m.alias, color: MODEL_COLORS[(models.indexOf(m) + 1) % MODEL_COLORS.length], row: bm };
            }),
          ];
        }

        // tooltip card
        const lines: string[] = [];
        if (histPt) {
          lines.push(`observed ${fmtTime(histPt.ds)}`, `${fmtVal(histPt.y)}`);
        } else if (rows.length) {
          const r = rows[0].row;
          lines.push(`forecast ${fmtTime(r.ds)} · step ${r.step}`);
          for (const { label, color, row } of rows) lines.push(`${label.padEnd(14, ' ')} ${fmtVal(row.point)}`);
          const pr = rows[0].row;
          for (const li of pr.levels) {
            lines.push(`  ${li.level}%: ${fmtVal(li.lo)} … ${fmtVal(li.hi)}`);
          }
        }
        const wBox = Math.min(190, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16);
        const hBox = lines.length * 13 + 10;
        const bx = Math.min(hov.x + 12, cw - padR + 40 - wBox);
        const by = Math.min(Math.max(padT + 4, hov.y - 16), padT + plotH - hBox - 4);
        ctx.fillStyle = 'rgba(5, 7, 10, 0.92)';
        ctx.strokeStyle = 'rgba(63, 74, 90, 0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(bx, by, wBox, hBox, 5);
        ctx.fill();
        ctx.stroke();
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'left';
        lines.forEach((l, i) => {
          ctx.fillStyle = i === 0 ? C.dim : l.startsWith('  ') ? C.ice : C.white;
          ctx.fillText(l, bx + 8, by + 14 + i * 13);
        });
        // band bounds markers on the crosshair for the primary row
        if (rows.length) {
          const r = rows[0].row;
          for (const li of r.levels) {
            if (!Number.isFinite(li.lo) || !Number.isFinite(li.hi)) continue;
            ctx.fillStyle = 'rgba(125, 211, 252, 0.9)';
            ctx.fillRect(hov.x - 2, yOf(li.lo) - 1, 4, 2);
            ctx.fillRect(hov.x - 2, yOf(li.hi) - 1, 4, 2);
          }
        }
      }
    };

    const request = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    request();
    const ro = new ResizeObserver(request);
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [height, state, config, primaryAlias, options, hoverTick]);

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden rounded-lg border border-zinc-800/80">
      <canvas
        ref={canvasRef}
        className="block w-full cursor-crosshair"
        onMouseMove={(e) => {
          const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
          hoverRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
          bumpHover();
        }}
        onMouseLeave={() => {
          hoverRef.current = null;
          bumpHover();
        }}
      />
    </div>
  );
}

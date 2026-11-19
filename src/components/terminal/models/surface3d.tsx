'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · surface3d — the lab's 3D engine. A self-contained canvas
// renderer (no chart library, no WebGL) that paints every mental model in the
// terminal's dark-teal design language:
//
//   • SURFACES  — z = f(x, y) grids drawn as painter's-algorithm quad meshes,
//                 colored by height on the shared viridis ramp (or a constant
//                 tint for overlay wireframes — "BS vs the skewed market")
//   • PATHS     — 3D polylines lifted over a surface (the May-2021 path on
//                 the gamma ridge, the American put's free-boundary curve)
//   • DOTS      — 3D scatter (quotes on the vol surface)
//   • PLANES    — translucent vertical planes (barriers) / floor highlights
//
//   Interaction: DRAG to orbit (yaw + pitch) · WHEEL to zoom · DOUBLE-CLICK
//   (or R) to reset · ARROWS orbit from the keyboard. The camera starts at
//   the lecture's default 3/4 pose. Deterministic: same data ⇒ same pixels;
//   one draw per camera move (no animation loop — the CPU stays calm).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from 'react';
// useState used only for the responsive size — the canvas itself redraws imperatively
import { sequentialColor } from '@/lib/quant/heatmap';
import { fmtNum } from '@/lib/format';

export interface SurfaceData {
  /** x-axis values (e.g. log-moneyness k, spot, strike) */
  x: number[];
  /** y-axis values (e.g. expiry T, vol) */
  y: number[];
  /** z[xi][yi] — height */
  z: number[][];
}

export interface SurfaceSpec {
  data: SurfaceData;
  /** color by height (viridis) or a constant tint */
  mode?: 'height' | 'const';
  color?: string;
  /** overlay surfaces render as wireframes so the primary stays visible */
  wireframe?: boolean;
  label?: string;
}

export interface PathSpec {
  /** points in DATA space (x, y, z) */
  points: { x: number; y: number; z: number }[];
  color: string;
  width?: number;
  /** draw a glowing dot at the last point */
  headDot?: boolean;
}

export interface DotSpec {
  points: { x: number; y: number; z: number }[];
  color: string;
  radius?: number;
}

export interface PlaneSpec {
  /** translucent wall perpendicular to the y axis (barrier along time) */
  axis: 'y';
  at: number;
  color: string;
  alpha?: number;
}

export interface Surface3dProps {
  surfaces: SurfaceSpec[];
  paths?: PathSpec[];
  dots?: DotSpec[];
  planes?: PlaneSpec[];
  xLabel: string;
  yLabel: string;
  zLabel: string;
  height?: number;
  /** fixed z domain (else auto from data) */
  zDomain?: [number, number];
  formatZ?: (v: number) => string;
}

interface Cam {
  yaw: number;
  pitch: number;
  zoom: number;
}

const DEFAULT_CAM: Cam = { yaw: -0.62, pitch: 0.42, zoom: 1 };

type P3 = { x: number; y: number; z: number };

/** One painter's-algorithm drawable. Quads carry 4 projected corners. */
type Drawable =
  | { kind: 'quad'; px: number[]; py: number[]; depth: number; fill: string; stroke?: string }
  | { kind: 'seg'; x1: number; y1: number; x2: number; y2: number; depth: number; stroke: string; width: number }
  | { kind: 'dot'; x: number; y: number; depth: number; fill: string; r: number };

export function Surface3d(props: Surface3dProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<Cam>({ ...DEFAULT_CAM });
  const dragRef = useRef<{ px: number; py: number } | null>(null);
  const [size, setSize] = useState({ w: 640, h: props.height ?? 260 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w > 40) setSize({ w, h: props.height ?? 260 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.height]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = size.w;
    const H = size.h;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // ── data extents ─────────────────────────────────────────────────────
    const s0 = props.surfaces[0]?.data;
    if (!s0 || !s0.x.length || !s0.y.length) {
      ctx.fillStyle = 'rgba(113,113,122,0.8)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('no data', W / 2, H / 2);
      return;
    }
    const xMin = Math.min(...s0.x);
    const xMax = Math.max(...s0.x);
    let yMin = Math.min(...s0.y);
    let yMax = Math.max(...s0.y);
    let zLo = Infinity;
    let zHi = -Infinity;
    for (const s of props.surfaces) {
      for (const row of s.data.z) {
        for (const v of row) {
          if (Number.isFinite(v)) {
            zLo = Math.min(zLo, v);
            zHi = Math.max(zHi, v);
          }
        }
      }
    }
    if (props.zDomain) {
      zLo = props.zDomain[0];
      zHi = props.zDomain[1];
    }
    for (const p of props.paths ?? []) {
      for (const pt of p.points) {
        zLo = Math.min(zLo, pt.z);
        zHi = Math.max(zHi, pt.z);
      }
    }
    if (!Number.isFinite(zLo)) zLo = 0;
    if (!Number.isFinite(zHi) || zHi <= zLo + 1e-12) zHi = zLo + 1;
    if (yMax === yMin) yMax = yMin + 1;

    const cam = camRef.current;

    // ── projection: normalize into a cube, yaw+pitch rotate, perspective ──
    const nx = (v: number) => (xMax === xMin ? 0.5 : (v - xMin) / (xMax - xMin));
    const ny = (v: number) => (yMax === yMin ? 0.5 : (v - yMin) / (yMax - yMin));
    const nz = (v: number) => (v - zLo) / (zHi - zLo);

    const SPAN = 148 * cam.zoom;
    const cx = W / 2;
    const cy = H / 2 + 8;
    const project = (p: P3) => {
      const wx = (nx(p.x) - 0.5) * SPAN;
      const wy = (ny(p.y) - 0.5) * SPAN;
      const wz = (nz(p.z) - 0.1) * SPAN * 0.6;
      const cosY = Math.cos(cam.yaw);
      const sinY = Math.sin(cam.yaw);
      const rx = wx * cosY - wy * sinY;
      const ry = wx * sinY + wy * cosY;
      const cosP = Math.cos(cam.pitch);
      const sinP = Math.sin(cam.pitch);
      const sx = rx;
      const sy = ry * cosP - wz * sinP;
      const sz = ry * sinP + wz * cosP;
      const dist = 6 * SPAN;
      const k = dist / (dist + sz);
      return { sx: cx + sx * k, sy: cy - sy * k, depth: -sz * k };
    };

    const zColor = (v: number) =>
      Number.isFinite(v) ? sequentialColor(Math.max(0, Math.min(1, (v - zLo) / (zHi - zLo)))) : '#27272a';
    const drawables: Drawable[] = [];

    const addSeg = (a: P3, b: P3, stroke: string, width: number, depthBias = 0) => {
      const pa = project(a);
      const pb = project(b);
      drawables.push({
        kind: 'seg',
        x1: pa.sx,
        y1: pa.sy,
        x2: pb.sx,
        y2: pb.sy,
        depth: Math.min(pa.depth, pb.depth) + depthBias,
        stroke,
        width,
      });
    };
    const addQuad = (a: P3, b: P3, c: P3, d: P3, fill: string, stroke: string | undefined, depthBias = 0) => {
      const pa = project(a);
      const pb = project(b);
      const pc = project(c);
      const pd = project(d);
      drawables.push({
        kind: 'quad',
        px: [pa.sx, pb.sx, pc.sx, pd.sx],
        py: [pa.sy, pb.sy, pc.sy, pd.sy],
        depth: (pa.depth + pb.depth + pc.depth + pd.depth) / 4 + depthBias,
        fill,
        stroke,
      });
    };

    // ── axis frame + floor grid (drawn early → they sort to the back) ────
    const c0 = { x: xMin, y: yMin, z: zLo };
    const c1 = { x: xMax, y: yMin, z: zLo };
    const c2 = { x: xMax, y: yMax, z: zLo };
    const c3 = { x: xMin, y: yMax, z: zLo };
    for (const [a, b] of [
      [c0, c1],
      [c1, c2],
      [c2, c3],
      [c3, c0],
    ] as [P3, P3][]) {
      addSeg(a, b, 'rgba(63,63,70,0.6)', 1, -2);
      addSeg(a, { ...a, z: zHi }, 'rgba(63,63,70,0.28)', 1, -2);
    }
    for (let i = 1; i < 4; i++) {
      const gx = xMin + ((xMax - xMin) * i) / 4;
      const gy = yMin + ((yMax - yMin) * i) / 4;
      addSeg({ x: gx, y: yMin, z: zLo }, { x: gx, y: yMax, z: zLo }, 'rgba(63,63,70,0.22)', 0.6, -2);
      addSeg({ x: xMin, y: gy, z: zLo }, { x: xMax, y: gy, z: zLo }, 'rgba(63,63,70,0.22)', 0.6, -2);
    }

    // ── barrier planes (translucent walls perpendicular to y) ────────────
    for (const pl of props.planes ?? []) {
      const alpha = pl.alpha ?? 0.08;
      addQuad(
        { x: xMin, y: pl.at, z: zLo },
        { x: xMax, y: pl.at, z: zLo },
        { x: xMax, y: pl.at, z: zHi },
        { x: xMin, y: pl.at, z: zHi },
        pl.color.replace(/rgba?\(([^)]+)\)/, (_m, inner: string) => `rgba(${inner.split(',').slice(0, 3).join(',')},${alpha})`),
        undefined,
        -0.4,
      );
    }

    // ── surfaces: painter's-algorithm mesh cells ─────────────────────────
    props.surfaces.forEach((s, si) => {
      const { x, y, z } = s.data;
      for (let xi = 0; xi < x.length - 1; xi++) {
        for (let yi = 0; yi < y.length - 1; yi++) {
          // ragged/short grids degrade to skipped cells instead of crashing
          const zTL = z[xi]?.[yi];
          const zTR = z[xi + 1]?.[yi];
          const zBR = z[xi + 1]?.[yi + 1];
          const zBL = z[xi]?.[yi + 1];
          if (!Number.isFinite(zTL) || !Number.isFinite(zTR) || !Number.isFinite(zBR) || !Number.isFinite(zBL)) continue;
          const a: P3 = { x: x[xi], y: y[yi], z: zTL };
          const b: P3 = { x: x[xi + 1], y: y[yi], z: zTR };
          const c: P3 = { x: x[xi + 1], y: y[yi + 1], z: zBR };
          const d: P3 = { x: x[xi], y: y[yi + 1], z: zBL };
          const zmid = (a.z + b.z + c.z + d.z) / 4;
          if (s.wireframe) {
            addSeg(a, b, s.color ?? '#a78bfa', 0.7, 0.1);
            addSeg(a, d, s.color ?? '#a78bfa', 0.7, 0.1);
            if (yi === y.length - 2) addSeg(d, c, s.color ?? '#a78bfa', 0.7, 0.1);
            if (xi === x.length - 2) addSeg(b, c, s.color ?? '#a78bfa', 0.7, 0.1);
          } else if (si === 0) {
            const fill = s.mode === 'const' ? s.color ?? '#2dd4bf' : zColor(zmid);
            addQuad(a, b, c, d, fill, 'rgba(10,13,20,0.5)');
          } else {
            // secondary solid surface at a translucent tint
            addQuad(a, b, c, d, s.color ?? 'rgba(167,139,250,0.18)', undefined, 0.15);
          }
        }
      }
    });

    // ── paths + dots (sorted ABOVE the surfaces) ─────────────────────────
    for (const p of props.paths ?? []) {
      for (let i = 0; i < p.points.length - 1; i++) {
        addSeg(p.points[i], p.points[i + 1], p.color, p.width ?? 1.6, 1);
      }
      if (p.headDot) {
        const e = project(p.points[p.points.length - 1]);
        drawables.push({ kind: 'dot', x: e.sx, y: e.sy, depth: e.depth + 2, fill: p.color, r: 3 });
      }
    }
    for (const d of props.dots ?? []) {
      for (const pt of d.points) {
        const q = project(pt);
        drawables.push({ kind: 'dot', x: q.sx, y: q.sy, depth: q.depth + 1.5, fill: d.color, r: d.radius ?? 2 });
      }
    }

    // ── painter's algorithm: far → near ───────────────────────────────────
    drawables.sort((a, b) => a.depth - b.depth);
    for (const d of drawables) {
      if (d.kind === 'seg') {
        ctx.strokeStyle = d.stroke;
        ctx.lineWidth = d.width;
        ctx.beginPath();
        ctx.moveTo(d.x1, d.y1);
        ctx.lineTo(d.x2, d.y2);
        ctx.stroke();
      } else if (d.kind === 'dot') {
        ctx.fillStyle = d.fill;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = d.fill;
        ctx.beginPath();
        ctx.moveTo(d.px[0], d.py[0]);
        for (let i = 1; i < 4; i++) ctx.lineTo(d.px[i], d.py[i]);
        ctx.closePath();
        ctx.fill();
        if (d.stroke) {
          ctx.strokeStyle = d.stroke;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    // ── axis labels ──────────────────────────────────────────────────────
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(161,161,170,0.9)';
    const fmt = (v: number) => (Math.abs(v) >= 100 ? fmtNum(v, 0) : Math.abs(v) >= 10 ? fmtNum(v, 1) : fmtNum(v, 2));
    const zFmt = props.formatZ ?? fmt;
    const front = project({ x: xMin, y: yMin, z: zLo });
    const frontR = project({ x: xMax, y: yMin, z: zLo });
    ctx.textAlign = 'left';
    ctx.fillText(`${props.xLabel} ${fmt(xMin)}`, Math.max(2, front.sx - 34), Math.min(H - 3, front.sy + 11));
    ctx.textAlign = 'right';
    ctx.fillText(`${fmt(xMax)}`, Math.min(W - 2, frontR.sx + 2), Math.min(H - 3, frontR.sy + 11));
    ctx.textAlign = 'left';
    ctx.fillText(`${props.yLabel} ${fmt(yMin)} … ${fmt(yMax)}`, Math.max(2, front.sx + 6), Math.max(9, front.sy - 4));
    ctx.fillText(`${props.zLabel} ${zFmt(zLo)} … ${zFmt(zHi)}`, 4, 10);
  }, [props, size]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ── interaction ──────────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { px: e.clientX, py: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    d.px = e.clientX;
    d.py = e.clientY;
    const cam = camRef.current;
    cam.yaw += dx * 0.008;
    cam.pitch = Math.max(-1.35, Math.min(1.35, cam.pitch + dy * 0.006));
    draw();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const cam = camRef.current;
    cam.zoom = Math.max(0.45, Math.min(3.2, cam.zoom * (1 - e.deltaY * 0.0012)));
    draw();
  };
  const resetCam = () => {
    camRef.current = { ...DEFAULT_CAM };
    draw();
  };

  return (
    <div ref={wrapRef} className="w-full select-none" style={{ touchAction: 'none' }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`3D surface: ${props.xLabel} by ${props.yLabel}, height ${props.zLabel}`}
        className="w-full cursor-grab rounded-md bg-zinc-950/60 ring-1 ring-zinc-800/70 focus:outline-none focus-visible:ring-teal-500/60 active:cursor-grabbing"
        style={{ height: props.height ?? 260 }}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={resetCam}
        onKeyDown={(e) => {
          const cam = camRef.current;
          if (e.key === 'ArrowLeft') cam.yaw -= 0.12;
          else if (e.key === 'ArrowRight') cam.yaw += 0.12;
          else if (e.key === 'ArrowUp') cam.pitch = Math.min(1.35, cam.pitch + 0.1);
          else if (e.key === 'ArrowDown') cam.pitch = Math.max(-1.35, cam.pitch - 0.1);
          else if (e.key === '+' || e.key === '=') cam.zoom = Math.min(3.2, cam.zoom * 1.15);
          else if (e.key === '-') cam.zoom = Math.max(0.45, cam.zoom / 1.15);
          else if (e.key === 'r' || e.key === 'R') {
            resetCam();
            e.preventDefault();
            return;
          } else return;
          e.preventDefault();
          draw();
        }}
      />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[8px] text-zinc-600">
        <span className="font-mono">drag · orbit&nbsp;&nbsp;wheel · zoom&nbsp;&nbsp;dbl-click / r · reset</span>
        <span className="flex flex-wrap items-center gap-2">
          {props.surfaces
            .filter((s) => s.label)
            .map((s) => (
              <span key={s.label} className="flex items-center gap-1 font-mono">
                <span className="h-1.5 w-3 rounded-sm" style={{ background: s.color ?? '#2dd4bf' }} />
                {s.label}
              </span>
            ))}
        </span>
      </div>
    </div>
  );
}

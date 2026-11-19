'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — WindowFrame. Every panel in the Script Lab lives in a free
// floating window: drag by the title bar (pointer events, mouse + touch),
// resize from 8 edges/corners, maximize (title double-click or button),
// minimize to the dock strip, close/re-open from the toolbar. Focus raises
// z-order; the full layout persists.
//
// Plus the dock-system affordances, implemented on the window chrome:
//   • COLLAPSE — title-bar chevron; animated 0fr→1fr grid transition keeps
//     the children MOUNTED while collapsed (charts/SSE survive)
//   • FULLSCREEN FOCUS — expand button pins the window to fixed inset-3
//     z-50 until restored; Esc restores too (same pattern as dock.tsx)
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Square, X, Maximize2, Copy, ChevronDown, ChevronRight, Expand, Minimize2 } from 'lucide-react';
import type { PanelId, WindowLayout } from '@/stores/scriptlab-store';

interface WindowFrameProps {
  id: PanelId;
  title: string;
  icon: React.ReactNode;
  layout: WindowLayout;
  bounds: { w: number; h: number };
  onPointerDownBody?: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (rect: { x?: number; y?: number; w?: number; h?: number }) => void;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onFocus: () => void;
  children: React.ReactNode;
}

const MIN_W = 300;
const MIN_H = 240;

type DragMode = null | 'move' | 'e' | 'w' | 'n' | 's' | 'ne' | 'nw' | 'se' | 'sw';

export function WindowFrame({
  id,
  title,
  icon,
  layout,
  bounds,
  onMove,
  onResize,
  onClose,
  onMinimize,
  onMaximize,
  onFocus,
  children,
}: WindowFrameProps) {
  // ── drag engine ────────────────────────────────────────────────────────────
  // window-level listeners while dragging: robust for mouse, touch and drags
  // that leave the window bounds (no reliance on pointer capture).
  interface DragState {
    mode: DragMode;
    px: number;
    py: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  // latest callbacks/bounds for the window listeners (read at event time)
  const applyRef = useRef({ bounds, onMove, onResize });
  useEffect(() => {
    applyRef.current = { bounds, onMove, onResize };
  }, [bounds, onMove, onResize]);

  // ── collapse (content stays mounted — same grid 0fr↔1fr trick as dock.tsx)
  const [collapsed, setCollapsed] = useState(false);
  // ── transient fullscreen focus overlay (never persisted)
  const [fullscreen, setFullscreen] = useState(false);

  // Esc exits the fullscreen overlay (dock.tsx interaction pattern)
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const beginDrag = useCallback(
    (mode: DragMode) => (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if ((layout.maximized || fullscreen) && mode === 'move') return; // maximized/fullscreen windows don't drag
      e.preventDefault();
      onFocus();
      const start: DragState = { mode, px: e.clientX, py: e.clientY, x: layout.x, y: layout.y, w: layout.w, h: layout.h };
      dragRef.current = start;
      setDragging(start);
      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* untrusted/synthetic events — window listeners carry the drag */
      }
    },
    [layout.maximized, fullscreen, layout.x, layout.y, layout.w, layout.h, onFocus],
  );

  useEffect(() => {
    if (!dragging) return;
    const onWinMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !d.mode) return;
      const { bounds: b, onMove: mv, onResize: rs } = applyRef.current;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;

      if (d.mode === 'move') {
        mv(
          Math.max(-d.w + 120, Math.min(b.w - 120, d.x + dx)),
          Math.max(0, Math.min(b.h - 36, d.y + dy)),
        );
        return;
      }
      let { x, y, w, h } = d;
      if (d.mode.includes('e')) w = Math.max(MIN_W, Math.min(b.w - d.x, d.w + dx));
      if (d.mode.includes('s')) h = Math.max(MIN_H, Math.min(b.h - d.y, d.h + dy));
      if (d.mode.includes('w')) {
        const x2 = Math.max(0, d.x + dx);
        w = Math.max(MIN_W, d.x + d.w - x2);
        x = d.x + d.w - w;
      }
      if (d.mode.includes('n')) {
        const y2 = Math.max(0, d.y + dy);
        h = Math.max(MIN_H, d.y + d.h - y2);
        y = d.y + d.h - h;
      }
      rs({ x, y, w, h });
    };
    const onWinUp = () => {
      dragRef.current = null;
      setDragging(null);
    };
    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('pointercancel', onWinUp);
    return () => {
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinUp);
    };
  }, [dragging]);

  // visual affordance while an active drag touches this window
  const isDragging = dragging !== null;

  // constrain on bounds change (viewport resize)
  useEffect(() => {
    if (layout.maximized) return;
    const w = Math.min(layout.w, Math.max(MIN_W, bounds.w));
    const h = Math.min(layout.h, Math.max(MIN_H, bounds.h));
    if (w !== layout.w || h !== layout.h) onResize({ w, h });
  }, [bounds.w, bounds.h]);

  if (layout.minimized || layout.closed) return null;

  // fullscreen focus overlay: fixed inset-3 z-50 (dock.tsx pattern); a
  // collapsed window shrinks to its title bar (height auto).
  const style: React.CSSProperties = fullscreen
    ? { position: 'fixed', inset: 12, zIndex: 50 }
    : layout.maximized
      ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: layout.z }
      : {
          left: layout.x,
          top: layout.y,
          width: layout.w,
          height: collapsed ? 'auto' : layout.h,
          zIndex: layout.z,
        };

  const handles: Array<{ mode: DragMode; cls: string; cursor: string }> = [
    { mode: 'n', cls: 'top-0 left-[10%] right-[10%] h-[6px] cursor-ns-resize', cursor: 'ns-resize' },
    { mode: 's', cls: 'bottom-0 left-[10%] right-[10%] h-[6px] cursor-ns-resize', cursor: 'ns-resize' },
    { mode: 'w', cls: 'left-0 top-[10%] bottom-[10%] w-[6px] cursor-ew-resize', cursor: 'ew-resize' },
    { mode: 'e', cls: 'right-0 top-[10%] bottom-[10%] w-[6px] cursor-ew-resize', cursor: 'ew-resize' },
    { mode: 'nw', cls: 'left-0 top-0 h-3 w-3 cursor-nwse-resize', cursor: 'nwse-resize' },
    { mode: 'ne', cls: 'right-0 top-0 h-3 w-3 cursor-nesw-resize', cursor: 'nesw-resize' },
    { mode: 'sw', cls: 'left-0 bottom-0 h-3 w-3 cursor-nesw-resize', cursor: 'nesw-resize' },
    { mode: 'se', cls: 'right-0 bottom-0 h-3 w-3 cursor-nwse-resize', cursor: 'nwse-resize' },
  ];

  return (
    <section
      aria-label={`${title} window`}
      className={`absolute flex flex-col overflow-hidden rounded-lg border border-zinc-700/80 bg-[#0a0d12]/98 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-sm transition-shadow ${
        layout.maximized || fullscreen ? 'rounded-none' : ''
      } ${fullscreen ? 'ring-1 ring-teal-500/30' : ''}`}
      style={style}
      onPointerDown={() => onFocus()}
    >
      {/* title bar */}
      <header
        className="flex h-8 shrink-0 touch-none select-none items-center gap-2 border-b border-zinc-800 bg-zinc-900/95 px-2.5"
        onPointerDown={beginDrag('move')}
        onDoubleClick={() => onMaximize()}
      >
        <span className="flex h-4 w-4 items-center justify-center text-teal-400/90">{icon}</span>
        <h3 className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
          {title}
        </h3>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((c) => !c);
          }}
          title={collapsed ? 'Expand window' : 'Collapse window — content stays mounted'}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          aria-expanded={!collapsed}
          className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setFullscreen((f) => !f);
          }}
          title={fullscreen ? 'Restore from fullscreen (Esc)' : 'Expand to fullscreen focus'}
          aria-label={fullscreen ? `Restore ${title} from fullscreen` : `Expand ${title} to fullscreen`}
          className={`rounded p-1 transition ${
            fullscreen ? 'bg-teal-950/70 text-teal-300' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
          }`}
        >
          {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Expand className="h-3 w-3" />}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMinimize();
          }}
          title="Minimize to dock"
          aria-label={`Minimize ${title}`}
          className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          <Minus className="h-3 w-3" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMaximize();
          }}
          title={layout.maximized ? 'Restore' : 'Maximize'}
          aria-label={layout.maximized ? `Restore ${title}` : `Maximize ${title}`}
          className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          {layout.maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close"
          aria-label={`Close ${title}`}
          className="rounded p-1 text-zinc-500 transition hover:bg-rose-950 hover:text-rose-300"
        >
          <X className="h-3 w-3" />
        </button>
      </header>

      {/* body — animated collapse wrapper (grid-template-rows 0fr↔1fr keeps
          the children MOUNTED while collapsed, so charts & streams survive) */}
      <div
        className={`grid min-h-0 flex-1 overflow-hidden transition-[grid-template-rows] duration-200 ease-out ${
          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="relative h-full min-h-0 overflow-hidden">
            {children}
            {!layout.maximized && !fullscreen && (
              <>
                {handles.map((h) => (
                  <div
                    key={h.mode}
                    aria-hidden
                    className={`absolute z-30 touch-none ${h.cls}`}
                    style={{ cursor: h.cursor }}
                    onPointerDown={beginDrag(h.mode)}
                  />
                ))}
                <span aria-hidden className="pointer-events-none absolute bottom-1 right-1 text-zinc-700">
                  <Maximize2 className="h-2.5 w-2.5 opacity-40" />
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

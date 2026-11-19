'use client';

// ─────────────────────────────────────────────────────────────────────────────
// dock — the DRAGGABLE + ADJUSTABLE + EXPANDABLE + COLLAPSIBLE panel system
// ("all the parts inside").
//
//   <Dock viewId="quant-overview" layout="grid">
//     <DockPanel id="brief"  title="Market Brief" span={2} dock={{kind:'quant-overview', meta:{symbol}}}>…</DockPanel>
//     <DockPanel id="price"  title="Price" span={1}>…</DockPanel>
//   </Dock>
//
// Every DockPanel:
//   • DRAG its header grip onto another panel → reorder (persisted per view in
//     localStorage, survives reloads)
//   • ADJUST its height by dragging the bottom edge (pixel heights persisted;
//     the S/M/L button cycles 220px → 460px → auto; double-click the handle
//     to reset to auto)
//   • EXPAND to a fullscreen focus overlay (Maximize2 / Esc to restore — the
//     content stays mounted, so live charts and SSE state survive the round
//     trip)
//   • COLLAPSE with a smooth animated 0fr→1fr grid transition — children stay
//     MOUNTED while collapsed, so live panels keep their subscriptions
//   • "Open in Builder" (pin) → the panel's live section pops into the Builder
//     workspace dock (switch between pinned panels there — see builder-dock.tsx)
//
// Plain fallback: a DockPanel rendered OUTSIDE a Dock keeps the classic Panel
// look with no controls — so existing Panel call sites migrate one by one.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  Expand,
  GripVertical,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
} from 'lucide-react';
import { useDockStore, type DockKind } from '@/stores/dock-store';

/** Preset heights (px) for the resize cycle button; null = auto. */
export type PanelSize = 'S' | 'M' | 'L';

const PRESET_HEIGHT: Record<PanelSize, number | null> = { S: 220, M: 460, L: null };
const MIN_H = 140;
const MAX_H = 3000;

interface DockLayout {
  order: string[];
  collapsed: Record<string, boolean>;
  /** Pixel heights per panel id — absent/null = auto height. */
  height: Record<string, number | null>;
}

interface DockContextValue {
  viewId: string;
  layout: DockLayout;
  move: (draggedId: string, targetId: string) => void;
  toggleCollapse: (id: string) => void;
  setHeight: (id: string, px: number | null) => void;
  /** Transient fullscreen-expand state (never persisted). */
  expanded: Record<string, boolean>;
  toggleExpand: (id: string) => void;
}

const DockCtx = createContext<DockContextValue | null>(null);

// in-page drag payload (HTML5 dataTransfer keeps only types during dragover)
let volosDragging: { viewId: string; id: string } | null = null;

function loadLayout(viewId: string): DockLayout {
  try {
    const raw = localStorage.getItem(`volos-dock-${viewId}`);
    if (raw) {
      const l = JSON.parse(raw) as Partial<DockLayout>;
      if (Array.isArray(l.order)) {
        return {
          order: l.order,
          collapsed: l.collapsed ?? {},
          height: l.height ?? {},
        };
      }
    }
  } catch {
    /* fresh */
  }
  return { order: [], collapsed: {}, height: {} };
}

export interface DockProps {
  viewId: string;
  /** 'stack' = vertical list · 'grid' = 2-col grid at xl (span 1 cards sit side-by-side). */
  layout?: 'stack' | 'grid';
  className?: string;
  children: ReactNode;
}

export function Dock({ viewId, layout = 'stack', className, children }: DockProps) {
  const [state, setState] = useState<DockLayout>(() => loadLayout(viewId));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const kids = useMemo(() => {
    const arr = React.Children.toArray(children).filter(React.isValidElement);
    const ids = arr.map((el) => String((el.props as { id?: string }).id ?? ''));
    return { arr, ids };
  }, [children]);

  // merge persisted order with the live children ids (new ids appended, gone ids dropped)
  const ordered = useMemo(() => {
    const { arr, ids } = kids;
    const stored = state.order.filter((id) => ids.includes(id));
    const fresh = ids.filter((id) => !stored.includes(id));
    const order = [...stored, ...fresh];
    const byId = new Map(arr.map((el) => [String((el.props as { id?: string }).id ?? ''), el]));
    return order.map((id) => byId.get(id)).filter(Boolean);
  }, [kids, state.order]);

  useEffect(() => {
    try {
      localStorage.setItem(`volos-dock-${viewId}`, JSON.stringify(state));
    } catch {
      /* private mode */
    }
  }, [viewId, state]);

  // Esc (or another panel expanding) exits the fullscreen overlay
  const anyExpanded = Object.values(expanded).some(Boolean);
  useEffect(() => {
    if (!anyExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded({});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyExpanded]);

  const ctx = useMemo<DockContextValue>(
    () => ({
      viewId,
      layout: state,
      expanded,
      move: (draggedId, targetId) =>
        setState((s) => {
          if (draggedId === targetId) return s;
          const known = [...s.order];
          for (const id of kids.ids) if (!known.includes(id)) known.push(id);
          const order = known.filter((x) => x !== draggedId);
          const at = order.indexOf(targetId);
          order.splice(at < 0 ? order.length : at, 0, draggedId);
          return { ...s, order };
        }),
      toggleCollapse: (id) =>
        setState((s) => ({ ...s, collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
      setHeight: (id, px) =>
        setState((s) => ({ ...s, height: { ...s.height, [id]: px === null ? null : Math.min(MAX_H, Math.max(MIN_H, Math.round(px))) } })),
      toggleExpand: (id) =>
        setExpanded((s) => {
          const next = s[id] ? {} : { [id]: true };
          return next;
        }),
    }),
    [viewId, state, kids.ids, expanded],
  );

  const containerCls =
    className ??
    (layout === 'grid' ? 'grid grid-cols-1 gap-2 xl:grid-cols-2' : 'space-y-2');

  return (
    <DockCtx.Provider value={ctx}>
      <div className={containerCls}>{ordered}</div>
      {/* fullscreen backdrop — rendered once for any expanded panel */}
      {anyExpanded && (
        <div
          aria-hidden
          onClick={() => setExpanded({})}
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[2px]"
        />
      )}
    </DockCtx.Provider>
  );
}

export interface DockPanelProps {
  id: string;
  title: string;
  sub?: string;
  right?: ReactNode;
  /** grid mode: 2 = full width (default), 1 = half width at xl. */
  span?: 1 | 2;
  /** Pinnable into the Builder dock — the live section kind + context meta. */
  dock?: { kind: DockKind; meta?: Record<string, string | number | boolean> };
  /** 'panel' = classic Panel chrome · 'bare' = slim control strip (wraps self-chromed components). */
  variant?: 'panel' | 'bare';
  className?: string;
  children: ReactNode;
}

/** Bottom-edge drag handle — pointer-captured pixel resize of the panel body. */
function ResizeHandle({ onResize, onReset }: { onResize: (px: number) => void; onReset: () => void }) {
  const active = useRef(false);
  const start = useRef(0);
  const startH = useRef(0);

  const measureBody = (el: HTMLElement) =>
    el.parentElement?.querySelector<HTMLElement>('[data-dock-body]')?.getBoundingClientRect().height ?? 460;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    active.current = true;
    start.current = e.clientY;
    startH.current = measureBody(e.currentTarget as HTMLElement);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!active.current) return;
    e.preventDefault();
    onResize(startH.current + (e.clientY - start.current));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (active.current) (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    active.current = false;
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Drag to resize the panel height · double-click to reset"
      title="Drag to adjust the height · double-click to reset to auto"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onResize(measureBody(e.currentTarget as HTMLElement) + 40);
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onResize(measureBody(e.currentTarget as HTMLElement) - 40);
        }
      }}
      className="group/handle relative -mt-[3px] flex h-[7px] shrink-0 cursor-row-resize select-none items-center justify-center"
    >
      <span className="h-[3px] w-16 rounded-full bg-zinc-800 transition-colors group-hover/handle:bg-teal-500/70" />
    </div>
  );
}

export function DockPanel({
  id,
  title,
  sub,
  right,
  span = 2,
  dock,
  variant = 'panel',
  className = '',
  children,
}: DockPanelProps) {
  const ctx = useContext(DockCtx);
  const togglePin = useDockStore((s) => s.togglePin);
  const pinnedList = useDockStore((s) => s.pinned);
  const pinned = useMemo(
    () =>
      dock
        ? pinnedList.some(
            (p) =>
              p.kind === dock.kind && JSON.stringify(p.meta ?? {}) === JSON.stringify(dock.meta ?? {}),
          )
        : false,
    [pinnedList, dock],
  );
  const [dragOver, setDragOver] = useState(false);
  const dragDeep = useRef(0);

  // ── plain fallback: no Dock around → classic Panel look, no controls ─────
  if (!ctx) {
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

  const collapsed = ctx.layout.collapsed[id] ?? false;
  const height = ctx.layout.height[id] ?? null;
  const isExpanded = ctx.expanded[id] ?? false;

  const onDragStart = (e: React.DragEvent) => {
    volosDragging = { viewId: ctx.viewId, id };
    e.dataTransfer.setData('text/plain', `${ctx.viewId}:${id}`);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragEnd = () => {
    volosDragging = null;
    setDragOver(false);
  };
  const onDragEnter = (e: React.DragEvent) => {
    if (!volosDragging || volosDragging.viewId !== ctx.viewId || volosDragging.id === id) return;
    e.preventDefault();
    dragDeep.current += 1;
    setDragOver(true);
  };
  const onDragLeave = () => {
    dragDeep.current = Math.max(0, dragDeep.current - 1);
    if (dragDeep.current === 0) setDragOver(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!volosDragging || volosDragging.viewId !== ctx.viewId || volosDragging.id === id) return;
    e.preventDefault(); // allow the drop
    e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (e: React.DragEvent) => {
    if (volosDragging && volosDragging.viewId === ctx.viewId && volosDragging.id !== id) {
      e.preventDefault();
      ctx.move(volosDragging.id, id);
    }
    dragDeep.current = 0;
    setDragOver(false);
  };

  const spanCls = span === 1 ? 'xl:col-span-1' : 'xl:col-span-2';
  const ring = dragOver ? 'ring-2 ring-teal-500/60' : '';

  // fullscreen focus overlay: the SAME section (children stay mounted)
  const expandedCls = isExpanded
    ? 'fixed inset-3 z-50 !col-span-auto w-auto min-w-0 max-w-none bg-zinc-950/98 shadow-2xl ring-1 ring-teal-500/25'
    : '';

  const cycleSize = () => {
    const cur: PanelSize = height === null ? 'L' : height <= 300 ? 'S' : 'M';
    const next: PanelSize = cur === 'L' ? 'S' : cur === 'S' ? 'M' : 'L';
    ctx.setHeight(id, PRESET_HEIGHT[next]);
  };

  const controls = (
    <>
      {dock && (
        <button
          onClick={() =>
            togglePin({
              id: `${dock.kind}:${JSON.stringify(dock.meta ?? {})}`,
              kind: dock.kind,
              title,
              meta: dock.meta,
            })
          }
          title={
            pinned
              ? 'Pinned into the Builder — click to unpin'
              : 'Open in Builder — pin this live section into the Builder workspace dock'
          }
          className={`rounded p-1 transition ${
            pinned
              ? 'bg-teal-950/70 text-teal-300'
              : 'text-zinc-600 hover:bg-zinc-800/60 hover:text-teal-300'
          }`}
        >
          {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
      )}
      <button
        onClick={cycleSize}
        title={`Resize preset — currently ${height === null ? 'auto' : `${height}px`} (cycles 220px → 460px → auto; or drag the bottom edge for any height)`}
        className="rounded p-1 text-zinc-600 transition hover:bg-zinc-800/60 hover:text-zinc-300"
      >
        <Maximize2 className="h-3 w-3" />
      </button>
      <button
        onClick={() => ctx.toggleExpand(id)}
        title={isExpanded ? 'Restore from fullscreen (Esc)' : 'Expand to fullscreen focus'}
        className={`rounded p-1 transition ${
          isExpanded
            ? 'bg-teal-950/70 text-teal-300'
            : 'text-zinc-600 hover:bg-zinc-800/60 hover:text-zinc-300'
        }`}
      >
        {isExpanded ? <Minimize2 className="h-3 w-3" /> : <Expand className="h-3 w-3" />}
      </button>
      <button
        onClick={() => ctx.toggleCollapse(id)}
        title={collapsed ? 'Expand' : 'Collapse'}
        aria-expanded={!collapsed}
        className="rounded p-1 text-zinc-600 transition hover:bg-zinc-800/60 hover:text-zinc-300"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
    </>
  );

  // animated collapse wrapper — grid-template-rows 0fr↔1fr keeps children
  // MOUNTED while collapsed (live subscriptions survive)
  const bodyWrapper = (padding: string) => (
    <div
      className={`grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out ${
        collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
      } ${isExpanded ? 'min-h-0 flex-1' : ''}`}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          data-dock-body
          className={`${padding} ${height !== null && !isExpanded ? 'overflow-y-auto' : ''} ${isExpanded ? 'h-full overflow-y-auto' : ''}`}
          style={height !== null && !isExpanded ? { height } : undefined}
        >
          {children}
        </div>
      </div>
    </div>
  );

  if (variant === 'bare') {
    return (
      <div
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`${className} ${spanCls} ${expandedCls} flex flex-col rounded-lg ${ring} transition-shadow`}
      >
        <div
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="flex cursor-grab select-none items-center gap-1.5 rounded-md border border-zinc-800/70 bg-zinc-950/70 px-2 py-1 text-zinc-500 active:cursor-grabbing"
          title="Drag to reorder · buttons: open in Builder, resize presets, fullscreen, collapse · drag the bottom edge for pixel heights"
        >
          <GripVertical className="h-3 w-3 text-zinc-600" />
          <span className="truncate text-[9px] font-semibold uppercase tracking-[0.12em]">{title}</span>
          <span className="ml-auto flex items-center gap-0.5">{controls}</span>
        </div>
        {bodyWrapper('pt-1.5 pb-3')}
        <ResizeHandle
          onResize={(px) => ctx.setHeight(id, px)}
          onReset={() => ctx.setHeight(id, null)}
        />
      </div>
    );
  }

  return (
    <section
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`flex flex-col rounded-lg border border-zinc-800/70 bg-zinc-900/30 ${spanCls} ${expandedCls} ${ring} ${className} transition-shadow`}
    >
      <header
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="flex cursor-grab select-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800/60 px-3 py-2 active:cursor-grabbing"
        title="Drag the whole header onto another panel to reorder · buttons: open in Builder, resize presets, fullscreen, collapse · drag the bottom edge for pixel heights"
      >
        <GripVertical className="h-3 w-3 shrink-0 text-zinc-600" />
        <h3 className="text-[11px] font-semibold tracking-tight text-zinc-200">{title}</h3>
        {sub && <span className="truncate text-[9px] text-zinc-600">{sub}</span>}
        <span className="ml-auto flex items-center gap-2">
          {right}
          <span className="flex items-center gap-0.5">{controls}</span>
        </span>
      </header>
      {bodyWrapper('p-3')}
      <ResizeHandle
        onResize={(px) => ctx.setHeight(id, px)}
        onReset={() => ctx.setHeight(id, null)}
      />
    </section>
  );
}

'use client';

// ─────────────────────────────────────────────────────────────────────────────
// dock — the DRAGGABLE + ADJUSTABLE panel system ("all the parts inside").
//
//   <Dock viewId="quant-overview" layout="grid">
//     <DockPanel id="brief"  title="Market Brief" span={2} dock={{kind:'quant-overview', meta:{symbol}}}>…</DockPanel>
//     <DockPanel id="price"  title="Price" span={1}>…</DockPanel>
//   </Dock>
//
// Every DockPanel:
//   • DRAG its header grip onto another panel → reorder (persisted per view in
//     localStorage, survives reloads)
//   • COLLAPSE (chevron) and RESIZE S/M/L (cycle button — bounded max-height,
//     panel scroll) — the adjustable parts
//   • "Open in Builder" (pin) → the panel's live section pops into the Builder
//     workspace dock (switch between pinned panels there — see builder-dock.tsx)
//
// Plain fallback: a DockPanel rendered OUTSIDE a Dock keeps the classic Panel
// look with no controls — so existing Panel call sites migrate one by one.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronRight, GripVertical, Maximize2, Pin, PinOff } from 'lucide-react';
import { useDockStore, type DockKind } from '@/stores/dock-store';

export type PanelSize = 'S' | 'M' | 'L';

interface DockLayout {
  order: string[];
  collapsed: Record<string, boolean>;
  size: Record<string, PanelSize>;
}

interface DockContextValue {
  viewId: string;
  layout: DockLayout;
  move: (draggedId: string, targetId: string) => void;
  toggleCollapse: (id: string) => void;
  cycleSize: (id: string) => void;
}

const DockCtx = createContext<DockContextValue | null>(null);

// in-page drag payload (HTML5 dataTransfer keeps only types during dragover)
let volosDragging: { viewId: string; id: string } | null = null;

function loadLayout(viewId: string): DockLayout {
  try {
    const raw = localStorage.getItem(`volos-dock-${viewId}`);
    if (raw) {
      const l = JSON.parse(raw) as DockLayout;
      if (Array.isArray(l.order)) {
        return { order: l.order, collapsed: l.collapsed ?? {}, size: l.size ?? {} };
      }
    }
  } catch {
    /* fresh */
  }
  return { order: [], collapsed: {}, size: {} };
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

  const ctx = useMemo<DockContextValue>(
    () => ({
      viewId,
      layout: state,
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
      cycleSize: (id) =>
        setState((s) => {
          const cur = s.size[id] ?? 'L';
          const next: PanelSize = cur === 'L' ? 'S' : cur === 'S' ? 'M' : 'L';
          return { ...s, size: { ...s.size, [id]: next } };
        }),
    }),
    [viewId, state, kids.ids],
  );

  const containerCls =
    className ??
    (layout === 'grid' ? 'grid grid-cols-1 gap-2 xl:grid-cols-2' : 'space-y-2');

  return (
    <DockCtx.Provider value={ctx}>
      <div className={containerCls}>{ordered}</div>
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

const SIZE_STYLE: Record<PanelSize, string> = {
  S: 'max-h-[220px] overflow-y-auto',
  M: 'max-h-[460px] overflow-y-auto',
  L: '',
};

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
  const size = ctx.layout.size[id] ?? 'L';

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
        onClick={() => ctx.cycleSize(id)}
        title={`Resize — currently ${size === 'L' ? 'full' : size === 'M' ? 'medium' : 'compact'} (cycles compact → medium → full)`}
        className="rounded p-1 text-zinc-600 transition hover:bg-zinc-800/60 hover:text-zinc-300"
      >
        <Maximize2 className="h-3 w-3" />
      </button>
      <button
        onClick={() => ctx.toggleCollapse(id)}
        title={collapsed ? 'Expand' : 'Collapse'}
        className="rounded p-1 text-zinc-600 transition hover:bg-zinc-800/60 hover:text-zinc-300"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
    </>
  );

  if (variant === 'bare') {
    return (
      <div
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`${className} ${spanCls} rounded-lg ${ring} transition-shadow`}
      >
        <div
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="flex cursor-grab select-none items-center gap-1.5 rounded-md border border-zinc-800/70 bg-zinc-950/70 px-2 py-1 text-zinc-500 active:cursor-grabbing"
          title="Drag to reorder · buttons: open in Builder, resize, collapse"
        >
          <GripVertical className="h-3 w-3 text-zinc-600" />
          <span className="truncate text-[9px] font-semibold uppercase tracking-[0.12em]">{title}</span>
          <span className="ml-auto flex items-center gap-0.5">{controls}</span>
        </div>
        {!collapsed && <div className={`mt-1.5 ${SIZE_STYLE[size]}`}>{children}</div>}
      </div>
    );
  }

  return (
    <section
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`rounded-lg border border-zinc-800/70 bg-zinc-900/30 ${spanCls} ${ring} ${className} transition-shadow`}
    >
      <header
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="flex cursor-grab select-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800/60 px-3 py-2 active:cursor-grabbing"
        title="Drag the whole header onto another panel to reorder · buttons: open in Builder, resize, collapse"
      >
        <GripVertical className="h-3 w-3 shrink-0 text-zinc-600" />
        <h3 className="text-[11px] font-semibold tracking-tight text-zinc-200">{title}</h3>
        {sub && <span className="truncate text-[9px] text-zinc-600">{sub}</span>}
        <span className="ml-auto flex items-center gap-2">
          {right}
          <span className="flex items-center gap-0.5">{controls}</span>
        </span>
      </header>
      {!collapsed && <div className={`p-3 ${SIZE_STYLE[size]}`}>{children}</div>}
    </section>
  );
}

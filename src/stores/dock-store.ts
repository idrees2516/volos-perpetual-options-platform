'use client';

// ─────────────────────────────────────────────────────────────────────────────
// dock-store — the BUILDER DOCK state: panels pinned from any workspace ("Open
// in Builder") live here, switchable and reorderable, persisted across
// reloads. The pinned panels keep running LIVE in the Builder workspace.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DockKind =
  | 'quant-overview'
  | 'quant-signals'
  | 'quant-gex'
  | 'quant-iv'
  | 'quant-volregime'
  | 'quant-tape'
  | 'quant-perps'
  | 'quant-risk'
  | 'paper-intelligence'
  | 'paper-autopilot';

export interface PinnedPanel {
  /** Unique instance id (kind + meta hash when needed). */
  id: string;
  kind: DockKind;
  title: string;
  meta?: Record<string, string | number | boolean>;
  pinnedAt: number;
}

interface DockState {
  pinned: PinnedPanel[];
  activeId: string | null;
  pin: (p: Omit<PinnedPanel, 'pinnedAt'>) => void;
  unpin: (id: string) => void;
  togglePin: (p: Omit<PinnedPanel, 'pinnedAt'>) => void;
  setActive: (id: string) => void;
  movePinned: (draggedId: string, targetId: string) => void;
  clear: () => void;
}

function samePanel(a: PinnedPanel, b: Omit<PinnedPanel, 'pinnedAt'>): boolean {
  return a.kind === b.kind && JSON.stringify(a.meta ?? {}) === JSON.stringify(b.meta ?? {});
}

export const useDockStore = create<DockState>()(
  persist(
    (set, get) => ({
      pinned: [],
      activeId: null,
      pin: (p) =>
        set((s) => {
          if (s.pinned.some((x) => samePanel(x, p))) return s;
          const entry: PinnedPanel = { ...p, pinnedAt: Date.now() };
          return { pinned: [...s.pinned, entry], activeId: entry.id };
        }),
      unpin: (id) =>
        set((s) => {
          const pinned = s.pinned.filter((p) => p.id !== id);
          const activeId = s.activeId === id ? (pinned[pinned.length - 1]?.id ?? null) : s.activeId;
          return { pinned, activeId };
        }),
      togglePin: (p) => {
        const existing = get().pinned.find((x) => samePanel(x, p));
        if (existing) get().unpin(existing.id);
        else get().pin(p);
      },
      setActive: (id) => set({ activeId: id }),
      movePinned: (draggedId, targetId) =>
        set((s) => {
          if (draggedId === targetId) return s;
          const order = [...s.pinned];
          const from = order.findIndex((p) => p.id === draggedId);
          if (from < 0) return s;
          const [moved] = order.splice(from, 1);
          const to = order.findIndex((p) => p.id === targetId);
          order.splice(to < 0 ? order.length : to, 0, moved);
          return { pinned: order };
        }),
      clear: () => set({ pinned: [], activeId: null }),
    }),
    { name: 'volos-builder-dock' },
  ),
);

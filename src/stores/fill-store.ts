// ─────────────────────────────────────────────────────────────────────────────
// fill-store (v2.0) — the paper desk's SESSION blotter.
// Plain in-memory zustand store (NO persist middleware): fills survive tab
// switches and view changes but intentionally clear on page reload — this is
// v2.0 behavior. (Cross-session persistence arrived later, in v2.1.)
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type { FillRow } from '@/lib/types';

interface FillState {
  fills: FillRow[];
  /** append every leg of one placed order as a group */
  addGroup: (rows: FillRow[]) => void;
  /** cancel one order group (remove its fills) */
  cancelGroup: (groupId: string) => void;
  /** flatten the whole blotter */
  clearAll: () => void;
}

export const useFillStore = create<FillState>((set) => ({
  fills: [],
  addGroup: (rows) => set((s) => ({ fills: [...rows.reverse(), ...s.fills] })),
  cancelGroup: (groupId) => set((s) => ({ fills: s.fills.filter((f) => f.groupId !== groupId) })),
  clearAll: () => set({ fills: [] }),
}));

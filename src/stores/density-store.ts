'use client';

// ─────────────────────────────────────────────────────────────────────────────
// density-store — terminal density (compact | comfortable), PERSISTED.
// Applies `data-density` on <html> so the CSS token layer
// (--volos-row-h / --volos-cell-py / --volos-panel-pad) resizes every
// density-aware table/panel at once. Traders get more rows per screen in
// compact mode without any per-component logic.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Density = 'compact' | 'comfortable';

interface DensityState {
  density: Density;
  setDensity: (d: Density) => void;
  toggleDensity: () => void;
}

function apply(d: Density) {
  if (typeof document !== 'undefined') document.documentElement.dataset.density = d;
}

export const useDensity = create<DensityState>()(
  persist(
    (set, get) => ({
      density: 'compact',
      setDensity: (d) => {
        apply(d);
        set({ density: d });
      },
      toggleDensity: () => get().setDensity(get().density === 'compact' ? 'comfortable' : 'compact'),
    }),
    {
      name: 'volos-density',
      onRehydrateStorage: () => (state) => {
        if (state) apply(state.density);
      },
    },
  ),
);

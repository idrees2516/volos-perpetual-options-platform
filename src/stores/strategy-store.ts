'use client';

// Strategy builder state: legs (up to 25), size, view overrides, animation
// controls — plus the selected catalog strategy. The selection, the loaded
// custom strategy, its legs and the underlying PERSIST (localStorage via
// zustand persist), so whatever you picked stays selected across view
// switches and reloads — in the catalog, in the payoff and in the builder.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Leg, LegKind, UnderlyingId, ViewOverrides } from '@/lib/types';
import { MAX_LEGS } from '@/lib/strategies';

let seq = 0;
export function makeLeg(kind: LegKind, spot: number): Leg {
  seq += 1;
  const base: Leg = {
    id: `leg-${Date.now().toString(36)}-${seq}`,
    kind,
    side: 'buy',
    qty: 1,
  };
  if (kind === 'call' || kind === 'put' || kind === 'perp_option') {
    const step = spot >= 50000 ? 500 : spot >= 4000 ? 50 : spot >= 400 ? 5 : spot >= 40 ? 0.5 : 0.05;
    base.strike = Math.round((spot * (kind === 'put' ? 0.95 : 1.0)) / step) * step;
  }
  if (kind === 'call' || kind === 'put') base.expiryDays = 30;
  if (kind === 'perp_option') base.fundingPeriodDays = 7;
  return base;
}

export type BuilderTab = 'scenario' | 'greeks' | 'carry' | 'quote';
export type WorkspaceMode = 'explore' | 'build';

interface StrategyState {
  underlying: UnderlyingId;
  legs: Leg[];
  size: number;
  overrides: ViewOverrides;
  activeTab: BuilderTab;
  showCone: boolean;
  showDecay: boolean;
  showNow: boolean;
  playing: boolean;
  playMode: 'decay' | 'spot';
  strategyName: string;
  /** Currently selected catalog strategy — PERSISTED so the payoff,
   *  the strategies view and the custom builder all keep the same choice. */
  catalogId: string;
  /** Strategies workspace mode (catalog vs builder) — persisted. */
  mode: WorkspaceMode;
  setUnderlying: (u: UnderlyingId) => void;
  addLeg: (kind: LegKind, spot: number) => boolean;
  removeLeg: (id: string) => void;
  duplicateLeg: (id: string) => boolean;
  updateLeg: (id: string, patch: Partial<Leg>) => void;
  setLegs: (legs: Leg[]) => void;
  /** Replace the whole strategy (from catalog / wizard / chain); returns applied leg count. */
  loadStrategy: (name: string, legs: Leg[]) => number;
  /** Load a catalog strategy by id — sets selection AND the builder legs. */
  loadCatalogStrategy: (id: string, legs: Leg[], name: string) => number;
  setSize: (s: number) => void;
  setOverrides: (patch: Partial<ViewOverrides>) => void;
  resetOverrides: () => void;
  setActiveTab: (t: BuilderTab) => void;
  toggle: (key: 'showCone' | 'showDecay' | 'showNow') => void;
  setPlaying: (p: boolean) => void;
  setPlayMode: (m: 'decay' | 'spot') => void;
  setStrategyName: (n: string) => void;
  setCatalogId: (id: string) => void;
  setMode: (m: WorkspaceMode) => void;
}

const DEFAULT_OVERRIDES: ViewOverrides = { spotShiftPct: 0, ivShiftPct: 0, daysForward: 0 };

export const useStrategy = create<StrategyState>()(
  persist(
    (set) => ({
      underlying: 'BTC',
      legs: [],
      size: 1,
      overrides: DEFAULT_OVERRIDES,
      activeTab: 'scenario',
      showCone: true,
      showDecay: true,
      showNow: true,
      playing: false,
      playMode: 'decay',
      strategyName: 'Custom Strategy',
      catalogId: 'long-call',
      mode: 'explore',
      setUnderlying: (u) => set({ underlying: u, legs: [] }),
      addLeg: (kind, spot) => {
        let ok = false;
        set((s) => {
          if (s.legs.length >= MAX_LEGS) return {};
          ok = true;
          return { legs: [...s.legs, makeLeg(kind, spot)] };
        });
        return ok;
      },
      removeLeg: (id) => set((s) => ({ legs: s.legs.filter((l) => l.id !== id) })),
      duplicateLeg: (id) => {
        let ok = false;
        set((s) => {
          if (s.legs.length >= MAX_LEGS) return {};
          const src = s.legs.find((l) => l.id === id);
          if (!src) return {};
          seq += 1;
          ok = true;
          return { legs: [...s.legs, { ...src, id: `leg-${Date.now().toString(36)}-${seq}` }] };
        });
        return ok;
      },
      updateLeg: (id, patch) =>
        set((s) => ({
          legs: s.legs.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        })),
      setLegs: (legs) => set({ legs: legs.slice(0, MAX_LEGS) }),
      loadStrategy: (name, legs) => {
        const capped = legs.slice(0, MAX_LEGS);
        set({ strategyName: name, legs: capped, overrides: DEFAULT_OVERRIDES, playing: false, mode: 'build' });
        return capped.length;
      },
      loadCatalogStrategy: (id, legs, name) => {
        const capped = legs.slice(0, MAX_LEGS);
        set({
          catalogId: id,
          strategyName: name,
          legs: capped,
          overrides: DEFAULT_OVERRIDES,
          playing: false,
          mode: 'build',
        });
        return capped.length;
      },
      setSize: (size) => set({ size: Math.min(Math.max(size, 0.001), 10000) }),
      setOverrides: (patch) => set((s) => ({ overrides: { ...s.overrides, ...patch } })),
      resetOverrides: () => set({ overrides: DEFAULT_OVERRIDES, playing: false }),
      setActiveTab: (activeTab) => set({ activeTab }),
      toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<StrategyState>),
      setPlaying: (playing) => set({ playing }),
      setPlayMode: (playMode) => set({ playMode, playing: false }),
      setStrategyName: (strategyName) => set({ strategyName }),
      setCatalogId: (catalogId) => set({ catalogId }),
      setMode: (mode) => set({ mode }),
    }),
    {
      name: 'volos-strategy-v2',
      // Hydrate manually after mount (avoids SSR/hydration mismatches).
      skipHydration: true,
      partialize: (s) => ({
        catalogId: s.catalogId,
        mode: s.mode,
        underlying: s.underlying,
        strategyName: s.strategyName,
        legs: s.legs,
        size: s.size,
      }),
    },
  ),
);

/** Call once from a top-level client effect to restore the persisted
 *  strategy selection + custom strategy after SSR. */
export function rehydrateStrategy(): void {
  void useStrategy.persist.rehydrate();
}

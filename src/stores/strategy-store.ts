'use client';

// Strategy builder state: legs (up to 25), size, view overrides, animation controls.

import { create } from 'zustand';
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
  setUnderlying: (u: UnderlyingId) => void;
  addLeg: (kind: LegKind, spot: number) => boolean;
  removeLeg: (id: string) => void;
  duplicateLeg: (id: string) => boolean;
  updateLeg: (id: string, patch: Partial<Leg>) => void;
  setLegs: (legs: Leg[]) => void;
  /** Replace the whole strategy (from library / wizard / chain); returns applied leg count. */
  loadStrategy: (name: string, legs: Leg[]) => number;
  setSize: (s: number) => void;
  setOverrides: (patch: Partial<ViewOverrides>) => void;
  resetOverrides: () => void;
  setActiveTab: (t: BuilderTab) => void;
  toggle: (key: 'showCone' | 'showDecay' | 'showNow') => void;
  setPlaying: (p: boolean) => void;
  setPlayMode: (m: 'decay' | 'spot') => void;
  setStrategyName: (n: string) => void;
}

const DEFAULT_OVERRIDES: ViewOverrides = { spotShiftPct: 0, ivShiftPct: 0, daysForward: 0 };

export const useStrategy = create<StrategyState>((set) => ({
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
    set({ strategyName: name, legs: capped, overrides: DEFAULT_OVERRIDES, playing: false });
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
}));

'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ui-store — v1.9 view state. Deliberately NOT persisted: v1.9 terminals
// boot into the default view every session.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';

export type MainView = 'strategies' | 'chain' | 'trading' | 'desk';
export type StrategyTab =
  | 'intelligence' | 'live' | 'metrics' | 'platforms' | 'backtest' | 'structure' | 'payoff';

export type CatalogFilter = 'all' | 'direction' | 'income' | 'volatility' | 'protection' | 'spread' | 'perpetual' | 'multileg' | '0dte';
export type SentimentFilter = 'any' | 'bullish' | 'bearish' | 'neutral' | 'volatile' | 'lowvol';
export type VenueFilter = 'all' | 'Modern' | 'Legacy' | 'TradFi';

interface UiState {
  view: MainView;
  strategyTab: StrategyTab;
  catalogFilter: CatalogFilter;
  sentiment: SentimentFilter;
  venueFilter: VenueFilter;
  search: string;
  builderOpen: boolean;
  copilotOpen: boolean;
  setView: (v: MainView) => void;
  setStrategyTab: (t: StrategyTab) => void;
  setCatalogFilter: (f: CatalogFilter) => void;
  setSentiment: (s: SentimentFilter) => void;
  setVenueFilter: (v: VenueFilter) => void;
  setSearch: (q: string) => void;
  setBuilderOpen: (b: boolean) => void;
  setCopilotOpen: (b: boolean) => void;
}

export const useUi = create<UiState>()((set) => ({
  view: 'strategies',
  strategyTab: 'intelligence',
  catalogFilter: 'all',
  sentiment: 'any',
  venueFilter: 'all',
  search: '',
  builderOpen: false,
  copilotOpen: false,
  setView: (v) => set({ view: v }),
  setStrategyTab: (t) => set({ strategyTab: t }),
  setCatalogFilter: (f) => set({ catalogFilter: f }),
  setSentiment: (s) => set({ sentiment: s }),
  setVenueFilter: (v) => set({ venueFilter: v }),
  setSearch: (q) => set({ search: q }),
  setBuilderOpen: (b) => set({ builderOpen: b }),
  setCopilotOpen: (b) => set({ copilotOpen: b }),
}));

// Strategy catalog — 118 pre-built strategies (1..=25 legs).
// The JSON is the single source of truth shared with the Rust backend
// (include_str!("../strategies.json")) — regenerate via scripts/gen_strategies.py.

import catalogJson from './strategies.json';
import type { Leg, LegKind, Side, UnderlyingId } from './types';

export const MAX_LEGS = 25;

export type StrategyCategory =
  | 'direction'
  | 'income'
  | 'volatility'
  | 'protection'
  | 'spread'
  | 'perpetual'
  | 'multileg';

export type StrategyView = 'bullish' | 'bearish' | 'neutral' | 'volatile' | 'low-vol';

export interface StrategyLegSpec {
  kind: LegKind;
  side: Side;
  qty: number;
  /** Strike as a multiplier of live spot (e.g. 1.10 => 10% OTM). */
  strike?: number;
  expiryDays?: number;
  fundingPeriodDays?: number;
}

export interface StrategySpec {
  id: string;
  name: string;
  category: StrategyCategory;
  view: StrategyView;
  complexity: number;
  description: string;
  tags: string[];
  legs: StrategyLegSpec[];
}

interface CatalogFile {
  version: number;
  maxLegs: number;
  strategyCount: number;
  strategies: StrategySpec[];
}

const file = catalogJson as unknown as CatalogFile;

export const STRATEGIES: StrategySpec[] = file.strategies;
export const STRATEGY_COUNT = STRATEGIES.length;

export const CATEGORY_META: Record<StrategyCategory, { label: string; hint: string }> = {
  direction: { label: 'Direction', hint: 'Bullish & bearish expressions' },
  income: { label: 'Income', hint: 'Premium harvesting & credit' },
  volatility: { label: 'Volatility', hint: 'Long / short vol & gamma' },
  protection: { label: 'Protection', hint: 'Hedges, floors & tails' },
  spread: { label: 'Spreads', hint: 'Structural & parity trades' },
  perpetual: { label: 'Perpetual', hint: 'Everlasting-native structures' },
  multileg: { label: 'Multi-Leg', hint: '8–25 leg monsters' },
};

export const VIEW_META: Record<StrategyView, { label: string; color: string }> = {
  bullish: { label: 'Bullish', color: 'text-emerald-400' },
  bearish: { label: 'Bearish', color: 'text-rose-400' },
  neutral: { label: 'Neutral', color: 'text-zinc-300' },
  volatile: { label: 'Volatile', color: 'text-amber-400' },
  'low-vol': { label: 'Low Vol', color: 'text-sky-400' },
};

export function strategyById(id: string): StrategySpec | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

function stepFor(spot: number): number {
  if (spot >= 50000) return 500;
  if (spot >= 4000) return 50;
  if (spot >= 400) return 5;
  if (spot >= 40) return 0.5;
  return 0.05;
}

export function snapToGrid(spot: number, mult: number): number {
  const step = stepFor(spot);
  return Math.round((spot * mult) / step) * step;
}

let legSeq = 0;

/** Resolve a strategy spec against live spot → concrete builder legs (with ids). */
export function resolveStrategyLegs(spec: StrategySpec, spot: number): Leg[] {
  return spec.legs.map((l) => {
    legSeq += 1;
    const leg: Leg = {
      id: `leg-${Date.now().toString(36)}-${legSeq}`,
      kind: l.kind,
      side: l.side,
      qty: l.qty,
    };
    if (l.strike !== undefined) leg.strike = snapToGrid(spot, l.strike);
    if (l.expiryDays !== undefined) leg.expiryDays = l.expiryDays;
    if (l.fundingPeriodDays !== undefined) leg.fundingPeriodDays = l.fundingPeriodDays;
    return leg;
  });
}

export function complexityStars(n: number): string {
  return '●'.repeat(n) + '○'.repeat(Math.max(0, 5 - n));
}

export function histogramBuckets(): { label: string; count: number }[] {
  const buckets = [
    { label: '1–2', min: 1, max: 2 },
    { label: '3–4', min: 3, max: 4 },
    { label: '5–7', min: 5, max: 7 },
    { label: '8–12', min: 8, max: 12 },
    { label: '13–19', min: 13, max: 19 },
    { label: '20–25', min: 20, max: 25 },
  ];
  return buckets.map((b) => ({
    label: b.label,
    count: STRATEGIES.filter((s) => s.legs.length >= b.min && s.legs.length <= b.max).length,
  }));
}

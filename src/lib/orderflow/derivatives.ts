// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — derivatives analytics (OI · funding · basis · liquidations)
//
// Pure functions; the manager owns the state, panels render it.
// Adapted from the open-source order-flow-screener by zadescoxp (Apache-2.0).
// ─────────────────────────────────────────────────────────────────────────────

import type { OfDerivatives, OfLiquidation, OfOiPoint, OfVenueId } from './types';

const DEFAULT_FUNDING_HOURS = 8;

/** Funding rate restated over an 8-hour interval so 1h / 4h / 8h venues compare. */
export function fundingRate8h(s: OfDerivatives): number | undefined {
  if (s.fundingRate === undefined) return undefined;
  const hours = s.fundingIntervalHours ?? DEFAULT_FUNDING_HOURS;
  return s.fundingRate * (8 / hours);
}

/** Annualized funding (decimal) from a rate over `intervalHours`. */
export function annualizeFunding(rate: number, intervalHours = DEFAULT_FUNDING_HOURS): number {
  return rate * (24 / intervalHours) * 365;
}

export interface OfDerivativesAggregate {
  timestamp: number;
  venues: OfDerivatives[];
  openInterest: number | null; // base units, summed over reporting venues
  openInterestValue: number | null; // quote units
  fundingRate8h: number | null; // OI-weighted, normalized to 8h
  nextFundingTime: number | null;
  primaryFundingRate: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  basisBps: number | null;
}

/** Combine per-venue derivatives state (OI summed; funding/basis OI-weighted). */
export function aggregateDerivatives(
  snapshots: OfDerivatives[],
  referencePrice: number | undefined,
): OfDerivativesAggregate | null {
  if (!snapshots.length) return null;
  const primary = snapshots[0];

  let oi = 0;
  let oiValue = 0;
  let oiCount = 0;
  for (const s of snapshots) {
    if (s.openInterest === undefined) continue;
    oi += s.openInterest;
    oiValue += s.openInterest * (s.markPrice ?? referencePrice ?? 0);
    oiCount++;
  }

  const weighted = (value: (s: OfDerivatives) => number | undefined) => {
    let sum = 0;
    let weight = 0;
    for (const s of snapshots) {
      const v = value(s);
      if (v === undefined || !Number.isFinite(v)) continue;
      const w = s.openInterest && s.openInterest > 0 ? s.openInterest : 1;
      sum += v * w;
      weight += w;
    }
    return weight > 0 ? sum / weight : null;
  };

  return {
    timestamp: Math.max(...snapshots.map((s) => s.timestamp)),
    venues: snapshots,
    openInterest: oiCount ? oi : null,
    openInterestValue: oiCount && oiValue > 0 ? oiValue : null,
    fundingRate8h: weighted(fundingRate8h),
    nextFundingTime: primary.nextFundingTime ?? null,
    primaryFundingRate: primary.fundingRate ?? null,
    markPrice: weighted((s) => s.markPrice),
    indexPrice: weighted((s) => s.indexPrice),
    basisBps: weighted((s) =>
      s.markPrice && s.indexPrice ? ((s.markPrice - s.indexPrice) / s.indexPrice) * 10_000 : undefined,
    ),
  };
}

// ── price × open-interest regime ────────────────────────────────────────────

export type OfOIRegime = 'new-longs' | 'short-covering' | 'new-shorts' | 'long-unwind' | 'neutral';

export const OI_REGIME_LABEL: Record<OfOIRegime, string> = {
  'new-longs': 'New longs',
  'short-covering': 'Short covering',
  'new-shorts': 'New shorts',
  'long-unwind': 'Long unwind',
  neutral: 'Balanced',
};

export const OI_REGIME_HINT: Record<OfOIRegime, string> = {
  'new-longs': 'Price up with rising open interest — fresh long positioning is driving the move.',
  'short-covering': 'Price up with falling open interest — shorts closing; the rally is driven by exits, not new demand.',
  'new-shorts': 'Price down with rising open interest — fresh short positioning is driving the move.',
  'long-unwind': 'Price down with falling open interest — longs closing or being liquidated.',
  neutral: 'Price or open interest is roughly flat over the window.',
};

export function classifyOIRegime(priceChange: number, oiChange: number, priceThreshold = 0.0005, oiThreshold = 0.001): OfOIRegime {
  if (Math.abs(priceChange) < priceThreshold || Math.abs(oiChange) < oiThreshold) return 'neutral';
  if (priceChange > 0) return oiChange > 0 ? 'new-longs' : 'short-covering';
  return oiChange > 0 ? 'new-shorts' : 'long-unwind';
}

export interface OfOIWindowChange {
  windowMs: number;
  priceChange: number;
  oiChange: number;
  oiDelta: number;
  regime: OfOIRegime;
}

/** Price and OI change over the trailing `windowMs` of the history. */
export function oiWindowChange(history: OfOiPoint[], windowMs: number): OfOIWindowChange | null {
  if (history.length < 2) return null;
  const to = history[history.length - 1];
  const cutoff = to.time - windowMs;
  let lo = 0;
  let hi = history.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].time < cutoff) lo = mid + 1;
    else hi = mid;
  }
  const from = history[lo];
  if (from === to || !(from.openInterest > 0) || !(from.price > 0)) return null;
  const priceChange = (to.price - from.price) / from.price;
  const oiChange = (to.openInterest - from.openInterest) / from.openInterest;
  return {
    windowMs,
    priceChange,
    oiChange,
    oiDelta: to.openInterest - from.openInterest,
    regime: classifyOIRegime(priceChange, oiChange),
  };
}

// ── liquidations ─────────────────────────────────────────────────────────────

export interface OfLiquidationBucket {
  time: number;
  longNotional: number;
  shortNotional: number;
  longQty: number;
  shortQty: number;
  count: number;
}

/** Bucket liquidations into fixed windows ending at `now`, oldest first. */
export function bucketLiquidations(
  liquidations: OfLiquidation[],
  bucketMs: number,
  count: number,
  now: number,
): OfLiquidationBucket[] {
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - (count - 1) * bucketMs;
  const buckets: OfLiquidationBucket[] = Array.from({ length: count }, (_, i) => ({
    time: start + i * bucketMs,
    longNotional: 0,
    shortNotional: 0,
    longQty: 0,
    shortQty: 0,
    count: 0,
  }));
  for (const l of liquidations) {
    const index = Math.floor((l.timestamp - start) / bucketMs);
    if (index < 0 || index >= count) continue;
    const b = buckets[index];
    if (l.side === 'long') {
      b.longNotional += l.quoteVolume;
      b.longQty += l.quantity;
    } else {
      b.shortNotional += l.quoteVolume;
      b.shortQty += l.quantity;
    }
    b.count++;
  }
  return buckets;
}

export interface OfLiquidationSummary {
  longNotional: number;
  shortNotional: number;
  count: number;
  largest: OfLiquidation | null;
}

export function summarizeLiquidations(liquidations: OfLiquidation[], since: number): OfLiquidationSummary {
  const summary: OfLiquidationSummary = { longNotional: 0, shortNotional: 0, count: 0, largest: null };
  for (let i = liquidations.length - 1; i >= 0; i--) {
    const l = liquidations[i];
    if (l.timestamp < since) break;
    if (l.side === 'long') summary.longNotional += l.quoteVolume;
    else summary.shortNotional += l.quoteVolume;
    summary.count++;
    if (!summary.largest || l.quoteVolume > summary.largest.quoteVolume) summary.largest = l;
  }
  return summary;
}

/** A cascade: the latest bucket far above the median of non-empty buckets. */
export function isLiquidationCascade(buckets: OfLiquidationBucket[], multiple = 5, floor = 0): boolean {
  if (buckets.length < 4) return false;
  const last = buckets[buckets.length - 1];
  const total = last.longNotional + last.shortNotional;
  if (total <= floor) return false;
  const history = buckets
    .slice(0, -1)
    .map((b) => b.longNotional + b.shortNotional)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (history.length < 3) return false;
  const median = history[Math.floor(history.length / 2)];
  return total >= median * multiple;
}

export function liquidationState(buckets: OfLiquidationBucket[]): 'quiet' | 'active' | 'cascade' {
  if (isLiquidationCascade(buckets)) return 'cascade';
  const last = buckets[buckets.length - 1];
  return last && last.count > 0 ? 'active' : 'quiet';
}

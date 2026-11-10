// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — instrument catalog & tick ladder
//
// Maps the terminal's canonical assets (BTC · ETH · SOL) onto each venue's
// perpetual symbol, and sizes the contiguous tick ladder (~1 bp) used by the
// footprint and the resting-liquidity heatmap.
// ─────────────────────────────────────────────────────────────────────────────

import type { OfAsset, OfVenueId } from './types';

export const OF_ASSETS: OfAsset[] = ['BTC', 'ETH', 'SOL'];

export const OF_VENUES: OfVenueId[] = ['binance', 'bybit', 'okx', 'deribit'];

/** Venues with a public liquidation feed. */
export const LIQ_FEED_VENUES: ReadonlySet<OfVenueId> = new Set<OfVenueId>(['binance', 'bybit', 'okx', 'deribit']);

export interface OfVenueMetaEntry {
  id: OfVenueId;
  name: string;
  /** venue-native symbol for an asset, or null when not listed */
  symbol: (asset: OfAsset) => string | null;
  /** quote for display */
  quote: 'USDT' | 'USD';
}

export const OF_VENUE_META: Record<OfVenueId, OfVenueMetaEntry> = {
  binance: {
    id: 'binance',
    name: 'Binance USD-M',
    symbol: (a) => (OF_ASSETS.includes(a) ? `${a}USDT` : null),
    quote: 'USDT',
  },
  bybit: {
    id: 'bybit',
    name: 'Bybit Linear',
    symbol: (a) => (OF_ASSETS.includes(a) ? `${a}USDT` : null),
    quote: 'USDT',
  },
  okx: {
    id: 'okx',
    name: 'OKX Swap',
    symbol: (a) => (OF_ASSETS.includes(a) ? `${a}-USDT-SWAP` : null),
    quote: 'USDT',
  },
  deribit: {
    id: 'deribit',
    name: 'Deribit Inverse',
    // Deribit lists BTC and ETH inverse perpetuals only.
    symbol: (a) => (a === 'BTC' || a === 'ETH' ? `${a}-PERPETUAL` : null),
    quote: 'USD',
  },
};

export function venuesForAsset(asset: OfAsset): OfVenueId[] {
  return OF_VENUES.filter((v) => OF_VENUE_META[v].symbol(asset) !== null);
}

export function isOfAsset(x: string): x is OfAsset {
  return (OF_ASSETS as string[]).includes(x);
}

/**
 * Contiguous tick ladder size, ≈1 bp of the current price, snapped to a
 * 1/2/5 × 10^k step so it stays stable while price drifts.
 */
export function autoTick(price: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return 0.01;
  const raw = price * 1e-4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * mag;
}

/** Display decimals for a price given its tick ladder. */
export function tickDecimals(tick: number): number {
  if (!(tick > 0)) return 2;
  return Math.min(6, Math.max(0, Math.ceil(-Math.log10(tick))));
}

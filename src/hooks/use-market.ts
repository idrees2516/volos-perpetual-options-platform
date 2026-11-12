'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useMarket — REAL live BTC/ETH/SOL prices polled from /api/prices (server
// proxies Binance→Bybit→OKX), plus live venue connectivity from /api/venues.
// 5s poll, smooth display interpolation in the ticker.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import type { LivePrice, VenueId, VenueSpec } from '@/lib/types';
import { VENUES } from '@/lib/venues';

export interface MarketState {
  prices: Record<string, LivePrice>;
  venues: VenueSpec[];
  loading: boolean;
  lastUpdate: number | null;
  errors: string[];
}

export function useMarket(): MarketState {
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [venueStatus, setVenueStatus] = useState<Record<string, { live: boolean; latencyMs: number | null; note?: string }>>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const venueTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let dead = false;

    async function pollPrices() {
      try {
        const r = await fetch('/api/prices', { cache: 'no-store' });
        const j = await r.json();
        if (dead) return;
        if (j.prices && Object.keys(j.prices).length) {
          setPrices(j.prices);
          setErrors(j.errors ?? []);
          setLastUpdate(Date.now());
        }
      } catch {
        /* transient network hiccup — keep last good frame */
      } finally {
        if (!dead) setLoading(false);
      }
    }

    async function pollVenues() {
      try {
        const r = await fetch('/api/venues', { cache: 'no-store' });
        const j = await r.json();
        if (!dead && j.venues) setVenueStatus(j.venues);
      } catch {
        /* keep last good status */
      }
    }

    pollPrices();
    pollVenues();
    const priceTimer = setInterval(pollPrices, 5000);
    venueTimer.current = setInterval(pollVenues, 30000);

    return () => {
      dead = true;
      clearInterval(priceTimer);
      if (venueTimer.current) clearInterval(venueTimer.current);
    };
  }, []);

  const venues = VENUES.map((v) => {
    const st = venueStatus[v.id];
    return st ? { ...v, live: st.live, latencyMs: st.latencyMs ?? null } : v;
  });

  return { prices, venues, loading, lastUpdate, errors };
}

export const spotOf = (m: MarketState, u: string, fallback = 80000): number =>
  m.prices[u]?.price ?? fallback;

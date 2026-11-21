'use client';

// Live market context — 100% REAL venue data, no local simulation.
//
// Every frame is built from the live-prices polling singleton:
//   • spot / 24h change / high / low / volume  — Binance → Bybit → OKX → Deribit
//   • perp funding (8h fraction) + open-interest notional — OKX USDT swaps
//   • volShift re-centres the pricing surface on the REAL Deribit 30d
//     historical-vol index (HV / baseline ATM − 1)
//
// There is NO client-side price simulation and NO engine fallback: if every
// public venue is unreachable the frame simply stays on the last known real
// snapshot and the status line reads "connecting…".
//
// Exposes smooth interpolated spot for buttery chart motion (lerp is a
// presentation-layer effect on the REAL ticks, not a data source).
//
// NOTE: this is the ONLY use-market module. A stale use-market.ts used to
// shadow this file for TypeScript resolution (tsc resolves .ts before .tsx,
// the Next bundler the other way) — it and the dead v1 views that imported
// its legacy surface (src/components/volos/*, superseded by terminal/*)
// were removed in the v2 structural cleanup.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AssetMarket, MarketData } from '@/lib/types';
import { subscribeLivePrices, refreshLivePrices, type LivePriceSnapshot } from '@/lib/live-prices';
import { VOL_CONFIG } from '@/lib/pricing';

const LIVE_ASSETS = ['BTC', 'ETH', 'SOL'] as const;

// Empty until the first REAL quote lands — no invented seed prices.
const EMPTY_ASSETS: Record<string, AssetMarket> = {
  BTC: { spot: 0, volShift: 0, fundingRate: 0, change24h: 0, openInterest: 0, volume24h: 0 },
  ETH: { spot: 0, volShift: 0, fundingRate: 0, change24h: 0, openInterest: 0, volume24h: 0 },
  SOL: { spot: 0, volShift: 0, fundingRate: 0, change24h: 0, openInterest: 0, volume24h: 0 },
};

const INITIAL: MarketData = {
  source: 'connecting',
  tick: 0,
  tsMs: Date.now(),
  assets: EMPTY_ASSETS,
};

interface MarketContextValue {
  market: MarketData;
  /** Smoothed spot for animation (lerped toward the live value). */
  smooth: Record<string, AssetMarket>;
  connected: boolean;
  /** Real venue serving the frames (e.g. 'Binance spot'). */
  source: string;
  /** The raw live-price snapshot (real quotes + perp metrics + HV). */
  live: LivePriceSnapshot | null;
  retry: () => void;
}

const MarketContext = createContext<MarketContextValue | null>(null);

export function MarketProvider({ children }: { children: React.ReactNode }) {
  const [market, setMarket] = useState<MarketData>(INITIAL);
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState<LivePriceSnapshot | null>(null);
  const latestRef = useRef<MarketData>(INITIAL);

  const retry = useCallback(() => {
    refreshLivePrices();
  }, []);

  // ── build the market frame from each REAL snapshot ─────────────────────────
  const push = useCallback((snap: LivePriceSnapshot) => {
    setLive(snap);
    setConnected(snap.ok);
    const prev = latestRef.current;
    const assets: Record<string, AssetMarket> = {};
    for (const a of LIVE_ASSETS) {
      const q = snap.quotes[a];
      const base = prev.assets[a] ?? EMPTY_ASSETS[a];
      const perp = snap.perp?.[a];
      const hv = snap.hv30d?.[a];
      const cfg = VOL_CONFIG[a];
      assets[a] = {
        spot: q?.spot && q.spot > 0 ? q.spot : base.spot,
        // app convention: change24h is a fraction (0.064 = 6.4%)
        change24h: q ? q.change24hPct / 100 : base.change24h,
        volume24h: q?.volumeUsd24h && q.volumeUsd24h > 0 ? q.volumeUsd24h : base.volume24h,
        // per-8h fraction (Binance convention) from the real OKX swap
        fundingRate: perp ? perp.fundingRate8h : base.fundingRate,
        openInterest: perp && perp.openInterestUsd > 0 ? perp.openInterestUsd : base.openInterest,
        // re-centre the synthetic pricing surface on the REAL Deribit HV
        volShift: hv && hv > 0 && cfg ? hv / cfg.atm30d - 1 : base.volShift,
      };
    }
    const frame: MarketData = {
      source: snap.ok ? snap.source : 'unreachable',
      tick: prev.tick + 1,
      tsMs: snap.tsMs,
      assets,
    };
    latestRef.current = frame;
    setMarket(frame);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeLivePrices(push);
    return unsubscribe;
  }, [push]);

  // Smooth interpolation at 30fps for chart motion.
  const [smooth, setSmooth] = useState<Record<string, AssetMarket>>(EMPTY_ASSETS);
  const smoothRef = useRef<Record<string, AssetMarket>>(EMPTY_ASSETS);
  useEffect(() => {
    const raf = setInterval(() => {
      const target = latestRef.current.assets;
      const cur = smoothRef.current;
      const next: Record<string, AssetMarket> = {};
      let changed = false;
      for (const k of Object.keys(target)) {
        const t = target[k];
        const c = cur[k] ?? t;
        const s: AssetMarket = {
          ...t,
          spot: c.spot + (t.spot - c.spot) * 0.18,
          volShift: c.volShift + (t.volShift - c.volShift) * 0.18,
          fundingRate: c.fundingRate + (t.fundingRate - c.fundingRate) * 0.18,
        };
        if (Math.abs(s.spot - c.spot) > 1e-9) changed = true;
        next[k] = s;
      }
      if (changed) {
        smoothRef.current = next;
        setSmooth(next);
      }
    }, 33);
    return () => clearInterval(raf);
  }, []);

  return (
    <MarketContext.Provider
      value={{ market, smooth, connected, source: market.source, live, retry }}
    >
      {children}
    </MarketContext.Provider>
  );
}

export function useMarket(): MarketContextValue {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error('useMarket must be used inside MarketProvider');
  return ctx;
}

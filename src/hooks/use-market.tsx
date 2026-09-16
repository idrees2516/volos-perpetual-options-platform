'use client';

// Live market context: SSE stream from the Rust engine with a transparent
// client-side simulation fallback. Exposes smooth interpolated spot for
// buttery chart motion.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AssetMarket, MarketData } from '@/lib/types';
import { openMarketStream } from '@/lib/api';
import { MarketSim } from '@/lib/market-sim';

const INITIAL: MarketData = {
  source: 'local',
  tick: 0,
  tsMs: Date.now(),
  assets: {
    BTC: { spot: 97450, volShift: 0, fundingRate: 0.091, change24h: 0, openInterest: 4.12e9, volume24h: 1.87e9 },
    ETH: { spot: 2462, volShift: 0.02, fundingRate: 0.083, change24h: 0, openInterest: 2.31e9, volume24h: 9.6e8 },
    SOL: { spot: 138.4, volShift: -0.01, fundingRate: 0.104, change24h: 0, openInterest: 6.4e8, volume24h: 3.1e8 },
  },
};

interface MarketContextValue {
  market: MarketData;
  /** Smoothed spot for animation (lerped toward the live value). */
  smooth: Record<string, AssetMarket>;
  connected: boolean;
  source: 'rust' | 'local';
  retry: () => void;
}

const MarketContext = createContext<MarketContextValue | null>(null);

export function MarketProvider({ children }: { children: React.ReactNode }) {
  const [market, setMarket] = useState<MarketData>(INITIAL);
  const [connected, setConnected] = useState(false);
  const [nonce, setNonce] = useState(0);
  const simRef = useRef<MarketSim | null>(null);
  const latestRef = useRef<MarketData>(INITIAL);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let closed = false;
    let closeStream: (() => void) | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let simStarted = false;

    const startFallback = () => {
      if (closed || simStarted) return;
      simStarted = true;
      setConnected(false);
      const sim = simRef.current ?? new MarketSim();
      simRef.current = sim;
      // Seed the simulator from the latest known state for continuity.
      sim.start((m) => {
        if (!closed) {
          latestRef.current = m;
          setMarket(m);
        }
      });
    };

    const stopFallback = () => {
      simRef.current?.stop();
      simStarted = false;
    };

    // Give the Rust SSE 3.5s to deliver its first frame; else fall back.
    fallbackTimer = setTimeout(startFallback, 3500);

    try {
      closeStream = openMarketStream(
        (m) => {
          if (closed) return;
          if (fallbackTimer) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
          }
          stopFallback();
          setConnected(true);
          latestRef.current = m;
          setMarket(m);
        },
        () => {
          if (!closed && !simStarted) startFallback();
        },
      );
    } catch {
      startFallback();
    }

    return () => {
      closed = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      closeStream?.();
      stopFallback();
    };
  }, [nonce]);

  // Smooth interpolation at 30fps for chart motion.
  const [smooth, setSmooth] = useState<Record<string, AssetMarket>>(INITIAL.assets);
  const smoothRef = useRef<Record<string, AssetMarket>>(INITIAL.assets);
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
      value={{ market, smooth, connected, source: market.source, retry }}
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

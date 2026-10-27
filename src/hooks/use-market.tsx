'use client';

// Live market context: SSE stream from the Rust engine with a transparent
// client-side simulation fallback — and REAL BTC/ETH/SOL spot prices from
// public exchange APIs (Binance → Bybit → OKX → Deribit index) overlaid on
// every frame, so every place the terminal shows a price is live.
// Exposes smooth interpolated spot for buttery chart motion.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AssetMarket, MarketData } from '@/lib/types';
import { openMarketStream } from '@/lib/api';
import { MarketSim } from '@/lib/market-sim';
import { subscribeLivePrices, type LivePriceSnapshot } from '@/lib/live-prices';

const LIVE_ASSETS = ['BTC', 'ETH', 'SOL'] as const;

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
  /** Real exchange prices (Binance/Bybit/OKX/Deribit) — null until first poll. */
  live: LivePriceSnapshot | null;
  retry: () => void;
}

const MarketContext = createContext<MarketContextValue | null>(null);

export function MarketProvider({ children }: { children: React.ReactNode }) {
  const [market, setMarket] = useState<MarketData>(INITIAL);
  const [connected, setConnected] = useState(false);
  const [live, setLive] = useState<LivePriceSnapshot | null>(null);
  const [nonce, setNonce] = useState(0);
  const simRef = useRef<MarketSim | null>(null);
  const latestRef = useRef<MarketData>(INITIAL);
  const liveRef = useRef<LivePriceSnapshot | null>(null);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  // ── REAL live prices: poll public exchange APIs every 10s ─────────────────
  // Overlaid on whichever market frame is current (engine SSE or sim), so
  // every displayed spot — ticker, payoff, chains, gamma lab, trading,
  // paper desk — is the real traded price.
  const push = (m: MarketData) => {
    const m2 = applyLive(m);
    latestRef.current = m2;
    setMarket(m2);
  };

  useEffect(() => {
    const unsubscribe = subscribeLivePrices((snap) => {
      liveRef.current = snap;
      setLive(snap);
      // re-apply the fresh quotes on top of the latest frame
      push(latestRef.current);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyLive = (m: MarketData): MarketData => {
    const snap = liveRef.current;
    if (!snap?.ok) return m;
    let touched = false;
    const assets = { ...m.assets };
    for (const a of LIVE_ASSETS) {
      const q = snap.quotes[a];
      const base = assets[a];
      if (q && q.spot > 0 && base) {
        touched = true;
        assets[a] = {
          ...base,
          spot: q.spot,
          // app convention: change24h is a fraction (0.064 = 6.4%)
          change24h: q.change24hPct / 100,
          volume24h: q.volumeUsd24h || base.volume24h,
        };
      }
    }
    return touched ? { ...m, assets } : m;
  };

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
          push(m);
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
          push(m);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

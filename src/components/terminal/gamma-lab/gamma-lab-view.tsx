'use client';

// ─────────────────────────────────────────────────────────────────────────────
// GAMMA & FLOW LAB — the OpenMarket-style market internals workspace.
// One view, four tabs:
//   Overview  — GEX by strike, walls, gamma flip, max pain, dealer positioning
//   Heatmaps  — strike × expiry grids for GEX / VEX / IV / OI / volume
//   Flow      — live options tape: sweeps, blocks, 0DTE, premium flows
//   Contracts — per-contract charts, skew, term structure
// Symbols: US index (SPX), ETFs (SPY, QQQ), stocks (NVDA, TSLA, AAPL)
// and crypto (BTC, ETH, SOL — spot from the live market feed).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Grid3x3, Radio, LineChart, RefreshCw } from 'lucide-react';
import { LAB_SYMBOLS, buildGammaProfile, nextPrints, summarizeFlow } from '@/lib/gamma-flow';
import type { FlowPrint, GammaProfile } from '@/lib/gamma-flow';
import { useMarket } from '@/hooks/use-market';
import { fmtNum } from '@/lib/format';
import { GammaOverview } from './gamma-overview';
import { GammaHeatmaps } from './gamma-heatmaps';
import { GammaFlow } from './gamma-flow-tape';
import { GammaContracts } from './gamma-contracts';

type LabTab = 'overview' | 'heatmaps' | 'flow' | 'contracts';

const TABS: { id: LabTab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview · GEX & Dealers', icon: <Activity className="h-3.5 w-3.5" /> },
  { id: 'heatmaps', label: 'Heatmaps · Strike × Expiry', icon: <Grid3x3 className="h-3.5 w-3.5" /> },
  { id: 'flow', label: 'Options Flow · Live Tape', icon: <Radio className="h-3.5 w-3.5" /> },
  { id: 'contracts', label: 'Contracts · Skew & IV', icon: <LineChart className="h-3.5 w-3.5" /> },
];

const FLOW_TAPE_LEN = 220;

export function GammaLabView() {
  const { market, smooth } = useMarket();
  const [tab, setTab] = useState<LabTab>('overview');
  const [symbolId, setSymbolId] = useState('SPY');
  const [tick, setTick] = useState(() => Date.now());
  const [prints, setPrints] = useState<FlowPrint[]>([]);
  const seqRef = useRef(0);

  // live clock for US symbols (crypto uses the market feed spot)
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 4000);
    return () => clearInterval(t);
  }, []);

  // live spot for crypto symbols from the market feed
  const liveSpot = useMemo(() => {
    if (symbolId === 'BTC' || symbolId === 'ETH' || symbolId === 'SOL') {
      const a = smooth[symbolId] ?? market.assets[symbolId];
      if (a) return a.spot;
    }
    return undefined;
  }, [symbolId, smooth, market]);

  const profile = useMemo(
    () => buildGammaProfile(symbolId, tick, liveSpot),
    [symbolId, tick, liveSpot],
  );

  // flow tape cadence — 1–3 prints every 900ms
  useEffect(() => {
    setPrints([]);
    seqRef.current = 0;
  }, [symbolId]);

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const count = 1 + Math.floor(Math.random() * 3);
      const next = nextPrints(
        buildGammaProfile(symbolId, now, liveSpot),
        now,
        seqRef.current++,
        count,
      );
      setPrints((prev) => [...next, ...prev].slice(0, FLOW_TAPE_LEN));
    }, 900);
    return () => clearInterval(t);
  }, [symbolId, liveSpot]);

  const summary = useMemo(() => summarizeFlow(prints), [prints]);

  const sym = profile.symbol;
  const symbolGroups: { label: string; ids: string[] }[] = [
    { label: 'US index', ids: ['SPX'] },
    { label: 'US ETFs', ids: ['SPY', 'QQQ'] },
    { label: 'US stocks', ids: ['NVDA', 'TSLA', 'AAPL'] },
    { label: 'Crypto', ids: ['BTC', 'ETH', 'SOL'] },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-bold tracking-tight text-zinc-100">
            Gamma &amp; Flow Lab
          </h2>
          <p className="text-[9px] uppercase tracking-[0.16em] text-zinc-500">
            GEX · dealer positioning · walls · flips · heatmaps · options flow · 0DTE · skew
          </p>
        </div>

        {/* symbol selector */}
        <div className="flex flex-wrap items-center gap-1.5">
          {symbolGroups.map((g) => (
            <div key={g.label} className="flex items-center gap-0.5">
              <span className="mr-0.5 text-[8px] uppercase tracking-wider text-zinc-600">{g.label}</span>
              {g.ids.map((id) => {
                const s = LAB_SYMBOLS.find((x) => x.id === id)!;
                const active = symbolId === id;
                return (
                  <button
                    key={id}
                    onClick={() => setSymbolId(id)}
                    className={`rounded-md px-2 py-1 font-mono text-[11px] font-semibold transition ${
                      active
                        ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30'
                        : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
                    }`}
                    title={s.name}
                  >
                    {id}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3 font-mono text-[10px]">
          <span className="text-zinc-500">
            {sym.name} × {sym.multiplier}
          </span>
          <span className="font-bold text-zinc-100">
            {fmtNum(profile.spot, profile.spot >= 1000 ? 0 : 2)}
          </span>
          <span
            className={`flex items-center gap-1 ${
              profile.levels.regime === 'long-gamma' ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            {profile.levels.regime === 'long-gamma' ? 'LONG γ' : 'SHORT γ'}
          </span>
        </div>
      </div>

      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-zinc-800/70 px-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-[11px] font-medium transition ${
              tab === t.id
                ? 'border-b-2 border-teal-400 text-teal-300'
                : 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[8px] text-zinc-600">
          <RefreshCw className="h-2.5 w-2.5" />
          deterministic OI surface · re-seeded each minute · naive dealer convention
        </span>
      </div>

      {/* tab content */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tab === 'overview' && <GammaOverview profile={profile} />}
        {tab === 'heatmaps' && <GammaHeatmaps profile={profile} />}
        {tab === 'flow' && <GammaFlow profile={profile} prints={prints} summary={summary} />}
        {tab === 'contracts' && <GammaContracts profile={profile} />}
      </div>
    </div>
  );
}

'use client';

// Live options chain — REAL quotes from the connected exchanges (Deribit,
// Bybit, OKX, Aevo, Paradex/tradeparadigm, Derive v3) with explicit
// BUY / SELL actions on separated CALLS and PUTS panels.
//
// Stability contract (no flicker):
//   • data comes from /api/chain (8s cadence, server-cached) — values only
//     change when the venue actually changes them
//   • failed refreshes KEEP the last good snapshot (stale badge, never blank)
//   • no Math.random in the render path anywhere; the offline mirror uses a
//     deterministic strike-seeded generator
//   • memoized rows; refresh indicator lives in the header only

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronsUpDown, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import type { LegKind, Side, UnderlyingId } from '@/lib/types';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { MAX_LEGS } from '@/lib/strategies';
import { VOL_CONFIG, bsGreeks, ivForStrike, forwardPrice } from '@/lib/pricing';
import { fmtNum } from '@/lib/format';

const VENUE_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'deribit', label: 'Deribit' },
  { id: 'bybit', label: 'Bybit' },
  { id: 'okx', label: 'OKX' },
  { id: 'aevo', label: 'Aevo' },
  { id: 'paradex', label: 'Paradex' },
] as const;

type VenueOption = (typeof VENUE_OPTIONS)[number]['id'];

interface ChainApiRow {
  strike: number;
  callIv: number;
  callPrice: number;
  callDelta: number;
  callOi: number;
  callVolume: number;
  callBid: number | null;
  callAsk: number | null;
  putIv: number;
  putPrice: number;
  putDelta: number;
  putOi: number;
  putVolume: number;
  putBid: number | null;
  putAsk: number | null;
  isAtm: boolean;
}

interface ChainApiResponse {
  asset: string;
  venue: string;
  venueName: string;
  requestedVenue: string;
  quoteSource: 'live' | 'derived';
  expiry: string;
  daysOut: number;
  spot: number;
  forward: number;
  atmIv: number;
  instrumentCount: number;
  fetchMs: number;
  expiries: { label: string; ms: number; daysOut: number; instruments: number }[];
  rows: ChainApiRow[];
}

// --- deterministic offline mirror (engine + venue unreachable) -------------------

function seedRand(seed: number): number {
  let t = seed + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function offlineMirror(asset: string, spot: number, volShift: number, expiryDays: number): ChainApiResponse {
  const cfg = VOL_CONFIG[asset] ?? VOL_CONFIG.BTC;
  const t = expiryDays / 365;
  const f = forwardPrice(cfg, spot, t);
  const step = f >= 50000 ? 1000 : f >= 4000 ? 100 : f >= 400 ? 5 : 1;
  const lo = Math.floor((f * 0.85) / step) * step;
  const hi = Math.ceil((f * 1.15) / step) * step;
  const rows: ChainApiRow[] = [];
  for (let k = lo; k <= hi; k += step) {
    const seed = Math.round(k * 7 + expiryDays * 131);
    const civ = ivForStrike(cfg, spot, k, t, volShift);
    const cg = bsGreeks(spot, k, t, civ, cfg.rate, 'call');
    const pg = bsGreeks(spot, k, t, civ, cfg.rate, 'put');
    rows.push({
      strike: k,
      callIv: civ * 100, callPrice: cg.price, callDelta: cg.delta,
      callOi: 300 + Math.round(seedRand(seed) * 4000),
      callVolume: 50 + Math.round(seedRand(seed + 1) * 900),
      callBid: cg.price * 0.985, callAsk: cg.price * 1.015,
      putIv: civ * 100, putPrice: pg.price, putDelta: pg.delta,
      putOi: 260 + Math.round(seedRand(seed + 2) * 3800),
      putVolume: 40 + Math.round(seedRand(seed + 3) * 800),
      putBid: pg.price * 0.985, putAsk: pg.price * 1.015,
      isAtm: Math.abs(k - f) < step * 0.5,
    });
  }
  return {
    asset,
    venue: 'local',
    venueName: 'Offline mirror',
    requestedVenue: 'auto',
    quoteSource: 'derived',
    expiry: `${expiryDays}d`,
    daysOut: expiryDays,
    spot,
    forward: f,
    atmIv: rows.find((r) => r.isAtm)?.callIv ?? 50,
    instrumentCount: rows.length * 2,
    fetchMs: 0,
    expiries: [],
    rows,
  };
}

// --- the view -------------------------------------------------------------------

export function ChainView({ onOpenBuilder }: { onOpenBuilder: () => void }) {
  const { market } = useMarket();
  const { underlying, addLeg, updateLeg, setStrategyName, legs: builderLegs } = useStrategy();
  const [venue, setVenue] = useState<VenueOption>('auto');
  const [expiry, setExpiry] = useState<string | null>(null);
  const [data, setData] = useState<ChainApiResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [mode, setMode] = useState<'combined' | 'calls' | 'puts'>('combined');
  const [flash, setFlash] = useState<string | null>(null);
  const [capHit, setCapHit] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const dataRef = useRef<ChainApiResponse | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const q = new URLSearchParams({ asset: underlying, venue });
      if (expiry) q.set('expiry', expiry);
      const res = await fetch(`/api/chain?${q.toString()}`);
      if (!res.ok) throw new Error(`chain ${res.status}`);
      const json = (await res.json()) as ChainApiResponse;
      dataRef.current = json;
      setData(json);
      setStale(false);
    } catch {
      // keep the last good snapshot; flag it
      setStale(true);
    } finally {
      setRefreshing(false);
    }
  }, [underlying, venue, expiry]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  // pick a sensible default expiry once the calendar arrives (nearest > 1.5d)
  useEffect(() => {
    if (expiry && data?.expiries.some((e) => e.label === expiry)) return;
    const pick = data?.expiries.find((e) => e.daysOut > 1.5) ?? data?.expiries[0];
    if (pick && pick.label !== data?.expiry) setExpiry(pick.label);
    else if (pick) setExpiry((cur) => cur ?? pick.label);
  }, [data, expiry]);

  // offline mirror when no venue data at all
  const view: ChainApiResponse = useMemo(() => {
    if (data) return data;
    const spot = market.assets[underlying]?.spot ?? 90000;
    return offlineMirror(underlying, spot, market.assets[underlying]?.volShift ?? 0, 30);
  }, [data, market.assets, underlying]);

  const rows = view.rows;
  const liveCount = data ? data.quoteSource === 'live' : false;

  const addFromChain = useCallback(
    (kind: LegKind, side: Side, strike: number) => {
      const ok = addLeg(kind, view.spot);
      if (!ok) {
        setCapHit(true);
        setTimeout(() => setCapHit(false), 2600);
        return;
      }
      const legs = useStrategy.getState().legs;
      const leg = legs[legs.length - 1];
      updateLeg(leg.id, {
        side,
        strike,
        expiryDays: Math.max(1, Math.round(view.daysOut)),
      });
      setStrategyName(
        `${underlying} ${side === 'buy' ? 'Buy' : 'Sell'} ${kind === 'call' ? 'Call' : 'Put'} ${fmtNum(strike, 0)}`,
      );
      const key = `${side}-${kind}-${strike}`;
      setFlash(key);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 1100);
    },
    [addLeg, updateLeg, setStrategyName, underlying, view.spot, view.daysOut],
  );

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800/70 px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          {underlying} Options Chain
        </h2>

        {/* venue selector */}
        <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/50 p-0.5">
          {VENUE_OPTIONS.map((v) => (
            <button
              key={v.id}
              onClick={() => setVenue(v.id)}
              className={`rounded px-2 py-0.5 text-[9.5px] font-medium transition ${
                venue === v.id ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {/* separated view modes */}
        <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/50 p-0.5">
          {(['combined', 'calls', 'puts'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-2 py-0.5 text-[9.5px] font-medium uppercase transition ${
                mode === m
                  ? m === 'calls'
                    ? 'bg-emerald-950/60 text-emerald-300 ring-1 ring-emerald-500/30'
                    : m === 'puts'
                      ? 'bg-rose-950/60 text-rose-300 ring-1 ring-rose-500/30'
                      : 'bg-zinc-800 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {m === 'combined' ? 'Calls + Puts' : m}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2 font-mono text-[10px] text-zinc-500">
          <span className={`rounded border px-1.5 py-0.5 tabular-nums ${
            builderLegs.length >= MAX_LEGS
              ? 'border-amber-500/50 bg-amber-950/30 text-amber-400'
              : 'border-zinc-800 bg-zinc-900/60 text-zinc-400'
          }`}>
            {builderLegs.length}/{MAX_LEGS} legs
          </span>
          <span>spot <span className="text-zinc-200">{fmtNum(view.spot, view.spot >= 1000 ? 0 : 1)}</span></span>
          <span>ATM IV <span className="text-teal-300">{view.atmIv.toFixed(1)}%</span></span>
          <Badge
            variant="outline"
            className={`border-zinc-700 bg-zinc-900 text-[8px] font-normal ${
              stale ? 'text-amber-400' : liveCount ? 'text-teal-400' : 'text-zinc-500'
            }`}
          >
            {stale ? (
              <>
                <WifiOff className="mr-1 h-2.5 w-2.5" /> stale · {data?.venueName ?? 'offline'}
              </>
            ) : (
              <>
                <Wifi className="mr-1 h-2.5 w-2.5" /> {view.venueName}
                {view.quoteSource === 'derived' ? ' · derived' : ''} · {view.fetchMs}ms
              </>
            )}
          </Badge>
          <RefreshCw className={`h-3 w-3 text-zinc-600 ${refreshing ? 'animate-spin text-teal-400' : ''}`} />
        </div>
      </div>

      {/* Expiry chips — REAL venue calendar */}
      {view.expiries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800/70 px-4 py-1.5">
          <span className="mr-1 text-[8.5px] uppercase tracking-wider text-zinc-600">Expiry</span>
          {view.expiries.slice(0, 11).map((e) => {
            const active = view.expiry === e.label;
            const is0dte = e.daysOut < 1.05;
            return (
              <button
                key={e.label}
                onClick={() => setExpiry(e.label)}
                className={`rounded px-1.5 py-0.5 font-mono text-[9.5px] transition ${
                  active
                    ? is0dte
                      ? 'bg-amber-950/60 text-amber-300 ring-1 ring-amber-500/40'
                      : 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30'
                    : is0dte
                      ? 'text-amber-500/80 hover:text-amber-300'
                      : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {e.label}
                <span className="ml-1 text-[8px] text-zinc-600">
                  {is0dte ? '0DTE' : `${e.daysOut.toFixed(0)}d`}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {capHit && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-950/30 px-4 py-1.5 text-[10px] text-amber-300">
          Strategy is full — maximum {MAX_LEGS} legs. Remove a leg in the builder to add more.
        </div>
      )}

      {/* Table — separated CALLS | strike | PUTS panels with explicit BUY/SELL */}
      <div className="max-h-[calc(100vh-235px)] overflow-auto">
        <table className="w-full min-w-[860px] font-mono text-[11px]">
          <thead className="sticky top-0 z-10 bg-[#0a0e14]">
            {(mode === 'combined' || mode === 'calls') && (
              <tr className="text-[8px] uppercase tracking-wider text-zinc-600">
                {mode === 'combined' ? (
                  <th colSpan={8} className="border-b border-r border-zinc-800/70 py-1.5 text-center text-emerald-500/70">
                    CALLS — buy / sell
                  </th>
                ) : (
                  <th className="border-b border-zinc-800/70 py-1.5 text-center text-emerald-500/70">CALLS — buy / sell</th>
                )}
                {mode === 'combined' && <th className="border-b border-zinc-800/70" />}
                {mode === 'combined' && <th colSpan={8} className="border-b border-l border-zinc-800/70 py-1.5 text-center text-rose-500/70">PUTS — buy / sell</th>}
              </tr>
            )}
            {mode === 'puts' && (
              <tr className="text-[8px] uppercase tracking-wider text-zinc-600">
                <th className="border-b border-zinc-800/70 py-1.5 text-center text-rose-500/70">PUTS — buy / sell</th>
              </tr>
            )}
            <tr className="text-[9px] text-zinc-500">
              {(mode === 'combined' || mode === 'calls') && (
                <>
                  <th className="border-r border-zinc-800/40 py-1.5 pr-2 text-right">IV</th>
                  <th className="py-1.5 pr-2 text-right">Bid</th>
                  <th className="py-1.5 pr-2 text-right">Ask</th>
                  <th className="py-1.5 pr-2 text-right">Price</th>
                  <th className="py-1.5 pr-2 text-right">Δ</th>
                  <th className="py-1.5 pr-2 text-right">OI</th>
                  <th className="border-r border-zinc-800/70 py-1.5 pr-2 text-center">Buy</th>
                  <th className={`py-1.5 pr-2 text-center ${mode === 'calls' ? '' : 'border-r border-zinc-800/70'}`}>Sell</th>
                </>
              )}
              <th className="bg-zinc-900/60 py-1.5 text-center">Strike</th>
              {(mode === 'combined' || mode === 'puts') && (
                <>
                  <th className={`py-1.5 pl-2 text-center ${mode === 'puts' ? '' : 'border-l border-zinc-800/70'}`}>Buy</th>
                  <th className="py-1.5 pl-2 text-center">Sell</th>
                  <th className="py-1.5 pl-2 text-left">OI</th>
                  <th className="py-1.5 pl-2 text-left">Δ</th>
                  <th className="py-1.5 pl-2 text-left">Price</th>
                  <th className="py-1.5 pl-2 text-left">Bid</th>
                  <th className="py-1.5 pl-2 text-left">Ask</th>
                  <th className="py-1.5 pl-2 text-left">IV</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ChainRow key={r.strike} row={r} mode={mode} flash={flash} onAction={addFromChain} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={17} className="py-8 text-center text-[11px] text-zinc-600">
                  No strikes for this expiry on {view.venueName}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-zinc-800/70 px-4 py-2">
        <p className="text-[9px] text-zinc-600">
          {view.venueName} · {rows.length} strikes · {view.instrumentCount} instruments
          {view.quoteSource === 'derived' ? ' · quotes derived from live cross-venue IV surface' : ' · native venue quotes'}
          {' · B/S buttons add buy/sell legs to the builder'}
        </p>
        <Button size="sm" variant="outline" onClick={onOpenBuilder} className="h-7 gap-1 border-zinc-700 bg-zinc-900 text-[10px] text-zinc-300 hover:text-zinc-100">
          <ChevronsUpDown className="h-3 w-3" /> Open Builder
        </Button>
      </div>
    </div>
  );
}

// --- one memoized row -------------------------------------------------------------

interface ChainRowProps {
  row: ChainApiRow;
  mode: 'combined' | 'calls' | 'puts';
  flash: string | null;
  onAction: (kind: LegKind, side: Side, strike: number) => void;
}

const ChainRow = React.memo(
  function ChainRow({ row, mode, flash, onAction }: ChainRowProps) {
    const callBuyFlash = flash === `buy-call-${row.strike}`;
    const callSellFlash = flash === `sell-call-${row.strike}`;
    const putBuyFlash = flash === `buy-put-${row.strike}`;
    const putSellFlash = flash === `sell-put-${row.strike}`;
    return (
      <tr
        className={`border-b border-zinc-800/30 hover:bg-zinc-900/40 ${row.isAtm ? 'bg-teal-950/10' : ''}`}
      >
        {/* CALLS panel */}
        {(mode === 'combined' || mode === 'calls') && (
          <>
            <td className="border-r border-zinc-800/30 py-1.5 pr-2 text-right text-zinc-500">{row.callIv > 0 ? row.callIv.toFixed(1) : '—'}</td>
            <td className="py-1.5 pr-2 text-right text-emerald-400/70 tabular-nums">{row.callBid != null ? fmtNum(row.callBid, 1) : '—'}</td>
            <td className="py-1.5 pr-2 text-right text-rose-400/70 tabular-nums">{row.callAsk != null ? fmtNum(row.callAsk, 1) : '—'}</td>
            <td className="py-1.5 pr-2 text-right font-semibold text-emerald-300/90">{row.callPrice > 0 ? fmtNum(row.callPrice, 1) : '—'}</td>
            <td className="py-1.5 pr-2 text-right text-zinc-400">{row.callDelta !== 0 ? row.callDelta.toFixed(3) : '—'}</td>
            <td className="py-1.5 pr-2 text-right text-zinc-600">{row.callOi > 0 ? fmtNum(row.callOi, 0) : '—'}</td>
            <td className="border-r border-zinc-800/70 py-1 pr-1 text-center">
              <ActionBtn label="B" title={`Buy ${row.strike} call`} flash={callBuyFlash} tone="buy" onClick={() => onAction('call', 'buy', row.strike)} />
            </td>
            <td className={`py-1 pr-2 text-center ${mode === 'calls' ? '' : 'border-r border-zinc-800/70'}`}>
              <ActionBtn label="S" title={`Sell ${row.strike} call`} flash={callSellFlash} tone="sell" onClick={() => onAction('call', 'sell', row.strike)} />
            </td>
          </>
        )}

        {/* Strike */}
        <td className={`bg-zinc-900/50 py-1.5 text-center font-bold ${row.isAtm ? 'text-teal-300' : 'text-zinc-300'}`}>
          {fmtNum(row.strike, 0)}
        </td>

        {/* PUTS panel */}
        {(mode === 'combined' || mode === 'puts') && (
          <>
            <td className={`py-1 pl-1 text-center ${mode === 'puts' ? '' : 'border-l border-zinc-800/70'}`}>
              <ActionBtn label="B" title={`Buy ${row.strike} put`} flash={putBuyFlash} tone="buy" onClick={() => onAction('put', 'buy', row.strike)} />
            </td>
            <td className="py-1 pl-1 text-center">
              <ActionBtn label="S" title={`Sell ${row.strike} put`} flash={putSellFlash} tone="sell" onClick={() => onAction('put', 'sell', row.strike)} />
            </td>
            <td className="py-1.5 pl-2 text-left text-zinc-600">{row.putOi > 0 ? fmtNum(row.putOi, 0) : '—'}</td>
            <td className="py-1.5 pl-2 text-left text-zinc-400">{row.putDelta !== 0 ? row.putDelta.toFixed(3) : '—'}</td>
            <td className="py-1.5 pl-2 text-left font-semibold text-rose-300/90">{row.putPrice > 0 ? fmtNum(row.putPrice, 1) : '—'}</td>
            <td className="py-1.5 pl-2 text-left text-emerald-400/70 tabular-nums">{row.putBid != null ? fmtNum(row.putBid, 1) : '—'}</td>
            <td className="py-1.5 pl-2 text-left text-rose-400/70 tabular-nums">{row.putAsk != null ? fmtNum(row.putAsk, 1) : '—'}</td>
            <td className="py-1.5 pl-2 text-left text-zinc-500">{row.putIv > 0 ? row.putIv.toFixed(1) : '—'}</td>
          </>
        )}
      </tr>
    );
  },
  (prev, next) =>
    prev.mode === next.mode &&
    prev.flash === next.flash &&
    prev.row === next.row &&
    prev.onAction === next.onAction,
);

function ActionBtn({
  label,
  title,
  flash,
  tone,
  onClick,
}: {
  label: string;
  title: string;
  flash: boolean;
  tone: 'buy' | 'sell';
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-6 rounded py-0.5 text-[9px] font-bold transition ${
        flash
          ? tone === 'buy'
            ? 'bg-emerald-500/30 text-emerald-200 ring-1 ring-emerald-400/60'
            : 'bg-rose-500/30 text-rose-200 ring-1 ring-rose-400/60'
          : tone === 'buy'
            ? 'bg-zinc-800/60 text-emerald-400/90 hover:bg-emerald-950/60 hover:text-emerald-300'
            : 'bg-zinc-800/60 text-rose-400/90 hover:bg-rose-950/60 hover:text-rose-300'
      }`}
    >
      {flash ? '✓' : label}
    </button>
  );
}

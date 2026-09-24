'use client';

// Pro-mode option chain: strikes × calls/puts with live IV, price, delta,
// OI — fetched from the Rust engine, with a local mirror fallback.
// Click any quote to add that leg to the builder.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Plus, ChevronsUpDown } from 'lucide-react';
import type { Leg, UnderlyingId } from '@/lib/types';
import { engine, RustChain } from '@/lib/api';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { MAX_LEGS } from '@/lib/strategies';
import { bsGreeks, ivForStrike, forwardPrice, VOL_CONFIG } from '@/lib/pricing';
import { fmtNum } from '@/lib/format';

const EXPIRIES = [1, 7, 14, 30, 60, 90, 180, 365];

export function ChainView({ onOpenBuilder }: { onOpenBuilder: () => void }) {
  const { market, smooth, connected } = useMarket();
  const { underlying, addLeg, setStrategyName, legs: builderLegs } = useStrategy();
  const asset = smooth[underlying] ?? market.assets[underlying];
  const [expiry, setExpiry] = useState(30);
  const [chain, setChain] = useState<RustChain | null>(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [capHit, setCapHit] = useState(false);

  const fetchChain = useCallback(async () => {
    setLoading(true);
    try {
      const c = await engine.chain(underlying as UnderlyingId, expiry);
      setChain(c);
    } catch {
      setChain(null);
    } finally {
      setLoading(false);
    }
  }, [underlying, expiry]);

  useEffect(() => {
    void fetchChain();
  }, [fetchChain]);

  // Refresh from engine every 5s when connected.
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => void fetchChain(), 5000);
    return () => clearInterval(t);
  }, [connected, fetchChain]);

  // Local mirror when engine offline.
  const localRows = useMemo(() => {
    const cfg = VOL_CONFIG[underlying] ?? VOL_CONFIG.BTC;
    const t = expiry / 365;
    const f = forwardPrice(cfg, asset.spot, t);
    const step = f >= 50000 ? 1000 : f >= 4000 ? 100 : f >= 400 ? 5 : 1;
    const lo = Math.floor((f * 0.75) / step) * step;
    const hi = Math.ceil((f * 1.25) / step) * step;
    const rows: RustChain['rows'] = [];
    for (let k = lo; k <= hi; k += step) {
      const civ = ivForStrike(cfg, asset.spot, k, t, asset.volShift);
      const cg = bsGreeks(asset.spot, k, t, civ, cfg.rate, 'call');
      const pg = bsGreeks(asset.spot, k, t, civ, cfg.rate, 'put');
      rows.push({
        strike: k,
        callIv: civ * 100, callPrice: cg.price, callDelta: cg.delta, callOi: 800 + Math.random() * 4000, callVolume: 100 + Math.random() * 900,
        putIv: civ * 100, putPrice: pg.price, putDelta: pg.delta, putOi: 700 + Math.random() * 3800, putVolume: 90 + Math.random() * 800,
        isAtm: Math.abs(k - f) < step * 0.5,
      });
    }
    return rows;
  }, [underlying, expiry, asset.spot, asset.volShift]);

  const rows = chain?.rows ?? localRows;
  const atmIv = chain?.atmIv ?? rows.find((r) => r.isAtm)?.callIv ?? 50;

  const addFromChain = (kind: 'call' | 'put', strike: number) => {
    const ok = addLeg(kind, asset.spot);
    if (!ok) {
      setCapHit(true);
      setTimeout(() => setCapHit(false), 2600);
      return;
    }
    const legs = useStrategy.getState().legs;
    const leg = legs[legs.length - 1];
    useStrategy.getState().updateLeg(leg.id, { strike, expiryDays: expiry });
    setStrategyName(`${underlying} ${kind === 'call' ? 'Call' : 'Put'} ${fmtNum(strike, 0)}`);
    setAdded(`${kind}-${strike}`);
    setTimeout(() => setAdded(null), 1200);
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800/70 px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          {underlying} Options Chain
        </h2>
        <div className="flex items-center gap-1">
          {EXPIRIES.map((d) => (
            <button
              key={d}
              onClick={() => setExpiry(d)}
              className={`rounded px-2 py-1 font-mono text-[10px] transition ${
                expiry === d ? 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3 font-mono text-[10px] text-zinc-500">
          <span className={`rounded border px-1.5 py-0.5 tabular-nums ${
            builderLegs.length >= MAX_LEGS
              ? 'border-amber-500/50 bg-amber-950/30 text-amber-400'
              : 'border-zinc-800 bg-zinc-900/60 text-zinc-400'
          }`}>
            {builderLegs.length}/{MAX_LEGS} legs
          </span>
          <span>spot <span className="text-zinc-200">{fmtNum(asset.spot, asset.spot >= 1000 ? 0 : 1)}</span></span>
          <span>fwd <span className="text-zinc-200">{fmtNum(chain?.forward ?? asset.spot, 0)}</span></span>
          <span>ATM IV <span className="text-teal-300">{atmIv.toFixed(1)}%</span></span>
          {loading && <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />}
          <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-[8px] font-normal text-zinc-500">
            {chain ? `engine · ${chain.computeUs}µs` : 'local mirror'}
          </Badge>
        </div>
      </div>

      {capHit && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-950/30 px-4 py-1.5 text-[10px] text-amber-300">
          Strategy is full — maximum {MAX_LEGS} legs. Remove a leg in the builder to add more.
        </div>
      )}

      {/* Table */}
      <div className="max-h-[calc(100vh-220px)] overflow-auto">
        <table className="w-full min-w-[760px] font-mono text-[11px]">
          <thead className="sticky top-0 z-10 bg-[#0a0e14]">
            <tr className="text-[8px] uppercase tracking-wider text-zinc-600">
              <th colSpan={5} className="border-b border-r border-zinc-800/70 py-1.5 text-center text-emerald-500/70">Calls</th>
              <th className="border-b border-zinc-800/70 py-1.5" />
              <th colSpan={5} className="border-b border-l border-zinc-800/70 py-1.5 text-center text-rose-500/70">Puts</th>
            </tr>
            <tr className="text-[9px] text-zinc-500">
              <th className="border-r border-zinc-800/40 py-1.5 pr-2 text-right">IV</th>
              <th className="py-1.5 pr-2 text-right">Price</th>
              <th className="py-1.5 pr-2 text-right">Δ</th>
              <th className="py-1.5 pr-2 text-right">OI</th>
              <th className="border-r border-zinc-800/70 py-1.5 pr-2 text-right">Vol</th>
              <th className="bg-zinc-900/60 py-1.5 text-center">Strike</th>
              <th className="border-l border-zinc-800/70 py-1.5 pl-2 text-left">Vol</th>
              <th className="py-1.5 pl-2 text-left">OI</th>
              <th className="py-1.5 pl-2 text-left">Δ</th>
              <th className="py-1.5 pl-2 text-left">Price</th>
              <th className="py-1.5 pl-2 text-left">IV</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.strike}
                className={`border-b border-zinc-800/30 transition hover:bg-zinc-900/40 ${r.isAtm ? 'bg-teal-950/10' : ''}`}
              >
                {/* Calls */}
                <td className="border-r border-zinc-800/30 py-1.5 pr-2 text-right text-zinc-500">{r.callIv.toFixed(1)}</td>
                <td className="py-1.5 pr-2 text-right font-semibold text-emerald-300/90">{fmtNum(r.callPrice, 2)}</td>
                <td className="py-1.5 pr-2 text-right text-zinc-400">{r.callDelta.toFixed(3)}</td>
                <td className="py-1.5 pr-2 text-right text-zinc-600">{fmtNum(r.callOi / 100, 0)}</td>
                <td className="border-r border-zinc-800/70 py-1.5 pr-2 text-right">
                  <button
                    onClick={() => addFromChain('call', r.strike)}
                    title="Add call leg to builder"
                    className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] transition ${
                      added === `call-${r.strike}`
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-zinc-800/60 text-zinc-500 hover:bg-emerald-950/50 hover:text-emerald-300'
                    }`}
                  >
                    {added === `call-${r.strike}` ? 'added' : <><Plus className="h-2.5 w-2.5" />{fmtNum(r.callVolume / 100, 0)}</>}
                  </button>
                </td>
                {/* Strike */}
                <td className={`bg-zinc-900/50 py-1.5 text-center font-bold ${r.isAtm ? 'text-teal-300' : 'text-zinc-300'}`}>
                  {fmtNum(r.strike, 0)}
                </td>
                {/* Puts */}
                <td className="border-l border-zinc-800/70 py-1.5 pl-2 text-left">
                  <button
                    onClick={() => addFromChain('put', r.strike)}
                    title="Add put leg to builder"
                    className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] transition ${
                      added === `put-${r.strike}`
                        ? 'bg-rose-500/20 text-rose-300'
                        : 'bg-zinc-800/60 text-zinc-500 hover:bg-rose-950/50 hover:text-rose-300'
                    }`}
                  >
                    {added === `put-${r.strike}` ? 'added' : <><Plus className="h-2.5 w-2.5" />{fmtNum(r.putVolume / 100, 0)}</>}
                  </button>
                </td>
                <td className="py-1.5 pl-2 text-left text-zinc-600">{fmtNum(r.putOi / 100, 0)}</td>
                <td className="py-1.5 pl-2 text-left text-zinc-400">{r.putDelta.toFixed(3)}</td>
                <td className="py-1.5 pl-2 text-left font-semibold text-rose-300/90">{fmtNum(r.putPrice, 2)}</td>
                <td className="py-1.5 pl-2 text-left text-zinc-500">{r.putIv.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-zinc-800/70 px-4 py-2">
        <p className="text-[9px] text-zinc-600">
          SVI surface · {rows.length} strikes · click a volume cell to add the leg to the builder
        </p>
        <Button size="sm" variant="outline" onClick={onOpenBuilder} className="h-7 gap-1 border-zinc-700 bg-zinc-900 text-[10px] text-zinc-300 hover:text-zinc-100">
          <ChevronsUpDown className="h-3 w-3" /> Open Builder
        </Button>
      </div>
    </div>
  );
}

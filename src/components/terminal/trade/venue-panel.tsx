'use client';

// Multi-venue panel — Derive / Paradex / Paradigm + Volos CLOB connectivity,
// composite liquidity and the best-execution route planner.

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { engine, type RoutePlan, type VenueQuote, type VenueStatus } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { Globe2, Route, Loader2 } from 'lucide-react';

export function VenuePanel({ instrument }: { instrument: string }) {
  const [statuses, setStatuses] = useState<VenueStatus[]>([]);
  const [quotes, setQuotes] = useState<VenueQuote[]>([]);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [routeSide, setRouteSide] = useState<'buy' | 'sell'>('buy');
  const [routeQty, setRouteQty] = useState('1');
  const [planning, setPlanning] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      engine.venues().then((s) => alive && setStatuses(s)).catch(() => {});
      engine.venueQuotes(instrument).then((q) => alive && setQuotes(q)).catch(() => {});
    };
    load();
    const iv = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [instrument]);

  const planRoute = () => {
    const q = parseFloat(routeQty);
    if (!(q > 0)) return;
    setPlanning(true);
    engine
      .routePlan({ instrument, side: routeSide, qty: q })
      .then(setPlan)
      .catch(() => setPlan(null))
      .finally(() => setPlanning(false));
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        <Globe2 className="h-3.5 w-3.5 text-sky-400" /> Venues & Router
      </p>

      {/* Statuses */}
      <div className="space-y-1">
        {statuses.map((v) => (
          <div key={v.venue} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/50 px-2 py-1.5">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                v.status === 'live' ? 'bg-teal-400' : v.status === 'simulated' ? 'bg-amber-400' : 'bg-zinc-600'
              }`}
            />
            <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-zinc-200">{v.venue}</span>
            <span className="font-mono text-[9px] text-zinc-500">{v.latencyMs.toFixed(0)}ms</span>
            <span
              className={`rounded px-1 py-0.5 text-[8px] font-semibold uppercase ${
                v.status === 'live' ? 'bg-teal-950/50 text-teal-300' : 'bg-amber-950/40 text-amber-300'
              }`}
            >
              {v.status === 'live' ? 'live' : v.mode === 'live_anchor' ? 'anchored' : v.status}
            </span>
          </div>
        ))}
        {statuses.length === 0 && <p className="text-[10px] text-zinc-600">Loading venue status…</p>}
      </div>

      {/* Composite quotes for selected instrument */}
      {quotes.length > 0 && (
        <div className="mt-2.5">
          <p className="mb-1 text-[8px] uppercase tracking-wider text-zinc-600">Composite book — {instrument}</p>
          <div className="space-y-0.5">
            {quotes.map((q) => (
              <div key={q.venue} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded bg-zinc-950/40 px-2 py-1 font-mono text-[9px] tabular-nums">
                <span className="text-zinc-400">{q.venue}</span>
                <span className="text-emerald-400/90">
                  {fmtNum(q.bid, 2)} × {fmtNum(q.bidQty, 2)}
                </span>
                <span className="text-rose-400/90">
                  {fmtNum(q.ask, 2)} × {fmtNum(q.askQty, 2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Route planner */}
      <div className="mt-2.5 rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
        <p className="mb-1.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
          <Route className="h-3 w-3 text-teal-400" /> Best-execution planner
        </p>
        <div className="flex gap-1.5">
          <button
            onClick={() => setRouteSide(routeSide === 'buy' ? 'sell' : 'buy')}
            className={`w-12 rounded border px-1 py-1 text-[9px] font-bold uppercase transition ${
              routeSide === 'buy'
                ? 'border-emerald-600/50 bg-emerald-950/40 text-emerald-300'
                : 'border-rose-600/50 bg-rose-950/40 text-rose-300'
            }`}
          >
            {routeSide}
          </button>
          <input
            type="number"
            step="any"
            min={0}
            value={routeQty}
            onChange={(e) => setRouteQty(e.target.value)}
            className="w-16 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-right font-mono text-[10px] text-zinc-200 outline-none"
          />
          <Button
            size="sm"
            onClick={planRoute}
            disabled={planning}
            className="h-7 flex-1 bg-teal-500/90 text-[9px] font-bold text-zinc-950 hover:bg-teal-400"
          >
            {planning ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Plan route'}
          </Button>
        </div>

        {plan && (
          <div className="mt-2 space-y-1">
            <div className="flex items-center justify-between font-mono text-[9px]">
              <span className="text-zinc-500">filled {fmtNum(plan.plannedQty, 3)} / {fmtNum(plan.requestedQty, 3)}</span>
              <span className="text-zinc-400">vwap {fmtNum(plan.vwap, 2)}</span>
            </div>
            {plan.children.map((c, i) => (
              <div key={i} className="flex items-center justify-between rounded bg-zinc-900/60 px-2 py-1 font-mono text-[9px]">
                <span className={c.ownClob ? 'text-teal-300' : 'text-zinc-300'}>
                  {c.ownClob ? 'Volos CLOB' : c.venue}
                </span>
                <span className="text-zinc-500">
                  {fmtNum(c.qty, 3)} @ {fmtNum(c.price, 2)} · fee {c.feeBps.toFixed(1)}bp
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-zinc-800 pt-1 font-mono text-[9px]">
              <span className="text-zinc-500">vs worst single venue</span>
              <span className="text-emerald-400">saves {plan.savingsBps.toFixed(1)} bps</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

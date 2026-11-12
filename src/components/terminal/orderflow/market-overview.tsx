'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — whole-market overview: every tracked asset × every venue in one
// strip. Click a card to drill into that symbol's full workspace.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { fmtPct, fmtQty, fmtUsd, venueColor } from './use-orderflow';
import type { OfAsset } from '@/lib/orderflow/types';

interface OverviewAsset {
  asset: string;
  connected: boolean;
  last: number;
  change1mPct: number;
  changeSessionPct: number;
  openInterest: number | null;
  oiChange: { priceChange: number; oiChange: number; regime: string } | null;
  funding8h: number | null;
  nextFundingTime: number | null;
  basisBps: number | null;
  cvd1m: number;
  buyShare1m: number;
  volumeZ: number | null;
  obi10: number | null;
  spreadBps: number | null;
  volume1mNotional: number;
  liquidations: {
    last1h: { longNotional: number; shortNotional: number; count: number };
    last24h: { longNotional: number; shortNotional: number; count: number };
    cascadeActive: boolean;
  };
  micro: { absorption: number; icebergs: number };
  leaderVenue: string | null;
  venues: Array<{ venue: string; status: string }>;
  venueStats: Array<{ venue: string; last: number; share: number; delta: number; leadMs: number | null }>;
}

export function MarketOverview({ onSelect, active }: { onSelect: (asset: OfAsset) => void; active: string }) {
  const [data, setData] = useState<{ tsMs: number; assets: OverviewAsset[] } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/orderflow/overview', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { tsMs: number; assets: OverviewAsset[] };
        if (alive) setData(json);
      } catch {
        /* next poll retries */
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
      {(data?.assets ?? []).map((a) => {
        const liqTotal = (a.liquidations?.last1h?.longNotional ?? 0) + (a.liquidations?.last1h?.shortNotional ?? 0);
        const liqMax = Math.max(a.liquidations?.last1h?.longNotional ?? 0, a.liquidations?.last1h?.shortNotional ?? 0, 1);
        const regime = a.oiChange?.regime ?? 'neutral';
        const regimeTone =
          regime === 'new-longs' ? 'text-emerald-400' : regime === 'new-shorts' ? 'text-rose-400' : regime === 'short-covering' ? 'text-amber-400' : regime === 'long-unwind' ? 'text-rose-400' : 'text-zinc-400';
        return (
          <button
            key={a.asset}
            onClick={() => onSelect(a.asset as OfAsset)}
            className={`group rounded-lg border p-2 text-left transition ${
              active === a.asset ? 'border-teal-500/50 bg-teal-950/10' : 'border-zinc-800/70 bg-zinc-900/30 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-baseline justify-between">
              <span className="flex items-center gap-1.5">
                <span className="text-[11px] font-bold text-zinc-100">{a.asset}</span>
                <span className={`flex items-center font-mono text-[9px] ${a.change1mPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {a.change1mPct >= 0 ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
                  {fmtPct(a.change1mPct, 2)}
                </span>
              </span>
              <span className="font-mono text-[13px] font-semibold text-zinc-50">{a.last ? a.last.toFixed(a.last > 5000 ? 0 : 2) : '—'}</span>
            </div>

            <div className="mt-1.5 grid grid-cols-4 gap-1.5 font-mono text-[9px]">
              <div>
                <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">oi</p>
                <p className="text-zinc-300">{fmtQty(a.openInterest)}</p>
                {a.oiChange && <p className={regimeTone}>{fmtPct(a.oiChange.oiChange * 100, 1)}</p>}
              </div>
              <div>
                <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">regime</p>
                <p className={regimeTone}>{a.oiChange?.regime?.replace('-', ' ') ?? '—'}</p>
              </div>
              <div>
                <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">funding 8h</p>
                <p className={(a.funding8h ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  {a.funding8h !== null ? `${(a.funding8h * 100).toFixed(3)}%` : '—'}
                </p>
              </div>
              <div>
                <p className="text-[7.5px] uppercase tracking-wider text-zinc-600">basis</p>
                <p className={(a.basisBps ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  {a.basisBps !== null ? `${a.basisBps.toFixed(1)}bp` : '—'}
                </p>
              </div>
            </div>

            <div className="mt-1.5 flex items-center gap-2 font-mono text-[8.5px]">
              <span className="flex items-center gap-1">
                <span className="text-[7.5px] uppercase tracking-wider text-zinc-600">cvd 1m</span>
                <span className={a.cvd1m >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{fmtQty(a.cvd1m)}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="text-[7.5px] uppercase tracking-wider text-zinc-600">obi</span>
                <span className={(a.obi10 ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{a.obi10 !== null ? a.obi10.toFixed(2) : '—'}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="text-[7.5px] uppercase tracking-wider text-zinc-600">1m vol</span>
                <span className="text-zinc-300">{fmtUsd(a.volume1mNotional)}</span>
              </span>
            </div>

            <div className="mt-1.5 flex items-center gap-1.5">
              <div className="flex h-3 flex-1 items-center gap-0.5 overflow-hidden rounded bg-zinc-900" title={`liq 1h: $${((a.liquidations?.last1h?.longNotional ?? 0) / 1000).toFixed(0)}K longs vs $${((a.liquidations?.last1h?.shortNotional ?? 0) / 1000).toFixed(0)}K shorts · 24h total ${fmtUsd((a.liquidations?.last24h?.longNotional ?? 0) + (a.liquidations?.last24h?.shortNotional ?? 0))}`}>
                <div className="h-full bg-rose-500/70" style={{ width: `${((a.liquidations?.last1h?.longNotional ?? 0) / liqMax) * 50}%` }} />
                <div className="h-full flex-1" />
                <div className="h-full bg-emerald-500/70" style={{ width: `${((a.liquidations?.last1h?.shortNotional ?? 0) / liqMax) * 50}%` }} />
              </div>
              {a.liquidations?.cascadeActive && (
                <span className="rounded bg-rose-950/60 px-1 py-0.5 text-[7.5px] font-bold uppercase tracking-wider text-rose-300 ring-1 ring-rose-500/40">
                  cascade
                </span>
              )}
              {liqTotal === 0 && <span className="font-mono text-[7.5px] text-zinc-700">liq quiet 1h</span>}
            </div>

            <div className="mt-1.5 flex items-center justify-between">
              <div className="flex items-center gap-1">
                {a.venues?.map((v) => (
                  <span
                    key={v.venue}
                    title={`${v.venue}: ${v.status}`}
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: v.status === 'live' ? venueColor(v.venue) : '#3f3f46' }}
                  />
                ))}
              </div>
              <span className="flex items-center gap-2 font-mono text-[8px] text-zinc-600">
                {a.micro?.absorption > 0 && <span className="text-emerald-500/80">abs {a.micro.absorption}/5m</span>}
                {a.micro?.icebergs > 0 && <span className="text-sky-400/80">ice {a.micro.icebergs}/5m</span>}
                {a.leaderVenue && <span className="text-teal-500/80">lead {a.leaderVenue}</span>}
              </span>
            </div>
          </button>
        );
      })}
      {!data && (
        <div className="col-span-3 flex items-center justify-center rounded-lg border border-zinc-800/70 bg-zinc-900/30 py-6 text-[10px] text-zinc-600">
          connecting to every venue — building the whole-market view…
        </div>
      )}
    </div>
  );
}

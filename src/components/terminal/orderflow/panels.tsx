'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — side panels (tape · book · venues · OI/funding · liquidations
// · alerts · KPI strip · CVD strip). All read the shared store directly.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  ChevronUp,
  ChevronDown,
  Diamond,
  ShieldAlert,
  Waves,
} from 'lucide-react';
import type { OrderFlowStore } from './use-orderflow';
import { fmtPrice, fmtQty, fmtTime, fmtUsd, fmtPct, venueColor } from './use-orderflow';
import type { OfAlertSettings, OfAsset, OfVenueId } from '@/lib/orderflow/types';
import { OI_REGIME_HINT, OI_REGIME_LABEL } from '@/lib/orderflow/derivatives';

// ── KPI strip ────────────────────────────────────────────────────────────────

function Stat({ label, value, tone, title }: { label: string; value: React.ReactNode; tone?: 'pos' | 'neg' | 'warn' | 'info'; title?: string }) {
  const color =
    tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : tone === 'info' ? 'text-teal-300' : 'text-zinc-200';
  return (
    <div className="flex min-w-[86px] shrink-0 flex-col gap-0.5 rounded-md border border-zinc-800/70 bg-zinc-900/40 px-2 py-1" title={title}>
      <span className="text-[8px] uppercase tracking-[0.14em] text-zinc-600">{label}</span>
      <span className={`font-mono text-[11px] font-semibold ${color}`}>{value}</span>
    </div>
  );
}

export function KpiStrip({ store }: { store: OrderFlowStore | null }) {
  const st = store?.state;
  const s = st?.session;
  const a = st?.analytics;
  const d = st?.deriv;
  const tick = st?.tick || 0.01;
  const fundingAnn = d?.aggregate?.fundingRate8h !== null && d?.aggregate?.fundingRate8h !== undefined ? d.aggregate.fundingRate8h * 365 * 100 : null;
  const nextFunding = d?.aggregate?.nextFundingTime ? Math.max(0, (d.aggregate.nextFundingTime - Date.now()) / 60_000) : null;
  const regime = d?.windows?.w1m?.regime ?? 'neutral';
  const regimeTone =
    regime === 'new-longs' ? 'pos' : regime === 'new-shorts' ? 'neg' : regime === 'short-covering' ? 'warn' : regime === 'long-unwind' ? 'neg' : undefined;
  const buyShare = s && s.volume > 0 ? s.buyVolume / s.volume : 0.5;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Stat
        label="last"
        value={fmtPrice(s?.last, tick)}
        tone={s && s.open ? (s.last >= s.open ? 'pos' : 'neg') : undefined}
        title={`session open ${fmtPrice(s?.open, tick)}`}
      />
      <Stat label="session range" value={`${fmtPrice(s?.high, tick)} / ${fmtPrice(s?.low, tick)}`} />
      <Stat
        label="vwap ±σ"
        value={`${fmtPrice(s?.vwap, tick)} · ${s?.vwapStd ? s.vwapStd.toFixed(tick < 1 ? 2 : 1) : '—'}`}
        tone="info"
        title={`distance ${(s && s.vwap ? ((s.last - s.vwap) / s.vwap) * 100 : 0).toFixed(2)}%`}
      />
      <Stat
        label="1m cvd"
        value={fmtQty(a?.cvd1m)}
        tone={(a?.cvd1m ?? 0) >= 0 ? 'pos' : 'neg'}
        title="1-minute cumulative volume delta"
      />
      <Stat label="buy share" value={`${(buyShare * 100).toFixed(0)}%`} tone={buyShare >= 0.5 ? 'pos' : 'neg'} />
      <Stat
        label={`oi ${d?.windows?.w5m ? fmtPct(d.windows.w5m.oiChange * 100, 1) : ''}`}
        value={fmtQty(d?.aggregate?.openInterest)}
        title="open interest summed across venues (base units) · 5-minute change"
      />
      <Stat
        label="regime"
        value={OI_REGIME_LABEL[regime as keyof typeof OI_REGIME_LABEL] ?? regime}
        tone={regimeTone as 'pos' | 'neg' | 'warn' | undefined}
        title={OI_REGIME_HINT[regime as keyof typeof OI_REGIME_HINT]}
      />
      <Stat
        label="funding 8h"
        value={d?.aggregate?.fundingRate8h !== null && d?.aggregate?.fundingRate8h !== undefined ? `${(d.aggregate.fundingRate8h * 100).toFixed(4)}%` : '—'}
        tone={(fundingAnn ?? 0) >= 0 ? 'pos' : 'neg'}
        title={`annualized ${fundingAnn ? fundingAnn.toFixed(1) : '—'}% · next in ${nextFunding ? nextFunding.toFixed(0) : '—'} min`}
      />
      <Stat label="basis" value={d?.aggregate?.basisBps != null ? `${d.aggregate.basisBps.toFixed(2)} bp` : '—'} tone={(d?.aggregate?.basisBps ?? 0) >= 0 ? 'pos' : 'neg'} />
      <Stat label="obi ±10bp" value={a?.depth ? a.depth.obi10.toFixed(2) : '—'} tone={(a?.depth?.obi10 ?? 0) >= 0 ? 'pos' : 'neg'} title="(bid − ask liquidity) ÷ total, ±10 bp" />
      <Stat label="vol z" value={a?.volumeZ != null ? `${a.volumeZ.toFixed(1)}σ` : '—'} tone={Math.abs(a?.volumeZ ?? 0) >= 2 ? 'warn' : undefined} />
      <Stat label="rv 5m ann" value={a?.realizedVolAnnPct != null ? `${a.realizedVolAnnPct.toFixed(1)}%` : '—'} />
      <Stat label="depth ±25bp" value={fmtUsd(a ? (a.depth?.bid25 ?? 0) + (a.depth?.ask25 ?? 0) : null)} />
    </div>
  );
}

// ── CVD strip ────────────────────────────────────────────────────────────────

export function CvdStrip({ store }: { store: OrderFlowStore | null }) {
  const a = store?.state?.analytics;
  const pts = a?.cvd ?? [];
  if (!pts.length) {
    return (
      <div className="flex h-[74px] items-center justify-center rounded-lg border border-zinc-800/70 bg-zinc-900/30 text-[10px] text-zinc-600">
        CVD — waiting for flow…
      </div>
    );
  }
  const values = pts.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 100;
  const h = 100;
  const path = pts
    .map((p, i) => `${(i / (pts.length - 1)) * w},${h - ((p.value - min) / range) * h}`)
    .join(' ');
  const up = (values[values.length - 1] ?? 0) >= (values[0] ?? 0);
  return (
    <div className="flex h-[74px] items-stretch gap-2 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-2 py-1">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full min-w-0 flex-1">
        <polyline
          points={path}
          fill="none"
          stroke={up ? '#34d399' : '#fb7185'}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex shrink-0 flex-col justify-center gap-0.5 border-l border-zinc-800/60 pl-2">
        <span className="text-[8px] uppercase tracking-[0.14em] text-zinc-600">session cvd</span>
        <span className={`font-mono text-[11px] font-semibold ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
          {fmtQty(values[values.length - 1])}
        </span>
        <span className="font-mono text-[9px] text-zinc-500">1m {fmtQty(a?.cvd1m)}</span>
      </div>
    </div>
  );
}

// ── liquidations mini chart ──────────────────────────────────────────────────

export function LiquidationMiniChart({ store }: { store: OrderFlowStore | null }) {
  const buckets = store?.liqBuckets() ?? [];
  if (!buckets.length) {
    return (
      <div className="flex h-[74px] items-center justify-center rounded-lg border border-zinc-800/70 bg-zinc-900/30 text-[10px] text-zinc-600">
        liquidations — quiet
      </div>
    );
  }
  const max = Math.max(...buckets.map((b) => Math.max(b.longNotional, b.shortNotional)), 1);
  const bars = buckets.slice(-30);
  const bw = 100 / bars.length;
  return (
    <div className="flex h-[74px] flex-col gap-1 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-2 py-1">
      <div className="flex items-center justify-between">
        <span className="text-[8px] uppercase tracking-[0.14em] text-zinc-600">liquidations · 1m buckets</span>
        <span className="flex items-center gap-1 font-mono text-[9px]">
          <span className="text-rose-400">L {fmtUsd(bars.reduce((a, b) => a + b.longNotional, 0))}</span>
          <span className="text-emerald-400">S {fmtUsd(bars.reduce((a, b) => a + b.shortNotional, 0))}</span>
        </span>
      </div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full">
        {bars.map((b, i) => {
          const x = i * bw + bw * 0.15;
          const w = bw * 0.7;
          const lh = (b.longNotional / max) * 18;
          const sh = (b.shortNotional / max) * 18;
          return (
            <g key={b.time}>
              <rect x={x} y={18 - lh} width={w} height={lh} fill="#f43f5e" opacity={0.75} />
              <rect x={x} y={20} width={w} height={sh} fill="#10b981" opacity={0.75} />
            </g>
          );
        })}
        <line x1="0" y1="19.5" x2="100" y2="19.5" stroke="#3f4a5a" strokeWidth="0.3" />
      </svg>
    </div>
  );
}

// ── tape ─────────────────────────────────────────────────────────────────────

export function TapePanel({
  store,
  venueFilter,
  onPrintClick,
}: {
  store: OrderFlowStore | null;
  venueFilter: OfVenueId | 'all';
  onPrintClick: (id: string) => void;
}) {
  const [minNotional, setMinNotional] = useState(0);
  const [bigOnly, setBigOnly] = useState(false);
  const [liqOnly, setLiqOnly] = useState(false);
  const st = store?.state;
  const notifyCount = store?.notifyCount ?? 0;

  const rows = useMemo(() => {
    if (!st) return [] as Array<{ kind: 'trade' | 'liq'; ts: number; data: unknown }>;
    const S = st;
    const prints = S.prints
      .filter((p) => (venueFilter === 'all' ? true : p.venue === venueFilter))
      .filter((p) => p.quoteVolume >= minNotional)
      .filter((p) => (bigOnly ? (p.ratio ?? 0) >= 5 : true));
    const liqs = liqOnly || !bigOnly ? S.liqs.filter((l) => (venueFilter === 'all' ? true : l.venue === venueFilter)) : [];
    const merged: Array<{ kind: 'trade' | 'liq'; ts: number; data: unknown }> = [
      ...prints.map((p) => ({ kind: 'trade' as const, ts: p.timestamp, data: p })),
      ...(liqOnly ? liqs.map((l) => ({ kind: 'liq' as const, ts: l.timestamp, data: l })) : []),
    ];
    if (!liqOnly && !bigOnly) {
      merged.push(...liqs.map((l) => ({ kind: 'liq' as const, ts: l.timestamp, data: l })));
    }
    merged.sort((a, b) => b.ts - a.ts);
    return merged.slice(0, 80);
    // notifyCount re-runs the memo when mutable state changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, notifyCount, venueFilter, minNotional, bigOnly, liqOnly]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800/60 px-2 py-1.5">
        <select
          value={minNotional}
          onChange={(e) => setMinNotional(Number(e.target.value))}
          className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-300"
          title="minimum notional filter"
        >
          <option value={0}>all sizes</option>
          <option value={5_000}>≥ $5K</option>
          <option value={25_000}>≥ $25K</option>
          <option value={100_000}>≥ $100K</option>
          <option value={500_000}>≥ $500K</option>
        </select>
        <button
          onClick={() => setBigOnly((v) => !v)}
          className={`rounded px-1.5 py-0.5 text-[9px] font-semibold transition ${bigOnly ? 'bg-amber-950/60 text-amber-300 ring-1 ring-amber-500/40' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
          title="prints ≥ 5× the session average"
        >
          big ×5
        </button>
        <button
          onClick={() => setLiqOnly((v) => !v)}
          className={`rounded px-1.5 py-0.5 text-[9px] font-semibold transition ${liqOnly ? 'bg-rose-950/60 text-rose-300 ring-1 ring-rose-500/40' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
          title="liquidations only"
        >
          LIQ only
        </button>
        <span className="ml-auto font-mono text-[8px] text-zinc-600">{rows.length} rows</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse">
          <tbody>
            {rows.map((row) => {
              if (row.kind === 'liq') {
                const l = row.data as { id: string; venue: string; side: string; price: number; quantity: number; quoteVolume: number; timestamp: number };
                const isLong = l.side === 'long';
                return (
                  <tr key={l.id} className="border-b border-zinc-900/80 bg-rose-950/10 hover:bg-rose-950/25">
                    <td className="px-1.5 py-0.5 font-mono text-[8.5px] text-zinc-500">{fmtTime(l.timestamp)}</td>
                    <td className="px-1 py-0.5"><span className="h-1.5 w-1.5 rounded-full" style={{ background: venueColor(l.venue) }} /></td>
                    <td className="px-1 py-0.5 font-mono text-[9px] font-bold text-rose-400">LIQ {isLong ? 'L' : 'S'}</td>
                    <td className="px-1 py-0.5 font-mono text-[9px] text-zinc-300">{l.price.toFixed(l.price > 5000 ? 0 : 2)}</td>
                    <td className="px-1 py-0.5 font-mono text-[9px] text-zinc-400">{l.quantity.toFixed(3)}</td>
                    <td className="px-1 py-0.5 font-mono text-[9px] font-bold text-rose-300">{fmtUsd(l.quoteVolume)}</td>
                    <td className="px-1 py-0.5 font-mono text-[8px] text-zinc-600">{l.venue}</td>
                  </tr>
                );
              }
              const p = row.data as { id: string; venue: string; side: 'buy' | 'sell'; price: number; quantity: number; quoteVolume: number; timestamp: number; ratio?: number; bookSize?: number };
              const buy = p.side === 'buy';
              const big = (p.ratio ?? 0) >= 5;
              return (
                <tr
                  key={`${p.venue}-${p.id}`}
                  onClick={() => onPrintClick(p.id)}
                  className={`cursor-pointer border-b border-zinc-900/80 hover:bg-zinc-900/70 ${big ? 'bg-amber-950/10' : ''}`}
                  title="click for full order detail"
                >
                  <td className="px-1.5 py-0.5 font-mono text-[8.5px] text-zinc-500">{fmtTime(p.timestamp)}</td>
                  <td className="px-1 py-0.5"><span className="h-1.5 w-1.5 rounded-full" style={{ background: venueColor(p.venue) }} /></td>
                  <td className="px-1 py-0.5">
                    {buy ? <ArrowUpRight className="h-3 w-3 text-emerald-400" /> : <ArrowDownRight className="h-3 w-3 text-rose-400" />}
                  </td>
                  <td className={`px-1 py-0.5 font-mono text-[9px] ${buy ? 'text-emerald-300' : 'text-rose-300'}`}>{p.price.toFixed(p.price > 5000 ? 1 : 2)}</td>
                  <td className="px-1 py-0.5 font-mono text-[9px] text-zinc-400">{p.quantity.toFixed(4)}</td>
                  <td className={`px-1 py-0.5 font-mono text-[9px] ${big ? 'font-bold text-amber-300' : 'text-zinc-300'}`}>{fmtUsd(p.quoteVolume)}</td>
                  <td className="px-1 py-0.5 font-mono text-[8px] text-zinc-600">
                    {p.ratio ? `${p.ratio.toFixed(1)}×` : ''}
                    {p.bookSize !== undefined && p.quantity > p.bookSize * 1.5 ? ' ⚠' : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="px-2 py-4 text-center text-[9px] text-zinc-600">no prints match the filter</p>}
      </div>
    </div>
  );
}

// ── order book ladder ────────────────────────────────────────────────────────

export function BookPanel({ store }: { store: OrderFlowStore | null }) {
  const st = store?.state;
  const book = st?.book?.merged;
  const perVenue = st?.book?.perVenue ?? {};
  const obi = st?.analytics?.depth?.obi10 ?? 0;
  const obiHist = st?.analytics?.obi ?? [];
  const tick = st?.tick || 0.01;
  if (!book || !book.bids.length || !book.asks.length) {
    return <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">book warming up…</div>;
  }
  const maxSz = Math.max(...book.bids.slice(0, 12).map((l) => l.size), ...book.asks.slice(0, 12).map((l) => l.size), 1);
  const micro = (() => {
    const b = book.bids[0];
    const a = book.asks[0];
    const denom = b.size + a.size;
    return denom > 0 ? (b.price * a.size + a.price * b.size) / denom : (b.price + a.price) / 2;
  })();
  const asks = book.asks.slice(0, 10).reverse();
  const bids = book.bids.slice(0, 10);
  const obiPath = obiHist
    .map((p, i) => `${(i / Math.max(1, obiHist.length - 1)) * 100},${50 - p.value * 45}`)
    .join(' ');

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 px-2 py-1.5">
      <div className="flex items-center justify-between font-mono text-[9px]">
        <span className="text-zinc-600">spread {book.spreadBps.toFixed(2)} bp</span>
        <span className="text-teal-300">micro {micro.toFixed(tick < 1 ? 2 : 1)}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {asks.map((l) => (
          <div key={`a${l.price}`} className="relative flex items-center justify-between px-1 py-[1.5px] font-mono text-[9.5px]">
            <div className="absolute inset-y-0 right-0 bg-rose-500/15" style={{ width: `${(l.size / maxSz) * 100}%` }} />
            <span className="relative text-rose-300">{l.price.toFixed(tick < 1 ? 2 : 0)}</span>
            <span className="relative text-zinc-400">{l.size.toFixed(3)}</span>
          </div>
        ))}
        <div className="my-0.5 border-y border-zinc-800/80 bg-zinc-900/60 py-0.5 text-center font-mono text-[9px] text-zinc-400">
          mid {((book.bids[0].price + book.asks[0].price) / 2).toFixed(tick < 1 ? 2 : 1)}
        </div>
        {bids.map((l) => (
          <div key={`b${l.price}`} className="relative flex items-center justify-between px-1 py-[1.5px] font-mono text-[9.5px]">
            <div className="absolute inset-y-0 right-0 bg-emerald-500/15" style={{ width: `${(l.size / maxSz) * 100}%` }} />
            <span className="relative text-emerald-300">{l.price.toFixed(tick < 1 ? 2 : 0)}</span>
            <span className="relative text-zinc-400">{l.size.toFixed(3)}</span>
          </div>
        ))}
      </div>
      <div className="shrink-0 space-y-1 border-t border-zinc-800/60 pt-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] uppercase tracking-[0.14em] text-zinc-600">obi</span>
          <div className="relative h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
            <div className={`absolute inset-y-0 left-1/2 w-[1px] bg-zinc-600`} />
            <div
              className={`absolute inset-y-0 ${obi >= 0 ? 'left-1/2 bg-emerald-500' : 'right-1/2 bg-rose-500'}`}
              style={{ width: `${Math.min(50, Math.abs(obi) * 50)}%` }}
            />
          </div>
          <span className={`font-mono text-[9px] ${obi >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{obi.toFixed(2)}</span>
        </div>
        {obiHist.length > 2 && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-6 w-full">
            <polyline points={obiPath} fill="none" stroke="#2dd4bf" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[8.5px]">
          {Object.entries(perVenue).map(([v, b]) => (
            <div key={v} className="flex items-center justify-between gap-1">
              <span className="h-1 w-1 rounded-full" style={{ background: venueColor(v) }} />
              <span className="text-zinc-500">{v}</span>
              <span className="text-zinc-400">{b ? `${b.bid.toFixed(0)}/${b.ask.toFixed(0)}` : '—'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── venues comparison ────────────────────────────────────────────────────────

export function VenuesPanel({ store }: { store: OrderFlowStore | null }) {
  const st = store?.state;
  const stats = st?.venues.stats ?? [];
  const leader = st?.venues.leader;
  const connections = st?.connections ?? [];
  const statusOf = (v: string) => connections.find((c) => c.venue === v)?.status ?? '—';
  if (!stats.length) {
    return <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">waiting for venue flow…</div>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col px-2 py-1.5">
      {leader && (
        <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-teal-500/25 bg-teal-950/30 px-2 py-1">
          <Waves className="h-3 w-3 text-teal-400" />
          <span className="text-[9px] text-teal-200">
            <span className="font-bold uppercase">{leader.venue}</span> leads — its price moves first (+
            {leader.leadMs}ms, corr {leader.leadCorr?.toFixed(2)})
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-[9.5px]">
          <thead>
            <tr className="border-b border-zinc-800/70 text-[8px] uppercase tracking-wider text-zinc-600">
              <th className="py-1 text-left font-medium">venue</th>
              <th className="py-1 text-right font-medium">last</th>
              <th className="py-1 text-right font-medium" title="vs median venue">prem bp</th>
              <th className="py-1 text-right font-medium" title="share of last minute volume">share</th>
              <th className="py-1 text-right font-medium">1m delta</th>
              <th className="py-1 text-right font-medium" title="price leads the other venues by this much">lead</th>
              <th className="py-1 text-center font-medium">feed</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {stats.map((s) => (
              <tr key={s.venue} className={`border-b border-zinc-900/80 ${leader && s.venue === leader.venue ? 'bg-teal-950/20' : ''}`}>
                <td className="py-1">
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: venueColor(s.venue) }} />
                    <span className="text-zinc-300">{s.venue}</span>
                  </span>
                </td>
                <td className="py-1 text-right text-zinc-200">{s.last.toFixed(s.last > 5000 ? 0 : 2)}</td>
                <td className={`py-1 text-right ${s.premiumBps >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{s.premiumBps.toFixed(1)}</td>
                <td className="py-1 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <div className="h-1 w-8 overflow-hidden rounded bg-zinc-800">
                      <div className="h-full bg-zinc-400" style={{ width: `${Math.min(100, s.share * 100)}%` }} />
                    </div>
                    <span className="text-zinc-400">{(s.share * 100).toFixed(0)}%</span>
                  </div>
                </td>
                <td className={`py-1 text-right ${s.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{s.delta.toFixed(1)}</td>
                <td className="py-1 text-right text-zinc-400">{s.leadMs !== null ? `${s.leadMs > 0 ? '+' : ''}${s.leadMs}ms` : '—'}</td>
                <td className="py-1 text-center">
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      statusOf(s.venue) === 'live' ? 'bg-emerald-400' : statusOf(s.venue) === 'connecting' ? 'bg-amber-400' : 'bg-zinc-600'
                    }`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── open interest & funding ──────────────────────────────────────────────────

export function DerivativesPanel({ store }: { store: OrderFlowStore | null }) {
  const st = store?.state;
  const d = st?.deriv;
  const oi = d?.oiSeries ?? [];
  const windows = d?.windows ?? {};
  const tick = st?.tick || 0.01;
  const oiPath = oi.length
    ? oi
        .map((p, i) => `${(i / Math.max(1, oi.length - 1)) * 100},${100 - ((p.openInterest - Math.min(...oi.map((q) => q.openInterest))) / (Math.max(...oi.map((q) => q.openInterest)) - Math.min(...oi.map((q) => q.openInterest)) || 1)) * 90}`)
        .join(' ')
    : '';
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 px-2 py-1.5">
      <div className="grid grid-cols-3 gap-1">
        {(['w1m', 'w5m', 'w15m'] as const).map((k) => {
          const w = windows[k];
          const regime = w?.regime ?? 'neutral';
          const label = OI_REGIME_LABEL[regime as keyof typeof OI_REGIME_LABEL] ?? regime;
          const tone =
            regime === 'new-longs' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20'
            : regime === 'new-shorts' ? 'text-rose-400 border-rose-500/30 bg-rose-950/20'
            : regime === 'short-covering' ? 'text-amber-400 border-amber-500/30 bg-amber-950/20'
            : regime === 'long-unwind' ? 'text-rose-400 border-rose-500/30 bg-rose-950/20'
            : 'text-zinc-400 border-zinc-800 bg-zinc-900/40';
          return (
            <div key={k} className={`rounded border px-1.5 py-1 ${tone}`} title={OI_REGIME_HINT[regime as keyof typeof OI_REGIME_HINT] ?? ''}>
              <p className="text-[7.5px] uppercase tracking-[0.14em] opacity-70">{k.slice(1)} regime</p>
              <p className="font-mono text-[9px] font-semibold">{label}</p>
              <p className="font-mono text-[7.5px] opacity-60">
                {w ? `Δoi ${fmtPct(w.oiChange * 100, 2)} · Δpx ${fmtPct(w.priceChange * 100, 2)}` : '—'}
              </p>
            </div>
          );
        })}
      </div>
      <div className="rounded-md border border-zinc-800/70 bg-zinc-900/30 p-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[8px] uppercase tracking-[0.14em] text-zinc-600">open interest (base)</span>
          <span className="font-mono text-[10px] font-semibold text-zinc-200">
            {fmtQty(d?.aggregate?.openInterest)} <span className="text-[8px] text-zinc-500">≈ {fmtUsd(d?.aggregate?.openInterestValue)}</span>
          </span>
        </div>
        {oi.length > 1 && (
          <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="mt-0.5 h-10 w-full">
            <polyline points={oiPath} fill="none" stroke="#fbbf24" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-[9.5px]">
          <thead>
            <tr className="border-b border-zinc-800/70 text-[8px] uppercase tracking-wider text-zinc-600">
              <th className="py-1 text-left font-medium">venue</th>
              <th className="py-1 text-right font-medium">oi</th>
              <th className="py-1 text-right font-medium">funding</th>
              <th className="py-1 text-right font-medium" title="restated to an 8-hour interval">8h</th>
              <th className="py-1 text-right font-medium" title="annualized">ann</th>
              <th className="py-1 text-right font-medium">basis</th>
              <th className="py-1 text-right font-medium" title="time to next settlement">next</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {(d?.perVenue ?? []).map((v) => {
              const next = v.nextFundingTime ? Math.max(0, (v.nextFundingTime - Date.now()) / 3_600_000) : null;
              return (
                <tr key={v.venue} className="border-b border-zinc-900/80">
                  <td className="py-1">
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: venueColor(v.venue) }} />
                      <span className="text-zinc-300">{v.venue}</span>
                    </span>
                  </td>
                  <td className="py-1 text-right text-zinc-200">{fmtQty(v.openInterest)}</td>
                  <td className={`py-1 text-right ${(v.fundingRate ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {v.fundingRate !== undefined ? `${(v.fundingRate * 100).toFixed(4)}%` : '—'}
                  </td>
                  <td className="py-1 text-right text-zinc-400">{v.fundingRate8h !== undefined ? `${(v.fundingRate8h * 100).toFixed(4)}%` : '—'}</td>
                  <td className={`py-1 text-right ${(v.fundingAnnualizedPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {v.fundingAnnualizedPct !== undefined ? `${v.fundingAnnualizedPct.toFixed(1)}%` : '—'}
                  </td>
                  <td className={`py-1 text-right ${(v.basisBps ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {v.basisBps !== undefined ? `${v.basisBps.toFixed(2)}bp` : '—'}
                  </td>
                  <td className="py-1 text-right text-zinc-400">{next !== null ? `${next.toFixed(1)}h` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {d?.aggregate && (
        <div className="shrink-0 border-t border-zinc-800/60 pt-1 font-mono text-[8.5px] text-zinc-500">
          mark {fmtPrice(d.aggregate.markPrice, tick)} · index {fmtPrice(d.aggregate.indexPrice, tick)} · weighted basis{' '}
          {d.aggregate.basisBps !== null ? `${d.aggregate.basisBps.toFixed(2)} bp` : '—'}
        </div>
      )}
    </div>
  );
}

// ── alerts ───────────────────────────────────────────────────────────────────

export function AlertsPanel({
  store,
  settings,
  onSettings,
}: {
  store: OrderFlowStore | null;
  settings: OfAlertSettings;
  onSettings: (s: OfAlertSettings) => void;
}) {
  const alerts = store?.state?.alerts ?? [];
  const toggle = (key: keyof OfAlertSettings) => onSettings({ ...settings, [key]: !settings[key] });
  const chips: Array<{ key: keyof OfAlertSettings; label: string; on: boolean }> = [
    { key: 'vwapCross', label: 'VWAP cross', on: settings.vwapCross },
    { key: 'valueAreaEdge', label: 'VA edge', on: settings.valueAreaEdge },
    { key: 'cvdDivergence', label: 'CVD div', on: settings.cvdDivergence },
    { key: 'absorption', label: 'Absorption', on: settings.absorption },
    { key: 'iceberg', label: 'Iceberg', on: settings.iceberg },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col px-2 py-1.5">
      <div className="flex flex-wrap gap-1 border-b border-zinc-800/60 pb-1.5">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => toggle(c.key)}
            className={`rounded px-1.5 py-0.5 text-[8.5px] font-semibold transition ${
              c.on ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/40' : 'bg-zinc-900 text-zinc-600 hover:text-zinc-300'
            }`}
          >
            {c.label}
          </button>
        ))}
        <span className="flex items-center gap-1 rounded bg-zinc-900 px-1.5 py-0.5 text-[8.5px] text-zinc-500" title="volume-spike σ threshold">
          spike σ
          <select
            value={settings.volumeSpike}
            onChange={(e) => onSettings({ ...settings, volumeSpike: Number(e.target.value) })}
            className="bg-zinc-900 font-mono text-[8.5px] text-zinc-300"
          >
            <option value={0}>off</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </span>
        <span className="flex items-center gap-1 rounded bg-zinc-900 px-1.5 py-0.5 text-[8.5px] text-zinc-500" title="large-liquidation threshold">
          liq $
          <select
            value={settings.largeLiquidation}
            onChange={(e) => onSettings({ ...settings, largeLiquidation: Number(e.target.value) })}
            className="bg-zinc-900 font-mono text-[8.5px] text-zinc-300"
          >
            <option value={0}>off</option>
            <option value={100_000}>100K</option>
            <option value={250_000}>250K</option>
            <option value={1_000_000}>1M</option>
          </select>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        {!alerts.length && (
          <p className="flex items-center justify-center gap-1.5 py-4 text-[9px] text-zinc-600">
            <Bell className="h-3 w-3" /> no alerts yet — rules armed
          </p>
        )}
        {alerts
          .slice()
          .reverse()
          .map((a) => (
            <div
              key={a.id}
              className={`mb-1 rounded border px-1.5 py-1 ${
                a.severity === 'critical'
                  ? 'border-rose-500/40 bg-rose-950/20'
                  : a.severity === 'warn'
                    ? 'border-amber-500/30 bg-amber-950/10'
                    : 'border-teal-500/30 bg-teal-950/10'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[9.5px] font-semibold ${a.severity === 'critical' ? 'text-rose-300' : a.severity === 'warn' ? 'text-amber-200' : 'text-teal-200'}`}>
                  {a.severity === 'critical' ? <ShieldAlert className="mr-1 inline h-3 w-3" /> : null}
                  {a.title}
                </span>
                <span className="shrink-0 font-mono text-[8px] text-zinc-600">{fmtTime(a.tsMs)}</span>
              </div>
              {a.detail && <p className="mt-0.5 text-[8.5px] leading-snug text-zinc-500">{a.detail}</p>}
            </div>
          ))}
      </div>
    </div>
  );
}

// ── microstructure markers list ──────────────────────────────────────────────

export function MarkersPanel({ store }: { store: OrderFlowStore | null }) {
  const micro = store?.state?.micro ?? [];
  const tick = store?.state?.tick || 0.01;
  return (
    <div className="flex h-full min-h-0 flex-col px-2 py-1.5">
      {!micro.length && (
        <p className="flex items-center justify-center gap-1.5 py-4 text-[9px] text-zinc-600">
          <Diamond className="h-3 w-3" /> no absorption / iceberg markers yet
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {micro
          .slice()
          .reverse()
          .map((m) => (
            <div
              key={m.id}
              className={`mb-1 flex items-center gap-2 rounded border px-1.5 py-1 ${
                m.kind === 'iceberg' ? 'border-sky-500/30 bg-sky-950/10' : m.side === 'bid' ? 'border-emerald-500/25 bg-emerald-950/10' : 'border-rose-500/25 bg-rose-950/10'
              }`}
              title={m.kind === 'absorption' ? 'heavy aggressive volume at one price that failed to move price through it' : 'a level that kept refilling after more than its displayed size traded'}
            >
              <span className={`font-mono text-[8px] font-bold ${m.kind === 'iceberg' ? 'text-sky-300' : 'text-zinc-400'}`}>
                {m.kind === 'iceberg' ? 'ICE' : 'ABS'}
              </span>
              <span className="font-mono text-[9.5px] text-zinc-200">{m.price.toFixed(tick < 1 ? 2 : 0)}</span>
              <span className={`flex items-center gap-0.5 text-[8px] ${m.side === 'bid' ? 'text-emerald-400' : 'text-rose-400'}`}>
                {m.side === 'bid' ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
                {m.side}
              </span>
              <span className="ml-auto font-mono text-[8.5px] text-zinc-500">
                {fmtQty(m.volume)} · {m.ratio.toFixed(1)}× · {fmtUsd(m.notional)}{m.venue ? ` · ${m.venue}` : ''}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

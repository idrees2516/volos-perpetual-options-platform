'use client';

// Strategy Library — browse / search / filter the 118-strategy catalog
// (1..=25 legs). Any strategy resolves against live spot and loads straight
// into the builder, the RFQ desk, or the CLOB trade ticket.

import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  CATEGORY_META,
  MAX_LEGS,
  STRATEGIES,
  VIEW_META,
  complexityStars,
  histogramBuckets,
  resolveStrategyLegs,
  type StrategyCategory,
  type StrategySpec,
  type StrategyView,
} from '@/lib/strategies';
import type { Leg, LegKind } from '@/lib/types';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { fmtNum } from '@/lib/format';
import {
  Search, Layers, TrendingUp, TrendingDown, ArrowLeftRight, Shield,
  Banknote, Infinity as InfinityIcon, Network, Zap, Send, Split, Star, Timer,
} from 'lucide-react';

const CATEGORY_ICONS: Record<StrategyCategory, React.ReactNode> = {
  direction: <TrendingUp className="h-3.5 w-3.5" />,
  income: <Banknote className="h-3.5 w-3.5" />,
  volatility: <Zap className="h-3.5 w-3.5" />,
  protection: <Shield className="h-3.5 w-3.5" />,
  spread: <Split className="h-3.5 w-3.5" />,
  perpetual: <InfinityIcon className="h-3.5 w-3.5" />,
  multileg: <Network className="h-3.5 w-3.5" />,
  '0dte': <Timer className="h-3.5 w-3.5" />,
};

const KIND_CHIP: Record<LegKind, string> = {
  call: 'C',
  put: 'P',
  perp_option: '∞',
  perp: 'F',
  spot: 'S',
};

const LEG_BUCKETS = [
  { id: 'all', label: 'Any', min: 1, max: 25 },
  { id: '1-2', label: '1–2 legs', min: 1, max: 2 },
  { id: '3-4', label: '3–4', min: 3, max: 4 },
  { id: '5-7', label: '5–7', min: 5, max: 7 },
  { id: '8-12', label: '8–12', min: 8, max: 12 },
  { id: '13-19', label: '13–19', min: 13, max: 19 },
  { id: '20-25', label: '20–25', min: 20, max: 25 },
];

interface LibraryProps {
  onOpenBuilder: () => void;
  onOpenTrade: () => void;
}

export function StrategyLibraryView({ onOpenBuilder, onOpenTrade }: LibraryProps) {
  const { market } = useMarket();
  const { underlying, loadStrategy } = useStrategy();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<StrategyCategory | 'all'>('all');
  const [view, setView] = useState<StrategyView | 'all'>('all');
  const [bucket, setBucket] = useState('all');
  const [preview, setPreview] = useState<StrategySpec | null>(null);

  const spot = market.assets[underlying]?.spot ?? 65000;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const b = LEG_BUCKETS.find((x) => x.id === bucket) ?? LEG_BUCKETS[0];
    return STRATEGIES.filter((s) => {
      if (category !== 'all' && s.category !== category) return false;
      if (view !== 'all' && s.view !== view) return false;
      const n = s.legs.length;
      if (n < b.min || n > b.max) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.id.includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.includes(q))
      );
    });
  }, [query, category, view, bucket]);

  const byCategory = useMemo(() => {
    const m = new Map<StrategyCategory, number>();
    for (const s of STRATEGIES) m.set(s.category, (m.get(s.category) ?? 0) + 1);
    return m;
  }, []);

  const handleLoad = (spec: StrategySpec, where: 'builder' | 'trade') => {
    const legs = resolveStrategyLegs(spec, spot);
    loadStrategy(spec.name, legs);
    if (where === 'builder') onOpenBuilder();
    else onOpenTrade();
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-teal-400" />
          <div>
            <h2 className="text-sm font-bold tracking-tight text-zinc-100">Strategy Library</h2>
            <p className="text-[9px] uppercase tracking-[0.16em] text-zinc-500">
              {STRATEGIES.length} structures · up to {MAX_LEGS} legs · resolves on {underlying} @ {fmtNum(spot, 0)}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {histogramBuckets()
            .slice(3)
            .map((b) => (
              <div key={b.label} className="rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1 text-center">
                <p className="font-mono text-xs font-semibold text-teal-300">{b.count}</p>
                <p className="text-[8px] uppercase tracking-wide text-zinc-500">{b.label} legs</p>
              </div>
            ))}
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 118 strategies — iron condor, zebra, backspread, everlasting…"
              className="h-8 border-zinc-800 bg-zinc-950 pl-8 text-xs"
            />
          </div>
          <div className="flex items-center gap-1">
            {(['all', 'bullish', 'bearish', 'neutral', 'volatile', 'low-vol'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-2 py-1 text-[10px] font-medium capitalize transition ${
                  view === v
                    ? 'bg-zinc-800 text-zinc-100 ring-1 ring-zinc-600'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {v === 'all' ? 'Any view' : v === 'low-vol' ? 'low vol' : v}
              </button>
            ))}
          </div>
          <select
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            className="h-8 cursor-pointer rounded-md border border-zinc-800 bg-zinc-950 px-2 text-[10px] text-zinc-300 [&>option]:bg-zinc-950"
          >
            {LEG_BUCKETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={() => setCategory('all')}
            className={`rounded-md px-2 py-1 text-[10px] font-medium transition ${
              category === 'all' ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            All families · {STRATEGIES.length}
          </button>
          {(Object.keys(CATEGORY_META) as StrategyCategory[]).map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              title={CATEGORY_META[cat].hint}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition ${
                category === cat
                  ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {CATEGORY_ICONS[cat]}
              {CATEGORY_META[cat].label}
              <span className="font-mono text-[9px] text-zinc-600">{byCategory.get(cat)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((s) => (
            <StrategyCard
              key={s.id}
              spec={s}
              onPreview={() => setPreview(s)}
              onLoadBuilder={() => handleLoad(s, 'builder')}
              onLoadTrade={() => handleLoad(s, 'trade')}
            />
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
            <Search className="h-5 w-5 text-zinc-600" />
            <p className="text-xs text-zinc-500">No strategies match those filters.</p>
          </div>
        )}
      </div>

      {/* Preview drawer */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPreview(null)}>
          <div
            className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-zinc-100">{preview.name}</h3>
                <p className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
                  <span>{CATEGORY_META[preview.category].label}</span>
                  <span>·</span>
                  <span className={VIEW_META[preview.view].color}>{VIEW_META[preview.view].label}</span>
                  <span>·</span>
                  <span className="font-mono">{preview.legs.length} legs</span>
                  <span>·</span>
                  <span className="font-mono text-teal-400/80">{complexityStars(preview.complexity)}</span>
                </p>
              </div>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-zinc-400" onClick={() => setPreview(null)}>
                ✕
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-400">{preview.description}</p>
            <div className="mt-4 space-y-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                Legs (resolved on {underlying} @ {fmtNum(spot, 0)})
              </p>
              {resolveStrategyLegs(preview, spot).map((leg) => (
                <LegPreviewRow key={leg.id} leg={leg} />
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {preview.tags.map((t) => (
                <span key={t} className="rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[9px] text-zinc-400">
                  {t}
                </span>
              ))}
            </div>
            <div className="mt-5 flex gap-2">
              <Button
                size="sm"
                className="h-8 flex-1 bg-teal-500 text-zinc-950 hover:bg-teal-400"
                onClick={() => {
                  handleLoad(preview, 'builder');
                  setPreview(null);
                }}
              >
                <Star className="mr-1.5 h-3.5 w-3.5" /> Load into Builder
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 flex-1 border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                onClick={() => {
                  handleLoad(preview, 'trade');
                  setPreview(null);
                }}
              >
                <Send className="mr-1.5 h-3.5 w-3.5" /> Send to RFQ / Trading
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StrategyCard({
  spec,
  onPreview,
  onLoadBuilder,
  onLoadTrade,
}: {
  spec: StrategySpec;
  onPreview: () => void;
  onLoadBuilder: () => void;
  onLoadTrade: () => void;
}) {
  return (
    <div className="group flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 transition hover:border-teal-500/40 hover:bg-zinc-900/70">
      <div className="flex items-start justify-between gap-2">
        <button onClick={onPreview} className="min-w-0 flex-1 text-left">
          <h3 className="truncate text-xs font-semibold text-zinc-100 group-hover:text-teal-200">{spec.name}</h3>
          <p className="mt-0.5 flex items-center gap-1.5 text-[9px] text-zinc-500">
            <span className="flex items-center gap-1">{CATEGORY_ICONS[spec.category]}{CATEGORY_META[spec.category].label}</span>
            <span>·</span>
            <span className={VIEW_META[spec.view].color}>{VIEW_META[spec.view].label}</span>
          </p>
        </button>
        <span
          className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[9px] tabular-nums ${
            spec.legs.length >= 20
              ? 'bg-fuchsia-950/50 text-fuchsia-300 ring-1 ring-fuchsia-500/30'
              : spec.legs.length >= 8
                ? 'bg-sky-950/50 text-sky-300 ring-1 ring-sky-500/30'
                : 'bg-zinc-800/80 text-zinc-400'
          }`}
        >
          {spec.legs.length}L
        </span>
      </div>

      <p className="line-clamp-2 text-[10px] leading-relaxed text-zinc-500">{spec.description}</p>

      {/* Leg chips */}
      <div className="flex flex-wrap gap-1">
        {spec.legs.slice(0, 8).map((l, i) => (
          <span
            key={i}
            className={`rounded px-1 py-0.5 font-mono text-[8px] tabular-nums ${
              l.side === 'buy' ? 'bg-emerald-950/50 text-emerald-400/90' : 'bg-rose-950/50 text-rose-400/90'
            }`}
          >
            {KIND_CHIP[l.kind]}
            {l.strike !== undefined ? l.strike.toFixed(2) : ''}×{l.qty}
            {l.expiryDays ? ` ${l.expiryDays}d` : l.fundingPeriodDays ? ` τ${l.fundingPeriodDays}` : ''}
          </span>
        ))}
        {spec.legs.length > 8 && (
          <span className="rounded bg-zinc-800/80 px-1 py-0.5 font-mono text-[8px] text-zinc-400">
            +{spec.legs.length - 8} more
          </span>
        )}
      </div>

      <div className="mt-auto flex items-center gap-1.5 border-t border-zinc-800/70 pt-2">
        <span className="font-mono text-[8px] text-teal-400/70" title={`complexity ${spec.complexity}/5`}>
          {complexityStars(spec.complexity)}
        </span>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 border-zinc-700 bg-zinc-900 px-2 text-[9px] text-zinc-300 hover:bg-zinc-800"
            onClick={onLoadBuilder}
          >
            Builder
          </Button>
          <Button
            size="sm"
            className="h-6 bg-teal-500/90 px-2 text-[9px] text-zinc-950 hover:bg-teal-400"
            onClick={onLoadTrade}
          >
            Trade
          </Button>
        </div>
      </div>
    </div>
  );
}

function LegPreviewRow({ leg }: { leg: Leg }) {
  const label =
    leg.kind === 'call'
      ? `Call · ${leg.expiryDays}d`
      : leg.kind === 'put'
        ? `Put · ${leg.expiryDays}d`
        : leg.kind === 'perp_option'
          ? `Everlasting · τ${leg.fundingPeriodDays}d`
          : leg.kind === 'perp'
            ? 'Perpetual Future'
            : 'Spot';
  return (
    <div className="flex items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/50 px-2.5 py-1.5">
      <span
        className={`w-9 rounded px-1 text-center text-[9px] font-bold uppercase ${
          leg.side === 'buy' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'
        }`}
      >
        {leg.side}
      </span>
      <span className="text-[10px] text-zinc-300">{label}</span>
      {leg.strike !== undefined && (
        <span className="font-mono text-[10px] text-zinc-400">@ {fmtNum(leg.strike, leg.strike >= 1000 ? 0 : 2)}</span>
      )}
      <span className="ml-auto font-mono text-[10px] text-zinc-500">×{leg.qty}</span>
    </div>
  );
}

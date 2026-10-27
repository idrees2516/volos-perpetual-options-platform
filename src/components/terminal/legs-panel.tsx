'use client';

// Legs panel — add/remove/edit strategy legs of any kind, plus the ONE
// fused strategy catalog (all 131 strategies) as editable starting points.
// The old 26-template list is gone: creation shows ONLY the unified
// 131-strategy catalog, searchable and collapsible by category.

import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Plus, Trash2, Copy, LayoutTemplate, TrendingUp, TrendingDown,
  Waves, Shield, Infinity as InfinityIcon, Sparkles, Coins, Search,
  ChevronDown, ChevronRight, Layers, Zap, Split, Network, Timer, Banknote,
} from 'lucide-react';
import type { Leg, LegAnalytics, LegKind, StrategyAnalysis } from '@/lib/types';
import { kindLabel } from '@/lib/types';
import {
  CATEGORY_META, MAX_LEGS, STRATEGIES, resolveStrategyLegs,
  type StrategyCategory, type StrategySpec,
} from '@/lib/strategies';
import { useStrategy } from '@/stores/strategy-store';
import { fmtNum, fmtUsd } from '@/lib/format';

const EXPIRIES = [1, 7, 14, 30, 60, 90, 180, 365];
const FUNDING_PERIODS = [1, 3, 7, 14, 30];

const KIND_ICONS: Record<LegKind, React.ReactNode> = {
  call: <TrendingUp className="h-3.5 w-3.5" />,
  put: <TrendingDown className="h-3.5 w-3.5" />,
  perp_option: <InfinityIcon className="h-3.5 w-3.5" />,
  perp: <Waves className="h-3.5 w-3.5" />,
  spot: <Coins className="h-3.5 w-3.5" />,
};

const CATEGORY_ICONS: Record<StrategyCategory, React.ReactNode> = {
  direction: <TrendingUp className="h-3 w-3" />,
  income: <Banknote className="h-3 w-3" />,
  volatility: <Zap className="h-3 w-3" />,
  protection: <Shield className="h-3 w-3" />,
  spread: <Split className="h-3 w-3" />,
  perpetual: <InfinityIcon className="h-3 w-3" />,
  multileg: <Network className="h-3 w-3" />,
  '0dte': <Timer className="h-3 w-3" />,
};

interface LegsPanelProps {
  spot: number;
  analysis: StrategyAnalysis | null;
}

export function LegsPanel({ spot, analysis }: LegsPanelProps) {
  const {
    legs, size, addLeg, removeLeg, duplicateLeg, updateLeg, setSize, setLegs,
    setStrategyName, catalogId, loadCatalogStrategy,
  } = useStrategy();

  const legAnalyticsById = useMemo(() => {
    const m = new Map<string, LegAnalytics>();
    if (analysis) for (const a of analysis.legs) m.set(a.id, a);
    return m;
  }, [analysis]);

  const applyStrategy = (spec: StrategySpec) => {
    loadCatalogStrategy(spec.id, resolveStrategyLegs(spec, spot), spec.name);
  };

  const netPremium = analysis?.netPremium ?? 0;
  const atCap = legs.length >= MAX_LEGS;

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      {/* Header actions — the ONE fused catalog (131 strategies) */}
      <StrategyCatalogPicker
        spot={spot}
        currentId={catalogId}
        onPick={applyStrategy}
        setLegs={setLegs}
        setStrategyName={setStrategyName}
      />

      {/* Add leg buttons */}
      <div className="grid grid-cols-5 gap-1">
        {(['call', 'put', 'perp_option', 'perp', 'spot'] as LegKind[]).map((kind) => (
          <button
            key={kind}
            onClick={() => addLeg(kind, spot)}
            disabled={atCap}
            title={atCap ? `Maximum of ${MAX_LEGS} legs reached` : `Add ${kindLabel(kind)} leg`}
            className={`flex flex-col items-center gap-1 rounded-md border py-2 text-[9px] font-medium transition ${
              atCap
                ? 'cursor-not-allowed border-zinc-800/60 bg-zinc-900/30 text-zinc-600'
                : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-teal-500/50 hover:bg-teal-950/30 hover:text-teal-300'
            }`}
          >
            {KIND_ICONS[kind]}
            <span>{kind === 'perp_option' ? 'Everlast' : kind === 'perp' ? 'Perp' : kind === 'spot' ? 'Spot' : kind === 'call' ? 'Call' : 'Put'}</span>
          </button>
        ))}
      </div>

      {/* Legs list */}
      <div className="-mr-2 flex-1 space-y-2 overflow-y-auto pr-2">
        {legs.length === 0 && (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 p-4 text-center">
            <Sparkles className="h-5 w-5 text-zinc-600" />
            <p className="text-xs text-zinc-500">Pick a strategy or add legs.</p>
            <p className="max-w-52 text-[10px] leading-tight text-zinc-600">
              Start from any of the {STRATEGIES.length} catalog strategies — or mix dated
              options, everlasting options, perps and spot, up to {MAX_LEGS} legs.
            </p>
          </div>
        )}
        {legs.map((leg) => (
          <LegRow
            key={leg.id}
            leg={leg}
            analytics={legAnalyticsById.get(leg.id)}
            spot={spot}
            onChange={(patch) => updateLeg(leg.id, patch)}
            onRemove={() => removeLeg(leg.id)}
            onDuplicate={() => duplicateLeg(leg.id)}
          />
        ))}
      </div>

      {/* Footer: size + net premium */}
      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Position size</span>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={0.001}
              step={1}
              value={size}
              onChange={(e) => setSize(parseFloat(e.target.value) || 1)}
              className="h-7 w-20 border-zinc-800 bg-zinc-950 text-right font-mono text-xs"
            />
            <span className="text-[10px] text-zinc-500">×</span>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-zinc-800 pt-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            {netPremium >= 0 ? 'Net debit' : 'Net credit'}
          </span>
          <span className={`font-mono text-sm font-semibold ${netPremium >= 0 ? 'text-zinc-100' : 'text-emerald-400'}`}>
            {fmtUsd(Math.abs(netPremium))}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── The ONE catalog picker — all 131 strategies, collapsible categories ──────
function StrategyCatalogPicker({
  spot,
  currentId,
  onPick,
  setLegs,
  setStrategyName,
}: {
  spot: number;
  currentId: string;
  onPick: (spec: StrategySpec) => void;
  setLegs: (legs: Leg[]) => void;
  setStrategyName: (n: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const current = STRATEGIES.find((s) => s.id === currentId);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return STRATEGIES;
    return STRATEGIES.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.includes(q)),
    );
  }, [query]);

  const byCategory = useMemo(() => {
    const m = new Map<StrategyCategory, StrategySpec[]>();
    for (const s of filtered) {
      const arr = m.get(s.category) ?? [];
      arr.push(s);
      m.set(s.category, arr);
    }
    return m;
  }, [filtered]);

  const toggleCategory = (cat: string) =>
    setCollapsed((c) => ({ ...c, [cat]: !c[cat] }));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="Strategy Catalog — all 131 strategies, fused"
          className="h-8 w-full justify-start gap-2 border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-teal-400" />
          <span className="truncate">
            {current ? current.name : 'Strategy Catalog'}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="rounded bg-teal-950/50 px-1 py-0.5 font-mono text-[9px] text-teal-300">
              {STRATEGIES.length}
            </span>
            <ChevronDown className="h-3 w-3 text-zinc-500" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex h-[440px] w-[330px] flex-col gap-2 border-zinc-800 bg-zinc-950 p-2"
      >
        {/* header + search */}
        <div className="shrink-0 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 text-teal-400" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
              Strategy Catalog
            </span>
            <span className="ml-auto font-mono text-[9px] text-zinc-600">
              {filtered.length}/{STRATEGIES.length}
            </span>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search — iron condor, zebra, 0DTE…"
              className="h-7 border-zinc-800 bg-zinc-900 pl-8 text-xs"
            />
          </div>
          {/* expand / collapse all categories */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCollapsed({})}
              className="rounded px-1.5 py-0.5 text-[9px] font-medium text-zinc-500 transition hover:text-zinc-300"
            >
              expand all
            </button>
            <button
              onClick={() => {
                const all: Record<string, boolean> = {};
                for (const cat of Object.keys(CATEGORY_META)) all[cat] = true;
                setCollapsed(all);
              }}
              className="rounded px-1.5 py-0.5 text-[9px] font-medium text-zinc-500 transition hover:text-zinc-300"
            >
              collapse all
            </button>
            <span className="ml-auto text-[8px] uppercase tracking-wider text-zinc-600">
              one catalog · fused
            </span>
          </div>
        </div>

        {/* the 131 — grouped, collapsible */}
        <div className="-mr-1 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {(Object.keys(CATEGORY_META) as StrategyCategory[]).map((cat) => {
            const items = byCategory.get(cat);
            if (!items?.length) return null;
            const catCollapsed = collapsed[cat] === true;
            return (
              <div key={cat} className="rounded-md border border-zinc-800/70 bg-zinc-900/30">
                <button
                  onClick={() => toggleCategory(cat)}
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
                >
                  {catCollapsed ? (
                    <ChevronRight className="h-3 w-3 text-teal-400" />
                  ) : (
                    <ChevronDown className="h-3 w-3 text-teal-400" />
                  )}
                  <span className="text-teal-300/80">{CATEGORY_ICONS[cat]}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
                    {CATEGORY_META[cat].label}
                  </span>
                  <span className="ml-auto font-mono text-[9px] text-zinc-600">{items.length}</span>
                </button>
                {!catCollapsed && (
                  <div className="space-y-0.5 border-t border-zinc-800/60 p-1">
                    {items.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          onPick(s);
                          setOpen(false);
                        }}
                        title={s.description}
                        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition ${
                          currentId === s.id
                            ? 'bg-teal-950/40 text-teal-200 ring-1 ring-teal-500/30'
                            : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                        }`}
                      >
                        <span className="truncate text-[11px] font-medium">{s.name}</span>
                        <span className="ml-auto shrink-0 rounded bg-zinc-800/80 px-1 font-mono text-[8px] tabular-nums text-zinc-400">
                          {s.legs.length}L
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p className="py-6 text-center text-[10px] text-zinc-600">
              No strategies match “{query}”.
            </p>
          )}
        </div>

        {/* footer — blank start */}
        <div className="shrink-0 space-y-1.5 border-t border-zinc-800 pt-1.5">
          <button
            onClick={() => {
              setLegs([]);
              setStrategyName('Custom Strategy');
              setOpen(false);
            }}
            className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-zinc-700 px-2 py-1.5 text-left text-[10px] text-zinc-400 transition hover:border-teal-500/50 hover:text-teal-300"
          >
            <Plus className="h-3 w-3" />
            Start blank — build fully custom legs
          </button>
          <p className="text-[8px] leading-relaxed text-zinc-600">
            The legacy 26-template list is fused into this ONE catalog — creation
            shows only the {STRATEGIES.length} strategies, resolved on live spot (
            {fmtNum(spot, spot >= 1000 ? 0 : 2)}).
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LegRow({
  leg, analytics, spot, onChange, onRemove, onDuplicate,
}: {
  leg: Leg;
  analytics?: LegAnalytics;
  spot: number;
  onChange: (patch: Partial<Leg>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const hasStrike = leg.kind === 'call' || leg.kind === 'put' || leg.kind === 'perp_option';
  const isDated = leg.kind === 'call' || leg.kind === 'put';
  const isBuy = leg.side === 'buy';
  const step = spot >= 50000 ? 500 : spot >= 4000 ? 50 : spot >= 400 ? 5 : 0.5;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 transition hover:border-zinc-700">
      {/* Row 1: identity */}
      <div className="mb-2 flex items-center gap-1.5">
        <button
          onClick={() => onChange({ side: isBuy ? 'sell' : 'buy' })}
          className={`flex h-5 items-center rounded px-1.5 text-[9px] font-bold uppercase tracking-wide transition ${
            isBuy
              ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40 hover:bg-emerald-500/25'
              : 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/40 hover:bg-rose-500/25'
          }`}
        >
          {isBuy ? 'Buy' : 'Sell'}
        </button>
        <span className="flex items-center gap-1 text-[10px] font-medium text-zinc-300">
          {KIND_ICONS[leg.kind]}
          {kindLabel(leg.kind)}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button onClick={onDuplicate} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" title="Duplicate leg">
            <Copy className="h-3 w-3" />
          </button>
          <button onClick={onRemove} className="rounded p-1 text-zinc-500 hover:bg-rose-950 hover:text-rose-400" title="Remove leg">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Row 2: parameters */}
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1">
          <span className="text-[9px] text-zinc-500">Qty</span>
          <input
            type="number"
            min={0.001}
            step={0.1}
            value={leg.qty}
            onChange={(e) => onChange({ qty: Math.min(Math.max(parseFloat(e.target.value) || 0.001, 0.001), 10000) })}
            className="w-full bg-transparent text-right font-mono text-[11px] text-zinc-200 outline-none"
          />
        </label>
        {hasStrike && (
          <label className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1">
            <span className="text-[9px] text-zinc-500">Strike</span>
            <input
              type="number"
              min={1}
              step={step}
              value={leg.strike ?? spot}
              onChange={(e) => onChange({ strike: Math.max(parseFloat(e.target.value) || 1, 1) })}
              className="w-full bg-transparent text-right font-mono text-[11px] text-zinc-200 outline-none"
            />
          </label>
        )}
        {isDated && (
          <label className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1">
            <span className="text-[9px] text-zinc-500">Expiry</span>
            <select
              value={leg.expiryDays ?? 30}
              onChange={(e) => onChange({ expiryDays: parseFloat(e.target.value) })}
              className="w-full cursor-pointer bg-transparent text-right font-mono text-[11px] text-zinc-200 outline-none [&>option]:bg-zinc-950"
            >
              {EXPIRIES.map((d) => (
                <option key={d} value={d}>{d}d</option>
              ))}
            </select>
          </label>
        )}
        {leg.kind === 'perp_option' && (
          <label className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1">
            <span className="text-[9px] text-zinc-500">Fund τ</span>
            <select
              value={leg.fundingPeriodDays ?? 7}
              onChange={(e) => onChange({ fundingPeriodDays: parseFloat(e.target.value) })}
              className="w-full cursor-pointer bg-transparent text-right font-mono text-[11px] text-zinc-200 outline-none [&>option]:bg-zinc-950"
            >
              {FUNDING_PERIODS.map((d) => (
                <option key={d} value={d}>{d}d</option>
              ))}
            </select>
          </label>
        )}
        {!hasStrike && !isDated && <div />}
      </div>

      {/* Row 3: live analytics */}
      {analytics && (
        <div className="mt-2 flex items-center gap-3 border-t border-zinc-800/70 pt-1.5 font-mono text-[10px]">
          <span className="text-zinc-300">{fmtUsd(analytics.price)}</span>
          {analytics.iv !== undefined && <span className="text-zinc-500">IV {analytics.iv.toFixed(1)}%</span>}
          <span className={analytics.delta >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}>
            Δ {analytics.delta >= 0 ? '+' : ''}{analytics.delta.toFixed(3)}
          </span>
          <span className="ml-auto text-zinc-500">{(isBuy ? '−' : '+')}{fmtUsd(Math.abs(analytics.cost)).slice(1)}</span>
        </div>
      )}
      {leg.kind === 'perp_option' && analytics?.fundingPerDay !== undefined && (
        <div className="mt-1 flex items-center gap-1 text-[9px] text-amber-400/80">
          <InfinityIcon className="h-2.5 w-2.5" />
          funding ≈ {fmtUsd(analytics.fundingPerDay)}/day {leg.side === 'sell' ? '(you receive)' : '(you pay)'}
        </div>
      )}
    </div>
  );
}

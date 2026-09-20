'use client';

// Legs panel — add/remove/edit strategy legs of any kind, plus the
// template library as editable starting points.

import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Plus, Trash2, Copy, LayoutTemplate, TrendingUp, TrendingDown,
  Waves, Shield, Infinity as InfinityIcon, Sparkles, Coins,
} from 'lucide-react';
import type { Leg, LegAnalytics, LegKind, StrategyAnalysis } from '@/lib/types';
import { kindLabel } from '@/lib/types';
import { TEMPLATES, templateCategories } from '@/lib/templates';
import { MAX_LEGS } from '@/lib/strategies';
import { useStrategy } from '@/stores/strategy-store';
import { fmtNum } from '@/lib/format';

import { fmtUsd } from '@/lib/format';

const EXPIRIES = [1, 7, 14, 30, 60, 90, 180, 365];
const FUNDING_PERIODS = [1, 3, 7, 14, 30];

const KIND_ICONS: Record<LegKind, React.ReactNode> = {
  call: <TrendingUp className="h-3.5 w-3.5" />,
  put: <TrendingDown className="h-3.5 w-3.5" />,
  perp_option: <InfinityIcon className="h-3.5 w-3.5" />,
  perp: <Waves className="h-3.5 w-3.5" />,
  spot: <Coins className="h-3.5 w-3.5" />,
};

interface LegsPanelProps {
  spot: number;
  analysis: StrategyAnalysis | null;
}

export function LegsPanel({ spot, analysis }: LegsPanelProps) {
  const {
    legs, size, addLeg, removeLeg, duplicateLeg, updateLeg, setSize, setLegs, setStrategyName,
  } = useStrategy();

  const legAnalyticsById = useMemo(() => {
    const m = new Map<string, LegAnalytics>();
    if (analysis) for (const a of analysis.legs) m.set(a.id, a);
    return m;
  }, [analysis]);

  const applyTemplate = (tplId: string) => {
    const tpl = TEMPLATES.find((t) => t.id === tplId);
    if (!tpl) return;
    setLegs(tpl.build(spot, useStrategy.getState().underlying));
    setStrategyName(tpl.name);
  };

  const netPremium = analysis?.netPremium ?? 0;
  const atCap = legs.length >= MAX_LEGS;

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      {/* Header actions */}
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 flex-1 justify-start gap-2 border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
              <LayoutTemplate className="h-3.5 w-3.5 text-teal-400" />
              Templates
              <span className="ml-auto text-[10px] text-zinc-500">{TEMPLATES.length} presets</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto border-zinc-800 bg-zinc-950">
            {templateCategories().map((cat) => {
              const items = TEMPLATES.filter((t) => t.category === cat.id);
              if (!items.length) return null;
              return (
                <div key={cat.id}>
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-zinc-500">{cat.label}</DropdownMenuLabel>
                  {items.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => applyTemplate(t.id)}
                      className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-zinc-900"
                    >
                      <span className="text-xs font-medium text-zinc-200">{t.name}</span>
                      <span className="line-clamp-2 text-[10px] leading-tight text-zinc-500">{t.description}</span>
                    </button>
                  ))}
                  <DropdownMenuSeparator className="bg-zinc-800" />
                </div>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <div
          title={`${legs.length} of ${MAX_LEGS} legs used`}
          className={`flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 font-mono text-[10px] tabular-nums ${
            atCap
              ? 'border-amber-500/50 bg-amber-950/30 text-amber-400'
              : legs.length > 0
                ? 'border-teal-500/30 bg-teal-950/20 text-teal-300'
                : 'border-zinc-800 bg-zinc-900/60 text-zinc-500'
          }`}
        >
          {legs.length}/{MAX_LEGS}
          <span className="text-[8px] uppercase tracking-wide">legs</span>
        </div>
      </div>

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
            <p className="text-xs text-zinc-500">Add legs or start from a template.</p>
            <p className="max-w-52 text-[10px] leading-tight text-zinc-600">
              Mix dated options, everlasting options, perps and spot — any structure, up to {MAX_LEGS} legs.
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

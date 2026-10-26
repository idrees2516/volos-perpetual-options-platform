'use client';

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED STRATEGIES WORKSPACE — the ONE home for the strategies feature.
//
// Everything strategy-related lives here in a single interface:
//   • Catalog      — browse / search / filter ALL 131 strategies in one place
//                    (card rail or dense table) incl. venue-era filtering
//   • Intent       — "tell us the outcome, we construct it" compiler
//   • Intelligence — what each strategy IS, when it's used, pros, cons,
//                    and the detailed mechanics of the strategy itself
//   • Live Data    — market + strategy analytics pulled on live spot,
//                    per-leg quotes, authoritative Rust engine numbers
//   • Metrics      — the deep layer: IV surface & 25Δ skew, second-order
//                    greeks, VaR/CVaR, stress grid, execution economics
//   • Platforms    — every modern + legacy venue this strategy runs on,
//                    with verdicts, adaptation recipes and fee estimates
//   • Structure    — legs resolved against live spot
//   • Payoff       — interactive payoff & risk chart
//   • Customize    — the full builder (legs editor, greeks, scenarios)
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  Search, Layers, TrendingUp, Shield, Banknote, Zap, Split,
  Infinity as InfinityIcon, Network, Timer, Send, Star, Compass, Coins, Waves,
  Loader2, Sparkles, ArrowLeft, BookOpen, BarChart3, ListTree, Gauge,
  ChevronDown, ChevronRight, Pencil, Sigma, Globe2, Rows3, Table2, Cpu, Landmark,
} from 'lucide-react';
import {
  CATEGORY_META, STRATEGIES, VIEW_META, complexityStars,
  histogramBuckets, resolveStrategyLegs, strategyById,
  type StrategyCategory, type StrategySpec, type StrategyView,
} from '@/lib/strategies';
import type { Leg, LegKind, UnderlyingId } from '@/lib/types';
import { kindLabel } from '@/lib/types';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { fmtNum, fmtUsd } from '@/lib/format';
import { analyzeStrategy } from '@/lib/pricing';
import { engine, RustIntentResponse } from '@/lib/api';
import { TEMPLATES } from '@/lib/templates';
import { PayoffChart } from '@/components/terminal/payoff-chart';
import { BuilderView } from '@/components/terminal/builder-view';
import { StrategyIntelligence } from './strategy-intelligence';
import { StrategyLiveData } from './strategy-live-data';
import { StrategyMetrics } from './strategy-metrics';
import { StrategyPlatforms } from './strategy-platforms';
import { PLATFORMS, platformsForStrategy } from '@/lib/platforms';
import { quickPremium } from '@/lib/metrics';

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
  call: 'C', put: 'P', perp_option: '∞', perp: 'F', spot: 'S',
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

const NO_OVERRIDE = { spotShiftPct: 0, ivShiftPct: 0, daysForward: 0 };

type DetailTab = 'intelligence' | 'data' | 'metrics' | 'platforms' | 'structure' | 'payoff';
type Mode = 'explore' | 'build';
type Goal = 'direction' | 'protect' | 'income' | 'volatility';
type Dir = 'bullish' | 'bearish' | 'neutral';
type RailMode = 'cards' | 'table';
type EraFilter = 'all' | 'modern' | 'legacy' | 'tradfi';

const GOALS: { id: Goal; label: string; icon: React.ReactNode }[] = [
  { id: 'direction', label: 'Trade a view', icon: <Compass className="h-3.5 w-3.5" /> },
  { id: 'protect', label: 'Protect', icon: <Shield className="h-3.5 w-3.5" /> },
  { id: 'income', label: 'Earn', icon: <Coins className="h-3.5 w-3.5" /> },
  { id: 'volatility', label: 'Volatility', icon: <Waves className="h-3.5 w-3.5" /> },
];

const DETAIL_TABS: { id: DetailTab; label: string; icon: React.ReactNode }[] = [
  { id: 'intelligence', label: 'Intelligence', icon: <BookOpen className="h-3.5 w-3.5" /> },
  { id: 'data', label: 'Live Data', icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { id: 'metrics', label: 'Metrics', icon: <Sigma className="h-3.5 w-3.5" /> },
  { id: 'platforms', label: 'Platforms', icon: <Globe2 className="h-3.5 w-3.5" /> },
  { id: 'structure', label: 'Structure', icon: <ListTree className="h-3.5 w-3.5" /> },
  { id: 'payoff', label: 'Payoff', icon: <Gauge className="h-3.5 w-3.5" /> },
];

const ERA_CHIPS: { id: EraFilter; label: string; icon: React.ReactNode }[] = [
  { id: 'all', label: 'All venues', icon: <Globe2 className="h-3 w-3" /> },
  { id: 'modern', label: 'Modern', icon: <Cpu className="h-3 w-3" /> },
  { id: 'legacy', label: 'Legacy', icon: <Landmark className="h-3 w-3" /> },
  { id: 'tradfi', label: 'TradFi', icon: <Landmark className="h-3 w-3" /> },
];

export function StrategiesView({ onOpenTrade }: { onOpenTrade: () => void }) {
  const { market, smooth } = useMarket();
  const { underlying, loadStrategy, strategyName } = useStrategy();
  const asset = smooth[underlying] ?? market.assets[underlying];
  const spot = asset.spot;

  // One workspace, two modes: explore the catalog or customize in the builder.
  const [mode, setMode] = useState<Mode>(() =>
    useStrategy.getState().legs.length > 0 ? 'build' : 'explore',
  );

  // ── catalog state ─────────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string>('long-call');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<StrategyCategory | 'all'>('all');
  const [viewFilter, setViewFilter] = useState<StrategyView | 'all'>('all');
  const [bucket, setBucket] = useState('all');
  const [detailTab, setDetailTab] = useState<DetailTab>('intelligence');
  const [railMode, setRailMode] = useState<RailMode>('cards');
  const [eraFilter, setEraFilter] = useState<EraFilter>('all');
  const [platformId, setPlatformId] = useState<string>('all');

  // ── intent compiler state ─────────────────────────────────────────────────
  const [intentOpen, setIntentOpen] = useState(false);
  const [goal, setGoal] = useState<Goal>('direction');
  const [direction, setDirection] = useState<Dir>('bullish');
  const [horizon, setHorizon] = useState(30);
  const [targetPct, setTargetPct] = useState(25);
  const [maxLoss, setMaxLoss] = useState(2000);
  const [allowPerp, setAllowPerp] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RustIntentResponse | null>(null);

  const selected = strategyById(selectedId) ?? STRATEGIES[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const b = LEG_BUCKETS.find((x) => x.id === bucket) ?? LEG_BUCKETS[0];
    const venueActive = eraFilter !== 'all' || platformId !== 'all';
    return STRATEGIES.filter((s) => {
      if (category !== 'all' && s.category !== category) return false;
      if (viewFilter !== 'all' && s.view !== viewFilter) return false;
      const n = s.legs.length;
      if (n < b.min || n > b.max) return false;
      if (venueActive) {
        const fits = platformsForStrategy(s, underlying, 0);
        if (platformId !== 'all') {
          const f = fits.find((x) => x.platform.id === platformId);
          if (!f || (f.support !== 'native' && f.support !== 'synthetic')) return false;
        }
        if (eraFilter === 'modern' && !fits.some((f) => f.platform.era === 'modern' && f.support !== 'unavailable')) return false;
        if (eraFilter === 'legacy' && !fits.some((f) => f.platform.era === 'legacy' && f.support !== 'unavailable')) return false;
        if (eraFilter === 'tradfi' && !fits.some((f) => f.platform.tradfiUnderlyings !== undefined && f.support !== 'unavailable')) return false;
      }
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.id.includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.includes(q))
      );
    });
  }, [query, category, viewFilter, bucket, eraFilter, platformId, underlying]);

  // Venue counts per strategy (pure spec logic — memoized per underlying).
  const venueCounts = useMemo(() => {
    const m = new Map<string, { native: number; ok: number }>();
    for (const s of STRATEGIES) {
      const fits = platformsForStrategy(s, underlying, 0);
      m.set(s.id, {
        native: fits.filter((f) => f.support === 'native').length,
        ok: fits.filter((f) => f.support === 'native' || f.support === 'synthetic').length,
      });
    }
    return m;
  }, [underlying]);

  // Cheap credit/debit sign per strategy — quantized spot so the 30fps stream
  // doesn't re-price all 532 legs every frame.
  const stepSize = spot >= 50000 ? 500 : spot >= 4000 ? 50 : 5;
  const spotQuant = Math.round(spot / stepSize) * stepSize;
  const premiumMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of STRATEGIES) m.set(s.id, quickPremium(s, underlying, spotQuant));
    return m;
  }, [underlying, spotQuant]);

  // Resolved legs + preview analysis for the selected strategy (client mirror).
  const previewLegs = useMemo(() => resolveStrategyLegs(selected, spot), [selected, spot]);
  const previewAnalysis = useMemo(
    () => analyzeStrategy(previewLegs, underlying, asset, 1, { overrides: NO_OVERRIDE }),
    [previewLegs, underlying, asset],
  );

  const handleCustomize = (spec: StrategySpec) => {
    loadStrategy(spec.name, resolveStrategyLegs(spec, spot));
    setMode('build');
  };

  const handleTrade = (spec: StrategySpec) => {
    loadStrategy(spec.name, resolveStrategyLegs(spec, spot));
    onOpenTrade();
  };

  // ─────────────────────────────────────────────────────────────── build mode
  if (mode === 'build') {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-teal-500/25 bg-teal-950/15 px-3 py-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMode('explore')}
            className="h-7 gap-1 border-zinc-700 bg-zinc-900 px-2.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Catalog
          </Button>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-zinc-100">{strategyName}</p>
            <p className="text-[9px] uppercase tracking-[0.14em] text-zinc-500">
              customizing in builder · {underlying} @ {fmtNum(spot, spot >= 1000 ? 0 : 2)}
            </p>
          </div>
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              onClick={onOpenTrade}
              className="h-7 gap-1.5 bg-teal-500 px-3 text-[10px] font-semibold text-zinc-950 hover:bg-teal-400"
            >
              <Send className="h-3.5 w-3.5" /> Send to Trading
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <BuilderView />
        </div>
      </div>
    );
  }

  // ───────────────────────────────────────────────────────────── explore mode
  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* ── Left rail: search · filters · intent compiler · catalog list ── */}
      <aside className="flex w-[400px] shrink-0 flex-col gap-2 overflow-hidden xl:w-[480px]">
        {/* header */}
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 shrink-0 text-teal-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold tracking-tight text-zinc-100">Strategies</h2>
            <p className="truncate text-[9px] uppercase tracking-[0.16em] text-zinc-500">
              {STRATEGIES.length} in ONE catalog · {PLATFORMS.length} venues · on {underlying} @ {fmtNum(spot, 0)}
            </p>
          </div>
          <div className="ml-auto flex flex-col items-end gap-1">
            <div className="flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/50 p-0.5">
              <button
                onClick={() => setRailMode('cards')}
                title="Card rail"
                className={`rounded p-1 transition ${railMode === 'cards' ? 'bg-teal-950/60 text-teal-300' : 'text-zinc-600 hover:text-zinc-300'}`}
              >
                <Rows3 className="h-3 w-3" />
              </button>
              <button
                onClick={() => setRailMode('table')}
                title="Dense table — all 131 at a glance"
                className={`rounded p-1 transition ${railMode === 'table' ? 'bg-teal-950/60 text-teal-300' : 'text-zinc-600 hover:text-zinc-300'}`}
              >
                <Table2 className="h-3 w-3" />
              </button>
            </div>
            <div className="flex gap-1">
              {histogramBuckets()
                .slice(3)
                .map((b) => (
                  <div key={b.label} className="rounded-md border border-zinc-800 bg-zinc-900/50 px-1.5 py-0.5 text-center">
                    <p className="font-mono text-[10px] font-semibold text-teal-300">{b.count}</p>
                    <p className="text-[7px] uppercase tracking-wide text-zinc-600">{b.label}L</p>
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search — iron condor, zebra, backspread…"
            className="h-8 border-zinc-800 bg-zinc-950 pl-8 text-xs"
          />
        </div>

        {/* intent compiler (collapsible) */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
          <button
            onClick={() => setIntentOpen(!intentOpen)}
            className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left"
          >
            {intentOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-teal-400" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-teal-400" />
            )}
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
              Compile by intent
            </span>
            <span className="ml-auto text-[8px] text-zinc-600">outcome → structure</span>
          </button>
          {intentOpen && (
            <div className="space-y-2.5 border-t border-zinc-800/70 p-2.5">
              <div className="grid grid-cols-2 gap-1">
                {GOALS.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => {
                      setGoal(g.id);
                      setResult(null);
                      if (g.id === 'protect') setDirection('bearish');
                    }}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left transition ${
                      goal === g.id
                        ? 'border-teal-500/50 bg-teal-950/25 text-teal-200'
                        : 'border-zinc-800 bg-zinc-900/30 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <span className={goal === g.id ? 'text-teal-300' : 'text-zinc-500'}>{g.icon}</span>
                    <span className="text-[10px] font-medium">{g.label}</span>
                  </button>
                ))}
              </div>

              {(goal === 'direction' || goal === 'protect') && (
                <div className="grid grid-cols-3 gap-1">
                  {(['bullish', 'bearish', 'neutral'] as Dir[]).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDirection(d)}
                      className={`rounded-md py-1 text-[10px] font-medium capitalize transition ${
                        direction === d
                          ? d === 'bullish'
                            ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40'
                            : d === 'bearish'
                              ? 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/40'
                              : 'bg-zinc-700/30 text-zinc-300 ring-1 ring-zinc-600'
                          : 'bg-zinc-900/50 text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-zinc-500">
                  <span>Horizon</span>
                  <span className="font-mono text-zinc-300">{horizon}d</span>
                </div>
                <Slider value={[horizon]} min={7} max={180} step={1} onValueChange={(v) => setHorizon(v[0])} className="mt-1.5" />
              </div>

              <div>
                <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-zinc-500">
                  <span>Target move</span>
                  <span className="font-mono text-zinc-300">
                    {goal === 'direction' && direction === 'bearish' ? '−' : '+'}{targetPct}%
                  </span>
                </div>
                <Slider value={[targetPct]} min={5} max={100} step={5} onValueChange={(v) => setTargetPct(v[0])} className="mt-1.5" />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[9px] uppercase tracking-wider text-zinc-500">Max loss $</span>
                <Input
                  type="number"
                  value={maxLoss}
                  min={100}
                  step={100}
                  onChange={(e) => setMaxLoss(Math.max(parseFloat(e.target.value) || 100, 100))}
                  className="h-7 flex-1 border-zinc-800 bg-zinc-950 font-mono text-xs"
                />
              </div>

              <label className="flex cursor-pointer items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/30 px-2 py-1.5">
                <span className="text-[10px] text-zinc-300">Allow perpetual structures</span>
                <input
                  type="checkbox"
                  checked={allowPerp}
                  onChange={(e) => setAllowPerp(e.target.checked)}
                  className="h-3.5 w-3.5 accent-teal-500"
                />
              </label>

              <Button
                onClick={compileIntent}
                disabled={loading}
                className="w-full gap-1.5 bg-teal-600 text-[11px] font-semibold text-zinc-950 hover:bg-teal-500"
                size="sm"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Compile candidate strategies
              </Button>
              {error && (
                <p className="text-[9px] leading-relaxed text-amber-500/80">
                  Rust compiler unreachable — local mirror used. {error}
                </p>
              )}

              {result && (
                <div className="space-y-1.5">
                  {result.notes?.map((n, i) => (
                    <p key={i} className="rounded bg-zinc-900/60 px-2 py-1 text-[9px] leading-relaxed text-zinc-500">{n}</p>
                  ))}
                  {result.candidates.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        const spec = STRATEGIES.find((s) => s.name === c.name);
                        if (spec) {
                          setSelectedId(spec.id);
                          setDetailTab('intelligence');
                        } else {
                          loadStrategy(c.name, c.legs);
                          setMode('build');
                        }
                      }}
                      className={`group w-full rounded-md border p-2 text-left transition ${
                        c.suggested
                          ? 'border-teal-500/40 bg-teal-950/15'
                          : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[11px] font-semibold text-zinc-200 group-hover:text-teal-200">{c.name}</p>
                        {c.suggested && (
                          <span className="rounded bg-teal-600/20 px-1 py-0.5 text-[7px] font-semibold text-teal-300">REC</span>
                        )}
                        <span className="ml-auto font-mono text-[8px] text-zinc-600">{c.legs.length}L</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[9px] leading-relaxed text-zinc-500">{c.thesis}</p>
                      <div className="mt-1 flex gap-1 text-[8px] text-zinc-600">
                        <span>max loss: {c.maxLossClass}</span>
                        <span>·</span>
                        <span>carry: {c.carryClass}</span>
                        <span>·</span>
                        <span>iv: {c.ivExposure}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* filters */}
        <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => setCategory('all')}
              className={`rounded-md px-2 py-1 text-[10px] font-medium transition ${
                category === 'all' ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              All · {STRATEGIES.length}
            </button>
            {(Object.keys(CATEGORY_META) as StrategyCategory[]).map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                title={CATEGORY_META[cat].hint}
                className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium transition ${
                  category === cat
                    ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {CATEGORY_ICONS[cat]}
                {CATEGORY_META[cat].label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {(['all', 'bullish', 'bearish', 'neutral', 'volatile', 'low-vol'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setViewFilter(v)}
                className={`rounded-md px-2 py-0.5 text-[9px] font-medium capitalize transition ${
                  viewFilter === v ? 'bg-zinc-800 text-zinc-100 ring-1 ring-zinc-600' : 'text-zinc-600 hover:text-zinc-400'
                }`}
              >
                {v === 'all' ? 'any view' : v === 'low-vol' ? 'low vol' : v}
              </button>
            ))}
            <select
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              className="ml-auto h-6 cursor-pointer rounded-md border border-zinc-800 bg-zinc-950 px-1.5 text-[9px] text-zinc-400 [&>option]:bg-zinc-950"
            >
              {LEG_BUCKETS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-1 border-t border-zinc-800/60 pt-1.5">
            {ERA_CHIPS.map((e) => (
              <button
                key={e.id}
                onClick={() => {
                  setEraFilter(e.id);
                  if (e.id !== 'all') setPlatformId('all');
                }}
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-medium transition ${
                  eraFilter === e.id && platformId === 'all'
                    ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {e.icon}
                {e.label}
              </button>
            ))}
            <select
              value={platformId}
              onChange={(e) => {
                setPlatformId(e.target.value);
                if (e.target.value !== 'all') setEraFilter('all');
              }}
              className="ml-auto h-6 cursor-pointer rounded-md border border-zinc-800 bg-zinc-950 px-1.5 text-[9px] text-zinc-400 [&>option]:bg-zinc-950"
              title="Filter to strategies this platform can run"
            >
              <option value="all">any platform</option>
              {PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.era === 'modern' ? '◆' : '◇'} {p.short}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* catalog list — cards or dense table, all 131 in one place */}
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {railMode === 'table' ? (
            <CatalogTable
              rows={filtered}
              selectedId={selectedId}
              onSelect={setSelectedId}
              premiumMap={premiumMap}
              venueCounts={venueCounts}
            />
          ) : (
            filtered.map((s) => {
              const p = premiumMap.get(s.id) ?? 0;
              const vc = venueCounts.get(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`w-full rounded-lg border p-2 text-left transition ${
                    selectedId === s.id
                      ? 'border-teal-500/50 bg-teal-950/20'
                      : 'border-zinc-800/70 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/60'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={selectedId === s.id ? 'text-teal-300' : 'text-zinc-500'}>
                      {CATEGORY_ICONS[s.category]}
                    </span>
                    <p className={`truncate text-[11px] font-semibold ${selectedId === s.id ? 'text-teal-100' : 'text-zinc-200'}`}>
                      {s.name}
                    </p>
                    <span
                      className={`ml-auto shrink-0 rounded px-1 py-0.5 font-mono text-[8px] tabular-nums ${
                        s.legs.length >= 20
                          ? 'bg-fuchsia-950/50 text-fuchsia-300'
                          : s.legs.length >= 8
                            ? 'bg-sky-950/50 text-sky-300'
                            : 'bg-zinc-800/80 text-zinc-400'
                      }`}
                    >
                      {s.legs.length}L
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[8px]">
                    <span className={VIEW_META[s.view].color}>{VIEW_META[s.view].label}</span>
                    <span className="text-zinc-700">·</span>
                    <span className={`shrink-0 font-mono ${p < 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
                      {p < 0 ? 'CR' : 'DR'} {fmtUsd(Math.abs(p), { compact: true })}
                    </span>
                    <span className="text-zinc-700">·</span>
                    <span className="font-mono text-teal-400/60">{complexityStars(s.complexity)}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-zinc-500">
                      <Globe2 className="h-2.5 w-2.5" />
                      <span title="venues that can run this strategy (native + synthetic)">
                        {vc?.ok ?? 0}v
                      </span>
                    </span>
                  </div>
                </button>
              );
            })
          )}
          {filtered.length === 0 && (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-center">
              <Search className="h-5 w-5 text-zinc-700" />
              <p className="text-xs text-zinc-500">No strategies match those filters.</p>
            </div>
          )}
          <p className="sticky bottom-0 z-10 bg-zinc-950/90 py-1 text-center text-[8px] uppercase tracking-[0.14em] text-zinc-600 backdrop-blur">
            showing {filtered.length} of {STRATEGIES.length} · one catalog, every strategy in one place
          </p>
        </div>
      </aside>

      {/* ── Right: strategy workspace ── */}
      <section className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden">
        {/* header */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold text-zinc-100">{selected.name}</h3>
            <p className="flex flex-wrap items-center gap-1.5 text-[9px] text-zinc-500">
              <span>{CATEGORY_META[selected.category].label}</span>
              <span>·</span>
              <span className={VIEW_META[selected.view].color}>{VIEW_META[selected.view].label}</span>
              <span>·</span>
              <span className="font-mono">{selected.legs.length} legs</span>
              <span>·</span>
              <span className="font-mono text-teal-400/80">{complexityStars(selected.complexity)}</span>
              <span>·</span>
              <span className="font-mono">
                {previewAnalysis.isCredit ? 'credit' : 'debit'} {fmtUsd(Math.abs(previewAnalysis.netPremium))}
              </span>
              <span>·</span>
              <span className="text-sky-400/80" title="venues that can run this strategy">
                {venueCounts.get(selected.id)?.ok ?? 0}/{PLATFORMS.length} venues
              </span>
            </p>
          </div>
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleCustomize(selected)}
              className="h-7 gap-1.5 border-zinc-700 bg-zinc-900 px-3 text-[10px] text-zinc-200 hover:bg-zinc-800"
            >
              <Pencil className="h-3 w-3" /> Customize in Builder
            </Button>
            <Button
              size="sm"
              onClick={() => handleTrade(selected)}
              className="h-7 gap-1.5 bg-teal-500 px-3 text-[10px] font-semibold text-zinc-950 hover:bg-teal-400"
            >
              <Send className="h-3 w-3" /> Send to Trading
            </Button>
          </div>
        </div>

        {/* tabs */}
        <div className="flex items-center gap-1 border-b border-zinc-800/70 px-1">
          {DETAIL_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setDetailTab(t.id)}
              className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-[11px] font-medium transition ${
                detailTab === t.id
                  ? 'border-b-2 border-teal-400 text-teal-300'
                  : 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          <span className="ml-auto font-mono text-[8px] text-zinc-600">
            {selected.id} · resolved on {underlying} @ {fmtNum(spot, spot >= 1000 ? 0 : 2)}
          </span>
        </div>

        {/* tab content */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {detailTab === 'intelligence' && <StrategyIntelligence spec={selected} />}
          {detailTab === 'data' && (
            <StrategyLiveData
              analysis={previewAnalysis}
              legs={previewLegs}
              underlying={underlying}
              market={asset}
              legCount={selected.legs.length}
            />
          )}
          {detailTab === 'metrics' && (
            <StrategyMetrics
              analysis={previewAnalysis}
              legs={previewLegs}
              underlying={underlying}
              market={asset}
              specName={selected.name}
            />
          )}
          {detailTab === 'platforms' && (
            <StrategyPlatforms
              spec={selected}
              underlying={underlying}
              premiumUsd={previewAnalysis.netPremium}
            />
          )}
          {detailTab === 'structure' && (
            <StructureTab
              spec={selected}
              legs={previewLegs}
              spot={spot}
              underlying={underlying}
              onLoad={() => handleCustomize(selected)}
            />
          )}
          {detailTab === 'payoff' && (
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
              <div className="px-4 pt-3">
                <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  <Gauge className="h-3.5 w-3.5 text-teal-400" /> Payoff &amp; Risk Profile
                  <span className="ml-2 font-mono text-[9px] font-normal normal-case tracking-normal text-zinc-600">
                    hover for P&amp;L · drag strikes after loading into the builder
                  </span>
                </h2>
              </div>
              <PayoffChart
                analysis={previewAnalysis}
                legs={previewLegs}
                spot={spot}
                overrides={NO_OVERRIDE}
                showCone
                showDecay
                showNow
                horizonDays={previewAnalysis.horizonDays}
                onStrikeDrag={() => {}}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );

  // ── intent compiler ────────────────────────────────────────────────────────
  function compileIntent() {
    setLoading(true);
    setError(null);
    setResult(null);
    engine
      .intent({
        underlying,
        goal,
        direction,
        horizon_days: horizon,
        target_move_pct: targetPct,
        max_loss_usd: maxLoss,
        allow_perpetual: allowPerp,
      })
      .then(setResult)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'engine unreachable');
        setResult(localCompile());
      })
      .finally(() => setLoading(false));
  }

  function localCompile(): RustIntentResponse {
    const map: Record<string, string[]> = {
      'direction|bullish': ['long-call', 'bull-call-spread', 'everlasting-call', 'perp-put'],
      'direction|bearish': ['long-put', 'bear-put-spread', 'everlasting-put'],
      protect: ['protective-put', 'collar', 'everlasting-put'],
      income: ['covered-call', 'cash-secured-put', 'short-strangle-wings'],
      volatility: ['long-straddle', 'long-strangle', 'iron-butterfly', 'everlasting-straddle'],
    };
    const key = goal === 'direction' ? `direction|${direction}` : goal;
    const ids = map[key] ?? ['long-call'];
    return {
      underlying,
      spot,
      compileUs: 0,
      notes: ['Compiled locally (client mirror) — Rust engine offline.'],
      candidates: ids
        .map((id) => TEMPLATES.find((t) => t.id === id))
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
        .map((t) => ({
          name: t.name,
          thesis: t.description,
          legs: t.build(spot, underlying),
          category: t.category,
          maxLossClass: 'see builder',
          upsideClass: 'see builder',
          carryClass: '—',
          ivExposure: '—',
          liquidityClass: '—',
          suggested: false,
        })),
    };
  }
}

// ── Structure tab ─────────────────────────────────────────────────────────────
function StructureTab({
  spec,
  legs,
  spot,
  underlying,
  onLoad,
}: {
  spec: StrategySpec;
  legs: Leg[];
  spot: number;
  underlying: UnderlyingId;
  onLoad: () => void;
}) {
  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
            <ListTree className="h-3.5 w-3.5" />
            Legs — resolved on live spot
          </h3>
          <span className="font-mono text-[9px] text-zinc-600">
            {underlying} @ {fmtNum(spot, spot >= 1000 ? 0 : 2)} · {legs.length} legs
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left">
            <thead>
              <tr className="border-b border-zinc-800 text-[8px] uppercase tracking-wider text-zinc-600">
                <th className="py-1.5 pr-2 font-medium">#</th>
                <th className="pr-2 font-medium">Instrument</th>
                <th className="pr-2 font-medium">Side</th>
                <th className="pr-2 font-medium">Qty</th>
                <th className="pr-2 font-medium">Strike</th>
                <th className="pr-2 font-medium">Moneyness</th>
                <th className="pr-2 font-medium">Tenor</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[10px] tabular-nums">
              {legs.map((leg, i) => (
                <tr key={leg.id} className="border-b border-zinc-800/40 text-zinc-300">
                  <td className="py-1.5 pr-2 text-zinc-600">{i + 1}</td>
                  <td className="pr-2">{kindLabel(leg.kind)}</td>
                  <td className="pr-2">
                    <span className={leg.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{leg.side}</span>
                  </td>
                  <td className="pr-2">×{leg.qty}</td>
                  <td className="pr-2">
                    {leg.strike !== undefined ? fmtNum(leg.strike, leg.strike >= 1000 ? 0 : 2) : '—'}
                  </td>
                  <td className="pr-2">
                    {leg.strike !== undefined ? (
                      <span
                        className={
                          leg.strike > spot * 1.001
                            ? 'text-sky-400'
                            : leg.strike < spot * 0.999
                              ? 'text-amber-400'
                              : 'text-zinc-400'
                        }
                      >
                        {((leg.strike / spot - 1) * 100).toFixed(1)}% {leg.strike > spot ? 'OTM' : leg.strike < spot ? 'ITM' : 'ATM'}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="pr-2 text-zinc-500">
                    {leg.expiryDays !== undefined
                      ? `${leg.expiryDays}d expiry`
                      : leg.fundingPeriodDays !== undefined
                        ? `τ${leg.fundingPeriodDays}d funding`
                        : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* leg chips */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Structure chips</h3>
        <div className="flex flex-wrap gap-1">
          {spec.legs.map((l, i) => (
            <span
              key={i}
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] tabular-nums ${
                l.side === 'buy' ? 'bg-emerald-950/50 text-emerald-400/90' : 'bg-rose-950/50 text-rose-400/90'
              }`}
            >
              {KIND_CHIP[l.kind]}
              {l.strike !== undefined ? l.strike.toFixed(2) : ''}×{l.qty}
              {l.expiryDays ? ` ${l.expiryDays}d` : l.fundingPeriodDays ? ` τ${l.fundingPeriodDays}` : ''}
            </span>
          ))}
        </div>
        <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">
          Strikes are multipliers of live spot — the same catalog resolves to tradable levels on BTC, ETH or SOL.
          Load the strategy into the builder to drag strikes and watch every metric update at 60fps.
        </p>
      </section>

      <div className="flex justify-end gap-2 pb-1">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 border-zinc-700 bg-zinc-900 px-3 text-[10px] text-zinc-200 hover:bg-zinc-800"
          onClick={onLoad}
        >
          <Star className="h-3 w-3" /> Load into Builder
        </Button>
      </div>
    </div>
  );
}

// ── Dense catalog table — ALL 131 strategies in one scroll ───────────────────
function CatalogTable({
  rows,
  selectedId,
  onSelect,
  premiumMap,
  venueCounts,
}: {
  rows: StrategySpec[];
  selectedId: string;
  onSelect: (id: string) => void;
  premiumMap: Map<string, number>;
  venueCounts: Map<string, { native: number; ok: number }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
          <tr className="border-b border-zinc-800 text-[8px] uppercase tracking-wider text-zinc-600">
            <th className="py-1 pr-1 font-medium">#</th>
            <th className="pr-1.5 font-medium">Strategy</th>
            <th className="pr-1 font-medium">Category</th>
            <th className="pr-1 font-medium">View</th>
            <th className="pr-1 text-right font-medium">Legs</th>
            <th className="pr-1 text-right font-medium">C/D</th>
            <th className="pr-1 text-right font-medium">Prem</th>
            <th className="pr-1 text-right font-medium">Venues</th>
            <th className="text-right font-medium">Cpx</th>
          </tr>
        </thead>
        <tbody className="font-mono text-[9px] tabular-nums">
          {rows.map((s, i) => {
            const p = premiumMap.get(s.id) ?? 0;
            const vc = venueCounts.get(s.id);
            const sel = selectedId === s.id;
            return (
              <tr
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={`cursor-pointer border-b border-zinc-800/40 transition ${
                  sel ? 'bg-teal-950/25 text-teal-100' : 'text-zinc-300 hover:bg-zinc-900/60'
                }`}
              >
                <td className="py-1 pr-1 text-zinc-600">{i + 1}</td>
                <td className="max-w-[190px] truncate pr-1.5 font-sans font-semibold">{s.name}</td>
                <td className="pr-1 text-zinc-500">{CATEGORY_META[s.category].label}</td>
                <td className={`pr-1 ${VIEW_META[s.view].color}`}>{VIEW_META[s.view].label}</td>
                <td className="pr-1 text-right">{s.legs.length}</td>
                <td className={`pr-1 text-right ${p < 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {p < 0 ? 'CR' : 'DR'}
                </td>
                <td className="pr-1 text-right text-zinc-500">{fmtUsd(Math.abs(p), { compact: true })}</td>
                <td className="pr-1 text-right text-zinc-400">
                  {vc?.ok ?? 0}
                  <span className="text-zinc-600">/{PLATFORMS.length}</span>
                </td>
                <td className="text-right text-teal-400/60">{complexityStars(s.complexity)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

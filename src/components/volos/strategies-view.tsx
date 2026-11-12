'use client';

// ─────────────────────────────────────────────────────────────────────────────
// StrategiesView — v1.9: the 131-strategy catalog rail + strategy context with
// seven sub-tabs (Intelligence · Live Data · Metrics · Platforms · Backtest ·
// Structure · Payoff).
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import {
  Search, List, LayoutGrid, BookOpen, Activity, SlidersHorizontal, LayoutGrid as GridIcon,
  Clock, Network, TrendingUp, Pencil, Send, Star, Settings2, Layers,
} from 'lucide-react';
import type { MarketState } from '@/hooks/use-market';
import { spotOf } from '@/hooks/use-market';
import { useUi, type StrategyTab, type CatalogFilter, type SentimentFilter } from '@/stores/ui-store';
import { useStrategy } from '@/stores/strategy-store';
import { STRATEGIES, strategyById, complexityStars, type StrategySpec } from '@/lib/strategies';
import { CATEGORY_META, CATEGORY_ORDER } from '@/lib/strategies';
import { analyzeStrategy, legQuote, distributionalRisk, strategyHorizon } from '@/lib/pricing';
import { BASE_IV, type UnderlyingId } from '@/lib/types';
import { feasibleVenueCount, VENUES } from '@/lib/venues';
import { intelligenceFor } from '@/lib/intelligence';
import { fmtUsd, fmtNum } from '@/lib/format';
import { SectionCard, Stat, Chip, SENTIMENT_LABEL, SENTIMENT_TONE } from './bits';
import { PayoffChart } from './payoff-chart';
import { LiveDataTab, MetricsTab, PlatformsTab, BacktestTab } from './strategy-analytics';

// ── sentiment ────────────────────────────────────────────────────────────────

type Sentiment = 'bullish' | 'bearish' | 'neutral' | 'volatile' | 'lowvol';

function sentimentOf(spec: StrategySpec): Sentiment {
  if (spec.category === 'volatility') return 'volatile';
  if (spec.category === 'income' || spec.category === '0dte') {
    // ODTE income structures are Low Vol unless structurally directional
    const s = structuralBias(spec);
    return s === 'neutral' ? 'lowvol' : s;
  }
  if (spec.category === 'protection') return 'bearish';
  return structuralBias(spec);
}

function structuralBias(spec: StrategySpec): Sentiment {
  let score = 0;
  for (const l of spec.legs) {
    const dir = l.side === 'long' ? 1 : -1;
    if (l.kind === 'call') score += dir;
    else if (l.kind === 'put') score -= dir;
    else if (l.kind === 'perp_option') score += (l.strikeOffsetPct ?? 0) >= 0 ? dir : -dir;
    else score += dir * 0.5;
  }
  if (score > 0.5) return 'bullish';
  if (score < -0.5) return 'bearish';
  return 'neutral';
}

/** Net premium (credit > 0) of a catalog strategy at spot — catalog rail only. */
function premiumFor(spec: StrategySpec, spot: number, underlying: UnderlyingId): number {
  const baseIv = BASE_IV[underlying];
  let net = 0;
  for (const l of spec.legs) {
    const q = legQuote(l, spot, baseIv, spot);
    net += (l.side === 'long' ? -1 : 1) * q.premium * l.ratio;
  }
  return net;
}

// ── catalog rail ─────────────────────────────────────────────────────────────

const FILTER_TAGS: { id: CatalogFilter; label: string; cat?: string }[] = [
  { id: 'all', label: 'All · 131' },
  { id: 'direction', label: 'Direction', cat: 'direction' },
  { id: 'income', label: 'Income', cat: 'income' },
  { id: 'volatility', label: 'Volatility', cat: 'volatility' },
  { id: 'protection', label: 'Protection', cat: 'protection' },
  { id: 'spread', label: 'Spreads', cat: 'spread' },
  { id: 'perpetual', label: 'Perpetual', cat: 'perpetual' },
  { id: 'multileg', label: 'Multi-Leg', cat: 'multileg' },
  { id: '0dte', label: 'ODTE', cat: '0dte' },
];

function CatalogRail({ market }: { market: MarketState }) {
  const { catalogFilter, setCatalogFilter, sentiment, setSentiment, search, setSearch } = useUi();
  const { venueFilter, setVenueFilter } = useUi();
  const { selectCatalog, catalogId, underlying } = useStrategy();
  const spot = spotOf(market, underlying);

  const spotBucket = Math.round(spot / 100) * 100;
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return STRATEGIES.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q)) return false;
      if (catalogFilter !== 'all' && s.category !== catalogFilter) return false;
      if (sentiment !== 'any' && sentimentOf(s) !== sentiment) return false;
      if (venueFilter !== 'all') {
        // venue feasibility proxy: the strategy's leg classes must exist in the group
        const ok = s.legs.some((l) =>
          venueFilter === 'TradFi'
            ? l.kind === 'call' || l.kind === 'put'
            : venueFilter === 'Modern'
              ? l.kind !== 'spot'
              : true,
        );
        if (!ok) return false;
      }
      return true;
    }).map((s) => ({ spec: s, prem: premiumFor(s, spotBucket, underlying), sent: sentimentOf(s) }));
  }, [search, catalogFilter, sentiment, venueFilter, spotBucket, underlying]);

  const bullish = list.filter((l) => l.sent === 'bullish').length;
  const bearish = list.filter((l) => l.sent === 'bearish').length;

  return (
    <aside className="flex w-[268px] shrink-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 text-teal-400" />
          <span className="text-xs font-bold text-zinc-100">Strategies</span>
          <div className="ml-auto flex gap-1">
            <button type="button" aria-label="list view" className="rounded p-1 text-teal-300 hover:bg-zinc-800"><List className="h-3 w-3" /></button>
            <button type="button" aria-label="grid view" className="rounded p-1 text-zinc-600 hover:bg-zinc-800"><LayoutGrid className="h-3 w-3" /></button>
          </div>
        </div>
        <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
          {STRATEGIES.length} IN ONE CATALOG · {VENUES.length} VENUES · ON {underlying} @ {spotBucket.toLocaleString()}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1">
          {[
            { n: list.length, l: 'total' },
            { n: bullish, l: 'bullish' },
            { n: bearish, l: 'bearish' },
          ].map((c) => (
            <div key={c.l} className="rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-1 text-center">
              <div className="font-mono text-sm font-bold text-zinc-100">{c.n}</div>
              <div className="text-[8px] uppercase tracking-wider text-zinc-500">{c.l}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="px-2 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950/80 px-2 py-1.5">
          <Search className="h-3 w-3 text-zinc-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search — iron condor, zebra, backspread…"
            className="w-full bg-transparent text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>

        <div className="mt-2 text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-500">Compile by intent</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {FILTER_TAGS.map((t) => (
            <Chip key={t.id} active={catalogFilter === t.id} onClick={() => setCatalogFilter(t.id)}>
              {t.label}
            </Chip>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Chip active={sentiment === 'any'} onClick={() => setSentiment('any')}>Any View</Chip>
          {(['bullish', 'bearish', 'neutral', 'volatile', 'lowvol'] as SentimentFilter[]).map((s) => (
            <Chip key={s} active={sentiment === s} onClick={() => setSentiment(s)}>
              {SENTIMENT_LABEL[s]}
            </Chip>
          ))}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {(['all', 'Modern', 'Legacy', 'TradFi'] as const).map((v) => (
            <Chip key={v} active={venueFilter === v} onClick={() => setVenueFilter(v)}>
              {v === 'all' ? 'All venues' : v}
            </Chip>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-zinc-800">
        {list.map(({ spec, prem, sent }) => {
          const active = spec.id === catalogId;
          return (
            <button
              key={spec.id}
              type="button"
              onClick={() => selectCatalog(spec.id, spot)}
              className={`flex w-full items-center gap-2 border-b border-zinc-900 px-2.5 py-2 text-left transition-colors ${
                active ? 'bg-teal-400/10' : 'hover:bg-zinc-900/60'
              }`}
            >
              <span className={`h-6 w-1 shrink-0 rounded-full ${active ? 'bg-teal-400' : 'bg-zinc-700'}`} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[11px] font-semibold ${active ? 'text-teal-200' : 'text-zinc-200'}`}>
                  {spec.name}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[9px]">
                  <span className={`font-semibold ${sent === 'bullish' ? 'text-emerald-400' : sent === 'bearish' ? 'text-rose-400' : sent === 'volatile' ? 'text-amber-400' : 'text-zinc-400'}`}>
                    {SENTIMENT_LABEL[sent]}
                  </span>
                  <span className={prem >= 0 ? 'text-teal-400' : 'text-zinc-400'}>
                    {prem >= 0 ? 'CR' : 'DEBIT'} {fmtUsd(Math.abs(prem), prem >= 100 ? 0 : 2)}
                  </span>
                  <span className="text-amber-500/90">{complexityStars(spec.complexity)}</span>
                </span>
              </span>
              <Settings2 className="h-3 w-3 shrink-0 text-zinc-700" />
            </button>
          );
        })}
        {list.length === 0 && (
          <div className="px-3 py-6 text-center text-[10px] text-zinc-600">no strategies match the filters</div>
        )}
      </div>

      <div className="border-t border-zinc-800 px-2.5 py-1.5 text-[8px] uppercase tracking-wider text-zinc-600">
        Showing {list.length} of {STRATEGIES.length} · one catalog. Every strategy in one place.
      </div>
    </aside>
  );
}

// ── context header + sub-tab nav ─────────────────────────────────────────────

const TAB_ITEMS: { id: StrategyTab; label: string; icon: typeof BookOpen }[] = [
  { id: 'intelligence', label: 'Intelligence', icon: BookOpen },
  { id: 'live', label: 'Live Data', icon: Activity },
  { id: 'metrics', label: 'Metrics', icon: SlidersHorizontal },
  { id: 'platforms', label: 'Platforms', icon: GridIcon },
  { id: 'backtest', label: 'Backtest', icon: Clock },
  { id: 'structure', label: 'Structure', icon: Network },
  { id: 'payoff', label: 'Payoff', icon: TrendingUp },
];

function ContextHeader({
  spec, premium, feasible, spot, sentiment,
}: { spec: StrategySpec | null; premium: number; feasible: number; spot: number; sentiment: Sentiment }) {
  const { setView, setBuilderOpen } = useUi();
  const { underlying, size } = useStrategy();
  if (!spec) return null;
  return (
    <div className="border-b border-zinc-800 px-4 pb-2 pt-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold leading-tight text-zinc-50">{spec.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
            <span className={`font-semibold ${CATEGORY_META[spec.category].color}`}>
              {CATEGORY_META[spec.category].label}
            </span>
            <span>·</span>
            <span className={sentiment === 'bullish' ? 'text-emerald-400' : sentiment === 'bearish' ? 'text-rose-400' : 'text-amber-400'}>
              {SENTIMENT_LABEL[sentiment]}
            </span>
            <span>·</span>
            <span>{spec.legs.length} legs</span>
            <span>·</span>
            <span className="text-amber-500/90">{complexityStars(spec.complexity)}</span>
            <span>·</span>
            <span className={premium >= 0 ? 'text-teal-300' : 'text-zinc-300'}>
              {premium >= 0 ? 'credit' : 'debit'} {fmtUsd(Math.abs(premium) * size)}
            </span>
            <span>·</span>
            <span>{feasible}/{VENUES.length} venues</span>
            <span>·</span>
            <span>size {size}×</span>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setBuilderOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:border-teal-500/60 hover:text-teal-300"
          >
            <Pencil className="h-3 w-3" /> Customize in Builder
          </button>
          <button
            type="button"
            onClick={() => setView('trading')}
            className="inline-flex items-center gap-1.5 rounded-md bg-teal-400 px-3 py-1.5 text-[11px] font-bold text-zinc-950 transition-colors hover:bg-teal-300"
          >
            <Send className="h-3 w-3" /> Send to Trading
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-4">
        <nav className="flex items-center gap-0.5 overflow-x-auto">
          {TAB_ITEMS.map((t) => (
            <TabButton key={t.id} tab={t} />
          ))}
        </nav>
        <div className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider text-zinc-600">
          {spec.id.replace(/_/g, '-')} · resolved on {underlying} @ {Math.round(spot).toLocaleString()}
        </div>
      </div>
    </div>
  );
}

function TabButton({ tab }: { tab: { id: StrategyTab; label: string; icon: typeof BookOpen } }) {
  const { strategyTab, setStrategyTab } = useUi();
  const active = strategyTab === tab.id;
  const Icon = tab.icon;
  return (
    <button
      type="button"
      onClick={() => setStrategyTab(tab.id)}
      className={`inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[10px] font-semibold transition-colors ${
        active
          ? 'border-teal-400 text-teal-300'
          : 'border-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      <Icon className="h-3 w-3" />
      {tab.label}
    </button>
  );
}

// ── Intelligence tab ─────────────────────────────────────────────────────────

function IntelligenceTab({ spec }: { spec: StrategySpec }) {
  const intel = intelligenceFor(spec);
  return (
    <div className="grid grid-cols-[1.6fr_1fr] gap-3">
      <div className="space-y-3">
        <SectionCard title="What it is" icon={<BookOpen className="h-3.5 w-3.5" />}>
          <p className="text-[11px] leading-relaxed text-zinc-300">{intel.whatIs}</p>
        </SectionCard>
        <SectionCard title="How it works — detailed mechanics" icon={<Settings2 className="h-3.5 w-3.5" />}>
          <div className="space-y-2.5">
            {intel.mechanics.map((m, i) => (
              <p key={i} className="text-[11px] leading-relaxed text-zinc-300">{m}</p>
            ))}
          </div>
        </SectionCard>
      </div>
      <div className="space-y-3">
        <SectionCard title="When it is used" icon={<Clock className="h-3.5 w-3.5" />}>
          <p className="text-[11px] leading-relaxed text-zinc-300">{intel.whenToUse}</p>
        </SectionCard>
        <SectionCard title={`Advantages (${intel.advantages.length})`} icon={<Star className="h-3.5 w-3.5" />}>
          <ul className="space-y-1.5">
            {intel.advantages.map((a, i) => (
              <li key={i} className="flex gap-2 text-[11px] leading-snug text-teal-300/90">
                <span className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-teal-400" />
                {a}
              </li>
            ))}
          </ul>
        </SectionCard>
        <SectionCard title={`Disadvantages (${intel.disadvantages.length})`} icon={<Star className="h-3.5 w-3.5" />}>
          <ul className="space-y-1.5">
            {intel.disadvantages.map((a, i) => (
              <li key={i} className="flex gap-2 text-[11px] leading-snug text-rose-300/90">
                <span className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-rose-400" />
                {a}
              </li>
            ))}
          </ul>
        </SectionCard>
        <div className="flex flex-wrap gap-1">
          {intel.tags.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Structure tab ────────────────────────────────────────────────────────────

function StructureTab({ spec }: { spec: StrategySpec }) {
  const { setBuilderOpen } = useUi();
  const { legs, underlying } = useStrategy();
  const spotRef = legs[0] ? 1 : 1;
  void spotRef;
  return (
    <div className="space-y-3">
      <SectionCard
        title="Legs — resolved on live spot"
        icon={<Network className="h-3.5 w-3.5" />}
        right={`${underlying} · ${legs.length} legs`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-[9px] uppercase tracking-wider text-zinc-500">
                <th className="py-1.5 pr-3">#</th>
                <th className="pr-3">Instrument</th>
                <th className="pr-3">Side</th>
                <th className="pr-3">Qty</th>
                <th className="pr-3">Strike</th>
                <th className="pr-3">Moneyness</th>
                <th>Tenor</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {legs.map((l, i) => {
                const off = l.strikeOffsetPct ?? 0;
                const moneyness = l.strikeOffsetPct === undefined ? '—' : `${Math.abs(off).toFixed(1)}% ${off < 0 ? 'ITM' : off === 0 ? 'ATM' : 'OTM'}`;
                return (
                  <tr key={l.id} className="border-b border-zinc-900">
                    <td className="py-1.5 pr-3 text-zinc-600">{i + 1}</td>
                    <td className="pr-3 capitalize text-zinc-200">
                      {l.kind === 'perp_option' ? 'Everlasting' : l.kind === 'perp' ? 'Perp' : l.kind === 'spot' ? 'Spot' : l.kind}
                    </td>
                    <td className={`pr-3 font-semibold ${l.side === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>{l.side}</td>
                    <td className="pr-3 text-zinc-300">×{l.ratio}</td>
                    <td className="pr-3 text-zinc-300">{l.strikeOffsetPct === undefined ? '—' : `${off > 0 ? '+' : ''}${off}% of spot`}</td>
                    <td className={`pr-3 ${off < 0 ? 'text-amber-400' : 'text-teal-400'}`}>{moneyness}</td>
                    <td className="text-zinc-400">{l.kind === 'perp_option' ? '∞' : l.kind === 'spot' ? '—' : `${l.dte}d expiry`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Structure chips" icon={<Layers className="h-3.5 w-3.5" />}>
        <div className="flex flex-wrap gap-1.5">
          {legs.map((l, i) => {
            const off = l.strikeOffsetPct;
            const chip = off === undefined
              ? `${l.kind === 'perp' ? 'PERP' : 'SPOT'}×${l.ratio}`
              : `${l.kind === 'put' || (l.kind === 'perp_option' && off < 0) ? 'P' : 'C'}${(off / 100).toFixed(2).replace('0.', '.')}×${l.ratio}${l.kind === 'perp_option' ? '∞' : l.dte === 0 ? 'd' : ` ${l.dte}d`}`;
            return (
              <span
                key={l.id}
                className={`rounded-md px-2 py-1 font-mono text-[10px] font-semibold ${
                  l.side === 'short' ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'
                }`}
                title={`leg ${i + 1}`}
              >
                {chip}
              </span>
            );
          })}
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-zinc-500">
          Strikes are multipliers of live spot — the same catalog resolves to tradeable levels on BTC, ETH or SOL.
          Load the strategy into the builder to drag strikes and watch every metric update live.
        </p>
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => setBuilderOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-teal-500/50 px-3 py-1.5 text-[11px] font-semibold text-teal-300 transition-colors hover:bg-teal-400/10"
          >
            <Star className="h-3 w-3" /> Load into Builder
          </button>
        </div>
      </SectionCard>
    </div>
  );
}

// ── Payoff tab ───────────────────────────────────────────────────────────────

function PayoffTab({ market }: { market: MarketState }) {
  const { legs, underlying, size, anchorSpot } = useStrategy();
  const spot = spotOf(market, underlying);
  const baseIv = BASE_IV[underlying];
  const analysis = useMemo(
    () => analyzeStrategy(legs, spot, underlying, anchorSpot ?? undefined, size),
    [legs, spot, underlying, anchorSpot, size],
  );
  const horizon = Math.max(1, Math.round(strategyHorizon(legs) * 365));
  const risk = useMemo(
    () => distributionalRisk(analysis.payoffAt, spot, baseIv, horizon),
    [analysis, spot, baseIv, horizon],
  );
  const series = useMemo(() => {
    const lo = spot * 0.5, hi = spot * 1.5, N = 200;
    const points: { s: number; pnl: number }[] = [];
    for (let i = 0; i <= N; i++) {
      const s = lo + ((hi - lo) * i) / N;
      points.push({ s, pnl: analysis.payoffAt(s) });
    }
    return {
      points, breakevens: analysis.breakevens, maxProfit: analysis.maxProfit, maxLoss: analysis.maxLoss,
      spot, horizonDays: horizon, atmIv: baseIv, netPremium: analysis.netPremium, size,
    };
  }, [analysis, spot, horizon, baseIv, size]);

  return (
    <div className="space-y-3">
      <SectionCard
        title="Expiry payoff · probability cone"
        icon={<TrendingUp className="h-3.5 w-3.5" />}
        right={`lognormal cone · ${horizon}d horizon · size ${size}×`}
      >
        <PayoffChart series={series} height={280} />
      </SectionCard>
      <div className="grid grid-cols-4 gap-2 xl:grid-cols-7">
        <Stat label={analysis.netPremium >= 0 ? 'Net credit' : 'Net debit'} value={fmtUsd(Math.abs(analysis.netPremium))} tone={analysis.netPremium >= 0 ? 'teal' : 'default'} />
        <Stat label="Max profit" value={analysis.maxProfit > 1e9 ? 'Unlimited' : fmtUsd(analysis.maxProfit)} tone="pos" />
        <Stat label="Max loss" value={fmtUsd(analysis.maxLoss)} tone="neg" />
        <Stat label="Prob. of profit" value={fmtNum(risk.pop * 100, 1) + '%'} tone="pos" />
        <Stat label="Expected value" value={fmtUsd(risk.ev, 2)} tone={risk.ev >= 0 ? 'pos' : 'neg'} />
        <Stat label="1σ band" value={`${Math.round(risk.lo1s).toLocaleString()} – ${Math.round(risk.hi1s).toLocaleString()}`} sub={`±${fmtNum((risk.stdev / spot) * 100, 1)}% by expiry`} />
        <Stat label="Breakevens" value={analysis.breakevens.slice(0, 2).map((b) => Math.round(b).toLocaleString()).join(' | ') || '—'} tone="amber" />
      </div>
    </div>
  );
}

// ── view ─────────────────────────────────────────────────────────────────────

export function StrategiesView({ market }: { market: MarketState }) {
  const { catalogId, legs, underlying, size, anchorSpot } = useStrategy();
  const { strategyTab } = useUi();
  const spot = spotOf(market, underlying);
  const spec = catalogId ? strategyById(catalogId) ?? null : null;

  const analysis = useMemo(
    () => (legs.length ? analyzeStrategy(legs, spot, underlying, anchorSpot ?? undefined, size) : null),
    [legs, spot, underlying, anchorSpot, size],
  );
  const feasible = useMemo(
    () => feasibleVenueCount(legs.map((l) => l.kind), legs.map((l) => l.dte)),
    [legs],
  );
  const sentiment: Sentiment = spec ? sentimentOf(spec) : 'neutral';
  const premium = analysis ? analysis.netPremium / (size || 1) : 0;

  return (
    <div className="flex h-full min-h-0 gap-3">
      <CatalogRail market={market} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
        <ContextHeader spec={spec} premium={premium} feasible={feasible} spot={spot} sentiment={sentiment} />
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!spec || !analysis ? (
            <div className="flex h-full items-center justify-center text-xs text-zinc-600">
              pick a strategy from the catalog rail
            </div>
          ) : strategyTab === 'intelligence' ? (
            <IntelligenceTab spec={spec} />
          ) : strategyTab === 'live' ? (
            <LiveDataTab market={market} analysis={analysis} spec={spec} />
          ) : strategyTab === 'metrics' ? (
            <MetricsTab market={market} analysis={analysis} spec={spec} />
          ) : strategyTab === 'platforms' ? (
            <PlatformsTab market={market} spec={spec} />
          ) : strategyTab === 'backtest' ? (
            <BacktestTab spec={spec} />
          ) : strategyTab === 'structure' ? (
            <StructureTab spec={spec} />
          ) : (
            <PayoffTab market={market} />
          )}
        </div>
      </div>
    </div>
  );
}

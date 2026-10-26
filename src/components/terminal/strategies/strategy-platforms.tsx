'use client';

// Platforms & Legacy tab — where THIS strategy actually runs. Every platform
// from the registry (perpetual-native modern venues + legacy crypto CEXs +
// TradFi exchanges + brokers) gets a verdict for the selected strategy:
// native / synthetic / partial / not listed, with the adaptation recipe and
// an estimated round-trip taker fee.

import React from 'react';
import { Building2, Landmark, Globe2, Cpu, CheckCircle2, RefreshCw, AlertTriangle, XCircle, Coins, Route } from 'lucide-react';
import type { StrategySpec } from '@/lib/strategies';
import type { UnderlyingId } from '@/lib/types';
import { fmtNum, fmtUsd } from '@/lib/format';
import { ERA_META, PLATFORMS, SUPPORT_META, platformSummary, platformsForStrategy } from '@/lib/platforms';
import { StrategyRouting } from './strategy-routing';

interface PlatformsProps {
  spec: StrategySpec;
  underlying: UnderlyingId;
  /** Net premium (signed) at size 1, used for fee estimates. */
  premiumUsd: number;
}

function VerdictIcon({ support }: { support: keyof typeof SUPPORT_META }) {
  switch (support) {
    case 'native':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
    case 'synthetic':
      return <RefreshCw className="h-3.5 w-3.5 text-sky-400" />;
    case 'partial':
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
    default:
      return <XCircle className="h-3.5 w-3.5 text-rose-400" />;
  }
}

function PlatformCard({ fit }: { fit: ReturnType<typeof platformsForStrategy>[number] }) {
  const { platform: p, support } = fit;
  const sm = SUPPORT_META[support];
  return (
    <div
      className={`rounded-lg border p-2.5 transition ${
        support === 'native'
          ? 'border-emerald-500/25 bg-emerald-950/10'
          : support === 'unavailable'
            ? 'border-zinc-800/70 bg-zinc-900/20 opacity-75'
            : 'border-zinc-800 bg-zinc-900/30'
      }`}
    >
      <div className="flex items-center gap-2">
        <VerdictIcon support={support} />
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold text-zinc-100">{p.name}</p>
          <p className="truncate text-[8px] uppercase tracking-wider text-zinc-600">
            {p.kind} · {p.latency} latency
          </p>
        </div>
        <span className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide ${sm.chip}`}>
          {sm.label}
        </span>
      </div>

      <p className="mt-1.5 text-[9px] leading-relaxed text-zinc-500">{p.tagline}</p>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[9px] tabular-nums text-zinc-400">
        <p>legs/ticket <span className="text-zinc-200">{p.maxLegsPerTicket === 25 ? '25 (RFQ basket)' : p.maxLegsPerTicket}</span></p>
        <p>dailies <span className={p.dailyExpiries ? 'text-emerald-400' : 'text-zinc-500'}>{p.dailyExpiries ? 'yes (0DTE)' : `min ${p.minTenorDays}d`}</span></p>
        <p>taker <span className="text-zinc-200">{p.fee.takerBpsPremium} bps prem</span></p>
        <p>maker <span className="text-zinc-200">{p.fee.makerBpsPremium} bps</span></p>
        {p.fee.perContractUsd !== undefined && (
          <p className="col-span-2">per contract <span className="text-zinc-200">{fmtUsd(p.fee.perContractUsd)}/side</span></p>
        )}
      </div>

      <p className="mt-1.5 text-[8px] leading-relaxed text-zinc-600">
        margin: <span className="text-zinc-400">{p.margin}</span>
        {p.assets.length > 0 && <> · lists <span className="text-zinc-400">{p.assets.join(' · ')}</span></>}
        {p.tradfiUnderlyings && <> · own underlyings: <span className="text-zinc-400">{p.tradfiUnderlyings}</span></>}
      </p>

      {support !== 'unavailable' && (
        <div className="mt-2 space-y-1">
          {fit.reasons.slice(0, 3).map((r, i) => (
            <p key={i} className="flex items-start gap-1 text-[8.5px] leading-relaxed text-zinc-500">
              <span className="mt-0.5 text-zinc-700">›</span> {r}
            </p>
          ))}
          <p className={`mt-1 rounded-md border px-2 py-1 text-[9px] leading-relaxed ${
            support === 'native'
              ? 'border-emerald-500/20 bg-emerald-950/20 text-emerald-200/90'
              : 'border-sky-500/20 bg-sky-950/20 text-sky-200/90'
          }`}>
            {fit.adaptation}
          </p>
          {fit.estFeeUsd !== null && (
            <p className="flex items-center gap-1 font-mono text-[9px] text-zinc-400">
              <Coins className="h-3 w-3 text-amber-400/70" />
              est. round-trip taker fee <span className="text-amber-300">{fmtUsd(fit.estFeeUsd)}</span>
            </p>
          )}
        </div>
      )}
      {support === 'unavailable' && (
        <p className="mt-2 rounded-md border border-rose-500/20 bg-rose-950/20 px-2 py-1 text-[9px] leading-relaxed text-rose-200/80">
          {fit.reasons[0]}
        </p>
      )}
    </div>
  );
}

export function StrategyPlatforms({ spec, underlying, premiumUsd }: PlatformsProps) {
  const fits = React.useMemo(
    () => platformsForStrategy(spec, underlying, premiumUsd),
    [spec, underlying, premiumUsd],
  );
  const summary = platformSummary(fits);

  const modern = fits.filter((f) => f.platform.era === 'modern');
  const legacyCrypto = fits.filter((f) => f.platform.era === 'legacy' && f.platform.tradfiUnderlyings === undefined);
  const legacyTradfi = fits.filter((f) => f.platform.era === 'legacy' && f.platform.tradfiUnderlyings !== undefined);

  return (
    <div className="space-y-3">
      {/* smart order routing & creation */}
      <StrategyRouting spec={spec} underlying={underlying} premiumUsd={premiumUsd} />

      {/* summary strip */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <Globe2 className="h-4 w-4 text-teal-400" />
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-200">
                {spec.name} — venue map
              </h3>
              <p className="text-[9px] text-zinc-500">
                {summary.native + summary.synthetic} of {summary.total} venues can run it · {PLATFORMS.length} platforms across modern &amp; legacy eras
              </p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {(['native', 'synthetic', 'partial', 'unavailable'] as const).map((s) => (
              <div key={s} className={`rounded-md border px-2 py-1 text-center ${SUPPORT_META[s].chip}`}>
                <p className="font-mono text-sm font-semibold leading-none tabular-nums">{summary[s]}</p>
                <p className="mt-0.5 text-[7px] uppercase tracking-wide opacity-80">{SUPPORT_META[s].label}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-2 text-[9px] leading-relaxed text-zinc-500">
          <span className="text-teal-300">Native</span> — one ticket as listed ·{' '}
          <span className="text-sky-300">Synthetic</span> — replicable via rolls / split tickets / futures hedge ·{' '}
          <span className="text-amber-300">Partial</span> — structure changes materially ·{' '}
          <span className="text-rose-300">Not listed</span> — core legs absent. Fee lines are estimates on the live premium of{' '}
          <span className="font-mono text-zinc-300">{fmtUsd(Math.abs(premiumUsd))}</span> at size 1.
        </p>
      </section>

      {/* modern era */}
      <section>
        <div className="mb-1.5 flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5 text-teal-400" />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-300">
            {ERA_META.modern.label}
          </h3>
          <span className="text-[8px] text-zinc-600">{ERA_META.modern.hint}</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {modern.map((f) => <PlatformCard key={f.platform.id} fit={f} />)}
        </div>
      </section>

      {/* legacy crypto */}
      <section>
        <div className="mb-1.5 flex items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5 text-amber-400" />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">
            Legacy · crypto dated-options venues
          </h3>
          <span className="text-[8px] text-zinc-600">{underlying} books — expiries, serials, 0DTE dailies</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {legacyCrypto.map((f) => <PlatformCard key={f.platform.id} fit={f} />)}
        </div>
      </section>

      {/* legacy tradfi */}
      <section>
        <div className="mb-1.5 flex items-center gap-1.5">
          <Landmark className="h-3.5 w-3.5 text-violet-400" />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300">
            Legacy · TradFi options exchanges &amp; brokers
          </h3>
          <span className="text-[8px] text-zinc-600">the same archetypes on index, futures &amp; single-name books</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {legacyTradfi.map((f) => <PlatformCard key={f.platform.id} fit={f} />)}
        </div>
        <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">
          TradFi venues list their own underlyings — the strategy&apos;s <span className="text-zinc-400">archetype</span> (this
          catalog&apos;s structure, strikes and ratios) trades there unchanged: the 0DTE book on CBOE SPX, the
          calendar spreads on CME ES, the covered calls and collars on Nasdaq single names. VolOS normalizes the
          leg math so one spec prices across every era at once — {fmtNum(spec.legs.length, 0)} legs resolved on{' '}
          {underlying} here, on SPX there.
        </p>
      </section>
    </div>
  );
}

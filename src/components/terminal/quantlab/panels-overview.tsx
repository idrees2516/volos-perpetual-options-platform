'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-overview — the one-glance brief: spot vs dealer levels,
// IV/VRP, expected move, perps, tape pulse and cross-symbol levels.
// -----------------------------------------------------------------------------

import React from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant, useAgeLabel } from './use-quant';
import { EmptyNote, ErrNote, LevelStrip, LineChart, LiveDot, Pill, StatGrid } from './quant-viz';
import { MultiSymbolTable } from './panels-gex';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';

interface BriefData {
  symbol: string;
  spot: number;
  levels: { hvl: number | null; callWall: number | null; putSupport: number | null; maxPain: number | null; regime: string; totalGexUsd1pct: number; hvl0dte: number | null; callWall0dte: number | null };
  iv: { atmIv30Pct: number; rv30Pct: number; vrpPct: number; frontAtmIvPct: number; frontRr25: number };
  expectedMove: { expiry: string; dte: number; oneSigmaUsd: number; oneSigmaPct: number; range: number[] } | null;
  perps: { oiUsd: number; fundingRate: number; fundingApr: number; perpBasisPct: number; cvd24hUsd: number | null; rv30Pct: number; liquidationTop: { price: number; side: string; notionalUsd: number; leverage: number }[] };
  tape: { prints12h: number; premium12hUsd: number; imbalance: number; callShare: number | null; whales: { id: string; instrument: string; side: string; premiumUsd: number; ts: number }[] } | null;
  frontExpiry: { expiry: string; dte: number; type: string; atmIvPct: number; oiUsd: number; maxPain: number; netGexUsd1pct: number } | null;
  options: { available: boolean; expiries: number; oiUsd: number; volumeUsd24h: number; putCallRatioOi: number };
  sources: string[];
}

export function OverviewPanel({ symbol, hasOptions }: { symbol: string; hasOptions: boolean }) {
  const brief = useQuant<BriefData>('/brief', { symbol }, { pollMs: 6000 });
  const market = useQuant<{ candles: { ts: number; c: number }[] }>('/market', { symbol }, { pollMs: 15000 });
  const age = useAgeLabel(brief.fetchedAt);
  const d = brief.data;

  return (
    <div className="space-y-2">
      <ErrNote error={brief.error} />
      {!d && brief.loading && <EmptyNote>booting the native engine — first compute takes a few seconds…</EmptyNote>}
      {d && (
        <Dock viewId="quant-overview" layout="grid">
          <DockPanel
            id="brief"
            title={`${symbol} Market Brief`}
            sub="one call · every number computed live from venue APIs"
            span={2}
            dock={{ kind: 'quant-overview', meta: { symbol } }}
            right={
              <>
                <LiveDot ok={!brief.error} label={`live · ${age}`} />
                <Pill tone={d.levels.regime === 'long-gamma' ? 'emerald' : 'rose'}>{d.levels.regime}</Pill>
              </>
            }
          >
            <LevelStrip
              spot={d.spot}
              levels={[
                { label: 'put sup', price: d.levels.putSupport, tone: 'rose' },
                { label: 'max pain', price: d.levels.maxPain, tone: 'violet' },
                { label: '0dte hvl', price: d.levels.hvl0dte, tone: 'teal' },
                { label: 'hvl', price: d.levels.hvl, tone: 'teal' },
                { label: 'wall', price: d.levels.callWall, tone: 'amber' },
              ]}
            />
            <div className="mt-1">
              <StatGrid
                cols={4}
                stats={[
                  { label: 'spot', value: fmtNum(d.spot, d.spot >= 1000 ? 0 : 2), sub: `deribit index · sources: ${d.sources.slice(0, 3).join(' · ')}` },
                  { label: 'net gex', value: fmtUsd(d.levels.totalGexUsd1pct, { compact: true, sign: true }), tone: d.levels.totalGexUsd1pct >= 0 ? 'emerald' : 'rose', sub: 'USD per 1% move' },
                  { label: 'cm30 iv', value: hasOptions && Number.isFinite(d.iv?.atmIv30Pct) ? `${d.iv.atmIv30Pct.toFixed(1)}%` : '—', tone: 'teal', sub: hasOptions ? `rv30 ${Number.isFinite(d.iv?.rv30Pct) ? `${d.iv.rv30Pct.toFixed(1)}%` : '—'} · vrp ${Number.isFinite(d.iv?.vrpPct) ? `${d.iv.vrpPct.toFixed(1)}` : '—'}` : 'no options chain' },
                  { label: '1σ expected move', value: d.expectedMove ? fmtUsd(d.expectedMove.oneSigmaUsd, { compact: true }) : '—', sub: d.expectedMove ? `${d.expectedMove.oneSigmaPct.toFixed(2)}% by ${d.expectedMove.expiry}` : '' },
                  { label: 'perp oi', value: fmtUsd(d.perps.oiUsd, { compact: true }), sub: '4 venues aggregated' },
                  { label: 'funding (8h)', value: `${(d.perps.fundingRate * 100).toFixed(4)}%`, tone: d.perps.fundingRate >= 0 ? 'emerald' : 'rose', sub: `apr ${(d.perps.fundingApr * 100).toFixed(1)}%` },
                  { label: 'options oi', value: hasOptions ? fmtUsd(d.options.oiUsd, { compact: true }) : '—', sub: hasOptions ? `${d.options.expiries} expiries · pcr ${d.options.putCallRatioOi.toFixed(2)}` : 'deribit: btc/eth only' },
                  { label: '12h tape', value: d.tape ? fmtUsd(d.tape.premium12hUsd, { compact: true }) : '—', sub: d.tape ? `${d.tape.prints12h} prints · imb ${(d.tape.imbalance * 100).toFixed(0)}%` : '' },
                ]}
              />
            </div>
          </DockPanel>

          <DockPanel id="price" title="Price · last 8h" sub="5m closes (binance perp)" span={1}>
              {market.data?.candles?.length ? (
                <LineChart
                  height={150}
                  yFormat={(v) => fmtNum(v, 0)}
                  series={[{ label: 'price', points: market.data.candles.map((c) => ({ x: c.ts, y: c.c })) }]}
                  xFormat={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                />
              ) : (
                <EmptyNote>{market.loading ? 'loading…' : '—'}</EmptyNote>
              )}
          </DockPanel>

          <DockPanel
            id="front-expiry"
            title="Front Expiry & Whale Watch"
            sub={d.frontExpiry ? `${d.frontExpiry.expiry} · ${d.frontExpiry.type}` : '—'}
            span={1}
          >
              {d.frontExpiry ? (
                <StatGrid
                  cols={4}
                  stats={[
                    { label: 'atm iv', value: `${d.frontExpiry.atmIvPct.toFixed(1)}%`, tone: 'teal' },
                    { label: 'expiry oi', value: fmtUsd(d.frontExpiry.oiUsd, { compact: true }) },
                    { label: 'max pain', value: fmtNum(d.frontExpiry.maxPain, 0), tone: 'violet' },
                    { label: 'net gex', value: fmtUsd(d.frontExpiry.netGexUsd1pct, { compact: true, sign: true }), tone: d.frontExpiry.netGexUsd1pct >= 0 ? 'emerald' : 'rose' },
                  ]}
                />
              ) : (
                <EmptyNote>no options chain for {symbol}</EmptyNote>
              )}
              {d.tape?.whales?.length ? (
                <div className="mt-2 space-y-0.5">
                  <p className="text-[8px] font-semibold uppercase tracking-[0.12em] text-zinc-600">largest 12h prints</p>
                  {d.tape.whales.slice(0, 4).map((w) => (
                    <p key={w.id} className="flex items-center justify-between font-mono text-[9px] text-zinc-400">
                      <span className={w.instrument.includes('-C') ? 'text-emerald-300' : 'text-rose-300'}>{w.instrument.replace(`${symbol}-`, '')}</span>
                      <span>
                        <span className={w.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{w.side}</span> · {fmtUsd(w.premiumUsd, { compact: true })}
                      </span>
                    </p>
                  ))}
                </div>
              ) : null}
          </DockPanel>

          {hasOptions && (
            <DockPanel id="cross-symbol" title="Cross-Symbol Dealer Levels" sub="btc & eth side by side · native engine" span={2} right={<Pill tone="teal">live</Pill>}>
              <MultiSymbolTable />
            </DockPanel>
          )}
        </Dock>
      )}
    </div>
  );
}

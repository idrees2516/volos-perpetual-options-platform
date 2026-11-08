'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-perps — Perps & Market + Liquidations: cross-venue OI,
// funding, CVD, futures basis, RV, candles; model-estimated liquidation map.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant } from './use-quant';
import { ChartLegend, EmptyNote, ErrNote, LineChart, Panel, Pill, Segmented, StatGrid } from './quant-viz';

interface PerpData {
  spot: number;
  perpMark: number;
  perpBasisPct: number;
  fundingRate: number;
  fundingApr: number;
  nextFundingTs: number | null;
  fundingHist: { ts: number; rate: number }[];
  oi: { venue: string; oiUsd: number; oiContracts: number }[];
  oiUsdTotal: number;
  oiHist: { ts: number; oiUsd: number }[];
  cvd: { ts: number; cvdUsd: number; price: number }[];
  futuresTerm: { instrument: string; mark: number; oi: number; basisPct: number; dte: number }[];
  rv30Pct: number;
  liquidationClusters: { price: number; side: 'long' | 'short'; notionalUsd: number; leverage: number }[];
}
interface LiqData {
  spot: number;
  priceGrid: number[];
  longIntensity: number[];
  shortIntensity: number[];
  topLong: { price: number; side: string; notionalUsd: number; leverage: number }[];
  topShort: { price: number; side: string; notionalUsd: number; leverage: number }[];
  model: string;
}

export function PerpsPanel({ symbol }: { symbol: string }) {
  const perp = useQuant<PerpData>('/perps', { symbol }, { pollMs: 10000 });
  const market = useQuant<{ change24hPct: number | null; high24h: number | null; low24h: number | null; volumeBase24h: number; takerBuyShare: number | null; candles: { ts: number; c: number }[] }>('/market', { symbol }, { pollMs: 10000 });
  const p = perp.data;
  const fundingNext = p?.nextFundingTs ? new Date(p.nextFundingTs).toLocaleTimeString(undefined, { hour12: false }) : null;

  return (
    <div className="space-y-2">
      <ErrNote error={perp.error} />
      {p && market.data && (
        <Panel title={`${symbol} Perp Picture`} sub="binance · bybit · okx · deribit — live public data" right={<Pill tone="teal">live</Pill>}>
          <StatGrid
            cols={4}
            stats={[
              { label: 'spot / index', value: fmtNum(p.spot, p.spot >= 1000 ? 0 : 2), sub: `24h ${market.data.change24hPct != null ? `${market.data.change24hPct >= 0 ? '+' : ''}${market.data.change24hPct.toFixed(2)}%` : '—'}` },
              { label: 'perp mark', value: fmtNum(p.perpMark, p.perpMark >= 1000 ? 0 : 2), sub: `basis ${Number.isFinite(p.perpBasisPct) ? `${p.perpBasisPct >= 0 ? '+' : ''}${p.perpBasisPct.toFixed(3)}%` : '—'}` },
              { label: 'funding (8h)', value: `${(p.fundingRate * 100).toFixed(4)}%`, tone: p.fundingRate >= 0 ? 'emerald' : 'rose', sub: `apr ${(p.fundingApr * 100).toFixed(1)}% · next ${fundingNext ?? '—'}` },
              { label: 'total perp oi', value: fmtUsd(p.oiUsdTotal, { compact: true }), sub: `${p.oi.length} venues` },
              { label: '24h volume', value: fmtUsd(market.data.volumeBase24h * p.spot, { compact: true }), sub: 'binance usdt-perp' },
              { label: 'taker buy share', value: market.data.takerBuyShare != null ? `${(market.data.takerBuyShare * 100).toFixed(1)}%` : '—', sub: '24h aggressor balance' },
              { label: 'rv30', value: `${p.rv30Pct.toFixed(1)}%`, sub: 'realized (5m, annualized)' },
              { label: 'cvd 24h', value: fmtUsd(p.cvd.at(-1)?.cvdUsd ?? 0, { compact: true, sign: true }), tone: (p.cvd.at(-1)?.cvdUsd ?? 0) >= 0 ? 'emerald' : 'rose', sub: 'cumulative volume delta' },
            ]}
          />
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {p.oi.map((o) => (
              <div key={o.venue} className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-1.5">
                <p className="text-[8px] font-semibold uppercase tracking-[0.12em] text-zinc-600">{o.venue}</p>
                <p className="font-mono text-[12px] font-semibold text-zinc-100">{fmtUsd(o.oiUsd, { compact: true })}</p>
                <p className="text-[8px] text-zinc-600">{((o.oiUsd / (p.oiUsdTotal || 1)) * 100).toFixed(1)}% share</p>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <div className="grid gap-2 xl:grid-cols-2">
        <Panel title="Price + CVD" sub="5m candles · cumulative taker delta (USD)">
          {p?.cvd?.length ? (
            <>
              <LineChart
                height={180}
                yFormat={(v) => fmtNum(v, 0)}
                series={[
                  { label: 'price', points: p.cvd.map((c) => ({ x: c.ts, y: c.price })), color: '#a1a1aa' },
                ]}
                xFormat={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              />
              <div className="mt-1">
                <LineChart
                  height={110}
                  yFormat={(v) => fmtUsd(v, { compact: true })}
                  series={[{ label: 'cvd', points: p.cvd.map((c) => ({ x: c.ts, y: c.cvdUsd })) }]}
                  xFormat={(v) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                />
              </div>
              <ChartLegend series={[{ label: 'cvd up = takers buying', color: '#2dd4bf' }]} />
            </>
          ) : (
            <EmptyNote>{perp.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>

        <div className="space-y-2">
          <Panel title="Funding History" sub="binance · per 8h">
            {p?.fundingHist?.length ? (
              <LineChart
                height={130}
                yFormat={(v) => `${(v * 100).toFixed(3)}%`}
                series={[{ label: 'funding', points: p.fundingHist.map((f) => ({ x: f.ts, y: f.rate })) }]}
                xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                yZero
              />
            ) : (
              <EmptyNote>{perp.loading ? 'loading…' : '—'}</EmptyNote>
            )}
          </Panel>
          <Panel title="Futures Term Structure" sub="deribit dated futures · annualized basis">
            {p?.futuresTerm?.length ? (
              <LineChart
                height={130}
                yFormat={(v) => `${v.toFixed(1)}%`}
                series={[{ label: 'basis', points: p.futuresTerm.map((f) => ({ x: f.dte, y: f.basisPct })) }]}
                xFormat={(v) => `${v.toFixed(0)}d`}
                yZero
              />
            ) : (
              <EmptyNote>{perp.loading ? 'loading…' : '—'}</EmptyNote>
            )}
          </Panel>
        </div>
      </div>
      <LiquidationPanel symbol={symbol} />
    </div>
  );
}

function LiquidationPanel({ symbol }: { symbol: string }) {
  const [levs, setLevs] = useState<'all' | '10' | '25' | '50' | '100'>('all');
  const liq = useQuant<LiqData>('/liquidations', { symbol, lev: levs === 'all' ? undefined : levs }, { pollMs: 20000 });
  const d = liq.data;
  const maxI = Math.max(...(d?.longIntensity ?? [1]), ...(d?.shortIntensity ?? [1]), 1);
  return (
    <Panel
      title="Liquidation Heatmap · model-estimated"
      sub="where leveraged perp positions would get liquidated (price × intensity)"
      right={
        <>
          <Segmented value={levs} onChange={setLevs} options={[{ id: 'all', label: 'All' }, { id: '10', label: '10x' }, { id: '25', label: '25x' }, { id: '50', label: '50x' }, { id: '100', label: '100x' }]} />
          <Pill tone="amber">estimate</Pill>
        </>
      }
    >
      <ErrNote error={liq.error} />
      {d?.priceGrid?.length ? (
        <>
          <div className="space-y-[3px]">
            {d.priceGrid.map((price, i) => {
              const l = d.longIntensity[i];
              const s = d.shortIntensity[i];
              if (l + s <= 0) return null;
              const near = Math.abs(price / d.spot - 1) < 0.01;
              return (
                <div key={price} className={`flex items-center gap-1.5 ${near ? 'opacity-100' : ''}`}>
                  <span className={`w-16 shrink-0 text-right font-mono text-[8.5px] ${near ? 'text-teal-300' : 'text-zinc-500'}`}>{fmtNum(price, 0)}</span>
                  <div className="flex h-2.5 flex-1 items-center gap-px">
                    <div className="flex h-full flex-1 justify-end">
                      {s > 0 && <div className="h-full rounded-l-sm bg-rose-500/70" style={{ width: `${Math.min(100, (s / maxI) * 100)}%` }} />}
                    </div>
                    <div className="h-full w-px bg-zinc-700" />
                    <div className="flex h-full flex-1 justify-start">
                      {l > 0 && <div className="h-full rounded-r-sm bg-emerald-500/70" style={{ width: `${Math.min(100, (l / maxI) * 100)}%` }} />}
                    </div>
                  </div>
                  <span className="w-14 shrink-0 text-right font-mono text-[8px] text-zinc-600">{fmtUsd(Math.max(l, s), { compact: true })}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[9px]">
            <div>
              <p className="mb-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-emerald-500">top long liqs (below)</p>
              {d.topLong.slice(0, 5).map((c) => (
                <p key={c.price} className="flex justify-between font-mono text-[8.5px] text-zinc-400">
                  <span>{fmtNum(c.price, 0)}</span>
                  <span>{fmtUsd(c.notionalUsd, { compact: true })} · {c.leverage}x</span>
                </p>
              ))}
            </div>
            <div>
              <p className="mb-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-rose-500">top short liqs (above)</p>
              {d.topShort.slice(0, 5).map((c) => (
                <p key={c.price} className="flex justify-between font-mono text-[8.5px] text-zinc-400">
                  <span>{fmtNum(c.price, 0)}</span>
                  <span>{fmtUsd(c.notionalUsd, { compact: true })} · {c.leverage}x</span>
                </p>
              ))}
            </div>
          </div>
          <p className="mt-2 text-[8px] leading-relaxed text-zinc-600">{d.model}</p>
        </>
      ) : (
        <EmptyNote>{liq.loading ? 'estimating…' : '—'}</EmptyNote>
      )}
    </Panel>
  );
}

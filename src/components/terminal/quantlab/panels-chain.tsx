'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-chain — Chain & OPEX: live per-expiry summary, the filtered
// dual-sided option chain (with our native greeks), and the OPEX calendar.
// -----------------------------------------------------------------------------

import React, { useMemo, useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant } from './use-quant';
import { DataTable, EmptyNote, ErrNote, LineChart, Panel, Pill, Segmented, StatGrid } from './quant-viz';
import { FlowPanel } from './panels-tape';
import { isoToDeribitLabel, type InspectTarget } from './trade-drawer';

interface ExpiryRow {
  expiry: string;
  dte: number;
  type: string;
  isAnchor: boolean;
  forward: number;
  atmIvPct: number;
  straddleUsd: number;
  rr25: number;
  fly25: number;
  oiContracts: number;
  oiUsd: number;
  callOi: number;
  putOi: number;
  putCallRatioOi: number;
  putCallRatioVol: number;
  netGexUsd1pct: number;
  maxPain: number;
  callVolumeUsd: number;
  putVolumeUsd: number;
}
interface SummaryData {
  spot: number;
  expiries: ExpiryRow[];
  totals: { oiUsd: number; volumeUsd24h: number; instruments: number; putCallRatioOi: number };
}
interface Side {
  bid: number;
  ask: number;
  mid: number;
  mark: number;
  ivPct: number;
  oi: number;
  oiUsd: number;
  volumeUsd: number;
  delta: number;
  gamma: number;
  vegaUsd: number;
  thetaUsd: number;
  spreadUsd: number;
}
interface ChainData {
  spot: number;
  expiry: string;
  dte: number;
  rows: { strike: number; forward: number; call: Side | null; put: Side | null }[];
}

export function ChainPanel({ symbol, hasOptions, onInspect }: { symbol: string; hasOptions: boolean; onInspect?: (t: InspectTarget) => void }) {
  if (!hasOptions) return <EmptyNote>{symbol} has no options chain on free venues (Deribit lists BTC/ETH).</EmptyNote>;
  const summary = useQuant<SummaryData>('/chain', { symbol, view: 'summary' }, { pollMs: 10000 });
  const [expiry, setExpiry] = useState<string>('');
  const [moneyness, setMoneyness] = useState<'5' | '10' | '20' | 'all'>('10');
  const activeExpiry = expiry || summary.data?.expiries[0]?.expiry || '';
  const chain = useQuant<ChainData>('/chain', { symbol, view: 'chain', expiry: activeExpiry, moneyness: moneyness === 'all' ? undefined : (Number(moneyness) / 100).toFixed(3) }, { pollMs: 6000, enabled: Boolean(activeExpiry) });
  const opex = useQuant<{ events: { expiry: string; dte: number; type: string; isAnchor: boolean; oiUsd: number; oiContracts: number; atmIvPct: number; maxPain: number; netGexUsd1pct: number; expectedMove1sUsd: number }[] }>('/chain', { symbol, view: 'opex', horizonDays: 60 }, { pollMs: 30000 });
  const [chainMode, setChainMode] = useState<'both' | 'call' | 'put'>('both');

  const rows = useMemo(() => chain.data?.rows ?? [], [chain.data]);
  const spot = summary.data?.spot ?? chain.data?.spot ?? 0;

  return (
    <div className="space-y-2">
      <ErrNote error={summary.error} />
      {summary.data && (
        <Panel title="Per-Expiry Summary" sub={`${summary.data.totals.instruments} live instruments · ${fmtUsd(summary.data.totals.volumeUsd24h, { compact: true })} 24h volume`} right={<Pill tone="teal">live chain</Pill>}>
          <StatGrid
            cols={4}
            stats={[
              { label: 'total oi notional', value: fmtUsd(summary.data.totals.oiUsd, { compact: true }), sub: 'calls + puts' },
              { label: '24h options volume', value: fmtUsd(summary.data.totals.volumeUsd24h, { compact: true }), sub: 'premium traded (usd)' },
              { label: 'put/call (oi)', value: summary.data.totals.putCallRatioOi.toFixed(2), sub: 'positioning skew' },
              { label: 'active expiries', value: summary.data.expiries.length, sub: 'deribit' },
            ]}
          />
          <div className="mt-2">
            <DataTable<ExpiryRow>
              rows={summary.data.expiries}
              maxRows={12}
              rowKey={(r) => r.expiry}
              highlight={(r) => r.expiry === activeExpiry}
              columns={[
                { key: 'expiry', label: 'expiry', align: 'l', render: (r) => <button className="font-mono text-teal-300 hover:underline" onClick={() => setExpiry(r.expiry)}>{r.expiry}</button> },
                { key: 'type', label: 'type', align: 'l', render: (r) => <span className="text-[8.5px] text-zinc-500">{r.isAnchor ? '◆ ' : ''}{r.type}</span> },
                { key: 'dte', label: 'dte', render: (r) => r.dte.toFixed(1) },
                { key: 'fwd', label: 'forward', render: (r) => fmtNum(r.forward, 0) },
                { key: 'iv', label: 'atm iv', render: (r) => (Number.isFinite(r.atmIvPct) ? `${r.atmIvPct.toFixed(1)}%` : '—') },
                { key: 'rr', label: '25Δ rr', render: (r) => (Number.isFinite(r.rr25) ? r.rr25.toFixed(1) : '—') },
                { key: 'straddle', label: 'straddle', render: (r) => (Number.isFinite(r.straddleUsd) ? fmtUsd(r.straddleUsd, { compact: true }) : '—') },
                { key: 'oi', label: 'oi $', render: (r) => fmtUsd(r.oiUsd, { compact: true }) },
                { key: 'pcr', label: 'pcr', render: (r) => (Number.isFinite(r.putCallRatioOi) ? r.putCallRatioOi.toFixed(2) : '—') },
                { key: 'gex', label: 'net gex', render: (r) => <span className={r.netGexUsd1pct >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{fmtUsd(r.netGexUsd1pct, { compact: true, sign: true })}</span> },
                { key: 'pain', label: 'max pain', render: (r) => (r.maxPain != null ? fmtNum(r.maxPain, 0) : '—') },
              ]}
            />
          </div>
        </Panel>
      )}

      <Panel
        title={`Option Chain · ${activeExpiry || '—'}`}
        sub="premiums in underlying units · greeks computed natively (Black-76 on venue forwards/IV) · click any mid price to open the order anatomy drawer"
        right={
          <>
            <Segmented value={chainMode} onChange={setChainMode} options={[{ id: 'both', label: 'Both' }, { id: 'call', label: 'Calls' }, { id: 'put', label: 'Puts' }]} />
            <Segmented value={moneyness} onChange={setMoneyness} options={[{ id: '5', label: '±5%' }, { id: '10', label: '±10%' }, { id: '20', label: '±20%' }, { id: 'all', label: 'All' }]} />
          </>
        }
      >
        <ErrNote error={chain.error} />
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[9px]">
              <thead>
                <tr className="border-b border-zinc-800/70 text-[7.5px] uppercase tracking-[0.1em] text-zinc-600">
                  {chainMode !== 'put' && ['bid', 'ask', 'mid', 'iv%', 'oi', 'δ', 'γ', 'vega'].map((h) => <th key={`c${h}`} className="px-1 py-1 text-right font-semibold">{h}</th>)}
                  <th className="px-1 py-1 text-center font-semibold text-teal-400">strike</th>
                  {chainMode !== 'call' && ['bid', 'ask', 'mid', 'iv%', 'oi', 'δ', 'γ', 'vega'].map((h) => <th key={`p${h}`} className="px-1 py-1 text-right font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const atm = Math.abs(r.strike / spot - 1) < 0.012;
                  const openDrawer = (isCall: boolean) => {
                    if (!onInspect || !activeExpiry) return;
                    onInspect({
                      instrument: `${symbol}-${isoToDeribitLabel(activeExpiry)}-${r.strike}-${isCall ? 'C' : 'P'}`,
                      symbol,
                      expiry: activeExpiry,
                      strike: r.strike,
                      kind: isCall ? 'call' : 'put',
                      from: { kind: 'chain' },
                    });
                  };
                  return (
                    <tr key={r.strike} className={`border-b border-zinc-900/60 hover:bg-zinc-900/40 ${atm ? 'bg-teal-950/20' : ''}`}>
                      {chainMode !== 'put' && (
                        <>
                          <td className="px-1 py-0.5 text-right font-mono text-emerald-300/90">{r.call ? r.call.bid.toFixed(4) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-emerald-300/90">{r.call ? r.call.ask.toFixed(4) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono">
                            {r.call ? (
                              <button onClick={() => openDrawer(true)} className="font-mono text-zinc-200 underline decoration-zinc-700 decoration-dotted underline-offset-2 hover:text-teal-300 hover:decoration-teal-500" title="open order anatomy">
                                {r.call.mid.toFixed(4)}
                              </button>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-400">{r.call ? r.call.ivPct.toFixed(1) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-400">{r.call ? r.call.oi.toFixed(0) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-500">{r.call ? r.call.delta.toFixed(2) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-500">{r.call ? (r.call.gamma * 1000).toFixed(3) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-500">{r.call ? r.call.vegaUsd.toFixed(0) : '—'}</td>
                        </>
                      )}
                      <td className={`px-1.5 py-0.5 text-center font-mono font-semibold ${atm ? 'text-teal-300' : 'text-zinc-200'}`}>{fmtNum(r.strike, 0)}</td>
                      {chainMode !== 'call' && (
                        <>
                          <td className="px-1 py-0.5 text-right font-mono text-rose-300/90">{r.put ? r.put.bid.toFixed(4) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-rose-300/90">{r.put ? r.put.ask.toFixed(4) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono">
                            {r.put ? (
                              <button onClick={() => openDrawer(false)} className="font-mono text-zinc-200 underline decoration-zinc-700 decoration-dotted underline-offset-2 hover:text-teal-300 hover:decoration-teal-500" title="open order anatomy">
                                {r.put.mid.toFixed(4)}
                              </button>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-400">{r.put ? r.put.ivPct.toFixed(1) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-400">{r.put ? r.put.oi.toFixed(0) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-500">{r.put ? r.put.delta.toFixed(2) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-500">{r.put ? (r.put.gamma * 1000).toFixed(3) : '—'}</td>
                          <td className="px-1 py-0.5 text-right font-mono text-zinc-500">{r.put ? r.put.vegaUsd.toFixed(0) : '—'}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyNote>{chain.loading ? 'loading chain…' : 'no rows in range'}</EmptyNote>
        )}
      </Panel>

      <Panel title="OPEX Calendar · next 60 days" sub="◆ anchor (monthly/quarterly) expiries" right={<Pill>event risk</Pill>}>
        {opex.data?.events?.length ? (
          <DataTable
            rows={opex.data.events}
            maxRows={12}
            rowKey={(r) => r.expiry}
            highlight={(r) => r.isAnchor}
            columns={[
              { key: 'expiry', label: 'expiry', align: 'l', render: (r) => <span className="font-mono">{r.isAnchor ? '◆ ' : ''}{r.expiry}</span> },
              { key: 'dte', label: 'dte', render: (r) => r.dte.toFixed(1) },
              { key: 'type', label: 'type', align: 'l', render: (r) => <span className="text-[8.5px] text-zinc-500">{r.type}</span> },
              { key: 'oi', label: 'oi rolling off', render: (r) => fmtUsd(r.oiUsd, { compact: true }) },
              { key: 'iv', label: 'atm iv', render: (r) => (Number.isFinite(r.atmIvPct) ? `${r.atmIvPct.toFixed(1)}%` : '—') },
              { key: 'em', label: '1σ move', render: (r) => fmtUsd(r.expectedMove1sUsd, { compact: true }) },
              { key: 'pain', label: 'max pain', render: (r) => (r.maxPain != null ? fmtNum(r.maxPain, 0) : '—') },
              { key: 'gex', label: 'net gex', render: (r) => <span className={r.netGexUsd1pct >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{fmtUsd(r.netGexUsd1pct, { compact: true, sign: true })}</span> },
            ]}
          />
        ) : (
          <EmptyNote>{opex.loading ? 'loading…' : '—'}</EmptyNote>
        )}
      </Panel>
    </div>
  );
}

// ── OI & flow ────────────────────────────────────────────────────────────────

export function OiPanel({ symbol, hasOptions }: { symbol: string; hasOptions: boolean }) {
  const oi = useQuant<{ totalOiUsd: number; byExpiry: { expiry: string; dte: number; type: string; callOi: number; putOi: number; oiContracts: number; oiUsd: number; callOiUsd: number; putOiUsd: number }[] }>('/oi', { symbol, view: 'by-expiry' }, { pollMs: 15000, enabled: hasOptions });
  const term = useQuant<{ spot: number; perpMark: number; perpBasisPct: number; futures: { instrument: string; mark: number; oi: number; basisPct: number; dte: number }[] }>('/oi', { symbol, view: 'term' }, { pollMs: 20000 });
  const oiHist = useQuant<{ points: { ts: number; value: number }[] }>('/oi', { symbol, view: 'history', days: 7 }, { pollMs: 60000 });

  return (
    <div className="space-y-2">
      {!hasOptions && <EmptyNote>{symbol} has no options chain — showing perp/futures structure only.</EmptyNote>}
      {hasOptions && (
        <Panel title="Open Interest by Expiry" sub="calls vs puts · live deribit chain" right={<Pill tone="teal">{oi.data ? fmtUsd(oi.data.totalOiUsd, { compact: true }) : '…'} total</Pill>}>
          <ErrNote error={oi.error} />
          {oi.data?.byExpiry?.length ? (
            <DataTable
              rows={oi.data.byExpiry}
              maxRows={12}
              rowKey={(r) => r.expiry}
              columns={[
                { key: 'expiry', label: 'expiry', align: 'l', render: (r) => r.expiry },
                { key: 'dte', label: 'dte', render: (r) => r.dte.toFixed(1) },
                { key: 'call', label: 'call oi', render: (r) => fmtNum(r.callOi, 0) },
                { key: 'put', label: 'put oi', render: (r) => fmtNum(r.putOi, 0) },
                { key: 'pcr', label: 'pcr', render: (r) => (r.callOi > 0 ? <span className={r.putOi / r.callOi >= 1 ? 'text-rose-300' : 'text-emerald-300'}>{(r.putOi / r.callOi).toFixed(2)}</span> : '—') },
                { key: 'oiUsd', label: 'oi $', render: (r) => fmtUsd(r.oiUsd, { compact: true }) },
              ]}
            />
          ) : (
            <EmptyNote>{oi.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>
      )}
      <div className="grid gap-2 xl:grid-cols-2">
        <Panel title="Futures Term Structure" sub="deribit dated futures · annualized basis vs spot">
          <ErrNote error={term.error} />
          {term.data?.futures?.length ? (
            <DataTable
              rows={term.data.futures}
              maxRows={10}
              rowKey={(r) => r.instrument}
              columns={[
                { key: 'inst', label: 'future', align: 'l', render: (r) => r.instrument.replace(`${symbol}-`, '') },
                { key: 'dte', label: 'dte', render: (r) => r.dte.toFixed(0) },
                { key: 'mark', label: 'mark', render: (r) => fmtNum(r.mark, 0) },
                { key: 'basis', label: 'basis (ann.)', render: (r) => <span className={r.basisPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{Number.isFinite(r.basisPct) ? `${(r.basisPct * 100).toFixed(2)}%` : '—'}</span> },
                { key: 'oi', label: 'oi $', render: (r) => fmtUsd(r.oi, { compact: true }) },
              ]}
            />
          ) : (
            <EmptyNote>{term.loading ? 'loading…' : '—'}</EmptyNote>
          )}
        </Panel>
        <Panel title="Options OI · 7d History" sub="our snapshot store (SQLite)">
          {oiHist.data?.points?.length ? (
            <LineChart
              height={150}
              yFormat={(v) => fmtUsd(v, { compact: true })}
              series={[{ label: 'oi notional', points: oiHist.data.points.map((p) => ({ x: p.ts, y: p.value })) }]}
              xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            />
          ) : (
            <EmptyNote>history accrues every ~2 min — check back soon</EmptyNote>
          )}
        </Panel>
      </div>
      {hasOptions && <FlowPanel symbol={symbol} />}
    </div>
  );
}

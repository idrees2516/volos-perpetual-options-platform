'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-risk — PORTFOLIO & ORDER RISK: the control room for every
// position and order. Live greeks per leg (the same numbers the engine uses),
// portfolio totals, the full spot×vol scenario P&L matrix (click any cell),
// working orders with fill-odds, per-position payoff drill-down and the
// WHAT-IF structure lab (pick legs → instant greeks + payoff + break-evens).
// -----------------------------------------------------------------------------

import React, { useMemo, useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant, useAgeLabel } from './use-quant';
import { DataTable, EmptyNote, ErrNote, LiveDot, Panel, Pill, Segmented, StatGrid } from './quant-viz';
import { AnimatedNumber, CrosshairChart, ScenarioHeatmap } from './viz-deep';

interface RiskLeg {
  positionId: string;
  symbol: string;
  instrument: string;
  expiry: string;
  expiryTs: number;
  dte: number;
  strike: number;
  kind: 'call' | 'put';
  side: 'long' | 'short';
  qty: number;
  signedQty: number;
  entry: number;
  mark: number;
  markUsd: number;
  unrealizedUsd: number;
  unrealizedPct: number;
  iv: number;
  deltaUsd: number;
  gammaUsd1pct: number;
  vegaUsdPt: number;
  thetaUsdDay: number;
  probItm: number;
  breakEven: number;
  breakEvenSigma: number;
  strategyTag: string | null;
  venue: string;
}

interface RiskData {
  asOf: number;
  equity: number;
  cash: number;
  marginUsed: number;
  legs: RiskLeg[];
  positionsWithoutChain: { positionId: string; symbol: string; note: string }[];
  totals: { deltaUsdByAsset: Record<string, number>; netDeltaUsd: number; gammaUsd1pct: number; vegaUsdPt: number; thetaUsdDay: number; grossExposureUsd: number };
  scenarios: { symbol: string; spot: number; spotSteps: number[]; volSteps: number[]; pnlUsd: number[][]; current: { spotIdx: number; volIdx: number } }[];
  openOrders: { orderId: string; symbol: string; instrument: string; side: 'buy' | 'sell'; qty: number; limitPrice: number; mark: number; distanceUsd: number; fillOddsPct: number | null; iv: number; dte: number; greeksIfFilled: { deltaUsd: number; gammaUsd1pct: number; vegaUsdPt: number; thetaUsdDay: number } | null }[];
  concentration: { symbol: string; notionalUsd: number; share: number }[];
  note: string;
}

interface WhatIfData {
  legs: { symbol: string; instrument: string; expiry: string; strike: number; kind: string; side: string; qty: number; signedQty: number; mark: number; iv: number; dte: number; deltaUsd: number; gammaUsd1pct: number; vegaUsdPt: number; thetaUsdDay: number }[];
  totals: { premiumUsd: number; deltaUsd: number; gammaUsd1pct: number; vegaUsdPt: number; thetaUsdDay: number };
  payoff: { spot: number; pnlUsd: number }[];
  breakEvens: number[];
  note: string;
}

// ── main panel ───────────────────────────────────────────────────────────────

export function RiskPanel({ symbol: focusSymbol }: { symbol: string }) {
  const risk = useQuant<RiskData>('/risk', undefined, { pollMs: 12000 });
  const age = useAgeLabel(risk.fetchedAt);
  const [selId, setSelId] = useState<string | null>(null);
  const [scenarioAsset, setScenarioAsset] = useState<string>('');
  const d = risk.data;
  const activeAsset = scenarioAsset || d?.scenarios[0]?.symbol || focusSymbol;
  const scenario = d?.scenarios.find((s) => s.symbol === activeAsset) ?? d?.scenarios[0];
  const selLeg = d?.legs.find((l) => l.positionId === selId) ?? null;

  return (
    <div className="space-y-2">
      <ErrNote error={risk.error} />
      {!d && risk.loading && <EmptyNote>joining the paper account against the live chain…</EmptyNote>}
      {d && (
        <>
          {/* ── account + portfolio greeks ── */}
          <Panel
            title="Portfolio Greeks · LIVE"
            sub={d.note}
            right={<LiveDot ok={!risk.error} label={`live · ${age}`} />}
          >
            <StatGrid
              cols={4}
              stats={[
                { label: 'equity', value: <AnimatedNumber value={d.equity} format={(v) => fmtUsd(v, { compact: true })} />, tone: 'teal', sub: `cash ${fmtUsd(d.cash, { compact: true })} · margin ${fmtUsd(d.marginUsed, { compact: true })}` },
                { label: 'net delta $', value: <AnimatedNumber value={d.totals.netDeltaUsd} format={(v) => fmtUsd(v, { compact: true, sign: true })} />, tone: d.totals.netDeltaUsd >= 0 ? 'emerald' : 'rose', sub: Object.entries(d.totals.deltaUsdByAsset).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${fmtNum(v / 1000, 0)}k`).join(' · ') || 'flat' },
                { label: 'gamma $/1%', value: <AnimatedNumber value={d.totals.gammaUsd1pct} format={(v) => fmtUsd(v, { compact: true, sign: true })} />, tone: d.totals.gammaUsd1pct >= 0 ? 'emerald' : 'rose', sub: d.totals.gammaUsd1pct >= 0 ? 'long gamma — dampened' : 'short gamma — amplified' },
                { label: 'vega $/pt', value: <AnimatedNumber value={d.totals.vegaUsdPt} format={(v) => fmtUsd(v, { compact: true, sign: true })} />, tone: d.totals.vegaUsdPt >= 0 ? 'emerald' : 'rose', sub: 'per 1 vol point' },
                { label: 'theta $/day', value: <AnimatedNumber value={d.totals.thetaUsdDay} format={(v) => fmtUsd(v, { compact: true, sign: true })} />, tone: d.totals.thetaUsdDay >= 0 ? 'emerald' : 'rose', sub: 'daily bleed/earn' },
                { label: 'gross exposure', value: fmtUsd(d.totals.grossExposureUsd, { compact: true }), sub: d.concentration.map((c) => `${c.symbol} ${(c.share * 100).toFixed(0)}%`).join(' · ') || '—' },
                { label: 'live legs', value: d.legs.length, sub: `${d.openOrders.length} working orders` },
                { label: 'unrealized', value: fmtUsd(d.legs.reduce((s, l) => s + l.unrealizedUsd, 0), { compact: true, sign: true }), tone: d.legs.reduce((s, l) => s + l.unrealizedUsd, 0) >= 0 ? 'emerald' : 'rose', sub: 'marks vs entries' },
              ]}
            />
          </Panel>

          {/* ── positions table ── */}
          <Panel title="Positions · every leg, live greeks" sub="click a row for the full order drill-down (payoff, break-evens, P(ITM))" right={<Pill tone="teal">{d.legs.length} legs</Pill>}>
            {d.legs.length ? (
              <DataTable<RiskLeg>
                rows={d.legs}
                maxRows={16}
                rowKey={(r) => r.positionId}
                highlight={(r) => r.positionId === selId}
                columns={[
                  {
                    key: 'inst',
                    label: 'instrument',
                    align: 'l',
                    render: (r) => (
                      <button className="text-left hover:underline" onClick={() => setSelId(r.positionId === selId ? null : r.positionId)}>
                        <span className={r.kind === 'call' ? 'text-emerald-300' : 'text-rose-300'}>{r.instrument.replace(`${r.symbol}-`, '')}</span>
                        <span className={`ml-1.5 rounded px-1 text-[7px] font-bold uppercase ${r.side === 'long' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>{r.side}</span>
                        {r.strategyTag && <span className="ml-1 text-[7px] text-violet-400">{r.strategyTag}</span>}
                      </button>
                    ),
                  },
                  { key: 'qty', label: 'qty', render: (r) => fmtNum(r.qty, r.qty >= 100 ? 0 : 1) },
                  { key: 'entry', label: 'entry → mark', render: (r) => <span className="font-mono">{r.entry.toFixed(4)} → {r.mark.toFixed(4)}</span> },
                  { key: 'upnl', label: 'u-pnl', render: (r) => <span className={r.unrealizedUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{fmtUsd(r.unrealizedUsd, { compact: true, sign: true })} <span className="text-[7.5px] text-zinc-600">({r.unrealizedPct >= 0 ? '+' : ''}{Number.isFinite(r.unrealizedPct) ? r.unrealizedPct.toFixed(0) : '—'}%)</span></span> },
                  { key: 'delta', label: 'δ $', render: (r) => fmtUsd(r.deltaUsd, { compact: true, sign: true }) },
                  { key: 'gamma', label: 'γ $/1%', render: (r) => fmtUsd(r.gammaUsd1pct, { compact: true, sign: true }) },
                  { key: 'vega', label: 'ν $/pt', render: (r) => fmtUsd(r.vegaUsdPt, { compact: true, sign: true }) },
                  { key: 'theta', label: 'θ $/d', render: (r) => fmtUsd(r.thetaUsdDay, { compact: true, sign: true }) },
                  { key: 'pitm', label: 'p(itm)', render: (r) => (Number.isFinite(r.probItm) ? `${(r.probItm * 100).toFixed(0)}%` : '—') },
                  { key: 'be', label: 'break-even', render: (r) => <span title={`${r.breakEvenSigma.toFixed(2)}σ away`}>{fmtNum(r.breakEven, 0)}</span> },
                  { key: 'dte', label: 'dte', render: (r) => r.dte.toFixed(1) },
                ]}
              />
            ) : (
              <EmptyNote>no option positions in the paper book — place one from the Tape/Chain drill-down or the Paper tab, then watch it here with live greeks</EmptyNote>
            )}
            {d.positionsWithoutChain.map((p) => (
              <p key={p.positionId} className="mt-1 text-[9px] text-zinc-600">
                {p.symbol}: {p.note}
              </p>
            ))}
          </Panel>

          {/* ── selected position drill-down ── */}
          {selLeg && <PositionDrill leg={selLeg} />}

          {/* ── scenario matrix ── */}
          {scenario && scenario.pnlUsd.length > 0 && (
            <Panel
              title="Scenario Matrix · full Black-76 reprice"
              sub="portfolio P&L if spot moves ±10% AND vol shifts ±8pts — every leg repriced, non-linear effects included"
              right={
                d.scenarios.length > 1 ? (
                  <Segmented value={activeAsset} onChange={setScenarioAsset} options={d.scenarios.map((s) => ({ id: s.symbol, label: s.symbol }))} />
                ) : (
                  <Pill tone="violet">{scenario.symbol}</Pill>
                )
              }
            >
              <ScenarioHeatmap spot={scenario.spot} spotSteps={scenario.spotSteps} volSteps={scenario.volSteps} pnlUsd={scenario.pnlUsd} />
              <p className="mt-1.5 text-[8.5px] text-zinc-600">columns: spot % move (actual price under) · rows: parallel vol shift in points · current cell outlined</p>
            </Panel>
          )}

          {/* ── working orders ── */}
          <Panel title="Working Orders" sub="every resting limit order with live fill-odds (probability the market touches your level before expiry)">
            {d.openOrders.length ? (
              <DataTable
                rows={d.openOrders}
                maxRows={10}
                rowKey={(o) => o.orderId}
                columns={[
                  { key: 'inst', label: 'instrument', align: 'l', render: (o) => <span className={o.instrument.includes('-C') ? 'text-emerald-300' : 'text-rose-300'}>{o.instrument.replace(`${o.symbol}-`, '')}</span> },
                  { key: 'side', label: 'side', render: (o) => <span className={`font-bold ${o.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{o.side.toUpperCase()}</span> },
                  { key: 'qty', label: 'qty', render: (o) => fmtNum(o.qty, 0) },
                  { key: 'limit', label: 'limit', render: (o) => o.limitPrice.toFixed(4) },
                  { key: 'mark', label: 'mark', render: (o) => (Number.isFinite(o.mark) ? o.mark.toFixed(4) : '—') },
                  { key: 'dist', label: 'distance', render: (o) => (Number.isFinite(o.distanceUsd) ? <span className={o.distanceUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{o.distanceUsd >= 0 ? '+' : ''}{o.distanceUsd.toFixed(4)}</span> : '—') },
                  {
                    key: 'odds',
                    label: 'fill odds',
                    render: (o) =>
                      o.fillOddsPct != null ? (
                        <span className="flex items-center justify-end gap-1.5">
                          <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-zinc-800">
                            <span className={`absolute inset-y-0 left-0 rounded-full ${o.fillOddsPct >= 60 ? 'bg-emerald-400' : o.fillOddsPct >= 30 ? 'bg-teal-400/70' : 'bg-amber-400/70'}`} style={{ width: `${o.fillOddsPct}%` }} />
                          </span>
                          <span className="font-mono">{o.fillOddsPct.toFixed(0)}%</span>
                        </span>
                      ) : (
                        '—'
                      ),
                  },
                  { key: 'dte', label: 'dte', render: (o) => o.dte.toFixed(1) },
                  {
                    key: 'gif',
                    label: 'if filled: δ$',
                    render: (o) => (o.greeksIfFilled ? fmtUsd(o.greeksIfFilled.deltaUsd, { compact: true, sign: true }) : '—'),
                  },
                ]}
              />
            ) : (
              <EmptyNote>no working orders — resting limits show up here with live fill probabilities</EmptyNote>
            )}
          </Panel>

          {/* ── what-if lab ── */}
          <WhatIfLab defaultSymbol={focusSymbol} />
        </>
      )}
    </div>
  );
}

// ── per-position drill-down ─────────────────────────────────────────────────

function PositionDrill({ leg }: { leg: RiskLeg }) {
  const spotRef = leg.strike; // strike-anchored grid
  const payoff = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    const lo = spotRef * 0.7;
    const hi = spotRef * 1.3;
    for (let i = 0; i <= 60; i++) {
      const S = lo + ((hi - lo) * i) / 60;
      // intrinsic at expiry; the entry mark (underlying units) is worth mark × S
      const v = leg.kind === 'call' ? Math.max(S - leg.strike, 0) : Math.max(leg.strike - S, 0);
      const pnl = leg.signedQty * (v - leg.mark * S);
      pts.push({ x: S, y: pnl });
    }
    return pts;
  }, [leg]);
  return (
    <Panel
      title={`Order Drill-Down · ${leg.instrument}`}
      sub={`${leg.side} ${fmtNum(leg.qty, 1)} contracts · entry ${leg.entry.toFixed(4)} → mark ${leg.mark.toFixed(4)} · expires ${leg.expiry} (${leg.dte.toFixed(1)}d)`}
      right={
        <>
          <span className={`rounded px-1.5 py-0.5 text-[8px] font-bold uppercase ${leg.unrealizedUsd >= 0 ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>{fmtUsd(leg.unrealizedUsd, { compact: true, sign: true })}</span>
          {leg.strategyTag && <Pill tone="violet">{leg.strategyTag}</Pill>}
        </>
      }
    >
      <div className="grid gap-3 xl:grid-cols-[1fr_minmax(260px,320px)]">
        <div>
          <CrosshairChart
            height={200}
            series={[{ label: 'p&L at expiry', points: payoff, area: true }]}
            yFormat={(v) => fmtUsd(v, { compact: true })}
            xFormat={(v) => fmtNum(v, 0)}
            yZero
            spot={{ x: leg.strike, y: 0 }}
          />
          <p className="mt-1 text-[8.5px] text-zinc-600">dashed line = strike · chart = P&L at expiry (live IV, Black-76)</p>
        </div>
        <div className="space-y-2">
          <StatGrid
            cols={2}
            stats={[
              { label: 'break-even', value: fmtNum(leg.breakEven, 0), tone: 'violet', sub: `${Number.isFinite(leg.breakEvenSigma) ? leg.breakEvenSigma.toFixed(2) : '—'}σ from spot` },
              { label: 'p(finish itm)', value: Number.isFinite(leg.probItm) ? `${(leg.probItm * 100).toFixed(0)}%` : '—', tone: 'teal' },
              { label: 'iv now', value: `${(leg.iv * 100).toFixed(1)}%` },
              { label: 'premium at risk', value: fmtUsd(Math.abs(leg.markUsd), { compact: true }), sub: leg.side === 'short' ? 'short: premium received' : 'long: premium paid' },
              { label: 'delta $', value: fmtUsd(leg.deltaUsd, { compact: true, sign: true }), tone: leg.deltaUsd >= 0 ? 'emerald' : 'rose' },
              { label: 'gamma $/1%', value: fmtUsd(leg.gammaUsd1pct, { compact: true, sign: true }), tone: leg.gammaUsd1pct >= 0 ? 'emerald' : 'rose' },
              { label: 'vega $/pt', value: fmtUsd(leg.vegaUsdPt, { compact: true, sign: true }) },
              { label: 'theta $/day', value: fmtUsd(leg.thetaUsdDay, { compact: true, sign: true }), tone: leg.thetaUsdDay >= 0 ? 'emerald' : 'rose' },
            ]}
          />
        </div>
      </div>
    </Panel>
  );
}

// ── what-if structure lab ───────────────────────────────────────────────────

interface ExpiryRow { expiry: string; dte: number; atmIvPct: number }
interface ChainRow { strike: number; call: { mid: number; ivPct: number } | null; put: { mid: number; ivPct: number } | null }

function WhatIfLab({ defaultSymbol }: { defaultSymbol: string }) {
  const [symbol, setSymbol] = useState<'BTC' | 'ETH'>(defaultSymbol === 'ETH' ? 'ETH' : 'BTC');
  const [legs, setLegs] = useState<{ expiry: string; strike: number; kind: 'call' | 'put'; side: 'buy' | 'sell'; qty: number }[]>([]);
  const [result, setResult] = useState<WhatIfData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const summary = useQuant<{ expiries: ExpiryRow[] }>('/chain', { symbol, view: 'summary' }, { pollMs: 30000 });
  const [expiry, setExpiry] = useState('');
  const activeExpiry = expiry || summary.data?.expiries[0]?.expiry || '';
  const chain = useQuant<{ rows: ChainRow[] }>('/chain', { symbol, view: 'chain', expiry: activeExpiry, moneyness: '0.15' }, { pollMs: 30000, enabled: Boolean(activeExpiry) });
  const [strike, setStrike] = useState<number | ''>('');
  const [kind, setKind] = useState<'call' | 'put'>('call');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState('1');

  const strikes = chain.data?.rows ?? [];
  const pickRow = strikes.find((r) => r.strike === Number(strike));

  const addLeg = () => {
    const s = Number(strike);
    if (!activeExpiry || !Number.isFinite(s) || s <= 0) return;
    setLegs((ls) => [...ls, { expiry: activeExpiry, strike: s, kind, side, qty: Math.max(0.1, Number(qty) || 1) }]);
  };

  const runWhatIf = async () => {
    if (!legs.length) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/quant/risk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legs: legs.map((l) => ({ ...l, symbol })) }),
      });
      const env = (await res.json()) as { success: boolean; data: WhatIfData | null; error?: { message: string } };
      if (env.success && env.data) setResult(env.data);
      else setErr(env.error?.message ?? 'what-if failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="What-If Structure Lab"
      sub="compose any structure from the live chain → instant portfolio-grade greeks, payoff and break-evens"
      right={
        <Segmented
          value={symbol}
          onChange={(v) => {
            setSymbol(v as 'BTC' | 'ETH');
            setExpiry('');
            setStrike('');
          }}
          options={[{ id: 'BTC', label: 'BTC' }, { id: 'ETH', label: 'ETH' }]}
        />
      }
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[7.5px] font-semibold uppercase tracking-[0.12em] text-zinc-600">expiry</span>
          <select value={activeExpiry} onChange={(e) => { setExpiry(e.target.value); setStrike(''); }} className="rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-1 font-mono text-[10px] text-zinc-200 outline-none focus:border-teal-700">
            {(summary.data?.expiries ?? []).slice(0, 16).map((e) => (
              <option key={e.expiry} value={e.expiry}>
                {e.expiry} ({e.dte.toFixed(0)}d{Number.isFinite(e.atmIvPct) ? ` · ${e.atmIvPct.toFixed(0)}%` : ''})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[7.5px] font-semibold uppercase tracking-[0.12em] text-zinc-600">strike</span>
          <select value={strike === '' ? '' : String(strike)} onChange={(e) => setStrike(e.target.value ? Number(e.target.value) : '')} className="rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-1 font-mono text-[10px] text-zinc-200 outline-none focus:border-teal-700">
            <option value="">select…</option>
            {strikes.map((r) => (
              <option key={r.strike} value={r.strike}>
                {fmtNum(r.strike, 0)}{r.call ? ` C ${r.call.mid.toFixed(4)}` : ''}{r.put ? ` · P ${r.put.mid.toFixed(4)}` : ''}
              </option>
            ))}
          </select>
        </label>
        <Segmented value={kind} onChange={setKind} options={[{ id: 'call', label: 'Call' }, { id: 'put', label: 'Put' }]} />
        <Segmented value={side} onChange={setSide} options={[{ id: 'buy', label: 'Buy' }, { id: 'sell', label: 'Sell' }]} />
        <label className="flex flex-col gap-0.5">
          <span className="text-[7.5px] font-semibold uppercase tracking-[0.12em] text-zinc-600">qty</span>
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" className="w-16 rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-1 font-mono text-[10px] text-zinc-200 outline-none focus:border-teal-700" />
        </label>
        <button onClick={addLeg} disabled={!strike || !activeExpiry} className="rounded-md border border-teal-800/60 bg-teal-950/40 px-2.5 py-1 text-[9.5px] font-semibold text-teal-300 transition hover:bg-teal-900/40 disabled:opacity-40">
          + add leg
        </button>
        {pickRow && activeExpiry && (
          <span className="font-mono text-[9px] text-zinc-500">
            {symbol}-{activeExpiry.replace(/-/g, '')}-{fmtNum(Number(strike), 0)}-{kind === 'call' ? 'C' : 'P'} · mark{' '}
            <span className="text-zinc-300">{(kind === 'call' ? pickRow.call?.mid : pickRow.put?.mid)?.toFixed(4) ?? '—'}</span> · iv{' '}
            <span className="text-teal-300">{(kind === 'call' ? pickRow.call?.ivPct : pickRow.put?.ivPct)?.toFixed(1) ?? '—'}%</span>
          </span>
        )}
      </div>

      {legs.length > 0 && (
        <div className="mt-2 space-y-1">
          {legs.map((l, i) => (
            <div key={`${l.expiry}-${l.strike}-${l.kind}-${i}`} className="flex items-center gap-2 rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2 py-1 font-mono text-[9px]">
              <span className={l.kind === 'call' ? 'text-emerald-300' : 'text-rose-300'}>
                {symbol}-{l.expiry.replace(/-/g, '')}-{fmtNum(l.strike, 0)}-{l.kind === 'call' ? 'C' : 'P'}
              </span>
              <span className={l.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{l.side}</span>
              <span className="text-zinc-400">×{l.qty}</span>
              <button onClick={() => setLegs((ls) => ls.filter((_, j) => j !== i))} className="ml-auto text-[8px] text-zinc-600 hover:text-rose-400">
                remove
              </button>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button onClick={runWhatIf} disabled={busy} className="rounded-md border border-violet-800/60 bg-violet-950/40 px-3 py-1 text-[9.5px] font-semibold text-violet-300 transition hover:bg-violet-900/40 disabled:opacity-50">
              {busy ? 'pricing…' : `analyze structure (${legs.length} legs)`}
            </button>
            <button onClick={() => { setLegs([]); setResult(null); }} className="rounded-md border border-zinc-800 px-2.5 py-1 text-[9.5px] text-zinc-500 hover:text-zinc-300">
              clear
            </button>
          </div>
        </div>
      )}

      <ErrNote error={err} />
      {result && (
        <div className="mt-3 space-y-2">
          <StatGrid
            cols={5}
            stats={[
              { label: 'net premium', value: fmtUsd(result.totals.premiumUsd, { compact: true, sign: true }), tone: result.totals.premiumUsd <= 0 ? 'emerald' : 'rose', sub: result.totals.premiumUsd <= 0 ? 'credit' : 'debit' },
              { label: 'delta $', value: fmtUsd(result.totals.deltaUsd, { compact: true, sign: true }), tone: result.totals.deltaUsd >= 0 ? 'emerald' : 'rose' },
              { label: 'gamma $/1%', value: fmtUsd(result.totals.gammaUsd1pct, { compact: true, sign: true }), tone: result.totals.gammaUsd1pct >= 0 ? 'emerald' : 'rose' },
              { label: 'vega $/pt', value: fmtUsd(result.totals.vegaUsdPt, { compact: true, sign: true }), tone: result.totals.vegaUsdPt >= 0 ? 'emerald' : 'rose' },
              { label: 'theta $/day', value: fmtUsd(result.totals.thetaUsdDay, { compact: true, sign: true }), tone: result.totals.thetaUsdDay >= 0 ? 'emerald' : 'rose' },
            ]}
          />
          {result.payoff.length > 3 && (
            <div>
              <CrosshairChart
                height={210}
                series={[{ label: 'structure p&L at expiry', points: result.payoff.map((p) => ({ x: p.spot, y: p.pnlUsd })), area: true }]}
                yFormat={(v) => fmtUsd(v, { compact: true })}
                xFormat={(v) => fmtNum(v, 0)}
                yZero
              />
              {result.breakEvens.length > 0 && (
                <p className="mt-1 font-mono text-[9px] text-zinc-500">
                  break-evens: <span className="font-bold text-violet-300">{result.breakEvens.map((b) => fmtNum(b, 0)).join(' · ')}</span>
                </p>
              )}
            </div>
          )}
          <p className="text-[8.5px] text-zinc-600">{result.note}</p>
        </div>
      )}
      {!result && legs.length === 0 && <EmptyNote>add legs above — e.g. buy 1 call + sell 2 higher calls = a 1×2 call ratio, priced live</EmptyNote>}
    </Panel>
  );
}

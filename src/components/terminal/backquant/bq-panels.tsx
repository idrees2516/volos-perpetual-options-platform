'use client';

// -----------------------------------------------------------------------------
// backquant/bq-panels — GEX · Chain & OPEX · IV Analytics · Greeks & TRACE ·
// OI & Flow workspace panels. Each panel reads its endpoint(s) through the
// /api/backquant/* data plane and renders VolOS-styled analytics.
// -----------------------------------------------------------------------------

import React, { useMemo, useState } from 'react';
import { Panel, StatTiles, BqHeatMatrix, BqLevelStrip, BqSeriesChart, BqTable, panelProps, fmtUsd, fmtNum, fmtPx, fmtPct, fmtDate, CHART_COLORS, EmptyNote } from './bq-viz';
import { useBq } from './use-bq';

type Any = Record<string, unknown>;

// ═══════════════════════════════════════════════ GEX & POSITIONING ═══════════

export function GexPanel({ symbol }: { symbol: string }) {
  const levels = useBq<Any>('/gex/levels', { symbol, include: 'max_pain,expected_move' }, { pollMs: 45_000 });
  const profile = useBq<Any>('/gex/strike-profile', { symbol }, { pollMs: 60_000 });
  const heatmap = useBq<Any>('/gex/strike-expiry-heatmap', { symbol, max_strikes: 15, max_expiries: 7 }, { pollMs: 90_000 });
  const ladder = useBq<Any>('/gex/ladder', { symbol, metric: 'gamma', expiries: 5 }, { pollMs: 90_000 });
  const dealerFlow = useBq<Any>('/gex/dealer-flow', { symbol }, { pollMs: 60_000 });

  const lv = (levels.data ?? {}) as {
    all_expiry?: Record<string, number>;
    odte?: Record<string, number>;
    max_pain?: number;
    expected_move?: { one_sigma?: { low: number; high: number }; two_sigma?: { low: number; high: number } };
  };
  const spot = levels.meta?.spot_price ?? 0;
  const pf = (profile.data ?? {}) as { strikes?: number[]; net_gex?: number[]; call_gex?: number[]; put_gex?: number[]; total_oi?: number[]; ranked_top_10?: Array<{ strike: number; net_gex: number }> };
  const hm = (heatmap.data ?? {}) as { strikes?: number[]; expiries?: string[]; matrix?: number[][]; unit?: string; max_abs?: number };
  const lad = (ladder.data ?? {}) as { expiries?: string[]; rows?: Array<{ strike: number; distance_pct: number; total: number; per_expiry?: Record<string, number> }> };
  const df = (dealerFlow.data ?? {}) as { points?: Array<Record<string, number>> };

  const profilePoints = useMemo(() => {
    if (!pf.strikes) return [];
    return pf.strikes.map((k, i) => ({
      strike: k,
      net: pf.net_gex?.[i] ?? 0,
      call: pf.call_gex?.[i] ?? 0,
      put: pf.put_gex?.[i] ?? 0,
      oi: pf.total_oi?.[i] ?? 0,
    }));
  }, [pf]);

  const maxNet = Math.max(...profilePoints.map((p) => Math.abs(p.net)), 1);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="GEX Key Levels" subtitle={`${symbol} · HVL / walls / support · all-expiry + 0DTE`} {...panelProps(levels)}>
          {lv.all_expiry ? (
            <>
              <BqLevelStrip
                spot={spot}
                levels={[
                  { label: 'put wall 3', price: lv.all_expiry.put_wall_3 ?? 0, tone: 'support' },
                  { label: 'put wall 2', price: lv.all_expiry.put_wall_2 ?? 0, tone: 'support' },
                  { label: 'put support', price: lv.all_expiry.put_support ?? 0, tone: 'support' },
                  { label: 'HVL (flip)', price: lv.all_expiry.hvl ?? 0, tone: 'flip' },
                  { label: 'call wall', price: lv.all_expiry.call_resistance ?? 0, tone: 'wall' },
                  { label: 'call wall 2', price: lv.all_expiry.call_wall_2 ?? 0, tone: 'wall' },
                  { label: 'call wall 3', price: lv.all_expiry.call_wall_3 ?? 0, tone: 'wall' },
                  ...(lv.max_pain ? [{ label: 'max pain', price: lv.max_pain, tone: 'magnet' as const }] : []),
                ]}
              />
              <div className="mt-3">
                <StatTiles
                  stats={[
                    { label: 'HVL · gamma flip', value: fmtPx(lv.all_expiry.hvl), hint: 'dealer gamma flips sign' },
                    { label: 'call wall', value: fmtPx(lv.all_expiry.call_resistance), hint: 'largest call gamma above' },
                    { label: 'put support', value: fmtPx(lv.all_expiry.put_support), hint: 'largest put gamma below' },
                    { label: '0DTE HVL', value: fmtPx(lv.odte?.hvl), hint: 'same-expiry flip' },
                    ...(lv.expected_move?.one_sigma
                      ? [{ label: '1σ expected move', value: `${fmtPx(lv.expected_move.one_sigma.low)} – ${fmtPx(lv.expected_move.one_sigma.high)}`, hint: 'ATM straddle implied' }]
                      : []),
                  ]}
                />
              </div>
            </>
          ) : (
            <EmptyNote text="no levels" />
          )}
        </Panel>

        <Panel title="GEX by Strike" subtitle="net / call / put gamma exposure per strike" {...panelProps(profile)}>
          {profilePoints.length ? (
            <>
              <div className="space-y-[3px]">
                {profilePoints.map((p) => {
                  const w = (Math.abs(p.net) / maxNet) * 50;
                  const pos = p.net >= 0;
                  return (
                    <div key={p.strike} className="group flex items-center gap-1 text-[9px]" title={`strike ${fmtPx(p.strike)} · net ${fmtUsd(p.net)} / 1% · call ${fmtUsd(p.call)} · put ${fmtUsd(p.put)} · OI ${fmtNum(p.oi, 0)}`}>
                      <span className={`w-[52px] shrink-0 text-right font-mono tabular-nums ${Math.abs(p.strike - spot) < (spot * 0.005) ? 'font-bold text-zinc-100' : 'text-zinc-500'}`}>{fmtPx(p.strike)}</span>
                      <div className="relative flex h-[11px] min-w-0 flex-1 items-center justify-center">
                        <div className="absolute inset-y-[5px] left-0 right-0 bg-zinc-800/40" />
                        {pos ? (
                          <div className="absolute left-1/2 h-full rounded-l-sm bg-teal-500/60" style={{ width: `${w}%` }} />
                        ) : (
                          <div className="absolute right-1/2 h-full rounded-r-sm bg-rose-500/60" style={{ width: `${w}%` }} />
                        )}
                        <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-700" />
                      </div>
                      <span className={`w-[58px] shrink-0 text-right font-mono tabular-nums ${pos ? 'text-teal-300' : 'text-rose-300'}`}>{fmtUsd(p.net)}</span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[8px] text-zinc-600">$ per 1% spot move · teal = dealers long gamma (absorbing) · rose = short (accelerating)</p>
            </>
          ) : (
            <EmptyNote text="no strike profile" />
          )}
        </Panel>
      </div>

      <Panel title="Strike × Expiry GEX Heatmap" subtitle="gamma exposure matrix — strikes (rows) × expiries (columns)" {...panelProps(heatmap)}>
        {hm.matrix ? (
          <BqHeatMatrix
            rowLabels={(hm.strikes ?? []).map((s) => fmtPx(s))}
            colLabels={(hm.expiries ?? []).map((e) => fmtDate(e))}
            matrix={hm.matrix ?? []}
            unit={hm.unit ?? '$ per 1% spot'}
            diverging
          />
        ) : (
          <EmptyNote text="no heatmap" />
        )}
      </Panel>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Strike Ladder" subtitle="dealer gamma exposure by strike × expiry" {...panelProps(ladder)}>
          <BqTable
            columns={[
              { key: 'strike', label: 'strike', align: 'right', render: (r) => <span className={Math.abs(Number(r.strike) - spot) < spot * 0.005 ? 'font-bold text-zinc-100' : ''}>{fmtPx(r.strike)}</span> },
              { key: 'distance_pct', label: 'Δ%', align: 'right', render: (r) => <span className={Number(r.distance_pct) >= 0 ? 'text-teal-400' : 'text-rose-400'}>{fmtPct(r.distance_pct)}</span> },
              { key: 'total', label: 'total', align: 'right', render: (r) => <span className={Number(r.total) >= 0 ? 'text-teal-300' : 'text-rose-300'}>{fmtUsd(r.total)}</span> },
              ...((lad.expiries ?? []).slice(0, 4).map((e) => ({
                key: `__${e}`,
                label: fmtDate(e),
                align: 'right' as const,
                render: (r: Any) => {
                  const v = (r.per_expiry as Record<string, number> | undefined)?.[e];
                  return <span className={Number(v) >= 0 ? 'text-teal-300/80' : 'text-rose-300/80'}>{fmtUsd(v)}</span>;
                },
              }))),
            ]}
            rows={(lad.rows ?? []).slice().reverse()}
            maxHeight={360}
          />
        </Panel>

        <Panel title="Dealer Hedge Flow" subtitle="gamma + vanna + charm components over time" {...panelProps(dealerFlow)}>
          <BqSeriesChart
            points={(df.points ?? []).map((p) => ({ ts: p.ts, gamma: p.gamma_flow, vanna: p.vanna_flow, charm: p.charm_flow, total: p.total }))}
            series={[
              { key: 'gamma', color: CHART_COLORS.teal, name: 'gamma flow' },
              { key: 'vanna', color: CHART_COLORS.violet, name: 'vanna flow' },
              { key: 'charm', color: CHART_COLORS.amber, name: 'charm flow' },
              { key: 'total', color: CHART_COLORS.zinc, name: 'total', dashed: true },
            ]}
            xFormatter={(v) => fmtDate(String(v).slice(0, 16))}
            yFormatter={(v) => fmtUsd(v)}
            referenceY={0}
            height={210}
          />
        </Panel>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════ CHAIN & OPEX ════════════════

export function ChainPanel({ symbol }: { symbol: string }) {
  const [typeFilter, setTypeFilter] = useState<'all' | 'call' | 'put'>('all');
  const chain = useBq<Any>('/options/chain', { symbol, expiries: 3, max_contracts: 120, option_type: typeFilter === 'all' ? undefined : typeFilter }, { pollMs: 45_000 });
  const venueBook = useBq<Any>('/options/venue-book', { symbol, limit: 14 }, { pollMs: 60_000 });
  const expirySummary = useBq<Any>('/options/expiry-summary', { symbol }, { pollMs: 90_000 });
  const opex = useBq<Any>('/options/opex', { symbol, horizon: 60 }, { pollMs: 120_000 });

  const ch = (chain.data ?? {}) as { contracts?: Array<Any>; aggregates?: Any };
  const vb = (venueBook.data ?? {}) as { rows?: Array<Any>; venues?: string[] };
  const es = (expirySummary.data ?? {}) as { expiries?: Array<Any> };
  const ox = (opex.data ?? {}) as { events?: Array<Any> };

  return (
    <div className="space-y-3">
      <Panel
        title="Filtered Options Chain"
        subtitle={`${symbol} · per-contract greeks, OI, IV, quotes${ch.aggregates ? ` · total OI ${fmtNum(ch.aggregates.total_oi, 0)}` : ''}`}
        right={
          <div className="flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-0.5">
            {(['all', 'call', 'put'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${typeFilter === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                {t}
              </button>
            ))}
          </div>
        }
        {...panelProps(chain)}
      >
        <BqTable
          columns={[
            { key: 'instrument', label: 'instrument' },
            { key: 'venue', label: 'venue', render: (r) => <span className="rounded bg-zinc-800/60 px-1 text-[8.5px] text-zinc-400">{String(r.venue)}</span> },
            { key: 'dte', label: 'dte', align: 'right' },
            { key: 'strike', label: 'strike', align: 'right', render: (r) => fmtPx(r.strike) },
            { key: 'option_type', label: 'type', render: (r) => <span className={r.option_type === 'call' ? 'text-teal-400' : 'text-rose-400'}>{String(r.option_type).toUpperCase()}</span> },
            { key: 'bid', label: 'bid', align: 'right', render: (r) => fmtNum(r.bid) },
            { key: 'ask', label: 'ask', align: 'right', render: (r) => fmtNum(r.ask) },
            { key: 'iv', label: 'iv', align: 'right', render: (r) => <span className="text-amber-300">{fmtPct(r.iv)}</span> },
            { key: 'delta', label: 'Δ', align: 'right', render: (r) => fmtNum(r.delta) },
            { key: 'gamma', label: 'Γ', align: 'right', render: (r) => fmtNum(r.gamma, 4) },
            { key: 'theta', label: 'Θ', align: 'right', render: (r) => fmtNum(r.theta, 1) },
            { key: 'oi', label: 'oi', align: 'right', render: (r) => fmtNum(r.oi, 0) },
          ]}
          rows={(ch.contracts ?? []) as Any[]}
          maxHeight={380}
        />
      </Panel>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Cross-Venue Book" subtitle="consolidated best bid / offer + dispersion" {...panelProps(venueBook)}>
          <BqTable
            columns={[
              { key: 'instrument', label: 'contract' },
              { key: 'strike', label: 'strike', align: 'right', render: (r) => fmtPx(r.strike) },
              { key: 'bb', label: 'best bid', align: 'right', render: (r) => <span className="text-teal-300">{fmtNum((r.best_bid as Any)?.price)} <span className="text-[7.5px] text-zinc-600">{String((r.best_bid as Any)?.venue ?? '')}</span></span> },
              { key: 'ba', label: 'best ask', align: 'right', render: (r) => <span className="text-rose-300">{fmtNum((r.best_ask as Any)?.price)} <span className="text-[7.5px] text-zinc-600">{String((r.best_ask as Any)?.venue ?? '')}</span></span> },
              { key: 'dispersion_pct', label: 'disp', align: 'right', render: (r) => fmtPct(r.dispersion_pct) },
            ]}
            rows={(vb.rows ?? []) as Any[]}
            maxHeight={260}
          />
        </Panel>

        <Panel title="OPEX Calendar" subtitle="upcoming expirations · OI roll-off" {...panelProps(opex)}>
          <BqTable
            columns={[
              { key: 'date', label: 'date', render: (r) => fmtDate(r.date) },
              { key: 'type', label: 'type', render: (r) => <span className={`rounded px-1 text-[8px] uppercase ${r.is_anchor ? 'bg-violet-950/60 text-violet-300' : 'bg-zinc-800/60 text-zinc-400'}`}>{String(r.type)}</span> },
              { key: 'dte', label: 'dte', align: 'right' },
              { key: 'oi_rolling_off', label: 'OI rolls', align: 'right', render: (r) => fmtNum(r.oi_rolling_off, 0) },
              { key: 'notional_rolling_off_usd', label: 'notional', align: 'right', render: (r) => fmtUsd(r.notional_rolling_off_usd) },
              { key: 'atm_iv', label: 'atm iv', align: 'right', render: (r) => <span className="text-amber-300">{fmtPct(r.atm_iv)}</span> },
              { key: 'expected_move_pct', label: 'exp move', align: 'right', render: (r) => fmtPct(r.expected_move_pct) },
            ]}
            rows={(ox.events ?? []) as Any[]}
            maxHeight={260}
          />
        </Panel>
      </div>

      <Panel title="Per-Expiry Summary" subtitle="IV / skew / PCR / OI / GEX per active expiry" {...panelProps(expirySummary)}>
        <BqTable
          columns={[
            { key: 'expiry', label: 'expiry', render: (r) => <span className="flex items-center gap-1">{fmtDate(r.expiry)} {r.is_anchor ? <span className="rounded bg-violet-950/60 px-1 text-[7.5px] uppercase text-violet-300">anchor</span> : null}</span> },
            { key: 'dte', label: 'dte', align: 'right' },
            { key: 'atm_iv', label: 'atm iv', align: 'right', render: (r) => <span className="text-amber-300">{fmtPct(r.atm_iv)}</span> },
            { key: 'skew_25d', label: 'skew 25Δ', align: 'right', render: (r) => <span className={Number(r.skew_25d) >= 0 ? 'text-teal-400' : 'text-rose-400'}>{fmtNum(r.skew_25d, 1)}</span> },
            { key: 'pcr', label: 'pcr', align: 'right', render: (r) => fmtNum(r.pcr) },
            { key: 'total_oi', label: 'oi', align: 'right', render: (r) => fmtNum(r.total_oi, 0) },
            { key: 'net_gex', label: 'net gex', align: 'right', render: (r) => <span className={Number(r.net_gex) >= 0 ? 'text-teal-300' : 'text-rose-300'}>{fmtUsd(r.net_gex)}</span> },
            { key: 'notional_oi_usd', label: 'notional', align: 'right', render: (r) => fmtUsd(r.notional_oi_usd) },
            { key: 'max_pain', label: 'max pain', align: 'right', render: (r) => fmtPx(r.max_pain) },
          ]}
          rows={(es.expiries ?? []) as Any[]}
          maxHeight={300}
        />
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════════════ IV ANALYTICS ════════════════

export function IvPanel({ symbol }: { symbol: string }) {
  const term = useBq<Any>('/options/iv/term-structure', { symbol }, { pollMs: 90_000 });
  const cm = useBq<Any>('/options/iv/constant-maturity', { symbol }, { pollMs: 120_000 });
  const skew = useBq<Any>('/options/iv/skew', { symbol }, { pollMs: 120_000 });
  const ivrv = useBq<Any>('/options/iv/iv-rv', { symbol, days: 90 }, { pollMs: 300_000 });
  const vrp = useBq<Any>('/options/vrp', { symbol, days: 120 }, { pollMs: 300_000 });
  const em = useBq<Any>('/options/expected-move', { symbol }, { pollMs: 60_000 });
  const range = useBq<Any>('/options/range', { symbol }, { pollMs: 90_000 });
  const surface = useBq<Any>('/options/iv/surface', { symbol }, { pollMs: 120_000 });

  const ts = (term.data ?? {}) as { points?: Array<{ dte: number; atm_iv: number }>; front_iv?: number };
  const cmD = (cm.data ?? {}) as { tenors?: Array<Any> };
  const sk = (skew.data ?? {}) as { expiries?: Array<Any> };
  const ir = (ivrv.data ?? {}) as { points?: Array<Any>; current?: { implied?: number; realized?: number; spread?: number } };
  const vp = (vrp.data ?? {}) as { points?: Array<Any>; mean?: number; current?: number; percentile?: number };
  const e = (em.data ?? {}) as { one_sigma?: Record<string, number>; two_sigma?: Record<string, number>; atm_iv?: number; straddle_price?: number };
  const rg = (range.data ?? {}) as { horizons?: Array<Any> };
  const sf = (surface.data ?? {}) as { expiries?: Array<{ expiry: string; dte: number; smile?: Array<{ strike: number; iv: number }> }> };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="ATM Term Structure" subtitle="at-the-money IV by tenor" {...panelProps(term)}>
          <BqSeriesChart
            points={(ts.points ?? []).map((p) => ({ dte: p.dte, iv: p.atm_iv }))}
            series={[{ key: 'iv', color: CHART_COLORS.amber, name: 'ATM IV %', type: 'area' }]}
            xKey="dte"
            xFormatter={(v) => `${v}d`}
            yFormatter={(v) => `${v.toFixed(0)}%`}
            height={170}
            legend={false}
          />
        </Panel>
        <Panel title="Expected Move & Calibrated Range" subtitle="the move the market is pricing" {...panelProps(em)}>
          <div className="space-y-3">
            <StatTiles
              stats={[
                { label: '1σ band', value: e.one_sigma ? `${fmtPx(e.one_sigma.low)} – ${fmtPx(e.one_sigma.high)}` : '—', hint: `±${fmtPct(e.one_sigma?.pct)} implied` },
                { label: '2σ band', value: e.two_sigma ? `${fmtPx(e.two_sigma.low)} – ${fmtPx(e.two_sigma.high)}` : '—' },
                { label: 'ATM IV', value: fmtPct(e.atm_iv), hint: '1d horizon' },
                { label: 'ATM straddle', value: fmtUsd(e.straddle_price) },
              ]}
            />
            <BqTable
              columns={[
                { key: 'horizon', label: 'horizon' },
                { key: 'b68', label: '68% band', align: 'right', render: (r) => { const b = r.band_68 as Record<string, number> | undefined; return b ? `${fmtPx(b.low)} – ${fmtPx(b.high)}` : '—'; } },
                { key: 'b90', label: '90% band', align: 'right', render: (r) => { const b = r.band_90 as Record<string, number> | undefined; return b ? `${fmtPx(b.low)} – ${fmtPx(b.high)}` : '—'; } },
                { key: 'hr68', label: '68% hit', align: 'right', render: (r) => fmtPct(r.hit_rate_68) },
                { key: 'hr90', label: '90% hit', align: 'right', render: (r) => fmtPct(r.hit_rate_90) },
              ]}
              rows={(rg.horizons ?? []) as Any[]}
              maxHeight={120}
            />
          </div>
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Skew by Expiry" subtitle="25Δ risk reversal / butterfly · put wing vs call wing" {...panelProps(skew)}>
          <BqTable
            columns={[
              { key: 'expiry', label: 'expiry', render: (r) => fmtDate(r.expiry) },
              { key: 'dte', label: 'dte', align: 'right' },
              { key: 'atm_iv', label: 'atm', align: 'right', render: (r) => <span className="text-amber-300">{fmtPct(r.atm_iv)}</span> },
              { key: 'put_25d_iv', label: 'put 25Δ', align: 'right', render: (r) => fmtPct(r.put_25d_iv) },
              { key: 'call_25d_iv', label: 'call 25Δ', align: 'right', render: (r) => fmtPct(r.call_25d_iv) },
              { key: 'rr_25d', label: 'RR 25Δ', align: 'right', render: (r) => <span className={Number(r.rr_25d) >= 0 ? 'text-teal-400' : 'text-rose-400'}>{fmtNum(r.rr_25d, 1)}</span> },
              { key: 'bf_25d', label: 'BF 25Δ', align: 'right', render: (r) => fmtNum(r.bf_25d, 1) },
            ]}
            rows={(sk.expiries ?? []) as Any[]}
            maxHeight={240}
          />
        </Panel>
        <Panel title="Constant-Maturity Vol" subtitle="ATM / RR / butterfly at fixed tenors (7d → 1y)" {...panelProps(cm)}>
          <BqTable
            columns={[
              { key: 'tenor_days', label: 'tenor', align: 'right', render: (r) => `${r.tenor_days}d` },
              { key: 'atm_iv', label: 'atm', align: 'right', render: (r) => <span className="text-amber-300">{fmtPct(r.atm_iv)}</span> },
              { key: 'rr_25d', label: 'RR 25Δ', align: 'right', render: (r) => <span className={Number(r.rr_25d) >= 0 ? 'text-teal-400' : 'text-rose-400'}>{fmtNum(r.rr_25d, 1)}</span> },
              { key: 'rr_10d', label: 'RR 10Δ', align: 'right', render: (r) => fmtNum(r.rr_10d, 1) },
              { key: 'bf_25d', label: 'BF 25Δ', align: 'right', render: (r) => fmtNum(r.bf_25d, 1) },
            ]}
            rows={(cmD.tenors ?? []) as Any[]}
            maxHeight={240}
          />
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="IV vs Realized Vol" subtitle="implied − realized · the vol risk premium in motion" {...panelProps(ivrv)}>
          <BqSeriesChart
            points={(ir.points ?? []).map((p) => ({ date: p.date, implied: p.implied, realized: p.realized, spread: p.spread }))}
            series={[
              { key: 'implied', color: CHART_COLORS.amber, name: 'implied' },
              { key: 'realized', color: CHART_COLORS.teal, name: 'realized 30d' },
              { key: 'spread', color: CHART_COLORS.rose, name: 'VRP spread', type: 'area' },
            ]}
            xKey="date"
            xFormatter={(v) => fmtDate(v)}
            yFormatter={(v) => `${v.toFixed(0)}%`}
            height={185}
          />
          {ir.current ? (
            <div className="mt-2">
              <StatTiles
                columns={3}
                stats={[
                  { label: 'implied now', value: fmtPct(ir.current.implied) },
                  { label: 'realized 30d', value: fmtPct(ir.current.realized) },
                  { label: 'spread (VRP)', value: fmtPct(ir.current.spread), delta: Number(ir.current.spread) >= 0 ? 'options rich' : 'options cheap', deltaPositive: Number(ir.current.spread) >= 0 },
                ]}
              />
            </div>
          ) : null}
        </Panel>
        <Panel title="Volatility Risk Premium" subtitle="implied − realized history · positive = options expensive" {...panelProps(vrp)}>
          <BqSeriesChart
            points={(vp.points ?? []).map((p) => ({ date: p.date, vrp: p.vrp }))}
            series={[{ key: 'vrp', color: CHART_COLORS.violet, name: 'VRP', type: 'area' }]}
            xKey="date"
            xFormatter={(v) => fmtDate(v)}
            referenceY={0}
            height={185}
          />
          {vp.current != null ? (
            <div className="mt-2">
              <StatTiles
                columns={3}
                stats={[
                  { label: 'current VRP', value: fmtNum(vp.current, 2), delta: Number(vp.current) >= 0 ? 'implied > realized' : 'implied < realized', deltaPositive: Number(vp.current) >= 0 },
                  { label: 'mean', value: fmtNum(vp.mean, 2) },
                  { label: 'percentile', value: fmtPct(vp.percentile, 0), hint: 'vs history' },
                ]}
              />
            </div>
          ) : null}
        </Panel>
      </div>

      <Panel title="IV Surface — Smiles" subtitle="per-expiry smile curves from the fitted surface" {...panelProps(surface)}>
        <BqSeriesChart
          points={((sf.expiries ?? []).slice(0, 6).flatMap((exp) =>
            (exp.smile ?? []).map((pt) => ({ strike: pt.strike, iv: pt.iv, expiry: `${fmtDate(exp.expiry)} (${exp.dte}d)` })),
          ) as Array<Any & { expiry: string }>)}
          series={((sf.expiries ?? []).slice(0, 6).map((exp, i) => ({
            key: `iv_${i}`,
            color: [CHART_COLORS.teal, CHART_COLORS.amber, CHART_COLORS.violet, CHART_COLORS.rose, CHART_COLORS.sky, CHART_COLORS.zinc][i % 6],
            name: `${fmtDate(exp.expiry)} · ${exp.dte}d`,
          })))}
          xKey="strike"
          xFormatter={(v) => fmtPx(v)}
          yFormatter={(v) => `${v.toFixed(0)}%`}
          height={210}
        />
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════════════ GREEKS & TRACE ══════════════

const GREEK_OPTIONS = ['gamma', 'vanna', 'charm', 'vega', 'theta'] as const;

export function GreeksPanel({ symbol }: { symbol: string }) {
  const [greek, setGreek] = useState<(typeof GREEK_OPTIONS)[number]>('gamma');
  const [traceGreek, setTraceGreek] = useState<'gamma' | 'charm' | 'vanna'>('gamma');
  const profile = useBq<Any>(`/options/greeks/${greek}`, { symbol }, { pollMs: 90_000 });
  const surface3d = useBq<Any>('/options/greeks/3d/surface', { symbol, greek }, { pollMs: 120_000 });
  const trace = useBq<Any>(`/options/greeks/trace/${traceGreek}`, { symbol, expiry: 'next', time_steps: 10, price_steps: 17 }, { pollMs: 120_000 });
  const traceSummary = useBq<Any>(`/options/greeks/trace/${traceGreek}/summary`, { symbol, expiry: 'next' }, { pollMs: 120_000 });

  const pf = (profile.data ?? {}) as { strikes?: number[]; net?: number[]; call?: number[]; put?: number[]; unit?: string };
  const s3 = (surface3d.data ?? {}) as { strikes?: number[]; expiries?: string[]; matrix?: number[][]; unit?: string };
  const tr = (trace.data ?? {}) as { prices?: number[]; times?: Array<{ ts: string; hours_to_expiry?: number }>; matrix?: number[][]; unit?: string; expiry?: string; dte?: number };
  const trs = (traceSummary.data ?? {}) as { pin_zones?: Array<Any>; accel_pockets?: Array<Any>; lean?: string; headline?: string };

  const maxNet = Math.max(...(pf.net ?? []).map(Math.abs), 1);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <div className="flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-0.5">
          {GREEK_OPTIONS.map((g) => (
            <button
              key={g}
              onClick={() => setGreek(g)}
              className={`rounded px-2 py-0.5 text-[9px] font-medium uppercase ${greek === g ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title={`Dealer ${greek} by Strike`} subtitle={pf.unit ?? 'exposure per strike · net / call / put'} {...panelProps(profile)}>
          {(pf.strikes ?? []).length ? (
            <div className="space-y-[3px]">
              {(pf.strikes ?? []).map((k, i) => {
                const v = pf.net?.[i] ?? 0;
                const w = (Math.abs(v) / maxNet) * 50;
                const pos = v >= 0;
                return (
                  <div key={k} className="flex items-center gap-1 text-[9px]" title={`strike ${fmtPx(k)} · net ${fmtNum(v)} · call ${fmtNum(pf.call?.[i])} · put ${fmtNum(pf.put?.[i])}`}>
                    <span className="w-[52px] shrink-0 text-right font-mono tabular-nums text-zinc-500">{fmtPx(k)}</span>
                    <div className="relative flex h-[11px] min-w-0 flex-1 items-center justify-center">
                      <div className="absolute inset-y-[5px] left-0 right-0 bg-zinc-800/40" />
                      {pos ? <div className="absolute left-1/2 h-full rounded-l-sm bg-teal-500/60" style={{ width: `${w}%` }} /> : <div className="absolute right-1/2 h-full rounded-r-sm bg-rose-500/60" style={{ width: `${w}%` }} />}
                      <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-700" />
                    </div>
                    <span className={`w-[62px] shrink-0 text-right font-mono tabular-nums ${pos ? 'text-teal-300' : 'text-rose-300'}`}>{fmtNum(v)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyNote text="no profile" />
          )}
        </Panel>

        <Panel title={`${greek} Surface (strike × expiry)`} subtitle={s3.unit ?? 'sum(greek × OI) per cell'} {...panelProps(surface3d)}>
          {s3.matrix ? (
            <BqHeatMatrix
              rowLabels={(s3.strikes ?? []).map((s) => fmtPx(s))}
              colLabels={(s3.expiries ?? []).map((e) => fmtDate(e))}
              matrix={s3.matrix ?? []}
              unit={s3.unit}
              diverging
            />
          ) : (
            <EmptyNote text="no surface" />
          )}
        </Panel>
      </div>

      <Panel
        title={`Greek TRACE — Forward ${traceGreek} Projection`}
        subtitle={`${symbol} · time × price map of dealer ${traceGreek} into expiry${tr.expiry ? ` (${fmtDate(tr.expiry)}, ${tr.dte ?? '?'}d)` : ''}`}
        right={
          <div className="flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-0.5">
            {(['gamma', 'charm', 'vanna'] as const).map((g) => (
              <button
                key={g}
                onClick={() => setTraceGreek(g)}
                className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${traceGreek === g ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                {g}
              </button>
            ))}
          </div>
        }
        {...panelProps(trace)}
      >
        <div className="grid gap-3 xl:grid-cols-[1.6fr_1fr]">
          {tr.matrix ? (
            <BqHeatMatrix
              rowLabels={(tr.prices ?? []).map((p) => fmtPx(p))}
              colLabels={(tr.times ?? []).map((t) => `${fmtNum(t.hours_to_expiry ?? 0, 0)}h`)}
              matrix={tr.matrix ?? []}
              unit={tr.unit}
              rowTitle="price"
              diverging
            />
          ) : (
            <EmptyNote text="no TRACE map" />
          )}
          <div className="space-y-2">
            {trs.headline ? (
              <div className="rounded-md border border-violet-800/40 bg-violet-950/20 px-2.5 py-2 text-[10px] leading-relaxed text-violet-200">{trs.headline}</div>
            ) : null}
            {trs.lean ? (
              <div className="rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-2 text-[9.5px] leading-relaxed text-zinc-400">{trs.lean}</div>
            ) : null}
            {trs.pin_zones?.length ? (
              <div>
                <p className="mb-1 text-[8.5px] font-semibold uppercase tracking-wider text-zinc-500">pin zones</p>
                <div className="space-y-1">
                  {trs.pin_zones.map((z, i) => (
                    <div key={i} className="flex items-center justify-between rounded border border-zinc-800/50 bg-zinc-950/40 px-2 py-1 text-[9px]">
                      <span className="font-mono tabular-nums text-zinc-300">{fmtPx(z.low)} – {fmtPx(z.high)}</span>
                      <span className="rounded bg-zinc-800/60 px-1 text-[8px] uppercase text-zinc-400">{String(z.strength ?? '')}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {trs.accel_pockets?.length ? (
              <div>
                <p className="mb-1 text-[8.5px] font-semibold uppercase tracking-wider text-zinc-500">accel pockets</p>
                {trs.accel_pockets.map((p, i) => (
                  <p key={i} className="rounded border border-amber-800/40 bg-amber-950/20 px-2 py-1 text-[9px] text-amber-200">
                    {fmtPx(p.price)} · {fmtNum(p.hours, 0)}h — {String(p.note ?? 'gamma accelerates')}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════════════ OI & FLOW ═══════════════════

export function OiPanel({ symbol }: { symbol: string }) {
  const oiExpiry = useBq<Any>('/options/oi/by-expiry', { symbol }, { pollMs: 90_000 });
  const pcr = useBq<Any>('/options/pcr', { symbol, granularity: 'daily', days: 45 }, { pollMs: 120_000 });
  const tide = useBq<Any>('/options/premium-tide', { symbol, horizon: '1d' }, { pollMs: 60_000 });
  const basis = useBq<Any>('/options/futures/term-structure', { symbol }, { pollMs: 120_000 });
  const strikeHeat = useBq<Any>('/tape/strike-heat', { symbol, hours: 24, top: 14 }, { pollMs: 60_000 });

  const oe = (oiExpiry.data ?? {}) as { expiries?: Array<Any> };
  const pc = (pcr.data ?? {}) as { daily?: Array<Any>; total?: Any };
  const td = (tide.data ?? {}) as { points?: Array<Any>; call_premium_usd?: number; put_premium_usd?: number; net_premium_usd?: number; tilt?: number };
  const bs = (basis.data ?? {}) as { maturities?: Array<Any>; curve_shape?: string; perp_basis_bps?: number };
  const sh = (strikeHeat.data ?? {}) as { strikes?: Array<Any> };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Open Interest by Expiry" subtitle="call vs put OI per expiration" {...panelProps(oiExpiry)}>
          <BqSeriesChart
            points={(oe.expiries ?? []).map((r) => ({ expiry: r.expiry, call: r.call_oi, put: r.put_oi }))}
            series={[
              { key: 'call', color: CHART_COLORS.teal, name: 'call OI', type: 'bar' },
              { key: 'put', color: CHART_COLORS.rose, name: 'put OI', type: 'bar' },
            ]}
            xKey="expiry"
            xFormatter={(v) => fmtDate(v)}
            yFormatter={(v) => fmtNum(v, 0)}
            height={185}
          />
        </Panel>
        <Panel title="Put / Call Ratio" subtitle="OI-weighted PCR history" {...panelProps(pcr)}>
          <BqSeriesChart
            points={(pc.daily ?? []).map((r) => ({ date: r.date, pcr: r.pcr }))}
            series={[{ key: 'pcr', color: CHART_COLORS.sky, name: 'PCR', type: 'area' }]}
            xKey="date"
            xFormatter={(v) => fmtDate(v)}
            referenceY={1}
            yFormatter={(v) => v.toFixed(2)}
            height={185}
            legend={false}
          />
          {pc.total ? (
            <div className="mt-2">
              <StatTiles
                columns={2}
                stats={[
                  { label: 'OI PCR', value: fmtNum(pc.total.oi_pcr), delta: Number(pc.total.oi_pcr) > 1 ? 'puts heavy' : 'calls heavy', deltaPositive: Number(pc.total.oi_pcr) <= 1 },
                  { label: 'volume PCR', value: fmtNum(pc.total.volume_pcr) },
                ]}
              />
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Premium Tide" subtitle="net premium & volume tilt (calls vs puts)" {...panelProps(tide)}>
          <StatTiles
            columns={3}
            stats={[
              { label: 'call premium', value: fmtUsd(td.call_premium_usd) },
              { label: 'put premium', value: fmtUsd(td.put_premium_usd) },
              { label: 'net premium', value: fmtUsd(td.net_premium_usd), delta: Number(td.net_premium_usd) >= 0 ? 'call-skewed' : 'put-skewed', deltaPositive: Number(td.net_premium_usd) >= 0 },
            ]}
          />
          <div className="mt-2">
            <BqSeriesChart
              points={(td.points ?? []).map((p) => ({ ts: p.ts, cum: p.cumulative, net: p.net_premium }))}
              series={[
                { key: 'cum', color: CHART_COLORS.teal, name: 'cumulative net' },
                { key: 'net', color: CHART_COLORS.zinc, name: 'per-bucket net' },
              ]}
              xFormatter={(v) => fmtDate(String(v).slice(0, 16))}
              yFormatter={(v) => fmtUsd(v)}
              referenceY={0}
              height={150}
            />
          </div>
        </Panel>
        <Panel title="Futures Term Structure" subtitle="dated-futures annualized basis curve" {...panelProps(basis)}>
          <BqSeriesChart
            points={(bs.maturities ?? []).map((m) => ({ dte: m.dte, basis: m.basis_annualized_pct }))}
            series={[{ key: 'basis', color: CHART_COLORS.violet, name: 'annualized basis %', type: 'area' }]}
            xKey="dte"
            xFormatter={(v) => `${v}d`}
            referenceY={0}
            yFormatter={(v) => `${v.toFixed(1)}%`}
            height={150}
            legend={false}
          />
          <div className="mt-2">
            <StatTiles
              columns={2}
              stats={[
                { label: 'curve shape', value: String(bs.curve_shape ?? '—') },
                { label: 'perp basis', value: `${fmtNum(bs.perp_basis_bps, 0)} bps` },
              ]}
            />
          </div>
        </Panel>
      </div>

      <Panel title="Tape Strike Heat" subtitle="net / absolute aggressor premium by strike (24h)" {...panelProps(strikeHeat)}>
        <BqTable
          columns={[
            { key: 'strike', label: 'strike', align: 'right', render: (r) => fmtPx(r.strike) },
            { key: 'abs_premium_usd', label: 'abs premium', align: 'right', render: (r) => fmtUsd(r.abs_premium_usd) },
            { key: 'net_premium_usd', label: 'net premium', align: 'right', render: (r) => <span className={Number(r.net_premium_usd) >= 0 ? 'text-teal-300' : 'text-rose-300'}>{fmtUsd(r.net_premium_usd)}</span> },
            { key: 'buy_usd', label: 'buy', align: 'right', render: (r) => fmtUsd(r.buy_usd) },
            { key: 'sell_usd', label: 'sell', align: 'right', render: (r) => fmtUsd(r.sell_usd) },
            { key: 'trades', label: 'trades', align: 'right', render: (r) => fmtNum(r.trades, 0) },
          ]}
          rows={(sh.strikes ?? []) as Any[]}
          maxHeight={260}
        />
      </Panel>
    </div>
  );
}

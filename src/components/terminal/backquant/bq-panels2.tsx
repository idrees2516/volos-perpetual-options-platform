'use client';

// -----------------------------------------------------------------------------
// backquant/bq-panels2 — Overview · Tape (live SSE) · Liquidations · Market ·
// ETF & COT & Filings workspace panels.
// -----------------------------------------------------------------------------

import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, Radio, Fish as WhaleIcon, TrendingUp, TrendingDown } from 'lucide-react';
import { Panel, StatTiles, BqHeatMatrix, BqSeriesChart, BqTable, panelProps, fmtUsd, fmtNum, fmtPx, fmtPct, fmtDate, fmtTime, CHART_COLORS, EmptyNote } from './bq-viz';
import { useBq } from './use-bq';

type Any = Record<string, unknown>;

// ═══════════════════════════════════════════════ OVERVIEW ═══════════════════

export function BqOverviewPanel({ symbol }: { symbol: string }) {
  const levels = useBq<Any>('/gex/levels', { symbol, include: 'max_pain,expected_move' }, { pollMs: 45_000 });
  const bundle = useBq<Any>('/market/bundle', { symbol, interval: '1h', hours: 72 }, { pollMs: 60_000 });
  const tapeStats = useBq<Any>('/tape/stats', { symbol, hours: 24 }, { pollMs: 60_000 });
  const expirySummary = useBq<Any>('/options/expiry-summary', { symbol }, { pollMs: 120_000 });
  const expectedMove = useBq<Any>('/options/expected-move', { symbol }, { pollMs: 60_000 });
  const liquidation = useBq<Any>('/liquidation/heatmap', { symbol }, { pollMs: 120_000 });

  const lv = (levels.data ?? {}) as { all_expiry?: Record<string, number>; odte?: Record<string, number>; max_pain?: number };
  const bu = (bundle.data ?? {}) as { points?: Array<Any>; spot?: number };
  const ts = (tapeStats.data ?? {}) as Any;
  const es = (expirySummary.data ?? {}) as { expiries?: Array<Any> };
  const em = (expectedMove.data ?? {}) as { one_sigma?: Record<string, number>; two_sigma?: Record<string, number> };
  const lq = (liquidation.data ?? {}) as { clusters?: Array<Any> };
  const spot = levels.meta?.spot_price ?? bu.spot ?? 0;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Spot vs Gamma Levels" subtitle={`${symbol} dealer positioning`} {...panelProps(levels)}>
          {lv.all_expiry ? (
            <StatTiles
              columns={2}
              stats={[
                { label: 'spot', value: fmtPx(spot) },
                { label: 'HVL · flip', value: fmtPx(lv.all_expiry.hvl), delta: spot >= (lv.all_expiry.hvl ?? 0) ? 'above flip — long gamma' : 'below flip — short gamma', deltaPositive: spot >= (lv.all_expiry.hvl ?? 0) },
                { label: 'call wall', value: fmtPx(lv.all_expiry.call_resistance) },
                { label: 'put support', value: fmtPx(lv.all_expiry.put_support) },
                { label: 'max pain', value: fmtPx(lv.max_pain) },
                { label: '0DTE HVL', value: fmtPx(lv.odte?.hvl) },
              ]}
            />
          ) : (
            <EmptyNote text="no levels" />
          )}
        </Panel>

        <Panel title="Expected Move" subtitle="the move the market is pricing" {...panelProps(expectedMove)}>
          <StatTiles
            columns={1}
            stats={[
              { label: '1σ band (1d)', value: em.one_sigma ? `${fmtPx(em.one_sigma.low)} – ${fmtPx(em.one_sigma.high)}` : '—', hint: `±${fmtPct(em.one_sigma?.pct)}` },
              { label: '2σ band (1d)', value: em.two_sigma ? `${fmtPx(em.two_sigma.low)} – ${fmtPx(em.two_sigma.high)}` : '—' },
              { label: 'distance to 1σ high', value: em.one_sigma ? fmtPct(((Number(em.one_sigma.high) - spot) / spot) * 100) : '—' },
            ]}
          />
        </Panel>

        <Panel title="Perp Market" subtitle="price · OI · funding (72h)" {...panelProps(bundle)}>
          <BqSeriesChart
            points={(bu.points ?? []).map((p) => ({ ts: p.ts, price: p.price, funding: (Number(p.funding_rate) * 100) }))}
            series={[
              { key: 'price', color: CHART_COLORS.teal, name: 'price' },
              { key: 'funding', color: CHART_COLORS.amber, name: 'funding %/ivl', yAxis: 'right' },
            ]}
            xFormatter={(v) => fmtDate(String(v).slice(0, 16))}
            height={140}
            yFormatter={(v) => fmtPx(v)}
            rightFormatter={(v) => `${v.toFixed(3)}%`}
          />
          {lq.clusters?.length ? (
            <p className="mt-2 text-[9px] text-zinc-500">
              nearest liquidation magnet: <span className="font-mono text-amber-300">{fmtPx(lq.clusters[0].price)}</span> · intensity {fmtNum(lq.clusters[0].intensity, 0)}/100
            </p>
          ) : null}
        </Panel>

        <Panel title="24h Options Tape" subtitle="multi-venue premium & prints" {...panelProps(tapeStats)}>
          <StatTiles
            columns={2}
            stats={[
              { label: 'premium', value: fmtUsd(ts.total_premium_usd) },
              { label: 'trades', value: fmtNum(ts.trade_count, 0) },
              { label: 'call share', value: fmtPct(ts.call_share_pct), delta: 'put ' + fmtPct(ts.put_share_pct), deltaPositive: false },
              { label: 'whale prints', value: fmtNum(ts.whale_count, 0) },
            ]}
          />
          {Array.isArray(ts.venue_split) ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {(ts.venue_split as Array<Any>).slice(0, 5).map((v, i) => (
                <span key={i} className="rounded-full border border-zinc-800 bg-zinc-900/60 px-1.5 py-px text-[8px] text-zinc-400">
                  {String(v.venue)} <span className="text-zinc-500">{fmtUsd(v.premium_usd)}</span>
                </span>
              ))}
            </div>
          ) : null}
        </Panel>
      </div>

      <Panel title="Expiry Ladder" subtitle="every active expiry · ATM IV · OI · net GEX · max pain" {...panelProps(expirySummary)}>
        <BqTable
          columns={[
            { key: 'expiry', label: 'expiry', render: (r) => <span className="flex items-center gap-1">{fmtDate(r.expiry)} {r.is_anchor ? <span className="rounded bg-violet-950/60 px-1 text-[7.5px] uppercase text-violet-300">anchor</span> : null}</span> },
            { key: 'dte', label: 'dte', align: 'right' },
            { key: 'atm_iv', label: 'atm iv', align: 'right', render: (r) => <span className="text-amber-300">{fmtPct(r.atm_iv)}</span> },
            { key: 'skew_25d', label: 'skew', align: 'right', render: (r) => fmtNum(r.skew_25d, 1) },
            { key: 'pcr', label: 'pcr', align: 'right', render: (r) => fmtNum(r.pcr) },
            { key: 'total_oi', label: 'oi', align: 'right', render: (r) => fmtNum(r.total_oi, 0) },
            { key: 'net_gex', label: 'net gex', align: 'right', render: (r) => <span className={Number(r.net_gex) >= 0 ? 'text-teal-300' : 'text-rose-300'}>{fmtUsd(r.net_gex)}</span> },
            { key: 'max_pain', label: 'max pain', align: 'right', render: (r) => fmtPx(r.max_pain) },
          ]}
          rows={(es.expiries ?? []) as Any[]}
          maxHeight={280}
        />
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════════════ TAPE (LIVE) ════════════════

interface StreamTrade {
  ts: string;
  venue: string;
  instrument: string;
  option_type: 'call' | 'put';
  strike: number;
  expiry: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  premium_usd: number;
  iv?: number;
  tags?: string[];
  demo?: boolean;
}

export function TapePanel({ symbol }: { symbol: string }) {
  const [live, setLive] = useState(true);
  const [trades, setTrades] = useState<StreamTrade[]>([]);
  const [onlyWhales, setOnlyWhales] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [mode, setMode] = useState<'live' | 'demo' | 'unknown'>('unknown');
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!live) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }
    const es = new EventSource(`/api/backquant/tape/stream?symbol=${encodeURIComponent(symbol)}`);
    esRef.current = es;
    es.addEventListener('hello', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { mode?: 'live' | 'demo' };
        setMode(d.mode ?? 'unknown');
      } catch { /* ignore */ }
    });
    es.addEventListener('trade', (ev) => {
      try {
        const t = JSON.parse((ev as MessageEvent).data) as StreamTrade;
        setLastEventAt(Date.now());
        setTrades((prev) => [t, ...prev].slice(0, 120));
      } catch { /* ignore */ }
    });
    es.onerror = () => {
      // EventSource auto-reconnects; surface nothing
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [symbol, live]);

  const whales = useBq<Any>('/tape/whale', { symbol, hours: 24, limit: 12 }, { pollMs: 60_000 });
  const stats = useBq<Any>('/tape/stats', { symbol, hours: 24 }, { pollMs: 60_000 });
  const imbalance = useBq<Any>('/tape/imbalance', { symbol, hours: 24, bucket_minutes: 60 }, { pollMs: 60_000 });
  const flowStrike = useBq<Any>('/tape/flow-by-strike', { symbol }, { pollMs: 60_000 });

  const wh = (whales.data ?? {}) as { whales?: Array<Any> };
  const st = (stats.data ?? {}) as Any;
  const im = (imbalance.data ?? {}) as { buckets?: Array<Any> };
  const fs = (flowStrike.data ?? {}) as { strikes?: Array<Any> };

  const shown = onlyWhales ? trades.filter((t) => (t.premium_usd ?? 0) > 250_000 || t.tags?.includes('whale')) : trades;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Premium (24h)" subtitle="total options premium traded" {...panelProps(stats)}>
          <StatTiles columns={2} stats={[
            { label: 'premium', value: fmtUsd(st.total_premium_usd) },
            { label: 'notional', value: fmtUsd(st.notional_volume_usd) },
            { label: 'buy side', value: fmtUsd(st.buy_premium_usd), deltaPositive: true, delta: 'aggressor buys' },
            { label: 'sell side', value: fmtUsd(st.sell_premium_usd), deltaPositive: false, delta: 'aggressor sells' },
          ]} />
        </Panel>
        <Panel title="Prints & Blocks" subtitle="24h trade counts" {...panelProps(stats)}>
          <StatTiles columns={2} stats={[
            { label: 'trades', value: fmtNum(st.trade_count, 0) },
            { label: 'whales', value: fmtNum(st.whale_count, 0) },
            { label: 'blocks', value: fmtNum(st.block_count, 0) },
            { label: 'call share', value: fmtPct(st.call_share_pct) },
          ]} />
        </Panel>
        <Panel title="Venue Split" subtitle="premium by venue" {...panelProps(stats)}>
          {Array.isArray(st.venue_split) ? (
            <div className="space-y-1">
              {(st.venue_split as Array<Any>).map((v, i) => {
                const max = Math.max(...(st.venue_split as Array<Any>).map((x) => Number(x.premium_usd ?? 0)), 1);
                const w = (Number(v.premium_usd ?? 0) / max) * 100;
                return (
                  <div key={i} className="flex items-center gap-1.5 text-[9px]">
                    <span className="w-[52px] shrink-0 truncate text-zinc-400">{String(v.venue)}</span>
                    <div className="h-[7px] min-w-0 flex-1 overflow-hidden rounded-sm bg-zinc-800/50">
                      <div className="h-full bg-teal-500/60" style={{ width: `${w}%` }} />
                    </div>
                    <span className="w-[52px] shrink-0 text-right font-mono tabular-nums text-zinc-300">{fmtUsd(v.premium_usd)}</span>
                  </div>
                );
              })}
            </div>
          ) : <EmptyNote text="no venue split" />}
        </Panel>
        <Panel title="Aggressor Imbalance" subtitle="time-bucketed buy vs sell" {...panelProps(imbalance)}>
          <BqSeriesChart
            points={(im.buckets ?? []).map((b) => ({ ts: b.ts, imbalance: b.imbalance, cumulative: b.cumulative }))}
            series={[
              { key: 'cumulative', color: CHART_COLORS.teal, name: 'cumulative', type: 'area' },
              { key: 'imbalance', color: CHART_COLORS.zinc, name: 'per bucket' },
            ]}
            xFormatter={(v) => fmtTime(String(v).slice(0, 16))}
            yFormatter={(v) => fmtUsd(v)}
            referenceY={0}
            height={150}
          />
        </Panel>
      </div>

      <Panel
        title="Live Tape"
        subtitle={`${symbol} multi-venue options prints — streaming${mode === 'demo' ? ' (demo simulator)' : mode === 'live' ? ' (BackQuant relay)' : ''}`}
        mode={mode === 'unknown' ? undefined : mode}
        right={
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setOnlyWhales((v) => !v)}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${onlyWhales ? 'bg-amber-950/50 text-amber-300 ring-1 ring-amber-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Only show prints above $250k"
            >
              <WhaleIcon className="h-3 w-3" /> whales
            </button>
            <button
              onClick={() => setLive((v) => !v)}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${live ? 'bg-teal-950/50 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {live ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {live ? 'streaming' : 'paused'}
            </button>
            {lastEventAt ? (
              <span className="flex items-center gap-1 text-[8.5px] text-zinc-500" title="last print received">
                <Radio className="h-2.5 w-2.5 animate-pulse text-teal-400" /> {fmtTime(lastEventAt)}
              </span>
            ) : null}
          </div>
        }
      >
        <div className="overflow-auto rounded-md border border-zinc-800/60" style={{ maxHeight: 340 }}>
          <table className="w-full text-[9.5px]">
            <thead className="sticky top-0 bg-zinc-900/95 backdrop-blur">
              <tr className="border-b border-zinc-800/60 text-zinc-500">
                <th className="px-2 py-1 text-left font-medium">time</th>
                <th className="px-2 py-1 text-left font-medium">venue</th>
                <th className="px-2 py-1 text-left font-medium">instrument</th>
                <th className="px-2 py-1 text-right font-medium">type</th>
                <th className="px-2 py-1 text-right font-medium">strike</th>
                <th className="px-2 py-1 text-right font-medium">expiry</th>
                <th className="px-2 py-1 text-right font-medium">side</th>
                <th className="px-2 py-1 text-right font-medium">qty</th>
                <th className="px-2 py-1 text-right font-medium">premium</th>
                <th className="px-2 py-1 text-right font-medium">iv</th>
                <th className="px-2 py-1 text-right font-medium">tags</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t, i) => {
                const buy = t.side === 'buy';
                const whale = (t.premium_usd ?? 0) > 250_000;
                return (
                  <tr key={`${t.ts}-${t.instrument}-${i}`} className={`border-b border-zinc-800/30 text-zinc-300 last:border-0 ${whale ? 'bg-amber-950/15' : ''}`}>
                    <td className="whitespace-nowrap px-2 py-[3px] font-mono tabular-nums text-zinc-500">{fmtTime(t.ts)}</td>
                    <td className="whitespace-nowrap px-2 py-[3px]"><span className="rounded bg-zinc-800/60 px-1 text-[8.5px] text-zinc-400">{t.venue}</span></td>
                    <td className="whitespace-nowrap px-2 py-[3px] font-mono text-zinc-400" title={t.instrument}>
                      {t.instrument?.length > 28 ? `${t.instrument.slice(0, 28)}…` : t.instrument}
                    </td>
                    <td className="px-2 py-[3px] text-right"><span className={t.option_type === 'call' ? 'text-teal-400' : 'text-rose-400'}>{t.option_type?.toUpperCase()}</span></td>
                    <td className="whitespace-nowrap px-2 py-[3px] text-right font-mono tabular-nums">{fmtPx(t.strike)}</td>
                    <td className="whitespace-nowrap px-2 py-[3px] text-right font-mono tabular-nums text-zinc-500">{t.expiry}</td>
                    <td className="px-2 py-[3px] text-right">
                      <span className={`flex items-center justify-end gap-0.5 font-medium ${buy ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {buy ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                        {t.side}
                      </span>
                    </td>
                    <td className="px-2 py-[3px] text-right font-mono tabular-nums">{fmtNum(t.qty, 1)}</td>
                    <td className="px-2 py-[3px] text-right font-mono tabular-nums font-medium">{fmtUsd(t.premium_usd)}</td>
                    <td className="px-2 py-[3px] text-right font-mono tabular-nums text-amber-300/80">{t.iv != null ? fmtPct(t.iv) : '—'}</td>
                    <td className="px-2 py-[3px] text-right">
                      {t.tags?.length ? (
                        <span className="space-x-0.5">
                          {t.tags.map((tag) => (
                            <span key={tag} className={`rounded px-1 text-[7.5px] uppercase ${tag === 'whale' ? 'bg-amber-900/50 text-amber-300' : tag === 'sweep' ? 'bg-rose-900/40 text-rose-300' : 'bg-zinc-800 text-zinc-400'}`}>{tag}</span>
                          ))}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[10px] text-zinc-500">
              {live ? <><Radio className="h-3 w-3 animate-pulse text-teal-400" /> waiting for prints…</> : 'stream paused'}
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Whale Prints (24h)" subtitle="largest options prints by premium" {...panelProps(whales)}>
          <BqTable
            columns={[
              { key: 'ts', label: 'time', render: (r) => fmtTime(r.ts) },
              { key: 'venue', label: 'venue', render: (r) => <span className="rounded bg-zinc-800/60 px-1 text-[8.5px] text-zinc-400">{String(r.venue)}</span> },
              { key: 'instrument', label: 'instrument', render: (r) => <span className="font-mono text-[8.5px] text-zinc-400">{String(r.instrument)}</span> },
              { key: 'side', label: 'side', align: 'right', render: (r) => <span className={r.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{String(r.side).toUpperCase()}</span> },
              { key: 'qty', label: 'qty', align: 'right', render: (r) => fmtNum(r.qty, 1) },
              { key: 'premium_usd', label: 'premium', align: 'right', render: (r) => <span className="font-semibold text-amber-300">{fmtUsd(r.premium_usd)}</span> },
            ]}
            rows={(wh.whales ?? []) as Any[]}
            maxHeight={260}
          />
        </Panel>
        <Panel title="Flow by Strike" subtitle="cumulative aggressor buying / selling on open contracts" {...panelProps(flowStrike)}>
          <BqTable
            columns={[
              { key: 'strike', label: 'strike', align: 'right', render: (r) => fmtPx(r.strike) },
              { key: 'call_buy_usd', label: 'call buy', align: 'right', render: (r) => <span className="text-teal-300/90">{fmtUsd(r.call_buy_usd)}</span> },
              { key: 'call_sell_usd', label: 'call sell', align: 'right', render: (r) => <span className="text-rose-300/80">{fmtUsd(r.call_sell_usd)}</span> },
              { key: 'put_buy_usd', label: 'put buy', align: 'right', render: (r) => <span className="text-teal-300/90">{fmtUsd(r.put_buy_usd)}</span> },
              { key: 'put_sell_usd', label: 'put sell', align: 'right', render: (r) => <span className="text-rose-300/80">{fmtUsd(r.put_sell_usd)}</span> },
              { key: 'net_aggressor_usd', label: 'net', align: 'right', render: (r) => <span className={Number(r.net_aggressor_usd) >= 0 ? 'font-semibold text-teal-300' : 'font-semibold text-rose-300'}>{fmtUsd(r.net_aggressor_usd)}</span> },
            ]}
            rows={(fs.strikes ?? []) as Any[]}
            maxHeight={260}
          />
        </Panel>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════ LIQUIDATIONS ════════════════

export function LiquidationPanel({ symbol }: { symbol: string }) {
  const heat = useBq<Any>('/liquidation/heatmap', { symbol }, { pollMs: 90_000 });
  const dist = useBq<Any>('/liquidation/distribution', { symbol }, { pollMs: 90_000 });

  const hm = (heat.data ?? {}) as { price_levels?: number[]; time_buckets?: string[]; intensity_matrix?: number[][]; clusters?: Array<Any>; horizon_hours?: number };
  const ds = (dist.data ?? {}) as { levels?: Array<Any>; nearest_magnet?: Any };

  return (
    <div className="space-y-3">
      <Panel title="Liquidation Heatmap" subtitle={`estimated liquidation intensity (price × time, next ${hm.horizon_hours ?? 16}h)`} {...panelProps(heat)}>
        {hm.intensity_matrix ? (
          <BqHeatMatrix
            rowLabels={(hm.price_levels ?? []).map((p) => fmtPx(p))}
            colLabels={(hm.time_buckets ?? []).map((_, i) => `+${(i + 1) * (Number(hm.horizon_hours ?? 16) / (hm.time_buckets?.length ?? 16))}h`)}
            matrix={hm.intensity_matrix ?? []}
            unit="intensity 0–100"
            diverging={false}
            format={(v) => `${Math.round(v)}`}
            rowTitle="price"
          />
        ) : (
          <EmptyNote text="no heatmap" />
        )}
        {hm.clusters?.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {hm.clusters.slice(0, 5).map((c, i) => (
              <span key={i} className="flex items-center gap-1 rounded-full border border-amber-800/50 bg-amber-950/20 px-2 py-0.5 text-[9px] text-amber-200">
                <span className="font-mono">{fmtPx(c.price)}</span>
                <span className="text-amber-400/70">{fmtNum(c.intensity, 0)}/100</span>
              </span>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel title="Liquidation Distribution" subtitle="long / short volumes per level with leverage tiers" {...panelProps(dist)}>
        <BqTable
          columns={[
            { key: 'price', label: 'price', align: 'right', render: (r) => fmtPx(r.price) },
            { key: 'distance_pct', label: 'Δ%', align: 'right', render: (r) => <span className={Number(r.distance_pct) >= 0 ? 'text-teal-400' : 'text-rose-400'}>{fmtPct(r.distance_pct)}</span> },
            { key: 'long_usd', label: 'long liq', align: 'right', render: (r) => fmtUsd(r.long_usd) },
            { key: 'short_usd', label: 'short liq', align: 'right', render: (r) => fmtUsd(r.short_usd) },
            { key: 'leverage_est', label: 'lev', align: 'right', render: (r) => <span className="rounded bg-zinc-800/60 px-1 text-[8.5px] text-zinc-400">{String(r.leverage_est ?? '—')}</span> },
          ]}
          rows={(ds.levels ?? []) as Any[]}
          maxHeight={340}
        />
        {ds.nearest_magnet ? (
          <p className="mt-2 text-[9.5px] text-zinc-500">
            nearest magnet: <span className="font-mono text-amber-300">{fmtPx(ds.nearest_magnet.price)}</span> ({String(ds.nearest_magnet.side)} side)
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════════════ MARKET DATA ═════════════════

export function MarketPanel({ symbol }: { symbol: string }) {
  const bundle = useBq<Any>('/market/bundle', { symbol, interval: '1h', hours: 120 }, { pollMs: 60_000 });
  const cvd = useBq<Any>('/market/cvd', { symbol, market: 'perp', interval: '1h', hours: 72 }, { pollMs: 60_000 });
  const liquidations = useBq<Any>('/market/liquidations', { symbol, interval: '1h', hours: 72 }, { pollMs: 90_000 });
  const funding = useBq<Any>('/market/funding', { symbol, interval: '1h', hours: 168 }, { pollMs: 90_000 });

  const bu = (bundle.data ?? {}) as { points?: Array<Any>; spot?: number };
  const cv = (cvd.data ?? {}) as { points?: Array<Any>; market?: string };
  const lq = (liquidations.data ?? {}) as { points?: Array<Any> };
  const fu = (funding.data ?? {}) as { points?: Array<Any>; current?: Any };

  return (
    <div className="space-y-3">
      <Panel title="Market Bundle" subtitle="price · open interest · funding on one aligned axis (120h)" {...panelProps(bundle)}>
        <BqSeriesChart
          points={(bu.points ?? []).map((p) => ({ ts: p.ts, price: p.price, oi: Number(p.open_interest) / 1e9, funding: Number(p.funding_rate) * 100 }))}
          series={[
            { key: 'price', color: CHART_COLORS.teal, name: 'price' },
            { key: 'oi', color: CHART_COLORS.violet, name: 'OI $B', yAxis: 'right' },
            { key: 'funding', color: CHART_COLORS.amber, name: 'funding %', yAxis: 'right' },
          ]}
          xFormatter={(v) => fmtDate(String(v).slice(0, 16))}
          yFormatter={(v) => fmtPx(v)}
          rightFormatter={(v) => v.toFixed(2)}
          height={230}
        />
      </Panel>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="CVD — Perp" subtitle="cumulative volume delta (aggressor flow)" {...panelProps(cvd)}>
          <BqSeriesChart
            points={(cv.points ?? []).map((p) => ({ ts: p.ts, cum: p.cumulative, delta: p.delta }))}
            series={[
              { key: 'cum', color: CHART_COLORS.sky, name: 'cumulative', type: 'area' },
              { key: 'delta', color: CHART_COLORS.zinc, name: 'per-bucket' },
            ]}
            xFormatter={(v) => fmtDate(String(v).slice(0, 16))}
            yFormatter={(v) => fmtUsd(v)}
            height={185}
          />
        </Panel>
        <Panel title="Perp Liquidations" subtitle="long / short liquidation series" {...panelProps(liquidations)}>
          <BqSeriesChart
            points={(lq.points ?? []).map((p) => ({ ts: p.ts, long: p.long_usd, short: p.short_usd }))}
            series={[
              { key: 'long', color: CHART_COLORS.rose, name: 'long liq $', type: 'bar' },
              { key: 'short', color: CHART_COLORS.teal, name: 'short liq $', type: 'bar' },
            ]}
            xFormatter={(v) => fmtDate(String(v).slice(0, 16))}
            yFormatter={(v) => fmtUsd(v)}
            height={185}
          />
        </Panel>
      </div>

      <Panel title="Funding Rate" subtitle="aggregate perpetual funding (168h)" {...panelProps(funding)}>
        <BqSeriesChart
          points={(fu.points ?? []).map((p) => ({ ts: p.ts, fr: Number(p.funding_rate) * 100 }))}
          series={[{ key: 'fr', color: CHART_COLORS.amber, name: 'funding %/interval', type: 'area' }]}
          xFormatter={(v) => fmtDate(String(v).slice(0, 16))}
          yFormatter={(v) => `${v.toFixed(3)}%`}
          referenceY={0}
          height={160}
          legend={false}
        />
        {fu.current ? (
          <div className="mt-2">
            <StatTiles
              columns={2}
              stats={[
                { label: 'current funding', value: `${fmtNum(Number(fu.current.funding_rate) * 100, 4)}%`, delta: Number(fu.current.funding_rate) >= 0 ? 'longs pay shorts' : 'shorts pay longs', deltaPositive: Number(fu.current.funding_rate) < 0 },
                { label: 'annualized', value: fmtPct(fu.current.funding_annualized_pct) },
              ]}
            />
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

// ═══════════════════════════════════════════════ ETF · COT · FILINGS ═════════

export function MacroPanel({ symbol }: { symbol: string }) {
  const isEth = symbol.startsWith('ETH');
  const etfSymbol = isEth ? 'ETH' : 'BTC';
  const [filingTab, setFilingTab] = useState<'cot' | 'insider' | 'holders'>('cot');
  const [ticker, setTicker] = useState(isEth ? 'COIN' : 'COIN');

  const flows = useBq<Any>('/etf/flows', { symbol: etfSymbol, region: 'us' }, { pollMs: 300_000 });
  const aum = useBq<Any>('/etf/aum', { symbol: etfSymbol }, { pollMs: 300_000 });
  const premium = useBq<Any>('/etf/premium', { symbol: etfSymbol }, { pollMs: 300_000 });
  const cot = useBq<Any>('/cot/summary', { window: '3y', limit: 8 }, { pollMs: 600_000, enabled: filingTab === 'cot' });
  const insider = useBq<Any>('/filings/insider', { ticker, lookback: '90d' }, { pollMs: 600_000, enabled: filingTab === 'insider' });
  const holders = useBq<Any>('/filings/holders', { ticker: ticker === 'COIN' || ticker === 'HOOD' ? ticker : 'MSTR', limit: 10 }, { pollMs: 600_000, enabled: filingTab === 'holders' });

  const fl = (flows.data ?? {}) as { funds?: Array<Any>; total?: Any; as_of_settlement?: string };
  const au = (aum.data ?? {}) as { funds?: Array<Any>; total_aum_usd?: number };
  const pr = (premium.data ?? {}) as { funds?: Array<Any> };
  const co = (cot.data ?? {}) as { markets?: Array<Any> };
  const ins = (insider.data ?? {}) as { transactions?: Array<Any> };
  const hs = (holders.data ?? {}) as { holders?: Array<Any> };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
        <Panel title={`Spot ${etfSymbol} ETF Flows`} subtitle={`daily creations / redemptions · settlement ${fl.as_of_settlement ?? ''} (T-1 by design)`} {...panelProps(flows)}>
          <div className="space-y-1.5">
            {(fl.funds ?? []).map((f, i) => {
              const flow = Number(f.daily_net_flow_usd ?? 0);
              const max = Math.max(...(fl.funds ?? []).map((x) => Math.abs(Number(x.daily_net_flow_usd ?? 0))), 1);
              const w = (Math.abs(flow) / max) * 50;
              return (
                <div key={i} className="flex items-center gap-1.5 text-[9.5px]" title={`${String(f.name)} · cumulative ${fmtUsd(f.cumulative_net_flow_usd)}`}>
                  <span className="w-[42px] shrink-0 font-mono font-medium text-zinc-300">{String(f.ticker)}</span>
                  <div className="relative flex h-[12px] min-w-0 flex-1 items-center justify-center">
                    <div className="absolute inset-y-[6px] left-0 right-0 bg-zinc-800/40" />
                    {flow >= 0 ? <div className="absolute left-1/2 h-full rounded-l-sm bg-teal-500/60" style={{ width: `${w}%` }} /> : <div className="absolute right-1/2 h-full rounded-r-sm bg-rose-500/60" style={{ width: `${w}%` }} />}
                    <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-700" />
                  </div>
                  <span className={`w-[64px] shrink-0 text-right font-mono tabular-nums ${flow >= 0 ? 'text-teal-300' : 'text-rose-300'}`}>{fmtUsd(flow)}</span>
                </div>
              );
            })}
          </div>
          {fl.total ? (
            <div className="mt-3">
              <StatTiles
                columns={2}
                stats={[
                  { label: 'daily net flow', value: fmtUsd(fl.total.daily_net_flow_usd), delta: Number(fl.total.daily_net_flow_usd) >= 0 ? 'inflows' : 'outflows', deltaPositive: Number(fl.total.daily_net_flow_usd) >= 0 },
                  { label: 'cumulative', value: fmtUsd(fl.total.cumulative_net_flow_usd) },
                ]}
              />
            </div>
          ) : null}
        </Panel>

        <div className="space-y-3">
          <Panel title="ETF AUM" subtitle="assets under management per fund" {...panelProps(aum)}>
            <StatTiles
              columns={1}
              stats={[
                { label: 'total AUM', value: fmtUsd(au.total_aum_usd) },
                ...(au.funds ?? []).slice(0, 3).map((f) => ({
                  label: String(f.ticker),
                  value: fmtUsd(f.aum),
                  delta: `${Number(f.change_1d_usd) >= 0 ? '+' : ''}${fmtUsd(f.change_1d_usd)} 1d`,
                  deltaPositive: Number(f.change_1d_usd) >= 0,
                })),
              ]}
            />
          </Panel>
          <Panel title="ETF Premium / Discount" subtitle="market price vs NAV" {...panelProps(premium)}>
            <BqTable
              columns={[
                { key: 'ticker', label: 'fund' },
                { key: 'market_price', label: 'price', align: 'right', render: (r) => fmtNum(r.market_price) },
                { key: 'nav', label: 'nav', align: 'right', render: (r) => fmtNum(r.nav) },
                { key: 'premium_pct', label: 'premium', align: 'right', render: (r) => <span className={Number(r.premium_pct) >= 0 ? 'text-teal-400' : 'text-rose-400'}>{fmtPct(r.premium_pct, 2)}</span> },
              ]}
              rows={(pr.funds ?? []) as Any[]}
              maxHeight={150}
            />
          </Panel>
        </div>
      </div>

      <Panel
        title="Regulatory Filings & Positioning"
        subtitle="CFTC COT · SEC Form 4 insiders · 13F institutional holders"
        right={
          <div className="flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-0.5">
            {(['cot', 'insider', 'holders'] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setFilingTab(t);
                  if (t === 'holders' && ticker !== 'MSTR' && ticker !== 'COIN' && ticker !== 'HOOD') setTicker('MSTR');
                }}
                className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${filingTab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                {t === 'cot' ? 'COT' : t === 'insider' ? 'Form 4' : '13F'}
              </button>
            ))}
          </div>
        }
      >
        {filingTab === 'cot' ? (
          <BqTable
            columns={[
              { key: 'name', label: 'market' },
              { key: 'net_leveraged_funds', label: 'net lev funds', align: 'right', render: (r) => <span className={Number(r.net_leveraged_funds) >= 0 ? 'text-teal-300' : 'text-rose-300'}>{fmtNum(r.net_leveraged_funds, 0)}</span> },
              { key: 'net_asset_managers', label: 'net asset mgrs', align: 'right', render: (r) => <span className={Number(r.net_asset_managers) >= 0 ? 'text-teal-300' : 'text-rose-300'}>{fmtNum(r.net_asset_managers, 0)}</span> },
              { key: 'weekly_change', label: 'wk Δ', align: 'right', render: (r) => <span className={Number(r.weekly_change) >= 0 ? 'text-teal-400' : 'text-rose-400'}>{fmtNum(r.weekly_change, 0)}</span> },
              { key: 'percentile_3y', label: '3y pct', align: 'right', render: (r) => {
                const p = Number(r.percentile_3y);
                return <span className={`rounded px-1 ${p > 80 ? 'bg-amber-950/50 text-amber-300' : p < 20 ? 'bg-sky-950/50 text-sky-300' : 'text-zinc-400'}`}>{Math.round(p)}th</span>;
              } },
            ]}
            rows={(co.markets ?? []) as Any[]}
            maxHeight={280}
          />
        ) : filingTab === 'insider' ? (
          <>
            <div className="mb-2 flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-0.5">
              {['COIN', 'HOOD'].map((t) => (
                <button key={t} onClick={() => setTicker(t)} className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${ticker === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500'}`}>{t}</button>
              ))}
            </div>
            <BqTable
              columns={[
                { key: 'filing_date', label: 'filed', render: (r) => fmtDate(r.filing_date) },
                { key: 'insider', label: 'insider' },
                { key: 'role', label: 'role', render: (r) => <span className="text-[8.5px] text-zinc-500">{String(r.role ?? '')}</span> },
                { key: 'action', label: 'action', align: 'right', render: (r) => <span className={r.action === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>{String(r.action).toUpperCase()}</span> },
                { key: 'shares', label: 'shares', align: 'right', render: (r) => fmtNum(r.shares, 0) },
                { key: 'value_usd', label: 'value', align: 'right', render: (r) => fmtUsd(r.value_usd) },
              ]}
              rows={(ins.transactions ?? []) as Any[]}
              maxHeight={260}
            />
          </>
        ) : (
          <>
            <div className="mb-2 flex gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-0.5">
              {['MSTR', 'COIN', 'HOOD', 'IBIT'].map((t) => (
                <button key={t} onClick={() => setTicker(t)} className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${ticker === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500'}`}>{t}</button>
              ))}
            </div>
            <BqTable
              columns={[
                { key: 'holder', label: 'holder' },
                { key: 'shares', label: 'shares', align: 'right', render: (r) => fmtNum(r.shares, 0) },
                { key: 'value_usd', label: 'value', align: 'right', render: (r) => fmtUsd(r.value_usd) },
                { key: 'change_shares', label: 'qtr Δ shares', align: 'right', render: (r) => <span className={Number(r.change_shares) >= 0 ? 'text-teal-400' : 'text-rose-400'}>{fmtNum(r.change_shares, 0)}</span> },
                { key: 'change_pct', label: 'qtr Δ%', align: 'right', render: (r) => fmtPct(r.change_pct) },
              ]}
              rows={(hs.holders ?? []) as Any[]}
              maxHeight={260}
            />
          </>
        )}
      </Panel>
    </div>
  );
}

'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW VIEW — the native order-flow workspace.
//
//   • live heatmap chart (resting liquidity + prints + liq + micro markers
//     + prior-session levels + footprint cells) with pan / zoom / follow
//   • KPI strip · CVD · liquidation buckets
//   • right rail: Tape · Book · Venues · OI/Funding · Markers · Alerts
//   • whole-market overview strip (every asset × every venue)
//   • order-level drill-down drawer on every print
//
// Microstructure heuristics and visual language adapted from the open-source
// order-flow-screener by zadescoxp (Apache-2.0), rebuilt natively on the
// VolOS server engine (SSE) for our venues: Binance · Bybit · OKX · Deribit.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  BookOpen,
  Diamond,
  Flame,
  LineChart,
  ListOrdered,
  Radio,
  Waves,
} from 'lucide-react';
import { useOrderFlow } from './use-orderflow';
import { FlowChart, type FlowChartOptions } from './flow-chart';
import { AlertsPanel, BookPanel, CvdStrip, DerivativesPanel, KpiStrip, LiquidationMiniChart, MarkersPanel, TapePanel, VenuesPanel } from './panels';
import { MarketOverview } from './market-overview';
import { OrderDrawer } from './order-drawer';
import type { OfAlertSettings, OfAsset, OfVenueId } from '@/lib/orderflow/types';

const ASSETS: OfAsset[] = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'LINK', 'AVAX'];
const VENUE_FILTERS: Array<{ id: OfVenueId | 'all'; label: string }> = [
  { id: 'all', label: 'all venues' },
  { id: 'binance', label: 'binance' },
  { id: 'bybit', label: 'bybit' },
  { id: 'okx', label: 'okx' },
  { id: 'bitget', label: 'bitget' },
  { id: 'hyperliquid', label: 'hl' },
  { id: 'deribit', label: 'deribit' },
  { id: 'coinbase', label: 'cb spot' },
  { id: 'kraken', label: 'kraken' },
];
const TFS: Array<{ tf: number; label: string }> = [
  { tf: 60_000, label: '1m' },
  { tf: 300_000, label: '5m' },
  { tf: 900_000, label: '15m' },
  { tf: 1_800_000, label: '30m' },
];
const RIGHT_TABS = [
  { id: 'tape', label: 'tape', icon: <ListOrdered className="h-3 w-3" /> },
  { id: 'book', label: 'book', icon: <BookOpen className="h-3 w-3" /> },
  { id: 'venues', label: 'venues', icon: <Activity className="h-3 w-3" /> },
  { id: 'deriv', label: 'oi/funding', icon: <Waves className="h-3 w-3" /> },
  { id: 'markers', label: 'markers', icon: <Diamond className="h-3 w-3" /> },
  { id: 'alerts', label: 'alerts', icon: <Bell className="h-3 w-3" /> },
] as const;

function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* private mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  };
  return [value, set];
}

export function OrderFlowView() {
  const [asset, setAsset] = usePersisted<OfAsset>('volos-of-asset', 'BTC');
  const [tf, setTf] = usePersisted<number>('volos-of-tf', 60_000);
  const [venueFilter, setVenueFilter] = useState<OfVenueId | 'all'>('all');
  const [rightTab, setRightTab] = useState<(typeof RIGHT_TABS)[number]['id']>('tape');
  const [printId, setPrintId] = useState<string | null>(null);
  const [options, setOptions] = usePersisted<FlowChartOptions>('volos-of-options', {
    showHeatmap: true,
    showFootprint: true,
    showBubbles: true,
    showLiquidations: true,
    showMarkers: true,
    showLevels: true,
    follow: true,
  });
  const [alertSettings, setAlertSettings] = usePersisted<OfAlertSettings>('volos-of-alerts', {
    vwapCross: true,
    valueAreaEdge: true,
    volumeSpike: 3,
    blockPrint: 10,
    cvdDivergence: true,
    largeLiquidation: 250_000,
    absorption: true,
    iceberg: true,
  });

  const { store, state } = useOrderFlow(asset, { tf, alertSettings, minutes: 15 });
  const alerts = state.alerts;
  const cascade = state.liqBuckets?.length ? undefined : undefined;

  // critical-alert toasts (top-right, auto-fade)
  const [toast, setToast] = useState<{ id: string; title: string; detail?: string } | null>(null);
  useEffect(() => {
    const last = alerts[alerts.length - 1];
    if (last && last.severity !== 'info') {
      setToast({ id: last.id, title: last.title, detail: last.detail });
      const t = setTimeout(() => setToast(null), 6000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts.length]);

  const toggleOption = (key: keyof FlowChartOptions) => setOptions({ ...options, [key]: !options[key] });
  const liveCount = state.connections.filter((c) => c.status === 'live').length;

  const optionChips: Array<{ key: keyof FlowChartOptions; label: string; title: string }> = [
    { key: 'showHeatmap', label: 'liquidity heat', title: 'resting-liquidity heatmap — order-book depth over time' },
    { key: 'showFootprint', label: 'footprint', title: 'per-price bid×ask volume per candle' },
    { key: 'showBubbles', label: 'prints', title: 'trade bubbles sized by notional; rings mark ≥5× average' },
    { key: 'showLiquidations', label: 'liq bubbles', title: 'forced-close bubbles (L = longs, S = shorts)' },
    { key: 'showMarkers', label: 'ABS/ICE', title: 'absorption bands and iceberg diamonds' },
    { key: 'showLevels', label: 'levels', title: 'prior-day POC/VAH/VAL/VWAP, naked POCs, session VWAP ±1σ' },
  ];

  return (
    <div className="space-y-2 pb-2">
      {/* ── header controls ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-2 py-1.5">
        <span className="flex items-center gap-1.5 pr-1">
          <Flame className="h-4 w-4 text-amber-400" />
          <span className="text-[12px] font-semibold tracking-tight text-zinc-100">
            Order Flow <span className="text-zinc-600">·</span>
          </span>
        </span>
        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          {ASSETS.map((a) => (
            <button
              key={a}
              onClick={() => setAsset(a)}
              className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold transition ${
                asset === a ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {a}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          {VENUE_FILTERS.map((v) => (
            <button
              key={v.id}
              onClick={() => setVenueFilter(v.id)}
              className={`rounded-md px-2 py-1 text-[10px] transition ${
                venueFilter === v.id ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          {TFS.map((t) => (
            <button
              key={t.tf}
              onClick={() => setTf(t.tf)}
              className={`rounded-md px-2 py-1 font-mono text-[10px] transition ${
                tf === t.tf ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {optionChips.map((c) => (
            <button
              key={c.key}
              onClick={() => toggleOption(c.key)}
              title={c.title}
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold transition ${
                options[c.key] ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'bg-zinc-900 text-zinc-600 hover:text-zinc-300'
              }`}
            >
              {c.label}
            </button>
          ))}
          <button
            onClick={() => toggleOption('follow')}
            title="follow the live edge — click any empty chart spot to re-arm"
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold transition ${
              options.follow ? 'bg-emerald-950/60 text-emerald-300 ring-1 ring-emerald-500/30' : 'bg-zinc-900 text-zinc-600 hover:text-zinc-300'
            }`}
          >
            <Radio className={`h-2.5 w-2.5 ${options.follow ? 'animate-pulse' : ''}`} />
            live
          </button>
          <a
            href={`/api/orderflow/export?asset=${asset}&what=trades`}
            className="rounded bg-zinc-900 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-500 transition hover:text-zinc-300"
            title="CSV export — the last 20,000 prints with ratio and displayed size"
          >
            csv
          </a>
        </div>
        <span className="ml-auto flex items-center gap-2 font-mono text-[8.5px] text-zinc-600">
          <span className={`flex items-center gap-1 ${state.connected ? 'text-emerald-400' : 'text-amber-400'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${state.connected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
            {state.connected ? 'streaming' : 'connecting'}
          </span>
          <span>
            {liveCount}/{venueFilter === 'all' ? state.connections.length : 1} venues live
          </span>
        </span>
      </div>

      {/* ── main grid ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 xl:flex-row">
        {/* left: chart + strips */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <FlowChart
            store={store}
            tf={tf}
            options={options}
            height={440}
            onPrintClick={(id) => setPrintId(id)}
            onFollowChange={(follow) => setOptions({ ...options, follow })}
          />
          <KpiStrip store={store} />
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <CvdStrip store={store} />
            <LiquidationMiniChart store={store} />
          </div>
        </div>

        {/* right rail */}
        <div className="flex w-full shrink-0 flex-col rounded-lg border border-zinc-800/80 bg-[#06090f] xl:w-[380px]">
          <div className="flex items-center gap-0.5 overflow-x-auto border-b border-zinc-800/70 px-1.5 py-1">
            {RIGHT_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setRightTab(t.id)}
                className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[9.5px] font-semibold transition ${
                  rightTab === t.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t.icon}
                {t.label}
                {t.id === 'alerts' && alerts.length > 0 && (
                  <span className="rounded-full bg-amber-500/20 px-1 text-[7.5px] font-bold text-amber-300">{alerts.length}</span>
                )}
              </button>
            ))}
          </div>
          <div className="h-[430px] min-h-0">
            {rightTab === 'tape' && <TapePanel store={store} venueFilter={venueFilter} onPrintClick={(id) => setPrintId(id)} />}
            {rightTab === 'book' && <BookPanel store={store} />}
            {rightTab === 'venues' && <VenuesPanel store={store} />}
            {rightTab === 'deriv' && <DerivativesPanel store={store} />}
            {rightTab === 'markers' && <MarkersPanel store={store} />}
            {rightTab === 'alerts' && <AlertsPanel store={store} settings={alertSettings} onSettings={setAlertSettings} />}
          </div>
        </div>
      </div>

      {/* ── whole-market overview ─────────────────────────────────────────── */}
      <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-2">
        <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
          <LineChart className="h-3.5 w-3.5 text-teal-400" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400">whole market</span>
          <span className="text-[8px] text-zinc-600">every venue · OI · funding · liquidations · flow — click to drill in</span>
        </div>
        <MarketOverview active={asset} onSelect={setAsset} />
      </div>

      {/* toast */}
      {toast && (
        <div className="fixed right-4 top-16 z-50 max-w-xs animate-in slide-in-from-right-4 rounded-lg border border-amber-500/40 bg-[#100d08]/95 px-3 py-2 shadow-xl backdrop-blur">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            {toast.title}
          </p>
          {toast.detail && <p className="mt-0.5 text-[9px] leading-snug text-zinc-400">{toast.detail}</p>}
        </div>
      )}

      <OrderDrawer id={printId} onClose={() => setPrintId(null)} onPrintClick={(id) => setPrintId(id)} />
    </div>
  );
}

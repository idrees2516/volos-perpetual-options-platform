'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-indicators — the INDICATORS tab (V2 P2): the technical
// battery as a real charting surface.
//
//   <IndicatorChart> (candles + overlays + sub-oscillator) fed by
//   GET /api/quant/indicators — store-first bars, server-side kernels — plus
//   the decision pill strip (trend, RSI, ADX, ATR%, HV ratio, squeeze, CVD).
//
//   TF picker 5m→1d · overlay toggles (EMAs · Bollinger · VWAP · Supertrend ·
//   Ichimoku cloud · Donchian) · sub-pane picker (delta+CVD · RSI · MACD ·
//   Stoch · ADX · OBV) — every choice persisted to localStorage, so the desk
//   comes back exactly as you left it.
// -----------------------------------------------------------------------------

import React from 'react';
import { Info } from 'lucide-react';
import { PanelState } from '@/components/ui/panel-state';
import { usePersistedState } from '@/hooks/use-persisted-state';
import type { IndicatorSnapshot, TfKey } from '@/lib/quant/indicator-service';
import { IndicatorChart, type SubPane } from './indicator-chart';
import { useQuant, useAgeLabel } from './use-quant';
import { Pill, LiveDot, Segmented } from './quant-viz';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';

// ── persisted control state (external-store pattern — see use-persisted-state) ──

const TFS: TfKey[] = ['5m', '15m', '30m', '1h', '4h', '1d'];

const OVERLAYS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'ema', label: 'EMA 20/50/200', hint: 'trend stack' },
  { id: 'bb', label: 'Bollinger 20·2σ', hint: 'volatility envelope' },
  { id: 'vwap', label: 'VWAP (daily anchor)', hint: 'execution benchmark' },
  { id: 'supertrend', label: 'Supertrend 10·3', hint: 'ATR trailing stop' },
  { id: 'ichimoku', label: 'Ichimoku + cloud', hint: 'trend structure, projected 26 bars forward' },
  { id: 'donchian', label: 'Donchian 20', hint: 'breakout channel' },
];

const SUBPANES: Array<{ id: SubPane; label: string }> = [
  { id: 'delta', label: 'Δ + CVD' },
  { id: 'rsi', label: 'RSI' },
  { id: 'macd', label: 'MACD' },
  { id: 'stoch', label: 'Stoch' },
  { id: 'adx', label: 'ADX/DMI' },
  { id: 'obv', label: 'OBV' },
];

const DEFAULT_OVERLAYS: Record<string, boolean> = {
  ema: true,
  bb: true,
  vwap: true,
  supertrend: true,
  ichimoku: false,
  donchian: false,
};

// ── the pill strip ───────────────────────────────────────────────────────────

function StatPills({ s }: { s: IndicatorSnapshot['stats'] }) {
  const items: React.ReactNode[] = [];
  if (s.trend != null) {
    items.push(
      <span key="trend" className={`font-mono ${s.trend === 'up' ? 'text-emerald-300' : 'text-rose-300'}`}>
        supertrend {s.trend === 'up' ? '▲ up' : '▼ down'}
      </span>,
    );
  }
  if (s.rsi14 != null) {
    items.push(
      <span key="rsi" className={`font-mono ${s.rsi14 > 70 ? 'text-rose-300' : s.rsi14 < 30 ? 'text-emerald-300' : 'text-zinc-300'}`}>
        rsi {s.rsi14.toFixed(1)}
      </span>,
    );
  }
  if (s.adx14 != null) {
    items.push(
      <span key="adx" className={`font-mono ${s.adx14 > 25 ? 'text-amber-300' : 'text-zinc-500'}`}>
        adx {s.adx14.toFixed(1)}{s.adx14 > 25 ? ' trending' : ' chop'}
      </span>,
    );
  }
  if (s.atrPct != null) items.push(<span key="atr" className="font-mono text-zinc-400">atr {s.atrPct.toFixed(2)}%</span>);
  if (s.hv20Ann != null) {
    items.push(
      <span key="hv" className="font-mono text-zinc-400">
        rv20 {(s.hv20Ann * 100).toFixed(0)}%
        {s.hvRatio != null && (
          <span className={s.hvRatio > 1.2 ? 'text-rose-300' : s.hvRatio < 0.8 ? 'text-emerald-300' : 'text-zinc-500'}>
            {' '}· {s.hvRatio > 1.2 ? 'expanding' : s.hvRatio < 0.8 ? 'compressing' : 'flat'} vs 90d
          </span>
        )}
      </span>,
    );
  }
  if (s.squeezeOn != null) {
    items.push(
      <span key="sq" className={`font-mono ${s.squeezeOn ? 'text-amber-300' : 'text-zinc-500'}`}>
        {s.squeezeOn ? 'squeeze ON — energy coiled' : 'squeeze off'}
      </span>,
    );
  }
  if (s.cvdWindow != null) {
    items.push(
      <span key="cvd" className={`font-mono ${s.cvdWindow >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
        window cvd {s.cvdWindow >= 0 ? '+' : ''}{(s.cvdWindow / 1000).toFixed(1)}k
      </span>,
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px]">
      {items.map((it, i) => (
        <span key={i} className="contents">{it}</span>
      ))}
    </div>
  );
}

// ── the panel ────────────────────────────────────────────────────────────────

export function IndicatorsPanel({ symbol }: { symbol: string }) {
  const [tf, setTf] = usePersistedState<TfKey>('volos-ind-tf', '1h');
  const [subpane, setSubpane] = usePersistedState<SubPane>('volos-ind-subpane', 'delta');
  const [overlays, setOverlays] = usePersistedState<Record<string, boolean>>('volos-ind-overlays', DEFAULT_OVERLAYS);
  const scan = useQuant<IndicatorSnapshot>('/indicators', { symbol, tf, limit: 240 }, { pollMs: 60_000 });
  const age = useAgeLabel(scan.fetchedAt);
  const data = scan.data;
  const s = data?.stats;

  const toggleOverlay = (id: string) =>
    setOverlays((o) => ({ ...DEFAULT_OVERLAYS, ...o, [id]: !(o?.[id] ?? DEFAULT_OVERLAYS[id]) }));

  return (
    <Dock viewId="quant-indicators">
    <DockPanel
      id="battery"
      title={`Indicators — ${symbol} technical battery`}
      sub="candles + curated overlays from our own kline mirror · server-side kernels · the same numbers the copilot reads"
      right={
        <>
          <Segmented
            value={tf}
            onChange={(v) => setTf(v as TfKey)}
            options={TFS.map((t) => ({ id: t, label: t }))}
          />
          {data && <LiveDot ok={!scan.error} label={`${data.source} · ${age}`} />}
        </>
      }
    >
      <PanelState
        loading={!data && scan.loading}
        error={scan.error}
        onRetry={scan.refresh}
        skeletonRows={10}
        skeletonCols={4}
        empty={data && data.bars.length < 30 ? 'no kline history for this symbol yet' : undefined}
      >
        {data && s && (
          <div className="space-y-2">
            {/* controls row */}
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
              {OVERLAYS.map((o) => {
                const on = overlays?.[o.id] ?? DEFAULT_OVERLAYS[o.id];
                return (
                  <button
                    key={o.id}
                    onClick={() => toggleOverlay(o.id)}
                    title={o.hint}
                    className={`rounded-md border px-2 py-0.5 font-mono text-[9px] transition ${
                      on
                        ? 'border-teal-500/40 bg-teal-500/10 text-teal-300'
                        : 'border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
              <div className="ml-auto flex items-center gap-1">
                <Segmented
                  value={subpane}
                  onChange={(v) => setSubpane(v as SubPane)}
                  options={SUBPANES}
                />
              </div>
            </div>

            {/* the chart */}
            <IndicatorChart
              bars={data.bars}
              series={data.series}
              overlays={{ ...DEFAULT_OVERLAYS, ...overlays }}
              subpane={subpane}
              tfSec={data.tfSec}
              height={420}
            />

            {/* decision strip + provenance */}
            <div className="space-y-1.5">
              <StatPills s={s} />
              <div className="flex items-center justify-between">
                <p className="font-mono text-[8.5px] text-zinc-600">{data.note}</p>
                <span className="flex items-center gap-1 text-[8.5px] text-zinc-600">
                  <Info className="h-3 w-3" />
                  hover the chart for OHLCV + indicator reads
                </span>
              </div>
            </div>

            {data.tfSec >= 86_400 && (
              <Pill tone="zinc">1d bars from the live venue while the kline mirror fills</Pill>
            )}
          </div>
        )}
      </PanelState>
    </DockPanel>
    </Dock>
  );
}


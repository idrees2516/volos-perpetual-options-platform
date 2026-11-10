'use client';

// ─────────────────────────────────────────────────────────────────────────────
// FORECAST VIEW — the conformal-prediction workspace.
//
// TimeCopilot foundationforecast's conformal-prediction example, rebuilt
// natively on the order-flow engine's flow bars:
//
//   • config bar   asset · flow-bar timeframe · target (price, volume, delta,
//                  CVD, buy share, prints, OI, venue panels) · horizon h ·
//                  interval levels · calibration windows W
//   • fan chart    flow-bar history + calibrated level bands + point lines,
//                  model switch + overlays + crosshair
//   • KPI strip    point / expected move / calibration / history provenance
//   • right rail   Models (3-way cards) · Evaluate (the docs' cross-validation
//                  table) · Calibration (diagnostics) · Live (walk-forward
//                  coverage from the SSE stream)
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Activity, Gauge, LineChart, RefreshCw, Sigma } from 'lucide-react';
import { useForecast, FORECAST_TARGETS, type FcConfig, type FcTargetId } from './use-forecast';
import { ForecastChart } from './forecast-chart';
import { CalibPanel, EvaluatePanel, ForecastKpiStrip, LiveCoveragePanel, ModelsPanel } from './panels';
import type { OfAsset } from '@/lib/orderflow/types';

const ASSETS: OfAsset[] = ['BTC', 'ETH', 'SOL'];
const TFS: Array<{ tf: number; label: string }> = [
  { tf: 60_000, label: '1m' },
  { tf: 300_000, label: '5m' },
  { tf: 900_000, label: '15m' },
  { tf: 1_800_000, label: '30m' },
];
const HS: number[] = [12, 30, 60, 120];
const LEVELSETS: number[][] = [
  [80, 95],
  [70, 85, 95],
  [50, 80, 90, 99],
];
const WINDOWS: number[] = [5, 10, 20];
const RIGHT_TABS = [
  { id: 'models', label: 'models', icon: <Sigma className="h-3 w-3" /> },
  { id: 'evaluate', label: 'evaluate', icon: <Activity className="h-3 w-3" /> },
  { id: 'calib', label: 'calibration', icon: <Gauge className="h-3 w-3" /> },
  { id: 'live', label: 'live', icon: <LineChart className="h-3 w-3" /> },
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

export function ForecastView() {
  const [asset, setAsset] = usePersisted<OfAsset>('volos-fc-asset', 'BTC');
  const [tf, setTf] = usePersisted<number>('volos-fc-tf', 60_000);
  const [target, setTarget] = usePersisted<FcTargetId>('volos-fc-target', 'close');
  const [h, setH] = usePersisted<number>('volos-fc-h', 30);
  const [levelsIdx, setLevelsIdx] = usePersisted<number>('volos-fc-levels', 0);
  const [nWindows, setNWindows] = usePersisted<number>('volos-fc-nwin', 10);
  const [primaryAlias, setPrimaryAlias] = usePersisted<string>('volos-fc-primary', 'FlowX-distribution');
  const [overlays, setOverlays] = useState<string[]>(['Ensemble-error']);
  const [showBands, setShowBands] = useState(true);
  const [historyBars, setHistoryBars] = useState(160);
  const [rightTab, setRightTab] = useState<(typeof RIGHT_TABS)[number]['id']>('models');

  const config: FcConfig = {
    asset,
    tf,
    target,
    h,
    levels: LEVELSETS[Math.min(levelsIdx, LEVELSETS.length - 1)],
    nWindows,
  };
  const { state, reloadEval } = useForecast(config, rightTab === 'evaluate');

  // keep the persisted primary valid whenever the model list changes
  useEffect(() => {
    if (!state.models.length) return;
    if (!state.models.some((m) => m.alias === primaryAlias)) {
      const fallback = state.models.find((m) => m.intervals === 'conformal_distribution') ?? state.models[0];
      setPrimaryAlias(fallback.alias);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.models.length, primaryAlias]);

  const toggleOverlay = (alias: string) =>
    setOverlays((o) => (o.includes(alias) ? o.filter((a) => a !== alias) : [...o, alias]));

  const liveDot = state.live ? 'bg-emerald-500' : state.error ? 'bg-rose-500' : 'bg-amber-400 animate-pulse';

  return (
    <div className="space-y-2 pb-2">
      {/* ── header controls ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-2 py-1.5">
        <span className="flex items-center gap-1.5 pr-1">
          <Sigma className="h-4 w-4 text-teal-400" />
          <span className="text-[12px] font-semibold tracking-tight text-zinc-100">
            Forecast <span className="text-zinc-600">·</span>
          </span>
          <span className={`ml-1 h-1.5 w-1.5 rounded-full ${liveDot}`} title={state.live ? 'SSE live' : state.error ? 'error' : 'connecting…'} />
        </span>

        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          {ASSETS.map((a) => (
            <button
              key={a}
              onClick={() => setAsset(a)}
              className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition ${
                asset === a ? 'bg-teal-500/20 text-teal-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {a}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          {TFS.map((t) => (
            <button
              key={t.tf}
              onClick={() => setTf(t.tf)}
              className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition ${
                tf === t.tf ? 'bg-teal-500/20 text-teal-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* target */}
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as FcTargetId)}
          className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-1.5 py-1 font-mono text-[10px] text-zinc-300 outline-none transition hover:border-zinc-700"
          title="forecast target built from flow bars"
        >
          {FORECAST_TARGETS.map((t) => (
            <option key={t.id} value={t.id} className="bg-zinc-900">
              {t.label}
            </option>
          ))}
        </select>

        {/* horizon */}
        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          <span className="px-1 text-[9px] text-zinc-600">h</span>
          {HS.map((hh) => (
            <button
              key={hh}
              onClick={() => setH(hh)}
              className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition ${
                h === hh ? 'bg-teal-500/20 text-teal-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {hh}
            </button>
          ))}
        </div>

        {/* levels */}
        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          <span className="px-1 text-[9px] text-zinc-600">levels</span>
          {LEVELSETS.map((ls, i) => (
            <button
              key={ls.join()}
              onClick={() => setLevelsIdx(i)}
              className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition ${
                levelsIdx === i ? 'bg-teal-500/20 text-teal-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {ls.join('/')}%
            </button>
          ))}
        </div>

        {/* calibration windows */}
        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5">
          <span className="px-1 text-[9px] text-zinc-600">W</span>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setNWindows(w)}
              className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition ${
                nWindows === w ? 'bg-teal-500/20 text-teal-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="conformal calibration windows"
            >
              {w}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setShowBands((b) => !b)}
            className={`rounded-lg border px-2 py-0.5 text-[9px] transition ${
              showBands ? 'border-teal-600/50 bg-teal-950/40 text-teal-300' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
            }`}
            title="toggle conformal level bands on the fan chart"
          >
            bands
          </button>
          <select
            value={historyBars}
            onChange={(e) => setHistoryBars(Number(e.target.value))}
            className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-1.5 py-1 font-mono text-[10px] text-zinc-300 outline-none transition hover:border-zinc-700"
            title="history bars visible left of the cutoff"
          >
            {[80, 160, 320].map((n) => (
              <option key={n} value={n} className="bg-zinc-900">
                {n} bars
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── KPI strip ───────────────────────────────────────────────────── */}
      <ForecastKpiStrip state={state} config={config} primaryAlias={primaryAlias} />

      {/* ── chart + right rail ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 lg:flex-row">
        <div className="min-w-0 flex-1">
          <ForecastChart
            state={state}
            config={config}
            primaryAlias={primaryAlias}
            options={{ historyBars, overlays, showBands }}
            height={440}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[8px] text-zinc-600">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-teal-400" /> primary point
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 rounded-sm bg-teal-400/25 ring-1 ring-teal-400/40" /> conformal band (teal = widest level)
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 bg-zinc-500" /> flow-bar history (bright tail = live engine)
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 bg-amber-400/70" /> overlay point line
            </span>
            <span className="text-zinc-700">
              provenance: klines {state.panel?.provenance?.klinesBars ?? 0} + engine {state.panel?.provenance?.engineBars ?? 0} ·
              season m={state.panel?.seasonLength ?? 1}
              {state.panel?.provenance?.klineError ? ` · kline ✕ ${state.panel.provenance.klineError}` : ''}
            </span>
          </div>
        </div>

        {/* right rail */}
        <div className="w-full shrink-0 lg:w-[340px]">
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-1.5 py-1">
            {RIGHT_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setRightTab(t.id)}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] transition ${
                  rightTab === t.id ? 'bg-teal-500/15 text-teal-300' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
            {rightTab === 'evaluate' && state.evalLoading && <RefreshCw className="ml-auto h-3 w-3 animate-spin text-zinc-600" />}
          </div>

          <div className="mt-1.5 max-h-[560px] overflow-y-auto rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-1.5">
            {rightTab === 'models' && (
              <ModelsPanel
                models={state.models}
                primaryAlias={primaryAlias}
                overlays={overlays}
                onPrimary={setPrimaryAlias}
                onToggleOverlay={toggleOverlay}
              />
            )}
            {rightTab === 'evaluate' && <EvaluatePanel state={state} config={config} onRefresh={() => reloadEval()} />}
            {rightTab === 'calib' && <CalibPanel state={state} primaryAlias={primaryAlias} />}
            {rightTab === 'live' && <LiveCoveragePanel state={state} />}
          </div>
        </div>
      </div>
    </div>
  );
}

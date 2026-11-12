'use client';

// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — client store + hook
//
// One ForecastFeed per (asset, tf, target, h, levels, nWindows):
//   • /api/forecast          full panel + models (on config change)
//   • /api/forecast/stream   SSE: init, then tick (recalibrated forecast,
//                            walk-forward coverage) every max(tf/6, 5s)
//   • /api/forecast/evaluate cross-validation + the docs' evaluation table
//                            (lazy — fetched on demand when the Evaluate tab
//                            is open, refreshed on config change)
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FcTargetId } from '@/lib/forecast/types';
import { FC_TARGETS } from '@/lib/forecast/types';
import type { OfAsset } from '@/lib/orderflow/types';

export interface FcConfig {
  asset: OfAsset;
  tf: number;
  target: FcTargetId;
  h: number;
  levels: number[];
  nWindows: number;
}

export interface FcPanelPoint {
  ds: number;
  y: number;
}

export interface FcRowLevel {
  level: number;
  lo: number;
  hi: number;
}

export interface FcModelRow {
  uniqueId: string;
  alias: string;
  cutoff: number;
  step: number;
  ds: number;
  point: number;
  levels: FcRowLevel[];
}

export interface FcModelUI {
  alias: string;
  model: string;
  modelLabel: string;
  intervals: string;
  note: string;
  rows: FcModelRow[];
  calibration: {
    nWindows: number;
    stepSize: number;
    required: number;
    available: number;
    ok: boolean;
    errorByStep: number[];
  } | null;
  expectedMove: {
    level: number;
    lo: number;
    hi: number;
    point: number;
    width: number;
    widthPct?: number;
    horizonMin?: number;
  } | null;
}

export interface FcEvalRowUI {
  alias: string;
  model: string;
  intervals: string;
  coverage: Record<string, number>;
  width: Record<string, number>;
  mase: number | null;
  scaledCrps: number | null;
  pinball: Record<string, number> | null;
  mae: number | null;
  rmse: number | null;
  smape: number | null;
  clampedAt: number | null;
  forecasts: number;
}

export interface FcCoveragePointUI {
  cutoff: number;
  steps: number;
  covered: Record<string, number>;
  width: number | null;
}

export interface FcEvalData {
  evalRows: FcEvalRowUI[];
  perStep: { alias: string; steps: { step: number; coverage: number; width: number }[] }[];
  coverageTimeline: { alias: string; points: FcCoveragePointUI[] }[] | null;
  cvWindows: number;
}

export interface FcFeedState {
  loading: boolean;
  error: string | null;
  builtAt: number | null;
  live: boolean;
  lastTickAt: number | null;
  panel: {
    series: { uniqueId: string; label: string; liveTailFrom: number | null; points: FcPanelPoint[] }[];
    provenance: {
      klinesBars: number;
      engineBars: number;
      engineOnly: boolean;
      klineError: string | null;
      klineSource?: 'store' | 'store+live' | 'binance' | 'none';
    };
    seasonLength: number;
    bounds: { lo?: number; hi?: number } | null;
  } | null;
  models: FcModelUI[];
  /** walk-forward coverage from the SSE stream (per alias) */
  liveCoverage: { alias: string; level: number; covered: number; total: number; ratio: number }[];
  evalData: FcEvalData | null;
  evalLoading: boolean;
}

const DEFAULT_STATE: FcFeedState = {
  loading: true,
  error: null,
  builtAt: null,
  live: false,
  lastTickAt: null,
  panel: null,
  models: [],
  liveCoverage: [],
  evalData: null,
  evalLoading: false,
};

function configKey(c: FcConfig): string {
  return [c.asset, c.tf, c.target, c.h, c.levels.join('-'), c.nWindows].join('|');
}

export class ForecastFeed {
  readonly key: string;
  private es: EventSource | null = null;
  private listeners = new Set<() => void>();
  private config: FcConfig;
  private st: FcFeedState = { ...DEFAULT_STATE };
  private disposed = false;
  private evalAbort: AbortController | null = null;
  /** whether the evaluate tab wants data */
  private evalWanted = false;
  notifyCount = 0;

  constructor(config: FcConfig) {
    this.config = config;
    this.key = configKey(config);
  }

  get state(): FcFeedState {
    return this.st;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.notifyCount++;
    this.st = { ...this.st };
    for (const fn of this.listeners) fn();
  }

  start() {
    this.openStream();
    if (this.evalWanted) void this.loadEval();
  }

  stop() {
    this.disposed = true;
    this.es?.close();
    this.es = null;
    this.evalAbort?.abort();
    this.evalAbort = null;
    this.listeners.clear();
  }

  private openStream() {
    const c = this.config;
    const params = new URLSearchParams({
      asset: c.asset,
      tf: String(c.tf),
      target: c.target,
      h: String(c.h),
      levels: c.levels.join(','),
      nWindows: String(c.nWindows),
    });
    const es = new EventSource(`/api/forecast/stream?${params}`);
    this.es = es;
    es.addEventListener('init', (e) => {
      if (this.disposed) return;
      try {
        const d = JSON.parse((e as MessageEvent).data);
        if (d.error) {
          this.st.error = d.error;
          this.st.loading = false;
          this.notify();
          return;
        }
        this.st = {
          ...this.st,
          loading: false,
          error: null,
          builtAt: d.builtAt,
          panel: d.panel,
          models: d.models,
          live: true,
        };
        this.notify();
      } catch {
        /* malformed frame */
      }
    });
    es.addEventListener('tick', (e) => {
      if (this.disposed) return;
      try {
        const d = JSON.parse((e as MessageEvent).data);
        if (d.models && this.st.panel) {
          // replace model rows; keep the panel history from init (cheap frame)
          this.st = {
            ...this.st,
            models: d.models,
            liveCoverage: d.coverage ?? this.st.liveCoverage,
            builtAt: d.builtAt,
            lastTickAt: d.builtAt,
            live: true,
          };
          this.notify();
        }
      } catch {
        /* malformed frame */
      }
    });
    es.addEventListener('open', () => {
      if (this.disposed) return;
      if (!this.st.live) {
        this.st.live = true;
        this.notify();
      }
    });
    es.addEventListener('error', () => {
      if (this.disposed) return;
      if (this.st.live) {
        this.st.live = false;
        this.notify();
      }
    });
  }

  setEvalWanted(wanted: boolean) {
    if (this.evalWanted === wanted) return;
    this.evalWanted = wanted;
    if (wanted) void this.loadEval();
  }

  async loadEval(cvWindows = 3) {
    if (this.disposed) return;
    this.evalAbort?.abort();
    const ctl = new AbortController();
    this.evalAbort = ctl;
    this.st.evalLoading = true;
    this.notify();
    const c = this.config;
    const params = new URLSearchParams({
      asset: c.asset,
      tf: String(c.tf),
      target: c.target,
      h: String(c.h),
      levels: c.levels.join(','),
      nWindows: String(c.nWindows),
      cvWindows: String(cvWindows),
    });
    try {
      const res = await fetch(`/api/forecast/evaluate?${params}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const d = await res.json();
      if (this.disposed || d.error) {
        if (d.error) {
          this.st.evalData = null;
        }
      } else {
        this.st.evalData = {
          evalRows: d.evalRows,
          perStep: d.perStep,
          coverageTimeline: d.coverageTimeline ?? null,
          cvWindows: d.cvWindows,
        };
      }
    } catch {
      /* aborted or network */
    } finally {
      if (!this.disposed) {
        this.st.evalLoading = false;
        this.notify();
      }
    }
  }
}

/** React hook: one feed per config, live via SSE, evaluate on demand. */
export function useForecast(config: FcConfig, evalWanted: boolean) {
  const key = configKey(config);
  const feedRef = useRef<ForecastFeed | null>(null);
  const [, setVersion] = useState(0);
  const versionTick = useCallback(() => setVersion((v) => v + 1), []);

  if (!feedRef.current || feedRef.current.key !== key) {
    feedRef.current?.stop();
    feedRef.current = new ForecastFeed(config);
    feedRef.current.subscribe(versionTick);
  }
  const feed = feedRef.current;

  useEffect(() => {
    feed.start();
    return () => feed.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    feed.setEvalWanted(evalWanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evalWanted, key]);

  const state = feed.state;
  return useMemo(
    () => ({ state, reloadEval: () => feed.loadEval() }),
    // feed mutates in place; notifyCount is the version
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, feed.notifyCount, evalWanted],
  );
}

export const FORECAST_TARGETS = FC_TARGETS;
export type { FcTargetId };

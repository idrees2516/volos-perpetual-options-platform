'use client';

// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — projected-state client hook
//
// One fetch (and a slow poll while enabled) of /api/forecast/state per
// (asset, tf, h, levels, nWindows). The same payload feeds BOTH consumers:
//   • the flow chart's forward fan (the overlay ahead of the live price)
//   • the ProjectionPanel ("what everything will be at that price")
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import type { FcProjectedState } from '@/lib/forecast/state';
import type { OfAsset } from '@/lib/orderflow/types';

export interface ProjectionConfig {
  asset: OfAsset;
  tf: number;
  h: number;
  levels: number[];
  nWindows: number;
}

export interface ProjectionFeedState {
  data: FcProjectedState | null;
  loading: boolean;
  error: string | null;
  builtAt: number | null;
}

const POLL_MS = 20_000;

function configKey(c: ProjectionConfig): string {
  return [c.asset, c.tf, c.h, c.levels.join('-'), c.nWindows].join('|');
}

export function useProjection(config: ProjectionConfig, enabled = true) {
  const key = configKey(config);
  const [state, setState] = useState<ProjectionFeedState>({
    data: null,
    loading: enabled,
    error: null,
    builtAt: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }
    const ctl = new AbortController();
    abortRef.current = ctl;
    let stopped = false;

    const load = async () => {
      if (stopped || ctl.signal.aborted) return;
      setState((s) => (s.data ? s : { ...s, loading: true }));
      const params = new URLSearchParams({
        asset: config.asset,
        tf: String(config.tf),
        h: String(config.h),
        levels: config.levels.join(','),
        nWindows: String(config.nWindows),
      });
      try {
        const res = await fetch(`/api/forecast/state?${params}`, { signal: ctl.signal, cache: 'no-store' });
        const d = await res.json();
        if (stopped || ctl.signal.aborted) return;
        if (d.error) {
          setState({ data: null, loading: false, error: String(d.error), builtAt: null });
        } else {
          setState({ data: d as FcProjectedState, loading: false, error: null, builtAt: d.builtAt ?? null });
        }
      } catch {
        if (!ctl.signal.aborted && !stopped) {
          setState((s) => ({ ...s, loading: false, error: s.data ? null : 'unreachable' }));
        }
      }
    };

    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return state;
}

'use client';

// -----------------------------------------------------------------------------
// backquant/use-bq — the BackQuant workspace data hook.
//
// Fetches any of the 70 v2 endpoints through the /api/backquant/* proxy
// (live REST or demo engine — same envelope either way) with loading /
// error / mode states, manual refresh and optional polling.
// -----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BqEnvelope } from '@/lib/backquant/types';

export interface BqState<T> {
  data: T | null;
  meta: BqEnvelope['meta'] | null;
  mode: 'live' | 'demo' | 'unknown';
  loading: boolean;
  error: string | null;
  refresh: () => void;
  fetchedAt: number | null;
}

function buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
  }
  const p = path.startsWith('/') ? path : `/${path}`;
  return `/api/backquant${p}${qs.size ? `?${qs.toString()}` : ''}`;
}

export function useBq<T = unknown>(
  path: string | null,
  params?: Record<string, string | number | boolean | undefined>,
  opts?: { pollMs?: number; enabled?: boolean },
): BqState<T> {
  const enabled = opts?.enabled !== false;
  const key = path ? buildUrl(path, params) : null;
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<BqEnvelope['meta'] | null>(null);
  const [mode, setMode] = useState<'live' | 'demo' | 'unknown'>('unknown');
  const [loading, setLoading] = useState<boolean>(Boolean(path && enabled));
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!key || !enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    const run = async () => {
      try {
        const res = await fetch(key, { cache: 'no-store' });
        const env = (await res.json()) as BqEnvelope<T>;
        if (cancelled || !mounted.current) return;
        const hdrMode = res.headers.get('X-BackQuant-Mode');
        setMode(hdrMode === 'live' || hdrMode === 'demo' ? hdrMode : env.demo ? 'demo' : 'live');
        if (env.success && env.data !== undefined) {
          setData(env.data);
          setMeta(env.meta ?? null);
          setError(null);
        } else {
          setError(env.error?.message ?? `BackQuant request failed (${res.status})`);
        }
      } catch (e) {
        if (!cancelled && mounted.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled && mounted.current) {
          setLoading(false);
          setFetchedAt(Date.now());
        }
      }
    };

    setLoading(true);
    void run();

    if (opts?.pollMs && opts.pollMs > 0) {
      const iv = setInterval(run, opts.pollMs);
      return () => {
        cancelled = true;
        clearInterval(iv);
      };
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick, opts?.pollMs]);

  return { data, meta, mode, loading, error, refresh, fetchedAt };
}

/** One-shot mode probe (live vs demo) for the header badge. */
export function useBqMode(): 'live' | 'demo' | 'unknown' {
  const { mode } = useBq<unknown>('/health', undefined, { pollMs: 60_000 });
  return mode;
}

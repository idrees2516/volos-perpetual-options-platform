'use client';

// -----------------------------------------------------------------------------
// quantlab/use-quant — the Quant Lab data hook: fetches any /api/quant
// endpoint with loading/error states, manual refresh and live polling.
// -----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuantEnvelope } from '@/lib/quant/types';

export interface QuantState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  fetchedAt: number | null;
  computeMs: number | null;
  note: string | null;
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
  return `/api/quant${p}${qs.size ? `?${qs.toString()}` : ''}`;
}

export function useQuant<T = unknown>(
  path: string | null,
  params?: Record<string, string | number | boolean | undefined>,
  opts?: { pollMs?: number; enabled?: boolean },
): QuantState<T> {
  const enabled = opts?.enabled !== false;
  const key = path ? buildUrl(path, params) : null;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(path && enabled));
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [computeMs, setComputeMs] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
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
        const env = (await res.json()) as QuantEnvelope<T>;
        if (cancelled || !mounted.current) return;
        if (env.success && env.data !== undefined) {
          setData(env.data);
          setComputeMs(env.meta?.computeMs ?? null);
          setNote(env.meta?.note ?? null);
          setError(null);
        } else {
          setError(env.error?.message ?? `request failed (${res.status})`);
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

  return { data, loading, error, refresh, fetchedAt, computeMs, note };
}

/** Age ticker so "live · 3s ago" labels update without refetching. */
export function useAgeLabel(ts: number | null): string {
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

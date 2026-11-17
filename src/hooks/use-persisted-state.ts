'use client';

// -----------------------------------------------------------------------------
// use-persisted-state — JSON state persisted to localStorage, implemented as
// an EXTERNAL store via useSyncExternalStore (no setState-in-effect: avoids
// cascading renders, SSR-safe, cross-tab sync via the `storage` event).
//
// Hydration contract: the server snapshot is `null` → `initial` on first
// paint; React reconciles with the client snapshot right after hydration.
// Same-tab updates notify local listeners; other tabs come through the
// `storage` event.
// -----------------------------------------------------------------------------

import { useCallback, useMemo, useSyncExternalStore } from 'react';

interface Store {
  value: string | null;
  listeners: Set<() => void>;
}

const g = globalThis as unknown as { __volosPersistedStores?: Map<string, Store> };
const stores = g.__volosPersistedStores ?? new Map<string, Store>();
g.__volosPersistedStores = stores;

function getStore(key: string): Store {
  let s = stores.get(key);
  if (!s) {
    let value: string | null = null;
    try {
      value = window.localStorage.getItem(key);
    } catch {
      /* private mode */
    }
    s = { value, listeners: new Set() };
    stores.set(key, s);
  }
  return s;
}

function emit(s: Store) {
  for (const cb of s.listeners) cb();
}

/** localStorage-backed JSON state — `useState` semantics, persisted. */
export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      const s = getStore(key);
      s.listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === key) emit(getStore(key));
      };
      window.addEventListener('storage', onStorage);
      return () => {
        s.listeners.delete(cb);
        window.removeEventListener('storage', onStorage);
      };
    },
    [key],
  );

  const getSnapshot = useCallback(() => getStore(key).value, [key]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const value = useMemo(() => {
    if (raw == null) return initial;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
     
  }, [raw]);

  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      const s = getStore(key);
      const prev = (() => {
        if (s.value == null) return initial;
        try {
          return JSON.parse(s.value) as T;
        } catch {
          return initial;
        }
      })();
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      s.value = JSON.stringify(next);
      try {
        window.localStorage.setItem(key, s.value);
      } catch {
        /* private mode — memory store only */
      }
      emit(s);
    },
    [key, initial],
  );

  return [value, set];
}

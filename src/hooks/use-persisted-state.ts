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

const g = globalThis as unknown as { __volosPersistedStores?: Map<string, Store>; __volosRawStores?: Map<string, Store> };
const stores = g.__volosPersistedStores ?? new Map<string, Store>();
g.__volosPersistedStores = stores;
// raw (non-JSON) string stores — for keys written by older code as plain text
const rawStores = g.__volosRawStores ?? new Map<string, Store>();
g.__volosRawStores = rawStores;

/** one creation path for raw stores — the entry ALWAYS hydrates from
 *  localStorage on first touch (subscribe runs before the first client
 *  getSnapshot after hydration, so it must read localStorage too). */
function getRawStore(key: string): Store {
  let s = rawStores.get(key);
  if (!s) {
    let value: string | null = null;
    try {
      value = window.localStorage.getItem(key);
    } catch {
      /* private mode */
    }
    s = { value, listeners: new Set() };
    rawStores.set(key, s);
  }
  return s;
}

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

/** Set a raw string store from OUTSIDE React (a plain helper, not a hook) —
 *  notifies every `usePersistedString` subscriber of the same key. */
export function setPersistedString(key: string, value: string): void {
  const s = getRawStore(key);
  s.value = value;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode — memory store only */
  }
  for (const c of s.listeners) c();
}

/** localStorage-backed raw string (no JSON round-trip) — `useState` semantics,
 *  persisted; safe for keys previously written as plain text (e.g. `volos-view`). */
export function usePersistedString(key: string, initial: string): [string, (v: string | ((prev: string) => string)) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      const s = getRawStore(key);
      s.listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === key) {
          const st = getRawStore(key);
          try {
            st.value = window.localStorage.getItem(key);
          } catch {
            /* private mode */
          }
          for (const c of st.listeners) c();
        }
      };
      window.addEventListener('storage', onStorage);
      return () => {
        s.listeners.delete(cb);
        window.removeEventListener('storage', onStorage);
      };
    },
    [key],
  );

  const getSnapshot = useCallback(() => getRawStore(key).value, [key]);

  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const value = raw ?? initial;

  const set = useCallback(
    (v: string | ((prev: string) => string)) => {
      const s = getRawStore(key);
      const prev = s.value ?? initial;
      const next = typeof v === 'function' ? (v as (p: string) => string)(prev) : v;
      s.value = next;
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* private mode — memory store only */
      }
      for (const c of s.listeners) c();
    },
    [key, initial],
  );

  return [value, set];
}

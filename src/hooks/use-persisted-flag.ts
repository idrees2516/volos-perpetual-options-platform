'use client';

// -----------------------------------------------------------------------------
// use-persisted-flag — localStorage-backed boolean flag as an EXTERNAL store
// (useSyncExternalStore): no setState-in-effect, SSR-safe (server snapshot
// `null` → `initial`, reconciled right after hydration), cross-tab sync via
// the `storage` event. Same contract as use-persisted-state, for plain flags.
// -----------------------------------------------------------------------------

import { useCallback, useSyncExternalStore } from 'react';

interface FlagStore {
  value: string | null;
  listeners: Set<() => void>;
}

const g = globalThis as unknown as { __volosFlagStores?: Map<string, FlagStore> };
const stores = g.__volosFlagStores ?? new Map<string, FlagStore>();
g.__volosFlagStores = stores;

function getStore(key: string): FlagStore {
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

function emit(s: FlagStore) {
  for (const cb of s.listeners) cb();
}

/** localStorage-backed boolean flag — restored after mount, no hydration mismatch. */
export function usePersistedFlag(key: string, initial: boolean): [boolean, () => void] {
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
  const value = raw == null ? initial : raw === '1';

  const toggle = useCallback(() => {
    const s = getStore(key);
    const prev = s.value == null ? initial : s.value === '1';
    const next = !prev;
    s.value = next ? '1' : '0';
    try {
      window.localStorage.setItem(key, s.value);
    } catch {
      /* private mode — memory store only */
    }
    emit(s);
  }, [key, initial]);

  return [value, toggle];
}

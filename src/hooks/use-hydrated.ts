'use client';

import { useSyncExternalStore } from 'react';

// Hydration-safe "mounted" flag without setState-in-effect (lint-clean).
// Server snapshot = false, client snapshot = true.
const emptySubscribe = () => () => {};
export function useHydrated(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}

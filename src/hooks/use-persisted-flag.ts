'use client';

// localStorage-backed boolean flag — restored after mount to avoid SSR
// hydration mismatches. Used for rail collapse states and similar UI flags.

import { useEffect, useState } from 'react';

export function usePersistedFlag(key: string, initial: boolean): [boolean, () => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) setValue(saved === '1');
    } catch {
      /* private mode */
    }
  }, [key]);
  const toggle = () => {
    setValue((v) => {
      const next = !v;
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  return [value, toggle];
}

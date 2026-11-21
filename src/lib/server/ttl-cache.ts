// ─────────────────────────────────────────────────────────────────────────────
// TTL cache — the shared server-side keyed cache for route payloads that are
// safe to serve a few seconds stale (the UI polls them). Single-flight: a
// burst of callers while a compute is running all await the SAME promise, so
// expensive recomputes never stampede. A rejected compute clears the slot so
// the next caller retries fresh instead of inheriting a cached error.
//
//   const cache = ttlCache('forecast', 10_000);
//   const payload = await cache.get(key, async () => { /* heavy compute */ });
// ─────────────────────────────────────────────────────────────────────────────

interface Entry<T> {
  at: number;
  run: Promise<T>;
}

export function ttlCache<T>(ns: string, ttlMs: number) {
  const g = globalThis as unknown as Record<string, unknown>;
  const slot = `__volosTTL:${ns}`;
  const store = (g[slot] as Map<string, Entry<T>> | undefined) ?? new Map<string, Entry<T>>();
  g[slot] = store;

  return {
    /** Cached-or-compute. `k` should be a canonical key of ALL inputs. */
    get(k: string, compute: () => Promise<T>): Promise<T> {
      const hit = store.get(k);
      if (hit && Date.now() - hit.at < ttlMs) return hit.run;
      const run = compute();
      store.set(k, { at: Date.now(), run });
      run.catch(() => {
        if (store.get(k)?.run === run) store.delete(k);
      });
      return run;
    },
    /** Manual bust (e.g. a write invalidates the read). */
    drop(k: string): void {
      store.delete(k);
    },
  };
}

// Smoothed spot ticker — presentation-layer interpolation of REAL quotes.
//
// WHY THIS EXISTS: the market provider used to hold the lerped spot in React
// STATE on a 33ms interval, which re-rendered the ENTIRE terminal tree
// (workbench + strategies view + copilot bridges) 30 times per second — the
// app felt slow, and under pressure React threw "Maximum update depth
// exceeded" straight from `setSmooth` inside that interval (reproduced and
// confirmed via the dev-overlay component stack).
//
// THE FIX: interpolation now lives in a module-level external store driven
// by useSyncExternalStore — only the TINY ticker surfaces (topbar asset
// pills, the rail's live-market pulse) subscribe and re-render; the heavy
// workspace views read the 5s REAL frames from the market context instead.
// The snapshot object identity only changes when a value actually moves
// (and notifications self-terminate once the lerp converges), so the loop
// risk is structurally impossible. The lerp is a presentation effect on
// REAL ticks — never a data source.

import { useSyncExternalStore } from 'react';
import type { AssetMarket } from './types';

const EMPTY: Record<string, AssetMarket> = {};

let target: Record<string, AssetMarket> = EMPTY;
let current: Record<string, AssetMarket> = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  if (target === current) return;
  let changed = false;
  const next: Record<string, AssetMarket> = {};
  for (const k of Object.keys(target)) {
    const t = target[k];
    const c = current[k] ?? t;
    const s: AssetMarket = {
      ...t,
      spot: c.spot + (t.spot - c.spot) * 0.18,
      volShift: c.volShift + (t.volShift - c.volShift) * 0.18,
      fundingRate: c.fundingRate + (t.fundingRate - c.fundingRate) * 0.18,
    };
    if (Math.abs(s.spot - c.spot) > 1e-9) changed = true;
    next[k] = s;
  }
  current = next;
  if (changed) for (const cb of listeners) cb();
}

/** Set the REAL frame the interpolation glides toward (the market provider
 * calls this on every live-price snapshot). Fires an immediate tick so the
 * first paint after a real quote is instant. */
export function setSmoothTarget(assets: Record<string, AssetMarket>): void {
  if (typeof window === 'undefined') return;
  target = assets;
  if (timer) tick();
}

/** Latest REAL frame, for synchronous reads (no subscription). */
export function smoothTargetNow(): Record<string, AssetMarket> {
  return target;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) {
    tick();
    timer = setInterval(tick, 33);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): Record<string, AssetMarket> {
  return current;
}

/** Subscribe the ticker surfaces to the smoothed spot values. */
export function useSmoothAssets(): Record<string, AssetMarket> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — client store + hook
//
// One OrderFlowStore per (asset, tf, filters) fed by the SSE stream. The store
// is a plain mutable object; React re-renders on a version tick (≤ 2 Hz) and
// the canvas chart reads it directly inside its own rAF loop, so live data
// never thrashes reconciliation.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  OfAlertEvent,
  OfAlertSettings,
  OfAsset,
  OfLiquidation,
  OfMicroEvent,
  OfSessionStats,
  OfVenueConnection,
  OfVenueId,
  OfVenueStat,
  OfWireTrade,
} from '@/lib/orderflow/types';
import type { WireCandle, WireHeatmapColumn } from '@/lib/orderflow/wire';

const PRINT_CAP = 900;
const LIQ_CAP = 300;
const MICRO_CAP = 150;
const ALERT_CAP = 120;
const HEATMAP_CAP = 7200;

export interface OfClientState {
  asset: OfAsset;
  connected: boolean;
  lastEventAt: number;
  tick: number;
  session: OfSessionStats | null;
  analytics: {
    cvd1m: number;
    volumeZ: number | null;
    realizedVolAnnPct: number | null;
    depth: {
      bid10: number;
      ask10: number;
      bid25: number;
      ask25: number;
      obi10: number;
      obi25: number;
      mid: number;
      spreadBps: number;
    } | null;
    obi: { time: number; value: number }[];
    cvd: { time: number; value: number }[];
  } | null;
  levels: {
    previous: { poc: number; vah: number; val: number; vwap: number; high: number; low: number } | null;
    naked: { day: number; poc: number }[];
    today: { high: number; low: number; poc: number | null; vwap: number | null };
  } | null;
  book: {
    merged: { bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; mid: number; spreadBps: number } | null;
    perVenue: Record<string, { bid: number; ask: number; bidSize: number; askSize: number } | null>;
  };
  deriv: {
    aggregate: {
      openInterest: number | null;
      openInterestValue: number | null;
      fundingRate8h: number | null;
      nextFundingTime: number | null;
      basisBps: number | null;
      markPrice: number | null;
      indexPrice: number | null;
    } | null;
    perVenue: Array<{
      venue: string;
      openInterest?: number;
      fundingRate?: number;
      fundingRate8h?: number;
      fundingAnnualizedPct?: number;
      nextFundingTime?: number;
      markPrice?: number;
      indexPrice?: number;
      basisBps?: number;
    }>;
    oiSeries: { time: number; openInterest: number; price: number }[];
    windows: Record<string, { regime: string; priceChange: number; oiChange: number; oiDelta: number } | null>;
  };
  venues: { stats: OfVenueStat[]; leader: OfVenueStat | null };
  connections: OfVenueConnection[];
  candles: WireCandle[];
  prints: OfWireTrade[];
  liqs: OfLiquidation[];
  micro: OfMicroEvent[];
  alerts: OfAlertEvent[];
  liqBuckets: { time: number; longNotional: number; shortNotional: number; count: number }[];
  heatmapColumns: Map<number, WireHeatmapColumn>;
}

export type OfClientListener = () => void;

export class OrderFlowStore {
  readonly state: OfClientState;
  /** identity of (asset, tf, filters) — lets the hook recreate cleanly */
  readonly key: string;
  private listeners = new Set<OfClientListener>();
  private notifyScheduled = false;
  /** increments on every notify — lets memos recompute on mutable state. */
  notifyCount = 0;
  private es: EventSource | null = null;
  readonly tf: number;
  readonly minNotional: number;
  readonly alertSettings: OfAlertSettings;

  constructor(asset: OfAsset, tf: number, opts: { minNotional?: number; alertSettings?: OfAlertSettings; minutes?: number } = {}) {
    this.tf = tf;
    this.minNotional = opts.minNotional ?? 0;
    this.alertSettings = opts.alertSettings ?? DEFAULTS;
    this.key = `${asset}|${tf}|${this.minNotional}|${JSON.stringify(this.alertSettings)}`;
    this.state = {
      asset,
      connected: false,
      lastEventAt: 0,
      tick: 0,
      session: null,
      analytics: null,
      levels: null,
      book: { merged: null, perVenue: {} },
      deriv: { aggregate: null, perVenue: [], oiSeries: [], windows: {} },
      venues: { stats: [], leader: null },
      connections: [],
      candles: [],
      prints: [],
      liqs: [],
      micro: [],
      alerts: [],
      liqBuckets: [],
      heatmapColumns: new Map(),
    };
    this.connect(opts.minutes ?? 15);
  }

  private connect(minutes: number): void {
    if (typeof EventSource === 'undefined') return; // SSR guard
    const asset = this.state.asset;
    const params = new URLSearchParams({
      asset,
      tf: String(this.tf),
      minutes: String(minutes),
      minNotional: String(this.minNotional),
    });
    const a = this.alertSettings;
    params.set('aw_vwap', a.vwapCross ? '1' : '0');
    params.set('aw_va', a.valueAreaEdge ? '1' : '0');
    params.set('aw_volz', String(a.volumeSpike));
    params.set('aw_block', String(a.blockPrint));
    params.set('aw_cvd', a.cvdDivergence ? '1' : '0');
    params.set('aw_liq', String(a.largeLiquidation));
    params.set('aw_abs', a.absorption ? '1' : '0');
    params.set('aw_ice', a.iceberg ? '1' : '0');
    const es = new EventSource(`/api/orderflow/stream?${params.toString()}`);
    this.es = es;
    const on = <T,>(name: string, fn: (data: T) => void) =>
      es.addEventListener(name, (ev) => {
        try {
          fn(JSON.parse((ev as MessageEvent).data as string) as T);
        } catch {
          /* malformed frame */
        }
      });

    on('init', (d: Record<string, unknown>) => {
      const s = this.state;
      s.tick = (d.tick as number) ?? 0;
      s.session = d.session as OfSessionStats;
      s.analytics = d.analytics as OfClientState['analytics'];
      s.book = d.book as OfClientState['book'];
      s.deriv = d.deriv as OfClientState['deriv'];
      s.venues = d.venues as OfClientState['venues'];
      s.connections = d.connections as OfVenueConnection[];
      s.micro = (d.micro as OfMicroEvent[]) ?? [];
      s.candles = (d.candles as WireCandle[]) ?? [];
      s.connected = true;
      s.lastEventAt = Date.now();
      this.notify();
    });
    on('levels', (d) => {
      this.state.levels = d as OfClientState['levels'];
      this.notify();
    });
    on('heatmap-init', (d: { columns: WireHeatmapColumn[]; tick: number }) => {
      const map = new Map<number, WireHeatmapColumn>();
      for (const c of d.columns ?? []) map.set(c.t, c);
      this.state.heatmapColumns = map;
      this.state.tick = d.tick ?? this.state.tick;
      this.notify();
    });
    on('heatmap', (d: WireHeatmapColumn & { tick?: number }) => {
      const map = this.state.heatmapColumns;
      map.set(d.t, d);
      if (map.size > HEATMAP_CAP) {
        // drop the oldest ~100 columns
        const it = map.keys();
        for (let k = 0; k < 120; k++) {
          const n = it.next();
          if (n.done) break;
          map.delete(n.value);
        }
      }
      if (d.tick) this.state.tick = d.tick;
      this.notify();
    });
    on('trade', (d: { batch: OfWireTrade[] }) => {
      const prints = this.state.prints;
      for (const t of d.batch ?? []) {
        prints.push(t);
      }
      if (prints.length > PRINT_CAP) prints.splice(0, prints.length - PRINT_CAP);
      this.notify();
    });
    on('liq', (d: { batch: OfLiquidation[] }) => {
      const liqs = this.state.liqs;
      for (const l of d.batch ?? []) liqs.push(l);
      if (liqs.length > LIQ_CAP) liqs.splice(0, liqs.length - LIQ_CAP);
      this.notify();
    });
    on('micro', (d: { events: OfMicroEvent[] }) => {
      const micro = this.state.micro;
      micro.push(...(d.events ?? []));
      if (micro.length > MICRO_CAP) micro.splice(0, micro.length - MICRO_CAP);
      this.notify();
    });
    on('book', (d: OfClientState['book']) => {
      this.state.book = d;
      this.notify();
    });
    on('stats', (d: {
      session: OfSessionStats;
      tick?: number;
      analytics: OfClientState['analytics'];
      liq?: { buckets: OfClientState['liqBuckets'] };
    }) => {
      this.state.session = d.session;
      this.state.tick = d.tick ?? this.state.tick;
      this.state.analytics = d.analytics;
      this.state.liqBuckets = d.liq?.buckets ?? this.state.liqBuckets;
      this.notify();
    });
    on('deriv', (d: OfClientState['deriv']) => {
      this.state.deriv = d;
      this.notify();
    });
    on('venues', (d: OfClientState['venues']) => {
      this.state.venues = d;
      this.notify();
    });
    on('status', (d: { venues: OfVenueConnection[] }) => {
      this.state.connections = d.venues ?? [];
      this.notify();
    });
    on('alert', (d: { events: OfAlertEvent[] }) => {
      const alerts = this.state.alerts;
      alerts.push(...(d.events ?? []));
      if (alerts.length > ALERT_CAP) alerts.splice(0, alerts.length - ALERT_CAP);
      this.notify();
    });
    es.onopen = () => {
      this.state.connected = true;
      this.notify();
    };
    es.onerror = () => {
      this.state.connected = false;
      this.notify();
    };
  }

  dispose(): void {
    this.es?.close();
    this.es = null;
    this.listeners.clear();
  }

  subscribe(listener: OfClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    setTimeout(() => {
      this.notifyScheduled = false;
      this.notifyCount++;
      for (const l of this.listeners) l();
    }, 300);
  }

  /** Liquidation buckets from the latest stats frame. */
  liqBuckets(): OfClientState['liqBuckets'] {
    return this.state.liqBuckets;
  }
}

const DEFAULTS: OfAlertSettings = {
  vwapCross: true,
  valueAreaEdge: true,
  volumeSpike: 3,
  blockPrint: 10,
  cvdDivergence: true,
  largeLiquidation: 250_000,
  absorption: true,
  iceberg: true,
};

/** Re-render on store notifications (≤ 2 Hz in practice). */
export function useOrderFlowStore(store: OrderFlowStore | null): void {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!store) return;
    const bump = () => setVersion((v) => v + 1);
    const off = store.subscribe(bump);
    bump();
    return () => {
      off();
    };
  }, [store]);
}

export function useOrderFlow(
  asset: OfAsset,
  opts: { tf: number; minNotional?: number; alertSettings?: OfAlertSettings; minutes?: number },
): { store: OrderFlowStore | null; state: OfClientState } {
  const [store, setStore] = useState<OrderFlowStore | null>(null);
  const alertKey = JSON.stringify(opts.alertSettings ?? null);
  useEffect(() => {
    const s = new OrderFlowStore(asset, opts.tf, {
      minNotional: opts.minNotional,
      alertSettings: opts.alertSettings,
      minutes: opts.minutes,
    });
    setStore(s);
    return () => s.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, opts.tf, opts.minNotional, alertKey, opts.minutes]);
  useOrderFlowStore(store);
  const state = useMemo<OfClientState>(
    () =>
      store?.state ?? {
        asset,
        connected: false,
        lastEventAt: 0,
        tick: 0,
        session: null,
        analytics: null,
        levels: null,
        book: { merged: null, perVenue: {} },
        deriv: { aggregate: null, perVenue: [], oiSeries: [], windows: {} },
        venues: { stats: [], leader: null },
        connections: [],
        candles: [],
        prints: [],
        liqs: [],
        micro: [],
        alerts: [],
        liqBuckets: [],
        heatmapColumns: new Map(),
      },
    [store, asset],
  );
  return { store, state };
}

// ── formatting helpers (shared by every panel) ──────────────────────────────

export function fmtUsd(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(digits)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtPrice(v: number | null | undefined, tick = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(Math.max(tick, 1e-6)))));
  return v.toFixed(Math.min(decimals, 2 + Math.ceil(-Math.log10(Math.max(tick, 1e-6)))));
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtQty(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

export function venueColor(venue: OfVenueId | string): string {
  switch (venue) {
    case 'binance':
      return '#f0b90b';
    case 'bybit':
      return '#f7a600';
    case 'okx':
      return '#7cc2ff';
    case 'deribit':
      return '#7bf1a8';
    case 'bitget':
      return '#00f2d2';
    case 'hyperliquid':
      return '#97fce4';
    case 'coinbase':
      return '#3b6eff';
    default:
      return '#a1a1aa';
  }
}

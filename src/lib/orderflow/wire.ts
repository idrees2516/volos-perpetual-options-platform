// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW — wire helpers (shared by REST routes and the SSE stream)
// ─────────────────────────────────────────────────────────────────────────────

import type { OrderFlowEngine, OfTimeframe } from './engine';
import type { OfAsset, OfAlertSettings, OfCandle } from './types';
import { OF_ASSETS } from './catalog';
import { DEFAULT_ALERT_SETTINGS } from './alerts';

export function parseAsset(raw: string | null | undefined): OfAsset {
  const a = (raw ?? 'BTC').toUpperCase();
  return (OF_ASSETS as string[]).includes(a) ? (a as OfAsset) : 'BTC';
}

export function parseTimeframe(raw: string | null | undefined, fallback: OfTimeframe = 60_000): OfTimeframe {
  const tf = Number(raw);
  return [60_000, 300_000, 900_000, 1_800_000].includes(tf) ? (tf as OfTimeframe) : fallback;
}

export interface WireCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  cumulativeDelta: number;
  complete: boolean;
  venueVolumes: Partial<Record<string, number>>;
  levels: { price: number; bidVolume: number; askVolume: number; delta: number; tradeCount: number }[];
}

/** JSON-safe candles: footprint levels become a sorted price-ascending array. */
export function wireCandles(engine: OrderFlowEngine, tf: OfTimeframe, n = 80): WireCandle[] {
  return engine.candlesFor(tf).slice(-n).map((c: OfCandle) => ({
    openTime: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    delta: c.delta,
    cumulativeDelta: c.cumulativeDelta,
    complete: c.complete,
    venueVolumes: c.venueVolumes,
    levels: [...c.levels.values()].sort((a, b) => a.price - b.price).map((l) => ({
      price: l.price,
      bidVolume: l.bidVolume,
      askVolume: l.askVolume,
      delta: l.delta,
      tradeCount: l.tradeCount,
    })),
  }));
}

export interface WireHeatmapColumn {
  t: number;
  i: number[];
  s: number[];
}

/**
 * Serialize the depth ring into sparse columns. `rowTick` re-buckets the rows
 * (for zoomed-out views), `stride` skips seconds (for very wide windows).
 */
export function heatmapColumns(
  engine: OrderFlowEngine,
  opts: { minutes?: number; rowTick?: number; stride?: number } = {},
): { tick: number; rowTick: number; columns: WireHeatmapColumn[] } {
  const history = engine.depth;
  const minutes = Math.max(1, Math.min(120, opts.minutes ?? 15));
  const stride = Math.max(1, Math.min(30, opts.stride ?? 1));
  const tick = history.tick > 0 ? history.tick : engine.tick;
  const rowTick = opts.rowTick && opts.rowTick > 0 ? opts.rowTick : tick;
  const from = Date.now() - minutes * 60_000;
  const first = Math.max(history.firstSeq, history.seqAtOrAfter(from));
  const columns: WireHeatmapColumn[] = [];
  let seqSkip = 0;
  for (let seq = first; seq <= history.lastSeq; seq++) {
    if (seqSkip > 0) {
      seqSkip--;
      continue;
    }
    seqSkip = stride - 1;
    const snap = history.get(seq);
    if (!snap || !snap.index.length) continue;
    if (rowTick === tick) {
      columns.push({ t: snap.time, i: Array.from(snap.index), s: Array.from(snap.size) });
    } else {
      const scale = rowTick / tick;
      const map = new Map<number, number>();
      for (let k = 0; k < snap.index.length; k++) {
        const row = Math.round(snap.index[k] * scale);
        map.set(row, (map.get(row) ?? 0) + snap.size[k]);
      }
      const rows = [...map.entries()].sort((a, b) => a[0] - b[0]);
      columns.push({ t: snap.time, i: rows.map((r) => r[0]), s: rows.map((r) => r[1]) });
    }
  }
  return { tick, rowTick, columns };
}

/** Compact alert-rule settings from the SSE URL (per browser, like the reference). */
export function parseAlertSettings(url: URL): OfAlertSettings {
  const p = url.searchParams;
  const flag = (name: string, fallback: boolean) => {
    const v = p.get(name);
    if (v === null) return fallback;
    return v === '1' || v === 'true';
  };
  const number = (name: string, fallback: number) => {
    const v = Number(p.get(name));
    return Number.isFinite(v) && p.get(name) !== null ? v : fallback;
  };
  return {
    vwapCross: flag('aw_vwap', DEFAULT_ALERT_SETTINGS.vwapCross),
    valueAreaEdge: flag('aw_va', DEFAULT_ALERT_SETTINGS.valueAreaEdge),
    volumeSpike: number('aw_volz', DEFAULT_ALERT_SETTINGS.volumeSpike),
    blockPrint: number('aw_block', DEFAULT_ALERT_SETTINGS.blockPrint),
    cvdDivergence: flag('aw_cvd', DEFAULT_ALERT_SETTINGS.cvdDivergence),
    largeLiquidation: number('aw_liq', DEFAULT_ALERT_SETTINGS.largeLiquidation),
    absorption: flag('aw_abs', DEFAULT_ALERT_SETTINGS.absorption),
    iceberg: flag('aw_ice', DEFAULT_ALERT_SETTINGS.iceberg),
  };
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data as Record<string, unknown>, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

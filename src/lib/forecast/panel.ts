// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — flow-bar panel builder (the forecasting data plane)
//
// Bridges the native order-flow engine into the forecasting layer's panel
// format (unique_id / ds / y, foundationforecast semantics):
//
//   • BACKFILL  Binance USDT-perp klines — the only public source with
//               taker-buy base volume, which carries the same aggressor
//               semantics as our engine's delta (buy − sell). Parsed rows
//               give: open/high/low/close/volume/trades/takerBuy.
//   • LIVE TAIL the engine's multi-venue footprint candles for the same
//               timeframe (consolidated across Binance/Bybit/OKX/Deribit),
//               overriding the kline tail bucket-for-bucket where present.
//   • ENGINE-ONLY targets (open interest, per-venue panels) come straight
//               from the engine session — OI history, per-candle venue
//               volumes and the raw tape (per-venue delta), no backfill.
//
// Every aggregate target therefore has two provable layers: long exchange
// history + the engine's live multi-venue truth. `liveTailFrom` marks where
// the engine tail begins so the UI/Copilot can show provenance.
//
// FlowX features (delta, volume, buy share, CVD slope) are built aligned
// index-for-index with y — FlowX consumes them lagged, so calibration never
// sees look-ahead.
// ─────────────────────────────────────────────────────────────────────────────

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import type { OfAsset, OfCandle, OfVenueId } from '@/lib/orderflow/types';
import { OF_VENUES } from '@/lib/orderflow/catalog';
import { detectSeasonLength } from './stats';
import type { FcSeries, FcTargetId } from './types';

const BINANCE_F = 'https://fapi.binance.com';
const TF_TO_BINANCE: Record<number, string> = {
  60_000: '1m',
  300_000: '5m',
  900_000: '15m',
  1_800_000: '30m',
};

/** Normalized bar used to build every target series. */
interface RawBar {
  ds: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  trades: number;
}

export interface FcPanel {
  asset: OfAsset;
  tf: number;
  target: FcTargetId;
  /** panel of series (one for aggregate targets, one per venue otherwise) */
  series: FcSeries[];
  /** per series (same order): exogenous flow-feature columns aligned with points */
  features: Float64Array[][];
  /** hard domain bounds for interval clamping (buy share etc.) */
  bounds: { lo?: number; hi?: number } | null;
  /** auto-detected season length of the primary series */
  seasonLength: number;
  provenance: {
    klinesBars: number;
    engineBars: number;
    engineOnly: boolean;
    klineError: string | null;
  };
  builtAt: number;
}

// ── kline backfill ──────────────────────────────────────────────────────────

async function fetchKlinesOnce(symbol: string, interval: string, limit: number): Promise<RawBar[]> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(
      `${BINANCE_F}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: ctl.signal, cache: 'no-store', headers: { Accept: 'application/json' } },
    );
    if (!res.ok) throw new Error(`binance ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    const out: RawBar[] = [];
    for (const r of rows) {
      const openTime = Number(r[0]);
      const volume = Number(r[5]);
      const trades = Number(r[8]);
      const takerBuy = Number(r[9]);
      if (![openTime, volume, trades, takerBuy].every(Number.isFinite)) continue;
      out.push({
        ds: openTime,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume,
        buyVolume: takerBuy,
        trades,
      });
    }
    return out;
  } finally {
    clearTimeout(to);
  }
}

/** One retry on transient venue/network hiccups (matches the markets client). */
async function fetchKlines(symbol: string, interval: string, limit: number): Promise<RawBar[]> {
  try {
    return await fetchKlinesOnce(symbol, interval, limit);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return fetchKlinesOnce(symbol, interval, limit);
  }
}

/** Engine footprint candle → normalized bar (buy volume from delta). */
function candleToBar(c: OfCandle): RawBar {
  let trades = 0;
  for (const lvl of c.levels.values()) trades += lvl.tradeCount;
  return {
    ds: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    buyVolume: c.volume > 0 ? Math.max(0, Math.min(c.volume, (c.volume + c.delta) / 2)) : 0,
    trades,
  };
}

// ── series construction ──────────────────────────────────────────────────────

/** Panel cache — one in-flight promise per key + TTL result cache. */
interface PanelCacheEntry {
  key: string;
  promise: Promise<FcPanel> | null;
  panel: FcPanel | null;
  at: number;
}
const panelCache = new Map<string, PanelCacheEntry>();
const PANEL_TTL_MS = 15_000;

function quantize(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}

/**
 * Build the forecasting panel for one (asset, tf, target).
 * `backfill` caps kline bars (≤1500); engine tail adds live multi-venue bars.
 */
export async function buildForecastPanel(
  asset: OfAsset,
  tf: number,
  target: FcTargetId,
  opts: { backfill?: number } = {},
): Promise<FcPanel> {
  const backfill = Math.max(60, Math.min(1500, opts.backfill ?? 720));
  const key = `${asset}|${tf}|${target}|${backfill}`;
  const now = Date.now();
  const hit = panelCache.get(key);
  if (hit && hit.panel && now - hit.at < PANEL_TTL_MS) return hit.panel;
  if (hit && hit.promise) return hit.promise;

  const promise = (async (): Promise<FcPanel> => {
    const interval = TF_TO_BINANCE[tf];
    const manager = getOrderFlowManager();
    manager.touch(asset);
    const state = manager.stateOf(asset);
    const engine = state?.engine;

    let klinesBars: RawBar[] = [];
    let klineError: string | null = null;
    if (interval && target !== 'oi' && target !== 'venueVolumeShare' && target !== 'venueDelta') {
      try {
        klinesBars = await fetchKlines(`${asset}USDT`, interval, backfill);
      } catch (e) {
        klineError = e instanceof Error ? e.message : 'kline fetch failed';
      }
    }

    let engineBars: RawBar[] = [];
    let venueVolumesByBar: Map<number, Partial<Record<OfVenueId, number>>> = new Map();
    let oiPoints: { time: number; openInterest: number }[] = [];
    let tape: { t: number; venue: string; qty: number; buy: boolean }[] = [];
    if (engine) {
      const candles = engine.candlesFor(tf).slice(-backfill);
      engineBars = candles.map(candleToBar);
      venueVolumesByBar = new Map(candles.map((c) => [c.openTime, c.venueVolumes]));
      oiPoints = engine.oiSeries();
      if (state) {
        // per-venue aggressor delta from the raw tape (session scope)
        tape = state.tape.map((t) => ({ t: t.timestamp, venue: t.venue, qty: t.quantity, buy: t.side === 'buy' }));
      }
    }

    // merge: kline history + engine tail (engine wins bucket-for-bucket)
    const byTime = new Map<number, RawBar>();
    for (const b of klinesBars) byTime.set(b.ds, b);
    let engineCount = 0;
    for (const b of engineBars) {
      if (byTime.has(b.ds)) engineCount++;
      byTime.set(b.ds, b);
    }
    const bars = [...byTime.values()].sort((a, b) => a.ds - b.ds);

    const series: FcSeries[] = [];
    const features: Float64Array[][] = [];
    let bounds: { lo?: number; hi?: number } | null = null;
    const engineOnly = target === 'oi' || target === 'venueVolumeShare' || target === 'venueDelta';

    if (target === 'venueVolumeShare' || target === 'venueDelta') {
      // per-venue panel: one series per venue, engine session scope
      for (const venue of OF_VENUES) {
        const label = `${asset} · ${venue} ${target === 'venueVolumeShare' ? 'volume share' : 'delta'} · ${tf / 60_000}m`;
        const pts: { ds: number; y: number }[] = [];
        if (target === 'venueVolumeShare') {
          for (const c of [...venueVolumesByBar.entries()].sort((a, b) => a[0] - b[0])) {
            const v = c[1][venue as OfVenueId] ?? 0;
            const total = Object.values(c[1]).reduce((a, b) => a + (b ?? 0), 0);
            if (total > 0) pts.push({ ds: c[0], y: v / total });
          }
          bounds = { lo: 0, hi: 1 };
        } else {
          const buckets = new Map<number, number>();
          for (const p of tape) {
            if (p.venue !== venue) continue;
            const b = Math.floor(p.t / tf) * tf;
            buckets.set(b, (buckets.get(b) ?? 0) + (p.buy ? p.qty : -p.qty));
          }
          for (const [ds, delta] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) pts.push({ ds, y: delta });
        }
        if (pts.length >= 24) {
          series.push({ uniqueId: `${asset}-${venue}-${target}`, label, points: pts, liveTailFrom: pts[0]?.ds });
          features.push([]);
        }
      }
    } else if (target === 'oi') {
      // open interest: engine history sampled per bucket close
      const buckets = new Map<number, { last: number }>();
      for (const p of oiPoints) {
        const b = Math.floor(p.time / tf) * tf;
        buckets.set(b, { last: p.openInterest });
      }
      const pts = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([ds, v]) => ({ ds, y: v.last }));
      if (pts.length >= 24) {
        series.push({ uniqueId: `${asset}-oi`, label: `${asset} · open interest · ${tf / 60_000}m`, points: pts, liveTailFrom: pts[0]?.ds });
        features.push([]);
      }
    } else {
      // aggregate targets from the merged bar history
      let cvd = 0;
      const pts: { ds: number; y: number }[] = [];
      for (const b of bars) {
        const delta = 2 * b.buyVolume - b.volume;
        cvd += delta;
        let y: number;
        switch (target) {
          case 'close':
            y = b.close;
            break;
          case 'volume':
            y = b.volume;
            break;
          case 'delta':
            y = delta;
            break;
          case 'cvd':
            y = cvd;
            break;
          case 'imbalance':
            y = b.volume > 0 ? b.buyVolume / b.volume : NaN;
            break;
          case 'trades':
          default:
            y = b.trades;
            break;
        }
        pts.push({ ds: b.ds, y });
      }
      if (target === 'imbalance') bounds = { lo: 0, hi: 1 };
      const liveTailFrom = engineBars.length ? engineBars[0].ds : undefined;
      series.push({ uniqueId: `${asset}-${target}`, label: `${asset} · ${target} · ${tf / 60_000}m`, points: pts, liveTailFrom });
      // FlowX features aligned index-for-index with points
      const n = pts.length;
      if (n > 8) {
        const fDelta = new Float64Array(n);
        const fVolume = new Float64Array(n);
        const fShare = new Float64Array(n);
        const fCvdSlope = new Float64Array(n);
        let cv = 0;
        const cvdHist = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const b = bars[i];
          const delta = 2 * b.buyVolume - b.volume;
          cv += delta;
          cvdHist[i] = cv;
          fDelta[i] = delta;
          fVolume[i] = b.volume > 0 ? Math.log1p(b.volume) : 0;
          fShare[i] = b.volume > 0 ? b.buyVolume / b.volume : 0.5;
        }
        const k = Math.max(1, Math.min(5, Math.floor(n / 24)));
        for (let i = 0; i < n; i++) fCvdSlope[i] = i >= k ? cvdHist[i] - cvdHist[i - k] : 0;
        features.push([fDelta, fVolume, fShare, fCvdSlope]);
      } else {
        features.push([]);
      }
    }

    const primary = series[0]?.points.map((p) => p.y) ?? [];
    const seasonLength = primary.length > 32 ? detectSeasonLength(primary) : 1;

    return {
      asset,
      tf,
      target,
      series,
      features,
      bounds,
      seasonLength,
      provenance: {
        klinesBars: klinesBars.length,
        engineBars: engineCount,
        engineOnly,
        klineError,
      },
      builtAt: now,
    };
  })();

  const entry: PanelCacheEntry = { key, promise, panel: null, at: now };
  panelCache.set(key, entry);
  try {
    const panel = await promise;
    entry.panel = panel;
    entry.at = Date.now();
    return panel;
  } finally {
    entry.promise = null;
  }
}

/** Convenience: the primary series values as a plain array. */
export function panelY(series: FcSeries): number[] {
  return series.points.map((p) => quantize(p.y)).filter(Number.isFinite);
}

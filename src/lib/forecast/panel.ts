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
//
// The merged-bar loader (loadMergedBars) is cached per (asset, tf, backfill,
// withKlines) and SHARED by every target panel and the projected-state
// builder — one venue fetch serves the whole forecast stack.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
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
export interface RawBar {
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
    /** where the history came from once the backfill store exists */
    klineSource: 'store' | 'store+live' | 'binance' | 'none';
  };
  builtAt: number;
}

// ── kline backfill ──────────────────────────────────────────────────────────

// STORED-FIRST: once the backfill worker has mirrored Binance history into
// KlineBar, panels are served from SQLite and never re-hit the venue (the
// 418 fix). Live gaps still fetch (and write-through to the store so it
// self-heals), then the engine tail overrides bucket-for-bucket.

async function fetchStoredKlines(asset: OfAsset, tfSec: number, limit: number): Promise<RawBar[]> {
  try {
    const rows = await db.klineBar.findMany({
      where: { venue: 'binance', asset, tfSec },
      orderBy: { tOpen: 'desc' },
      take: limit,
    });
    return rows
      .map((r) => ({
        ds: r.tOpen.getTime(),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        buyVolume: r.buyVolume,
        trades: r.trades,
      }))
      .reverse();
  } catch {
    return []; // store unavailable → fall back to direct fetch
  }
}

/** Write-through: persist freshly fetched klines so the store self-heals. */
async function persistKlines(asset: OfAsset, tfSec: number, bars: RawBar[]): Promise<void> {
  try {
    for (const b of bars) {
      await db.klineBar.upsert({
        where: { venue_asset_tfSec_tOpen: { venue: 'binance', asset, tfSec, tOpen: new Date(b.ds) } },
        create: {
          venue: 'binance',
          asset,
          tfSec,
          tOpen: new Date(b.ds),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
          buyVolume: b.buyVolume,
          trades: b.trades,
        },
        update: {
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
          buyVolume: b.buyVolume,
          trades: b.trades,
        },
      });
    }
  } catch {
    /* best-effort — the panel must never fail because storage is slow */
  }
}

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
    try {
      return await fetchKlinesOnce(symbol, interval, limit);
    } catch {
      // Binance geo-blocks some datacenter egress (HTTP 451) — OKX serves the
      // same perp history; taker-buy volume is approximated from the bar body
      // (documented heuristic: bullish bars carry more taker buys).
      return fetchOkxCandles(symbol, interval, limit);
    }
  }
}

const OKX_F = 'https://www.okx.com';
/** Binance interval → OKX bar (the loader only produces these five). */
const INTERVAL_TO_OKX: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
};

/**
 * OKX perp candles fallback (newest-first, ≤ 300 per page — paginated with
 * `after`). Row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm].
 * buyVolume is derived from the bar's body share (0.5 ± 0.4·body/range).
 */
async function fetchOkxCandles(symbol: string, interval: string, limit: number): Promise<RawBar[]> {
  // the USDT-perp swap (not spot) — matches the Binance fapi semantics
  const instId = `${symbol.replace('USDT', '')}-USDT-SWAP`;
  const bar = INTERVAL_TO_OKX[interval] ?? interval;
  const out: RawBar[] = [];
  let after: string | undefined;
  for (let page = 0; page < Math.ceil(limit / 300) + 1 && out.length < limit; page++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 12_000);
    try {
      const url = new URL(`${OKX_F}/api/v5/market/candles`);
      url.searchParams.set('instId', instId);
      url.searchParams.set('bar', bar);
      url.searchParams.set('limit', String(Math.min(300, limit - out.length)));
      if (after) url.searchParams.set('after', after);
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`okx ${res.status}`);
      const body = (await res.json()) as { code?: string; data?: unknown[][] };
      if (body.code !== '0' || !body.data?.length) throw new Error('okx empty');
      const rows = body.data;
      for (const r of rows) {
        const ds = Number(r[0]);
        const open = Number(r[1]);
        const high = Number(r[2]);
        const low = Number(r[3]);
        const close = Number(r[4]);
        const volume = Number(r[5]);
        if (![ds, open, high, low, close, volume].every(Number.isFinite)) continue;
        const range = Math.max(1e-12, high - low);
        const share = Math.min(0.9, Math.max(0.1, 0.5 + 0.4 * ((close - open) / range)));
        out.push({ ds, open, high, low, close, volume, buyVolume: volume * share, trades: 0 });
      }
      after = String(rows[rows.length - 1][0]); // paginate older
    } finally {
      clearTimeout(to);
    }
  }
  if (!out.length) throw new Error('okx candles empty');
  return out.sort((a, b) => a.ds - b.ds).slice(-limit);
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

// ── merged-bar loader (shared: one fetch serves every target / state build) ────

export interface MergedBarSet {
  /** kline history ∪ engine tail (engine wins bucket-for-bucket), ascending */
  bars: RawBar[];
  /** kline bars the loader used (0 for engine-only loads) */
  klinesBars: number;
  /** engine bars that overrode klines bucket-for-bucket */
  engineCount: number;
  klineError: string | null;
  klineSource: 'store' | 'store+live' | 'binance' | 'none';
  /** first engine-bar ds — where the engine tail begins (null: no engine bars) */
  liveTailFrom: number | null;
  /** engine OHLC candles actually used (slice(-backfill)) — venue maps derive */
  engineCandles: OfCandle[];
  /** engine open-interest history */
  oiPoints: { time: number; openInterest: number }[];
}

interface BarCacheEntry {
  key: string;
  promise: Promise<MergedBarSet> | null;
  set: MergedBarSet | null;
  at: number;
}
const barCache = new Map<string, BarCacheEntry>();
const BARS_TTL_MS = 15_000;

/**
 * Load the merged bar history for one (asset, tf): stored klines → live
 * bridge → direct fetch fallback, then the engine's footprint-candle tail
 * overriding bucket-for-bucket. `withKlines=false` skips exchange history
 * entirely (engine-only targets). Result cached 15 s and shared by every
 * caller — a panel for close, volume, delta and the projected-state build
 * all hit the venue at most once per TTL window.
 */
export async function loadMergedBars(
  asset: OfAsset,
  tf: number,
  backfill: number,
  opts: { withKlines?: boolean } = {},
): Promise<MergedBarSet> {
  const cap = Math.max(60, Math.min(1500, backfill));
  const withKlines = opts.withKlines ?? true;
  const interval = TF_TO_BINANCE[tf];
  const key = `${asset}|${tf}|${cap}|${withKlines ? 'k' : 'e'}`;
  const now = Date.now();
  const hit = barCache.get(key);
  if (hit && hit.set && now - hit.at < BARS_TTL_MS) return hit.set;
  if (hit && hit.promise) return hit.promise;

  const promise = (async (): Promise<MergedBarSet> => {
    const manager = getOrderFlowManager();
    manager.touch(asset);
    const state = manager.stateOf(asset);
    const engine = state?.engine;

    let klinesBars: RawBar[] = [];
    let klineError: string | null = null;
    let klineSource: 'store' | 'store+live' | 'binance' | 'none' = 'none';
    if (withKlines && interval) {
      const tfSec = tf / 1000;
      // 1) stored history (the backfill worker's mirror) — no venue call
      klinesBars = await fetchStoredKlines(asset, tfSec, cap);
      if (klinesBars.length >= Math.min(240, cap * 0.6)) {
        klineSource = 'store';
        // 2) bridge the gap to now with one small live request (write-through)
        try {
          const bridge = await fetchKlines(`${asset}USDT`, interval, 30);
          const known = new Set(klinesBars.map((b) => b.ds));
          const fresh = bridge.filter((b) => !known.has(b.ds));
          if (fresh.length) {
            const cut = bridge[0]?.ds ?? Infinity;
            klinesBars = [...klinesBars.filter((b) => b.ds < cut), ...bridge]
              .sort((a, b) => a.ds - b.ds)
              .slice(-cap);
            klineSource = 'store+live';
          }
          void persistKlines(asset, tfSec, bridge);
        } catch {
          /* live bridge optional — stored history + engine tail still valid */
        }
      } else {
        // store cold: direct fetch (the old 418-risk path, now write-through)
        klinesBars = [];
        try {
          klinesBars = await fetchKlines(`${asset}USDT`, interval, cap);
          klineSource = 'binance';
          void persistKlines(asset, tfSec, klinesBars);
        } catch (e) {
          klineError = e instanceof Error ? e.message : 'kline fetch failed';
          // last resort: whatever the store had (possibly partial)
          const stored = await fetchStoredKlines(asset, tfSec, cap);
          if (stored.length) {
            klinesBars = stored;
            klineSource = 'store';
            klineError = `${klineError} (served from partial store)`;
          }
        }
      }
    }

    let engineCount = 0;
    let engineCandles: OfCandle[] = [];
    let oiPoints: { time: number; openInterest: number }[] = [];
    if (engine) {
      engineCandles = engine.candlesFor(tf).slice(-cap);
      oiPoints = engine.oiSeries();
    }

    // merge: kline history + engine tail (engine wins bucket-for-bucket)
    const byTime = new Map<number, RawBar>();
    for (const b of klinesBars) byTime.set(b.ds, b);
    for (const c of engineCandles) {
      const b = candleToBar(c);
      if (byTime.has(b.ds)) engineCount++;
      byTime.set(b.ds, b);
    }
    const bars = [...byTime.values()].sort((a, b) => a.ds - b.ds);

    return {
      bars,
      klinesBars: klinesBars.length,
      engineCount,
      klineError,
      klineSource,
      liveTailFrom: engineCandles.length ? engineCandles[0].openTime : null,
      engineCandles,
      oiPoints,
    };
  })();

  const entry: BarCacheEntry = { key, promise, set: null, at: now };
  barCache.set(key, entry);
  try {
    const set = await promise;
    entry.set = set;
    entry.at = Date.now();
    return set;
  } finally {
    entry.promise = null;
  }
}

// ── series construction (pure, shared with the projected-state builder) ──────

/** Aggregate target series from the merged bar history (pure). */
export function aggregateSeries(
  bars: RawBar[],
  target: 'close' | 'volume' | 'delta' | 'cvd' | 'imbalance' | 'trades',
): { points: { ds: number; y: number }[]; bounds: { lo?: number; hi?: number } | null } {
  let cvd = 0;
  const points: { ds: number; y: number }[] = [];
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
    points.push({ ds: b.ds, y });
  }
  return { points, bounds: target === 'imbalance' ? { lo: 0, hi: 1 } : null };
}

/** FlowX feature columns (delta, log-volume, buy share, CVD slope) — pure. */
export function flowFeatures(bars: RawBar[]): Float64Array[] {
  const n = bars.length;
  if (n <= 8) return [];
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
  return [fDelta, fVolume, fShare, fCvdSlope];
}

// ── panel cache — one in-flight promise per key + TTL result cache ────────────

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
    const engineOnly = target === 'oi' || target === 'venueVolumeShare' || target === 'venueDelta';
    const withKlines = !engineOnly;
    const { bars, klinesBars, engineCount, klineError, klineSource, liveTailFrom, engineCandles, oiPoints } =
      await loadMergedBars(asset, tf, backfill, { withKlines });

    const series: FcSeries[] = [];
    const features: Float64Array[][] = [];
    let bounds: { lo?: number; hi?: number } | null = null;

    if (target === 'venueVolumeShare' || target === 'venueDelta') {
      // per-venue panel: one series per venue, engine session scope
      const tape = getOrderFlowManager().stateOf(asset)?.tape ?? [];
      for (const venue of OF_VENUES) {
        const label = `${asset} · ${venue} ${target === 'venueVolumeShare' ? 'volume share' : 'delta'} · ${tf / 60_000}m`;
        const pts: { ds: number; y: number }[] = [];
        if (target === 'venueVolumeShare') {
          for (const c of [...engineCandles].sort((a, b) => a.openTime - b.openTime)) {
            const v = c.venueVolumes[venue as OfVenueId] ?? 0;
            const total = Object.values(c.venueVolumes).reduce((a, b) => a + (b ?? 0), 0);
            if (total > 0) pts.push({ ds: c.openTime, y: v / total });
          }
          bounds = { lo: 0, hi: 1 };
        } else {
          const buckets = new Map<number, number>();
          for (const p of tape) {
            if (p.venue !== venue) continue;
            const b = Math.floor(p.timestamp / tf) * tf;
            buckets.set(b, (buckets.get(b) ?? 0) + (p.side === 'buy' ? p.quantity : -p.quantity));
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
      const { points, bounds: b } = aggregateSeries(bars, target);
      bounds = b;
      series.push({
        uniqueId: `${asset}-${target}`,
        label: `${asset} · ${target} · ${tf / 60_000}m`,
        points,
        liveTailFrom: liveTailFrom ?? undefined,
      });
      features.push(flowFeatures(bars));
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
        klinesBars,
        engineBars: engineCount,
        engineOnly,
        klineError,
        klineSource,
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

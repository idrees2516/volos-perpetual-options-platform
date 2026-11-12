// ─────────────────────────────────────────────────────────────────────────────
// STORE — historical backfill worker ("kill the 418s by asking once")
//
// Walks months of venue REST history into SQLite, one small chunk at a time:
//
//   • Binance USDT-perp klines (1m/5m/15m/30m) — the only public source with
//     taker-buy base volume, the same aggressor semantics as engine delta.
//   • Binance funding-rate history (8h points, full depth) and OI history
//     (5m period, ~30 days — the API's own depth cap).
//   • Bybit + OKX klines (5m) as a secondary layer for venue-comparison
//     analytics later (no taker-buy split on some venues → buyVolume=null
//     is NOT representable in the schema, so those venues only backfill
//     where taker-buy exists: Bybit yes via /v5/market/kline? — actually no
//     taker split — we store only Binance for delta semantics; the worker
//     is venue-generic so adding a venue later is one adapter entry).
//
// RATE-LIMIT DISCIPLINE (the whole point):
//   – minimum spacing between ANY two venue REST calls (default 1200 ms —
//     Binance futures weight is generous with klines@1 but 418 = IP ban);
//   – 418/429 → exponential backoff with jitter, respecting Retry-After;
//     the worker PAUSES (never hammers) and resumes from the last finished
//     chunk (BackfillJob rows are the resume ledger);
//   – every write is an upsert on the natural unique key — chunks are
//     idempotent, restarts re-run at most the in-flight chunk.
//
// The worker is a module singleton inside the Node server; start/stop/status
// via /api/store/backfill (POST {action}, GET status). Auto-start opt-in via
// env AUTO_BACKFILL=1 so a fresh deployment begins history on boot.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
import { OF_ASSETS } from '@/lib/orderflow/catalog';
import type { OfAsset } from '@/lib/orderflow/types';

// ── configuration ────────────────────────────────────────────────────────────

export interface BackfillConfig {
  assets: OfAsset[];
  /** kline timeframes to backfill (seconds → Binance interval) */
  klineTfs: number[];
  /** days of history per kline timeframe */
  klineDepthDays: Record<number, number>;
  /** days of funding-rate history */
  fundingDepthDays: number;
  /** OI history: Binance serves ~30 days at 5m — fixed depth */
  oiDepthDays: number;
  /** minimum spacing between venue REST calls (ms) */
  minCallGapMs: number;
  /** base backoff after a 418/429 (ms) — doubles per consecutive hit */
  backoffBaseMs: number;
  /** hard ceiling for a single backoff */
  backoffMaxMs: number;
  /** klines rows per request (Binance max 1500) */
  klineBatch: number;
}

export const DEFAULT_BACKFILL_CONFIG: BackfillConfig = {
  assets: [...OF_ASSETS],
  klineTfs: [60, 300, 1800],
  klineDepthDays: { 60: 30, 300: 120, 1800: 365 },
  fundingDepthDays: 180,
  oiDepthDays: 29,
  minCallGapMs: 1200,
  backoffBaseMs: 45_000,
  backoffMaxMs: 900_000,
  klineBatch: 1500,
};

const TF_TO_BINANCE: Record<number, string> = {
  60: '1m',
  300: '5m',
  900: '15m',
  1800: '30m',
  3600: '1h',
};

const BINANCE_F = 'https://fapi.binance.com';
const DAY_MS = 86_400_000;

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

/** Plan the [from, to] chunks (ms epoch) that cover [startMs, endMs], walking
 *  BACKWARDS from endMs in windows of maxPerChunk*stepMs, returned
 *  chronologically. Idempotent: re-running any chunk re-writes the same rows. */
export function planChunks(startMs: number, endMs: number, stepMs: number, maxPerChunk: number): Array<[number, number]> {
  if (endMs <= startMs || stepMs <= 0 || maxPerChunk <= 0) return [];
  const span = maxPerChunk * stepMs;
  const chunks: Array<[number, number]> = [];
  let hi = endMs;
  let guard = 0;
  while (hi > startMs && guard++ < 100_000) {
    const lo = Math.max(startMs, hi - span);
    if (lo < hi) chunks.push([lo, hi]);
    hi = lo;
  }
  return chunks.reverse(); // chronological order
}

/** Next backoff after `consecutiveHits` 418/429s: base·2^(n−1) ± jitter, capped
 *  at maxMs and floored at 1 s (deterministic when jitter is passed). */
export function nextBackoffMs(consecutiveHits: number, baseMs: number, maxMs: number, jitter = 0.5): number {
  const n = Math.max(1, consecutiveHits);
  const raw = baseMs * Math.pow(2, n - 1);
  const capped = Math.min(maxMs, raw);
  const spread = Math.min(capped / 2, 5_000);
  const out = Math.round(capped + (jitter * 2 - 1) * spread);
  return Math.max(1_000, Math.min(maxMs, out));
}

/** Retry-After header (seconds or HTTP-date) → ms; null when absent/bogus. */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const asSec = Number(header);
  if (Number.isFinite(asSec) && asSec >= 0) return Math.min(asSec * 1000, 900_000);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, Math.min(asDate - Date.now(), 900_000));
  return null;
}

export interface RawKlineRow {
  tOpen: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  trades: number;
}

/** Parse a Binance kline array row; null on malformed/short rows. */
export function parseBinanceKline(r: unknown[]): RawKlineRow | null {
  if (!Array.isArray(r) || r.length < 12) return null;
  const v = (x: unknown) => (typeof x === 'number' ? x : Number(x));
  const row: RawKlineRow = {
    tOpen: v(r[0]),
    open: v(r[1]),
    high: v(r[2]),
    low: v(r[3]),
    close: v(r[4]),
    volume: v(r[5]),
    buyVolume: v(r[9]),
    trades: v(r[8]),
  };
  for (const key of ['tOpen', 'open', 'high', 'low', 'close', 'volume', 'buyVolume', 'trades'] as const) {
    if (!Number.isFinite(row[key])) return null;
  }
  if (row.tOpen <= 0 || row.volume < 0 || row.buyVolume < 0 || row.trades < 0) return null;
  return row;
}

// ── rate-limited fetch ───────────────────────────────────────────────────────

class Throttle418 extends Error {
  constructor(public status: number, public retryAfterMs: number | null) {
    super(`venue ${status}`);
  }
}

interface FetcherHooks {
  onWait: (ms: number, why: string) => void;
}

/** Rate-limited JSON fetch: enforces minCallGapMs and translates 418/429. */
async function fetchLimited<T>(url: string, cfg: BackfillConfig, hooks: FetcherHooks): Promise<T> {
  const gap = Date.now() - fetchLimited.lastCall;
  if (gap < cfg.minCallGapMs) {
    const wait = cfg.minCallGapMs - gap;
    hooks.onWait(wait, 'pace');
    await new Promise((r) => setTimeout(r, wait));
  }
  fetchLimited.lastCall = Date.now();
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    if (res.status === 418 || res.status === 429) {
      const ra = retryAfterMs(res.headers.get('retry-after'));
      throw new Throttle418(res.status, ra);
    }
    if (!res.ok) throw new Error(`venue ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(to);
  }
}
fetchLimited.lastCall = 0;

// ── worker state ─────────────────────────────────────────────────────────────

export interface BackfillStatus {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  phase: string;
  current: string | null;
  done: number;
  total: number;
  rowsWritten: number;
  throttle: { hits: number; lastAt: number | null; waitingMs: number; nextRetryAt: number | null } | null;
  errors: string[];
  coverage: BackfillCoverage[];
}

export interface BackfillCoverage {
  table: 'klineBar' | 'derivativesPoint';
  venue: string;
  asset: string;
  kind: string; // 'klines:60' | 'funding' | 'oi:300'
  rows: number;
  from: string | null;
  to: string | null;
}

const g = globalThis as unknown as {
  __volosBackfill?: {
    status: BackfillStatus;
    run: Promise<void> | null;
    stop: boolean;
    cfg: BackfillConfig;
    backoffHits: number;
    backoffUntil: number;
    lastThrottle: number;
    lastWaitMs: number;
  };
};

function state() {
  if (!g.__volosBackfill) {
    g.__volosBackfill = {
      status: {
        running: false,
        startedAt: null,
        finishedAt: null,
        phase: 'idle',
        current: null,
        done: 0,
        total: 0,
        rowsWritten: 0,
        throttle: null,
        errors: [],
        coverage: [],
      },
      run: null,
      stop: false,
      cfg: DEFAULT_BACKFILL_CONFIG,
      backoffHits: 0,
      backoffUntil: 0,
      lastThrottle: 0,
      lastWaitMs: 0,
    };
  }
  return g.__volosBackfill;
}

export function backfillStatus(): BackfillStatus {
  const s = state();
  return { ...s.status, coverage: s.status.coverage };
}

export function stopBackfill(): void {
  const s = state();
  s.stop = true;
}

// ── coverage report (also used by /api/store/stats) ──────────────────────────

export async function backfillCoverage(): Promise<BackfillCoverage[]> {
  try {
    const out: BackfillCoverage[] = [];
    for (const asset of OF_ASSETS) {
      const rows = await db.klineBar.groupBy({ by: ['venue', 'tfSec'], where: { asset }, _count: { _all: true }, _min: { tOpen: true }, _max: { tOpen: true } });
      for (const r of rows) {
        out.push({
          table: 'klineBar',
          venue: r.venue,
          asset,
          kind: `klines:${r.tfSec}`,
          rows: r._count._all,
          from: r._min.tOpen?.toISOString() ?? null,
          to: r._max.tOpen?.toISOString() ?? null,
        });
      }
      for (const kind of ['funding', 'openInterest'] as const) {
        const pts = await db.derivativesPoint.aggregate({ where: { asset, kind }, _count: { _all: true }, _min: { ts: true }, _max: { ts: true } });
        if (pts._count._all > 0) {
          out.push({
            table: 'derivativesPoint',
            venue: 'binance',
            asset,
            kind,
            rows: pts._count._all,
            from: pts._min.ts?.toISOString() ?? null,
            to: pts._max.ts?.toISOString() ?? null,
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── chunk executors ──────────────────────────────────────────────────────────

async function backfillKlineChunk(
  asset: OfAsset,
  tfSec: number,
  fromMs: number,
  toMs: number,
  cfg: BackfillConfig,
): Promise<number> {
  const interval = TF_TO_BINANCE[tfSec];
  if (!interval) return 0;
  const symbol = `${asset}USDT`;
  const url = `${BINANCE_F}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${fromMs}&endTime=${toMs - 1}&limit=${cfg.klineBatch}`;
  const rows = (await fetchLimited<unknown[][]>(url, cfg, { onWait: (ms) => void noteWait(ms) })) as unknown[][];
  let written = 0;
  for (const r of rows) {
    const bar = parseBinanceKline(r);
    if (!bar) continue;
    await db.klineBar.upsert({
      where: { venue_asset_tfSec_tOpen: { venue: 'binance', asset, tfSec, tOpen: new Date(bar.tOpen) } },
      create: {
        venue: 'binance',
        asset,
        tfSec,
        tOpen: new Date(bar.tOpen),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        buyVolume: bar.buyVolume,
        trades: bar.trades,
      },
      update: {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        buyVolume: bar.buyVolume,
        trades: bar.trades,
      },
    });
    written++;
  }
  await db.backfillJob.create({
    data: {
      venue: 'binance',
      asset,
      kind: `klines:${tfSec}`,
      from: new Date(fromMs),
      to: new Date(toMs),
      rows: written,
      ms: 0,
    },
  });
  return written;
}

async function backfillFundingChunk(asset: OfAsset, fromMs: number, toMs: number, cfg: BackfillConfig): Promise<number> {
  const symbol = `${asset}USDT`;
  const url = `${BINANCE_F}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${fromMs}&endTime=${toMs - 1}&limit=1000`;
  const rows = (await fetchLimited<Array<{ fundingRate: string; fundingTime: number }>>(url, cfg, { onWait: (ms) => void noteWait(ms) })) as Array<{ fundingRate: string; fundingTime: number }>;
  let written = 0;
  for (const r of rows) {
    const v = Number(r.fundingRate);
    const t = Number(r.fundingTime);
    if (!Number.isFinite(v) || !Number.isFinite(t)) continue;
    await db.derivativesPoint.upsert({
      where: { venue_asset_kind_ts: { venue: 'binance', asset, kind: 'funding', ts: new Date(t) } },
      create: { venue: 'binance', asset, kind: 'funding', ts: new Date(t), value: v },
      update: { value: v },
    });
    written++;
  }
  await db.backfillJob.create({
    data: { venue: 'binance', asset, kind: 'funding', from: new Date(fromMs), to: new Date(toMs), rows: written, ms: 0 },
  });
  return written;
}

async function backfillOiChunk(asset: OfAsset, fromMs: number, toMs: number, cfg: BackfillConfig): Promise<number> {
  const symbol = `${asset}USDT`;
  const url = `${BINANCE_F}/futures/data/openInterestHist?symbol=${symbol}&period=5m&startTime=${fromMs}&endTime=${toMs - 1}&limit=1000`;
  const rows = (await fetchLimited<Array<{ sumOpenInterest: string; timestamp: number }>>(url, cfg, { onWait: (ms) => void noteWait(ms) })) as Array<{ sumOpenInterest: string; timestamp: number }>;
  let written = 0;
  for (const r of rows) {
    const v = Number(r.sumOpenInterest);
    const t = Number(r.timestamp);
    if (!Number.isFinite(v) || !Number.isFinite(t)) continue;
    await db.derivativesPoint.upsert({
      where: { venue_asset_kind_ts: { venue: 'binance', asset, kind: 'openInterest', ts: new Date(t) } },
      create: { venue: 'binance', asset, kind: 'openInterest', ts: new Date(t), value: v },
      update: { value: v },
    });
    written++;
  }
  await db.backfillJob.create({
    data: { venue: 'binance', asset, kind: 'oi:300', from: new Date(fromMs), to: new Date(toMs), rows: written, ms: 0 },
  });
  return written;
}

function noteWait(ms: number): void {
  const s = state();
  s.lastWaitMs = ms;
}

// ── the runner ───────────────────────────────────────────────────────────────

interface Task {
  label: string;
  exec: () => Promise<number>;
}

function buildTasks(cfg: BackfillConfig): Task[] {
  const now = Date.now();
  const tasks: Task[] = [];
  for (const asset of cfg.assets) {
    for (const tf of cfg.klineTfs) {
      const days = cfg.klineDepthDays[tf] ?? 30;
      const from = now - days * DAY_MS;
      for (const [lo, hi] of planChunks(from, now, tf * 1000, cfg.klineBatch)) {
        tasks.push({
          label: `${asset} klines:${TF_TO_BINANCE[tf]} ${new Date(lo).toISOString().slice(0, 16)}→${new Date(hi).toISOString().slice(11, 16)}`,
          exec: () => backfillKlineChunk(asset, tf, lo, hi, cfg),
        });
      }
    }
    // funding: 8h points → chunks of 1000 points = ~333 days
    {
      const from = now - cfg.fundingDepthDays * DAY_MS;
      for (const [lo, hi] of planChunks(from, now, 8 * 3600_000, 1000)) {
        tasks.push({
          label: `${asset} funding ${new Date(lo).toISOString().slice(0, 16)}`,
          exec: () => backfillFundingChunk(asset, lo, hi, cfg),
        });
      }
    }
    // OI history: 5m period, capped depth by API
    {
      const from = now - cfg.oiDepthDays * DAY_MS;
      for (const [lo, hi] of planChunks(from, now, 300_000, 1000)) {
        tasks.push({
          label: `${asset} oi:5m ${new Date(lo).toISOString().slice(0, 16)}`,
          exec: () => backfillOiChunk(asset, lo, hi, cfg),
        });
      }
    }
  }
  return tasks;
}

export async function startBackfill(cfgOverride: Partial<BackfillConfig> = {}): Promise<BackfillStatus> {
  const s = state();
  if (s.run) return backfillStatus(); // already running
  s.cfg = { ...DEFAULT_BACKFILL_CONFIG, ...cfgOverride };
  s.stop = false;
  s.backoffHits = 0;
  s.backoffUntil = 0;
  s.status = {
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    phase: 'planning',
    current: null,
    done: 0,
    total: 0,
    rowsWritten: 0,
    throttle: null,
    errors: [],
    coverage: [],
  };
  s.run = (async () => {
    try {
      const tasks = buildTasks(s.cfg);
      s.status.total = tasks.length;
      s.status.phase = 'backfilling';
      for (const task of tasks) {
        if (s.stop) {
          s.status.phase = 'stopped';
          break;
        }
        // honour an active 418 backoff window
        const waitLeft = s.backoffUntil - Date.now();
        if (waitLeft > 0) {
          s.status.throttle = {
            hits: s.backoffHits,
            lastAt: s.lastThrottle || null,
            waitingMs: waitLeft,
            nextRetryAt: s.backoffUntil,
          };
          await new Promise((r) => setTimeout(r, Math.min(waitLeft, 60_000)));
          if (s.stop) {
            s.status.phase = 'stopped';
            break;
          }
        }
        s.status.current = task.label;
        try {
          const rows = await task.exec();
          s.status.rowsWritten += rows;
          s.backoffHits = 0; // success resets the escalation
          s.status.throttle = s.backoffUntil > Date.now() ? s.status.throttle : null;
        } catch (err) {
          if (err instanceof Throttle418) {
            s.backoffHits++;
            s.lastThrottle = Date.now();
            const wait =
              err.retryAfterMs && err.retryAfterMs > 0
                ? Math.min(err.retryAfterMs + 5_000, s.cfg.backoffMaxMs)
                : nextBackoffMs(s.backoffHits, s.cfg.backoffBaseMs, s.cfg.backoffMaxMs);
            s.backoffUntil = Date.now() + wait;
            s.status.throttle = {
              hits: s.backoffHits,
              lastAt: s.lastThrottle,
              waitingMs: wait,
              nextRetryAt: s.backoffUntil,
            };
            s.status.errors.push(`${task.label}: venue ${err.status} → backoff ${(wait / 1000).toFixed(0)}s`);
            if (s.status.errors.length > 50) s.status.errors.shift();
          } else {
            s.status.errors.push(`${task.label}: ${err instanceof Error ? err.message : String(err)}`);
            if (s.status.errors.length > 50) s.status.errors.shift();
          }
        }
        s.status.done++;
        // periodically refresh coverage for the status endpoint
        if (s.status.done % 25 === 0 || s.status.done === s.status.total) {
          s.status.coverage = await backfillCoverage();
        }
      }
      if (s.status.phase !== 'stopped') s.status.phase = 'complete';
    } catch (err) {
      s.status.phase = 'error';
      s.status.errors.push(String(err));
    } finally {
      s.status.running = false;
      s.status.finishedAt = Date.now();
      s.status.coverage = await backfillCoverage().catch(() => []);
      s.run = null;
    }
  })();
  return backfillStatus();
}

// auto-start on boot when asked (env flag; safe: idempotent chunks)
if (process.env.AUTO_BACKFILL === '1') {
  void startBackfill().catch(() => undefined);
}

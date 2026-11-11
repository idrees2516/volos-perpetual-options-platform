// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW / FORECAST — storage writer ("store now, analyze later")
//
// Persists the engine's own truth into SQLite (Prisma):
//   • MicroSnapshot — the advanced microstructure readout, every 30 s per
//     active asset (impact, toxicity, book shape, vol regime, profile...)
//   • FlowBar — the multi-venue 1-minute flow bars, one write per completed
//     minute, idempotent via (asset, tfSec, tOpen) unique key
//   • ForecastRun / ForecastEvalRun — every conformal forecast and its
//     cross-validation, written through by the API routes
//
// Every writer swallows its own errors: analytics storage must never take
// the live terminal down. Retention prunes anything older than RETENTION_DAYS
// opportunistically (at most once an hour).
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '@/lib/db';
import type { OrderFlowEngine } from '@/lib/orderflow/engine';
import type { OfAsset } from '@/lib/orderflow/types';

const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 3600_000;

let lastPrune = 0;

async function prune(): Promise<void> {
  if (Date.now() - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = Date.now();
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    await db.flowBar.deleteMany({ where: { tOpen: { lt: cutoff } } });
    await db.microSnapshot.deleteMany({ where: { ts: { lt: cutoff } } });
    await db.forecastRun.deleteMany({ where: { createdAt: { lt: cutoff } } });
    await db.forecastEvalRun.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch {
    /* storage is best-effort */
  }
}

/** Advanced microstructure snapshot from the engine's own analytics. */
export async function recordMicroSnapshot(asset: OfAsset, engine: OrderFlowEngine): Promise<void> {
  try {
    const a = engine.analytics();
    const stats = engine.sessionStats();
    if (!stats.last || a.cvd.length < 60) return; // too-young session
    await db.microSnapshot.create({
      data: {
        asset,
        ts: new Date(),
        price: stats.last,
        kyleLambda: a.advanced.kyleLambdaBpsPer100k,
        vpin: a.advanced.vpin,
        amihud: a.advanced.amihudBpsPer1m,
        signAutocorr: a.advanced.tradeSignAutocorr,
        microSkew: a.advanced.micropriceSkew,
        obi: a.advanced.obiMean1m,
        rvAnnPct: a.realizedVolAnnPct,
        atrPct: a.advanced.atrPct,
        volRegime: a.advanced.volRegime,
        vwapDist: a.advanced.vwapDistSigma,
        takerShare: a.advanced.takerBuyShare1m,
        volumeZ: a.volumeZ,
        cvd1m: a.cvd1m,
        depth10Bp: a.depth ? a.depth.bid10 + a.depth.ask10 : null,
        spreadBps: a.depth?.spreadBps ?? null,
        absorption15m: a.micro.absorption15m,
        iceberg15m: a.micro.iceberg15m,
      },
    });
    void prune();
  } catch {
    /* best-effort */
  }
}

/** Completed 1-minute flow bars, idempotent per (asset, tf, open). */
export async function recordFlowBars(asset: OfAsset, engine: OrderFlowEngine): Promise<void> {
  try {
    const candles = engine.candlesFor(60_000).filter((c) => c.complete);
    if (!candles.length) return;
    // only the last few minutes — the clock calls this every minute
    const recent = candles.slice(-4);
    const oiSeries = engine.oiSeries();
    for (const c of recent) {
      const oiAt = oiSeries.filter((p) => p.time <= c.openTime + 60_000).pop();
      await db.flowBar.upsert({
        where: { asset_tfSec_tOpen: { asset, tfSec: 60, tOpen: new Date(c.openTime) } },
        create: {
          asset,
          tfSec: 60,
          tOpen: new Date(c.openTime),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          buyVol: 0,
          sellVol: 0,
          delta: c.delta,
          trades: 0,
          cvd: c.cumulativeDelta,
          oi: oiAt?.openInterest,
        },
        update: {
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          delta: c.delta,
          cvd: c.cumulativeDelta,
          oi: oiAt?.openInterest,
        },
      });
    }
  } catch {
    /* best-effort */
  }
}

export interface StoredForecastParams {
  asset: string;
  tfSec: number;
  target: string;
  h: number;
  levels: number[];
  nWindows: number;
  cutoffMs: number;
  anchor: number;
  provenance: string;
}

/** Write-through for a conformal forecast run (called by /api/forecast). */
export async function recordForecastRun(
  params: StoredForecastParams,
  models: Array<{ alias: string; method: string; point: number[]; bounds?: Record<string, [number, number]> }>,
): Promise<void> {
  try {
    // compact band map at horizon h: alias → level → [lo, hi]
    const band: Record<string, Record<string, [number, number]>> = {};
    const summary: Array<Record<string, unknown>> = [];
    for (const m of models) {
      if (m.bounds) {
        band[`${m.alias}:${m.method}`] = Object.fromEntries(
          Object.entries(m.bounds).map(([lvl, [lo, hi]]) => [lvl, [Number(lo.toFixed(6)), Number(hi.toFixed(6))]]),
        );
      }
      summary.push({
        alias: m.alias,
        method: m.method,
        pointEnd: m.point.length ? Number(m.point[m.point.length - 1].toFixed(6)) : null,
        width80: m.bounds?.['80'] ? Number((m.bounds['80'][1] - m.bounds['80'][0]).toFixed(6)) : null,
        width95: m.bounds?.['95'] ? Number((m.bounds['95'][1] - m.bounds['95'][0]).toFixed(6)) : null,
      });
    }
    const median = models.find((m) => m.alias === 'ensemble' && m.method === 'conformal_error')?.point;
    const expectedMove =
      median && median.length ? Math.abs(median[median.length - 1] - params.anchor) : null;
    await db.forecastRun.create({
      data: {
        asset: params.asset,
        tfSec: params.tfSec,
        target: params.target,
        h: params.h,
        levelsJson: JSON.stringify(params.levels),
        nWindows: params.nWindows,
        cutoff: new Date(params.cutoffMs),
        anchor: params.anchor,
        expectedMove: expectedMove ?? null,
        bandJson: JSON.stringify(band),
        modelsJson: JSON.stringify(summary),
        provenance: params.provenance,
      },
    });
    void prune();
  } catch {
    /* best-effort */
  }
}

/** Write-through for a cross-validated evaluation run. */
export async function recordForecastEvalRun(
  params: { asset: string; tfSec: number; target: string; h: number; levels: number[]; cvWindows: number },
  rows: unknown[],
  perStep?: unknown,
): Promise<void> {
  try {
    await db.forecastEvalRun.create({
      data: {
        asset: params.asset,
        tfSec: params.tfSec,
        target: params.target,
        h: params.h,
        levelsJson: JSON.stringify(params.levels),
        cvWindows: params.cvWindows,
        rowsJson: JSON.stringify(rows).slice(0, 200_000),
        perStepJson: perStep !== undefined ? JSON.stringify(perStep).slice(0, 100_000) : null,
      },
    });
    void prune();
  } catch {
    /* best-effort */
  }
}

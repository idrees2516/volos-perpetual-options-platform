// GET /api/store/stats — what the analytics storage holds.
//
// Row counts, time ranges and latest timestamps per table per asset, so
// panels and the copilot can see stored history depth at a glance.

import { db } from '@/lib/db';
import { json } from '@/lib/orderflow/wire';
import { OF_ASSETS } from '@/lib/orderflow/catalog';
import { backfillStatus } from '@/lib/store/backfill';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [flowBars, micro, runs, evals, klines, deriv, jobs] = await Promise.all([
      db.flowBar.groupBy({ by: ['asset'], _count: { _all: true }, _min: { tOpen: true }, _max: { tOpen: true } }),
      db.microSnapshot.groupBy({ by: ['asset'], _count: { _all: true }, _min: { ts: true }, _max: { ts: true } }),
      db.forecastRun.groupBy({ by: ['asset'], _count: { _all: true }, _min: { createdAt: true }, _max: { createdAt: true } }),
      db.forecastEvalRun.groupBy({ by: ['asset'], _count: { _all: true } }),
      db.klineBar.groupBy({ by: ['asset', 'tfSec'], _count: { _all: true }, _min: { tOpen: true }, _max: { tOpen: true } }),
      db.derivativesPoint.groupBy({ by: ['asset', 'kind'], _count: { _all: true }, _min: { ts: true }, _max: { ts: true } }),
      db.backfillJob.aggregate({ _count: { _all: true } }),
    ]);
    const flowBy = new Map(flowBars.map((g) => [g.asset, g]));
    const microBy = new Map(micro.map((g) => [g.asset, g]));
    const runBy = new Map(runs.map((g) => [g.asset, g]));
    const evalBy = new Map(evals.map((g) => [g.asset, g._count._all]));
    const klineBy = new Map<string, (typeof klines)[number]>();
    for (const k of klines) klineBy.set(`${k.asset}:${k.tfSec}`, k);
    const derivBy = new Map(deriv.map((g) => [`${g.asset}:${g.kind}`, g]));
    const assets = [...new Set([...OF_ASSETS, ...flowBy.keys(), ...microBy.keys(), ...runBy.keys()])];
    return json({
      tables: ['flowBar', 'microSnapshot', 'forecastRun', 'forecastEvalRun', 'klineBar', 'derivativesPoint', 'backfillJob'],
      assets: assets.map((asset) => {
        const f = flowBy.get(asset);
        const m = microBy.get(asset);
        const r = runBy.get(asset);
        const k60 = klineBy.get(`${asset}:60`);
        const k300 = klineBy.get(`${asset}:300`);
        const k1800 = klineBy.get(`${asset}:1800`);
        const funding = derivBy.get(`${asset}:funding`);
        const oi = derivBy.get(`${asset}:openInterest`);
        return {
          asset,
          flowBars: f?._count._all ?? 0,
          flowBarFrom: f?._min.tOpen ?? null,
          flowBarTo: f?._max.tOpen ?? null,
          microSnapshots: m?._count._all ?? 0,
          microFrom: m?._min.ts ?? null,
          microTo: m?._max.ts ?? null,
          forecastRuns: r?._count._all ?? 0,
          forecastFrom: r?._min.createdAt ?? null,
          forecastTo: r?._max.createdAt ?? null,
          forecastEvals: evalBy.get(asset) ?? 0,
          klines: {
            '1m': { rows: k60?._count._all ?? 0, from: k60?._min.tOpen ?? null, to: k60?._max.tOpen ?? null },
            '5m': { rows: k300?._count._all ?? 0, from: k300?._min.tOpen ?? null, to: k300?._max.tOpen ?? null },
            '30m': { rows: k1800?._count._all ?? 0, from: k1800?._min.tOpen ?? null, to: k1800?._max.tOpen ?? null },
          },
          fundingPoints: funding?._count._all ?? 0,
          fundingFrom: funding?._min.ts ?? null,
          fundingTo: funding?._max.ts ?? null,
          oiPoints: oi?._count._all ?? 0,
          oiFrom: oi?._min.ts ?? null,
          oiTo: oi?._max.ts ?? null,
        };
      }),
      backfill: {
        chunks: jobs._count._all,
        status: backfillStatus(),
      },
      tsMs: Date.now(),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'store unavailable' }, 500);
  }
}

// GET /api/store/stats — what the analytics storage holds.
//
// Row counts, time ranges and latest timestamps per table per asset, so
// panels and the copilot can see stored history depth at a glance.

import { db } from '@/lib/db';
import { json } from '@/lib/orderflow/wire';
import { OF_ASSETS } from '@/lib/orderflow/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [flowBars, micro, runs, evals] = await Promise.all([
      db.flowBar.groupBy({ by: ['asset'], _count: { _all: true }, _min: { tOpen: true }, _max: { tOpen: true } }),
      db.microSnapshot.groupBy({ by: ['asset'], _count: { _all: true }, _min: { ts: true }, _max: { ts: true } }),
      db.forecastRun.groupBy({ by: ['asset'], _count: { _all: true }, _min: { createdAt: true }, _max: { createdAt: true } }),
      db.forecastEvalRun.groupBy({ by: ['asset'], _count: { _all: true } }),
    ]);
    const flowBy = new Map(flowBars.map((g) => [g.asset, g]));
    const microBy = new Map(micro.map((g) => [g.asset, g]));
    const runBy = new Map(runs.map((g) => [g.asset, g]));
    const evalBy = new Map(evals.map((g) => [g.asset, g._count._all]));
    const assets = [...new Set([...OF_ASSETS, ...flowBy.keys(), ...microBy.keys(), ...runBy.keys()])];
    return json({
      tables: ['flowBar', 'microSnapshot', 'forecastRun', 'forecastEvalRun'],
      assets: assets.map((asset) => {
        const f = flowBy.get(asset);
        const m = microBy.get(asset);
        const r = runBy.get(asset);
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
        };
      }),
      tsMs: Date.now(),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'store unavailable' }, 500);
  }
}

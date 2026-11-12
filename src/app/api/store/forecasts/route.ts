// GET /api/store/forecasts?asset=BTC&target=close&limit=200&model=ensemble
//
// The payoff of "store now, analyze later": every persisted conformal
// forecast run is re-scored against what actually happened, using the stored
// 1-minute flow bars as ground truth.
//
// For each ForecastRun (asset, target=close, h, cutoff, bandJson):
//   realized close := FlowBar.close at tOpen ≈ cutoff + h·tfSec
//   covered(level) := lo ≤ realized ≤ hi
// Aggregated per model:method and per level → empirical coverage over all
// stored runs, plus mean width and the per-run detail rows.
// This is the long-horizon calibration audit — it survives restarts and
// accumulates across days, unlike the live SSE walk-forward counter.

import { db } from '@/lib/db';
import { isOfAsset } from '@/lib/orderflow/catalog';
import { json } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BandMap {
  [modelKey: string]: { [level: string]: [number, number] };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get('asset') ?? 'BTC').toUpperCase();
  const asset = (isOfAsset(raw) ? raw : raw) as string;
  const target = url.searchParams.get('target') ?? 'close';
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 200));
  const modelFilter = url.searchParams.get('model');

  try {
    const runs = await db.forecastRun.findMany({
      where: { asset, target, ...(modelFilter ? { modelsJson: { contains: modelFilter } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    if (!runs.length) return json({ asset, target, runs: [], coverage: [], tsMs: Date.now() });

    // ground truth: every stored 1 m close, one lookup map
    const from = Math.min(...runs.map((r) => r.cutoff.getTime())) - 4 * 3600_000;
    const bars = await db.flowBar.findMany({
      where: { asset, tfSec: 60, tOpen: { gte: new Date(from) } },
      orderBy: { tOpen: 'asc' },
    });
    const closeByT = new Map<number, number>();
    for (const b of bars) closeByT.set(b.tOpen.getTime(), b.close);

    // aggregate coverage per model:method and per level
    const agg = new Map<string, Map<number, { in: number; n: number; width: number }>>();
    const detail: Array<Record<string, unknown>> = [];
    for (const run of runs) {
      const targetT = run.cutoff.getTime() + run.h * run.tfSec * 1000;
      let realized = closeByT.get(targetT);
      if (realized === undefined) {
        // nearest stored bar within ±tf (tolerant to sparse minutes)
        for (const tol of [60_000, 120_000, 180_000]) {
          realized = closeByT.get(targetT - tol) ?? closeByT.get(targetT + tol);
          if (realized !== undefined) break;
        }
      }
      if (realized === undefined) continue; // horizon not realized yet
      const band = JSON.parse(run.bandJson) as BandMap;
      for (const [modelKey, levels] of Object.entries(band)) {
        if (modelFilter && !modelKey.includes(modelFilter)) continue;
        let levelsAgg = agg.get(modelKey);
        if (!levelsAgg) agg.set(modelKey, (levelsAgg = new Map()));
        for (const [lvl, [lo, hi]] of Object.entries(levels)) {
          const level = Number(lvl);
          let cell = levelsAgg.get(level);
          if (!cell) levelsAgg.set(level, (cell = { in: 0, n: 0, width: 0 }));
          cell.n++;
          cell.width += hi - lo;
          if (realized >= lo && realized <= hi) cell.in++;
          if (modelKey.startsWith('ensemble:')) {
            detail.push({
              t: run.createdAt.getTime(),
              cutoff: run.cutoff.getTime(),
              h: run.h,
              tfSec: run.tfSec,
              level,
              lo,
              hi,
              realized,
              covered: realized >= lo && realized <= hi,
            });
          }
        }
      }
    }

    const coverage = [...agg.entries()]
      .map(([modelKey, levels]) => ({
        model: modelKey,
        levels: [...levels.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([level, c]) => ({
            level,
            coverage: c.n ? c.in / c.n : null,
            meanWidth: c.n ? c.width / c.n : null,
            n: c.n,
          })),
      }))
      .sort((a, b) => (b.levels[0]?.n ?? 0) - (a.levels[0]?.n ?? 0));

    return json({
      asset,
      target,
      runsScanned: runs.length,
      runsRealized: detail.length,
      coverage,
      runs: detail.slice(-Math.min(detail.length, 500)),
      tsMs: Date.now(),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'store unavailable' }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/viz/series — load ANY catalog series for (asset, tf): the universal
// data plane behind the Chart Studio, the Model Studio inputs and the
// copilot's chart tool. Rides the shared merged-bar cache.
// ─────────────────────────────────────────────────────────────────────────────

import { loadVizSeries, seriesSpecOf } from '@/lib/viz/series';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ASSETS = ['BTC', 'ETH', 'SOL'] as const;
const TFS = [60_000, 300_000, 900_000, 1_800_000] as const;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id') ?? 'close';
    const asset = (ASSETS.includes((url.searchParams.get('asset') ?? 'BTC') as (typeof ASSETS)[number]) ? url.searchParams.get('asset') : 'BTC') as 'BTC';
    const tfRaw = Number(url.searchParams.get('tf') ?? 1_800_000);
    const tf = (TFS.includes(tfRaw as (typeof TFS)[number]) ? tfRaw : 1_800_000) as number;
    const backfill = Math.max(60, Math.min(1500, Number(url.searchParams.get('backfill') ?? 720)));
    if (!seriesSpecOf(id)) {
      return Response.json({ ok: false, error: `unknown series id: ${id}` }, { status: 400 });
    }
    const t0 = Date.now();
    const series = await loadVizSeries(id, asset, tf, backfill);
    return Response.json(
      { ok: true, series, meta: { id, asset, tf, backfill, computeMs: Date.now() - t0, points: series.points?.length ?? series.matrix?.values.length ?? 0 } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : 'series load failed' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

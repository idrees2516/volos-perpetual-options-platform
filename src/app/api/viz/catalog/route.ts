// ─────────────────────────────────────────────────────────────────────────────
// /api/viz/catalog — the Chart/Model Studio catalog: every plottable series
// in the product, every runnable model, every chart kind, every transform.
// One JSON contract that drives the Studio UI AND the copilot's chart/model
// tools — the "what can I even draw/run" surface.
// ─────────────────────────────────────────────────────────────────────────────

import { SERIES_SPECS, SERIES_GROUPS } from '@/lib/viz/series';
import { MODEL_SPECS } from '@/lib/viz/modelrunner';
import { CHART_KINDS, TRANSFORMS } from '@/lib/viz/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(
    {
      ok: true,
      series: SERIES_SPECS,
      groups: SERIES_GROUPS,
      models: MODEL_SPECS,
      chartKinds: CHART_KINDS,
      transforms: TRANSFORMS,
      note: 'any points series renders as any chart kind (candles need candle-capable sources; matrix families render as heatmaps); stats models run on any series — model outputs are series again',
      meta: { seriesCount: SERIES_SPECS.length, modelCount: MODEL_SPECS.length, chartKinds: CHART_KINDS.length, transforms: TRANSFORMS.length },
    },
    { headers: { 'Cache-Control': 'public, max-age=60' } },
  );
}

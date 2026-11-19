// ─────────────────────────────────────────────────────────────────────────────
// POST /api/models/run — run ANY model from the room on ANY series with ANY
// parameters. The Model Studio's compute path AND the copilot's model tool:
// verdicts + chartable outputs, the same VizSeries the Chart Studio plots.
// ─────────────────────────────────────────────────────────────────────────────

import { runModel, MODEL_MAP } from '@/lib/viz/modelrunner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      model?: string;
      asset?: string;
      tf?: number;
      backfill?: number;
      seriesId?: string;
      params?: Record<string, number | string>;
    };
    if (!body.model || !MODEL_MAP.has(body.model)) {
      return Response.json({ ok: false, error: `unknown model: ${body.model ?? '(none)'} — see /api/viz/catalog` }, { status: 400 });
    }
    const asset = (['BTC', 'ETH', 'SOL'] as const).includes((body.asset ?? 'BTC') as 'BTC') ? (body.asset ?? 'BTC') : 'BTC';
    const tfRaw = Number(body.tf ?? 1_800_000);
    const tf = [60_000, 300_000, 900_000, 1_800_000].includes(tfRaw) ? tfRaw : 1_800_000;
    const t0 = Date.now();
    const result = await runModel({
      model: body.model,
      asset: asset as 'BTC',
      tf,
      backfill: body.backfill,
      seriesId: body.seriesId,
      params: body.params,
    });
    return Response.json(
      { ok: true, result, meta: { model: body.model, computeMs: Date.now() - t0, outputs: result.outputs.length } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : 'model run failed' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

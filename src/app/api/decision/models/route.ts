// ─────────────────────────────────────────────────────────────────────────────
// /api/decision/models — the model-suite detail pass: every statistical model
// (GARCH, HMM, Kalman, OU, Merton, ML, Kelly, mixed MC) with its fitted
// parameters, chart-ready series, and the map of product surfaces it already
// powers. Serves the Mental Models Lab's live model room.
// ─────────────────────────────────────────────────────────────────────────────

import { buildModelSuite } from '@/lib/decision/suite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const asset = (url.searchParams.get('asset') ?? 'BTC').toUpperCase();
    const h = Math.max(4, Math.min(120, Number(url.searchParams.get('h')) || 24));
    const t0 = Date.now();
    const suite = await buildModelSuite(asset, { h });
    return Response.json(
      {
        ok: true,
        suite,
        meta: { asset, h, computeMs: Date.now() - t0, models: suite.models.length },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'model suite failed' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

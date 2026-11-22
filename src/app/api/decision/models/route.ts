// ─────────────────────────────────────────────────────────────────────────────
// /api/decision/models — the model-suite detail pass: every statistical model
// (GARCH, HMM, Kalman, OU, Merton, ML, Kelly, mixed MC) with its fitted
// parameters, chart-ready series, and the map of product surfaces it already
// powers. Serves the Mental Models Lab's live model room.
// ─────────────────────────────────────────────────────────────────────────────

import { buildModelSuite } from '@/lib/decision/suite';
import { ttlCache } from '@/lib/server/ttl-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// the model-suite detail pass fits the whole statistical machine on the merged
// bar history (~190 ms) and only changes when new bars land — the lab polls
// it, so identical queries are served from a 30 s single-flight cache
const suiteCache = ttlCache<Awaited<ReturnType<typeof buildModelSuite>>>('decision:models', 30_000);

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const asset = (url.searchParams.get('asset') ?? 'BTC').toUpperCase();
    const h = Math.max(4, Math.min(120, Number(url.searchParams.get('h')) || 24));
    const t0 = Date.now();
    const suite = await suiteCache.get(`${asset}:${h}`, async () => buildModelSuite(asset, { h }));
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

// GET /api/positions/intelligence — the full position × market fusion report:
// per-position metrics (greeks, prob ITM, P&L attribution, theta bleed,
// alignment), decision recommendations, triggered management rules, effective
// settings, and the portfolio rollup. Optional ?positionId= to scope to one.

import { buildPositionIntelligence } from '@/lib/positions/intelligence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const positionId = url.searchParams.get('positionId') ?? undefined;
    const report = await buildPositionIntelligence(positionId ? { positionId } : undefined);
    return Response.json(
      { ok: true, report },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[positions/intelligence] error:', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'intelligence unavailable' },
      { status: 500 },
    );
  }
}

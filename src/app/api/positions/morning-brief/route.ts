// GET|POST /api/positions/morning-brief — the daily desk brief from the
// decision engine: overnight market recap, portfolio rollup, per-position
// decision digest, watchlist, autopilot activity and the AI narrative.
//
// GET  → ?date=YYYY-MM-DD (default latest), ?history=1 for the index,
//        ?ensure=1 to generate today's if the hour has come (cheap when fresh).
// POST → regenerate now: { includeAi?: boolean } (default true).

import {
  briefHistory,
  buildMorningBrief,
  ensureMorningBrief,
  getBrief,
  latestBrief,
} from '@/lib/positions/morning-brief';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('history') === '1') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 30) || 30, 30);
      return Response.json(
        { ok: true, history: briefHistory(limit) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (url.searchParams.get('ensure') === '1') {
      const res = await ensureMorningBrief();
      return Response.json(
        { ok: true, ensured: res, brief: latestBrief() },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const date = url.searchParams.get('date');
    const brief = date ? getBrief(date) : latestBrief();
    return Response.json(
      { ok: true, brief, history: briefHistory(10) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[positions/morning-brief] error:', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'brief unavailable' },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { includeAi?: boolean };
    const brief = await buildMorningBrief({ includeAi: body.includeAi !== false });
    return Response.json(
      { ok: true, brief },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[positions/morning-brief] POST error:', err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'brief generation failed' },
      { status: 500 },
    );
  }
}

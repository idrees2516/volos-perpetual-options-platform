// GET/POST /api/scriptlab/runs — the strategy backtest track record.
// Every strategy run is auto-logged with the exact code + stats that produced
// it (append-only), so repeated runs answer "which parameter sets actually
// worked, when" across dev-server restarts.
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const limitRaw = Number(new URL(req.url).searchParams.get('limit') ?? '8');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.round(limitRaw))) : 8;
    const rows = await db.scriptRun.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return Response.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        scriptName: r.scriptName,
        symbol: r.symbol,
        tf: r.tf,
        bars: r.bars,
        metrics: JSON.parse(r.metricsJson) as Record<string, number>,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return Response.json({ ok: false, error: { message: e instanceof Error ? e.message : 'db error' } }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as {
      scriptName?: string;
      symbol?: string;
      tf?: string;
      bars?: number;
      metrics?: Record<string, number>;
      code?: string;
    };
    const scriptName = (b.scriptName ?? 'untitled').slice(0, 80);
    const symbol = (b.symbol ?? 'BTC').slice(0, 10);
    const tf = (b.tf ?? '1h').slice(0, 8);
    if (!b.metrics || typeof b.metrics.trades !== 'number') {
      return Response.json({ ok: false, error: { message: 'missing strategy metrics' } }, { status: 400 });
    }
    await db.scriptRun.create({
      data: {
        scriptName,
        symbol,
        tf,
        bars: Math.max(0, Math.round(b.bars ?? 0)),
        metricsJson: JSON.stringify(b.metrics),
        code: (b.code ?? '').slice(0, 40_000),
      },
    });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: { message: e instanceof Error ? e.message : 'log failed' } }, { status: 500 });
  }
}

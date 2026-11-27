// POST /api/scriptlab/loop — start / stop an AI Backtest Loop campaign.
// GET  /api/scriptlab/loop?id=… — poll the job's progress (attempts, scores,
// best variant with code + equity curves).
//
// The loop runs IN THE BACKGROUND inside the node process: each attempt
// (AI variant or deterministic input tuning) is scored by the walk-forward
// engine on the same bar ladder the chart uses, and the client polls this
// route every ~1.5 s to render progress — the video's "Running the Backtest
// Loop" experience.

import { startLoop, requestStop, getJob, type LoopStartOpts } from '@/lib/ai/backtest-loop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<LoopStartOpts> & { action?: 'start' | 'stop'; jobId?: string };

    if (body.action === 'stop') {
      const ok = body.jobId ? requestStop(body.jobId) : false;
      return Response.json({ ok, error: ok ? undefined : { message: 'job not found' } }, { status: ok ? 200 : 404 });
    }

    if (!body.code?.trim()) {
      return Response.json({ ok: false, error: { message: 'no script to improve — apply a strategy to the chart first' } }, { status: 400 });
    }
    // the chart's own bars pin the loop to exactly what the trader sees
    const bars = Array.isArray(body.bars)
      ? body.bars
          .filter((b: unknown) => b && typeof (b as { c?: unknown }).c === 'number')
          .slice(0, 1000)
          .map((b: { ts: number; o: number; h: number; l: number; c: number; v: number; tb: number }) => ({
            ts: Number(b.ts), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v), tb: Number(b.tb ?? 0),
          }))
      : undefined;
    const opts: LoopStartOpts = {
      code: body.code,
      symbol: body.symbol ?? 'BTC',
      tf: body.tf ?? '1h',
      limit: body.limit ?? 600,
      criteria: body.criteria ?? {
        minProfitFactor: 1.4,
        minWinRatePct: 55,
        maxDrawdownPct: 10,
        minTrades: 40,
      },
      trainPct: body.trainPct ?? 0.6,
      maxAttempts: body.maxAttempts ?? 8,
      goal: body.goal,
      bars,
    };
    const job = await startLoop(opts);
    return Response.json({ ok: true, job });
  } catch (e) {
    return Response.json(
      { ok: false, error: { message: e instanceof Error ? e.message : 'loop failed to start' } },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: { message: 'missing ?id=' } }, { status: 400 });
  const job = getJob(id);
  if (!job) return Response.json({ ok: false, error: { message: 'job not found (server restarted?)' } }, { status: 404 });
  return Response.json({ ok: true, job });
}

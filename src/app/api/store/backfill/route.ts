// GET  /api/store/backfill — worker status + coverage report
// POST /api/store/backfill — { action: 'start' | 'stop', …config overrides }
//
// Starts/stops the in-process historical backfill worker (Binance klines +
// funding + OI → SQLite). Idempotent: chunks upsert on natural keys, so
// restarts resume rather than duplicate. Depth is capped per venue API limits.

import { NextResponse } from 'next/server';
import {
  backfillCoverage,
  backfillStatus,
  startBackfill,
  stopBackfill,
  DEFAULT_BACKFILL_CONFIG,
  type BackfillConfig,
} from '@/lib/store/backfill';
import { isOfAsset, OF_ASSETS } from '@/lib/orderflow/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const coverage = await backfillCoverage();
  return NextResponse.json({
    status: backfillStatus(),
    coverage,
    defaults: {
      klineDepthDays: DEFAULT_BACKFILL_CONFIG.klineDepthDays,
      fundingDepthDays: DEFAULT_BACKFILL_CONFIG.fundingDepthDays,
      oiDepthDays: DEFAULT_BACKFILL_CONFIG.oiDepthDays,
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      assets?: string[];
      klineTfs?: number[];
      klineDepthDays?: Record<string, number>;
      fundingDepthDays?: number;
      oiDepthDays?: number;
      minCallGapMs?: number;
    };
    const action = body.action ?? 'start';
    if (action === 'stop') {
      stopBackfill();
      return NextResponse.json({ ok: true, status: backfillStatus() });
    }
    if (action !== 'start') {
      return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
    }
    const override: Partial<BackfillConfig> = {};
    if (Array.isArray(body.assets) && body.assets.length) {
      const assets = body.assets.map(String).filter((a) => isOfAsset(a));
      if (assets.length) override.assets = assets as BackfillConfig['assets'];
    }
    if (Array.isArray(body.klineTfs) && body.klineTfs.length) {
      const tfs = body.klineTfs.map(Number).filter((t) => Number.isFinite(t) && t >= 60 && t <= 3600);
      if (tfs.length) override.klineTfs = tfs;
    }
    if (body.klineDepthDays && typeof body.klineDepthDays === 'object') {
      const depth: Record<number, number> = {};
      for (const [tf, days] of Object.entries(body.klineDepthDays)) {
        const t = Number(tf);
        const d = Number(days);
        if (Number.isFinite(t) && Number.isFinite(d) && d > 0 && d <= 1095) depth[t] = d;
      }
      if (Object.keys(depth).length) override.klineDepthDays = depth;
    }
    if (typeof body.fundingDepthDays === 'number' && body.fundingDepthDays > 0) {
      override.fundingDepthDays = Math.min(body.fundingDepthDays, 1095);
    }
    if (typeof body.oiDepthDays === 'number' && body.oiDepthDays > 0) {
      override.oiDepthDays = Math.min(body.oiDepthDays, 29);
    }
    if (typeof body.minCallGapMs === 'number' && body.minCallGapMs >= 250) {
      override.minCallGapMs = body.minCallGapMs;
    }
    const status = await startBackfill(override);
    return NextResponse.json({ ok: true, status, assets: OF_ASSETS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'backfill control failed' },
      { status: 500 },
    );
  }
}

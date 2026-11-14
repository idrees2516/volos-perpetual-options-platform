// GET  /api/research/results — recent persisted research runs (compact rows)
//        ?limit=20&asset=BTC
//
// The research harness's track record: every run over the stored history,
// newest first, with top factors and composite IC per run.

import { NextResponse } from 'next/server';
import { recentResearchRuns } from '@/lib/research/harness';
import { isOfAsset } from '@/lib/orderflow/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
    const assetParam = url.searchParams.get('asset');
    const asset = assetParam && isOfAsset(assetParam) ? assetParam : undefined;
    const runs = await recentResearchRuns(limit, asset);
    return NextResponse.json({ runs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'research listing failed' },
      { status: 500 },
    );
  }
}

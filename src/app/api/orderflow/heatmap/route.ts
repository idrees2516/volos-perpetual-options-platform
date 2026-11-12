// GET /api/orderflow/heatmap?asset=BTC&minutes=15&rowTick=&stride=1 —
// resting-liquidity heatmap backfill (sparse 1-second columns of the depth
// ring, re-bucketable to coarser rows for zoomed-out views).

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { heatmapColumns, json, parseAsset } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const manager = getOrderFlowManager();
  manager.touch(asset);
  const state = manager.stateOf(asset);
  if (!state) return json({ asset, tick: 0, rowTick: 0, columns: [] });
  const minutes = Number(url.searchParams.get('minutes')) || 15;
  const rowTickRaw = Number(url.searchParams.get('rowTick'));
  const stride = Number(url.searchParams.get('stride')) || 1;
  const result = heatmapColumns(state.engine, {
    minutes,
    rowTick: Number.isFinite(rowTickRaw) && rowTickRaw > 0 ? rowTickRaw : undefined,
    stride,
  });
  return json({ asset, ...result, tsMs: Date.now() });
}

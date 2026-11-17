// GET /api/orderflow/heatmap?asset=BTC&minutes=15&rowTick=&stride=1&walls=1 —
// resting-liquidity heatmap backfill (sparse 1-second columns of the depth
// ring, re-bucketable to coarser rows for zoomed-out views). `walls=1` also
// runs the wall detector server-side over the same columns, so the wall
// list survives browser reloads mid-session.

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { heatmapColumns, json, parseAsset } from '@/lib/orderflow/wire';
import { detectWalls } from '@/lib/orderflow/walls';

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
  const withWalls = url.searchParams.get('walls') === '1';
  const walls = withWalls
    ? detectWalls(result.columns, result.rowTick, {}, result.columns.length ? result.columns[result.columns.length - 1].t : Date.now())
    : undefined;
  return json({ asset, ...result, ...(walls ? { walls } : {}), tsMs: Date.now() });
}

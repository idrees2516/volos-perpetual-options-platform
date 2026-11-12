// GET /api/orderflow/venues?asset=BTC — cross-venue comparison: last price vs
// median in bps, volume share, 1-minute delta, and which venue's price moves
// first (lead/lag from 250 ms buckets), plus feed connection statuses.

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { json, parseAsset } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const manager = getOrderFlowManager();
  manager.touch(asset);
  const state = manager.stateOf(asset);
  if (!state) return json({ asset, stats: [], leader: null, connections: [] });
  const summary = state.engine.venueSummary();
  return json({
    asset,
    ...summary,
    connections: [...state.connections.values()],
    tsMs: Date.now(),
  });
}

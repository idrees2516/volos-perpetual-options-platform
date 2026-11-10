// GET /api/orderflow/analytics?asset=BTC — flow studies: session CVD at 1 s
// resolution, 1-minute CVD & delta, volume z-score, annualized realized
// volatility, resting-liquidity depth stats (±10/25 bp + OBI) and the OBI
// history.

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
  if (!state) return json({ asset, analytics: null });
  return json({ asset, analytics: state.engine.analytics(), tsMs: Date.now() });
}

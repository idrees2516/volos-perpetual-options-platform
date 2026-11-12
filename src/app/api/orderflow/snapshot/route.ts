// GET /api/orderflow/snapshot?asset=BTC&tf=60000 — full current state of one
// asset: session stats, analytics, merged book, derivatives, venue summary,
// microstructure markers, footprint candles, liquidations.

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { json, parseAsset, parseTimeframe, wireCandles } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const tf = parseTimeframe(url.searchParams.get('tf'));
  const manager = getOrderFlowManager();
  manager.touch(asset);
  const snap = manager.snapshot(asset, { tf });
  const state = manager.stateOf(asset);
  return json({
    ...snap,
    candles: state ? wireCandles(state.engine, tf, 80) : [],
  });
}

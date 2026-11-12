// GET /api/orderflow/print?id=<tradeId> — full forensic detail of ONE order:
// size vs displayed size, aggressor, venue, surrounding prints ±5s, the mid
// move 1s/5s/15s after, resting size at that price/second, iceberg candidacy
// and a verdict. This is the "control on each and every order" drill-down.

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { json } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'missing ?id=' }, 400);
  const manager = getOrderFlowManager();
  for (const asset of ['BTC', 'ETH', 'SOL'] as const) manager.touch(asset, 30_000);
  const detail = manager.printDetail(id);
  if (!detail) return json({ error: `print ${id} not in the recent ring` }, 404);
  return json(detail);
}

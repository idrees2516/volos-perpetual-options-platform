// GET /api/orderflow/levels?asset=BTC — prior-session levels: previous UTC
// day's POC / VAH / VAL / VWAP, naked POCs from the last seven days, today's
// developing levels. Built from Binance 5m klines; cached ~10 minutes.

import { getLevels } from '@/lib/orderflow/levels';
import { json, parseAsset } from '@/lib/orderflow/wire';
import { getOrderFlowManager } from '@/lib/orderflow/manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  getOrderFlowManager().touch(asset, 60_000);
  try {
    const levels = await getLevels(asset);
    return json(levels);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'levels unavailable' }, 502);
  }
}

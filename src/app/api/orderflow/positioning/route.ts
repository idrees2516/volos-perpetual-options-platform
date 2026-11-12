// GET /api/orderflow/positioning?asset=BTC — exchange-native positioning data
// pulled straight from Binance's futures-data endpoints (verified live):
//   • top trader long/short account ratio  (5m series, 12h)
//   • global long/short account ratio       (5m series, 12h)
//   • taker buy/sell volume ratio           (5m series, 12h) — aggressor skew
//   • open interest history                 (5m series, 12h, base + notional)
// Cached 60 s per asset (shared with the copilot tool).

import { getPositioning, parsePositioningAsset } from '@/lib/orderflow/positioning';
import { json } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parsePositioningAsset(url.searchParams.get('asset'));
  try {
    const data = await getPositioning(asset);
    return json(data);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'positioning unavailable' }, 500);
  }
}

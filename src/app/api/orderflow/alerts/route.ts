// GET /api/orderflow/alerts?asset=BTC — the recent alert-event ring (block
// prints, liquidations, absorption, icebergs, VWAP/VA crosses, volume spikes,
// CVD divergence). Rule toggles ride the SSE URL (per browser).

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { json, parseAsset } from '@/lib/orderflow/wire';
import { DEFAULT_ALERT_SETTINGS } from '@/lib/orderflow/alerts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const manager = getOrderFlowManager();
  manager.touch(asset, 60_000);
  return json({
    asset,
    events: manager.alertRing(asset),
    defaults: DEFAULT_ALERT_SETTINGS,
    tsMs: Date.now(),
  });
}

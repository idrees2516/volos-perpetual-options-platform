// GET /api/orderflow/liquidations?asset=BTC&minutes=60 — forced closes from
// the venues that publish a public liquidation stream (Binance · Bybit · OKX ·
// Deribit): recent records, per-bucket long/short notional, 5m/1h/24h totals,
// largest single and the cascade state.

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { bucketLiquidations, liquidationState, summarizeLiquidations } from '@/lib/orderflow/derivatives';
import { json, parseAsset } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const assetParam = url.searchParams.get('asset');
  const manager = getOrderFlowManager();
  const now = Date.now();
  const minutes = Math.min(240, Math.max(5, Number(url.searchParams.get('minutes')) || 60));
  const bucketMs = minutes <= 15 ? 15_000 : minutes <= 60 ? 60_000 : 300_000;
  const bucketCount = 30;

  if (!assetParam) {
    // whole-market liquidations
    manager.touchAll(120_000);
    const recent = manager.liquidationQuery(undefined, now - minutes * 60_000, 150);
    const liqBuckets = bucketLiquidations(recent, bucketMs, bucketCount, now);
    return json({
      global: true,
      tsMs: now,
      recent,
      buckets: liqBuckets,
      state: liquidationState(liqBuckets),
      totals: summarizeLiquidations(recent, now - minutes * 60_000),
      windowMinutes: minutes,
    });
  }

  const asset = parseAsset(assetParam);
  manager.touch(asset);
  const recent = manager.liquidationQuery(asset, now - minutes * 60_000, 200);
  const liqBuckets = bucketLiquidations(recent, bucketMs, bucketCount, now);
  return json({
    asset,
    tsMs: now,
    recent,
    buckets: liqBuckets,
    state: liquidationState(liqBuckets),
    last5m: summarizeLiquidations(recent, now - 300_000),
    last1h: summarizeLiquidations(recent, now - 3_600_000),
    last24h: summarizeLiquidations(recent, now - 86_400_000),
    windowMinutes: minutes,
  });
}

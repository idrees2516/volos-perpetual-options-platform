// GET /api/orderflow/overview — whole-market order-flow dashboard data for
// every tracked asset (BTC · ETH · SOL × Binance/Bybit/OKX/Deribit).

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { json } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const manager = getOrderFlowManager();
  manager.touchAll(300_000); // overview watchers keep every venue warm 5 min
  return json(manager.overview());
}

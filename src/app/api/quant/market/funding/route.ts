// GET /api/quant/market/funding?window=7d|30d — the funding heat grid:
// rows = desk majors, columns = 8h funding events, cells = APR % (teal
// shorts-pay / rose longs-pay). Store-first with a staggered live sweep
// when the store is cold; per-asset drop-resilience; 5 min server cache.

import { fundingGrid, type FundingWindow } from '@/lib/quant/funding-grid';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const raw = sp.get('window');
    const window: FundingWindow = raw === '30d' ? '30d' : '7d';
    const data = await fundingGrid(window);
    return qOk(data, {
      computeMs: Date.now() - t0,
      note: 'funding APR heat grid — the "where is the leverage" map',
      sources: ['binance-fapi', 'sqlite-derivatives-mirror'],
    });
  });
}

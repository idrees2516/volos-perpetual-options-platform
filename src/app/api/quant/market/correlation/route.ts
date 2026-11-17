// GET /api/quant/market/correlation?window=7d|30d|90d — cross-asset matrix.
import { marketCorrelation } from '@/lib/quant/correlation';
import { guard, qOk, qErr, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const w = sp.get('window') ?? '30d';
    const window = (w === '7d' || w === '30d' || w === '90d' ? w : '30d') as '7d' | '30d' | '90d';
    if (!['7d', '30d', '90d'].includes(w)) return qErr(`unknown window '${w}' — use 7d|30d|90d`, 400);
    const result = await marketCorrelation(window);
    return qOk(result, { computeMs: Date.now() - t0, sources: [result.source === 'store' ? 'sqlite-kline-mirror' : 'binance-fapi'] });
  });
}

// GET /api/quant/market/breadth — whole-market treemap tiles + breadth stats.
import { marketBreadth } from '@/lib/quant/breadth';
import { guard, qOk } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return guard(async () => {
    const t0 = Date.now();
    const breadth = await marketBreadth();
    return qOk(breadth, { computeMs: Date.now() - t0, sources: ['binance-fapi'] });
  });
}

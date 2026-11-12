// GET /api/quant/vol?symbol=BTC — the vol-cycle brief: IV percentile/rank from
// our own history, realized-vol cone, DVOL index, IV-vs-DVOL-vs-RV triangle.
import { volRegime } from '@/lib/quant/volatility';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const data = await volRegime(symbol);
    return qOk(data, {
      symbol,
      computeMs: Date.now() - t0,
      sources: ['deribit', 'sqlite-history'],
      note: data.verdict,
    });
  });
}

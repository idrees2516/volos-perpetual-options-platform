// GET /api/quant/screener — the whole-market scan: every symbol side-by-side
// with cross-symbol z-scores, leaderboards and live regime scores.
import { marketScreener } from '@/lib/quant/screener';
import { guard, qOk } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return guard(async () => {
    const t0 = Date.now();
    const data = await marketScreener();
    return qOk(data, {
      computeMs: Date.now() - t0,
      sources: ['deribit', 'binance-fapi', 'bybit', 'okx', 'sqlite-history'],
      note: `${data.rows.length} markets · ${data.rankings.length} leaderboards`,
    });
  });
}

// GET /api/quant/history?symbol=BTC&metric=gex|oi|stress&days=7 — plus dealer-flow.
import { dealerFlow, ensureHistory, history } from '@/lib/quant/history';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const metric = (['gex', 'oi', 'stress', 'dealer-flow'].includes(sp.get('metric') ?? '') ? sp.get('metric') : 'gex') as 'gex' | 'oi' | 'stress' | 'dealer-flow';
    const days = Math.min(30, Math.max(1, Number(sp.get('days') ?? 7)));

    if (metric === 'dealer-flow') {
      const df = await dealerFlow(symbol, days);
      return qOk(df, { symbol, computeMs: Date.now() - t0, note: 'estimated dealer hedging flow from persisted snapshots' });
    }
    const h = await history(symbol, metric, days);
    return qOk(h, {
      symbol,
      computeMs: Date.now() - t0,
      note: 'our own snapshot store (SQLite, ~2min cadence) — history starts when the engine first ran',
    });
  });
}

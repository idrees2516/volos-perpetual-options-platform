// GET /api/quant/indicators?symbol=BTC&tf=5m|15m|30m|1h|4h|1d&limit=240 —
// OHLCV bars (store-first: native tf → 30m aggregation → live fallback) with
// the full curated indicator battery computed server-side.
import { indicatorSnapshot, TF_KEYS, type TfKey } from '@/lib/quant/indicator-service';
import { guard, qOk, qErr, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return qErr(`bad symbol '${symbol}'`, 400);
    const t = sp.get('tf') ?? '1h';
    if (!TF_KEYS.includes(t as TfKey)) return qErr(`unknown tf '${t}' — use ${TF_KEYS.join('|')}`, 400);
    const limitRaw = Number(sp.get('limit') ?? '240');
    const limit = Number.isFinite(limitRaw) ? Math.max(60, Math.min(500, Math.round(limitRaw))) : 240;

    const snap = await indicatorSnapshot(symbol, t as TfKey, limit);
    return qOk(snap, {
      computeMs: Date.now() - t0,
      sources: [snap.source === 'live' ? 'binance-fapi' : 'sqlite-kline-mirror'],
    });
  });
}

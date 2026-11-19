// GET /api/scriptlab/bars?symbol=BTC&tf=5m|15m|30m|1h|4h|1d&limit=1000 —
// OHLCV(+taker-buy) bars for the VolScript engine. Same store-first ladder
// as /api/quant/indicators (SQLite kline mirror → aggregation → live sweep),
// so scripts, backtests and the AI all compute on the same numbers.
import { loadBars, TF_KEYS, TF_SECONDS, type TfKey } from '@/lib/quant/indicator-service';
import { guard, qOk, qErr, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return qErr(`bad symbol '${symbol}'`, 400);
    const t = sp.get('tf') ?? '1h';
    if (!TF_KEYS.includes(t as TfKey)) return qErr(`unknown tf '${t}' — use ${TF_KEYS.join('|')}`, 400);
    const limitRaw = Number(sp.get('limit') ?? '500');
    const limit = Number.isFinite(limitRaw) ? Math.max(60, Math.min(1000, Math.round(limitRaw))) : 500;

    const { bars, source } = await loadBars(symbol, t as TfKey, limit);
    return qOk(
      {
        symbol,
        tf: t,
        tfSec: TF_SECONDS[t as TfKey],
        source,
        asOf: Date.now(),
        bars: bars.map((b) => ({
          ts: b.ts,
          o: b.o,
          h: b.h,
          l: b.l,
          c: b.c,
          v: b.v,
          tb: b.tb,
        })),
      },
      { sources: [source === 'live' ? 'binance-fapi' : 'sqlite-kline-mirror'] },
    );
  });
}

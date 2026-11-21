// GET /api/chartdesk/bars?symbol=BTC&tf=1h&from=&to=&countBack= — deep paged
// OHLCV bars for the OpenAlgo Charts widget (the Chart Desk). Two ladders:
//   ① SQLite kline mirror (windowed: tOpen between from/to — fast, offline)
//   ② live Binance USDT-perp sweep (endTime paging, up to 5000 bars back)
// Bars come out in the openalgo-charts `Bar` shape: UTC SECONDS + ohlcv.
import { db } from '@/lib/db';
import { candles, candlesPaged } from '@/lib/quant/markets';
import { TF_SECONDS, TF_KEYS, type TfKey } from '@/lib/quant/indicator-service';
import { guard, qOk, qErr, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OutBar {
  time: number; // UTC seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  /** taker-buy volume — the VolScript orderflow natives (delta/cvd) */
  tb?: number;
}

const g2 = globalThis as unknown as { __chartdeskBars?: Map<string, { bars: OutBar[]; source: string; ts: number }> };
const cache = g2.__chartdeskBars ?? new Map<string, { bars: OutBar[]; source: string; ts: number }>();
g2.__chartdeskBars = cache;
const TTL = 30_000;

export async function GET(req: Request) {
  return guard(async () => {
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return qErr(`bad symbol '${symbol}'`, 400);
    const t = sp.get('tf') ?? '1h';
    if (!TF_KEYS.includes(t as TfKey)) return qErr(`unknown tf '${t}' — use ${TF_KEYS.join('|')}`, 400);
    const tfSec = TF_SECONDS[t as TfKey];

    const fromSec = sp.get('from') ? Number(sp.get('from')) : undefined;
    const toSec = sp.get('to') ? Number(sp.get('to')) : undefined;
    const countBack = Number(sp.get('countBack') ?? '1000');
    const want = Number.isFinite(countBack) ? Math.max(60, Math.min(5000, Math.round(countBack))) : 1000;

    const toMs = toSec !== undefined && Number.isFinite(toSec) ? toSec * 1000 : undefined;
    const fromMs = fromSec !== undefined && Number.isFinite(fromSec) ? fromSec * 1000 : undefined;

    const key = `${symbol}:${t}:${fromSec ?? ''}:${toSec ?? ''}:${want}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < TTL) {
      return qOk(
        { symbol, tf: t, tfSec, source: hit.source, count: hit.bars.length, bars: hit.bars },
        { sources: [hit.source === 'live' ? 'binance-fapi' : 'sqlite-kline-mirror'] },
      );
    }

    // ① windowed store read (fast path — our own SQLite kline mirror)
    if (fromMs !== undefined) {
      const rows = await db.klineBar
        .findMany({
          where: {
            asset: symbol,
            tfSec,
            ...(toMs ? { tOpen: { gte: new Date(fromMs), lte: new Date(toMs) } } : { tOpen: { gte: new Date(fromMs) } }),
          },
          orderBy: { tOpen: 'desc' },
          take: want,
          select: { tOpen: true, open: true, high: true, low: true, close: true, volume: true, buyVolume: true },
        })
        .catch(() => [] as { tOpen: Date; open: number; high: number; low: number; close: number; volume: number; buyVolume: number }[]);
      const fresh = rows.slice().reverse();
      if (fresh.length >= Math.min(60, Math.floor(want * 0.5))) {
        // freshness guard: a window ending near NOW must not be served from a
        // stale mirror — fall through to the live sweep instead
        const lastSec = Math.floor(fresh[fresh.length - 1].tOpen.getTime() / 1000);
        const refSec = toSec ?? Math.floor(Date.now() / 1000);
        const stale = lastSec < refSec - tfSec * 3;
        if (!stale) {
          const bars: OutBar[] = fresh.map((r) => ({
            time: Math.floor(r.tOpen.getTime() / 1000),
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            volume: r.volume,
            tb: r.buyVolume,
          }));
          cache.set(key, { bars, source: 'store', ts: Date.now() });
          return qOk({ symbol, tf: t, tfSec, source: 'store', count: bars.length, bars }, { sources: ['sqlite-kline-mirror'] });
        }
      }
    }

    // ② live paged sweep (Binance → OKX fallback; deep history walks backwards)
    const live = toMs
      ? await candles(symbol, t, Math.min(1000, want), { endTime: toMs }).catch(() => [])
      : await candlesPaged(symbol, t, want, fromMs ?? undefined).catch(() => []);
    // accept small windows (the live-tail poll asks for 3) but demand real
    // coverage for big ones
    const minAccept = Math.min(30, Math.max(1, want));
    if (live.length >= minAccept) {
      let bars: OutBar[] = live.map((c) => ({
        time: Math.floor(c.ts / 1000),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
        tb: c.takerBuy,
      }));
      if (fromSec !== undefined) bars = bars.filter((b) => b.time >= Math.floor(fromSec));
      if (toSec !== undefined) bars = bars.filter((b) => b.time <= Math.floor(toSec));
      if (bars.length) cache.set(key, { bars, source: 'live', ts: Date.now() });
      return qOk({ symbol, tf: t, tfSec, source: 'live', count: bars.length, bars }, { sources: ['binance-fapi', 'okx-fallback'] });
    }
    return qErr(
      `no bars for ${symbol} @ ${t} (store cold, live sweep returned ${live.length})`,
      502,
    );
  });
}

// GET /api/quant/market?symbol=BTC — market bundle (price · OI · funding · 24h).
import { getPerpBundle } from '@/lib/quant/perps';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const bundle = await getPerpBundle(symbol);
    const candles = bundle.candles.slice(-288);
    const first = candles[0];
    const last = candles.at(-1);
    let high = -Infinity;
    let low = Infinity;
    let vol = 0;
    let takerBuy = 0;
    for (const c of candles) {
      high = Math.max(high, c.h);
      low = Math.min(low, c.l);
      vol += c.v;
      takerBuy += c.takerBuy;
    }
    return qOk(
      {
        symbol,
        asOf: bundle.asOf,
        spot: bundle.spot,
        perpMark: bundle.perpMark,
        change24hPct: first && last ? ((last.c - first.o) / first.o) * 100 : null,
        high24h: Number.isFinite(high) ? high : null,
        low24h: Number.isFinite(low) ? low : null,
        volumeBase24h: vol,
        takerBuyShare: vol > 0 ? takerBuy / vol : null,
        fundingRate: bundle.fundingRate,
        fundingApr: bundle.fundingApr,
        nextFundingTs: bundle.nextFundingTs,
        oi: bundle.oi,
        oiUsdTotal: bundle.oiUsdTotal,
        rv30Pct: bundle.rv30Pct,
        cvd24hUsd: bundle.cvd.at(-1)?.cvdUsd ?? null,
        candles: candles.slice(-96),
        liquidationTop: bundle.liquidationClusters.slice(0, 6),
      },
      { symbol, computeMs: Date.now() - t0, sources: ['binance-fapi', 'bybit', 'okx', 'deribit'] },
    );
  });
}

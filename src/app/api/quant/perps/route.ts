// GET /api/quant/perps?symbol=BTC — the perpetual-futures picture.
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
    return qOk(
      {
        ...bundle,
        cvd24hUsd: bundle.cvd.at(-1)?.cvdUsd ?? null,
        note: 'live Binance/Bybit/OKX/Deribit public data; CVD from taker-buy kline flow; liquidation clusters are model-estimated',
      },
      { symbol, computeMs: Date.now() - t0, sources: ['binance-fapi', 'bybit', 'okx', 'deribit'] },
    );
  });
}

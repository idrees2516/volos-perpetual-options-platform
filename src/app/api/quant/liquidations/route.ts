// GET /api/quant/liquidations?symbol=BTC&lev=10,25,50,100
import { getPerpBundle, liquidationHeatmap } from '@/lib/quant/perps';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const view = sp.get('view') ?? 'heatmap';
    const lev = sp.get('lev') ? sp.get('lev')!.split(',').map(Number).filter((n) => Number.isFinite(n)) : undefined;
    const bundle = await getPerpBundle(symbol);
    const hm = liquidationHeatmap(symbol, bundle, lev);
    const meta = { symbol, computeMs: Date.now() - t0, sources: ['binance-fapi'] };

    if (view === 'distribution') {
      return qOk(
        {
          symbol,
          asOf: hm.asOf,
          spot: hm.spot,
          clusters: hm.clusters,
          byLeverage: [10, 25, 50, 100].map((l) => {
            const c = bundle.liquidationClusters.filter((x) => x.leverage === l);
            return { leverage: l, count: c.length, longUsd: c.filter((x) => x.side === 'long').reduce((s, x) => s + x.notionalUsd, 0), shortUsd: c.filter((x) => x.side === 'short').reduce((s, x) => s + x.notionalUsd, 0) };
          }),
          model: hm.model,
        },
        meta,
      );
    }
    return qOk(hm, meta);
  });
}

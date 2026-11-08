// GET /api/quant/catalog?view=symbols|expiries|status|registry — discovery & meta.
import { serviceStatus, symbolCatalog } from '@/lib/quant/quant';
import { getChainSnapshot } from '@/lib/quant/engine';
import { ENDPOINTS, ENDPOINT_COUNT } from '@/lib/quant/registry';
import { tapeInfo } from '@/lib/quant/tape';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const view = sp.get('view') ?? 'symbols';

    switch (view) {
      case 'expiries': {
        const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
        const snap = await getChainSnapshot(symbol);
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            expiries: snap.expiries.map((e) => ({ expiry: e.expiry, dte: e.dte, type: e.type, isAnchor: e.isAnchor, oiUsd: e.oiUsd, atmIvPct: e.atmIvPct })),
          },
          { symbol, computeMs: Date.now() - t0 },
        );
      }
      case 'status':
        return qOk(await serviceStatus(), { computeMs: Date.now() - t0 });
      case 'registry':
        return qOk(
          {
            engine: 'volquant-native v1',
            endpoints: ENDPOINTS,
            count: ENDPOINT_COUNT,
            note: 'every endpoint computes from live venue APIs — Deribit (options chain/tape/futures), Binance/Bybit/OKX (perps), CFTC/SEC/Farside (macro)',
          },
          { computeMs: Date.now() - t0 },
        );
      default: {
        const cat = await symbolCatalog();
        return qOk({ ...cat, tape: tapeInfo(), endpointCount: ENDPOINT_COUNT }, { computeMs: Date.now() - t0 });
      }
    }
  });
}

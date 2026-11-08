// GET /api/quant/tape?symbol=BTC&view=prints|aggregates|flow&hours=24
import { ensureTape, flowByStrike, tapeAggregates, tapePrints, tapeInfo } from '@/lib/quant/tape';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const view = sp.get('view') ?? 'aggregates';
    const hours = Math.min(48, Math.max(1, Number(sp.get('hours') ?? 24)));
    const minPremiumUsd = Number(sp.get('minPremiumUsd') ?? 0) || 0;
    const side = sp.get('side') === 'buy' || sp.get('side') === 'sell' ? (sp.get('side') as 'buy' | 'sell') : undefined;
    const kind = sp.get('kind') === 'call' || sp.get('kind') === 'put' ? (sp.get('kind') as 'call' | 'put') : undefined;
    const limit = Math.min(1000, Number(sp.get('limit') ?? 200) || 200);
    const whaleUsd = Number(sp.get('whaleUsd') ?? 100_000) || 100_000;

    if (view === 'prints') {
      const prints = tapePrints(symbol, { hours, minPremiumUsd, side, kind, limit });
      return qOk({ symbol, asOf: Date.now(), hours, count: prints.length, prints }, { symbol, computeMs: Date.now() - t0, sources: ['deribit'] });
    }

    if (view === 'flow') {
      const strike = sp.get('strike') ? Number(sp.get('strike')) : undefined;
      const flow = flowByStrike(symbol, hours * 7, strike);
      return qOk({ symbol, asOf: Date.now(), windowHours: hours * 7, strike, byStrike: flow.slice(0, 40) }, { symbol, computeMs: Date.now() - t0, sources: ['deribit'] });
    }

    const agg = await tapeAggregates(symbol, hours, whaleUsd);
    const prints = tapePrints(symbol, { hours, minPremiumUsd, side, kind, limit: 60 });
    return qOk(
      { symbol, ...agg, recentPrints: prints, engineTape: tapeInfo().find((t) => t.symbol === symbol) ?? null, venue: 'deribit (only free keyless options tape)' },
      { symbol, computeMs: Date.now() - t0, sources: ['deribit'] },
    );
  });
}

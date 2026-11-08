// GET /api/quant/oi?symbol=BTC&view=by-expiry|pcr|history|premium|term
import { getChainSnapshot, hasOptions } from '@/lib/quant/engine';
import { ensureTape, tapeAggregates } from '@/lib/quant/tape';
import { history } from '@/lib/quant/history';
import { getPerpBundle } from '@/lib/quant/perps';
import { guard, qErr, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const view = sp.get('view') ?? 'by-expiry';

    if (view === 'term') {
      // futures term structure + perp basis
      const perp = await getPerpBundle(symbol);
      return qOk(
        {
          symbol,
          asOf: perp.asOf,
          spot: perp.spot,
          perpMark: perp.perpMark,
          perpBasisPct: perp.perpBasisPct,
          futures: perp.futuresTerm,
          note: 'annualized basis from live Deribit dated futures vs spot',
        },
        { symbol, computeMs: Date.now() - t0, sources: ['deribit'] },
      );
    }

    if (!hasOptions(symbol)) {
      return qErr(`no options market for ${symbol} — OI views need the Deribit chain (BTC/ETH)`, 400, { symbol });
    }

    const snap = await getChainSnapshot(symbol);
    const meta = { symbol, computeMs: Date.now() - t0, cacheAgeMs: Date.now() - snap.asOf, sources: ['deribit'] };

    if (view === 'pcr') {
      return qOk(
        {
          symbol,
          asOf: snap.asOf,
          spot: snap.spot,
          putCallRatioOi: snap.putCallRatioOi,
          byExpiry: snap.expiries.map((e) => ({ expiry: e.expiry, dte: e.dte, putCallRatioOi: e.putCallRatioOi, putCallRatioVol: e.putCallRatioVol, callOi: e.callOi, putOi: e.putOi })),
        },
        meta,
      );
    }

    if (view === 'history') {
      const h = await history(symbol, 'oi', Math.min(30, Number(sp.get('days') ?? 7)));
      return qOk(h, { symbol, computeMs: Date.now() - t0, note: 'options OI notional from our snapshot store (SQLite)' });
    }

    if (view === 'premium') {
      // premium tide: cumulative net taker premium across windows
      ensureTape(symbol);
      const windows = [6, 12, 24, 48];
      const tides = await Promise.all(
        windows.map(async (h) => {
          const a = await tapeAggregates(symbol, h);
          return { hours: h, premiumUsd: a.premiumUsd, netUsd: a.buyPremiumUsd - a.sellPremiumUsd, imbalance: a.imbalance, prints: a.prints };
        }),
      );
      return qOk(
        {
          symbol,
          asOf: Date.now(),
          tides,
          note: 'net taker premium (buy − sell) over trailing windows from the live tape',
        },
        meta,
      );
    }

    // by-expiry
    return qOk(
      {
        symbol,
        asOf: snap.asOf,
        spot: snap.spot,
        totalOiUsd: snap.totalOiUsd,
        byExpiry: snap.expiries.map((e) => ({
          expiry: e.expiry,
          dte: e.dte,
          type: e.type,
          callOi: e.callOi,
          putOi: e.putOi,
          oiContracts: e.oiContracts,
          oiUsd: e.oiUsd,
          callOiUsd: (e.oiUsd * e.callOi) / (e.oiContracts || 1),
          putOiUsd: (e.oiUsd * e.putOi) / (e.oiContracts || 1),
        })),
      },
      meta,
    );
  });
}

// GET /api/quant/gex?symbol=BTC&view=levels|strike|expiry|heatmap|ladder|multi
import { getChainSnapshot } from '@/lib/quant/engine';
import { multiSymbolLevels } from '@/lib/quant/quant';
import { guard, qErr, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const view = sp.get('view') ?? 'levels';
    const expiry = sp.get('expiry');

    if (view === 'multi') {
      const data = await multiSymbolLevels();
      return qOk(data, { computeMs: Date.now() - t0, note: 'multi-symbol GEX levels side by side' });
    }

    const snap = await getChainSnapshot(symbol);
    const meta = { symbol, computeMs: Date.now() - t0, cacheAgeMs: Date.now() - snap.asOf, sources: ['deribit'] };

    // expiry filter: '0dte' | 'front' | explicit token
    let rows = snap.rows;
    let label = 'all-expiry';
    if (expiry === '0dte' || expiry === 'front') {
      const front = snap.expiries[0]?.expiry;
      if (front) {
        rows = rows.filter((r) => r.expiry === front);
        label = `0dte (${front})`;
      }
    } else if (expiry) {
      rows = rows.filter((r) => r.expiry === expiry);
      label = expiry;
    }

    const strikes = rows === snap.rows ? snap.strikes : (() => {
      const m = new Map<number, { strike: number; callOi: number; putOi: number; callOiUsd: number; putOiUsd: number; callGex: number; putGex: number; netGex: number; callVolumeUsd: number; putVolumeUsd: number }>();
      for (const r of rows) {
        const a = m.get(r.strike) ?? { strike: r.strike, callOi: 0, putOi: 0, callOiUsd: 0, putOiUsd: 0, callGex: 0, putGex: 0, netGex: 0, callVolumeUsd: 0, putVolumeUsd: 0 };
        if (r.isCall) {
          a.callOi += r.oi; a.callOiUsd += r.oiUsd; a.callGex += r.gexUsd1pct; a.callVolumeUsd += r.volumeUsd;
        } else {
          a.putOi += r.oi; a.putOiUsd += r.oiUsd; a.putGex += r.gexUsd1pct; a.putVolumeUsd += r.volumeUsd;
        }
        a.netGex = a.callGex - a.putGex;
        m.set(r.strike, a);
      }
      return [...m.values()].sort((a, b) => a.strike - b.strike);
    })();

    switch (view) {
      case 'strike':
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            spot: snap.spot,
            window: label,
            unit: 'USD per 1% spot move (dealer-signed: calls +, puts −)',
            topStrikes: [...strikes].sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex)).slice(0, 20),
            allStrikes: strikes,
          },
          meta,
        );
      case 'expiry':
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            spot: snap.spot,
            byExpiry: snap.expiries.map((e) => ({
              expiry: e.expiry,
              dte: e.dte,
              type: e.type,
              netGexUsd1pct: e.netGexUsd1pct,
              oiUsd: e.oiUsd,
              atmIvPct: e.atmIvPct,
              maxPain: e.maxPain,
              putCallRatioOi: e.putCallRatioOi,
            })),
          },
          meta,
        );
      case 'heatmap':
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            spot: snap.spot,
            unit: 'USD per 1% move',
            strikes: snap.heatmap.strikes,
            expiries: snap.heatmap.expiries,
            netGex: snap.heatmap.netGex,
            oiUsd: snap.heatmap.oi,
            ivPct: snap.heatmap.iv,
          },
          meta,
        );
      case 'ladder': {
        // strike ladder around spot ±10% with cumulative net GEX
        const near = strikes.filter((s) => Math.abs(s.strike / snap.spot - 1) <= 0.1);
        let cum = 0;
        const ladder = near.map((s) => {
          cum += s.netGex;
          return { ...s, cumNetGex: cum };
        });
        return qOk({ symbol, asOf: snap.asOf, spot: snap.spot, ladder, unit: 'USD per 1% move' }, meta);
      }
      default:
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            spot: snap.spot,
            levels: snap.levels,
            levels0dte: snap.levels0dte,
            window: label,
            unit: 'USD per 1% spot move',
            note: 'native model: dealer short calls / long puts (customer-flow convention), live Deribit chain',
            topStrikes: snap.levels.topStrikes.slice(0, 10),
          },
          meta,
        );
    }
  });
}

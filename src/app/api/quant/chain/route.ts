// GET /api/quant/chain?symbol=BTC&view=chain|summary|opex|book&expiry=&dteMax=
import { getChainSnapshot } from '@/lib/quant/engine';
import { futureBookSummary } from '@/lib/quant/deribit';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const view = sp.get('view') ?? 'summary';
    const expiry = sp.get('expiry');
    const dteMax = sp.get('dteMax') ? Number(sp.get('dteMax')) : undefined;
    const moneyness = sp.get('moneyness') ? Number(sp.get('moneyness')) : undefined;

    const snap = await getChainSnapshot(symbol);
    const meta = { symbol, computeMs: Date.now() - t0, cacheAgeMs: Date.now() - snap.asOf, sources: ['deribit'] };

    if (view === 'summary') {
      return qOk(
        {
          symbol,
          asOf: snap.asOf,
          spot: snap.spot,
          expiries: snap.expiries.map((e) => ({
            expiry: e.expiry,
            dte: e.dte,
            type: e.type,
            isAnchor: e.isAnchor,
            forward: e.forward,
            atmIvPct: e.atmIvPct,
            straddleUsd: e.straddleUsd,
            rr25: e.rr25,
            fly25: e.fly25,
            oiContracts: e.oiContracts,
            oiUsd: e.oiUsd,
            callOi: e.callOi,
            putOi: e.putOi,
            putCallRatioOi: e.putCallRatioOi,
            putCallRatioVol: e.putCallRatioVol,
            netGexUsd1pct: e.netGexUsd1pct,
            maxPain: e.maxPain,
            callVolumeUsd: e.callVolumeUsd,
            putVolumeUsd: e.putVolumeUsd,
          })),
          totals: { oiUsd: snap.totalOiUsd, volumeUsd24h: snap.totalVolumeUsd24h, instruments: snap.rows.length, putCallRatioOi: snap.putCallRatioOi },
        },
        meta,
      );
    }

    if (view === 'opex') {
      const horizon = sp.get('horizonDays') ? Number(sp.get('horizonDays')) : 45;
      const events = snap.expiries
        .filter((e) => e.dte <= horizon)
        .map((e) => {
          const em = snap.expectedMoves.find((m) => m.expiry === e.expiry);
          return {
            expiry: e.expiry,
            dte: e.dte,
            type: e.type,
            isAnchor: e.isAnchor,
            oiUsd: e.oiUsd,
            oiContracts: e.oiContracts,
            atmIvPct: e.atmIvPct,
            maxPain: e.maxPain,
            netGexUsd1pct: e.netGexUsd1pct,
            expectedMove1sUsd: em?.oneSigmaUsd ?? e.expectedMove1sUsd,
            straddleUsd: e.straddleUsd,
          };
        });
      return qOk({ symbol, asOf: snap.asOf, spot: snap.spot, horizonDays: horizon, events }, meta);
    }

    if (view === 'book') {
      // cross-venue snapshot: Deribit option+futures marks vs perp venues
      const futures = await futureBookSummary(symbol);
      return qOk(
        {
          symbol,
          asOf: snap.asOf,
          spot: snap.spot,
          deribit: {
            optionsInstruments: snap.rows.length,
            frontExpiry: snap.expiries[0]?.expiry ?? null,
            perpMark: snap.perpMark,
            futures: futures.v.map((f) => ({ instrument: f.instrument_name, mark: f.mark_price, oiUsd: f.open_interest ?? 0 })),
          },
          note: 'options chain resolves on Deribit (the free keyless venue); perps aggregate Binance/Bybit/OKX/Deribit via /api/quant/perps',
        },
        meta,
      );
    }

    // view === 'chain': filtered rows for one expiry
    const exp = expiry ?? snap.expiries[0]?.expiry;
    let rows = snap.rows.filter((r) => r.expiry === exp);
    if (dteMax && !expiry) rows = snap.rows.filter((r) => r.dte <= dteMax);
    if (moneyness) {
      const fwd = rows[0]?.forward ?? snap.spot;
      rows = rows.filter((r) => Math.abs(r.strike / fwd - 1) <= moneyness);
    }
    // pair calls/puts per strike
    const byStrike = new Map<number, { call?: (typeof rows)[number]; put?: (typeof rows)[number] }>();
    for (const r of rows) {
      const e = byStrike.get(r.strike) ?? {};
      if (r.isCall) e.call = r;
      else e.put = r;
      byStrike.set(r.strike, e);
    }
    const chain = [...byStrike.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([strike, pair]) => ({
        strike,
        forward: pair.call?.forward ?? pair.put?.forward ?? snap.spot,
        call: pair.call
          ? { bid: pair.call.bid, ask: pair.call.ask, mid: pair.call.mid, mark: pair.call.mark, ivPct: pair.call.iv * 100, oi: pair.call.oi, oiUsd: pair.call.oiUsd, volumeUsd: pair.call.volumeUsd, delta: pair.call.delta, gamma: pair.call.gamma, vegaUsd: pair.call.vega, thetaUsd: pair.call.thetaUsd, spreadUsd: pair.call.spreadUsd }
          : null,
        put: pair.put
          ? { bid: pair.put.bid, ask: pair.put.ask, mid: pair.put.mid, mark: pair.put.mark, ivPct: pair.put.iv * 100, oi: pair.put.oi, oiUsd: pair.put.oiUsd, volumeUsd: pair.put.volumeUsd, delta: pair.put.delta, gamma: pair.put.gamma, vegaUsd: pair.put.vega, thetaUsd: pair.put.thetaUsd, spreadUsd: pair.put.spreadUsd }
          : null,
      }));
    return qOk(
      {
        symbol,
        asOf: snap.asOf,
        spot: snap.spot,
        expiry: exp,
        dte: rows[0]?.dte ?? null,
        rows: chain,
        note: 'premiums in underlying units (Deribit inverse options); greeks computed natively (Black-76 on venue forwards/IV)',
      },
      meta,
    );
  });
}

// GET /api/quant/iv?symbol=BTC&view=atm|term|skew|smile|cm|vrp|em|surface
import { getChainSnapshot } from '@/lib/quant/engine';
import { historicalVolatility } from '@/lib/quant/deribit';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const view = sp.get('view') ?? 'term';

    const snap = await getChainSnapshot(symbol);
    const meta = { symbol, computeMs: Date.now() - t0, cacheAgeMs: Date.now() - snap.asOf, sources: ['deribit'] };

    switch (view) {
      case 'atm': {
        const front = snap.expiries[0];
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            spot: snap.spot,
            front: front
              ? { expiry: front.expiry, dte: front.dte, atmIvPct: front.atmIvPct, straddleUsd: front.straddleUsd, rr25: front.rr25, fly25: front.fly25, smile: front.smile }
              : null,
            cm30Pct: snap.iv30vsRv30.iv30Pct,
          },
          meta,
        );
      }
      case 'skew':
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            spot: snap.spot,
            byExpiry: snap.expiries.map((e) => ({ expiry: e.expiry, dte: e.dte, atmIvPct: e.atmIvPct, rr25: e.rr25, fly25: e.fly25, rr10: e.rr10 })),
            note: 'rr25 = 25Δ put IV − 25Δ call IV (pct pts); fly25 = mid(25Δ wings) − ATM',
          },
          meta,
        );
      case 'smile': {
        const expiry = sp.get('expiry') ?? snap.expiries[0]?.expiry;
        const e = snap.expiries.find((x) => x.expiry === expiry) ?? snap.expiries[0];
        return qOk({ symbol, asOf: snap.asOf, spot: snap.spot, expiry: e?.expiry, dte: e?.dte, forward: e?.forward, smile: e?.smile ?? [] }, meta);
      }
      case 'cm': {
        // constant-maturity curve sampled at standard tenors (our own interp)
        const pts = snap.termStructure.filter((p) => Number.isFinite(p.atmIvPct));
        const tenors = [1, 7, 14, 30, 60, 90, 180].map((d) => ({
          dte: d,
          atmIvPct: pts.length ? interpIv(pts.map((p) => p.dte), pts.map((p) => p.atmIvPct), d) : NaN,
        }));
        return qOk({ symbol, asOf: snap.asOf, spot: snap.spot, tenors, raw: pts, note: 'linear-in-time interpolation of the live ATM term structure' }, meta);
      }
      case 'vrp': {
        const hv = await historicalVolatility(symbol).catch(() => ({ v: [] as [number, number][], ts: Date.now() }));
        const rv = hv.v.slice(-60);
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            iv30Pct: snap.iv30vsRv30.iv30Pct,
            rv30Pct: snap.iv30vsRv30.rv30Pct,
            vrpPct: snap.iv30vsRv30.vrpPct,
            realizedSeries: rv.map((p) => ({ ts: p[0], rvPct: p[1] })),
            note: `IV = our constant-maturity 30d ATM IV; RV = ${snap.iv30vsRv30.rvSource}`,
          },
          meta,
        );
      }
      case 'em':
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            spot: snap.spot,
            byExpiry: snap.expectedMoves,
            note: '1σ lognormal (F×σ√t) + ATM-straddle premium; calibrated = VRP-rescaled (rv/iv clamped 0.55–1.45)',
          },
          meta,
        );
      case 'surface':
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            spot: snap.spot,
            strikes: snap.heatmap.strikes,
            expiries: snap.heatmap.expiries,
            ivPct: snap.heatmap.iv,
            note: 'OTM-composite IV grid (calls ≥ forward, puts below), live venue marks',
          },
          meta,
        );
      default:
        return qOk(
          {
            symbol,
            asOf: snap.asOf,
            spot: snap.spot,
            termStructure: snap.termStructure,
            cm30Pct: snap.iv30vsRv30.iv30Pct,
            vrp: snap.iv30vsRv30,
          },
          meta,
        );
    }
  });
}

function interpIv(xs: number[], ys: number[], x: number): number {
  if (!xs.length) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0,
    hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] > x) hi = mid;
    else lo = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

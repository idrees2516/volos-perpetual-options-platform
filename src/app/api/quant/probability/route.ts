// GET /api/quant/probability?symbol=BTC&price=100000&expiry=front
import { getChainSnapshot } from '@/lib/quant/engine';
import { guard, qOk, searchParams } from '@/lib/quant/http';
import { interp } from '@/lib/quant/math';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const sp = searchParams(req);
    const symbol = (sp.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');
    const price = sp.get('price') ? Number(sp.get('price')) : null;
    const expiry = sp.get('expiry');

    const snap = await getChainSnapshot(symbol);
    const meta = { symbol, computeMs: Date.now() - t0, cacheAgeMs: Date.now() - snap.asOf, sources: ['deribit'] };

    const slices = expiry && expiry !== 'front' ? snap.probability.filter((s) => s.expiry === expiry) : snap.probability;
    const list = slices.length ? slices : snap.probability.slice(0, 1);

    const perExpiry = list.map((s) => {
      let pAbove: number | null = null;
      if (price && Number.isFinite(price)) {
        pAbove = 1 - interp(s.cdf, s.strikes, price);
      }
      return {
        expiry: s.expiry,
        dte: s.dte,
        strikes: s.strikes,
        density: s.density,
        cdf: s.cdf,
        mode: s.mode,
        p1: s.p1,
        p3: s.p3,
        expected: s.expected,
        mass: s.mass,
        ...(pAbove !== null ? { levelPrice: price, pAbove, pBelow: 1 - pAbove } : {}),
      };
    });

    // probability surface: density curves across expiries on a shared grid
    const allStrikes = [...new Set(snap.probability.flatMap((s) => s.strikes))].sort((a, b) => a - b);
    const surface = snap.probability.map((s) => ({
      expiry: s.expiry,
      dte: s.dte,
      density: allStrikes.map((k) => interp(s.strikes, s.density, k)),
    }));

    return qOk(
      {
        symbol,
        asOf: snap.asOf,
        spot: snap.spot,
        perExpiry,
        surface: { strikes: allStrikes, slices: surface },
        method: 'Breeden–Litzenberger second derivative of the live OTM composite curve (put-call parity for the lower wing), winsorized + normalized',
        note: 'risk-neutral density implied by real Deribit marks; mass < 1 flags clipped-arbitrage noise',
      },
      meta,
    );
  });
}

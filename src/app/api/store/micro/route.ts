// GET /api/store/micro?asset=BTC&limit=720&from=…&to=…
//
// Stored microstructure snapshots (30 s cadence): Kyle lambda, VPIN,
// Amihud, sign autocorr, microprice skew, OBI, realized vol / ATR /
// regime, VWAP distance, taker share, volume z, CVD 1m, depth, spread,
// absorption/iceberg counts — the granular history for regime studies.

import { db } from '@/lib/db';
import { isOfAsset } from '@/lib/orderflow/catalog';
import { json } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get('asset') ?? 'BTC').toUpperCase();
  const asset = isOfAsset(raw) ? raw : raw; // accept any stored asset key
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 720));
  const fromMs = Number(url.searchParams.get('from')) || undefined;
  const toMs = Number(url.searchParams.get('to')) || undefined;
  const sinceMin = Math.max(1, Math.min(60 * 24 * 30, Number(url.searchParams.get('sinceMin')) || 0));

  try {
    const where = {
      asset: asset as string,
      ...(fromMs || toMs || sinceMin
        ? {
            ts: {
              ...(fromMs ? { gte: new Date(fromMs) } : {}),
              ...(toMs ? { lte: new Date(toMs) } : {}),
              ...(sinceMin ? { gte: new Date(Date.now() - sinceMin * 60_000) } : {}),
            },
          }
        : {}),
    };
    const rows = await db.microSnapshot.findMany({ where, orderBy: { ts: 'desc' }, take: limit });
    return json({
      asset,
      count: rows.length,
      snapshots: rows
        .map((s) => ({
          t: s.ts.getTime(),
          price: s.price,
          kyle: s.kyleLambda ?? undefined,
          vpin: s.vpin ?? undefined,
          amihud: s.amihud ?? undefined,
          signAutocorr: s.signAutocorr ?? undefined,
          microSkew: s.microSkew ?? undefined,
          obi: s.obi ?? undefined,
          rv: s.rvAnnPct ?? undefined,
          atrPct: s.atrPct ?? undefined,
          regime: s.volRegime ?? undefined,
          vwapDist: s.vwapDist ?? undefined,
          takerShare: s.takerShare ?? undefined,
          volumeZ: s.volumeZ ?? undefined,
          cvd1m: s.cvd1m ?? undefined,
          depth10Bp: s.depth10Bp ?? undefined,
          spreadBps: s.spreadBps ?? undefined,
          abs15: s.absorption15m,
          ice15: s.iceberg15m,
        }))
        .reverse(),
      tsMs: Date.now(),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'store unavailable' }, 500);
  }
}

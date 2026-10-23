// GET /api/venues — live health + connectivity of every connected options
// exchange: Deribit, Bybit, OKX, Aevo, Paradex (tradeparadigm), Derive v3.
//
//   ?asset=BTC   which asset's chains to probe (default BTC)

import { getVenueStatuses, VENUE_META, type FeedAsset } from '@/lib/ai/exchange-feeds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASSETS = ['BTC', 'ETH', 'SOL'];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const assetRaw = (url.searchParams.get('asset') ?? 'BTC').toUpperCase();
  const asset = (ASSETS.includes(assetRaw) ? assetRaw : 'BTC') as FeedAsset;

  try {
    const statuses = await getVenueStatuses(asset);
    return Response.json(
      {
        asset,
        tsMs: Date.now(),
        venues: statuses.map((s) => ({
          id: s.id,
          name: s.name,
          site: VENUE_META[s.id].site,
          settlement: VENUE_META[s.id].settlement,
          status: s.status,
          latencyMs: s.latencyMs,
          instruments: s.instruments,
          spot: s.spot ? +s.spot.toFixed(2) : null,
          atmIv: s.atmIv ? +s.atmIv.toFixed(1) : null,
          note: s.note,
        })),
        liveCount: statuses.filter((s) => s.status === 'live').length,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'venues unavailable' },
      { status: 502 },
    );
  }
}

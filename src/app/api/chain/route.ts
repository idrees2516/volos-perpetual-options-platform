// GET /api/chain — REAL live options chain from the connected exchanges.
//
//   ?asset=BTC          BTC | ETH | SOL (default BTC)
//   &venue=deribit      deribit | bybit | okx | aevo | paradex | derive | auto (default auto)
//   &expiry=25OCT26     optional venue-native expiry label
//
// Returns the normalized chain (RustChain-compatible rows + bid/ask), the
// venue expiry calendar and which venue actually served the data (with
// automatic fallback when a venue is down).

import {
  getVenueChain,
  getVenueExpiries,
  VENUE_IDS,
  VENUE_META,
  type FeedAsset,
  type VenueId,
} from '@/lib/ai/exchange-feeds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASSETS = ['BTC', 'ETH', 'SOL'];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const assetRaw = (url.searchParams.get('asset') ?? 'BTC').toUpperCase();
  const asset = (ASSETS.includes(assetRaw) ? assetRaw : 'BTC') as FeedAsset;
  const venueRaw = (url.searchParams.get('venue') ?? 'auto').toLowerCase();
  const expiry = url.searchParams.get('expiry') ?? undefined;

  const preferred: VenueId =
    venueRaw !== 'auto' && (VENUE_IDS as string[]).includes(venueRaw) ? (venueRaw as VenueId) : 'deribit';

  try {
    // try preferred venue, then fall back through the rest
    const order: VenueId[] = [preferred, ...VENUE_IDS.filter((v) => v !== preferred)];
    let chain = null;
    let usedVenue: VenueId = preferred;
    let error: string | undefined;
    for (const v of order) {
      const res = await getVenueChain(v, asset, expiry ?? undefined);
      if (res.chain) {
        chain = res.chain;
        usedVenue = v;
        break;
      }
      if (v === preferred) error = res.error;
    }

    if (!chain) {
      return Response.json({ error: error ?? 'no venue reachable' }, { status: 502 });
    }

    const { expiries } = await getVenueExpiries(chain.venue, asset);

    return Response.json(
      {
        asset,
        venue: usedVenue,
        venueName: VENUE_META[usedVenue].name,
        requestedVenue: preferred,
        quoteSource: chain.quoteSource,
        expiry: chain.expiry,
        expiryMs: chain.expiryMs,
        daysOut: +chain.daysOut.toFixed(2),
        spot: +chain.spot.toFixed(2),
        forward: +chain.forward.toFixed(2),
        atmIv: +chain.atmIv.toFixed(1),
        instrumentCount: chain.instrumentCount,
        fetchMs: chain.fetchMs,
        tsMs: chain.tsMs,
        expiries: expiries.slice(0, 12).map((e) => ({
          label: e.label,
          ms: e.ms,
          daysOut: +e.daysOut.toFixed(1),
          instruments: e.instruments,
        })),
        rows: chain.rows.map((r) => ({
          strike: r.strike,
          callIv: +r.callIv.toFixed(1),
          callPrice: +r.callPrice.toFixed(2),
          callDelta: +r.callDelta.toFixed(3),
          callOi: Math.round(r.callOi),
          callVolume: Math.round(r.callVolume),
          callBid: r.callBid != null ? +r.callBid.toFixed(2) : null,
          callAsk: r.callAsk != null ? +r.callAsk.toFixed(2) : null,
          putIv: +r.putIv.toFixed(1),
          putPrice: +r.putPrice.toFixed(2),
          putDelta: +r.putDelta.toFixed(3),
          putOi: Math.round(r.putOi),
          putVolume: Math.round(r.putVolume),
          putBid: r.putBid != null ? +r.putBid.toFixed(2) : null,
          putAsk: r.putAsk != null ? +r.putAsk.toFixed(2) : null,
          isAtm: r.isAtm,
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'chain unavailable' },
      { status: 502 },
    );
  }
}

// GET /api/orderflow/tape?asset=BTC&venue=&minNotional=&flags=&limit=&since= —
// time & sales: newest-first prints with ratio/flags/bookSize for the
// order-level drill-down.

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { json, parseAsset } from '@/lib/orderflow/wire';
import { OF_VENUES } from '@/lib/orderflow/catalog';
import type { OfVenueId } from '@/lib/orderflow/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const manager = getOrderFlowManager();
  manager.touch(asset);
  const venueRaw = url.searchParams.get('venue');
  const venue = venueRaw && (OF_VENUES as string[]).includes(venueRaw) ? (venueRaw as OfVenueId) : undefined;
  const minNotionalRaw = Number(url.searchParams.get('minNotional'));
  const flags = url.searchParams.get('flags')?.split(',').filter(Boolean);
  const prints = manager.tapeQuery(asset, {
    venue,
    minNotional: Number.isFinite(minNotionalRaw) && minNotionalRaw > 0 ? minNotionalRaw : undefined,
    flags: flags?.length ? flags : undefined,
    limit: Number(url.searchParams.get('limit')) || 120,
    since: Number(url.searchParams.get('since')) || undefined,
  });
  return json({ asset, tsMs: Date.now(), prints });
}

// GET /api/orderflow/export?asset=BTC&what=trades|liquidations|oi|candles —
// CSV download (UTC ISO + epoch ms, oldest first), matching the reference
// terminal's export semantics.

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { parseAsset } from '@/lib/orderflow/wire';
import { wireCandles } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function iso(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', 'Z');
}

function csv(rows: (string | number)[][]): string {
  return rows.map((r) => r.join(',')).join('\n');
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const what = url.searchParams.get('what') ?? 'trades';
  const manager = getOrderFlowManager();
  manager.touch(asset, 60_000);
  const state = manager.stateOf(asset);
  let body = '';
  let filename = `orderflow-${asset.toLowerCase()}-${what}.csv`;

  if (what === 'liquidations') {
    const liqs = manager.liquidationQuery(asset, undefined, 5000).slice().reverse();
    body = csv([
      ['timestamp_iso', 'timestamp_ms', 'venue', 'side', 'price', 'quantity_base', 'notional_usd'],
      ...liqs.map((l) => [iso(l.timestamp), l.timestamp, l.venue, l.side, l.price, l.quantity.toFixed(6), l.quoteVolume.toFixed(2)]),
    ]);
  } else if (what === 'oi') {
    const series = state ? state.engine.oiSeries() : [];
    body = csv([
      ['timestamp_iso', 'timestamp_ms', 'open_interest_base', 'price'],
      ...series.map((p) => [iso(p.time), p.time, p.openInterest.toFixed(3), p.price.toFixed(2)]),
    ]);
  } else if (what === 'candles') {
    const candles = state ? wireCandles(state.engine, 60_000, 240) : [];
    body = csv([
      ['open_time_iso', 'open_time_ms', 'open', 'high', 'low', 'close', 'volume', 'delta', 'cumulative_delta'],
      ...candles.map((c) => [iso(c.openTime), c.openTime, c.open, c.high, c.low, c.close, c.volume.toFixed(6), c.delta.toFixed(6), c.cumulativeDelta.toFixed(6)]),
    ]);
  } else {
    const prints = manager.tapeQuery(asset, { limit: 20_000 }).slice().reverse();
    filename = `orderflow-${asset.toLowerCase()}-trades.csv`;
    body = csv([
      ['timestamp_iso', 'timestamp_ms', 'venue', 'side', 'price', 'quantity_base', 'notional_usd', 'ratio_vs_avg', 'displayed_size_at_level'],
      ...prints.map((p) => [
        iso(p.timestamp),
        p.timestamp,
        p.venue,
        p.side,
        p.price,
        p.quantity.toFixed(6),
        p.quoteVolume.toFixed(2),
        p.ratio !== undefined ? p.ratio.toFixed(2) : '',
        p.bookSize !== undefined ? p.bookSize.toFixed(6) : '',
      ]),
    ]);
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

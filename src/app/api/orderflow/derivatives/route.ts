// GET /api/orderflow/derivatives?asset=BTC — open interest (summed, 1 s
// samples + history), funding per venue (8h-restated, annualized, countdown),
// mark/index basis in bps, and the price × OI positioning regime over
// 1m / 5m / 15m windows.

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { aggregateDerivatives, annualizeFunding, fundingRate8h, oiWindowChange } from '@/lib/orderflow/derivatives';
import { json, parseAsset } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const manager = getOrderFlowManager();
  manager.touch(asset);
  const state = manager.stateOf(asset);
  if (!state) return json({ asset, aggregate: null, perVenue: [], oiSeries: [], windows: {} });
  const engine = state.engine;
  const snapshots = engine.allDerivatives();
  const aggregate = aggregateDerivatives(snapshots, engine.midPrice() || undefined);
  return json({
    asset,
    aggregate,
    perVenue: snapshots.map((s) => ({
      venue: s.venue,
      openInterest: s.openInterest,
      fundingRate: s.fundingRate,
      fundingRate8h: fundingRate8h(s),
      fundingAnnualizedPct:
        s.fundingRate !== undefined ? annualizeFunding(s.fundingRate, s.fundingIntervalHours ?? 8) * 100 : undefined,
      nextFundingTime: s.nextFundingTime,
      markPrice: s.markPrice,
      indexPrice: s.indexPrice,
      basisBps: s.markPrice && s.indexPrice ? ((s.markPrice - s.indexPrice) / s.indexPrice) * 10_000 : undefined,
    })),
    oiSeries: engine.oiSeries().slice(-600),
    windows: {
      w1m: oiWindowChange(engine.oiSeries(), 60_000),
      w5m: oiWindowChange(engine.oiSeries(), 300_000),
      w15m: oiWindowChange(engine.oiSeries(), 900_000),
    },
    tsMs: Date.now(),
  });
}

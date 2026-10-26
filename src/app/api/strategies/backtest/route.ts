// POST /api/strategies/backtest — run a strategy backtest on REAL exchange
// history (Bybit spot klines + live Deribit IV calibration) and return the
// full performance record: stats, equity curve, sample trades, assumptions.
//
// Body:
//   {
//     asset:        'BTC' | 'ETH' | 'SOL',
//     strategyName: string,
//     windowDays?:  90 | 180 | 365 | 730 (default 365, clamped 90–730),
//     legs: [{ kind: 'call'|'put', side: 'buy'|'sell', qty, strike, expiryDays }]
//            — strike is a MULTIPLIER of the cycle's entry spot (1.00 = ATM).
//   }

import { runBacktest, type BacktestLegSpec } from '@/lib/ai/backtest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Body {
  asset?: string;
  strategyName?: string;
  windowDays?: number;
  legs?: Array<{
    kind?: string;
    side?: string;
    qty?: number;
    strike?: number;
    expiryDays?: number;
  }>;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const asset = String(body.asset ?? 'BTC').toUpperCase();
  if (!['BTC', 'ETH', 'SOL'].includes(asset)) {
    return Response.json({ error: `asset must be BTC, ETH or SOL (got ${asset})` }, { status: 400 });
  }

  const legs: BacktestLegSpec[] = (body.legs ?? [])
    .filter(
      (l) =>
        (l.kind === 'call' || l.kind === 'put') &&
        (l.side === 'buy' || l.side === 'sell') &&
        Number.isFinite(l.qty) && (l.qty ?? 0) > 0 &&
        Number.isFinite(l.strike) && (l.strike ?? 0) > 0,
    )
    .map((l) => ({
      kind: l.kind as 'call' | 'put',
      side: l.side as 'buy' | 'sell',
      qty: Number(l.qty),
      strike: Number(l.strike),
      expiryDays: Math.min(Math.max(Number(l.expiryDays ?? 30), 1), 365),
    }));

  if (legs.length === 0) {
    return Response.json({ error: 'no valid option legs — need at least one call/put leg with qty and strike' }, { status: 400 });
  }

  const windowDays = Math.min(Math.max(Number(body.windowDays ?? 365) || 365, 90), 730);

  try {
    const result = await runBacktest({
      asset,
      legs,
      windowDays,
      strategyName: body.strategyName ?? 'strategy',
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'backtest failed' },
      { status: 502 },
    );
  }
}

// GET /api/store/flowbars?asset=BTC&tfSec=60&limit=720&from=…&to=…
//
// Stored 1-minute multi-venue flow bars (the engine's own truth, persisted
// by the manager clock) — OHLCV + delta + CVD + OI, for later analytics,
// backtests and export.

import { db } from '@/lib/db';
import { isOfAsset } from '@/lib/orderflow/catalog';
import type { OfAsset } from '@/lib/orderflow/types';
import { json } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get('asset') ?? 'BTC').toUpperCase();
  const asset: OfAsset | string = isOfAsset(raw) ? raw : raw; // accept any stored asset key
  const tfSec = Math.max(1, Math.min(3600, Number(url.searchParams.get('tfSec')) || 60));
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 720));
  const fromMs = Number(url.searchParams.get('from')) || undefined;
  const toMs = Number(url.searchParams.get('to')) || undefined;

  try {
    const where = {
      asset: asset as string,
      tfSec,
      ...(fromMs || toMs
        ? {
            tOpen: {
              ...(fromMs ? { gte: new Date(fromMs) } : {}),
              ...(toMs ? { lte: new Date(toMs) } : {}),
            },
          }
        : {}),
    };
    const bars = await db.flowBar.findMany({ where, orderBy: { tOpen: 'desc' }, take: limit });
    return json({
      asset,
      tfSec,
      count: bars.length,
      bars: bars
        .map((b) => ({
          t: b.tOpen.getTime(),
          o: b.open,
          h: b.high,
          l: b.low,
          c: b.close,
          v: b.volume,
          delta: b.delta,
          cvd: b.cvd,
          oi: b.oi ?? undefined,
        }))
        .reverse(),
      tsMs: Date.now(),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'store unavailable' }, 500);
  }
}

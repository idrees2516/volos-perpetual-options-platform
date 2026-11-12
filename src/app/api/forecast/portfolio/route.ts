// GET /api/forecast/portfolio — forward-looking hedged portfolio risk.
//
//   ?h=30&tf=60000&levels=80,95&notional=100000
//   ?weights=BTC:0.4,ETH:0.3,SOL:0.2,XRP:0.1   (default: equal across majors)
//   ?assets=BTC,ETH,SOL                        (default: all 8 majors)
//
// Conformal bands (conformal_error, the honest intervals) → forward σ per
// asset → portfolio forward VaR/ES with the cross-asset correlation matrix
// from stored/backfilled closes; per-asset β vs BTC, hedge notional and
// residual VaR; BTC ±1σ/±2σ scenario grid, hedged vs unhedged.

import { buildPortfolioRisk } from '@/lib/forecast/portfolio';
import { isOfAsset } from '@/lib/orderflow/catalog';
import type { OfAsset } from '@/lib/orderflow/types';
import { json } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const h = Math.max(1, Math.min(120, Number(url.searchParams.get('h')) || 30));
  const tfSec = Math.max(60, Math.min(1800, Number(url.searchParams.get('tf')) || 60));
  const levels = (url.searchParams.get('levels') ?? '80,95')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((v) => Number.isFinite(v) && v > 50 && v < 100);
  const notionalUsd = Math.max(1000, Math.min(100_000_000, Number(url.searchParams.get('notional')) || 100_000));
  const nWindows = Math.max(2, Math.min(64, Number(url.searchParams.get('nWindows')) || 10));

  const assetsRaw = (url.searchParams.get('assets') ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && isOfAsset(s)) as OfAsset[];
  const assets = assetsRaw.length ? assetsRaw : undefined;

  const weights: Partial<Record<OfAsset, number>> = {};
  for (const part of (url.searchParams.get('weights') ?? '').split(',')) {
    const [rawA, rawW] = part.split(':');
    const a = (rawA ?? '').trim().toUpperCase();
    const w = Number(rawW);
    if (isOfAsset(a) && Number.isFinite(w) && w > 0) weights[a] = w;
  }

  try {
    const payload = await buildPortfolioRisk({ h, tfSec, levels, weights, notionalUsd, assets, nWindows });
    return json(payload);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'portfolio risk failed' }, 500);
  }
}

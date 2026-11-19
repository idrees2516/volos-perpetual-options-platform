// ─────────────────────────────────────────────────────────────────────────────
// /api/decision — THE unified decision surface: every data family in the
// product (model room, signal battery, vol cycle, forecast, order flow,
// breadth, funding, paper book, strategy catalog) fused into one report —
// stance, confidence, pillars, model verdicts, strategy fit, risk sizing,
// and the action battery.
// ─────────────────────────────────────────────────────────────────────────────

import { buildDecisionHub } from '@/lib/decision/hub';
import type { HubAsset } from '@/lib/decision/hub';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ASSETS: HubAsset[] = ['BTC', 'ETH', 'SOL'];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const raw = (url.searchParams.get('asset') ?? 'BTC').toUpperCase();
    const asset = (ASSETS.includes(raw as HubAsset) ? raw : 'BTC') as HubAsset;
    const t0 = Date.now();
    const report = await buildDecisionHub(asset);
    return Response.json(
      {
        ok: true,
        report,
        meta: {
          asset,
          computeMs: Date.now() - t0,
          horizonMin: report.horizonMin,
          stance: report.stance,
          stanceLabel: report.stanceLabel,
          note: `stance ${report.stance} (${report.stanceLabel}) · confidence ${report.confidence}% · ${report.actions.length} actions`,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'decision hub failed' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

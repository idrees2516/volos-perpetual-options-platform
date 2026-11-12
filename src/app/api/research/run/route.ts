// GET  /api/research/run — the factor catalog (ids, families, labels)
// POST /api/research/run — execute a signal-research run over the STORED
//        history and persist it. Body (all optional):
//
//          { asset: 'BTC', tfSec: 300, horizonBars: 12,
//            lookbackDays: 120, factorIds: ['delta_z', ...], persist: true }
//
// Factors consume stored klines (aggressor delta), carried funding/OI and —
// once live sessions accumulate — stored microstructure snapshots. Results
// carry daily-block Spearman IC, quintile spreads (bps), top-quintile hit
// rate and an IC-directed composite. The run is written to ResearchRun so
// the Copilot/UI can quote it later without re-running.

import { NextResponse } from 'next/server';
import { RESEARCH_FACTORS, runResearch } from '@/lib/research/harness';
import { isOfAsset, OF_ASSETS } from '@/lib/orderflow/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({
    factors: RESEARCH_FACTORS.map((f) => ({ id: f.id, label: f.label, family: f.family, needsMicro: f.needsMicro === true })),
    defaults: { tfSec: 300, horizonBars: 12, lookbackDays: 120 },
    assets: OF_ASSETS,
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      asset?: string;
      tfSec?: number;
      horizonBars?: number;
      lookbackDays?: number;
      factorIds?: string[];
      persist?: boolean;
    };
    const report = await runResearch({
      asset: isOfAsset(String(body.asset ?? 'BTC')) ? body.asset : 'BTC',
      tfSec: body.tfSec,
      horizonBars: body.horizonBars,
      lookbackDays: body.lookbackDays,
      factorIds: Array.isArray(body.factorIds) ? body.factorIds.map(String) : undefined,
      persist: body.persist !== false,
    });
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'research run failed' },
      { status: 500 },
    );
  }
}

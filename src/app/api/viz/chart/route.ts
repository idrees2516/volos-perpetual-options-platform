// ─────────────────────────────────────────────────────────────────────────────
// POST /api/viz/chart — compute ANY chart: a set of catalog series, each with
// its own transform, rendered as one chart kind. One compute path serves the
// Chart Studio UI and the copilot's chart tool, with band derivation
// (rolling ±σ) so the band kind works on ANY series.
// ─────────────────────────────────────────────────────────────────────────────

import { loadVizSeries } from '@/lib/viz/series';
import { applyTransform, rollingEnvelope } from '@/lib/viz/transforms';
import type { ChartKind, VizTransform, VizSeries } from '@/lib/viz/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ChartRequest {
  asset?: string;
  tf?: number;
  backfill?: number;
  kind?: ChartKind;
  series?: { id: string; transform?: VizTransform }[];
}

const PALETTE = ['#2dd4bf', '#f59e0b', '#a78bfa', '#38bdf8', '#fb7185', '#4ade80', '#f472b6', '#e4eaf2'];

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChartRequest;
    const asset = (['BTC', 'ETH', 'SOL'] as const).includes((body.asset ?? 'BTC') as 'BTC') ? (body.asset ?? 'BTC') : 'BTC';
    const tfRaw = Number(body.tf ?? 1_800_000);
    const tf = [60_000, 300_000, 900_000, 1_800_000].includes(tfRaw) ? tfRaw : 1_800_000;
    const backfill = Math.max(60, Math.min(1500, Number(body.backfill ?? 720)));
    const kind: ChartKind = body.kind ?? 'line';
    const wanted = (body.series ?? []).slice(0, 8);
    if (wanted.length === 0) {
      return Response.json({ ok: false, error: 'no series requested' }, { status: 400 });
    }

    const t0 = Date.now();
    const outSeries: (VizSeries & { color: string; transform: VizTransform })[] = [];
    const matrixSeries: VizSeries[] = [];

    for (let i = 0; i < wanted.length; i++) {
      const w = wanted[i];
      const s = await loadVizSeries(w.id, asset as 'BTC', tf, backfill);
      if (s.kind === 'matrix') {
        matrixSeries.push(s);
        continue;
      }
      let points = applyTransform(s.points ?? [], w.transform ?? 'none');
      if (kind === 'band' && !points.some((p) => Number.isFinite(p.lo))) {
        points = rollingEnvelope(points, 24, 1.5);
      }
      outSeries.push({
        ...s,
        points,
        label: `${s.label}${w.transform && w.transform !== 'none' ? ` · ${w.transform}` : ''}`,
        color: PALETTE[i % PALETTE.length],
        transform: w.transform ?? 'none',
      });
    }

    if (outSeries.length === 0 && matrixSeries.length > 0) {
      return Response.json(
        { ok: true, kind: 'matrix', matrix: matrixSeries[0], meta: { asset, tf, computeMs: Date.now() - t0, note: 'matrix family — render as heatmap' } },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (outSeries.length === 0) {
      return Response.json({ ok: false, error: 'no renderable points series in the request' }, { status: 400 });
    }

    return Response.json(
      {
        ok: true,
        kind,
        series: outSeries,
        meta: {
          asset,
          tf,
          backfill,
          computeMs: Date.now() - t0,
          points: outSeries[0].points?.length ?? 0,
          note: kind === 'candles' && !outSeries[0].points?.some((p) => Number.isFinite(p.c)) ? 'candle fields missing — rendering as line' : undefined,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : 'chart compute failed' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

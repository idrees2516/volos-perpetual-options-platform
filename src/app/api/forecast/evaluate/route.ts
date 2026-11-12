// GET /api/forecast/evaluate — cross-validation + the docs' evaluation table.
//
//   ?asset=BTC&tf=60000&target=close&h=30&levels=80,95&cvWindows=2
//   ?models=... (same resolution as /api/forecast)
//   ?includeCv=1   also return the raw CV rows (per cutoff/step predictions
//                  with actuals — enough to draw the docs' backtest plot)
//
// Conformal models recalibrate at every cutoff on only the windows before it,
// so the evaluation never sees the data it is scored on (reference guarantee).
// Metrics per alias: coverage_level{L}, mean width, MASE, scaled CRPS (from
// the interval bounds), mean pinball per level, MAE/RMSE/sMAPE, clamping
// detection for native fixed-knot models, and the coverage-over-time series
// (per cutoff) that drives the Evaluate tab's drift chart.

import { buildForecastPanel } from '@/lib/forecast/panel';
import { DEFAULT_FC_SPECS, Forecaster, resolveSpecs, specsFromModelIds } from '@/lib/forecast/forecaster';
import { FC_TARGETS, type FcTargetId } from '@/lib/forecast/types';
import { json, parseAsset, parseTimeframe } from '@/lib/orderflow/wire';
import { recordForecastEvalRun } from '@/lib/store/writer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TARGET_IDS = new Set<string>(FC_TARGETS.map((t) => t.id as string));

// evaluation runs are heavier — one per config per 10 minutes is plenty
const storeDedupe = new Map<string, number>();
const STORE_DEDUPE_MS = 600_000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const tf = parseTimeframe(url.searchParams.get('tf'));
  const targetRaw = url.searchParams.get('target') ?? 'close';
  const target = (TARGET_IDS.has(targetRaw) ? targetRaw : 'close') as FcTargetId;
  const h = Math.max(1, Math.min(120, Number(url.searchParams.get('h')) || 30));
  const levels = (url.searchParams.get('levels') ?? '80,95')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((v) => Number.isFinite(v) && v > 50 && v < 100);
  const useLevels = levels.length ? [...new Set(levels)].sort((a, b) => a - b) : [80, 95];
  const cvWindows = Math.max(1, Math.min(16, Number(url.searchParams.get('cvWindows')) || 2));
  const nWindows = Math.max(2, Math.min(64, Number(url.searchParams.get('nWindows')) || 10));
  const backfill = Math.max(60, Math.min(1500, Number(url.searchParams.get('backfill')) || 720));
  const includeCv = url.searchParams.get('includeCv') === '1';

  try {
    const panel = await buildForecastPanel(asset, tf, target, { backfill });
    const specs = (specsFromModelIds(url.searchParams.get('modelIds')) ?? DEFAULT_FC_SPECS).map((s) => ({
      ...s,
      nWindows: s.nWindows ?? nWindows,
    }));
    const forecaster = new Forecaster(resolveSpecs(url.searchParams.get('models'), specs));
    const cvRows = forecaster.crossValidate(panel, {
      h,
      levels: useLevels,
      nWindows,
      cvWindows,
    });
    const evalRows = forecaster.evaluate(cvRows, panel, useLevels);
    // coverage-over-time per alias (drift chart)
    const coverageTimeline = evalRows.map((r) => ({
      alias: r.alias,
      points: forecaster.coverageTimeline(r.alias),
    }));

    // per-step coverage/width for the horizon-error chart
    const byAliasStep = new Map<string, Map<number, { inN: number; n: number; widthSum: number }>>();
    for (const r of cvRows) {
      if (r.y === null || !Number.isFinite(r.y)) continue;
      let steps = byAliasStep.get(r.alias);
      if (!steps) byAliasStep.set(r.alias, (steps = new Map()));
      const widest = useLevels[useLevels.length - 1];
      const li = r.levels.find((l) => l.level === widest);
      let cell = steps.get(r.step);
      if (!cell) steps.set(r.step, (cell = { inN: 0, n: 0, widthSum: 0 }));
      cell.n++;
      if (li && Number.isFinite(li.lo) && Number.isFinite(li.hi)) {
        if (r.y >= li.lo && r.y <= li.hi) cell.inN++;
        cell.widthSum += li.hi - li.lo;
      }
    }
    const perStep = [...byAliasStep.entries()].map(([alias, steps]) => ({
      alias,
      steps: [...steps.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([step, c]) => ({ step, coverage: c.n > 0 ? c.inN / c.n : NaN, width: c.n > 0 ? c.widthSum / c.n : NaN })),
    }));

    // ── storage write-through (deduped per config, one run/10 min) ────────
    const key = `${asset}:${tf}:${target}:${h}:${useLevels.join(',')}:${cvWindows}`;
    if (Date.now() - (storeDedupe.get(key) ?? 0) > STORE_DEDUPE_MS) {
      storeDedupe.set(key, Date.now());
      void recordForecastEvalRun(
        { asset, tfSec: tf / 1000, target, h, levels: useLevels, cvWindows },
        evalRows,
        perStep,
      );
    }

    return json({
      asset,
      tf,
      target,
      h,
      levels: useLevels,
      cvWindows,
      nWindows,
      builtAt: Date.now(),
      panel: {
        seriesCount: panel.series.length,
        points: panel.series[0]?.points.length ?? 0,
        provenance: panel.provenance,
        seasonLength: panel.seasonLength,
      },
      evalRows,
      coverageTimeline,
      perStep,
      cvRows: includeCv ? cvRows : undefined,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'evaluate failed' }, 500);
  }
}

// GET /api/forecast — conformal forecast on flow-bar targets.
//
//   ?asset=BTC        BTC | ETH | SOL
//   ?tf=60000         1m | 5m | 15m | 30m flow-bar buckets
//   ?target=close     close | volume | delta | cvd | imbalance | trades |
//                     oi | venueVolumeShare | venueDelta
//   ?h=30             horizon steps
//   ?levels=80,95     interval levels (percent)
//   ?models=...        alias CSV (default: FlowX/Ensemble ×3 + AR/Theta) or
//                     model-id CSV via ?modelIds=flowx,ar
//   ?nWindows=10       conformal calibration windows
//   ?backfill=720      kline bars of exchange history
//
// Returns the panel (series + provenance) plus every model's rows, calibration
// diagnostics, and the expected-move readout for price targets.

import { buildForecastPanel } from '@/lib/forecast/panel';
import { DEFAULT_FC_SPECS, Forecaster, resolveSpecs, specsFromModelIds } from '@/lib/forecast/forecaster';
import { FC_TARGETS, type FcTargetId } from '@/lib/forecast/types';
import { json, parseAsset, parseTimeframe } from '@/lib/orderflow/wire';
import { recordForecastRun } from '@/lib/store/writer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TARGET_IDS = new Set<string>(FC_TARGETS.map((t) => t.id as string));

// write-through throttle: identical configs persist at most one run/minute
const storeDedupe = new Map<string, number>();
const STORE_DEDUPE_MS = 60_000;

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
  const nWindows = Math.max(2, Math.min(64, Number(url.searchParams.get('nWindows')) || 10));
  const backfill = Math.max(60, Math.min(1500, Number(url.searchParams.get('backfill')) || 720));

  try {
    const panel = await buildForecastPanel(asset, tf, target, { backfill });
    const specs = (specsFromModelIds(url.searchParams.get('modelIds')) ?? DEFAULT_FC_SPECS).map((s) => ({
      ...s,
      nWindows: s.nWindows ?? nWindows,
    }));
    const forecaster = new Forecaster(resolveSpecs(url.searchParams.get('models'), specs));
    const out = forecaster.forecast(panel, { h, levels: useLevels, nWindows });

    const targetMeta = FC_TARGETS.find((t) => t.id === target)!;
    const models = out.primary.map((m) => {
      const last = m.rows[m.rows.length - 1];
      const widest = useLevels[useLevels.length - 1];
      const li = last?.levels.find((l) => l.level === widest);
      const point = last?.point ?? NaN;
      const isPrice = target === 'close';
      return {
        alias: m.alias,
        model: m.model,
        modelLabel: m.modelLabel,
        intervals: m.intervals,
        note: m.note,
        rows: m.rows,
        calibration: m.calibration
          ? {
              nWindows: m.calibration.nWindows,
              stepSize: m.calibration.stepSize,
              required: m.calibration.required,
              available: m.calibration.available,
              ok: m.calibration.ok,
              errorByStep: m.calibration.errorByStep,
            }
          : null,
        expectedMove:
          isPrice && li && Number.isFinite(li.lo) && Number.isFinite(li.hi)
            ? {
                level: widest,
                lo: li.lo,
                hi: li.hi,
                point,
                width: li.hi - li.lo,
                widthPct: Number.isFinite(point) && point > 0 ? ((li.hi - li.lo) / point) * 100 : NaN,
                horizonMin: (h * tf) / 60_000,
              }
            : null,
      };
    });

    // ── storage write-through (deduped per config, one run/minute) ──────────
    const cutoffPoint = panel.series[0]?.points.at(-1);
    if (cutoffPoint) {
      storeRun(
        `${asset}:${tf}:${target}:${h}:${useLevels.join(',')}`,
        {
          asset,
          tfSec: tf / 1000,
          target,
          h,
          levels: useLevels,
          nWindows,
          cutoffMs: cutoffPoint.ds,
          anchor: cutoffPoint.y,
          provenance: `engine:${panel.provenance.engineBars}/kline:${panel.provenance.klinesBars}${
            panel.provenance.klineError ? '/err' : ''
          }`,
        },
        out.primary.map((m) => {
          const last = m.rows[m.rows.length - 1];
          const bounds: Record<string, [number, number]> = {};
          for (const l of last?.levels ?? []) {
            if (Number.isFinite(l.lo) && Number.isFinite(l.hi)) bounds[String(l.level)] = [l.lo, l.hi];
          }
          return {
            alias: m.alias,
            method: m.intervals,
            point: m.rows.map((r) => r.point),
            bounds: Object.keys(bounds).length ? bounds : undefined,
          };
        }),
      );
    }

    return json({
      asset,
      tf,
      target,
      targetMeta,
      h,
      levels: useLevels,
      nWindows,
      builtAt: Date.now(),
      panel: {
        series: panel.series.map((s) => ({
          uniqueId: s.uniqueId,
          label: s.label,
          liveTailFrom: s.liveTailFrom ?? null,
          points: s.points.slice(-Math.max(240, h * 4)),
        })),
        provenance: panel.provenance,
        seasonLength: panel.seasonLength,
        bounds: panel.bounds,
      },
      models,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'forecast failed' }, 500);
  }
}

/** Storage write-through (deduped) — "store now, analyze later". */
function storeRun(
  key: string,
  params: Parameters<typeof recordForecastRun>[0],
  models: Parameters<typeof recordForecastRun>[1],
): void {
  const now = Date.now();
  const last = storeDedupe.get(key) ?? 0;
  if (now - last < STORE_DEDUPE_MS) return;
  storeDedupe.set(key, now);
  void recordForecastRun(params, models);
}

// GET /api/forecast/stream — SSE: live conformal forecast updates.
//
//   ?asset=BTC&tf=60000&target=close&h=30&levels=80,95&models=...&nWindows=10
//
//   init    the full forecast payload (same shape as /api/forecast) so the
//           panel renders immediately
//   tick    every max(tf/6, 5s) seconds: rebuilt panel (cached) + re-run
//           forecast — the latest point/bounds per model, the fresh actual
//           vs the previous forecast's band (walk-forward hit/miss), and a
//           rolling coverage readout against the widest level
//   ping    keepalive every 15 s
//
// The forecast recalibrates as new flow bars arrive — calibration windows
// slide with the panel, exactly like re-running ff.forecast() on each tick.

import { buildForecastPanel } from '@/lib/forecast/panel';
import { DEFAULT_FC_SPECS, Forecaster, resolveSpecs, specsFromModelIds } from '@/lib/forecast/forecaster';
import { FC_TARGETS, type FcTargetId } from '@/lib/forecast/types';
import { parseAsset, parseTimeframe } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TARGET_IDS = new Set<string>(FC_TARGETS.map((t) => t.id as string));

interface CoverageAcc {
  inN: number;
  n: number;
}

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
  const backfill = 720;

  const specs = (specsFromModelIds(url.searchParams.get('modelIds')) ?? DEFAULT_FC_SPECS).map((s) => ({
    ...s,
    nWindows: s.nWindows ?? nWindows,
  }));
  const forecaster = new Forecaster(resolveSpecs(url.searchParams.get('models'), specs));
  const encoder = new TextEncoder();
  let closed = false;

  /** last emitted widest-level band per alias: for walk-forward hit/miss */
  const lastStep1 = new Map<string, { lo: number; hi: number }>();
  const coverageAcc = new Map<string, CoverageAcc>();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const full = await buildForecastPanel(asset, tf, target, { backfill })
        .then((panel) => {
          if (!panel.series.length) return { error: 'no series yet' };
          const out = forecaster.forecast(panel, { h, levels: useLevels, nWindows });
          for (const m of out.primary) {
            const last = m.rows[m.rows.length - 1];
            const li = last?.levels.find((l) => l.level === useLevels[useLevels.length - 1]);
            if (last && li) lastStep1.set(m.alias, { lo: li.lo, hi: li.hi });
          }
          return {
            asset,
            tf,
            target,
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
            models: out.primary.map((m) => ({
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
            })),
          };
        })
        .catch((e) => ({ error: e instanceof Error ? e.message : 'forecast failed' }));
      send('init', full);

      const tickMs = Math.max(5_000, Math.min(30_000, Math.floor(tf / 6)));
      const tick = setInterval(() => {
        if (closed) return;
        buildForecastPanel(asset, tf, target, { backfill })
          .then((panel) => {
            if (closed || !panel.series.length) return;
            const out = forecaster.forecast(panel, { h, levels: useLevels, nWindows });
            const lastPoint = panel.series[0].points[panel.series[0].points.length - 1];
            const widest = useLevels[useLevels.length - 1];
            const models = out.primary.map((m) => {
              const last = m.rows[m.rows.length - 1];
              const li = last?.levels.find((l) => l.level === widest);
              const prev = lastStep1.get(m.alias);
              // walk-forward check: did the fresh actual fall in the PREVIOUS band?
              if (prev && lastPoint && Number.isFinite(lastPoint.y) && Number.isFinite(prev.lo) && Number.isFinite(prev.hi)) {
                const acc = coverageAcc.get(m.alias) ?? { inN: 0, n: 0 };
                acc.n++;
                if (lastPoint.y >= prev.lo && lastPoint.y <= prev.hi) acc.inN++;
                coverageAcc.set(m.alias, acc);
              }
              if (last && li) lastStep1.set(m.alias, { lo: li.lo, hi: li.hi });
              return {
                alias: m.alias,
                intervals: m.intervals,
                note: m.note,
                rows: m.rows,
                expectedMove:
                  target === 'close' && li && Number.isFinite(li.lo)
                    ? { level: widest, lo: li.lo, hi: li.hi, point: last?.point ?? NaN, width: li.hi - li.lo }
                    : null,
              };
            });
            const coverage = [...coverageAcc.entries()].map(([alias, c]) => ({
              alias,
              level: widest,
              covered: c.inN,
              total: c.n,
              ratio: c.n > 0 ? c.inN / c.n : NaN,
            }));
            send('tick', { models, coverage, actual: lastPoint ?? null, builtAt: Date.now(), levels: useLevels });
          })
          .catch(() => undefined);
      }, tickMs);
      (tick as unknown as { unref?: () => void }).unref?.();

      const keepalive = setInterval(() => send('ping', { t: Date.now() }), 15_000);
      (keepalive as unknown as { unref?: () => void }).unref?.();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(tick);
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

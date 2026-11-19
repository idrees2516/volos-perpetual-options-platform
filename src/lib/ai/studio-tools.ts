// ─────────────────────────────────────────────────────────────────────────────
// studio-tools — the AI COPILOT'S chart/model toolbelt.
//
// The Chart & Model Studio's compute plane handed to the copilot:
//   • studio_catalog — every plottable series + runnable model + chart kind
//                      + transform in the product (what can even be drawn).
//   • studio_chart   — compute ANY chart: series ids + transforms + kind →
//                      the plotted data (values + bands), server-side.
//   • studio_model   — run ANY model on ANY series with parameters →
//                      verdicts + outputs (chartable series).
// ─────────────────────────────────────────────────────────────────────────────

import { tool, jsonSchema } from 'ai';
import { SERIES_SPECS, SERIES_MAP, loadVizSeries } from '@/lib/viz/series';
import { MODEL_SPECS, MODEL_MAP, runModel } from '@/lib/viz/modelrunner';
import { applyTransform, rollingEnvelope } from '@/lib/viz/transforms';
import { CHART_KINDS, TRANSFORMS } from '@/lib/viz/types';

const ASSETS = ['BTC', 'ETH', 'SOL'] as const;
const TFS = [60_000, 300_000, 900_000, 1_800_000] as const;

export const studioSystemPrompt = () =>
  `CHART & MODEL STUDIO tools — you can draw ANY chart and run ANY model on ANY data in the product. studio_catalog lists every plottable series (price OHLCV, indicators, flow, forecast fan, model outputs, surfaces) and every runnable model (GARCH, OU/Kalman, HMM, ML P(up), Merton jumps, mixed-process Monte Carlo, Kelly/CVaR, conformal, Black-Scholes, Heston, SABR). studio_chart computes any combination of series (each with a transform: log/diff/pct/zscore/minmax/ema/cum) as any chart kind (line/area/band/bars/histogram/scatter/step/candles). studio_model runs any model with parameters on any series — e.g. GARCH on RSI, HMM on funding, conformal bands on volume. Use these for "chart X", "plot RSI vs volume", "what would GARCH say about OI", "run Heston with higher vol-of-vol", "show the correlation matrix".`;

export const studioTools = {
  studio_catalog: tool({
    description:
      "The Chart & Model Studio catalog: EVERY plottable series in the product (price OHLCV, indicators, flow, forecast, live model outputs, matrix surfaces — with the product surfaces that consume each), EVERY runnable model (statistical + pricing + Monte Carlo with their parameters), every chart kind and every transform. Use FIRST when the user wants a chart or model you are unsure exists, or to answer 'what can I plot'.",
    parameters: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: async () => ({
      series: SERIES_SPECS.map((s) => ({ id: s.id, group: s.group, label: s.label, unit: s.unit, desc: s.desc, tags: s.tags, consumedBy: s.consumedBy })),
      models: MODEL_SPECS.map((m) => ({ id: m.id, label: m.label, family: m.family, desc: m.desc, usesSeries: m.usesSeries, params: m.params, consumedBy: m.consumedBy })),
      chartKinds: CHART_KINDS.map((k) => ({ id: k.id, desc: k.desc })),
      transforms: TRANSFORMS.map((t) => ({ id: t.id, desc: t.desc })),
      tool: 'studio_catalog',
    }),
  }),

  studio_chart: tool({
    description:
      'Compute ANY chart from the product data: 1–6 series ids (from studio_catalog), each with an optional transform (none|log|diff|pct|zscore|minmax|ema|cum), rendered as one chart kind (line|area|band|bars|histogram|scatter|step|candles). Returns each series as (t, v, lo, hi) points ready to plot. Matrix series (ivSurface, gexSession, fundingGrid, correlation) return their grid. Use for "chart/plot/draw X" questions.',
    parameters: jsonSchema<{ series: string[]; kind?: string; transforms?: string[]; asset?: string; tf?: number }>({
      type: 'object',
      properties: {
        series: { type: 'array', items: { type: 'string' }, description: '1–6 series ids from studio_catalog (e.g. ["close", "rsi14"])' },
        kind: { type: 'string', enum: CHART_KINDS.map((k) => k.id) as string[], description: 'chart kind (default line)' },
        transforms: { type: 'array', items: { type: 'string', enum: TRANSFORMS.map((t) => t.id) }, description: 'per-series transforms, same order as series (optional)' },
        asset: { type: 'string', enum: [...ASSETS], description: 'BTC | ETH | SOL (default BTC)' },
        tf: { type: 'number', enum: [...TFS], description: 'bar timeframe ms: 60000 1m | 300000 5m | 900000 15m | 1800000 30m (default 30m)' },
      },
      required: ['series'],
    }),
    execute: async ({ series, kind, transforms, asset, tf }) => {
      const a = (ASSETS.includes(asset as 'BTC') ? asset : 'BTC') as 'BTC';
      const t = (TFS.includes(tf as never) ? tf : 1_800_000) as number;
      const k = CHART_KINDS.find((x) => x.id === kind)?.id ?? 'line';
      const ids = (series ?? []).slice(0, 6).filter((id) => SERIES_MAP.has(id));
      if (ids.length === 0) return { error: 'no valid series ids — call studio_catalog first', tool: 'studio_chart' };
      const out = await Promise.all(
        ids.map(async (id, i) => {
          const s = await loadVizSeries(id, a, t, 720);
          if (s.kind === 'matrix') {
            return { id, label: s.label, kind: 'matrix', rows: s.matrix!.rows, cols: s.matrix!.cols, values: s.matrix!.values, note: s.note };
          }
          const tr = transforms?.[i] ?? 'none';
          let points = applyTransform(s.points ?? [], tr as never);
          if (k === 'band' && !points.some((p) => Number.isFinite(p.lo))) points = rollingEnvelope(points, 24, 1.5);
          const thin = points.length > 120 ? points.filter((_, idx) => idx % Math.ceil(points.length / 120) === 0) : points;
          return {
            id,
            label: `${s.label}${tr !== 'none' ? ` · ${tr}` : ''}`,
            kind: 'points',
            unit: s.unit,
            n: points.length,
            points: thin.map((p) => ({ t: p.t, v: Number(p.v.toFixed(4)), lo: p.lo != null ? Number(p.lo.toFixed(4)) : undefined, hi: p.hi != null ? Number(p.hi.toFixed(4)) : undefined })),
            last: points.at(-1) ? { v: Number((points.at(-1)!.v).toFixed(4)), t: points.at(-1)!.t } : null,
            provenance: s.provenance,
          };
        }),
      );
      return { chartKind: k, asset: a, tf: t, series: out, tool: 'studio_chart' };
    },
  }),

  studio_model: tool({
    description:
      'Run ANY model from the room on ANY series with ANY parameters: GARCH(1,1), OU+Kalman, HMM regimes, ML P(up), Merton jumps, mixed-process Monte Carlo, Kelly/CVaR, conformal forecast, Black-Scholes, Heston, SABR. Stats models fit on the chosen series\u2019 returns — any catalog series works as input (GARCH on RSI, HMM on funding, conformal on volume…). Returns verdicts + chartable output series. Use for "what does GARCH say about X", "run HMM with 4 states on RSI", "show me the SABR smile with higher vol-of-vol".',
    parameters: jsonSchema<{ model: string; series?: string; asset?: string; tf?: number; params?: Record<string, number | string> }>({
      type: 'object',
      properties: {
        model: { type: 'string', enum: MODEL_SPECS.map((m) => m.id) as string[], description: 'the model to run' },
        series: { type: 'string', description: 'input series id from studio_catalog for stats models (default close)' },
        asset: { type: 'string', enum: [...ASSETS], description: 'BTC | ETH | SOL (default BTC)' },
        tf: { type: 'number', enum: [...TFS], description: 'bar timeframe ms (default 1800000 = 30m)' },
        params: { type: 'object', description: 'model parameters by name (see studio_catalog); e.g. {h: 48, k: 4}, {sigma: 0.6, K: 105}' },
      },
      required: ['model'],
    }),
    execute: async ({ model, series, asset, tf, params }) => {
      if (!MODEL_MAP.has(model)) return { error: `unknown model ${model}`, tool: 'studio_model' };
      const a = (ASSETS.includes(asset as 'BTC') ? asset : 'BTC') as 'BTC';
      const t = (TFS.includes(tf as never) ? tf : 1_800_000) as number;
      try {
        const result = await runModel({ model, asset: a, tf: t, seriesId: series ?? 'close', params: params ?? {} });
        return {
          model: result.label,
          input: result.input,
          verdicts: result.verdicts,
          outputs: result.outputs.map((o) => ({
            id: o.id,
            label: o.label,
            n: o.points?.length ?? 0,
            note: o.note,
            points: (o.points ?? []).slice(-160).map((p) => ({ t: p.t, v: Number(p.v.toFixed(4)), lo: p.lo != null ? Number(p.lo.toFixed(4)) : undefined, hi: p.hi != null ? Number(p.hi.toFixed(4)) : undefined })),
          })),
          note: result.note,
          tool: 'studio_model',
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'model run failed', tool: 'studio_model' };
      }
    },
  }),
};

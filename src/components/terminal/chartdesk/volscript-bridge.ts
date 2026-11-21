// ─────────────────────────────────────────────────────────────────────────────
// Chart Desk — the VolScript bridge. Turns ANY VolScript/Pine-v5 script (AI-
// written, hand-written or copied from TradingView) into a full openalgo-charts
// IndicatorDescriptor: inputs become the study's settings form, plots become
// chart series (lines/steplines/areas/histograms/candles), plotshape/plotchar/
// plotarrow become signal markers, hline becomes levels, fill() shades bands,
// bgcolor() shades per-bar backgrounds, barcolor() recolors the candles, and
// strategy backtests paint their entries/exits on the price chart. The legend
// carries a SOURCE button (`hasSource`) — the deep loop back into the editor.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Bar,
  IndicatorDescriptor,
  IndicatorFillSpec,
  IndicatorInput,
  IndicatorLevel,
  IndicatorMarker,
  IndicatorSettings,
  IndicatorSource,
  IndicatorValues,
  SeriesType,
  IndicatorBackgroundSpec,
} from 'openalgo-charts';
import { runScript } from '@/lib/scriptlang/internal';
import type { RunResult, ScriptBar, PlotSpec, ShapeStyle } from '@/lib/scriptlang/types';
import { takerBuyFor } from './volos-feed';

// ── color helpers ───────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** css color + 0..1 alpha → rgba() string openalgo can paint. */
export function rgba(cssColor: string, alpha = 1): string {
  if (cssColor === 'transparent') return 'rgba(0,0,0,0)';
  const rgb = hexToRgb(cssColor);
  if (rgb) return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, alpha))})`;
  if (cssColor.startsWith('rgba') || cssColor.startsWith('rgb')) return cssColor;
  return cssColor;
}

const PLOT_TYPE: Record<string, SeriesType> = {
  line: 'line',
  stepline: 'step',
  histogram: 'histogram',
  column: 'column',
  area: 'area',
  circles: 'line-markers',
  cross: 'line-markers',
};

const MARKER_SHAPE: Record<ShapeStyle, IndicatorMarker['shape']> = {
  triangleup: 'triangleUp',
  triangledown: 'triangleDown',
  circle: 'circle',
  cross: 'cross',
  square: 'square',
  diamond: 'diamond',
  arrowup: 'arrowUp',
  arrowdown: 'arrowDown',
  label: 'labelUp', // labelDown decided per location below
};

// ── bar mapping (openalgo Bar[] → VolScript ScriptBar[]) ───────────────────

function toScriptBars(bars: readonly Bar[]): ScriptBar[] {
  const out: ScriptBar[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    out[i] = {
      ts: b.time * 1000,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume ?? 0,
      tb: b.volume != null ? takerBuyFor(b.time, b.volume) : (b.volume ?? 0) / 2,
    };
  }
  return out;
}

const nulls = (n: number): (number | null)[] => new Array<number | null>(n).fill(null);
const col = (data: number[]): (number | null)[] => {
  const out = nulls(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    out[i] = Number.isFinite(v) ? v : null;
  }
  return out;
};

export interface BridgeOptions {
  /** descriptor registry id, e.g. `volscript:bollinger-squeeze` */
  id: string;
  /** display name for the picker + legend */
  name: string;
  /** the full VolScript/Pine source (shown by the SOURCE button loop) */
  code: string;
  /** picker group */
  category?: string;
}

export interface RegisteredScript {
  id: string;
  name: string;
  code: string;
}

/** id → script source — the indicatorSource button looks the code up here. */
const registered = new Map<string, RegisteredScript>();

export function getRegisteredScript(id: string): RegisteredScript | undefined {
  return registered.get(id);
}

export function listRegisteredScripts(): RegisteredScript[] {
  return [...registered.values()];
}

/** Compile a VolScript once (title/inputs/plot count) without chart bars. */
export function previewScript(code: string): { ok: boolean; title?: string; kind?: string; error?: string } {
  const fake: ScriptBar[] = Array.from({ length: 260 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 3_600_000,
    o: 100,
    h: 101,
    l: 99,
    c: 100 + Math.sin(i / 20),
    v: 1000,
    tb: 500,
  }));
  const r = runScript(code, fake);
  return r.ok ? { ok: true, title: r.title, kind: r.kind } : { ok: false, error: r.error?.message ?? 'compile failed' };
}

/** The descriptor factory: ANY VolScript → a full openalgo study. */
export function volscriptDescriptor(options: BridgeOptions): IndicatorDescriptor {
  const { id, name, code } = options;
  const inputs: IndicatorInput[] = [];

  // probe the script once for its input form (a cheap synthetic run)
  const probe = previewScript(code);

  const buildInputs = (r: RunResult): IndicatorInput[] =>
    r.inputs.map<IndicatorInput>((s) => {
      if (s.type === 'int' || s.type === 'float') {
        return {
          key: s.key,
          type: 'number',
          label: s.title,
          default: typeof s.def === 'number' ? s.def : 0,
          min: s.minval,
          max: s.maxval,
          step: s.step ?? (s.type === 'int' ? 1 : undefined),
          group: 'Inputs',
        };
      }
      if (s.type === 'bool') {
        return { key: s.key, type: 'boolean', label: s.title, default: s.def === true, group: 'Inputs' };
      }
      if (s.type === 'string' && s.options?.length) {
        return {
          key: s.key,
          type: 'select',
          label: s.title,
          default: String(s.def),
          options: s.options.map((v) => ({ label: v, value: v })),
          group: 'Inputs',
        };
      }
      if (s.type === 'source') {
        return {
          key: s.key,
          type: 'source',
          label: s.title,
          default: String(s.def) as IndicatorSource,
          group: 'Inputs',
        };
      }
      return { key: s.key, type: 'text', label: s.title, default: String(s.def), group: 'Inputs' };
    });

  const desc: IndicatorDescriptor = {
    id,
    name,
    category: options.category ?? 'VolScript',
    placement: 'onchart', // refined per-run below
    hasSource: true,
    inputs,
    plots: [
      {
        key: 'pending',
        type: 'line',
        title: probe.ok ? (probe.title ?? name) : name,
        style: { color: '#2dd4bf' },
      },
    ],
    calc(bars: readonly Bar[], settings: Readonly<IndicatorSettings>): IndicatorValues {
      // a restored study computes BEFORE the first bars land — returning empty
      // (rather than throwing) lets the layout restore succeed and recompute
      // the moment data arrives
      if (!bars.length) return {};
      const scriptBars = toScriptBars(bars);
      const r = runScript(code, scriptBars, { inputs: settings as Record<string, number | boolean | string> });
      if (!r.ok) throw new Error(`VolScript line ${r.error?.line ?? 0}: ${r.error?.message ?? 'compile failed'}`);
      // inputs were discovered on this run — splice them in (once, safely)
      if (inputs.length === 0 && r.inputs.length) {
        const built = buildInputs(r);
        inputs.push(...built);
        (desc as unknown as { inputs: IndicatorInput[] }).inputs = built;
      }
      const values: IndicatorValues = {};
      for (let i = 0; i < r.plots.length; i++) {
        const p = r.plots[i];
        const key = `p${i}`;
        values[key] = col(p.data);
        if (p.ohlc) {
          values[`${key}o`] = col(p.ohlc.open);
          values[`${key}h`] = col(p.ohlc.high);
          values[`${key}l`] = col(p.ohlc.low);
          values[`${key}c`] = col(p.ohlc.close);
        }
      }
      // constant columns for fill() edges that are hlines
      for (let j = 0; j < r.hlines.length; j++) values[`h${j}`] = new Array(bars.length).fill(r.hlines[j].price);
      // background/barColors columns are read by the hooks below through closure state
      lastRun = r;
      return values;
    },
    markers(ctx): readonly IndicatorMarker[] {
      const r = lastRun;
      if (!r) return [];
      const out: IndicatorMarker[] = [];
      const onChart = desc.placement === 'onchart';
      for (const s of r.shapes) {
        for (let i = 0; i < ctx.bars.length; i++) {
          if (!s.cond[i]) continue;
          const b = ctx.bars[i];
          const below = s.location !== 'abovebar';
          const shape: IndicatorMarker['shape'] =
            s.style === 'label' ? (below ? 'labelDown' : 'labelUp') : (MARKER_SHAPE[s.style] ?? 'circle');
          out.push({
            time: b.time,
            position: below ? 'belowBar' : 'aboveBar',
            shape,
            size: 'small',
            color: rgba(s.color, Math.max(0.55, s.alpha)),
            text: s.text,
            bold: Boolean(s.text),
            ...(onChart ? {} : {}),
          });
        }
      }
      // strategy backtest entries/exits — the backtest panel's markers, painted
      if (r.backtest) {
        for (const m of r.backtest.markers) {
          const b = ctx.bars[m.idx];
          if (!b) continue;
          if (m.kind === 'entry') {
            out.push({
              time: b.time,
              position: m.side === 'long' ? 'belowBar' : 'aboveBar',
              shape: m.side === 'long' ? 'triangleUp' : 'triangleDown',
              size: 'small',
              color: m.side === 'long' ? '#4ade80' : '#fb7185',
              text: `${m.side === 'long' ? 'L' : 'S'} @${m.price.toFixed(1)}`,
            });
          } else {
            out.push({
              time: b.time,
              position: 'atPrice',
              price: m.price,
              shape: 'cross',
              size: 'tiny',
              color: m.reason === 'stop' ? '#fb7185' : m.reason === 'limit' ? '#4ade80' : '#a1a1aa',
              text: m.reason === 'stop' ? 'SL' : m.reason === 'limit' ? 'TP' : 'X',
            });
          }
        }
      }
      return out;
    },
    levels(): readonly IndicatorLevel[] {
      const r = lastRun;
      if (!r) return [];
      return r.hlines.map((h) => ({
        price: h.price,
        color: rgba(h.color, Math.max(0.4, h.alpha)),
        title: h.title,
        dashed: h.dashed,
        lineWidth: 1,
      }));
    },
    background(): readonly IndicatorBackgroundSpec[] | readonly (string | null)[] {
      const r = lastRun;
      if (!r?.background) return [];
      return r.background.colors.map((c) => (c && c !== 'transparent' ? rgba(c, Math.min(0.85, Math.max(0.06, r.background!.alpha))) : null));
    },
    barColors(): readonly (string | null)[] {
      const r = lastRun;
      if (!r?.barColors) return [];
      return r.barColors.colors;
    },
  };

  // placement + plots are finalized on the first calc — but the picker wants
  // them upfront, so do a synthetic run now
  const synthetic: ScriptBar[] = Array.from({ length: 300 }, (_, i) => {
    const px = 100 + Math.sin(i / 24) * 6;
    return { ts: 1_700_000_000_000 + i * 3_600_000, o: px, h: px + 1.2, l: px - 1.2, c: px + 0.3, v: 1000, tb: 500 };
  });
  let lastRun: RunResult | null = null;
  const r0 = runScript(code, synthetic);
  if (r0.ok) {
    lastRun = r0;
    (desc as unknown as { placement: 'onchart' | 'pane' }).placement = r0.overlay ? 'onchart' : 'pane';
    (desc as unknown as { inputs: IndicatorInput[] }).inputs = buildInputs(r0);
    inputs.length = 0;
    inputs.push(...desc.inputs);
    (desc as unknown as { plots: unknown[] }).plots = r0.plots.map((p, i) => {
      const key = `p${i}`;
      const type: SeriesType = p.ohlc ? (p.ohlcKind === 'bars' ? 'bar' : 'candlestick') : (PLOT_TYPE[p.style] ?? 'line');
      const plot: Record<string, unknown> = {
        key,
        type,
        title: p.title,
        style: {
          ...(type === 'candlestick' || type === 'bar'
            ? {
                upColor: rgba(p.color, 0.85),
                downColor: rgba(p.color, 0.5),
                borderUpColor: rgba(p.color, 0.9),
                borderDownColor: rgba(p.color, 0.7),
                wickUpColor: rgba(p.color, 0.8),
                wickDownColor: rgba(p.color, 0.6),
              }
            : { color: rgba(p.color, p.alpha) }),
          lineWidth: Math.max(1, Math.min(4, p.width)),
        },
        colorKey: key,
      };
      if (p.ohlc) plot.ohlc = { open: `${key}o`, high: `${key}h`, low: `${key}l`, close: `${key}c` };
      return plot;
    });
    if (r0.overlay) (desc as unknown as { markerAnchor?: 'plot' | 'price' }).markerAnchor = 'price';
    // fills are STATIC data on a descriptor — derive them from the synthetic run
    const fillSpecs: IndicatorFillSpec[] = r0.fills.map((f) => {
      const keyOf = (e: { kind: 'plot' | 'hline'; index: number }) => (e.kind === 'plot' ? `p${e.index}` : `h${e.index}`);
      return {
        between: [keyOf(f.a), keyOf(f.b)] as [string, string],
        colorUp: rgba(f.color, Math.min(0.9, Math.max(0.08, f.alpha * 0.4))),
        colorDown: rgba(f.color, Math.min(0.9, Math.max(0.08, f.alpha * 0.4))),
        opacity: Math.min(0.9, Math.max(0.08, f.alpha * 0.4)),
      };
    });
    if (fillSpecs.length) (desc as unknown as { fills?: readonly IndicatorFillSpec[] }).fills = fillSpecs;
  }

  registered.set(id, { id, name, code });
  return desc;
}

/** Build + register a script descriptor (the caller supplies openalgo's
 *  registerIndicator — client-side, after the dynamic import). */
export function registerVolScript(
  registerIndicator: (d: IndicatorDescriptor) => void,
  id: string,
  name: string,
  code: string,
): IndicatorDescriptor {
  const d = volscriptDescriptor({ id, name, code });
  registerIndicator(d);
  return d;
}

export function slugifyScript(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'script'
  );
}

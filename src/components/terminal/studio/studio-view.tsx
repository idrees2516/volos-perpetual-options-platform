'use client';

// ─────────────────────────────────────────────────────────────────────────────
// STUDIO — any chart × any model, in depth.
//
//   CHART tab   — every plottable series in the product (price, indicators,
//                 flow, forecast, model outputs, surfaces) rendered as ANY
//                 chart kind with per-series transforms, overlays, left/right
//                 axes or 0–1 normalization, crosshair readouts, and matrix
//                 families as heatmaps or 3D surfaces.
//   MODEL tab   — every model in the room run on ANY series with parameter
//                 sliders: verdicts + chartable outputs that push straight
//                 into the chart ("session series") — the loop closes:
//                 any data → any model → any chart.
//
// The spec persists; everything rides the shared merged-bar cache.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LineChart, Pill, Segmented, StatGrid, HeatMatrix } from '@/components/terminal/quantlab/quant-viz';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';
import { UniversalChart, type StudioSeries } from './universal-chart';
import { Surface3d } from '@/components/terminal/models/surface3d';
import { applyTransform } from '@/lib/viz/transforms';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { correlationColor, sequentialColor } from '@/lib/quant/heatmap';
import { fmtNum } from '@/lib/format';
import { ChartLine, FlaskConical, Plus, Search, Trash2, X } from 'lucide-react';
import type { ChartKind, SeriesSpec, VizSeries, VizTransform } from '@/lib/viz/types';

interface ModelSpecLite {
  id: string;
  label: string;
  family: string;
  desc: string;
  usesSeries: boolean;
  params: { name: string; label: string; type: 'number' | 'select'; min?: number; max?: number; step?: number; def: number | string; options?: string[] }[];
  outputs: { id: string; label: string; kind: string }[];
  consumedBy: string[];
}

interface Catalog {
  ok: boolean;
  series: SeriesSpec[];
  models: ModelSpecLite[];
}

interface ChartSpecRow {
  id: string;
  transform: VizTransform;
  axis: 'left' | 'right';
}

interface ChartSpec {
  asset: string;
  tf: number;
  kind: ChartKind;
  normalize: boolean;
  rows: ChartSpecRow[];
}

const DEFAULT_SPEC: ChartSpec = {
  asset: 'BTC',
  tf: 1_800_000,
  kind: 'line',
  normalize: false,
  rows: [
    { id: 'close', transform: 'none', axis: 'left' },
    { id: 'volume', transform: 'zscore', axis: 'right' },
  ],
};

const PALETTE = ['#2dd4bf', '#f59e0b', '#a78bfa', '#38bdf8', '#fb7185', '#4ade80', '#f472b6', '#e4eaf2'];
const ASSETS = ['BTC', 'ETH', 'SOL'] as const;
const TFS: { id: number; label: string }[] = [
  { id: 60_000, label: '1m' },
  { id: 300_000, label: '5m' },
  { id: 900_000, label: '15m' },
  { id: 1_800_000, label: '30m' },
];

interface ChartResponse {
  ok: boolean;
  kind?: ChartKind | 'matrix';
  series?: (VizSeries & { color: string; transform: VizTransform })[];
  matrix?: VizSeries;
  meta?: { computeMs?: number; points?: number; note?: string };
  error?: string;
}

export function StudioView() {
  const [tab, setTab] = usePersistedState<'chart' | 'models'>('volos-studio-tab', 'chart');
  const [spec, setSpec] = usePersistedState<ChartSpec>('volos-studio-chart', DEFAULT_SPEC);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [chart, setChart] = useState<ChartResponse | null>(null);
  const [chartBusy, setChartBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [sessionSeries, setSessionSeries] = useState<{ series: VizSeries; color: string }[]>([]);
  const [matrixView, setMatrixView] = usePersistedState<'heatmap' | '3d'>('volos-studio-matrix-view', 'heatmap');

  // ── catalog ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    fetch('/api/viz/catalog')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setCatalog(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const specKey = JSON.stringify({ ...spec, rows: spec.rows });

  // ── chart compute (server) — every setState lives in an async callback ───
  useEffect(() => {
    if (spec.rows.length === 0) return;
    let alive = true;
    const timer = setTimeout(() => {
      setChartBusy(true);
      void fetch('/api/viz/chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset: spec.asset,
          tf: spec.tf,
          kind: spec.kind,
          series: spec.rows.map((r) => ({ id: r.id, transform: r.transform })),
        }),
      })
        .then(async (res) => {
          const d = (await res.json()) as ChartResponse;
          if (alive) setChart(d);
        })
        .catch(() => alive && setChart({ ok: false, error: 'chart compute failed' }))
        .finally(() => alive && setChartBusy(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [specKey]);

  const seriesById = useMemo(() => new Map((catalog?.series ?? []).map((s) => [s.id, s])), [catalog]);

  // merged render series: server-transformed catalog rows + session series (client-transformed)
  const studioSeries: StudioSeries[] = useMemo(() => {
    const out: StudioSeries[] = [];
    const server = chart?.series ?? [];
    for (const s of server) {
      const row = spec.rows.find((r) => r.id === s.id);
      out.push({ ...s, axis: row?.axis ?? 'left' });
    }
    for (const s of sessionSeries) {
      out.push({ ...s.series, color: s.color, axis: 'left', label: `${s.series.label}${s.series.group === 'model-output' ? ' ⚙' : ''}`, points: applyTransform(s.series.points ?? [], 'none') });
    }
    return out;
  }, [chart, sessionSeries, spec.rows]);

  const toggleRow = useCallback(
    (id: string) => {
      setSpec((s) => {
        if (s.rows.some((r) => r.id === id)) return { ...s, rows: s.rows.filter((r) => r.id !== id) };
        if (s.rows.length >= 8) return s;
        return { ...s, rows: [...s.rows, { id, transform: 'none', axis: 'left' }] };
      });
    },
    [setSpec],
  );

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = search.trim().toLowerCase();
    const list = q
      ? catalog.series.filter((s) => `${s.label} ${s.group} ${s.tags.join(' ')}`.toLowerCase().includes(q))
      : catalog.series;
    return list.slice(0, 200);
  }, [catalog, search]);

  const grouped = useMemo(() => {
    const g = new Map<string, SeriesSpec[]>();
    for (const s of filtered) {
      const arr = g.get(s.group) ?? [];
      arr.push(s);
      g.set(s.group, arr);
    }
    return [...g.entries()];
  }, [filtered]);

  const isMatrix = chart?.kind === 'matrix' && chart.matrix;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-bold tracking-tight text-zinc-100">
            <ChartLine className="h-4 w-4 text-teal-400" />
            Chart &amp; Model Studio
          </h2>
          <p className="text-[9px] uppercase tracking-[0.16em] text-zinc-500">
            any series × any chart kind · any model on any data · outputs loop back as charts
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-md border border-teal-800/40 bg-teal-950/30 px-2 py-1 text-[8.5px] font-semibold uppercase tracking-[0.12em] text-teal-300">
            {catalog ? `${catalog.series.length} series · ${catalog.models.length} models` : 'loading catalog…'}
          </span>
        </div>
        <Segmented
          value={tab}
          onChange={(t) => setTab(t)}
          options={[
            { id: 'chart', label: 'chart studio' },
            { id: 'models', label: 'model studio' },
          ]}
        />
      </div>

      {tab === 'chart' ? (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* ── series catalog rail ─────────────────────────────────────────── */}
          <aside className="flex w-[228px] shrink-0 flex-col rounded-lg border border-zinc-800 bg-zinc-950/50">
            <div className="flex items-center gap-1.5 border-b border-zinc-800/70 px-2 py-1.5">
              <Search className="h-3 w-3 text-zinc-600" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search series…"
                className="w-full bg-transparent text-[10px] text-zinc-200 placeholder-zinc-600 focus:outline-none"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {grouped.map(([group, list]) => (
                <div key={group} className="mb-1">
                  <p className="px-1 py-0.5 text-[8px] font-bold uppercase tracking-[0.18em] text-zinc-600">{group}</p>
                  {list.map((s) => {
                    const active = spec.rows.some((r) => r.id === s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() => toggleRow(s.id)}
                        title={`${s.desc}${s.consumedBy ? ` · consumed by ${s.consumedBy.join(', ')}` : ''}`}
                        className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-[10px] transition ${
                          active ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                        }`}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.group === 'models' ? '#a78bfa' : s.group === 'flow' ? '#f59e0b' : s.group === 'surfaces' ? '#38bdf8' : '#2dd4bf' }} />
                        <span className="truncate">{s.label}</span>
                        {s.tags.includes('matrix') ? <Pill tone="zinc">grid</Pill> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </aside>

          {/* ── the chart ───────────────────────────────────────────────────── */}
          <Dock viewId="studio-chart" layout="stack" className="min-w-0 flex-1">
            <DockPanel id="chart" title="the chart" sub="any series · any kind · overlays · transforms" span={2} right={
              <span className="flex items-center gap-1.5">
                {chartBusy ? <Pill tone="amber">computing…</Pill> : chart?.meta?.computeMs != null ? <Pill tone="zinc" title="server compute">{chart.meta.computeMs}ms</Pill> : null}
                <Pill tone="zinc">{spec.asset} · {TFS.find((t) => t.id === spec.tf)?.label}</Pill>
              </span>
            }>
              <div className="space-y-2">
                {/* controls row */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <div className="flex items-center gap-1">
                    {ASSETS.map((a) => (
                      <button
                        key={a}
                        onClick={() => setSpec((s) => ({ ...s, asset: a }))}
                        className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${spec.asset === a ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    {TFS.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setSpec((s) => ({ ...s, tf: t.id }))}
                        className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${spec.tf === t.id ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    {(['line', 'area', 'band', 'bars', 'histogram', 'scatter', 'step', 'candles'] as ChartKind[]).map((k) => (
                      <button
                        key={k}
                        onClick={() => setSpec((s) => ({ ...s, kind: k }))}
                        className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${spec.kind === k ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setSpec((s) => ({ ...s, normalize: !s.normalize }))}
                    className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${spec.normalize ? 'bg-amber-950/60 text-amber-300 ring-1 ring-amber-500/30' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'}`}
                    title="min-max each series to 0–1 — compare any units"
                  >
                    0–1
                  </button>
                  {sessionSeries.length > 0 && (
                    <button
                      onClick={() => setSessionSeries([])}
                      className="flex items-center gap-1 rounded bg-zinc-900 px-1.5 py-0.5 text-[9.5px] font-semibold text-violet-400 hover:text-violet-300"
                      title="clear model-run session series"
                    >
                      <X className="h-2.5 w-2.5" /> {sessionSeries.length} model series
                    </button>
                  )}
                </div>

                {/* the canvas / matrix */}
                {chart && !chart.ok && <p className="rounded-md border border-rose-900/50 bg-rose-950/30 px-2 py-1.5 text-[10px] text-rose-300">{chart.error}</p>}
                {isMatrix ? (
                  <MatrixPanel series={chart.matrix!} view={matrixView} onView={setMatrixView} />
                ) : chart?.series ? (
                  <UniversalChart kind={spec.kind} series={studioSeries} normalize={spec.normalize} height={400} />
                ) : (
                  <div className="flex h-[400px] items-center justify-center rounded-lg border border-dashed border-zinc-800 text-[11px] text-zinc-600">
                    {spec.rows.length === 0 ? 'pick series from the catalog →' : chartBusy ? 'computing…' : '—'}
                  </div>
                )}

                {/* legend + per-series transforms */}
                <div className="space-y-1">
                  {spec.rows.map((row, i) => {
                    const s = seriesById.get(row.id);
                    return (
                      <div key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-zinc-800/60 bg-zinc-900/40 px-2 py-1">
                        <span className="h-2 w-2 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
                        <span className="min-w-0 truncate text-[10px] font-medium text-zinc-200">{s?.label ?? row.id}</span>
                        {s?.unit ? <Pill tone="zinc">{s.unit}</Pill> : null}
                        {s?.consumedBy?.length ? (
                          <span className="hidden text-[8.5px] text-zinc-600 md:inline" title={s.consumedBy.join(' · ')}>
                            → {s.consumedBy.slice(0, 2).join(' · ')}
                          </span>
                        ) : null}
                        <select
                          value={row.transform}
                          onChange={(e) =>
                            setSpec((sp) => ({ ...sp, rows: sp.rows.map((r) => (r.id === row.id ? { ...r, transform: e.target.value as VizTransform } : r)) }))
                          }
                          className="rounded bg-zinc-950 px-1 py-0.5 text-[9px] text-zinc-300 ring-1 ring-zinc-800 focus:outline-none"
                        >
                          {['none', 'log', 'diff', 'pct', 'zscore', 'minmax', 'ema', 'cum'].map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() =>
                            setSpec((sp) => ({ ...sp, rows: sp.rows.map((r) => (r.id === row.id ? { ...r, axis: r.axis === 'left' ? 'right' : 'left' } : r)) }))
                          }
                          className={`rounded px-1 py-0.5 text-[9px] font-semibold ${row.axis === 'right' ? 'bg-sky-950/60 text-sky-300 ring-1 ring-sky-500/30' : 'bg-zinc-900 text-zinc-500'}`}
                          title="plot on the right axis"
                        >
                          {row.axis}
                        </button>
                        <button onClick={() => toggleRow(row.id)} className="ml-auto rounded p-1 text-zinc-600 hover:text-rose-400" title="remove">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                  {spec.rows.length === 0 && <p className="px-1 text-[10px] text-zinc-600">no series selected — click catalog entries to add up to 8</p>}
                </div>
              </div>
            </DockPanel>
          </Dock>
        </div>
      ) : (
        <ModelStudio catalog={catalog} spec={spec} onSessionSeries={(s) => { setSessionSeries((prev) => [...prev.filter((x) => x.series.id !== s.id), { series: s, color: PALETTE[(prev.length + spec.rows.length) % PALETTE.length] }]); setTab('chart'); }} />
      )}
    </div>
  );
}

// ── matrix rendering (heatmap / 3D surface) ──────────────────────────────────

function MatrixPanel({ series, view, onView }: { series: VizSeries; view: 'heatmap' | '3d'; onView: (v: 'heatmap' | '3d') => void }) {
  const m = series.matrix!;
  const finite = useMemo(() => m.values.flat().filter((v) => Number.isFinite(v)), [m]);
  const lo = useMemo(() => Math.min(...finite), [finite]);
  const hi = useMemo(() => Math.max(...finite), [finite]);
  const maxAbs = useMemo(() => Math.max(...finite.map(Math.abs), 1e-9), [finite]);
  const diverging = series.id === 'gexSession' || series.id === 'correlation';
  const colorFn = diverging
    ? (v: number) => correlationColor(Math.max(-1, Math.min(1, v / maxAbs)))
    : (v: number) => sequentialColor(Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Segmented value={view} onChange={onView} options={[{ id: 'heatmap', label: 'heatmap' }, { id: '3d', label: '3D surface' }]} />
        <span className="text-[9px] text-zinc-600">
          {m.rows.length} rows × {m.cols.length} cols · {series.note ?? ''}
        </span>
      </div>
      {view === 'heatmap' ? (
        <HeatMatrix
          rows={m.rows.slice(0, 40)}
          cols={m.cols.slice(0, 40)}
          values={m.values.slice(0, 40).map((r) => r.slice(0, 40))}
          format={(v: number) => fmtNum(v, 1)}
          colorFn={(v: number) => colorFn(v)}
          height={15}
        />
      ) : (
        <Matrix3d series={series} />
      )}
    </div>
  );
}

function Matrix3d({ series }: { series: VizSeries }) {
  const m = series.matrix!;
  // z[colIdx][rowIdx] — x-major as Surface3d expects
  const z = m.cols.map((_, ci) => m.rows.map((_, ri) => m.values[ri]?.[ci] ?? Number.NaN));
  const finite = m.values.flat().filter((v) => Number.isFinite(v));
  return (
    <Surface3d
      surfaces={[{ data: { x: m.cols.map((_, i) => i), y: m.rows.map((_, i) => i), z }, mode: 'height' }]}
      xLabel={`${m.cols[0] ?? ''}→${m.cols.at(-1) ?? ''}`}
      yLabel={`${m.rows[0] ?? ''}→${m.rows.at(-1) ?? ''}`}
      zLabel={series.label}
      height={340}
      formatZ={(v: number) => fmtNum(finite.length ? v : 0, 1)}
    />
  );
}

// ── MODEL STUDIO ─────────────────────────────────────────────────────────────

interface ModelRunResultLite {
  model: string;
  label: string;
  input: { seriesId: string; seriesLabel: string; asset: string; tf: number; n: number; level: number };
  verdicts: { label: string; value: string; tone?: string; sub?: string }[];
  outputs: VizSeries[];
  note?: string;
  builtAt: number;
}

function ModelStudio({ catalog, spec, onSessionSeries }: { catalog: Catalog | null; spec: ChartSpec; onSessionSeries: (s: VizSeries) => void }) {
  const [modelId, setModelId] = usePersistedState('volos-studio-model', 'garch');
  const [seriesId, setSeriesId] = usePersistedState('volos-studio-model-series', 'close');
  const [params, setParams] = usePersistedState<Record<string, number | string>>('volos-studio-model-params', {});
  const [result, setResult] = useState<ModelRunResultLite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runToken = useRef(0);

  const model = catalog?.models.find((m) => m.id === modelId);
  const pointsSeries = useMemo(() => (catalog?.series ?? []).filter((s) => !s.tags.includes('matrix')), [catalog]);
  // effective params: the model's defaults overlaid with the persisted edits
  // (stale keys from a previous model are simply never read)
  const eff = useMemo(() => {
    const out: Record<string, number | string> = {};
    for (const p of model?.params ?? []) out[p.name] = params[p.name] ?? p.def;
    return out;
  }, [model, params]);

  const run = useCallback(() => {
    const token = ++runToken.current;
    setBusy(true);
    setError(null);
    void fetch('/api/models/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, asset: spec.asset, tf: spec.tf, seriesId, params: eff }),
    })
      .then(async (res) => {
        const d = await res.json();
        if (token !== runToken.current) return;
        if (d.ok) setResult(d.result);
        else setError(d.error ?? 'model run failed');
      })
      .catch((e) => token === runToken.current && setError(String(e)))
      .finally(() => token === runToken.current && setBusy(false));
  }, [modelId, spec.asset, spec.tf, seriesId, eff]);

  return (
    <Dock viewId="studio-models" layout="grid" className="min-h-0 flex-1">
      {/* model picker + params */}
      <DockPanel id="picker" title="the model room" sub="any model · any input series · your parameters" span={1}>
        <div className="space-y-2">
          <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto pr-1">
            {(catalog?.models ?? []).map((m) => (
              <button
                key={m.id}
                onClick={() => setModelId(m.id)}
                className={`flex flex-col rounded-md px-1.5 py-1 text-left text-[10px] transition ${modelId === m.id ? 'bg-violet-950/60 text-violet-300 ring-1 ring-violet-500/30' : 'bg-zinc-900/60 text-zinc-400 hover:text-zinc-200'}`}
              >
                <span className="font-semibold">{m.label}</span>
                <span className="text-[8px] uppercase tracking-wider text-zinc-600">{m.family}</span>
              </button>
            ))}
          </div>
          {model && (
            <p className="text-[9.5px] leading-relaxed text-zinc-500">{model.desc}</p>
          )}
          {model?.usesSeries && (
            <label className="flex items-center gap-2 text-[9.5px] text-zinc-500">
              input series
              <select
                value={seriesId}
                onChange={(e) => setSeriesId(e.target.value)}
                className="min-w-0 flex-1 rounded bg-zinc-950 px-1.5 py-1 text-[10px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none"
              >
                {pointsSeries.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.group} · {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {model && model.params.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-zinc-800/60 bg-zinc-900/40 p-2">
              {model.params.map((p) =>
                p.type === 'select' ? (
                  <label key={p.name} className="flex items-center gap-2 text-[9.5px] text-zinc-500">
                    {p.label}
                    <select
                      value={String(params[p.name] ?? p.def)}
                      onChange={(e) => setParams((s) => ({ ...s, [p.name]: e.target.value }))}
                      className="rounded bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-200 ring-1 ring-zinc-800 focus:outline-none"
                    >
                      {(p.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label key={p.name} className="flex items-center gap-2 text-[9.5px] text-zinc-500">
                    <span className="w-24 shrink-0">{p.label}</span>
                    <input
                      type="range"
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      value={Number(eff[p.name] ?? p.def)}
                      onChange={(e) => setParams((s) => ({ ...s, [p.name]: Number(e.target.value) }))}
                      className="min-w-0 flex-1 accent-violet-400"
                    />
                    <span className="w-14 shrink-0 text-right font-mono text-[9.5px] text-zinc-300">{fmtNum(Number(eff[p.name] ?? p.def), 2)}</span>
                  </label>
                ),
              )}
            </div>
          )}
          <button
            onClick={run}
            disabled={busy || !model}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-950/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-200 transition hover:bg-violet-950/70 disabled:opacity-50"
          >
            <FlaskConical className="h-3 w-3" />
            {busy ? 'running…' : 'run model'}
          </button>
          {model?.consumedBy?.length ? (
            <p className="text-[8.5px] leading-relaxed text-zinc-600">
              consumed in production by: {model.consumedBy.join(' · ')}
            </p>
          ) : null}
          {error && <p className="rounded-md border border-rose-900/50 bg-rose-950/30 px-2 py-1.5 text-[10px] text-rose-300">{error}</p>}
        </div>
      </DockPanel>

      {/* result */}
      <DockPanel id="result" title={result ? `${result.label} · verdicts` : 'model verdicts'} sub={result ? `${result.input.seriesLabel} on ${result.input.asset} · ${result.input.n} points` : 'run a model to see its read of the data'} span={1}>
        {result ? (
          <StatGrid
            cols={2}
            stats={result.verdicts.map((v) => ({
              label: v.label,
              value: v.value,
              sub: v.sub,
              tone: (v.tone as 'teal' | 'rose' | 'amber' | 'zinc' | 'emerald' | 'violet') ?? 'zinc',
            }))}
          />
        ) : (
          <p className="px-1 py-6 text-[10px] text-zinc-600">pick a model, choose its input series, run — the verdict grid and output charts land here</p>
        )}
        {result?.note ? <p className="mt-2 text-[9px] text-zinc-600">{result.note}</p> : null}
      </DockPanel>

      {/* outputs */}
      <DockPanel id="outputs" title="model outputs" sub="chartable series — push them into the chart studio" span={2}>
        {result && result.outputs.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {result.outputs.map((o) => (
              <div key={o.id} className="space-y-1 rounded-md border border-zinc-800/60 bg-zinc-900/30 p-2">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[10px] font-semibold text-zinc-200">{o.label}</span>
                  <button
                    onClick={() => onSessionSeries(o)}
                    className="ml-auto flex items-center gap-1 rounded bg-violet-950/60 px-1.5 py-0.5 text-[9px] font-semibold text-violet-300 ring-1 ring-violet-500/30 hover:bg-violet-950"
                    title="add to the chart studio"
                  >
                    <Plus className="h-2.5 w-2.5" /> chart
                  </button>
                </div>
                <LineChart
                  series={[{ label: o.label, color: '#a78bfa', points: (o.points ?? []).map((p) => ({ x: p.t, y: p.v })) }]}
                  height={150}
                  yFormat={(v) => fmtNum(v, 2)}
                />
                {o.note ? <p className="text-[8.5px] text-zinc-600">{o.note}</p> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="px-1 py-6 text-[10px] text-zinc-600">every model run emits its outputs as chartable series — the loop: any data → any model → any chart</p>
        )}
      </DockPanel>
    </Dock>
  );
}

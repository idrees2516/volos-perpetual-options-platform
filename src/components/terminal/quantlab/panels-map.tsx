'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-map — MARKET MAP: the whole market as pictures.
//
//   • Breadth treemap — every major USDT-perp as a tile: area = 24h turnover,
//     color = 24h change / funding APR. One glance answers "where is the
//     market, where is the money, where is the leverage" (Coin360/CoinGlass
//     style, our own canvas + squarify layout — no chart library, one visual
//     language with the depth heatmap).
//   • Correlation matrix — the desk's 8 majors × rolling Pearson on log
//     returns from our own kline store (7d/30d/90d): what actually moves
//     together, the risk-clustering picture.
//
// Both: token-driven colors from lib/quant/heatmap (rose↔slate↔teal), shared
// HeatLegend, PanelState loading skeletons / empty / error+retry, live dots.
// Hover a treemap tile or matrix cell for the exact numbers; click a tile to
// refocus the whole Quant Lab on that market.
// -----------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Info } from 'lucide-react';
import { fmtUsd } from '@/lib/format';
import { PanelState } from '@/components/ui/panel-state';
import { correlationColor, divergingColor, legendTicks, sequentialColor, squarify, type TreemapRect } from '@/lib/quant/heatmap';
import type { BreadthResult, BreadthTile } from '@/lib/quant/breadth';
import type { CorrelationResult } from '@/lib/quant/correlation';
import type { FundingGridResult } from '@/lib/quant/funding-grid';
import { useQuant, useAgeLabel } from './use-quant';
import { Panel, Pill, LiveDot, Segmented, HeatMatrix, HeatLegend } from './quant-viz';

// re-exported for existing import sites — the legend now lives in quant-viz
export { HeatLegend };

// ── breadth treemap (canvas) ────────────────────────────────────────────────

type ColorMetric = 'change' | 'funding' | 'volume';

interface MetricSpec {
  id: ColorMetric;
  label: string;
  scale: 'diverging' | 'sequential';
  domain: (b: BreadthResult) => [number, number];
  value: (t: BreadthTile) => number;
  fmt: (v: number) => string;
  /** value → fill fraction on the metric's own domain */
  norm: (v: number, dom: [number, number]) => number;
}

/** Robust symmetric domain: p90 of |values| — outliers saturate instead of
 *  washing the whole map to neutral when one coin does +55%. */
function robustSymmetricDomain(vals: number[], floor: number, pct = 0.9): [number, number] {
  const finite = vals.filter((v) => Number.isFinite(v)).map(Math.abs).sort((a, b) => a - b);
  if (!finite.length) return [-floor, floor];
  const q = finite[Math.min(finite.length - 1, Math.floor(finite.length * pct))];
  const m = Math.max(q, floor);
  return [-m, m];
}

const METRICS: MetricSpec[] = [
  {
    id: 'change',
    label: '24h change',
    scale: 'diverging',
    domain: (b) => robustSymmetricDomain(b.tiles.map((t) => t.change24hPct), 2),
    value: (t) => t.change24hPct,
    fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`,
    norm: (v, d) => (v - d[0]) / (d[1] - d[0]),
  },
  {
    id: 'funding',
    label: 'funding apr',
    scale: 'diverging',
    domain: (b) => robustSymmetricDomain(b.tiles.map((t) => t.fundingApr ?? 0), 0.005),
    value: (t) => t.fundingApr ?? 0,
    fmt: (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`,
    norm: (v, d) => (v - d[0]) / (d[1] - d[0]),
  },
  {
    id: 'volume',
    label: 'volume share',
    scale: 'sequential',
    domain: (b) => [0, 100 * Math.max(...b.tiles.map((t) => t.volumeShare), 1e-9)],
    value: (t) => t.volumeShare,
    fmt: (v) => `${(v * 100).toFixed(1)}%`,
    norm: (v, d) => (v * 100 - d[0]) / (d[1] - d[0]),
  },
];

interface HoverInfo {
  x: number;
  y: number;
  tile: BreadthTile;
}

function BreadthTreemap({ data, metric, onFocusSymbol }: { data: BreadthResult; metric: ColorMetric; onFocusSymbol?: (s: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rectsRef = useRef<TreemapRect<BreadthTile>[]>([]);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const metricSpec = METRICS.find((m) => m.id === metric)!;
  const domain = useMemo(() => metricSpec.domain(data), [data, metricSpec]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(200, r.width), h: Math.max(180, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !(size.w > 0) || !(size.h > 0)) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const PAD = 2;
    const rects = squarify(
      data.tiles.map((t) => ({ value: t.volume24hUsd, data: t })),
      size.w - PAD,
      size.h - PAD,
    );
    rectsRef.current = rects;

    const [lo, hi] = domain;
    for (const r of rects) {
      const v = metricSpec.value(r.data);
      const fill =
        metricSpec.scale === 'sequential'
          ? sequentialColor(metricSpec.norm(v, domain))
          : divergingColor(v, Math.max(Math.abs(lo), Math.abs(hi)));
      const hovered = hover?.tile === r.data;

      ctx.fillStyle = fill;
      ctx.fillRect(r.x + PAD / 2, r.y + PAD / 2, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
      if (hovered) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(r.x + PAD / 2 + 0.5, r.y + PAD / 2 + 0.5, Math.max(0, r.w - 2), Math.max(0, r.h - 2));
      }

      // label tiles big enough to fit text
      const fs = Math.min(15, Math.max(8.5, r.w / 5));
      if (r.w > fs * 2.2 && r.h > fs * 2.1) {
        ctx.font = `600 ${fs}px var(--font-geist-mono), ui-monospace, monospace`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#e4e4e7';
        const cx = r.x + PAD / 2 + 4;
        const cy = r.y + PAD / 2 + 3;
        ctx.fillText(r.data.symbol, cx, cy);
        if (r.h > fs * 3.6 && r.w > fs * 3) {
          ctx.font = `500 ${fs * 0.78}px var(--font-geist-mono), ui-monospace, monospace`;
          const valText = metricSpec.fmt(v);
          const tone = v >= 0 ? '#5eead4' : '#fda4af';
          ctx.fillStyle = tone;
          ctx.fillText(valText, cx, cy + fs * 1.15);
          if (r.h > fs * 5 && r.w > fs * 4.5) {
            ctx.fillStyle = 'rgba(228,228,231,0.55)';
            ctx.font = `400 ${Math.max(7.5, fs * 0.62)}px var(--font-geist-mono), ui-monospace, monospace`;
            ctx.fillText(fmtUsd(r.data.volume24hUsd), cx, cy + fs * 2.2);
          }
        }
      }
    }
  }, [data, size, metric, domain, metricSpec, hover]);

  useEffect(() => {
    draw();
  }, [draw]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>): TreemapRect<BreadthTile> | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return rectsRef.current.find((rc) => x >= rc.x && x <= rc.x + rc.w && y >= rc.y && y <= rc.y + rc.h) ?? null;
  };

  return (
    <div ref={wrapRef} className="relative h-[340px] w-full">
      <canvas
        ref={canvasRef}
        className="cursor-pointer"
        onMouseMove={(e) => {
          const hit = pick(e);
          setHover(hit ? { x: e.clientX, y: e.clientY, tile: hit.data } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const hit = pick(e);
          if (hit) onFocusSymbol?.(hit.data.symbol);
        }}
      />
      {hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 shadow-xl"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 190), top: hover.y + 12 }}
        >
          <p className="font-mono text-[11px] font-bold text-zinc-100">{hover.tile.symbol}</p>
          <p className="font-mono text-[9px] text-zinc-400">
            spot {hover.tile.lastPrice >= 1000 ? hover.tile.lastPrice.toFixed(0) : hover.tile.lastPrice.toPrecision(4)}
          </p>
          <p className={`font-mono text-[9px] ${hover.tile.change24hPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            24h {hover.tile.change24hPct >= 0 ? '+' : ''}{hover.tile.change24hPct.toFixed(2)}%
          </p>
          <p className="font-mono text-[9px] text-zinc-400">24h vol {fmtUsd(hover.tile.volume24hUsd)}</p>
          {hover.tile.fundingApr != null && (
            <p className={`font-mono text-[9px] ${hover.tile.fundingApr >= 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
              funding {hover.tile.fundingApr >= 0 ? '+' : ''}{(hover.tile.fundingApr * 100).toFixed(1)}% apr
            </p>
          )}
          <p className="mt-0.5 text-[7.5px] uppercase tracking-wider text-zinc-600">click to focus quant lab</p>
        </div>
      )}
    </div>
  );
}

// ── breadth panel ────────────────────────────────────────────────────────────

function BreadthPanel({ onFocusSymbol }: { onFocusSymbol?: (s: string) => void }) {
  const scan = useQuant<BreadthResult>('/market/breadth', undefined, { pollMs: 30_000 });
  const age = useAgeLabel(scan.fetchedAt);
  const [metric, setMetric] = useState<ColorMetric>('change');
  const data = scan.data;
  const s = data?.stats;
  const metricSpec = METRICS.find((m) => m.id === metric)!;
  const metricDomain = useMemo(() => (data ? metricSpec.domain(data) : ([-2, 2] as [number, number])), [data, metricSpec]);

  return (
    <Panel
      title="Market Breadth — the whole market, one map"
      sub="tile area = 24h USDT-perp turnover · color = selected metric · binance-fapi sweep (2 REST calls/refresh)"
      right={
        <>
          <Segmented
            value={metric}
            onChange={(v) => setMetric(v as ColorMetric)}
            options={METRICS.map((m) => ({ id: m.id, label: m.label }))}
          />
          {data && <LiveDot ok={!scan.error} label={`live · ${age}`} />}
        </>
      }
    >
      <PanelState
        loading={!data && scan.loading}
        error={scan.error}
        onRetry={scan.refresh}
        skeletonRows={9}
        skeletonCols={3}
        empty={data && data.tiles.length === 0 ? 'venue sweep returned no markets' : undefined}
      >
        {data && (
          <div className="space-y-2.5">
            {s && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[9px]">
                <span className="font-mono text-zinc-400">
                  breadth <span className="text-emerald-300">{s.advancers}↑</span>
                  <span className="text-zinc-600"> / </span>
                  <span className="text-rose-300">{s.decliners}↓</span>
                </span>
                <span className="font-mono text-zinc-400">median <span className="text-zinc-200">{s.medianChangePct.toFixed(2)}%</span></span>
                <span className="font-mono text-zinc-400">turnover <span className="text-zinc-200">{fmtUsd(s.turnoverUsd)}</span></span>
                <span className="font-mono text-zinc-400">btc share <span className="text-zinc-200">{(s.btcDominance * 100).toFixed(1)}%</span></span>
                {s.topGainer && (
                  <span className="font-mono text-zinc-400">top <span className="text-emerald-300">{s.topGainer.symbol} +{s.topGainer.changePct.toFixed(1)}%</span></span>
                )}
                {s.topLoser && (
                  <span className="font-mono text-zinc-400">flop <span className="text-rose-300">{s.topLoser.symbol} {s.topLoser.changePct.toFixed(1)}%</span></span>
                )}
                {s.avgFundingApr != null && (
                  <span className="font-mono text-zinc-400">avg funding <span className={s.avgFundingApr >= 0 ? 'text-amber-300' : 'text-emerald-300'}>{(s.avgFundingApr * 100).toFixed(1)}% apr</span></span>
                )}
                <Pill tone="zinc">{data.tracked} of {data.universe} tracked</Pill>
              </div>
            )}
            <BreadthTreemap data={data} metric={metric} onFocusSymbol={onFocusSymbol} />
            <div className="flex items-center justify-between">
              <HeatLegend
                min={metricDomain[0]}
                max={metricDomain[1]}
                label={METRICS.find((m) => m.id === metric)!.label}
                scale={METRICS.find((m) => m.id === metric)!.scale}
              />
              <p className="text-[8.5px] text-zinc-600">{data.note}</p>
            </div>
          </div>
        )}
      </PanelState>
    </Panel>
  );
}

// ── correlation panel ────────────────────────────────────────────────────────

function CorrelationPanel() {
  const [window, setWindow] = useState<'7d' | '30d' | '90d'>('30d');
  const scan = useQuant<CorrelationResult>('/market/correlation', { window }, { pollMs: 300_000 });
  const age = useAgeLabel(scan.fetchedAt);
  const data = scan.data;

  const avgAbs = data?.avgAbsCorrelation;
  const clusters =
    data?.vsBtc
      .filter((r) => r.symbol !== 'BTC' && r.r != null)
      .sort((a, b) => (b.r ?? 0) - (a.r ?? 0))
      .slice(0, 3)
      .map((r) => r.symbol) ?? [];

  return (
    <Panel
      title="Cross-Asset Correlation — what actually moves together"
      sub="pearson on log returns · timestamp-aligned closes from our own kline store (live sweep when the store is cold)"
      right={
        <>
          <Segmented
            value={window}
            onChange={(v) => setWindow(v as '7d' | '30d' | '90d')}
            options={[{ id: '7d', label: '7d' }, { id: '30d', label: '30d' }, { id: '90d', label: '90d' }]}
          />
          {data && <LiveDot ok={!scan.error} label={`${data.source} · ${age}`} />}
        </>
      }
    >
      <PanelState
        loading={!data && scan.loading}
        error={scan.error}
        onRetry={scan.refresh}
        skeletonRows={8}
        skeletonCols={8}
        empty={data && data.assets.length < 2 ? 'not enough history to correlate yet' : undefined}
      >
        {data && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[9px]">
              <span className="font-mono text-zinc-400">avg |r| <span className="text-zinc-200">{(avgAbs ?? 0).toFixed(2)}</span></span>
              {avgAbs != null && (
                <span className={`font-mono ${avgAbs > 0.7 ? 'text-rose-300' : avgAbs > 0.4 ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {avgAbs > 0.7 ? 'one trade, clustered' : avgAbs > 0.4 ? 'high co-movement — diversify across horizons' : 'idiosyncratic — genuine dispersion'}
                </span>
              )}
              {clusters.length > 0 && (
                <span className="font-mono text-zinc-400">closest to BTC <span className="text-teal-300">{clusters.join(' · ')}</span></span>
              )}
              <Pill tone="zinc">{data.barsUsed} bars</Pill>
            </div>
            <HeatMatrix
              rows={data.assets}
              cols={data.assets}
              values={data.matrix.map((row) => row.map((v) => (v == null || !Number.isFinite(v) ? NaN : v)))}
              format={(v) => (Number.isFinite(v) ? v.toFixed(2) : '—')}
              colorFn={(v) => correlationColor(Number.isFinite(v) ? v : 0)}
              height={26}
              titleFn={(v) => (Number.isFinite(v) ? `r = ${v.toFixed(3)}` : 'insufficient history')}
            />
            <div className="flex items-center justify-between">
              <HeatLegend min={-1} max={1} fixed={[-1, 1]} label="r" />
              <p className="text-[8.5px] text-zinc-600">{data.note}</p>
            </div>
          </div>
        )}
      </PanelState>
    </Panel>
  );
}

// ── funding heat panel — the leverage map ────────────────────────────────────

function FundingPanel() {
  const [window, setWindow] = useState<'7d' | '30d'>('7d');
  const scan = useQuant<FundingGridResult>('/market/funding', { window }, { pollMs: 300_000 });
  const age = useAgeLabel(scan.fetchedAt);
  const data = scan.data;

  // robust symmetric domain: p90 of |APR| — one +300% APR outlier must not
  // wash every major to neutral slate
  const domain = useMemo<[number, number]>(() => {
    const vals = (data?.aprPct ?? []).flat().filter((v): v is number => v != null && Number.isFinite(v)).map(Math.abs).sort((a, b) => a - b);
    if (!vals.length) return [-10, 10];
    const q = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))];
    const m = Math.max(q, 5);
    return [-m, m];
  }, [data]);

  const s = data?.stats;
  return (
    <Panel
      title="Funding Heat — where is the leverage"
      sub="8h funding events × desk majors · APR annualized · rose = longs pay (crowded) · teal = shorts pay (cheap)"
      right={
        <>
          <Segmented
            value={window}
            onChange={(v) => setWindow(v as '7d' | '30d')}
            options={[{ id: '7d', label: '7d' }, { id: '30d', label: '30d' }]}
          />
          {data && <LiveDot ok={!scan.error} label={`${data.source} · ${age}`} />}
        </>
      }
    >
      <PanelState
        loading={!data && scan.loading}
        error={scan.error}
        onRetry={scan.refresh}
        skeletonRows={8}
        skeletonCols={14}
        empty={data && data.assets.length === 0 ? 'no funding history yet — backfill filling' : undefined}
      >
        {data && (
          <div className="space-y-2.5">
            {s && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[9px]">
                <span className="font-mono text-zinc-400">avg latest <span className="text-zinc-200">{s.avgAprPct != null ? `${s.avgAprPct >= 0 ? '+' : ''}${s.avgAprPct.toFixed(1)}%` : '—'}</span></span>
                <span className="font-mono text-zinc-400">longs pay <span className="text-rose-300">{s.longsPay}</span></span>
                <span className="font-mono text-zinc-400">shorts pay <span className="text-teal-300">{s.shortsPay}</span></span>
                {s.hottest && (
                  <span className="font-mono text-zinc-400">crowded <span className="text-rose-300">{s.hottest.symbol} +{s.hottest.aprPct.toFixed(1)}%</span></span>
                )}
                {s.coldest && (
                  <span className="font-mono text-zinc-400">cheapest <span className="text-teal-300">{s.coldest.symbol} {s.coldest.aprPct.toFixed(1)}%</span></span>
                )}
                <Pill tone="zinc">{data.assets.length} × {data.times.length} events</Pill>
              </div>
            )}
            <HeatMatrix
              rows={data.assets}
              cols={data.times.map((t) => new Date(t).toLocaleDateString(undefined, { month: 'numeric', day: '2-digit' }))}
              values={data.aprPct.map((row) => row.map((v) => (v == null || !Number.isFinite(v) ? NaN : v)))}
              format={(v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(0)}` : '·')}
              // NEGATED on purpose: positive funding (longs pay) reads rose =
              // crowded leverage, negative (shorts pay) reads teal — the
              // desk's funding semantics, same color scale everywhere else
              colorFn={(v) => divergingColor(Number.isFinite(v) ? -v : 0, domain[1])}
              height={24}
              titleFn={(v, r, c) =>
                Number.isFinite(v)
                  ? `${data.assets[r]} · ${new Date(data.times[c]).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })}: ${v >= 0 ? '+' : ''}${v.toFixed(2)}% APR (8h ${(v / (3 * 365 * 100)).toFixed(5)})`
                  : 'no observation'
              }
            />
            <div className="flex items-center justify-between">
              <HeatLegend min={domain[0]} max={domain[1]} label="apr %" />
              <p className="text-[8.5px] text-zinc-600">{data.note}</p>
            </div>
          </div>
        )}
      </PanelState>
    </Panel>
  );
}

// ── the MARKET MAP tab ───────────────────────────────────────────────────────

export function MarketMapPanel({ onFocusSymbol }: { onFocusSymbol?: (symbol: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-1.5">
        <LayoutGrid className="h-3.5 w-3.5 text-teal-400" />
        <p className="text-[11px] font-semibold tracking-tight text-zinc-200">Market Map</p>
        <p className="text-[9px] text-zinc-600">whole-market breadth + cross-asset correlation + funding heat — the "where are we, where is the leverage" pictures</p>
        <span className="ml-auto flex items-center gap-1 text-[8.5px] text-zinc-600">
          <Info className="h-3 w-3" />
          heat: teal = positive · rose = negative
        </span>
      </div>
      <BreadthPanel onFocusSymbol={onFocusSymbol} />
      <CorrelationPanel />
      <FundingPanel />
    </div>
  );
}

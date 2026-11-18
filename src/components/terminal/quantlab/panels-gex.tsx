'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-gex — GEX & Positioning: dealer levels, strike profile,
// strike×expiry heatmap, ladder, per-expiry GEX and dealer-flow history.
// -----------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { divergingColor } from '@/lib/quant/heatmap';
import { PanelState } from '@/components/ui/panel-state';
import { useQuant, useAgeLabel } from './use-quant';
import { ChartLegend, DivergingBars, EmptyNote, ErrNote, HeatMatrix, HeatLegend, LineChart, LiveDot, Panel, Pill, Segmented, StatGrid } from './quant-viz';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';

interface Levels {
  hvl: number | null;
  callWall: number | null;
  putSupport: number | null;
  maxPain: number | null;
  regime: string;
  totalGexUsd1pct: number;
  callGexUsd1pct: number;
  putGexUsd1pct: number;
  topStrikes: { strike: number; callGex: number; putGex: number; netGex: number; callOi: number; putOi: number }[];
}
interface GexLevelsData {
  spot: number;
  levels: Levels;
  levels0dte: Levels | null;
  unit: string;
  note: string;
}
interface HeatData {
  spot: number;
  strikes: number[];
  expiries: string[];
  netGex: number[][];
  oiUsd: number[][];
}
interface LadderData {
  spot: number;
  ladder: { strike: number; netGex: number; cumNetGex: number; callOi: number; putOi: number }[];
}
interface HistData {
  points: { ts: number; value: number }[];
  meta: { unit: string; snapshots: number };
}
interface SessionData {
  symbol: string;
  minutes: number;
  strikes: number[];
  times: number[];
  netGex: number[][];
  spot: number[];
  zeroGamma: (number | null)[];
  maxAbs: number;
  regime: 'long-gamma' | 'short-gamma' | null;
  note: string;
}

export function GexPanel({ symbol, hasOptions }: { symbol: string; hasOptions: boolean }) {
  const [scope, setScope] = useState<'all' | '0dte'>('all');
  const levels = useQuant<GexLevelsData>('/gex', { symbol, view: 'levels', expiry: scope }, { pollMs: 8000 });
  const strike = useQuant<{ topStrikes: { strike: number; callGex: number; putGex: number; netGex: number; callOi: number; putOi: number; callOiUsd: number; putOiUsd: number }[] }>('/gex', { symbol, view: 'strike' }, { pollMs: 15000 });
  const heat = useQuant<HeatData>('/gex', { symbol, view: 'heatmap' }, { pollMs: 20000 });
  const ladder = useQuant<LadderData>('/gex', { symbol, view: 'ladder' }, { pollMs: 15000 });
  const hist = useQuant<HistData>('/history', { symbol, metric: 'gex', days: 7 }, { pollMs: 60000 });
  const flow = useQuant<{ points: { ts: number; hedgeFlowUsd: number }[]; model: string }>('/history', { symbol, metric: 'dealer-flow', days: 3 }, { pollMs: 60000 });
  const [sessionMinutes, setSessionMinutes] = useState<60 | 120 | 240>(120);
  const session = useQuant<SessionData>('/gex', { symbol, view: 'session', minutes: sessionMinutes }, { pollMs: 30_000 });

  if (!hasOptions) return <EmptyNote>{symbol} has no options chain on free venues — open the Perps & Market tab for live futures analytics.</EmptyNote>;

  const lv = levels.data;
  const lvs = scope === '0dte' ? lv?.levels0dte : lv?.levels;
  const maxGex = Math.max(...(strike.data?.topStrikes ?? []).map((s) => Math.abs(s.netGex)), 1);

  return (
    <div className="space-y-2">
      <ErrNote error={levels.error} />
      <Dock viewId="quant-gex" layout="grid">
      {lv && lvs && (
        <DockPanel
          id="levels"
          title="Dealer Key Levels"
          sub={scope === '0dte' ? '0DTE (front expiry)' : 'all-expiry'}
          right={
            <>
              <Segmented value={scope} onChange={setScope} options={[{ id: 'all', label: 'All' }, { id: '0dte', label: '0DTE' }]} />
              <Pill tone={lvs.regime === 'long-gamma' ? 'emerald' : 'rose'}>{lvs.regime}</Pill>
            </>
          }
        >
          <StatGrid
            stats={[
              { label: 'spot', value: fmtNum(lv.spot, lv.spot >= 1000 ? 0 : 2), sub: 'deribit index' },
              { label: 'gamma flip · hvl', value: lvs.hvl != null ? fmtNum(lvs.hvl, 0) : '—', tone: 'teal', sub: 'cumulative gex zero-cross' },
              { label: 'call wall', value: lvs.callWall != null ? fmtNum(lvs.callWall, 0) : '—', tone: 'amber', sub: 'largest +gex strike' },
              { label: 'put support', value: lvs.putSupport != null ? fmtNum(lvs.putSupport, 0) : '—', tone: 'rose', sub: 'largest −gex strike' },
              { label: 'max pain', value: lvs.maxPain != null ? fmtNum(lvs.maxPain, 0) : '—', sub: 'expiry pin magnet' },
              { label: 'net gex', value: fmtUsd(lvs.totalGexUsd1pct, { compact: true, sign: true }), sub: 'USD per 1% move', tone: lvs.totalGexUsd1pct >= 0 ? 'emerald' : 'rose' },
              { label: 'call gex', value: fmtUsd(lvs.callGexUsd1pct, { compact: true }), sub: 'USD per 1% move' },
              { label: 'put gex', value: fmtUsd(lvs.putGexUsd1pct, { compact: true }), sub: 'USD per 1% move' },
            ]}
          />
          <p className="mt-2 text-[8.5px] leading-relaxed text-zinc-600">{lv.note}</p>
        </DockPanel>
      )}

      <DockPanel id="strike" title="GEX by Strike" sub="net dealer gamma per strike · USD / 1% move" right={<Pill tone="teal">live</Pill>} span={1}>
          {strike.data?.topStrikes?.length ? (
            <DivergingBars rows={strike.data.topStrikes.slice(0, 14).map((s) => ({ label: fmtNum(s.strike, 0), value: s.netGex, alt: `${fmtNum(s.callOi, 0)}c/${fmtNum(s.putOi, 0)}p` }))} unit="$" />
          ) : (
            <EmptyNote>{strike.loading ? 'computing…' : 'no strike data'}</EmptyNote>
          )}
        </DockPanel>

        <DockPanel id="ladder" title="Strike Ladder" sub="cumulative net gex around spot ±10%" span={1}>
          {ladder.data?.ladder?.length ? (
            <DivergingBars rows={ladder.data.ladder.slice(0, 16).map((s) => ({ label: fmtNum(s.strike, 0), value: s.cumNetGex }))} unit="$" />
          ) : (
            <EmptyNote>{ladder.loading ? 'computing…' : '—'}</EmptyNote>
          )}
        </DockPanel>

      <DockPanel id="heatmap" title="Strike × Expiry GEX Heatmap" sub="USD per 1% move · dealer-signed" right={<Pill>top 24 strikes × 12 expiries</Pill>}>
        {heat.data?.strikes?.length ? (
          <HeatMatrix
            rows={heat.data.strikes.slice(0, 24).map((s) => fmtNum(s, 0))}
            cols={heat.data.expiries.slice(0, 12).map((e) => e.slice(5))}
            values={heat.data.netGex.slice(0, 12).map((row) => row.slice(0, 24))}
            format={(v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}` : `${(v / 1e3).toFixed(0)}k`)}
          />
        ) : (
          <EmptyNote>{heat.loading ? 'computing…' : '—'}</EmptyNote>
        )}
      </DockPanel>

      <DockPanel id="session" title="Gamma Session" variant="bare">
        <GammaSessionPanel session={session.data} loading={session.loading} error={session.error} onRetry={session.refresh} minutes={sessionMinutes} onMinutes={setSessionMinutes} />
      </DockPanel>

      <DockPanel id="hist" title="Total GEX · 7d History" sub={hist.data?.meta?.unit ?? 'USD per 1% move'} right={<Pill>{hist.data?.meta?.snapshots ?? 0} snapshots</Pill>} span={1}>
          {hist.data?.points?.length ? (
            <LineChart
              height={150}
              yFormat={(v) => `${(v / 1e6).toFixed(1)}M`}
              series={[{ label: 'net gex', points: hist.data.points.map((p) => ({ x: p.ts, y: p.value })) }]}
              xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              yZero
            />
          ) : (
            <EmptyNote>history accrues every ~2 min — check back soon</EmptyNote>
          )}
        </DockPanel>

        <DockPanel id="flow" title="Estimated Dealer Hedge Flow" sub="−GEX × Δspot% from snapshots" right={<Pill tone="amber">estimate</Pill>} span={1}>
          {flow.data?.points?.length ? (
            <LineChart
              height={150}
              yFormat={(v) => `${(v / 1e6).toFixed(1)}M`}
              series={[{ label: 'hedge flow', points: flow.data.points.map((p) => ({ x: p.ts, y: p.hedgeFlowUsd })) }]}
              xFormat={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              yZero
            />
          ) : (
            <EmptyNote>{flow.loading ? 'loading…' : 'needs ≥2 snapshots'}</EmptyNote>
          )}
          <ChartLegend series={[{ label: 'positive = dealers sold into rally', color: '#2dd4bf' }]} />
        </DockPanel>
      </Dock>
      <p className="text-[8.5px] text-zinc-600">
        Model: dealers short customer calls / long puts on the live Deribit chain — the standard dealer-positioning convention. All values in USD per 1% spot move.
      </p>
    </div>
  );
}

/** Compact cross-symbol table for the overview tab. */
export function MultiSymbolTable() {
  const { data } = useQuant<{ symbols: { symbol: string; spot: number; hvl: number | null; callWall: number | null; putSupport: number | null; totalGexUsd1pct: number; regime: string; atmIv30Pct: number; putCallRatioOi: number }[] }>('/gex', { view: 'multi' }, { pollMs: 15000 });
  if (!data?.symbols?.length) return <EmptyNote>loading cross-symbol levels…</EmptyNote>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[9.5px]">
        <thead>
          <tr className="border-b border-zinc-800/70 text-[8px] uppercase tracking-[0.1em] text-zinc-600">
            {['sym', 'spot', 'hvl', 'call wall', 'put support', 'net gex', 'regime', 'cm30 iv', 'pcr'].map((h) => (
              <th key={h} className="px-1.5 py-1 text-right font-semibold first:text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.symbols.map((s) => (
            <tr key={s.symbol} className="border-b border-zinc-900/60 hover:bg-zinc-900/40">
              <td className="px-1.5 py-1 text-left font-mono font-semibold text-teal-300">{s.symbol}</td>
              <td className="px-1.5 py-1 text-right font-mono text-zinc-200">{fmtNum(s.spot, 0)}</td>
              <td className="px-1.5 py-1 text-right font-mono text-zinc-300">{s.hvl != null ? fmtNum(s.hvl, 0) : '—'}</td>
              <td className="px-1.5 py-1 text-right font-mono text-amber-300">{s.callWall != null ? fmtNum(s.callWall, 0) : '—'}</td>
              <td className="px-1.5 py-1 text-right font-mono text-rose-300">{s.putSupport != null ? fmtNum(s.putSupport, 0) : '—'}</td>
              <td className={`px-1.5 py-1 text-right font-mono ${s.totalGexUsd1pct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtUsd(s.totalGexUsd1pct, { compact: true, sign: true })}</td>
              <td className="px-1.5 py-1 text-right"><Pill tone={s.regime === 'long-gamma' ? 'emerald' : 'rose'}>{s.regime}</Pill></td>
              <td className="px-1.5 py-1 text-right font-mono text-zinc-300">{Number.isFinite(s.atmIv30Pct) ? `${s.atmIv30Pct.toFixed(1)}%` : '—'}</td>
              <td className="px-1.5 py-1 text-right font-mono text-zinc-300">{Number.isFinite(s.putCallRatioOi) ? s.putCallRatioOi.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── gamma session — net dealer gamma × time, canvas ──────────────────────────

interface SessionHover {
  x: number;
  y: number;
  strike: number;
  ts: number;
  netGex: number;
  spot: number;
  zeroGamma: number | null;
}

function GammaSessionPanel({
  session,
  loading,
  error,
  onRetry,
  minutes,
  onMinutes,
}: {
  session: SessionData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  minutes: 60 | 120 | 240;
  onMinutes: (m: 60 | 120 | 240) => void;
}) {
  const cols = session?.times.length ?? 0;
  return (
    <Panel
      title="Gamma Session — net dealer gamma through the session"
      sub="strike × time · USD per 1% move · amber = zero-gamma flip · white = spot trace"
      right={
        <>
          <Segmented
            value={String(minutes)}
            onChange={(v) => onMinutes(Number(v) as 60 | 120 | 240)}
            options={[{ id: '60', label: '1h' }, { id: '120', label: '2h' }, { id: '240', label: '4h' }]}
          />
          {session && <Pill tone={session.regime === 'long-gamma' ? 'emerald' : 'rose'}>{session.regime ?? '—'}</Pill>}
          {cols > 0 && <LiveDot ok={!error} label={`${cols} samples`} />}
        </>
      }
    >
      <PanelState
        loading={!session && loading}
        error={error}
        onRetry={onRetry}
        skeletonRows={10}
        skeletonCols={16}
        empty={session && session.times.length === 0 ? 'session sampler warming — one column accrues per minute while this view is open' : undefined}
      >
        {session && session.times.length > 0 && (
          <div className="space-y-2.5">
            <GammaSessionCanvas data={session} />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <HeatLegend min={-session.maxAbs} max={session.maxAbs} label="net gex $/1%" n={5} />
              <p className="text-[8.5px] text-zinc-600">{session.note}</p>
            </div>
          </div>
        )}
      </PanelState>
    </Panel>
  );
}

function GammaSessionCanvas({ data }: { data: SessionData }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<SessionHover | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(280, r.width), h: Math.max(200, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // plot geometry memo — shared by draw + hover pick
  const geo = useMemo(() => {
    const GL = 52; // left gutter: strike labels
    const GB = 18; // bottom gutter: time labels
    const rows = data.strikes.length;
    const cols = data.times.length;
    const plotW = Math.max(10, size.w - GL - 8);
    const plotH = Math.max(10, size.h - GB - 8);
    const colW = plotW / Math.max(1, cols);
    const rowH = plotH / Math.max(1, rows);
    // continuous y for a strike: interpolate between the row centers
    const yOf = (strike: number): number => {
      const st = data.strikes;
      if (!st.length) return plotH / 2;
      if (st.length === 1) return rowH / 2;
      if (strike <= st[0]) return rowH / 2;
      if (strike >= st[st.length - 1]) return plotH - rowH / 2;
      for (let i = 0; i < st.length - 1; i++) {
        if (strike >= st[i] && strike <= st[i + 1]) {
          const f = st[i + 1] === st[i] ? 0 : (strike - st[i]) / (st[i + 1] - st[i]);
          return (i + f) * rowH + rowH / 2;
        }
      }
      return plotH - rowH / 2;
    };
    return { GL, GB, rows, cols, colW, rowH, plotW, plotH, yOf };
  }, [data, size]);

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

    const { GL, GB, rows, cols, colW, rowH, plotW, plotH, yOf } = geo;

    // cells
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const v = data.netGex[c]?.[r];
        ctx.fillStyle = Number.isFinite(v) ? divergingColor(v, data.maxAbs || 1) : 'rgba(39,39,42,0.30)';
        ctx.fillRect(GL + c * colW + 0.5, r * rowH + 0.5, Math.max(1, colW - 1), Math.max(1, rowH - 1));
      }
    }

    // plot frame
    ctx.strokeStyle = 'rgba(63,63,70,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(GL + 0.5, 0.5, plotW, plotH);

    // strike labels (every other row when dense)
    ctx.font = '500 8px var(--font-geist-mono), ui-monospace, monospace';
    ctx.fillStyle = 'rgba(161,161,170,0.85)';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const step = rows > 18 ? 2 : 1;
    for (let r = 0; r < rows; r += step) {
      ctx.fillText(fmtNum(data.strikes[r], 0), GL - 6, r * rowH + rowH / 2);
    }

    // time labels (first / middle / last)
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(113,113,122,0.9)';
    if (cols > 0) {
      const fmt = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const spots = [0, Math.floor((cols - 1) / 2), cols - 1];
      for (const c of spots) ctx.fillText(fmt(data.times[c]), GL + c * colW + colW / 2, plotH + GB / 2 + 2);
    }

    // zero-gamma line (amber, dashed) + spot trace (white, thin)
    const line = (vals: (number | null)[], color: string, width: number, dash?: number[]) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      let open = false;
      for (let c = 0; c < cols; c++) {
        const v = vals[c];
        if (v == null || !Number.isFinite(v)) {
          open = false;
          continue;
        }
        const x = GL + c * colW + colW / 2;
        const y = yOf(v);
        if (!open) {
          ctx.moveTo(x, y);
          open = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };
    line(data.zeroGamma, 'rgba(251,191,36,0.95)', 1.6, [5, 3]);
    line(data.spot.map((v) => v), 'rgba(244,244,245,0.9)', 1.2);

    // right-edge current values
    ctx.textAlign = 'left';
    const lastZ = data.zeroGamma[cols - 1];
    if (lastZ != null && Number.isFinite(lastZ)) {
      ctx.fillStyle = 'rgba(251,191,36,0.95)';
      ctx.fillText(fmtNum(lastZ, 0), GL + plotW + 4, yOf(lastZ));
    }
    const lastS = data.spot[cols - 1];
    if (Number.isFinite(lastS)) {
      ctx.fillStyle = 'rgba(244,244,245,0.95)';
      ctx.fillText(fmtNum(lastS, 0), GL + plotW + 4, yOf(lastS));
    }
  }, [data, size, geo]);

  useEffect(() => {
    draw();
  }, [draw]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>): SessionHover | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const { GL, cols, colW, rows, rowH } = geo;
    if (cols === 0 || rows === 0) return null;
    const c = Math.max(0, Math.min(cols - 1, Math.floor((x - GL) / colW)));
    const rr = Math.max(0, Math.min(rows - 1, Math.floor(y / rowH)));
    return {
      x: e.clientX,
      y: e.clientY,
      strike: data.strikes[rr],
      ts: data.times[c],
      netGex: data.netGex[c]?.[rr] ?? NaN,
      spot: data.spot[c],
      zeroGamma: data.zeroGamma[c],
    };
  };

  return (
    <div ref={wrapRef} className="relative h-[300px] w-full">
      <canvas
        ref={canvasRef}
        className="cursor-crosshair"
        onMouseMove={(e) => {
          const hit = pick(e);
          setHover(hit && Number.isFinite(hit.netGex) ? hit : hit ? { ...hit, netGex: NaN } : null);
        }}
        onMouseLeave={() => setHover(null)}
      />
      {hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 shadow-xl"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 210), top: hover.y + 12 }}
        >
          <p className="font-mono text-[11px] font-bold text-zinc-100">{fmtNum(hover.strike, 0)}</p>
          <p className="font-mono text-[9px] text-zinc-400">
            {new Date(hover.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </p>
          {Number.isFinite(hover.netGex) ? (
            <p className={`font-mono text-[9px] ${hover.netGex >= 0 ? 'text-teal-300' : 'text-rose-300'}`}>
              net gex {fmtUsd(hover.netGex, { compact: true, sign: true })}/1%
            </p>
          ) : (
            <p className="font-mono text-[9px] text-zinc-600">no mark at this strike that minute</p>
          )}
          <p className="font-mono text-[9px] text-zinc-400">spot {fmtNum(hover.spot, 0)}</p>
          {hover.zeroGamma != null && <p className="font-mono text-[9px] text-amber-300">zero-gamma {fmtNum(hover.zeroGamma, 0)}</p>}
        </div>
      )}
    </div>
  );
}

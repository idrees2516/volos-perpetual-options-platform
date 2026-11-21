'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — OptionsPanel. The Strategy Lab bridge (EXPERIMENTAL).
//
// The 131-strategy options catalog wired straight into the unified studio:
// pick a structure, resolve its legs against the chart's own dataset, preview
// the expiry payoff, then COMPILE it into VolScript. The generated script
// applies to the price chart above (Black-Scholes marks, structure P&L in the
// sub pane), its code lands in the Pine editor below, and the AI desk can
// rewrite it from there. Options strategies stop being a separate feature —
// they become scripts in the same pipeline.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Sparkles, Zap, ArrowRight, Info, ChevronRight, CornerDownLeft,
} from 'lucide-react';
import {
  STRATEGIES, CATEGORY_META, VIEW_META, strategyById,
  type StrategyCategory, type StrategySpec,
} from '@/lib/strategies';
import { compileStrategyToScript, buildBridgePreview } from '@/lib/scriptlang/options-bridge';
import { useScriptLab } from '@/stores/scriptlab-store';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';

const KIND_CHIP: Record<string, string> = {
  call: 'C', put: 'P', perp_option: '∞', perp: 'F', spot: 'S',
};

const CAT_FILTERS: { id: 'all' | StrategyCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  ...(Object.keys(CATEGORY_META) as StrategyCategory[]).map((k) => ({ id: k, label: CATEGORY_META[k].label })),
];

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100_000) return v.toFixed(0);
  if (a >= 1_000) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}

function stars(n: number): string {
  return '●'.repeat(n) + '○'.repeat(Math.max(0, 5 - n));
}

export function OptionsPanel() {
  const {
    bars, symbol, tf, loadScript, rerun, setBottomTab,
    replayActive, replayIdx,
  } = useScriptLab();

  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<'all' | StrategyCategory>('all');
  const [selectedId, setSelectedId] = useState('long-call');
  const [iv, setIv] = useState(0.6);
  const [entryBar, setEntryBar] = useState(0);

  const n = bars?.length ?? 0;
  const entryIdx = Math.max(0, Math.min(n - 1, entryBar));
  const entrySpot = bars && n > 0 ? bars[entryIdx].c : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return STRATEGIES.filter((s) => {
      if (cat !== 'all' && s.category !== cat) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.id.includes(q) ||
        s.tags.some((t) => t.includes(q))
      );
    });
  }, [query, cat]);

  const spec: StrategySpec | undefined = useMemo(() => strategyById(selectedId), [selectedId]);

  const preview = useMemo(
    () => (spec && entrySpot && entrySpot > 0 ? buildBridgePreview(spec, { entrySpot, iv }) : null),
    [spec, entrySpot, iv],
  );

  // ── payoff-at-expiry mini chart (canvas, redraws with the preview) ───────
  const payoffRef = useRef<HTMLCanvasElement>(null);
  const payoffWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cv = payoffRef.current;
    const wrap = payoffWrapRef.current;
    if (!cv || !wrap || !preview) return;
    const w = Math.max(260, wrap.clientWidth);
    const h = 128;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const vals = preview.payoff.map((p) => p.value);
    let lo = Math.min(...vals, 0);
    let hi = Math.max(...vals, 0);
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const pad = (hi - lo) * 0.08;
    hi += pad;
    lo -= pad;
    const x = (i: number) => (w * (i + 0.5)) / preview.payoff.length;
    const y = (v: number) => h - 8 - ((v - lo) / (hi - lo)) * (h - 18);

    // zero line
    ctx.strokeStyle = 'rgba(63,63,70,0.6)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y(0) + 0.5);
    ctx.lineTo(w, y(0) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // payoff curve + fill
    ctx.beginPath();
    preview.payoff.forEach((p, i) => {
      if (i === 0) ctx.moveTo(x(0), y(p.value));
      else ctx.lineTo(x(i), y(p.value));
    });
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(w, y(0));
    ctx.lineTo(0, y(0));
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(45,212,191,0.16)');
    grad.addColorStop(1, 'rgba(45,212,191,0.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    // entry-spot marker
    const t = (preview.entrySpot - preview.gridMin) / (preview.gridMax - preview.gridMin);
    if (t > 0 && t < 1) {
      ctx.strokeStyle = 'rgba(251,191,36,0.75)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(t * w, 2);
      ctx.lineTo(t * w, h - 6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(251,191,36,0.9)';
      ctx.font = '600 8.5px var(--font-geist-mono), ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('entry spot', Math.min(t * w + 4, w - 48), 10);
    }

    // breakeven dots
    ctx.fillStyle = '#fbbf24';
    for (const be of preview.breakevens) {
      const bt = (be - preview.gridMin) / (preview.gridMax - preview.gridMin);
      if (bt > 0 && bt < 1) {
        ctx.beginPath();
        ctx.arc(bt * w, y(0), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // grid bounds labels
    ctx.fillStyle = '#71717a';
    ctx.font = '500 8px var(--font-geist-mono), ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(fmtNum(preview.gridMin), 2, h - 1);
    ctx.textAlign = 'right';
    ctx.fillText(fmtNum(preview.gridMax), w - 2, h - 1);
  }, [preview]);

  // ── apply: compile → load → run → reveal the code below the chart ─────────
  const apply = () => {
    if (!spec) return;
    const code = compileStrategyToScript(spec, { iv, entryBar: entryIdx });
    loadScript({
      name: `${spec.name} — options bridge`,
      code,
      category: 'options',
      description: spec.description,
    });
    if (bars) setTimeout(() => rerun({ code, inputs: {} }), 0);
    setBottomTab('editor');
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ── picker ────────────────────────────────────────────────────────── */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-zinc-800/70 bg-zinc-950/40">
        <div className="flex items-center gap-1.5 border-b border-zinc-800/70 px-3 py-2">
          <Zap className="h-3.5 w-3.5 text-violet-400" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300">Strategy Lab catalog</span>
          <span className="ml-auto rounded bg-violet-950/60 px-1.5 py-px font-mono text-[8px] font-bold text-violet-300 ring-1 ring-violet-500/30">
            {filtered.length}/{STRATEGIES.length}
          </span>
        </div>
        <div className="border-b border-zinc-800/70 px-2 py-1.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search 131 structures…"
              className="h-6 border-zinc-800 bg-zinc-950 pl-6 text-[10px]"
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {CAT_FILTERS.map((c) => (
              <button
                key={c.id}
                onClick={() => setCat(c.id)}
                className={`rounded-full px-1.5 py-px text-[8.5px] font-semibold transition ${
                  cat === c.id
                    ? 'bg-violet-950/70 text-violet-300 ring-1 ring-violet-500/40'
                    : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.map((s) => {
            const active = s.id === selectedId;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                onDoubleClick={apply}
                className={`flex w-full items-center gap-2 border-b border-zinc-900/60 px-2.5 py-1.5 text-left transition ${
                  active ? 'bg-violet-950/30' : 'hover:bg-zinc-900/50'
                }`}
              >
                <span className={`font-mono text-[8px] ${VIEW_META[s.view]?.color ?? 'text-zinc-400'}`}>
                  {VIEW_META[s.view]?.label ?? s.view}
                </span>
                <span className={`min-w-0 flex-1 truncate text-[10px] ${active ? 'text-zinc-100' : 'text-zinc-400'}`}>
                  {s.name}
                </span>
                <span className="shrink-0 font-mono text-[8px] text-zinc-600">
                  {s.legs.length}L · <span className="text-amber-400/70">{stars(s.complexity)}</span>
                </span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-[9px] text-zinc-600">no strategies match this filter</p>
          )}
        </div>
      </aside>

      {/* ── detail ─────────────────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1 overflow-y-auto p-3">
        {!spec || !preview ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
            <p className="text-[11px]">{n === 0 ? 'no bars loaded — pick a symbol in the toolbar' : 'select a strategy from the catalog'}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* header */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-[13px] font-bold text-zinc-100">{spec.name}</h3>
              <span className={`rounded-full px-1.5 py-px text-[8px] font-bold uppercase tracking-wider ring-1 ring-inset ${VIEW_META[spec.view]?.color ?? 'text-zinc-400'} bg-zinc-900 ring-zinc-700`}>
                {VIEW_META[spec.view]?.label ?? spec.view}
              </span>
              <span className="rounded-full bg-zinc-900 px-1.5 py-px text-[8px] font-semibold uppercase tracking-wider text-zinc-400 ring-1 ring-inset ring-zinc-700">
                {CATEGORY_META[spec.category].label}
              </span>
              <span className="ml-auto flex items-center gap-1 rounded-full bg-amber-950/50 px-1.5 py-px text-[8px] font-bold uppercase tracking-[0.12em] text-amber-300 ring-1 ring-amber-500/30">
                experimental
              </span>
            </div>
            <p className="max-w-3xl text-[10.5px] leading-relaxed text-zinc-400">{spec.description}</p>

            {/* legs */}
            <div className="overflow-hidden rounded-lg border border-zinc-800/80">
              <table className="w-full text-left font-mono text-[9.5px]">
                <thead className="bg-zinc-950/80 text-[8px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-2 py-1 font-semibold">#</th>
                    <th className="px-2 py-1 font-semibold">kind</th>
                    <th className="px-2 py-1 font-semibold">side</th>
                    <th className="px-2 py-1 font-semibold">qty</th>
                    <th className="px-2 py-1 font-semibold">strike ×entry</th>
                    <th className="px-2 py-1 font-semibold">abs strike</th>
                    <th className="px-2 py-1 font-semibold">expiry</th>
                    <th className="px-2 py-1 text-right font-semibold">entry mark</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.legs.map((l, i) => (
                    <tr key={i} className="border-t border-zinc-900 text-zinc-300">
                      <td className="px-2 py-1 text-zinc-600">{i + 1}</td>
                      <td className="px-2 py-1">
                        <span className="rounded bg-zinc-800/80 px-1 font-bold text-zinc-200">{KIND_CHIP[l.kind] ?? l.kind}</span>
                        <span className="ml-1 text-[8.5px] text-zinc-500">{l.kind.replace('_', ' ')}</span>
                      </td>
                      <td className={`px-2 py-1 font-bold ${l.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{l.side}</td>
                      <td className="px-2 py-1">{l.qty}</td>
                      <td className="px-2 py-1 text-zinc-400">{l.mult.toFixed(2)}×</td>
                      <td className="px-2 py-1">{fmtNum(l.strikeAbs)}</td>
                      <td className="px-2 py-1 text-zinc-400">
                        {l.expiryDays !== undefined ? `${l.expiryDays} d` : l.fundingDays !== undefined ? `everlasting · ${l.fundingDays} d funding` : l.kind === 'perp' || l.kind === 'spot' ? 'linear' : '—'}
                      </td>
                      <td className="px-2 py-1 text-right text-zinc-200">{fmtNum(l.entryMark)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* config */}
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-2.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <label className="flex items-center gap-2 text-[9.5px] text-zinc-400">
                  <span className="font-semibold text-zinc-300">iv</span>
                  <Slider
                    value={[iv]}
                    min={0.1}
                    max={2.0}
                    step={0.05}
                    onValueChange={(v) => setIv(v[0])}
                    className="w-[110px]"
                  />
                  <span className="w-[52px] font-mono text-zinc-200">{(iv * 100).toFixed(0)}%</span>
                </label>
                <label className="flex items-center gap-2 text-[9.5px] text-zinc-400">
                  <span className="font-semibold text-zinc-300">entry bar</span>
                  <Input
                    type="number"
                    min={0}
                    max={Math.max(0, n - 1)}
                    value={entryIdx}
                    onChange={(e) => setEntryBar(Number(e.target.value))}
                    className="h-6 w-[64px] border-zinc-800 bg-zinc-950 text-[10px]"
                  />
                </label>
                <div className="flex items-center gap-1">
                  <button onClick={() => setEntryBar(0)} className="rounded border border-zinc-800 px-1.5 py-0.5 text-[8.5px] text-zinc-400 transition hover:text-zinc-200" title="Open the structure at the first bar of the window">
                    first
                  </button>
                  <button onClick={() => setEntryBar(Math.max(0, n - 1))} className="rounded border border-zinc-800 px-1.5 py-0.5 text-[8.5px] text-zinc-400 transition hover:text-zinc-200" title="Open the structure at the last bar">
                    last
                  </button>
                  {replayActive && (
                    <button
                      onClick={() => setEntryBar(replayIdx)}
                      className="rounded border border-amber-500/40 bg-amber-950/40 px-1.5 py-0.5 text-[8.5px] font-bold text-amber-300 transition hover:bg-amber-900/40"
                      title="Open the structure at the bar-replay cursor — then step the tape and watch the structure's P&L evolve"
                    >
                      replay cursor {replayIdx + 1}
                    </button>
                  )}
                </div>
                <span className="ml-auto font-mono text-[9px] text-zinc-500">
                  entry spot <span className="text-zinc-200">{entrySpot ? fmtNum(entrySpot) : '—'}</span>
                  {replayActive && <span className="ml-1.5 text-amber-400/80">(replay active)</span>}
                </span>
              </div>
              <p className="mt-1.5 flex items-start gap-1 text-[8.5px] leading-relaxed text-zinc-500">
                <Info className="mt-px h-2.5 w-2.5 shrink-0" />
                resolved against the studio dataset ({symbol} · {tf} · {n} bars). entry marks are Black-Scholes at the iv above (r = 0, flat across strikes); linear legs carry no funding.
              </p>
            </div>

            {/* payoff + stats */}
            <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
              <div ref={payoffWrapRef} className="relative overflow-hidden rounded-lg border border-zinc-800/80 bg-[#05070c]">
                <p className="absolute left-2 top-1.5 z-[1] text-[8.5px] font-bold uppercase tracking-wider text-zinc-400">
                  payoff at expiry <span className="font-normal normal-case text-zinc-600">· grid ±60% · per 1 structure · incl. entry premium</span>
                </p>
                <canvas ref={payoffRef} className="block" />
              </div>
              <div className="space-y-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-2.5 font-mono text-[9.5px]">
                <p className="text-[8.5px] font-bold uppercase tracking-wider text-zinc-500">structure economics</p>
                <p className="flex justify-between text-zinc-400">
                  net premium
                  <span className={preview.netPremium <= 0 ? 'text-rose-300' : 'text-emerald-300'}>
                    {preview.netPremium <= 0 ? 'debit ' : 'credit '}
                    {fmtNum(Math.abs(preview.netPremium))}
                  </span>
                </p>
                <p className="flex justify-between text-zinc-400">
                  breakevens
                  <span className="text-zinc-200">{preview.breakevens.length ? preview.breakevens.map((b) => fmtNum(b)).join(' / ') : 'none in grid'}</span>
                </p>
                <p className="flex justify-between text-zinc-400">
                  max profit <span className="text-emerald-300">+{fmtNum(preview.maxProfit)}</span>
                </p>
                <p className="flex justify-between text-zinc-400">
                  max loss <span className="text-rose-300">{fmtNum(preview.maxLoss)}</span>
                </p>
                <div className="mt-1 border-t border-zinc-800/70 pt-1.5">
                  {preview.notes.map((note, i) => (
                    <p key={i} className="flex items-start gap-1 text-[8px] leading-relaxed text-zinc-600">
                      <span className="text-amber-500/60">▲</span>
                      {note}
                    </p>
                  ))}
                </div>
              </div>
            </div>

            {/* apply */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-teal-500/20 bg-teal-950/10 p-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 text-[10px] font-bold text-teal-200">
                  <Sparkles className="h-3 w-3" />
                  compile this structure into VolScript
                </p>
                <p className="mt-0.5 text-[9px] leading-relaxed text-zinc-400">
                  the generated script applies to the chart above — structure P&L in the sub pane, entry marked with a diamond —
                  its code lands in the Pine editor, and the AI desk can rewrite any leg from there.
                </p>
              </div>
              <button
                onClick={apply}
                className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-[10px] font-bold text-zinc-950 shadow transition hover:bg-teal-500"
                title="Compile into VolScript and apply to the chart (double-click a catalog row does the same)"
              >
                apply to chart
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="flex items-center gap-1 text-[8px] text-zinc-600">
              <ChevronRight className="h-2.5 w-2.5" />
              double-click a catalog row applies it instantly
              <CornerDownLeft className="ml-1 h-2.5 w-2.5" />
              iv + entry bar stay editable as script inputs after the compile
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

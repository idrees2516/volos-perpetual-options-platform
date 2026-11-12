'use client';

// -----------------------------------------------------------------------------
// quantlab/panels-signals — SIGNALS & DECISIONS: the live decision brief.
// Regime gauge, the full signal battery (each with strength, detail and an
// ACTION), the strategy playbook with concrete strikes, and the watchlist.
// This panel is the "better decision making" surface — everything computed
// by /api/quant/signals from live venue data, polled every 10s.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import { fmtUsd, fmtNum } from '@/lib/format';
import { useQuant, useAgeLabel } from './use-quant';
import { EmptyNote, ErrNote, LiveDot, Panel, Pill, Segmented, StatGrid } from './quant-viz';
import { Gauge, StrengthMeter } from './viz-deep';

interface Signal {
  id: string;
  group: 'Gamma' | 'Volatility' | 'Flow' | 'Perps' | 'Structure';
  title: string;
  state: 'bullish' | 'bearish' | 'neutral' | 'extreme-bullish' | 'extreme-bearish';
  strength: number;
  headline: string;
  detail: string;
  action: string;
}
interface Playbook {
  id: string;
  title: string;
  setup: string;
  rationale: string;
  confidence: number;
  tags: string[];
}
interface Brief {
  symbol: string;
  asOf: number;
  spot: number;
  regimeScore: number;
  regimeLabel: string;
  volBias: 'expansion' | 'compression' | 'balanced';
  signals: Signal[];
  playbook: Playbook[];
  watchlist: { id: string; label: string; price: number | null; kind: string; distancePct: number | null; note: string; tone: string }[];
  drivers: { label: string; contribution: number }[];
  context: { ivRank: number | null; ivWindowDays: number; ivPoints: number; fundingPctile: number | null; snapshots: number };
  notes: string[];
}

const STATE_CHIP: Record<string, { label: string; cls: string }> = {
  'extreme-bullish': { label: 'STRONG BULL', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40' },
  bullish: { label: 'BULLISH', cls: 'bg-emerald-500/10 text-emerald-300/90 ring-emerald-500/25' },
  neutral: { label: 'NEUTRAL', cls: 'bg-zinc-500/10 text-zinc-400 ring-zinc-600/40' },
  bearish: { label: 'BEARISH', cls: 'bg-rose-500/10 text-rose-300/90 ring-rose-500/25' },
  'extreme-bearish': { label: 'STRONG BEAR', cls: 'bg-rose-500/15 text-rose-300 ring-rose-500/40' },
};

export function SignalsPanel({ symbol }: { symbol: string }) {
  const brief = useQuant<Brief>('/signals', { symbol }, { pollMs: 10000 });
  const [group, setGroup] = useState<'all' | 'Gamma' | 'Volatility' | 'Flow' | 'Perps'>('all');
  const age = useAgeLabel(brief.fetchedAt);
  const d = brief.data;

  const signals = (d?.signals ?? []).filter((s) => group === 'all' || s.group === group);
  const bulls = (d?.signals ?? []).filter((s) => s.state.includes('bull')).length;
  const bears = (d?.signals ?? []).filter((s) => s.state.includes('bear')).length;

  return (
    <div className="space-y-2">
      <ErrNote error={brief.error} />
      {!d && brief.loading && <EmptyNote>computing the live signal battery — first run takes a few seconds…</EmptyNote>}
      {d && (
        <>
          <div className="grid gap-2 xl:grid-cols-[minmax(280px,340px)_1fr]">
            {/* ── regime card ── */}
            <Panel
              title={`${symbol} Regime`}
              sub="composite of every live signal"
              right={<LiveDot ok={!brief.error} label={`live · ${age}`} />}
            >
              <Gauge score={d.regimeScore} label={d.regimeLabel} />
              <div className="mt-3">
                <StatGrid
                  cols={2}
                  stats={[
                    { label: 'spot', value: fmtNum(d.spot, d.spot >= 1000 ? 0 : 2) },
                    { label: 'vol bias', value: d.volBias === 'expansion' ? 'EXPANSION' : d.volBias === 'compression' ? 'COMPRESSION' : 'BALANCED', tone: d.volBias === 'expansion' ? 'rose' : d.volBias === 'compression' ? 'amber' : 'zinc' },
                    { label: 'bull vs bear', value: `${bulls} / ${bears}`, sub: `${d.signals.length} signals live` },
                    { label: 'iv rank', value: d.context.ivRank != null ? `${d.context.ivRank}/100` : '—', tone: d.context.ivRank != null && d.context.ivRank >= 65 ? 'amber' : d.context.ivRank != null && d.context.ivRank <= 35 ? 'emerald' : 'zinc', sub: `${d.context.ivPoints} snapshots` },
                  ]}
                />
              </div>
              {d.drivers.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-600">top score drivers</p>
                  {d.drivers.slice(0, 5).map((dr) => (
                    <div key={dr.label} className="flex items-center gap-2">
                      <span className="w-[150px] shrink-0 truncate text-[8.5px] text-zinc-500" title={dr.label}>
                        {dr.label}
                      </span>
                      <div className="relative h-2 flex-1 rounded-sm bg-zinc-900">
                        <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
                        <div
                          className={`absolute top-0 h-full rounded-sm ${dr.contribution >= 0 ? 'left-1/2 bg-emerald-500/70' : 'right-1/2 bg-rose-500/70'}`}
                          style={{ width: `${Math.min(50, Math.abs(dr.contribution) * 90)}%` }}
                        />
                      </div>
                      <span className={`w-10 shrink-0 text-right font-mono text-[8.5px] ${dr.contribution >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {dr.contribution >= 0 ? '+' : ''}
                        {dr.contribution.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            {/* ── playbook ── */}
            <Panel title="Strategy Playbook" sub="rule-based setups with live numbers — the reason you don't need another platform" right={<Pill tone="violet">{d.playbook.length} setups</Pill>}>
              {d.playbook.length ? (
                <div className="space-y-2">
                  {d.playbook.map((p, i) => (
                    <div key={p.id} className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[8px] font-bold text-violet-300">#{i + 1}</span>
                        <h4 className="text-[11px] font-semibold text-zinc-100">{p.title}</h4>
                        <span className="ml-auto flex items-center gap-1">
                          <span className="text-[8px] uppercase tracking-[0.1em] text-zinc-600">conf</span>
                          <span className={`font-mono text-[10px] font-bold ${p.confidence >= 0.7 ? 'text-emerald-300' : p.confidence >= 0.55 ? 'text-teal-300' : 'text-zinc-300'}`}>{(p.confidence * 100).toFixed(0)}%</span>
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[9.5px] leading-relaxed text-teal-200/90">{p.setup}</p>
                      <p className="mt-1 text-[9px] leading-relaxed text-zinc-400">{p.rationale}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {p.tags.map((t) => (
                          <span key={t} className="rounded bg-zinc-800/60 px-1 py-0.5 text-[7.5px] uppercase tracking-[0.1em] text-zinc-500">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyNote>no high-conviction setups right now — signals are mid-range; check the battery →</EmptyNote>
              )}
            </Panel>
          </div>

          {/* ── signal battery ── */}
          <Panel
            title="Signal Battery"
            sub="every live metric turned into a decision — hover for the full read"
            right={
              <Segmented
                value={group}
                onChange={setGroup}
                options={[
                  { id: 'all', label: `All ${d.signals.length}` },
                  { id: 'Gamma', label: 'Gamma' },
                  { id: 'Volatility', label: 'Vol' },
                  { id: 'Flow', label: 'Flow' },
                  { id: 'Perps', label: 'Perps' },
                ]}
              />
            }
          >
            <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
              {signals.map((s) => {
                const chip = STATE_CHIP[s.state] ?? STATE_CHIP.neutral;
                return (
                  <div key={s.id} className="group rounded-lg border border-zinc-800/70 bg-zinc-950/40 p-2.5 transition hover:border-zinc-700">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-zinc-800/60 px-1 py-0.5 text-[7px] font-bold uppercase tracking-[0.12em] text-zinc-500">{s.group}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[7.5px] font-bold uppercase tracking-[0.1em] ring-1 ${chip.cls}`}>{chip.label}</span>
                      <span className="ml-auto font-mono text-[8.5px] text-zinc-600">{s.strength}/100</span>
                    </div>
                    <h4 className="mt-1.5 text-[10.5px] font-semibold text-zinc-100">{s.title}</h4>
                    <p className="mt-0.5 font-mono text-[9px] text-teal-200/80">{s.headline}</p>
                    <div className="mt-1.5">
                      <StrengthMeter strength={s.strength} state={s.state} />
                    </div>
                    <p className="mt-1.5 text-[8.8px] leading-relaxed text-zinc-500">{s.detail}</p>
                    <p className="mt-1.5 rounded-md border border-teal-900/40 bg-teal-950/20 px-1.5 py-1 text-[8.8px] leading-relaxed text-teal-200/90">
                      <span className="font-bold uppercase tracking-[0.1em] text-teal-400/80">action · </span>
                      {s.action}
                    </p>
                  </div>
                );
              })}
            </div>
            {!signals.length && <EmptyNote>no signals in this group yet</EmptyNote>}
          </Panel>

          {/* ── watchlist ── */}
          <Panel title="Watchlist" sub="the levels that matter right now — set alerts around these on any other platform? not anymore" right={<Pill tone="amber">{d.watchlist.filter((w) => w.kind === 'price').length} levels</Pill>}>
            <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {d.watchlist.map((w) => (
                <div key={w.id} className="flex items-start gap-2 rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-2">
                  <span
                    className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${w.tone === 'teal' ? 'bg-teal-400' : w.tone === 'rose' ? 'bg-rose-400' : w.tone === 'amber' ? 'bg-amber-400' : w.tone === 'violet' ? 'bg-violet-400' : 'bg-zinc-500'}`}
                  />
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <p className="text-[9.5px] font-semibold text-zinc-200">{w.label}</p>
                      {w.price != null && <p className="font-mono text-[10px] font-bold text-zinc-100">{fmtNum(w.price, w.price >= 1000 ? 0 : 2)}</p>}
                      {w.distancePct != null && Number.isFinite(w.distancePct) && (
                        <p className={`font-mono text-[8.5px] ${w.distancePct >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
                          {w.distancePct >= 0 ? '+' : ''}
                          {w.distancePct.toFixed(2)}%
                        </p>
                      )}
                    </div>
                    <p className="mt-0.5 text-[8.5px] leading-snug text-zinc-500">{w.note}</p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {d.notes.length > 0 && d.notes.map((n) => <p key={n} className="text-[9px] text-zinc-600">{n}</p>)}
        </>
      )}
    </div>
  );
}

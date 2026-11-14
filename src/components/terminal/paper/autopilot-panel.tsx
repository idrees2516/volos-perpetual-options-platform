'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Autopilot panel — the AUTO-REBALANCE LOOP control surface of the Paper Desk.
//
// Live status (running / dry-run / live pill, cycle stats), every guard-rail
// control (enable, dry-run, interval, confidence gate, cooldown, max actions,
// which decisions may execute), one-click "run cycle now", the audit journal
// feed (executed vs planned entries with realized P&L) — and the MORNING BRIEF
// card: overnight recap, portfolio rollup, decision census, watchlist and the
// AI narrative, with generate-now and Ask-AI hand-off.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fmtNum, fmtUsd } from '@/lib/format';
import { useCopilot } from '@/stores/copilot-store';
import type { AutopilotJournalEntry, AutopilotSettings, AutopilotStats } from '@/lib/positions/autopilot';
import type { MorningBrief } from '@/lib/positions/morning-brief';
import {
  Bot,
  BrainCircuit,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Zap,
} from 'lucide-react';

interface StatusRes {
  ok: boolean;
  running: boolean;
  inFlight: boolean;
  startedAt: number | null;
  settings: AutopilotSettings;
  stats: AutopilotStats;
  journalCount: number;
  journal: AutopilotJournalEntry[];
}

const EXEC_LABELS: { key: keyof AutopilotSettings['execute']; label: string; hint: string }[] = [
  { key: 'takeProfit', label: 'Take-profit', hint: 'close at the management TP band' },
  { key: 'exit', label: 'Exit', hint: 'close on EXIT verdicts (stop-loss / thesis break)' },
  { key: 'roll', label: 'Roll', hint: 'close + re-deploy one cycle further out' },
  { key: 'adjust', label: 'Trim (ADJUST)', hint: 'partial trim on ADJUST verdicts' },
  { key: 'scaleIn', label: 'Scale-in', hint: 'add on SCALE_IN verdicts' },
];

const RESULT_STYLE: Record<string, string> = {
  closed: 'text-emerald-300',
  rolled: 'text-violet-300',
  trimmed: 'text-amber-300',
  scaled: 'text-teal-300',
  planned: 'text-sky-300',
  skipped: 'text-zinc-500',
  failed: 'text-rose-400',
};

export function AutopilotPanel() {
  const askAi = useCopilot((s) => s.askAi);
  const [data, setData] = useState<StatusRes | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [openCtl, setOpenCtl] = useState(false);
  const [openJournal, setOpenJournal] = useState(true);
  const [brief, setBrief] = useState<MorningBrief | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/positions/autopilot', { cache: 'no-store' });
      const j = (await r.json()) as StatusRes;
      if (j.ok) setData(j);
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBrief = useCallback(async () => {
    try {
      const r = await fetch('/api/positions/morning-brief', { cache: 'no-store' });
      const j = (await r.json()) as { ok: boolean; brief: MorningBrief | null };
      if (j.ok) setBrief(j.brief);
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadBrief();
  }, [load, loadBrief]);

  // poll faster while the loop is live so the journal visibly streams
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const ms = data?.settings.enabled ? 20_000 : 60_000;
    pollRef.current = setInterval(() => {
      void load();
      void loadBrief();
    }, ms);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [data?.settings.enabled, load, loadBrief]);

  const patch = useCallback(
    async (p: Record<string, unknown>) => {
      setBusy(JSON.stringify(p));
      try {
        const r = await fetch('/api/positions/autopilot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patch: p }),
        });
        const j = (await r.json()) as StatusRes & { ok: boolean; settings?: AutopilotSettings };
        if (j.ok && j.settings) setData((d) => (d ? { ...d, settings: j.settings!, stats: j.stats ?? d.stats, running: j.running ?? d.running } : j));
        await load();
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const runNow = useCallback(async () => {
    setBusy('run');
    try {
      const r = await fetch('/api/positions/autopilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run_now' }),
      });
      await r.json();
      await load();
    } finally {
      setBusy(null);
    }
  }, [load]);

  const genBrief = useCallback(async (includeAi: boolean) => {
    setBriefBusy(true);
    try {
      const r = await fetch('/api/positions/morning-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeAi }),
      });
      const j = (await r.json()) as { ok: boolean; brief: MorningBrief | null };
      if (j.ok && j.brief) setBrief(j.brief);
    } finally {
      setBriefBusy(false);
    }
  }, []);

  const s = data?.settings;
  const st = data?.stats;
  const mode = !s ? 'loading' : !s.enabled ? 'disabled' : s.dryRun ? 'dry-run' : 'live';
  const MODE: Record<string, { label: string; cls: string; dot: string }> = {
    loading: { label: '…', cls: 'bg-zinc-800/60 text-zinc-400 ring-zinc-600/40', dot: 'bg-zinc-500' },
    disabled: { label: 'OFF', cls: 'bg-zinc-800/60 text-zinc-400 ring-zinc-600/40', dot: 'bg-zinc-500' },
    'dry-run': { label: 'DRY-RUN', cls: 'bg-sky-950/60 text-sky-300 ring-sky-500/30', dot: 'bg-sky-400' },
    live: { label: 'LIVE', cls: 'bg-emerald-950/60 text-emerald-300 ring-emerald-500/30', dot: 'bg-emerald-400 animate-pulse' },
  };
  const m = MODE[mode];
  const journal = useMemo(() => data?.journal ?? [], [data]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      {/* header */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
          <Bot className="h-3.5 w-3.5 text-teal-400" /> Autopilot — auto-rebalance
        </span>
        <span className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[9px] font-bold tracking-wide ring-1 ${m.cls}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
          {m.label}
        </span>
        {data?.running && (
          <span className="flex items-center gap-1 text-[8.5px] text-zinc-500" title="Server-side singleton loop — started from instrumentation.ts">
            <CircleDot className="h-2.5 w-2.5 text-emerald-500" /> loop up · every {s?.intervalSec}s
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-6 border-zinc-700 px-2 text-[9px]"
            disabled={busy === 'run'}
            onClick={runNow}
            title="Evaluate every position now and apply the decisions (respects dry-run + guard rails)"
          >
            {busy === 'run' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run cycle
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => void load()} title="Refresh">
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </span>
      </div>

      {/* stats strip */}
      {st && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[9px] text-zinc-500">
          <span>cycles <span className="text-zinc-300">{st.cyclesRun}</span></span>
          <span>executed <span className="text-emerald-400">{st.actionsExecuted}</span></span>
          <span>planned <span className="text-sky-400">{st.actionsPlanned}</span></span>
          <span>errors <span className={st.errors > 0 ? 'text-rose-400' : 'text-zinc-300'}>{st.errors}</span></span>
          {st.lastCycleAt > 0 && (
            <span title={`duration ${st.lastCycleDurationMs}ms`}>
              last cycle <span className="text-zinc-300">{new Date(st.lastCycleAt).toLocaleTimeString()}</span>
            </span>
          )}
          {st.lastError && <span className="text-rose-400">last error: {st.lastError.slice(0, 60)}</span>}
        </div>
      )}

      {/* master controls */}
      {s && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1.5">
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider">
            <input
              type="checkbox"
              className="h-3 w-3 accent-teal-500"
              checked={s.enabled}
              disabled={busy === JSON.stringify({ enabled: true }) || busy === JSON.stringify({ enabled: false })}
              onChange={(e) => void patch({ enabled: e.target.checked })}
            />
            <span className={s.enabled ? 'text-emerald-400' : 'text-zinc-400'}>Enabled</span>
          </label>
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider">
            <input
              type="checkbox"
              className="h-3 w-3 accent-sky-500"
              checked={s.dryRun}
              disabled={busy === JSON.stringify({ dryRun: true }) || busy === JSON.stringify({ dryRun: false })}
              onChange={(e) => void patch({ dryRun: e.target.checked })}
            />
            <span className={s.dryRun ? 'text-sky-400' : 'text-zinc-400'}>Dry-run (journal only)</span>
          </label>
          <span className="ml-auto flex items-center gap-2 text-[9px] text-zinc-500">
            <ShieldCheck className="h-3 w-3 text-teal-500/70" />
            gate ≥<span className="font-mono text-zinc-300">{s.minConfidence}%</span> · cooldown{' '}
            <span className="font-mono text-zinc-300">{s.cooldownMin}m</span> · max{' '}
            <span className="font-mono text-zinc-300">{s.maxActionsPerCycle}/cycle</span>
          </span>
        </div>
      )}

      {/* guard-rail editor */}
      <button
        onClick={() => setOpenCtl((v) => !v)}
        className="mt-1.5 flex w-full items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-zinc-400 transition hover:text-zinc-200"
      >
        {openCtl ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Zap className="h-3 w-3 text-teal-400/70" /> Guard rails &amp; executed actions
      </button>
      {openCtl && s && (
        <div className="mt-1.5 grid grid-cols-2 gap-2 rounded border border-zinc-800 bg-zinc-950/40 p-2 md:grid-cols-3">
          {(
            [
              { key: 'intervalSec', label: 'Interval sec', lo: 30, hi: 3600, step: 10 },
              { key: 'minConfidence', label: 'Min confidence %', lo: 0, hi: 100, step: 5 },
              { key: 'maxActionsPerCycle', label: 'Max actions/cycle', lo: 1, hi: 10, step: 1 },
              { key: 'cooldownMin', label: 'Cooldown min', lo: 0, hi: 1440, step: 5 },
              { key: 'adjustTrimFraction', label: 'ADJUST trim ×', lo: 0.05, hi: 1, step: 0.05 },
              { key: 'scaleInFraction', label: 'SCALE-IN ×', lo: 0.05, hi: 1, step: 0.05 },
              { key: 'briefHour', label: 'Brief hour (local)', lo: 0, hi: 23, step: 1 },
            ] as const
          ).map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[8px] uppercase tracking-wider text-zinc-500">{f.label}</span>
              <input
                type="number"
                min={f.lo}
                max={f.hi}
                step={f.step}
                defaultValue={s[f.key] as number}
                key={`${f.key}-${s[f.key]}`}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v !== (s[f.key] as number)) void patch({ [f.key]: v });
                }}
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 font-mono text-[10px] text-zinc-200 outline-none focus:border-teal-600"
              />
            </label>
          ))}
          <div className="col-span-2 md:col-span-3">
            <p className="mb-1 text-[8px] uppercase tracking-wider text-zinc-500">Decisions the loop may execute</p>
            <div className="flex flex-wrap gap-1.5">
              {EXEC_LABELS.map((f) => (
                <label
                  key={f.key}
                  title={f.hint}
                  className={`flex cursor-pointer select-none items-center gap-1 rounded px-1.5 py-1 text-[9px] font-semibold ring-1 ${
                    s.execute[f.key]
                      ? 'bg-emerald-950/60 text-emerald-300 ring-emerald-500/30'
                      : 'bg-zinc-900/70 text-zinc-500 ring-zinc-700/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-2.5 w-2.5 accent-emerald-500"
                    checked={s.execute[f.key]}
                    onChange={(e) => void patch({ execute: { [f.key]: e.target.checked } })}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
          <div className="col-span-2 flex items-center gap-2 md:col-span-3">
            <span className="font-mono text-[8.5px] text-zinc-600">brief timezone {s.briefTz}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[8.5px] text-rose-400/80 hover:text-rose-300"
              onClick={async () => {
                await fetch('/api/positions/autopilot', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'reset_journal' }),
                });
                await load();
              }}
            >
              <RotateCcw className="mr-1 h-2.5 w-2.5" /> Clear journal
            </Button>
          </div>
        </div>
      )}

      {/* journal */}
      <button
        onClick={() => setOpenJournal((v) => !v)}
        className="mt-2 flex w-full items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-zinc-400 transition hover:text-zinc-200"
      >
        {openJournal ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <FlaskConical className="h-3 w-3 text-teal-400/70" /> Audit journal
        <span className="ml-auto font-mono text-[8px] font-normal text-zinc-600">{journal.length} shown · {data?.journalCount ?? 0} total</span>
      </button>
      {openJournal && (
        <div className="mt-1.5 max-h-56 space-y-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/40 p-1.5">
          {journal.length === 0 && (
            <p className="px-1 py-3 text-center text-[9px] text-zinc-600">
              No autopilot actions yet — enable the loop (or press Run cycle) and every evaluated decision lands here.
            </p>
          )}
          {journal.map((e) => (
            <div key={e.id} className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-zinc-900/60">
              <span className="shrink-0 font-mono text-[8px] text-zinc-600">{new Date(e.ts).toLocaleTimeString()}</span>
              <span
                className={`shrink-0 rounded px-1 text-[8px] font-bold uppercase ${
                  e.mode === 'live' ? 'bg-emerald-950/70 text-emerald-300' : 'bg-sky-950/70 text-sky-300'
                }`}
              >
                {e.mode}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-zinc-300" title={e.detail}>
                <span className="text-zinc-500">{e.instrument}</span>{' '}
                <span className={`font-bold ${RESULT_STYLE[e.result] ?? 'text-zinc-300'}`}>{e.action}</span>{' '}
                <span className={RESULT_STYLE[e.result] ?? 'text-zinc-400'}>{e.result}</span>
                {e.fill && (
                  <span className="text-zinc-500">
                    {' '}
                    @ {e.fill.price} · {e.fill.realizedPnl >= 0 ? '+' : ''}
                    {fmtNum(e.fill.realizedPnl, 0)}
                  </span>
                )}
                <span className="text-zinc-600"> — {e.detail}</span>
              </span>
              <span className="shrink-0 font-mono text-[8px] text-zinc-600" title={`confidence ${e.confidence}% · health ${e.healthScore}`}>
                {e.confidence}%
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── morning brief ──────────────────────────────────────────────── */}
      <div className="mt-3 rounded border border-zinc-800 bg-zinc-950/40 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-300">
            <CalendarClock className="h-3.5 w-3.5 text-amber-400/80" /> Morning brief
          </span>
          {brief && (
            <span className="font-mono text-[8.5px] text-zinc-500">
              {brief.date} · {new Date(brief.generatedAt).toLocaleTimeString()}
              {brief.aiNarrative ? ' · AI ✓' : ''}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-6 border-zinc-700 px-2 text-[9px]"
              disabled={briefBusy}
              onClick={() => void genBrief(true)}
              title="Regenerate now (fuses live market + decisions + autopilot journal + AI narrative)"
            >
              {briefBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Generate
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[9px] text-teal-300/80 hover:text-teal-300"
              disabled={briefBusy}
              onClick={() =>
                askAi(
                  'Read my latest morning brief with the morning_brief tool and walk me through it: the overnight tape, what it means for my book (delta/vega/theta), which watchlist positions need action today and what the autopilot did since the last brief. Be concrete with the numbers.',
                )
              }
            >
              <BrainCircuit className="mr-1 h-3 w-3" /> Ask AI
            </Button>
          </span>
        </div>

        {!brief && (
          <p className="py-3 text-center text-[9px] text-zinc-600">
            No brief yet — it generates daily at {s?.briefHour ?? 8}:00 {s?.briefTz ?? 'Asia/Karachi'} (autopilot loop),
            or press Generate.
          </p>
        )}

        {brief && (
          <div className="mt-2 space-y-2">
            {/* overnight tape */}
            <div className="flex flex-wrap gap-1.5">
              {brief.market.map((mkt) => (
                <span
                  key={mkt.asset}
                  className="rounded border border-zinc-800/70 bg-zinc-950/70 px-1.5 py-0.5 font-mono text-[8.5px]"
                  title={`bias ${mkt.biasLabel ?? 'n/a'} (${mkt.biasScore ?? 'n/a'}) · regime ${mkt.regimeLabel ?? 'n/a'} (${mkt.regimeScore ?? 'n/a'})${mkt.topSignals.length ? ` · ${mkt.topSignals.join(', ')}` : ''}`}
                >
                  <span className="font-bold text-teal-300">{mkt.asset}</span>{' '}
                  <span className={mkt.change24hPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {mkt.change24hPct >= 0 ? '+' : ''}
                    {mkt.change24hPct}%
                  </span>
                  {mkt.atmIv30dPct != null && <span className="text-amber-400/80"> iv {mkt.atmIv30dPct.toFixed(0)}</span>}
                  {mkt.ivRank != null && <span className="text-zinc-500"> rank {mkt.ivRank.toFixed(0)}</span>}
                </span>
              ))}
            </div>

            {/* portfolio + census */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[9px] text-zinc-500">
              <span>
                equity <span className="text-zinc-200">{fmtUsd(brief.portfolio.equity)}</span>
              </span>
              <span>
                uP&amp;L{' '}
                <span className={brief.portfolio.unrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  {brief.portfolio.unrealized >= 0 ? '+' : ''}
                  {fmtNum(brief.portfolio.unrealized, 0)}
                </span>
              </span>
              <span>
                Δ$ <span className="text-zinc-300">{fmtNum(brief.portfolio.netDeltaUsd, 0)}</span>
              </span>
              <span>
                vega <span className="text-zinc-300">{fmtNum(brief.portfolio.netVega, 0)}</span>
              </span>
              <span>
                θ <span className="text-zinc-300">{fmtNum(brief.portfolio.netTheta, 0)}</span>
              </span>
              <span>
                margin <span className="text-zinc-300">{brief.portfolio.marginUtilizationPct.toFixed(0)}%</span>
              </span>
              <span title={`stress −1ATR ${fmtNum(brief.portfolio.stressDown1Atr, 0)} / +1ATR ${fmtNum(brief.portfolio.stressUp1Atr, 0)}`}>
                ⌁±1ATR{' '}
                <span className="text-rose-400/80">{fmtNum(brief.portfolio.stressDown1Atr, 0)}</span>/
                <span className="text-emerald-400/80">{fmtNum(brief.portfolio.stressUp1Atr, 0)}</span>
              </span>
              <span>
                positions <span className="text-zinc-300">{brief.portfolio.openPositions}</span>
              </span>
            </div>

            {/* decisions */}
            {brief.positions.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {brief.positions.slice(0, 12).map((p) => (
                  <span
                    key={p.positionId}
                    title={`${p.side} ${p.instrument} · P&L ${p.pnlPct.toFixed(1)}% · health ${p.healthScore} · ${p.reason}`}
                    className="rounded bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[8.5px] text-zinc-300 ring-1 ring-zinc-700/50"
                  >
                    {p.instrument.slice(0, 14)} <span className="text-zinc-500">→</span>{' '}
                    <span
                      className={
                        p.action === 'EXIT'
                          ? 'font-bold text-rose-400'
                          : p.action === 'TAKE_PROFIT'
                            ? 'font-bold text-teal-300'
                            : p.action === 'ROLL'
                              ? 'font-bold text-violet-300'
                              : p.action === 'HOLD'
                                ? 'text-sky-300'
                                : 'text-amber-300'
                      }
                    >
                      {p.action}
                    </span>
                  </span>
                ))}
              </div>
            )}

            {/* watchlist */}
            {brief.watchlist.length > 0 && (
              <div className="rounded border border-amber-900/40 bg-amber-950/20 p-1.5">
                <p className="mb-1 text-[8px] font-semibold uppercase tracking-wider text-amber-400/80">Today&apos;s watchlist</p>
                <div className="space-y-0.5">
                  {brief.watchlist.slice(0, 6).map((w) => (
                    <p key={w.positionId} className="font-mono text-[8.5px] text-zinc-400">
                      <span className="text-zinc-200">{w.instrument.slice(0, 16)}</span>{' '}
                      <span className="text-amber-300/90">{w.action}</span> — {w.note}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* autopilot digest */}
            <p className="font-mono text-[8.5px] text-zinc-500">
              autopilot since last brief:{' '}
              <span className={brief.autopilot.closed > 0 ? 'text-emerald-400' : 'text-zinc-300'}>
                {brief.autopilot.closed} executed
              </span>{' '}
              · <span className="text-sky-400">{brief.autopilot.planned} planned</span>
              {brief.autopilot.failed > 0 && <span className="text-rose-400"> · {brief.autopilot.failed} failed</span>}
              {brief.autopilot.enabled ? ` · ${brief.autopilot.dryRun ? 'dry-run' : 'LIVE'}` : ' · off'}
            </p>

            {/* AI narrative */}
            {brief.aiNarrative && (
              <div className="rounded border border-teal-900/40 bg-teal-950/20 p-2">
                <p className="mb-1 flex items-center gap-1 text-[8px] font-semibold uppercase tracking-wider text-teal-400/80">
                  <BrainCircuit className="h-2.5 w-2.5" /> Desk narrative
                </p>
                <div className="space-y-0.5">
                  {brief.aiNarrative
                    .split('\n')
                    .filter((l) => l.trim().startsWith('-') || l.trim().startsWith('•') || l.trim().startsWith('*'))
                    .slice(0, 10)
                    .map((l, i) => (
                      <p key={i} className="text-[9px] leading-relaxed text-zinc-300">
                        {l.replace(/^[-•*]\s*/, '').trim()}
                      </p>
                    ))}
                  {brief.aiNarrative.split('\n').filter((l) => l.trim().startsWith('-') || l.trim().startsWith('•') || l.trim().startsWith('*')).length === 0 && (
                    <p className="whitespace-pre-wrap text-[9px] leading-relaxed text-zinc-300">{brief.aiNarrative}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

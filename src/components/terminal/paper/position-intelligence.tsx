'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Position Intelligence — the decision layer of the Paper Desk.
//
// Fuses every open paper position with the whole live market data stack and
// shows, per position: the decision (HOLD / ADJUST / SCALE_IN / TAKE_PROFIT /
// EXIT / ROLL) with confidence + health, re-priced Greeks, prob ITM, P&L
// attribution, theta bleed, market alignment, triggered management rules —
// and an inline editor for the position's management SETTINGS (profile
// presets + every threshold), so returns can be tuned per position.
// The "Ask AI" buttons hand the whole context to the copilot.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fmtNum, fmtUsd } from '@/lib/format';
import { useCopilot } from '@/stores/copilot-store';
import type { IntelligenceReport, PositionIntelligence, PositionAction } from '@/lib/positions/intelligence';
import type { PositionProfile, PositionSettings, SettingsView } from '@/lib/positions/settings';
import {
  Activity,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Gauge,
  Loader2,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';

// --- decision presentation ------------------------------------------------------------

const ACTION_STYLE: Record<PositionAction, { label: string; cls: string; dot: string }> = {
  HOLD: { label: 'HOLD', cls: 'bg-sky-950/60 text-sky-300 ring-sky-500/30', dot: 'bg-sky-400' },
  ADJUST: { label: 'ADJUST', cls: 'bg-amber-950/60 text-amber-300 ring-amber-500/30', dot: 'bg-amber-400' },
  SCALE_IN: { label: 'SCALE IN', cls: 'bg-emerald-950/60 text-emerald-300 ring-emerald-500/30', dot: 'bg-emerald-400' },
  TAKE_PROFIT: { label: 'TAKE PROFIT', cls: 'bg-teal-950/60 text-teal-300 ring-teal-500/30', dot: 'bg-teal-400' },
  EXIT: { label: 'EXIT', cls: 'bg-rose-950/60 text-rose-300 ring-rose-500/30', dot: 'bg-rose-400' },
  ROLL: { label: 'ROLL', cls: 'bg-violet-950/60 text-violet-300 ring-violet-500/30', dot: 'bg-violet-400' },
};

const TRIGGER_STYLE = {
  critical: 'bg-rose-950/60 text-rose-300 ring-1 ring-rose-500/40',
  warn: 'bg-amber-950/60 text-amber-300 ring-1 ring-amber-500/40',
  info: 'bg-zinc-800/60 text-zinc-300 ring-1 ring-zinc-600/40',
} as const;

const SETTING_FIELDS: { key: keyof PositionSettings; label: string; step: number; hint: string }[] = [
  { key: 'takeProfitPct', label: 'Take-profit %', step: 1, hint: 'close at +X% P&L' },
  { key: 'stopLossPct', label: 'Stop-loss %', step: 1, hint: 'close at −X% P&L' },
  { key: 'maxThetaBleedPctPerDay', label: 'Max θ bleed %/day', step: 0.5, hint: 'decay guard' },
  { key: 'minDte', label: 'Min DTE', step: 1, hint: 'roll/exit under X days' },
  { key: 'probItmFloorPct', label: 'Prob-ITM floor %', step: 1, hint: 'long exit under X%' },
  { key: 'probItmCeilPct', label: 'Prob-ITM ceiling %', step: 1, hint: 'short exit over X%' },
  { key: 'ivMoveAlertPts', label: 'IV move alert pts', step: 1, hint: 'vega guard ±X pts' },
  { key: 'alignmentBreakScore', label: 'Alignment break', step: 5, hint: 'market turns −X/100' },
  { key: 'maxHoldDays', label: 'Max hold days', step: 1, hint: 'hard time stop' },
];

// --- small atoms -----------------------------------------------------------------------

function Metric({ label, value, tone, hint }: { label: string; value: string; tone?: 'pos' | 'neg' | 'warn'; hint?: string }) {
  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5" title={hint}>
      <p className="text-[8px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p
        className={`font-mono text-[11px] font-semibold ${
          tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : 'text-zinc-200'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function AttrBar({ label, value, maxAbs }: { label: string; value: number; maxAbs: number }) {
  const pct = Math.min(Math.abs(value) / Math.max(maxAbs, 1e-9), 1) * 50;
  const pos = value >= 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[8px] uppercase tracking-wider text-zinc-500">{label}</span>
      <div className="relative h-2 flex-1 rounded-sm bg-zinc-800/60">
        <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-600" />
        <div
          className={`absolute top-0 h-full rounded-sm ${pos ? 'bg-emerald-500/70' : 'bg-rose-500/70'}`}
          style={pos ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
        />
      </div>
      <span className={`w-14 shrink-0 text-right font-mono text-[9px] ${pos ? 'text-emerald-400/90' : 'text-rose-400/90'}`}>
        {value >= 0 ? '+' : ''}
        {fmtNum(value, 0)}
      </span>
    </div>
  );
}

function HealthBar({ score }: { score: number }) {
  const tone = score >= 60 ? 'bg-emerald-500' : score >= 40 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="flex items-center gap-1.5" title={`Health score ${score}/100`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full ${tone}`} style={{ width: `${score}%` }} />
      </div>
      <span className="font-mono text-[9px] text-zinc-500">{score}</span>
    </div>
  );
}

// --- settings editor --------------------------------------------------------------------

function SettingsEditor({
  scope,
  positionId,
  current,
  presets,
  onSaved,
}: {
  scope: 'global' | 'position';
  positionId?: string;
  current: PositionSettings;
  presets: Record<string, PositionSettings>;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const askAi = useCopilot((s) => s.askAi);

  const valueOf = (key: keyof PositionSettings): string => {
    if (key in draft) return draft[key as string];
    const v = current[key];
    return v == null ? '' : String(v);
  };

  const dirty = Object.keys(draft).length > 0;

  const set = (key: keyof PositionSettings, raw: string) => {
    setDraft((d) => ({ ...d, [key]: raw }));
  };

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch('/api/positions/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const settings: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (v.trim() === '') settings[k] = null;
      else {
        const n = Number(v);
        if (Number.isFinite(n)) settings[k] = n;
      }
    }
    if (Object.keys(settings).length === 0) return;
    const ok = await post({ action: 'updatePosition', positionId, settings });
    if (ok) {
      setDraft({});
      onSaved();
    }
  };

  const saveGlobal = async () => {
    const settings: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (v.trim() === '') settings[k] = null;
      else {
        const n = Number(v);
        if (Number.isFinite(n)) settings[k] = n;
      }
    }
    if (Object.keys(settings).length === 0) return;
    const ok = await post({ action: 'updateGlobal', settings });
    if (ok) {
      setDraft({});
      onSaved();
    }
  };

  const applyPreset = async (profile: PositionProfile) => {
    const ok = await post({ action: 'applyPreset', profile, positionId: scope === 'position' ? positionId : undefined });
    if (ok) {
      setDraft({});
      onSaved();
    }
  };

  const askTune = () =>
    askAi(
      `Tune my position management settings for a better return/risk balance${
        scope === 'position' ? ' on this specific position' : ' (global defaults)'
      }. Read my current settings with get_position_settings and the position intelligence report, propose the optimal preset or field changes with reasoning, then apply them with update_position_settings and tell me exactly what changed and why.`,
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[8.5px] uppercase tracking-wider text-zinc-500">Profile</span>
        {(['scalper', 'swing', 'harvester', 'longshot'] as const).map((p) => (
          <button
            key={p}
            disabled={busy}
            onClick={() => applyPreset(p)}
            title={
              p === 'scalper'
                ? 'quick 25%/15% TP/SL · 4-day time stop'
                : p === 'swing'
                  ? '60%/35% TP/SL · 14-day time stop'
                  : p === 'harvester'
                    ? 'premium-selling guardrails · 55% TP'
                    : 'asymmetric runner · 150%/50% TP/SL'
            }
            className={`rounded px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wide transition ${
              current.profile === p && !dirty
                ? 'bg-teal-500/90 text-zinc-950'
                : 'bg-zinc-800/70 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
            }`}
          >
            {p}
          </button>
        ))}
        {dirty && (
          <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[8.5px] uppercase tracking-wide text-zinc-300">
            custom (unsaved)
          </span>
        )}
        {scope === 'position' && (
          <span className="ml-auto rounded bg-violet-950/50 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-violet-300 ring-1 ring-violet-500/30">
            per-position override
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {SETTING_FIELDS.map((f) => (
          <div key={f.key} title={f.hint}>
            <label className="mb-0.5 block text-[8px] uppercase tracking-wider text-zinc-500">{f.label}</label>
            <input
              type="number"
              step={f.step}
              min={0}
              value={valueOf(f.key)}
              onChange={(e) => set(f.key, e.target.value)}
              placeholder="off"
              disabled={busy}
              className="h-6.5 w-full rounded border border-zinc-800 bg-zinc-950 px-1.5 text-right font-mono text-[10px] text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-teal-500/50 disabled:opacity-50"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          disabled={busy || !dirty}
          onClick={scope === 'position' ? save : saveGlobal}
          className="h-6 bg-teal-500/90 px-2 text-[9px] font-bold text-zinc-950 hover:bg-teal-400 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Save {scope === 'position' ? 'this position' : 'global'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !dirty}
          onClick={() => setDraft({})}
          className="h-6 border-zinc-700 bg-zinc-900 px-2 text-[9px] text-zinc-400 hover:bg-zinc-800"
        >
          Revert
        </Button>
        {scope === 'position' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => post({ action: 'clearPosition', positionId }).then((ok) => ok && onSaved())}
            className="h-6 border-zinc-700 bg-zinc-900 px-2 text-[9px] text-zinc-400 hover:bg-zinc-800"
          >
            Use global
          </Button>
        )}
        <button
          onClick={askTune}
          className="ml-auto flex items-center gap-1 rounded border border-violet-700/50 bg-violet-950/30 px-2 py-1 text-[9px] font-semibold text-violet-300 transition hover:bg-violet-900/40"
        >
          <Sparkles className="h-3 w-3" /> AI-tune these settings
        </button>
      </div>
    </div>
  );
}

// --- per-position card --------------------------------------------------------------------

function PositionCard({
  p,
  settingsView,
  onClose,
  onChanged,
}: {
  p: PositionIntelligence;
  settingsView: SettingsView | null;
  onClose: (id: string) => void;
  onChanged: () => void;
}) {
  const [openSettings, setOpenSettings] = useState(false);
  const askAi = useCopilot((s) => s.askAi);
  const a = ACTION_STYLE[p.decision.action];
  const maxAttr = Math.max(
    Math.abs(p.pnl.deltaPnl),
    Math.abs(p.pnl.vegaPnl),
    Math.abs(p.pnl.thetaPnl),
    Math.abs(p.pnl.residualPnl),
    1,
  );

  const askPosition = () =>
    askAi(
      `Deep-dive my ${p.side} ${p.instrument} paper position (id ${p.positionId}): the decision engine says ${p.decision.action} with ${p.decision.confidence}% confidence. Pull the full position intelligence, explain the P&L attribution (delta $${fmtNum(p.pnl.deltaPnl, 0)}, vega $${fmtNum(p.pnl.vegaPnl, 0)}, theta $${fmtNum(p.pnl.thetaPnl, 0)}), the market alignment score (${p.market.alignmentScore ?? 'n/a'}) and the current settings (profile: ${p.settings.profile}). Should I follow the recommendation — and if not, what settings would produce a better outcome?`,
    );

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
      {/* header row */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[9px] font-bold tracking-wide ring-1 ${a.cls}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${a.dot}`} />
          {a.label}
          <span className="font-mono opacity-70">{p.decision.confidence}%</span>
        </span>
        <span className="font-mono text-[11px] font-semibold text-zinc-200">{p.instrument}</span>
        <span className={`text-[9px] font-bold uppercase ${p.side === 'long' ? 'text-emerald-400' : 'text-rose-400'}`}>{p.side}</span>
        <span className="font-mono text-[9px] text-zinc-500">×{fmtNum(p.qty, 3)}</span>
        {p.strategyTag && (
          <span className="max-w-[110px] truncate rounded bg-violet-950/40 px-1.5 py-0.5 text-[8px] text-violet-300/80">{p.strategyTag}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <HealthBar score={p.decision.healthScore} />
          <button
            onClick={() => setOpenSettings((v) => !v)}
            className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[8.5px] font-semibold uppercase transition ${
              openSettings ? 'border-teal-500/50 bg-teal-950/40 text-teal-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {openSettings ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Settings2 className="h-3 w-3" /> {p.settings.profile}
            {p.settingsSource === 'position' && <span className="text-violet-300">·override</span>}
          </button>
        </div>
      </div>

      {/* triggers */}
      {p.triggers.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {p.triggers.map((t) => (
            <span
              key={t.code}
              title={t.message}
              className={`rounded px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide ${TRIGGER_STYLE[t.level]}`}
            >
              {t.code.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      )}

      {/* metric grid */}
      <div className="mb-2 grid grid-cols-4 gap-1.5 md:grid-cols-8">
        <Metric label="uP&L" value={`${p.pnl.pct >= 0 ? '+' : ''}${p.pnl.pct}%`} tone={p.pnl.pct >= 0 ? 'pos' : 'neg'} hint={`$${fmtNum(p.pnl.unrealized, 2)}`} />
        <Metric label="Δ pos" value={p.current.greeks ? fmtNum(p.current.greeks.positionDelta, 3) : '—'} hint="position delta in underlying units" />
        <Metric label="Prob ITM" value={p.current.probItmPct != null ? `${p.current.probItmPct}%` : '—'} hint="probability of finishing in the money" />
        <Metric
          label="θ/day"
          value={p.risk.thetaBleedPctPerDay != null ? `${p.risk.thetaBleedPctPerDay}%` : '—'}
          tone={p.risk.thetaBleedPctPerDay != null && p.risk.thetaBleedPctPerDay > 3 ? 'warn' : undefined}
          hint="daily decay as % of remaining value"
        />
        <Metric label="DTE" value={`${p.dte}d`} tone={p.dte < 5 ? 'warn' : undefined} hint={`held ${p.daysHeld}d`} />
        <Metric
          label="BE dist"
          value={p.risk.distanceToBreakevenAtr != null ? `${p.risk.distanceToBreakevenAtr}σ` : '—'}
          hint={`breakeven ${fmtNum(p.risk.breakeven, 0)} · touch prob ${p.risk.probTouchBreakevenPct ?? '—'}%`}
        />
        <Metric
          label="IV move"
          value={p.market.ivMovePts != null ? `${p.market.ivMovePts >= 0 ? '+' : ''}${p.market.ivMovePts}` : '—'}
          tone={p.market.ivMovePts != null && Math.abs(p.market.ivMovePts) > 5 ? 'warn' : undefined}
          hint={`entry IV ${p.entry.ivPct ?? '—'}% → now ${p.current.ivPct ?? '—'}%`}
        />
        <Metric
          label="Alignment"
          value={p.market.alignmentScore != null ? `${p.market.alignmentScore > 0 ? '+' : ''}${p.market.alignmentScore}` : '—'}
          tone={(p.market.alignmentScore ?? 0) < -30 ? 'neg' : (p.market.alignmentScore ?? 0) > 30 ? 'pos' : undefined}
          hint={p.market.alignmentLabel}
        />
      </div>

      {/* attribution + reasons */}
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        <div className="space-y-1 rounded border border-zinc-800/70 bg-zinc-950/40 px-2 py-1.5">
          <p className="text-[8px] uppercase tracking-wider text-zinc-500">P&L attribution (USD)</p>
          <AttrBar label="delta" value={p.pnl.deltaPnl} maxAbs={maxAttr} />
          <AttrBar label="vega" value={p.pnl.vegaPnl} maxAbs={maxAttr} />
          <AttrBar label="theta" value={p.pnl.thetaPnl} maxAbs={maxAttr} />
          <AttrBar label="other" value={p.pnl.residualPnl} maxAbs={maxAttr} />
        </div>
        <div className="rounded border border-zinc-800/70 bg-zinc-950/40 px-2 py-1.5">
          <p className="mb-1 text-[8px] uppercase tracking-wider text-zinc-500">
            {a.label} — {p.decision.suggestedAction}
          </p>
          <ul className="space-y-0.5">
            {p.decision.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-1 text-[9px] leading-snug text-zinc-400">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* settings drawer */}
      {openSettings && settingsView && (
        <div className="mt-2 rounded border border-teal-800/40 bg-teal-950/10 p-2">
          <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-teal-300/80">
            Management settings — {p.settingsSource === 'position' ? 'this position' : 'inherited from global'}
          </p>
          <SettingsEditor
            scope="position"
            positionId={p.positionId}
            current={p.settings}
            presets={settingsView.presets}
            onSaved={onChanged}
          />
        </div>
      )}

      {/* actions */}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={askPosition}
          className="flex items-center gap-1 rounded border border-violet-700/50 bg-violet-950/30 px-2 py-1 text-[9px] font-semibold text-violet-300 transition hover:bg-violet-900/40"
        >
          <BrainCircuit className="h-3 w-3" /> Ask AI about this position
        </button>
        {p.decision.action === 'EXIT' || p.decision.action === 'TAKE_PROFIT' ? (
          <button
            onClick={() => onClose(p.positionId)}
            className="flex items-center gap-1 rounded border border-rose-700/50 bg-rose-950/30 px-2 py-1 text-[9px] font-semibold text-rose-300 transition hover:bg-rose-900/40"
          >
            <X className="h-3 w-3" /> {p.decision.action === 'TAKE_PROFIT' ? 'Bank it' : 'Cut it'}
          </button>
        ) : null}
        <span className="ml-auto font-mono text-[8px] text-zinc-600">
          mark {fmtNum(p.current.mark, 2)} · {p.current.quoteSource === 'live' ? 'live venue quote' : 'model mark'}
        </span>
      </div>
    </div>
  );
}

// --- the panel ------------------------------------------------------------------------------

export function PositionIntelligencePanel({ onClosePosition }: { onClosePosition: (id: string) => void }) {
  const [report, setReport] = useState<IntelligenceReport | null>(null);
  const [settingsView, setSettingsView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [openGlobal, setOpenGlobal] = useState(false);
  const askAi = useCopilot((s) => s.askAi);

  const load = useCallback(() => {
    fetch('/api/positions/intelligence')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setReport(j.report))
      .catch(() => {})
      .finally(() => setLoading(false));
    fetch('/api/positions/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setSettingsView({ global: j.global, presets: j.presets, positions: j.positions, updatedAt: j.updatedAt }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 20_000);
    return () => clearInterval(iv);
  }, [load]);

  const portfolio = report?.portfolio;
  const positions = useMemo(
    () => [...(report?.positions ?? [])].sort((a, b) => a.decision.confidence - b.decision.confidence),
    [report],
  );

  const askReview = () =>
    askAi(
      'Review my whole paper book with position_intelligence: tell me which positions need action right now (and why — attribution, alignment, triggers), which settings I should change for better returns, then propose and apply the changes.',
    );

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      {/* header */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
          <Activity className="h-3.5 w-3.5 text-teal-400" /> Position intelligence
          <span className="font-mono text-[9px] font-normal text-zinc-600">
            positions × whole market data · decisions · settings
          </span>
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          {portfolio && (
            <>
              {portfolio.alerts.critical > 0 && (
                <span className="flex items-center gap-1 rounded bg-rose-950/60 px-1.5 py-0.5 text-[8.5px] font-bold uppercase text-rose-300 ring-1 ring-rose-500/40">
                  <ShieldAlert className="h-3 w-3" /> {portfolio.alerts.critical} critical
                </span>
              )}
              {portfolio.alerts.warn > 0 && (
                <span className="rounded bg-amber-950/60 px-1.5 py-0.5 text-[8.5px] font-bold uppercase text-amber-300 ring-1 ring-amber-500/40">
                  {portfolio.alerts.warn} warn
                </span>
              )}
            </>
          )}
          <button
            onClick={load}
            className="rounded border border-zinc-700 p-1 text-zinc-500 transition hover:text-zinc-200"
            title="Refresh intelligence"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={askReview}
            className="flex items-center gap-1 rounded bg-violet-600/80 px-2 py-1 text-[9px] font-bold text-white transition hover:bg-violet-500"
          >
            <Sparkles className="h-3 w-3" /> AI review
          </button>
        </div>
      </div>

      {/* portfolio rollup */}
      {portfolio && (
        <div className="mb-2 grid grid-cols-4 gap-1.5 md:grid-cols-8">
          <Metric label="Equity" value={fmtUsd(portfolio.equity)} />
          <Metric label="Net Δ (USD)" value={fmtUsd(portfolio.netGreeks.total.deltaUsd)} tone={portfolio.netGreeks.total.deltaUsd >= 0 ? 'pos' : 'neg'} />
          <Metric label="Net Γ" value={fmtNum(portfolio.netGreeks.total.gamma, 4)} />
          <Metric label="Net ν" value={fmtNum(portfolio.netGreeks.total.vega, 1)} />
          <Metric label="Net θ/day" value={fmtUsd(portfolio.netGreeks.total.theta)} tone={portfolio.netGreeks.total.theta >= 0 ? 'pos' : 'neg'} />
          <Metric label="Stress −1σ" value={fmtUsd(portfolio.stress.down1AtrPnl)} tone={portfolio.stress.down1AtrPnl >= 0 ? 'pos' : 'neg'} hint="P&L if spot drops 1 ATR" />
          <Metric label="Stress +1σ" value={fmtUsd(portfolio.stress.up1AtrPnl)} tone={portfolio.stress.up1AtrPnl >= 0 ? 'pos' : 'neg'} hint="P&L if spot rises 1 ATR" />
          <Metric
            label="Margin used"
            value={`${portfolio.marginUtilizationPct}%`}
            tone={portfolio.marginUtilizationPct > 50 ? 'warn' : undefined}
          />
        </div>
      )}

      {/* market context chips */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {(report?.market ?? []).map((c) => (
          <div
            key={c.asset}
            className="flex items-center gap-2 rounded border border-zinc-800/70 bg-zinc-950/50 px-2 py-1 font-mono text-[9px]"
            title={
              c.technicals
                ? `${c.technicals.biasLabel} · RSI ${c.technicals.rsi14} · ADX ${c.technicals.adx14}\n${c.technicals.signals.join(' · ')}`
                : 'technical context warming up'
            }
          >
            <span className="font-bold text-teal-300">{c.asset}</span>
            <span className="text-zinc-300">${fmtNum(c.spot, 0)}</span>
            <span className={c.change24hPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {c.change24hPct >= 0 ? '+' : ''}
              {c.change24hPct}%
            </span>
            {c.decision && (
              <span className={c.decision.regimeScore >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}>
                regime {c.decision.regimeScore > 0 ? '+' : ''}
                {c.decision.regimeScore}
              </span>
            )}
            {c.technicals && (
              <span className="text-zinc-500">
                bias {c.technicals.biasScore > 0 ? '+' : ''}
                {c.technicals.biasScore}
              </span>
            )}
            {c.volRegime?.ivRank != null && <span className="text-amber-400/80">IV rank {c.volRegime.ivRank}</span>}
            {c.fundingRate != null && (
              <span className={c.fundingRate >= 0 ? 'text-zinc-500' : 'text-teal-400/70'}>
                fund {(c.fundingRate * 100).toFixed(3)}%
              </span>
            )}
          </div>
        ))}
      </div>

      {/* positions */}
      {loading && !report && (
        <div className="flex items-center justify-center gap-2 py-6 text-[10px] text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Fusing positions with live market data…
        </div>
      )}
      {report && positions.length === 0 && (
        <div className="flex items-center gap-2 rounded border border-dashed border-zinc-800 py-4 text-[10px] text-zinc-500">
          <Gauge className="h-3.5 w-3.5" />
          No open positions — the market context above stays live; open a paper trade and its decision card appears here.
        </div>
      )}
      <div className="space-y-2">
        {positions.map((p) => (
          <PositionCard key={p.positionId} p={p} settingsView={settingsView} onClose={onClosePosition} onChanged={load} />
        ))}
      </div>

      {/* global settings */}
      {settingsView && (
        <div className="mt-2">
          <button
            onClick={() => setOpenGlobal((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-zinc-400 transition hover:text-zinc-200"
          >
            {openGlobal ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Settings2 className="h-3 w-3" /> Global management defaults — {settingsView.global.profile}
            <span className="ml-auto font-mono text-[8px] font-normal text-zinc-600">
              {Object.keys(settingsView.positions).length} position overrides
            </span>
          </button>
          {openGlobal && (
            <div className="mt-1.5 rounded border border-zinc-800 bg-zinc-950/40 p-2">
              <SettingsEditor
                scope="global"
                current={settingsView.global}
                presets={settingsView.presets}
                onSaved={load}
              />
            </div>
          )}
        </div>
      )}

      {report && report.notes.length > 0 && (
        <p className="mt-2 text-[8.5px] leading-relaxed text-zinc-600">{report.notes.join(' · ')}</p>
      )}
    </div>
  );
}

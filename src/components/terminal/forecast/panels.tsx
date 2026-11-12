'use client';

// ─────────────────────────────────────────────────────────────────────────────
// FORECAST — right-rail panels
//
//   ModelsPanel         model cards: alias / interval method / calibration
//                       note / expected-move readout; click to make primary
//                       (fan chart), toggle ● to overlay its point line
//   EvaluatePanel       the docs' evaluation table — coverage per level vs
//                       nominal, mean width, MASE, scaled CRPS, clamp
//                       detection — plus per-step coverage mini-chart
//   CalibPanel          calibration diagnostics for the primary model
//   LiveCoveragePanel   walk-forward hit/miss from the SSE stream
//   ForecastKpiStrip    compact KPI strip above the chart
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useReducer, useRef, useState } from 'react';
import { CheckCircle2, Gauge, RefreshCw, Sigma, TrendingUp } from 'lucide-react';
import type { FcConfig, FcEvalRowUI, FcFeedState, FcModelUI } from './use-forecast';

const fmt = (v: number | null | undefined, digits = 3): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);
const fmtW = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : v >= 1000 ? v.toFixed(0) : v.toFixed(1);

// ── model cards (primary selector) ────────────────────────────────────────────

export function ModelsPanel({
  models,
  primaryAlias,
  overlays,
  onPrimary,
  onToggleOverlay,
}: {
  models: FcModelUI[];
  primaryAlias: string;
  overlays: string[];
  onPrimary: (alias: string) => void;
  onToggleOverlay: (alias: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="px-1 text-[9px] leading-relaxed text-zinc-600">
        Each model class appears three ways (native · conformal_distribution · conformal_error) — copies share
        the point forecast, so any difference is the intervals. Click a card to make it the fan-chart primary;
        toggle ● to overlay its point line.
      </p>
      {models.map((m) => {
        const isPrimary = m.alias === primaryAlias;
        const isOverlay = overlays.includes(m.alias);
        const conformal = m.intervals !== 'native';
        return (
          <button
            key={m.alias}
            onClick={() => onPrimary(m.alias)}
            className={`block w-full rounded-lg border px-2.5 py-2 text-left transition ${
              isPrimary
                ? 'border-teal-500/40 bg-teal-950/30'
                : conformal
                  ? 'border-sky-800/40 bg-sky-950/15 hover:border-sky-700'
                  : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`truncate font-mono text-[11px] ${isPrimary ? 'text-teal-300' : conformal ? 'text-sky-300' : 'text-zinc-300'}`}
                >
                  {m.alias}
                </span>
                <span
                  className={`shrink-0 rounded px-1 py-px text-[8px] uppercase tracking-wide ${
                    m.intervals === 'conformal_distribution'
                      ? 'bg-sky-900/60 text-sky-300'
                      : m.intervals === 'conformal_error'
                        ? 'bg-violet-900/60 text-violet-300'
                        : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {m.intervals === 'conformal_distribution' ? 'c-dist' : m.intervals === 'conformal_error' ? 'c-err' : 'native'}
                </span>
              </span>
              {!isPrimary && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleOverlay(m.alias);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      onToggleOverlay(m.alias);
                    }
                  }}
                  title="overlay point line on the chart"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[8px] ${
                    isOverlay ? 'border-amber-400 bg-amber-400/20 text-amber-300' : 'border-zinc-700 text-zinc-600'
                  }`}
                >
                  ●
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate text-[9px] text-zinc-500" title={m.note}>
                {m.note}
              </span>
            </div>
            {m.expectedMove && (
              <div className="mt-1 flex items-center gap-2 font-mono text-[9px]">
                <span className="text-zinc-600">exp.move</span>
                <span className="text-zinc-400">
                  {fmt(m.expectedMove.lo, 1)} … {fmt(m.expectedMove.hi, 1)}
                </span>
                <span className={m.expectedMove.widthPct ? 'text-amber-400' : 'text-zinc-500'}>
                  {m.expectedMove.widthPct ? `${m.expectedMove.widthPct.toFixed(2)}%` : ''}
                </span>
              </div>
            )}
            {m.calibration && (
              <div className="mt-1 font-mono text-[8px] text-zinc-600">
                calib: W={m.calibration.nWindows} · Δ={m.calibration.stepSize} ·{' '}
                {m.calibration.ok ? (
                  <span className="text-emerald-500/80">ok</span>
                ) : (
                  <span className="text-rose-400/90">
                    short {m.calibration.available}/{m.calibration.required}
                  </span>
                )}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── evaluation (the docs' evaluation table) ───────────────────────────────────

function CoverageBadge({ level, coverage }: { level: string; coverage: number | null | undefined }) {
  const nominal = Number(level) / 100;
  const v = coverage ?? NaN;
  const ok = Number.isFinite(v) && Math.abs(v - nominal) <= 0.08;
  const close = Number.isFinite(v) && Math.abs(v - nominal) <= 0.2;
  const tone = ok
    ? 'border-emerald-700/60 bg-emerald-900/30 text-emerald-300'
    : close
      ? 'border-amber-700/60 bg-amber-900/25 text-amber-300'
      : 'border-rose-800/60 bg-rose-950/40 text-rose-300';
  return (
    <span className={`rounded border px-1 py-px font-mono text-[9px] ${tone}`} title={`nominal ${(nominal * 100).toFixed(0)}%`}>
      {Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '–'}
    </span>
  );
}

export function EvaluatePanel({
  state,
  config,
  onRefresh,
}: {
  state: FcFeedState;
  config: FcConfig;
  onRefresh: () => void;
}) {
  const d = state.evalData;
  const levelKeys = config.levels.map(String);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-[9px] leading-relaxed text-zinc-600">
          Cross-validated: conformal models recalibrate at every cutoff on only the data before it — the
          evaluation never sees what it is scored on. Coverage badges: green within ±8% of nominal.
        </p>
        <button
          onClick={onRefresh}
          disabled={state.evalLoading}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-[9px] text-zinc-300 transition hover:border-teal-600 hover:text-teal-300 disabled:opacity-50"
          title="re-run cross-validation"
        >
          <RefreshCw className={`h-3 w-3 ${state.evalLoading ? 'animate-spin' : ''}`} />
          cv×{d?.cvWindows ?? 3}
        </button>
      </div>

      {state.evalLoading && !d && <p className="px-1 text-[10px] text-zinc-500">cross-validating…</p>}
      {!state.evalLoading && !d && !state.error && (
        <p className="px-1 text-[10px] text-zinc-500">no evaluation yet — press refresh.</p>
      )}

      {d && (
        <>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full border-collapse text-[9px]">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/50 text-zinc-500">
                  <th className="px-1.5 py-1 text-left font-medium">alias</th>
                  {levelKeys.map((k) => (
                    <th key={`c${k}`} className="px-1 py-1 text-center font-medium">
                      cov {k}%
                    </th>
                  ))}
                  {levelKeys.map((k) => (
                    <th key={`w${k}`} className="px-1 py-1 text-right font-medium">
                      width {k}%
                    </th>
                  ))}
                  <th className="px-1 py-1 text-right font-medium">mase</th>
                  <th className="px-1 py-1 text-right font-medium">s.crps</th>
                  {levelKeys.map((k) => (
                    <th key={`p${k}`} className="px-1 py-1 text-right font-medium">
                      pin {k}
                    </th>
                  ))}
                  <th className="px-1 py-1 text-center font-medium">clamp</th>
                </tr>
              </thead>
              <tbody>
                {d.evalRows.map((r: FcEvalRowUI) => (
                  <tr key={r.alias} className="border-b border-zinc-800/50 hover:bg-zinc-900/40">
                    <td className="px-1.5 py-1">
                      <span
                        className={`font-mono ${
                          r.intervals === 'conformal_distribution'
                            ? 'text-sky-300'
                            : r.intervals === 'conformal_error'
                              ? 'text-violet-300'
                              : r.intervals === 'enbpi'
                                ? 'text-emerald-300'
                                : r.intervals === 'aci'
                                  ? 'text-orange-300'
                                  : r.intervals === 'native_full'
                                    ? 'text-rose-300'
                                    : 'text-zinc-300'
                        }`}
                        title={r.intervals}
                      >
                        {r.alias}
                      </span>
                    </td>
                    {levelKeys.map((k) => (
                      <td key={`c${k}`} className="px-1 py-1 text-center">
                        <CoverageBadge level={k} coverage={r.coverage?.[k]} />
                      </td>
                    ))}
                    {levelKeys.map((k) => (
                      <td key={`w${k}`} className="px-1 py-1 text-right font-mono text-zinc-400">
                        {fmtW(r.width?.[k])}
                      </td>
                    ))}
                    <td className="px-1 py-1 text-right font-mono text-zinc-400">{fmt(r.mase)}</td>
                    <td className="px-1 py-1 text-right font-mono text-zinc-400">{fmt(r.scaledCrps)}</td>
                    {levelKeys.map((k) => (
                      <td key={`p${k}`} className="px-1 py-1 text-right font-mono text-zinc-400">
                        {r.pinball?.[k] != null ? fmt(r.pinball[k]) : '–'}
                      </td>
                    ))}
                    <td className="px-1 py-1 text-center">
                      {r.clampedAt ? (
                        <span
                          className="rounded border border-amber-700/60 bg-amber-900/30 px-1 py-px font-mono text-[8px] text-amber-300"
                          title={`native knots stop at the ${r.clampedAt}% band — wider levels clamp`}
                        >
                          @{r.clampedAt}
                        </span>
                      ) : (
                        <span className="text-zinc-700">–</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PerStepCoverage perStep={d.perStep} levels={config.levels} />
          <CoverageTimelineChart timeline={d.coverageTimeline ?? []} levels={config.levels} />
          <p className="px-1 text-[8px] leading-relaxed text-zinc-700">
            mase = mean absolute scaled error (seasonality-aware point accuracy; lower is better) · s.crps =
            scaled continuous ranked probability score from the interval bounds + median · pin = mean pinball
            loss at the band knots (calibration fidelity; lower is better) · clamp = widest level equals the
            narrowest band → the model&apos;s &quot;95%&quot; is really its 80%. Colors: conformal-dist sky ·
            conformal-error violet · EnbPI emerald · ACI orange · native-full rose.
          </p>
        </>
      )}
    </div>
  );
}

/** Coverage-over-time chart: per-cutoff band-hit ratio at the widest level.
 *  The drift detector — flat-on-nominal means calibration holds across the
 *  whole CV window; a dive flags a regime change the intervals missed. */
function CoverageTimelineChart({
  timeline,
  levels,
}: {
  timeline: { alias: string; points: { cutoff: number; steps: number; covered: Record<string, number>; width: number | null }[] }[];
  levels: number[];
}) {
  const widest = levels[levels.length - 1];
  const key = String(widest);
  const seriesWith = timeline.filter((t) => t.points.length >= 2);
  if (!seriesWith.length) return null;
  const W = 250;
  const H = 130;
  const PADL = 2;
  const PADB = 14;
  const TOP = 6;
  const nominalY = H - PADB - (widest / 100) * (H - PADB - TOP);
  const t0 = Math.min(...seriesWith.map((s) => s.points[0].cutoff));
  const t1 = Math.max(...seriesWith.map((s) => s.points[s.points.length - 1].cutoff));
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => PADL + ((t - t0) / span) * (W - PADL - 4);
  const y = (c: number) => (Number.isFinite(c) ? H - PADB - Math.max(0, Math.min(1, c)) * (H - PADB - TOP) : H - PADB);
  const stroke = (alias: string) =>
    alias.includes('EnbPI') ? '#34d399' : alias.includes('ACI') ? '#fb923c' : alias.includes('error') ? '#a78bfa' : alias.includes('distribution') ? '#38bdf8' : '#525a68';
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
      <p className="mb-1 text-[9px] text-zinc-500">
        coverage over time <span className="text-zinc-700">(per CV cutoff · widest level {widest}% · teal dashes = nominal)</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={0} x2={W} y1={H - PADB} y2={H - PADB} stroke="#3f4a5a" strokeWidth={1} />
        <line x1={0} x2={W} y1={nominalY} y2={nominalY} stroke="#2dd4bf" strokeOpacity={0.45} strokeDasharray="3 3" />
        <text x={W - 58} y={nominalY - 3} fill="#2dd4bf" fillOpacity={0.7} fontSize={7}>
          nominal {widest}%
        </text>
        {seriesWith.map((s) => (
          <polyline
            key={s.alias}
            fill="none"
            stroke={stroke(s.alias)}
            strokeWidth={s.alias.includes('FlowX') ? 1.6 : 1}
            strokeOpacity={s.alias.includes('FlowX') || s.alias.includes('Ensemble') ? 0.95 : 0.55}
            points={s.points
              .filter((p) => Number.isFinite(p.covered?.[key]))
              .map((p) => `${x(p.cutoff).toFixed(1)},${y(p.covered[key]).toFixed(1)}`)
              .join(' ')}
          />
        ))}
      </svg>
      <p className="text-[8px] text-zinc-700">
        {seriesWith.length} models × {seriesWith[0].points.length} cutoffs — a line diving under the dashed
        nominal is under-coverage (band too narrow for that window).
      </p>
    </div>
  );
}

/** per-horizon-step coverage mini chart (widest level). */
function PerStepCoverage({
  perStep,
  levels,
}: {
  perStep: { alias: string; steps: { step: number; coverage: number; width: number }[] }[];
  levels: number[];
}) {
  const widest = levels[levels.length - 1];
  const W = 250;
  const H = Math.max(90, Math.min(220, 10 + perStep.length * 15));
  const maxStep = Math.max(...perStep.map((p) => (p.steps.length ? p.steps[p.steps.length - 1].step : 0)), 1);
  const nominalY = H - 18 - (widest / 100) * (H - 28);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
      <p className="mb-1 text-[9px] text-zinc-500">
        coverage by horizon step <span className="text-zinc-700">(widest level {widest}% · green ≥ nominal)</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={0} x2={W} y1={H - 18} y2={H - 18} stroke="#3f4a5a" strokeWidth={1} />
        <line x1={0} x2={W} y1={nominalY} y2={nominalY} stroke="#2dd4bf" strokeOpacity={0.4} strokeDasharray="3 3" />
        <text x={2} y={nominalY - 3} fill="#2dd4bf" fillOpacity={0.6} fontSize={7}>
          nominal {widest}%
        </text>
        {perStep.map((p, i) => {
          const y = 3 + i * 15;
          const steps = p.steps;
          if (!steps.length) return null;
          return (
            <g key={p.alias}>
              <text x={0} y={y + 8} fill="#8b95a5" fontSize={7}>
                {p.alias.slice(0, 18)}
              </text>
              <rect x={62} y={y + 1} width={W - 62 - 16} height={9} fill="#141b26" rx={2} />
              {steps.map((s) => {
                const w = ((W - 62 - 16) * 0.92) / maxStep;
                const cov = Number.isFinite(s.coverage) ? Math.max(0, Math.min(1, s.coverage)) : 0;
                const cx = 62 + (s.step - 1) * w;
                const good = cov >= widest / 100 - 0.08;
                const mid = cov >= widest / 100 - 0.2;
                return (
                  <rect
                    key={s.step}
                    x={cx}
                    y={y + 1 + (1 - cov) * 9}
                    width={Math.max(1.5, w - 1)}
                    height={Math.max(1, cov * 9)}
                    fill={good ? '#34d399' : mid ? '#fbbf24' : '#fb7185'}
                    fillOpacity={0.85}
                    rx={1}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── calibration diagnostics ──────────────────────────────────────────────────

export function CalibPanel({ state, primaryAlias }: { state: FcFeedState; primaryAlias: string }) {
  const model = state.models.find((m) => m.alias === primaryAlias) ?? state.models[0];
  if (!model) return <p className="px-1 text-[10px] text-zinc-500">no model loaded.</p>;
  const calib = model.calibration;
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-2.5 py-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] text-teal-300">{model.alias}</span>
          <span className="text-[8px] uppercase tracking-wide text-zinc-600">{model.intervals}</span>
        </div>
        <p className="mt-0.5 text-[9px] leading-relaxed text-zinc-500">{model.note}</p>
        {model.modelLabel && <p className="mt-0.5 text-[8px] text-zinc-700">{model.modelLabel}</p>}
      </div>

      {calib ? (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            <Stat label="windows W" value={`${calib.nWindows}`} sub={`req ≥ ${calib.required} obs`} ok={calib.ok} />
            <Stat label="step Δ" value={`${calib.stepSize}`} sub="= h (non-overlap)" ok />
            <Stat label="history" value={`${calib.available}`} sub={calib.ok ? 'sufficient' : 'too short'} ok={calib.ok} />
          </div>
          {calib.errorByStep.some((e) => Number.isFinite(e)) ? (
            <ErrorByStep errorByStep={calib.errorByStep} />
          ) : (
            <p className="px-1 text-[9px] text-zinc-600">no calibration errors — history too short for W≥2.</p>
          )}
          <p className="px-1 text-[8px] leading-relaxed text-zinc-700">
            Calibration backtests the point forecast on W rolling h-step windows, keeps the absolute error at
            every horizon step, then builds intervals from those errors —{' '}
            {model.intervals === 'conformal_error'
              ? 'q̂ⱼ = Q₁₋α(e₁ⱼ…e_Wⱼ), symmetric around the point'
              : '2W synthetic outcomes ŷ±e, symmetric quantiles'}.
          </p>
        </>
      ) : (
        <p className="px-1 text-[9px] leading-relaxed text-zinc-600">
          native model — intervals come from the model&apos;s fixed quantile knots {'{0.1, 0.5, 0.9}'} on one-step
          residuals, so any level wider than 80% clamps to the 80% band. This is exactly the limitation
          conformal prediction exists to fix: intervals calibrated from the model&apos;s own backtested errors can
          reach as wide as the data requires.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, sub, ok }: { label: string; value: string; sub: string; ok?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2 py-1.5">
      <p className="text-[8px] uppercase tracking-wide text-zinc-600">{label}</p>
      <p className={`font-mono text-[12px] ${ok === false ? 'text-rose-400' : 'text-zinc-200'}`}>{value}</p>
      <p className="text-[8px] text-zinc-700">{sub}</p>
    </div>
  );
}

/** mean |calibration error| per horizon step — the width driver. */
function ErrorByStep({ errorByStep }: { errorByStep: number[] }) {
  const W = 250;
  const H = 84;
  const finite = errorByStep.filter(Number.isFinite);
  const maxE = Math.max(...finite, 0.000001);
  const stepW = (W - 26) / Math.max(1, errorByStep.length);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
      <p className="mb-1 flex items-center gap-1 text-[9px] text-zinc-500">
        <Sigma className="h-3 w-3 text-teal-400" /> mean |error| per horizon step
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={24} x2={W} y1={H - 14} y2={H - 14} stroke="#3f4a5a" strokeWidth={1} />
        {errorByStep.map((e, i) => {
          const h = Number.isFinite(e) ? (e / maxE) * (H - 26) : 0;
          return (
            <g key={i}>
              <rect
                x={24 + i * stepW}
                y={H - 14 - h}
                width={Math.max(1, stepW - 1.5)}
                height={h}
                fill="#2dd4bf"
                fillOpacity={0.55 + 0.4 * (Number.isFinite(e) ? e / maxE : 0)}
                rx={1}
              />
              {(i === 0 || i === errorByStep.length - 1 || i === Math.floor(errorByStep.length / 2)) && (
                <text x={24 + i * stepW} y={H - 5} fill="#5b6575" fontSize={6} textAnchor="middle">
                  {i + 1}
                </text>
              )}
            </g>
          );
        })}
        <text x={22} y={H - 20} fill="#8b95a5" fontSize={7} textAnchor="end">
          {maxE >= 1000 ? maxE.toFixed(0) : maxE >= 10 ? maxE.toFixed(1) : maxE.toFixed(3)}
        </text>
      </svg>
    </div>
  );
}

// ── live walk-forward coverage ───────────────────────────────────────────────

export function LiveCoveragePanel({ state }: { state: FcFeedState }) {
  const rows = state.liveCoverage ?? [];
  return (
    <div className="space-y-2">
      <p className="px-1 text-[9px] leading-relaxed text-zinc-600">
        Walk-forward check from the live stream: every tick re-forecasts and asks whether the fresh actual
        landed inside the previously emitted band (widest level). The running ratio is the empirical coverage
        you would experience using these intervals in production.
      </p>
      {!rows.length && <p className="px-1 text-[10px] text-zinc-500">collecting ticks… (needs a couple of ticks)</p>}
      {rows.map((r) => {
        const ok = Number.isFinite(r.ratio) && Math.abs(r.ratio - r.level / 100) <= 0.08;
        return (
          <div key={r.alias} className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-2.5 py-1.5">
            <div className="flex items-center justify-between font-mono text-[10px]">
              <span
                className={
                  r.alias.includes('distribution') ? 'text-sky-300' : r.alias.includes('error') ? 'text-violet-300' : 'text-zinc-300'
                }
              >
                {r.alias}
              </span>
              <span className={ok ? 'text-emerald-400' : 'text-zinc-400'}>
                {r.covered}/{r.total}
                {Number.isFinite(r.ratio) ? ` · ${(r.ratio * 100).toFixed(0)}%` : ''}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`}
                style={{ width: `${Number.isFinite(r.ratio) ? Math.max(2, Math.min(100, r.ratio * 100)) : 0}%` }}
              />
            </div>
            <div className="mt-0.5 flex justify-between text-[8px] text-zinc-700">
              <span>nominal {r.level}%</span>
              <span>hits vs ticks</span>
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2 px-1 text-[8px] text-zinc-700">
        {state.lastTickAt ? (
          <span className="flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-emerald-600" />
            last tick {Math.max(0, Math.round((Date.now() - state.lastTickAt) / 1000))}s ago
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Gauge className="h-3 w-3" /> waiting for first tick
          </span>
        )}
        <span className={`flex items-center gap-1 ${state.live ? 'text-emerald-600' : 'text-rose-400'}`}>
          <TrendingUp className="h-3 w-3" /> sse {state.live ? 'live' : 'down'}
        </span>
      </div>
    </div>
  );
}

// ── KPI strip ────────────────────────────────────────────────────────────────

/** compact KPI strip above the chart. */
export function ForecastKpiStrip({
  state,
  config,
  primaryAlias,
}: {
  state: FcFeedState;
  config: FcConfig;
  primaryAlias: string;
}) {
  useElapsedTick(5000);
  const model = state.models.find((m) => m.alias === primaryAlias) ?? state.models[0];
  const prov = state.panel?.provenance;
  const kpis: { label: string; value: string; sub?: string; tone?: 'teal' | 'amber' | 'rose' | 'zinc' }[] = [];
  if (model) {
    const last = model.rows[model.rows.length - 1];
    if (last && Number.isFinite(last.point)) {
      kpis.push({ label: `${model.alias} point`, value: fmt(last.point, 2), sub: `h=${config.h} last step`, tone: 'teal' });
    }
    const em = model.expectedMove;
    if (em) {
      kpis.push({
        label: `exp.move ${em.level}%`,
        value: `${fmtW(em.width)} wide`,
        sub: em.widthPct ? `${em.widthPct.toFixed(2)}% of price` : undefined,
        tone: 'amber',
      });
    }
    const calib = model.calibration;
    if (calib) {
      kpis.push({
        label: 'calibration',
        value: `W=${calib.nWindows}`,
        sub: calib.ok ? `Δ=${calib.stepSize}` : `short ${calib.available}/${calib.required}`,
        tone: calib.ok ? 'teal' : 'rose',
      });
    }
  }
  if (prov) {
    kpis.push({
      label: 'flow-bar history',
      value: `${prov.engineBars + prov.klinesBars}`,
      sub: prov.klineError ? `klines ✕ (${prov.klineError})` : `${prov.klinesBars} kline + ${prov.engineBars} engine`,
      tone: prov.klineError ? 'amber' : 'zinc',
    });
  }
  const toneCls = (t?: string) =>
    t === 'teal' ? 'text-teal-300' : t === 'amber' ? 'text-amber-400' : t === 'rose' ? 'text-rose-400' : 'text-zinc-200';
  return (
    <div className="flex flex-wrap gap-1.5">
      {kpis.map((k) => (
        <div key={k.label} className="min-w-[118px] flex-1 rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-2.5 py-1.5">
          <p className="text-[8px] uppercase tracking-wide text-zinc-600">{k.label}</p>
          <p className={`font-mono text-[13px] ${toneCls(k.tone)}`}>{k.value}</p>
          {k.sub && (
            <p className="truncate text-[8px] text-zinc-700" title={k.sub}>
              {k.sub}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** periodic re-render for "Ns ago" labels without spamming the parent. */
function useElapsedTick(ms: number): void {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(force, ms);
    return () => clearInterval(t);
  }, [ms, force]);
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK — forward-looking hedged portfolio (conformal bands → VaR → BTC hedges)
// + the analytics-storage ticker ("store now, analyze later" depth readout).
// ─────────────────────────────────────────────────────────────────────────────

interface PortfolioAssetUI {
  asset: string;
  weight: number;
  point: number | null;
  band80: [number, number] | null;
  band95: [number, number] | null;
  fwdSigmaPct: number | null;
  expMove80Pct: number | null;
  realizedVolPctHorizon: number | null;
  corrBtc: number | null;
  betaVsBtc: number | null;
  positionUsd: number;
  fwdVaR95Usd: number | null;
  hedgeUsd: number | null;
  residualVaR95Usd: number | null;
}

interface PortfolioUI {
  h: number;
  tfSec: number;
  notionalUsd: number;
  assets: PortfolioAssetUI[];
  corr: Array<{ a: string; b: string; rho: number | null }>;
  portfolio: {
    fwdVaR95Usd: number | null;
    fwdEs95Usd: number | null;
    fwdVolPct: number | null;
    realizedVolPct: number | null;
    hedgeFwdVaR95Usd: number | null;
  };
  scenarios: Array<{ btcMove: string; btcPct: number; unhedgedPnlUsd: number; hedgedPnlUsd: number }>;
  tsMs: number;
}

export function RiskPanel({ h, tfSec }: { h: number; tfSec: number }) {
  const [data, setData] = useState<PortfolioUI | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stored, setStored] = useState<{ flowBars: number; forecastRuns: number; micro: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(
          `/api/forecast/portfolio?h=${h}&tf=${tfSec}&notional=100000`,
        );
        const j = (await r.json()) as PortfolioUI | { error: string };
        if (!alive) return;
        if ('error' in j) setError(j.error);
        else {
          setData(j);
          setError(null);
        }
      } catch {
        if (alive) setError('portfolio fetch failed');
      } finally {
        if (alive) setLoading(false);
      }
    };
    const loadStore = async () => {
      try {
        const r = await fetch('/api/store/stats');
        const j = (await r.json()) as {
          assets?: Array<{ asset: string; flowBars: number; forecastRuns: number; microSnapshots: number }>;
        };
        if (!alive || !j.assets) return;
        const agg = j.assets.reduce(
          (a, x) => ({
            flowBars: a.flowBars + (x.flowBars ?? 0),
            forecastRuns: a.forecastRuns + (x.forecastRuns ?? 0),
            micro: a.micro + (x.microSnapshots ?? 0),
          }),
          { flowBars: 0, forecastRuns: 0, micro: 0 },
        );
        setStored(agg);
      } catch {
        /* storage ticker is cosmetic */
      }
    };
    void load();
    void loadStore();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [h, tfSec]);

  const fmtUsd = (v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1000) return `$${(v / 1000).toFixed(1)}k`;
    return `$${v.toFixed(0)}`;
  };
  const fmtPct = (v: number | null | undefined, digits = 2): string =>
    v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`;

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 px-2 py-4 text-[10px] text-zinc-500">
        <RefreshCw className="h-3 w-3 animate-spin" /> forecasting conformal bands for 8 majors…
      </div>
    );
  }
  if (error && !data) return <p className="px-2 py-3 text-[10px] text-rose-400">{error}</p>;
  if (!data) return null;

  const p = data.portfolio;
  const hedgeReduction =
    p.fwdVaR95Usd !== null && p.hedgeFwdVaR95Usd !== null && p.fwdVaR95Usd > 0
      ? (1 - p.hedgeFwdVaR95Usd / p.fwdVaR95Usd) * 100
      : null;
  const assets = data.assets;
  const symbols = assets.map((a) => a.asset);
  const rho = (a: string, b: string): number | null =>
    data.corr.find((c) => c.a === a && c.b === b)?.rho ?? null;
  const corrColor = (r: number | null): string => {
    if (r === null) return 'bg-zinc-900';
    const t = Math.min(1, Math.abs(r));
    if (r >= 0) return `rgba(45, 212, 191, ${0.08 + t * 0.55})`;
    return `rgba(244, 63, 94, ${0.08 + t * 0.55})`;
  };

  return (
    <div className="space-y-2">
      <p className="px-1 text-[9px] leading-relaxed text-zinc-600">
        Forward-looking book: conformal_error bands per asset (h={data.h} × {data.tfSec}s) → forward σ, weighted with the
        cross-asset correlation from each asset&apos;s own closes. Hedge = short BTC perp notional = β × position.
        Past σ shown for comparison — the future number is what the calibrated bands actually imply.
      </p>

      {/* portfolio strip */}
      <div className="grid grid-cols-2 gap-1.5">
        <Stat label="fwd VaR 95%" value={fmtUsd(p.fwdVaR95Usd)} sub={`ES ${fmtUsd(p.fwdEs95Usd)}`} ok />
        <Stat
          label="hedged VaR 95%"
          value={fmtUsd(p.hedgeFwdVaR95Usd)}
          sub={hedgeReduction !== null ? `β-hedge cuts ${hedgeReduction.toFixed(0)}%` : '—'}
          ok={hedgeReduction === null ? undefined : hedgeReduction > 0}
        />
        <Stat label="fwd vol (h)" value={fmtPct(p.fwdVolPct)} sub={`horizon ${(data.h * data.tfSec) / 60} min`} ok />
        <Stat
          label="realized vol (h)"
          value={fmtPct(p.realizedVolPct)}
          sub={p.fwdVolPct !== null && p.realizedVolPct !== null ? (p.fwdVolPct > p.realizedVolPct ? 'bands wider than past' : 'bands tighter than past') : '—'}
          ok
        />
      </div>

      {/* per-asset rows */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30">
        <div className="grid grid-cols-[52px_1fr_auto] items-center gap-1 border-b border-zinc-800/70 px-2 py-1 text-[8px] uppercase tracking-wider text-zinc-600">
          <span>asset</span>
          <span>exp move 80 / fwd σ / past σ</span>
          <span className="text-right">VaR95 · β · hedge · resid</span>
        </div>
        {assets.map((a) => (
          <div key={a.asset} className="grid grid-cols-[52px_1fr_auto] items-center gap-1 px-2 py-1 font-mono text-[9px]">
            <span className="text-zinc-300">
              {a.asset}
              <span className="ml-1 text-zinc-600">{(a.weight * 100).toFixed(0)}%</span>
            </span>
            <span className="text-zinc-400">
              {fmtPct(a.expMove80Pct)}
              <span className="text-zinc-600"> / </span>
              {fmtPct(a.fwdSigmaPct)}
              <span className="text-zinc-600"> / </span>
              {fmtPct(a.realizedVolPctHorizon)}
            </span>
            <span className="text-right text-zinc-400">
              {fmtUsd(a.fwdVaR95Usd)}
              <span className="text-zinc-600"> · </span>
              <span className="text-teal-300">{a.betaVsBtc !== null ? a.betaVsBtc.toFixed(2) : '—'}</span>
              <span className="text-zinc-600"> · </span>
              <span className="text-amber-300">{fmtUsd(a.hedgeUsd)}</span>
              <span className="text-zinc-600"> · </span>
              {fmtUsd(a.residualVaR95Usd)}
            </span>
          </div>
        ))}
      </div>

      {/* correlation heat */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
        <p className="mb-1 text-[8px] uppercase tracking-wider text-zinc-600">cross-asset correlation (returns, aligned closes)</p>
        <div className="flex flex-col items-center">
          <div className="flex">
            <div className="w-[52px]" />
            {symbols.map((s) => (
              <span key={s} className="w-[19px] text-center text-[7px] text-zinc-500">
                {s.slice(0, 3)}
              </span>
            ))}
          </div>
          {symbols.map((rowA) => (
            <div key={rowA} className="flex items-center">
              <span className="w-[52px] pr-1 text-right text-[7px] text-zinc-500">{rowA}</span>
              {symbols.map((colB) => {
                const r = rho(rowA, colB);
                return (
                  <div
                    key={colB}
                    className="h-[17px] w-[17px] rounded-[2px]"
                    style={{ background: corrColor(r), margin: '0.5px' }}
                    title={rowA === colB ? '1.00' : r !== null ? r.toFixed(2) : 'no data'}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* scenario grid */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-2">
        <p className="mb-1 text-[8px] uppercase tracking-wider text-zinc-600">
          BTC shock grid — P&amp;L on a $100k book, unhedged vs β-hedged
        </p>
        <div className="grid grid-cols-3 gap-1 font-mono text-[9px]">
          <span className="text-zinc-600">btc move</span>
          <span className="text-right text-zinc-600">unhedged</span>
          <span className="text-right text-zinc-600">hedged</span>
          {data.scenarios.map((s) => (
            <div key={s.btcMove} className="col-span-3 grid grid-cols-3 gap-1">
              <span className={s.btcPct > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {s.btcMove} ({s.btcPct >= 0 ? '+' : ''}
                {s.btcPct.toFixed(1)}%)
              </span>
              <span className={`text-right ${s.unhedgedPnlUsd >= 0 ? 'text-emerald-300/80' : 'text-rose-300/80'}`}>
                {fmtUsd(s.unhedgedPnlUsd)}
              </span>
              <span className="text-right text-zinc-300">{fmtUsd(s.hedgedPnlUsd)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* storage ticker */}
      <div className="flex items-center justify-between rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2 py-1 text-[8px] text-zinc-600">
        <span>storage: {stored ? `${stored.flowBars} flow bars · ${stored.micro} micro rows · ${stored.forecastRuns} forecast runs` : 'checking…'}</span>
        <span className="flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3 text-emerald-700" />
          {data.tsMs ? `${Math.max(0, Math.round((Date.now() - data.tsMs) / 1000))}s ago` : ''}
        </span>
      </div>
      {error && <p className="px-1 text-[9px] text-amber-500/80">refresh: {error}</p>}
    </div>
  );
}

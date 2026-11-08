'use client';

// ---------------------------------------------------------------------------
// json-cards — the FRONTEND half of the generative-UI integration.
//
// The same catalog the model emits specs against
// (src/lib/cards/catalog.ts) is wired here through @json-render/react's
// defineRegistry into real VolOS-styled components: stat grids, data
// tables, SVG sparklines & bars, research digests with clickable sources,
// insight lists, alerts and ACTION BUTTONS that drive the actual platform
// (load strategy → builder, paper-deploy → paper desk, open source → new tab).
//
// The chat panel renders every `render_card` tool invocation through
// <JsonCard spec={...}/> — cards stream into the conversation.
// ---------------------------------------------------------------------------

import { useMemo, createContext, useContext } from 'react';
import {
  defineRegistry,
  Renderer,
  StateProvider,
  VisibilityProvider,
  ActionProvider,
  type ComponentRegistry,
} from '@json-render/react';
import { cardsCatalog, type CardSpec } from '@/lib/cards/catalog';

// --- platform action bridge ---------------------------------------------------
// The chat panel registers its real handlers; card buttons call through.

export interface CardActionHandlers {
  onLoadStrategy: (strategyId: string) => void;
  onPaperDeploy: (variantName: string | null) => void | Promise<void>;
}

let actionHandlers: CardActionHandlers | null = null;

export function setCardActionHandlers(h: CardActionHandlers | null): void {
  actionHandlers = h;
}

// --- styling helpers ------------------------------------------------------------

const ACCENTS: Record<string, { bar: string; text: string }> = {
  teal: { bar: 'bg-teal-500/70', text: 'text-teal-300' },
  amber: { bar: 'bg-amber-500/70', text: 'text-amber-300' },
  rose: { bar: 'bg-rose-500/70', text: 'text-rose-300' },
  violet: { bar: 'bg-violet-500/70', text: 'text-violet-300' },
  zinc: { bar: 'bg-zinc-500/70', text: 'text-zinc-300' },
};

const CHART_COLORS: Record<string, string> = {
  teal: '#2dd4bf',
  amber: '#fbbf24',
  rose: '#fb7185',
  violet: '#a78bfa',
};

const ALERT_TONES: Record<string, string> = {
  info: 'border-sky-800/60 bg-sky-950/30 text-sky-200',
  success: 'border-teal-800/60 bg-teal-950/30 text-teal-200',
  warning: 'border-amber-800/60 bg-amber-950/30 text-amber-200',
  danger: 'border-rose-800/60 bg-rose-950/30 text-rose-200',
};

const INSIGHT_ICONS: Record<string, string> = {
  insight: '💡',
  risk: '⚠️',
  greek: 'Σ',
  timing: '⏱',
  flow: '🌊',
};

// --- sparkline ------------------------------------------------------------------

function Sparkline({ points, height = 64, color = 'teal', baseline }: { points: number[]; height?: number; color?: string; baseline?: number | null }) {
  const stroke = CHART_COLORS[color] ?? CHART_COLORS.teal;
  const w = 240;
  const h = height;
  if (!points || points.length < 2) return <div className="py-2 text-[10px] text-zinc-500">not enough points</div>;
  const min = Math.min(...points, baseline ?? Infinity);
  const max = Math.max(...points, baseline ?? -Infinity);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const y = (v: number) => h - 6 - ((v - min) / span) * (h - 12);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const baseY = baseline != null && Number.isFinite(baseline) ? y(baseline) : null;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }} preserveAspectRatio="none">
      {baseY != null && <line x1="0" y1={baseY} x2={w} y2={baseY} stroke="#52525b" strokeWidth="1" strokeDasharray="4 3" />}
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// --- the component registry -------------------------------------------------------

const components = {
  SectionCard: ({ props, children }: { props: { title: string; description?: string | null; accent?: string | null }; children?: React.ReactNode }) => {
    const accent = ACCENTS[props.accent ?? 'zinc'] ?? ACCENTS.zinc;
    return (
      <div className="overflow-hidden rounded-lg border border-zinc-800/70 bg-zinc-900/40">
        <div className="flex items-stretch">
          <div className={`w-[3px] shrink-0 ${accent.bar}`} />
          <div className="min-w-0 flex-1 p-2.5">
            <p className={`text-[10.5px] font-semibold uppercase tracking-[0.12em] ${accent.text}`}>{props.title}</p>
            {props.description ? <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">{props.description}</p> : null}
            <div className="mt-2 space-y-2">{children}</div>
          </div>
        </div>
      </div>
    );
  },

  Grid: ({ props, children }: { props: { columns?: number | null; gap?: string | null }; children?: React.ReactNode }) => (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${props.columns ?? 2}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  ),

  StatGrid: ({ props }: { props: { stats: Array<{ label: string; value: string | number; delta?: string | null; deltaPositive?: boolean | null; hint?: string | null }>; columns?: number | null } }) => (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(props.columns ?? 3, 4)}, minmax(0, 1fr))` }}>
      {props.stats.map((s, i) => (
        <div key={i} className="rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
          <p className="truncate text-[9px] font-medium uppercase tracking-wider text-zinc-500" title={s.label}>{s.label}</p>
          <p className="mt-0.5 truncate text-[13px] font-semibold tabular-nums text-zinc-100" title={String(s.value)}>{s.value}</p>
          {s.delta ? (
            <p className={`text-[9.5px] font-medium tabular-nums ${s.deltaPositive ? 'text-teal-400' : 'text-rose-400'}`}>{s.delta}</p>
          ) : null}
          {s.hint ? <p className="mt-0.5 truncate text-[9px] leading-tight text-zinc-600" title={s.hint}>{s.hint}</p> : null}
        </div>
      ))}
    </div>
  ),

  DataTable: ({ props }: { props: { title?: string | null; columns: Array<{ key: string; label: string; align?: string | null }>; rows: Array<Record<string, string | number | null>>; dense?: boolean | null } }) => (
    <div className="overflow-hidden rounded-md border border-zinc-800/60">
      {props.title ? <p className="border-b border-zinc-800/60 bg-zinc-900/60 px-2 py-1 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-400">{props.title}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b border-zinc-800/60 bg-zinc-900/30 text-zinc-500">
              {props.columns.map((c) => (
                <th key={c.key} className={`px-2 py-1 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r, i) => (
              <tr key={i} className="border-b border-zinc-800/40 last:border-0 text-zinc-300">
                {props.columns.map((c) => {
                  const v = r[c.key];
                  const num = typeof v === 'number';
                  return (
                    <td key={c.key} className={`px-2 py-1 tabular-nums ${c.align === 'right' || num ? 'text-right' : 'text-left'} ${num ? (v > 0 ? 'text-teal-300' : v < 0 ? 'text-rose-300' : '') : ''}`}>
                      {v == null ? '—' : String(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ),

  LineChart: ({ props }: { props: { label?: string | null; points: number[]; height?: number | null; color?: string | null; baseline?: number | null } }) => (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
      {props.label ? <p className="text-[9px] font-medium uppercase tracking-wider text-zinc-500">{props.label}</p> : null}
      <Sparkline points={props.points} height={props.height ?? 64} color={props.color ?? 'teal'} baseline={props.baseline} />
      <div className="flex justify-between text-[8.5px] tabular-nums text-zinc-600">
        <span>{props.points[0] != null ? props.points[0].toLocaleString() : ''}</span>
        <span>{props.points.length} pts</span>
        <span>{props.points[props.points.length - 1] != null ? props.points[props.points.length - 1].toLocaleString() : ''}</span>
      </div>
    </div>
  ),

  BarChart: ({ props }: { props: { label?: string | null; items: Array<{ label: string; value: number }>; color?: string | null } }) => {
    const max = Math.max(...props.items.map((i) => Math.abs(i.value)), 1);
    return (
      <div className="rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
        {props.label ? <p className="mb-1 text-[9px] font-medium uppercase tracking-wider text-zinc-500">{props.label}</p> : null}
        <div className="space-y-1">
          {props.items.map((it, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-[68px] shrink-0 truncate text-[9.5px] text-zinc-400" title={it.label}>{it.label}</span>
              <div className="h-[7px] min-w-0 flex-1 overflow-hidden rounded-sm bg-zinc-800/50">
                <div className={`h-full ${props.color === 'amber' ? 'bg-amber-500/70' : props.color === 'rose' ? 'bg-rose-500/70' : props.color === 'violet' ? 'bg-violet-500/70' : 'bg-teal-500/70'}`} style={{ width: `${(Math.abs(it.value) / max) * 100}%` }} />
              </div>
              <span className="w-[56px] shrink-0 text-right text-[9.5px] tabular-nums text-zinc-300">{it.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    );
  },

  // ── BackQuant analytics visuals ─────────────────────────────────────────────

  HeatMatrix: ({ props }: { props: { title?: string | null; rowLabels: string[]; colLabels: string[]; values: number[][]; unit?: string | null; diverging?: boolean | null; compact?: boolean | null } }) => {
    const rows = props.rowLabels ?? [];
    const cols = props.colLabels ?? [];
    const grid = (props.values ?? []).filter((r) => Array.isArray(r));
    const flat = grid.flat().filter((v) => Number.isFinite(v));
    if (rows.length < 2 || cols.length < 2 || flat.length === 0) {
      return <div className="py-2 text-[10px] text-zinc-500">heat matrix incomplete</div>;
    }
    const diverging = props.diverging ?? false;
    const maxAbs = Math.max(...flat.map(Math.abs), 1e-9);
    const fmt = (v: number) => {
      if (!Number.isFinite(v)) return '—';
      const a = Math.abs(v);
      if (props.compact !== false && a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
      if (props.compact !== false && a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
      if (props.compact !== false && a >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
      return `${Math.round(v * 100) / 100}`;
    };
    const cellStyle = (v: number): React.CSSProperties => {
      if (!Number.isFinite(v)) return { background: 'rgba(63,63,70,0.3)' };
      if (diverging) {
        const t = Math.min(Math.abs(v) / maxAbs, 1);
        const alpha = 0.12 + t * 0.68;
        return { background: v >= 0 ? `rgba(45,212,191,${alpha})` : `rgba(251,113,133,${alpha})` };
      }
      const t = Math.min(Math.max(v / (maxAbs || 100), 0), 1);
      const alpha = 0.08 + t * 0.72;
      return { background: `rgba(251,191,36,${alpha})` };
    };
    return (
      <div className="overflow-hidden rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
        {props.title ? <p className="mb-1 text-[9px] font-medium uppercase tracking-wider text-zinc-500">{props.title}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-[2px] text-[8.5px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-[1] bg-zinc-950/95 px-1 text-left font-medium text-zinc-500">—</th>
                {cols.map((c, i) => (
                  <th key={i} className="px-1 font-medium text-zinc-500" title={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((rLabel, ri) => (
                <tr key={ri}>
                  <td className="sticky left-0 z-[1] bg-zinc-950/95 px-1 text-right font-mono text-zinc-400" title={rLabel}>{rLabel}</td>
                  {cols.map((_, ci) => {
                    const v = grid[ri]?.[ci];
                    return (
                      <td
                        key={ci}
                        className="px-1 py-[3px] text-center font-mono tabular-nums"
                        style={cellStyle(v)}
                        title={v != null ? `${rLabel} × ${cols[ci]}: ${fmt(v)}${props.unit ? ` ${props.unit}` : ''}` : ''}
                      >
                        {v != null ? fmt(v) : '·'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {props.unit ? <p className="mt-1 text-[8px] text-zinc-600">unit: {props.unit}{diverging ? ' · teal + / rose −' : ' · intensity'}</p> : null}
      </div>
    );
  },

  LevelStrip: ({ props }: { props: { title?: string | null; spot: number; levels: Array<{ label: string; price: number; tone?: string | null }> } }) => {
    const levels = (props.levels ?? []).filter((l) => Number.isFinite(l.price));
    if (levels.length < 2 || !Number.isFinite(props.spot)) {
      return <div className="py-2 text-[10px] text-zinc-500">level strip incomplete</div>;
    }
    const all = [...levels.map((l) => l.price), props.spot];
    const min = Math.min(...all);
    const max = Math.max(...all);
    const pad = (max - min) * 0.06 || 1;
    const lo = min - pad;
    const hi = max + pad;
    const pos = (p: number) => ((p - lo) / (hi - lo)) * 100;
    const TONES: Record<string, { bar: string; text: string }> = {
      wall: { bar: 'bg-rose-500/80', text: 'text-rose-300' },
      support: { bar: 'bg-teal-500/80', text: 'text-teal-300' },
      flip: { bar: 'bg-amber-500/80', text: 'text-amber-300' },
      magnet: { bar: 'bg-violet-500/80', text: 'text-violet-300' },
    };
    const fmt = (p: number) => (p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(p * 100) / 100));
    return (
      <div className="rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-2">
        {props.title ? <p className="mb-1.5 text-[9px] font-medium uppercase tracking-wider text-zinc-500">{props.title}</p> : null}
        <div className="relative h-16">
          {/* level bars */}
          {levels.map((l, i) => {
            const tone = TONES[l.tone ?? ''] ?? { bar: 'bg-zinc-500/70', text: 'text-zinc-400' };
            return (
              <div key={i} className="absolute flex items-center gap-1" style={{ left: `${Math.min(Math.max(pos(l.price), 0), 100)}%`, top: `${(i % 2) * 30 + 2}px`, transform: 'translateX(-50%)' }}>
                <div className={`h-4 w-[2.5px] rounded ${tone.bar}`} />
                <span className={`whitespace-nowrap rounded bg-zinc-900/80 px-1 text-[8.5px] font-medium ${tone.text}`}>
                  {l.label} <span className="font-mono tabular-nums text-zinc-400">{fmt(l.price)}</span>
                </span>
              </div>
            );
          })}
          {/* spot line */}
          <div className="absolute bottom-0 top-0" style={{ left: `${Math.min(Math.max(pos(props.spot), 0), 100)}%`, transform: 'translateX(-50%)' }}>
            <div className="h-full w-[2px] rounded bg-zinc-100 shadow-[0_0_6px_rgba(255,255,255,0.5)]" />
          </div>
          <div className="absolute -translate-x-1/2 whitespace-nowrap rounded bg-zinc-100 px-1.5 py-px text-[9px] font-bold text-zinc-950" style={{ left: `${Math.min(Math.max(pos(props.spot), 0), 100)}%`, bottom: '-2px' }}>
            SPOT {fmt(props.spot)}
          </div>
          {/* baseline */}
          <div className="absolute bottom-0 left-0 right-0 h-px bg-zinc-800" />
        </div>
        <div className="mt-1 flex justify-between text-[8px] tabular-nums text-zinc-600">
          <span>{fmt(lo)}</span>
          <span>{fmt(hi)}</span>
        </div>
      </div>
    );
  },

  ResearchDigest: ({ props }: { props: { title: string; summary: string; findings?: Array<string | { title: string; detail: string }> | null; sources: Array<{ label: string; url: string }>; engine?: string | null } }) => (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-950/40 p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px]">🌐</span>
        <p className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-zinc-200">{props.title}</p>
        {props.engine ? <span className="shrink-0 rounded-full border border-zinc-700/60 px-1.5 py-px text-[8px] uppercase tracking-wider text-zinc-500">{props.engine}</span> : null}
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">{props.summary}</p>
      {props.findings && props.findings.length > 0 ? (
        <div className="mt-1.5 space-y-1">
          {props.findings.map((f, i) => {
            const item = typeof f === 'string' ? { title: f, detail: '' } : f;
            return (
              <div key={i} className="rounded border border-zinc-800/50 bg-zinc-900/30 px-1.5 py-1">
                <p className="text-[9.5px] font-medium text-zinc-300">{item.title}</p>
                {item.detail ? <p className="mt-0.5 text-[9.5px] leading-snug text-zinc-500">{item.detail}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {props.sources.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {props.sources.map((s, i) => (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="max-w-[180px] truncate rounded-full border border-teal-800/50 bg-teal-950/30 px-1.5 py-px text-[9px] text-teal-300 hover:bg-teal-900/40"
              title={s.url}
            >
              ↗ {s.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  ),

  InsightList: ({ props }: { props: { title?: string | null; items: Array<{ icon?: string | null; title: string; detail: string }> } }) => (
    <div className="space-y-1">
      {props.title ? <p className="text-[9.5px] font-semibold uppercase tracking-wider text-zinc-500">{props.title}</p> : null}
      {props.items.map((it, i) => (
        <div key={i} className="flex gap-1.5 rounded-md border border-zinc-800/50 bg-zinc-950/30 px-2 py-1.5">
          <span className="shrink-0 text-[11px] leading-none">{INSIGHT_ICONS[it.icon ?? 'insight'] ?? '💡'}</span>
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-zinc-200">{it.title}</p>
            <p className="mt-0.5 text-[9.5px] leading-snug text-zinc-500">{it.detail}</p>
          </div>
        </div>
      ))}
    </div>
  ),

  Alert: ({ props }: { props: { tone: string; title: string; detail?: string | null } }) => (
    <div className={`rounded-md border px-2.5 py-1.5 ${ALERT_TONES[props.tone] ?? ALERT_TONES.info}`}>
      <p className="text-[10px] font-semibold">{props.title}</p>
      {props.detail ? <p className="mt-0.5 text-[9.5px] leading-snug opacity-80">{props.detail}</p> : null}
    </div>
  ),

  ActionCard: ({ props }: { props: { title?: string | null; description?: string | null; buttons: Array<Record<string, unknown>> } }) => {
    // Accept both flat button props and `payload`-nested ones (model habit).
    const normalized = props.buttons.map((b) => {
      const payload = (b.payload ?? {}) as Record<string, unknown>;
      return { ...b, ...payload, payload: undefined } as unknown as {
        label?: string;
        action?: string;
        strategyId?: string | null;
        url?: string | null;
        variantName?: string | null;
        primary?: boolean | null;
      };
    });
    return (
      <ActionButtons
        title={props.title ?? null}
        description={props.description ?? null}
        buttons={normalized.map((b) => ({
          label: String(b.label ?? 'Go'),
          action: String(b.action ?? 'open_url'),
          strategyId: b.strategyId ?? null,
          url: b.url ?? null,
          variantName: b.variantName ?? null,
          primary: b.primary ?? false,
        }))}
      />
    );
  },
};

// --- action buttons (bridge to the platform) --------------------------------------

function ActionButtons({
  title,
  description,
  buttons,
}: {
  title: string | null;
  description: string | null;
  buttons: Array<{ label: string; action: string; strategyId?: string | null; url?: string | null; variantName?: string | null; primary?: boolean | null }>;
}) {
  const run = (btn: { action: string; strategyId?: string | null; url?: string | null; variantName?: string | null }) => {
    if (btn.action === 'load_strategy' && btn.strategyId) actionHandlers?.onLoadStrategy(btn.strategyId);
    else if (btn.action === 'paper_deploy') void actionHandlers?.onPaperDeploy(btn.variantName ?? null);
    else if (btn.action === 'open_url' && btn.url) window.open(btn.url, '_blank', 'noopener,noreferrer');
  };
  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-950/40 p-2">
      {title ? <p className="text-[9.5px] font-semibold uppercase tracking-wider text-zinc-500">{title}</p> : null}
      {description ? <p className="mt-0.5 text-[9.5px] text-zinc-500">{description}</p> : null}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {buttons.map((b, i) => (
          <button
            key={i}
            type="button"
            onClick={() => run(b)}
            className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${
              b.primary
                ? 'bg-teal-600/90 text-white hover:bg-teal-500'
                : 'border border-zinc-700/70 bg-zinc-900/60 text-zinc-300 hover:border-teal-700/60 hover:text-teal-200'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- registry + renderer ------------------------------------------------------------

const { registry, handlers } = defineRegistry(cardsCatalog, {
  components,
  actions: {
    load_strategy: async (params) => {
      const p = params as { strategyId?: string } | undefined;
      if (p?.strategyId) actionHandlers?.onLoadStrategy(p.strategyId);
    },
    paper_deploy: async (params) => {
      const p = params as { variantName?: string | null } | undefined;
      void actionHandlers?.onPaperDeploy(p?.variantName ?? null);
    },
    open_url: async (params) => {
      const p = params as { url?: string } | undefined;
      if (p?.url) window.open(p.url, '_blank', 'noopener,noreferrer');
    },
  },
});

export const cardRegistry: ComponentRegistry = registry;

/** Normalize a spec for rendering: default children arrays, drop broken refs. */
export function normalizeSpec(spec: unknown): CardSpec | null {
  if (!spec || typeof spec !== 'object') return null;
  const s = spec as { root?: unknown; elements?: unknown };
  if (typeof s.root !== 'string' || !s.elements || typeof s.elements !== 'object') return null;
  const raw = s.elements as Record<string, { type?: unknown; props?: unknown; children?: unknown }>;
  const elements: CardSpec['elements'] = {};
  for (const [k, el] of Object.entries(raw)) {
    if (!el || typeof el !== 'object' || typeof (el as { type?: unknown }).type !== 'string') continue;
    elements[k] = {
      type: (el as { type: string }).type,
      props: ((el as { props?: unknown }).props ?? {}) as Record<string, unknown>,
      children: Array.isArray((el as { children?: unknown }).children) ? ((el as { children?: unknown }).children as string[]) : [],
    };
  }
  if (!elements[s.root]) return null;
  return { root: s.root, elements };
}

/** One complete generative-UI card, rendered from a render_card spec. */
export function JsonCard({ spec }: { spec: unknown }) {
  const normalized = useMemo(() => normalizeSpec(spec), [spec]);
  if (!normalized) {
    return (
      <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-2.5 py-2 text-[10px] text-zinc-500">
        render_card: spec incomplete…
      </div>
    );
  }
  return (
    <StateProvider initialState={{}}>
      <VisibilityProvider>
        <ActionProvider handlers={handlers(() => undefined, () => ({}))}>
          <Renderer spec={normalized as never} registry={registry} />
        </ActionProvider>
      </VisibilityProvider>
    </StateProvider>
  );
}

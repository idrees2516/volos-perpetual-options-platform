'use client';

// ─────────────────────────────────────────────────────────────────────────────
// LegsPanel — the strategy legs editor. Every list child is rendered through a
// stable unique `leg.id` key (no array-index keys anywhere) so React never
// warns about duplicate/missing keys while legs are added, removed or edited.
// ─────────────────────────────────────────────────────────────────────────────

import { X, Plus, ChevronDown } from 'lucide-react';
import type { Leg, LegKind, ResolvedLeg } from '@/lib/types';
import { kindChip, kindLabel } from '@/lib/types';
import { fmtNum, fmtUsd } from '@/lib/format';

const KINDS: LegKind[] = ['call', 'put', 'perp_option', 'perp', 'spot'];

export function LegsPanel({
  legs, resolved, onChange, onAdd, onRemove, editable = true,
}: {
  legs: Leg[];
  resolved?: ResolvedLeg[];
  onChange?: (id: string, patch: Partial<Leg>) => void;
  onAdd?: (leg: Omit<Leg, 'id'>) => void;
  onRemove?: (id: string) => void;
  editable?: boolean;
}) {
  const res = (id: string) => resolved?.find((r) => r.id === id);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <div className="grid grid-cols-[28px_78px_64px_1fr_64px_58px_84px_92px_28px] gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800 bg-zinc-900/60">
        <span />
        <span>Type</span>
        <span>Side</span>
        <span>Strike</span>
        <span>DTE</span>
        <span>Ratio</span>
        <span className="text-right">Prem</span>
        <span className="text-right">Δ / Γ</span>
        <span />
      </div>
      <div className="max-h-72 overflow-y-auto">
        {legs.map((leg) => {
          const r = res(leg.id);
          return (
            <div
              key={leg.id}
              className="grid grid-cols-[28px_78px_64px_1fr_64px_58px_84px_92px_28px] gap-1 items-center px-2 py-1 text-[11px] hover:bg-zinc-900/40 border-b border-zinc-900"
            >
              <span
                className={`inline-flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold ${
                  leg.side === 'long'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-rose-500/15 text-rose-400'
                }`}
              >
                {leg.side === 'long' ? '+' : '−'}
              </span>
              {editable && onChange ? (
                <select
                  aria-label="leg type"
                  className="rounded bg-zinc-900 border border-zinc-800 px-1 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-emerald-600"
                  value={leg.kind}
                  onChange={(e) => onChange(leg.id, { kind: e.target.value as LegKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{kindChip[k]} {kindLabel[k]}</option>
                  ))}
                </select>
              ) : (
                <span className="text-zinc-300">{kindChip[leg.kind]} {kindLabel[leg.kind]}</span>
              )}
              {editable && onChange ? (
                <select
                  aria-label="leg side"
                  className="rounded bg-zinc-900 border border-zinc-800 px-1 py-0.5 text-[10px] outline-none focus:border-emerald-600"
                  value={leg.side}
                  onChange={(e) => onChange(leg.id, { side: e.target.value as 'long' | 'short' })}
                >
                  <option key="long" value="long">long</option>
                  <option key="short" value="short">short</option>
                </select>
              ) : (
                <span className={leg.side === 'long' ? 'text-emerald-400' : 'text-rose-400'}>{leg.side}</span>
              )}
              {leg.strikeOffsetPct !== undefined && editable && onChange ? (
                <select
                  aria-label="leg strike offset"
                  className="rounded bg-zinc-900 border border-zinc-800 px-1 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-emerald-600"
                  value={leg.strikeOffsetPct}
                  onChange={(e) => onChange(leg.id, { strikeOffsetPct: Number(e.target.value) })}
                >
                  {[-15, -12, -10, -8, -7, -6, -5, -4, -3, -2, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15].map((o) => (
                    <option key={o} value={o}>{o === 0 ? 'ATM' : `${o > 0 ? '+' : ''}${o}%`}</option>
                  ))}
                </select>
              ) : (
                <span className="text-zinc-300 font-mono">
                  {r?.strike != null
                    ? r.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })
                    : leg.kind === 'perp_option'
                      ? (leg.strikeOffsetPct ?? 0) >= 0 ? 'C∞ strike' : 'P∞ strike'
                      : '—'}
                </span>
              )}
              {editable && onChange && leg.kind !== 'spot' ? (
                <select
                  aria-label="leg dte"
                  className="rounded bg-zinc-900 border border-zinc-800 px-1 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-emerald-600"
                  value={leg.dte}
                  onChange={(e) => onChange(leg.id, { dte: Number(e.target.value) })}
                >
                  {[0, 1, 7, 14, 21, 30, 45, 60, 90, 180].map((d) => (
                    <option key={d} value={d}>{leg.kind === 'perp_option' ? '∞' : `${d}d`}</option>
                  ))}
                </select>
              ) : (
                <span className="text-zinc-400">{leg.kind === 'spot' ? '—' : leg.kind === 'perp_option' ? '∞' : `${leg.dte}d`}</span>
              )}
              {editable && onChange ? (
                <select
                  aria-label="leg ratio"
                  className="rounded bg-zinc-900 border border-zinc-800 px-1 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-emerald-600"
                  value={leg.ratio}
                  onChange={(e) => onChange(leg.id, { ratio: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>{n}×</option>
                  ))}
                </select>
              ) : (
                <span className="text-zinc-400">{leg.ratio}×</span>
              )}
              <span className={`text-right font-mono ${leg.side === 'long' ? 'text-rose-400' : 'text-emerald-400'}`}>
                {r ? `${leg.side === 'long' ? '−' : '+'}${fmtUsd(r.premium * leg.ratio)}` : '—'}
              </span>
              <span className="text-right font-mono text-zinc-400">
                {r && (leg.kind === 'call' || leg.kind === 'put' || leg.kind === 'perp_option')
                  ? `${fmtNum(r.delta, 2)} / ${fmtNum(r.gamma * 1000, 1)}k`
                  : '—'}
              </span>
              {editable && onRemove ? (
                <button
                  type="button"
                  aria-label={`remove leg ${leg.id}`}
                  className="text-zinc-600 hover:text-rose-400"
                  onClick={() => onRemove(leg.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
        {legs.length === 0 && (
          <div key="empty-legs" className="px-3 py-4 text-center text-[11px] text-zinc-600">
            no legs — add one below or pick from the 131-strategy catalog
          </div>
        )}
      </div>
      {editable && onAdd && (
        <div className="flex items-center justify-between px-2 py-1.5 border-t border-zinc-800 bg-zinc-900/40">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-emerald-600 hover:text-emerald-400"
            onClick={() => onAdd({ kind: 'call', side: 'long', strikeOffsetPct: 2, dte: 30, ratio: 1 })}
          >
            <Plus className="h-3 w-3" /> Add leg
          </button>
          <span className="text-[10px] text-zinc-600">{legs.length} legs · keyed by stable leg.id</span>
        </div>
      )}
    </div>
  );
}

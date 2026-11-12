'use client';

// ─────────────────────────────────────────────────────────────────────────────
// v1.9 shared UI bits — section cards, stat tiles, score bars.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';

export function SectionCard({
  title, icon, right, children, className = '',
}: {
  title: string; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-lg border border-zinc-800 bg-zinc-900/40 ${className}`}>
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        {icon && <span className="text-teal-400">{icon}</span>}
        <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-300">{title}</h3>
        {right && <div className="ml-auto text-[10px] text-zinc-500">{right}</div>}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Stat({
  label, value, sub, tone = 'default', className = '',
}: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: 'default' | 'pos' | 'neg' | 'teal' | 'amber'; className?: string;
}) {
  const toneCls =
    tone === 'pos' ? 'text-teal-400'
    : tone === 'neg' ? 'text-rose-400'
    : tone === 'teal' ? 'text-teal-300'
    : tone === 'amber' ? 'text-amber-400'
    : 'text-zinc-100';
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 ${className}`}>
      <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</div>
      <div className={`mt-1 font-mono text-sm font-semibold ${toneCls}`}>{value}</div>
      {sub !== undefined && <div className="mt-0.5 text-[9px] text-zinc-500">{sub}</div>}
    </div>
  );
}

export function ScoreBar({ value, tone = 'teal' }: { value: number; tone?: 'teal' | 'amber' }) {
  const pct = Math.max(2, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
      <div
        className={`h-full rounded-full ${tone === 'teal' ? 'bg-teal-400/80' : 'bg-amber-400/80'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Chip({
  children, tone = 'zinc', onClick, active,
}: {
  children: ReactNode; tone?: 'zinc' | 'teal' | 'amber' | 'rose' | 'emerald'; onClick?: () => void; active?: boolean;
}) {
  const tones: Record<string, string> = {
    zinc: 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
    teal: 'border-teal-500/40 bg-teal-400/10 text-teal-300',
    amber: 'border-amber-500/40 bg-amber-400/10 text-amber-300',
    rose: 'border-rose-500/40 bg-rose-400/10 text-rose-300',
    emerald: 'border-emerald-500/40 bg-emerald-400/10 text-emerald-300',
  };
  const cls = active ? 'border-teal-400/60 bg-teal-400/15 text-teal-300' : tones[tone];
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors hover:border-teal-500/50 ${cls}`}
      >
        {children}
      </button>
    );
  }
  return <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{children}</span>;
}

export const SENTIMENT_LABEL: Record<string, string> = {
  bullish: 'Bullish', bearish: 'Bearish', neutral: 'Neutral', volatile: 'Volatile', lowvol: 'Low Vol',
};

export const SENTIMENT_TONE: Record<string, 'teal' | 'rose' | 'zinc' | 'amber' | 'emerald'> = {
  bullish: 'emerald', bearish: 'rose', neutral: 'zinc', volatile: 'amber', lowvol: 'teal',
};

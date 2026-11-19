'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS · models-ui — the small shared controls every model panel
// uses: parameter sliders (shadcn), the course-note citation strip, and the
// readout row. Everything speaks the terminal's zinc/teal design language.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { Slider } from '@/components/ui/slider';
import { fmtNum } from '@/lib/format';

/** One labeled parameter slider (the "five numbers a desk actually quotes"). */
export function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: string;
}) {
  return (
    <div className="group">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-zinc-400" title={hint}>
          {label}
        </span>
        <span className="font-mono text-[10px] font-semibold text-teal-300">{(format ?? ((v: number) => fmtNum(v, 2)))(value)}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(vals: number[]) => onChange(vals[0])}
        aria-label={label}
        className="mt-1 h-1.5 cursor-pointer"
      />
    </div>
  );
}

/** The lecture citation: which parts of the course this model visualizes. */
export function CourseNote({ parts, idea }: { parts: string; idea: string }) {
  return (
    <p className="rounded-md border border-teal-900/40 bg-teal-950/20 px-2 py-1.5 text-[9px] leading-relaxed text-zinc-400">
      <span className="font-mono font-bold uppercase tracking-[0.14em] text-teal-400">{parts}</span>
      <span className="mx-1.5 text-zinc-600">·</span>
      {idea}
    </p>
  );
}

/** Compact readout line used under charts. */
export function Readout({ items }: { items: { label: string; value: React.ReactNode; tone?: 'teal' | 'rose' | 'amber' | 'zinc' }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[9px] text-zinc-500">
      {items.map((it) => (
        <span key={it.label} className="whitespace-nowrap">
          <span className="text-zinc-600">{it.label}</span>{' '}
          <span className={it.tone === 'teal' ? 'text-teal-300' : it.tone === 'rose' ? 'text-rose-300' : it.tone === 'amber' ? 'text-amber-300' : 'text-zinc-200'}>
            {it.value}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Re-roll button for seeded simulations (deterministic by design). */
export function RerollButton({ seed, onSeed }: { seed: number; onSeed: () => void }) {
  return (
    <button
      onClick={onSeed}
      title={`seed ${seed} — deterministic: same seed, same paths, same chart. Click to re-roll.`}
      className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 font-mono text-[8.5px] text-zinc-400 transition hover:border-teal-700/60 hover:text-teal-300"
    >
      <span className="text-zinc-600">seed</span>
      {seed}
      <span className="text-zinc-600">↻</span>
    </button>
  );
}

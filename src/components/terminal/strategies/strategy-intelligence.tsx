'use client';

// Strategy Intelligence tab — the educational layer of the unified Strategies
// workspace: what the strategy IS, when it is used, its advantages and
// disadvantages, and the detailed mechanics of how the strategy itself works.

import React from 'react';
import { BookOpen, Target, Cog, CheckCircle2, AlertTriangle, Tag } from 'lucide-react';
import type { StrategySpec } from '@/lib/strategies';

/** Group sentences into readable paragraphs (every N sentences). */
function paragraphs(text: string, per = 3): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += per) {
    out.push(sentences.slice(i, i + per).join(' '));
  }
  return out;
}

function Section({
  icon,
  title,
  accent,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3.5">
      <h3 className={`mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${accent}`}>
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

export function StrategyIntelligence({ spec }: { spec: StrategySpec }) {
  const mech = paragraphs(spec.mechanics, 3);

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {/* What it is */}
      <Section icon={<BookOpen className="h-3.5 w-3.5" />} title="What it is" accent="text-teal-300">
        <p className="text-xs leading-relaxed text-zinc-300">{spec.whatIs}</p>
        <p className="mt-2 border-t border-zinc-800/60 pt-2 text-[11px] leading-relaxed text-zinc-500">
          {spec.description}
        </p>
      </Section>

      {/* When to use */}
      <Section icon={<Target className="h-3.5 w-3.5" />} title="When it is used" accent="text-sky-300">
        <p className="text-xs leading-relaxed text-zinc-300">{spec.whenToUse}</p>
      </Section>

      {/* Detailed mechanics — full width */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3.5 xl:col-span-2">
        <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300">
          <Cog className="h-3.5 w-3.5" />
          How it works — detailed mechanics
        </h3>
        <div className="space-y-2.5">
          {mech.map((p, i) => (
            <p key={i} className="text-xs leading-relaxed text-zinc-300">
              {p}
            </p>
          ))}
        </div>
      </section>

      {/* Advantages */}
      <Section icon={<CheckCircle2 className="h-3.5 w-3.5" />} title={`Advantages (${spec.advantages.length})`} accent="text-emerald-300">
        <ul className="space-y-1.5">
          {spec.advantages.map((a, i) => (
            <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-zinc-300">
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500/80" />
              <span>{a}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* Disadvantages */}
      <Section icon={<AlertTriangle className="h-3.5 w-3.5" />} title={`Disadvantages (${spec.disadvantages.length})`} accent="text-rose-300">
        <ul className="space-y-1.5">
          {spec.disadvantages.map((d, i) => (
            <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-zinc-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-rose-500/80" />
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* Tags */}
      <section className="flex flex-wrap items-center gap-1.5 xl:col-span-2">
        <Tag className="h-3 w-3 text-zinc-600" />
        {spec.tags.map((t) => (
          <span
            key={t}
            className="rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 font-mono text-[9px] text-zinc-400"
          >
            {t}
          </span>
        ))}
      </section>
    </div>
  );
}

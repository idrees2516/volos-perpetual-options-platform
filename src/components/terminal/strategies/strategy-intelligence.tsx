'use client';

// Strategy Intelligence tab — the educational layer of the unified Strategies
// workspace: what the strategy IS, when it is used, its advantages and
// disadvantages, and the detailed mechanics of how the strategy itself works.
// Every card is a DockPanel: drag to reorder, pixel-resize, fullscreen focus,
// collapse (content stays mounted) — persisted per strategies-intelligence view.

import React from 'react';
import { CheckCircle2, AlertTriangle, Tag } from 'lucide-react';
import type { StrategySpec } from '@/lib/strategies';
import { Dock, DockPanel } from '@/components/terminal/dock/dock';

/** Group sentences into readable paragraphs (every N sentences). */
function paragraphs(text: string, per = 3): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += per) {
    out.push(sentences.slice(i, i + per).join(' '));
  }
  return out;
}

export function StrategyIntelligence({ spec }: { spec: StrategySpec }) {
  const mech = paragraphs(spec.mechanics, 3);

  return (
    <Dock viewId="strategies-intelligence" layout="grid">
      {/* What it is */}
      <DockPanel id="what-it-is" title="What it is" span={1}>
        <p className="text-xs leading-relaxed text-zinc-300">{spec.whatIs}</p>
        <p className="mt-2 border-t border-zinc-800/60 pt-2 text-[11px] leading-relaxed text-zinc-500">
          {spec.description}
        </p>
      </DockPanel>

      {/* When to use */}
      <DockPanel id="when-to-use" title="When it is used" span={1}>
        <p className="text-xs leading-relaxed text-zinc-300">{spec.whenToUse}</p>
      </DockPanel>

      {/* Detailed mechanics — full width */}
      <DockPanel id="mechanics" title="How it works — detailed mechanics" span={2}>
        <div className="space-y-2.5">
          {mech.map((p, i) => (
            <p key={i} className="text-xs leading-relaxed text-zinc-300">
              {p}
            </p>
          ))}
        </div>
      </DockPanel>

      {/* Advantages */}
      <DockPanel id="advantages" title={`Advantages (${spec.advantages.length})`} span={1}>
        <ul className="space-y-1.5">
          {spec.advantages.map((a, i) => (
            <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-zinc-300">
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500/80" />
              <span>{a}</span>
            </li>
          ))}
        </ul>
      </DockPanel>

      {/* Disadvantages */}
      <DockPanel id="disadvantages" title={`Disadvantages (${spec.disadvantages.length})`} span={1}>
        <ul className="space-y-1.5">
          {spec.disadvantages.map((d, i) => (
            <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-zinc-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-rose-500/80" />
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </DockPanel>

      {/* Tags */}
      <DockPanel id="tags" title="Tags" variant="bare" span={2}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag className="h-3 w-3 text-zinc-600" />
          {spec.tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 font-mono text-[9px] text-zinc-400"
            >
              {t}
            </span>
          ))}
        </div>
      </DockPanel>
    </Dock>
  );
}

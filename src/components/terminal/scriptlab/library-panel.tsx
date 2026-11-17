'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Script Lab — LibraryPanel. The 17-category script browser: category cards
// with live counts (built-in + saved), full-text search, one-click "open in
// editor + run". Saved user scripts (SQLite) merge into their categories and
// are deletable.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import {
  TrendingUp, Gauge, Waves, BarChart3, Network, Compass, Boxes, AudioWaveform,
  Shapes, Ruler, Sigma, Cpu, Clock, HeartPulse, Shield, Braces, BadgeCheck,
  ChevronLeft, Search, Trash2, Play, Sparkles,
} from 'lucide-react';
import { useScriptLab } from '@/stores/scriptlab-store';
import { SCRIPT_CATEGORIES, BUILTIN_SCRIPTS } from '@/lib/scriptlang/library';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  trend: <TrendingUp className="h-4 w-4" />,
  momentum: <Gauge className="h-4 w-4" />,
  volatility: <Waves className="h-4 w-4" />,
  volume_flow: <BarChart3 className="h-4 w-4" />,
  structure: <Network className="h-4 w-4" />,
  smc_ict: <Compass className="h-4 w-4" />,
  wyckoff: <Boxes className="h-4 w-4" />,
  elliott_harmonics: <AudioWaveform className="h-4 w-4" />,
  patterns: <Shapes className="h-4 w-4" />,
  levels: <Ruler className="h-4 w-4" />,
  statistics: <Sigma className="h-4 w-4" />,
  machine_learning: <Cpu className="h-4 w-4" />,
  time_sessions: <Clock className="h-4 w-4" />,
  sentiment_breadth: <HeartPulse className="h-4 w-4" />,
  risk_exits: <Shield className="h-4 w-4" />,
  meta: <Braces className="h-4 w-4" />,
  validation: <BadgeCheck className="h-4 w-4" />,
};

export function LibraryPanel() {
  const { userScripts, loadScript, deleteUserScript, rerun, bars } = useScriptLab();
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const cat of SCRIPT_CATEGORIES) c[cat.key] = 0;
    for (const s of BUILTIN_SCRIPTS) c[s.category] = (c[s.category] ?? 0) + 1;
    for (const s of userScripts) c[s.category] = (c[s.category] ?? 0) + 1;
    return c;
  }, [userScripts]);

  const listing = useMemo(() => {
    const items = [
      ...BUILTIN_SCRIPTS.map((s) => ({ ...s, user: false, id: `b:${s.name}` })),
      ...userScripts.map((s) => ({
        name: s.name,
        category: s.category,
        kind: (s.kind === 'strategy' ? 'strategy' : 'indicator') as 'strategy' | 'indicator',
        description: s.description ?? '',
        code: s.code,
        user: true,
        id: s.id,
      })),
    ];
    if (category) {
      const inCat = items.filter((s) => s.category === category);
      return inCat;
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      return items.filter(
        (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.category.includes(q),
      );
    }
    return [];
  }, [category, query, userScripts]);

  const open = (s: { name: string; code: string; category: string; description: string }) => {
    loadScript(s);
    // run immediately — bars are already loaded
    if (bars) setTimeout(() => rerun({ code: s.code, inputs: {} }), 0);
  };

  const catMeta = category ? SCRIPT_CATEGORIES.find((c) => c.key === category) : null;

  return (
    <div className="flex h-full min-h-0 flex-col p-2.5">
      {/* search */}
      <div className="relative mb-2 flex items-center gap-2">
        {category && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 border-zinc-800 bg-zinc-950 px-1.5 text-[10px]"
            onClick={() => setCategory(null)}
            title="Back to categories"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
        )}
        <Search className="absolute left-[10px] h-3 w-3 text-zinc-600" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value) setCategory(null);
          }}
          placeholder={category ? `search ${catMeta?.label}…` : 'search 17 categories…'}
          aria-label="Search scripts"
          className="h-7 border-zinc-800 bg-zinc-950 pl-6 text-[10.5px]"
        />
      </div>

      {/* body */}
      <ScrollArea className="min-h-0 flex-1">
        {category === null && !query.trim() ? (
          <div className="grid grid-cols-2 gap-1.5 pr-2">
            {SCRIPT_CATEGORIES.map((c) => (
              <button
                key={c.key}
                onClick={() => setCategory(c.key)}
                title={c.description}
                className="group flex items-center gap-2 rounded-lg border border-zinc-800/90 bg-zinc-900/40 px-2.5 py-2 text-left transition hover:border-teal-700/60 hover:bg-teal-950/30"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-800/80 text-teal-400/90 group-hover:bg-teal-900/60 group-hover:text-teal-300">
                  {CATEGORY_ICONS[c.key]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10.5px] font-semibold text-zinc-200">{c.label}</span>
                  <span className="block truncate text-[8.5px] text-zinc-600">{c.description}</span>
                </span>
                <span className="shrink-0 rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 group-hover:text-teal-300">
                  {counts[c.key] ?? 0}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-1 pr-2">
            {catMeta && !query && (
              <p className="px-0.5 pb-1 text-[9.5px] text-zinc-500">
                {catMeta.label} — {catMeta.description}
              </p>
            )}
            {listing.map((s) => (
              <div
                key={s.id}
                className="group flex items-center gap-2 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-2.5 py-1.5 transition hover:border-teal-700/50 hover:bg-zinc-900/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5">
                    <span className="truncate text-[10.5px] font-semibold text-zinc-200">{s.name}</span>
                    <span
                      className={`shrink-0 rounded px-1 py-px text-[7px] font-bold uppercase tracking-wider ${
                        s.kind === 'strategy'
                          ? 'bg-violet-950/70 text-violet-300 ring-1 ring-violet-500/25'
                          : 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/25'
                      }`}
                    >
                      {s.kind === 'strategy' ? 'strat' : 'ind'}
                    </span>
                    {s.user && (
                      <span className="shrink-0 text-[7.5px] font-bold uppercase tracking-wider text-amber-400/90">
                        <Sparkles className="inline h-2.5 w-2.5" /> saved
                      </span>
                    )}
                  </p>
                  <p className="truncate text-[8.5px] text-zinc-600">{s.description}</p>
                </div>
                <Button
                  size="sm"
                  className="h-6 shrink-0 gap-1 bg-teal-600/90 px-2 text-[9px] font-semibold text-zinc-950 hover:bg-teal-500"
                  onClick={() => open(s)}
                  title="Open in the editor and run"
                >
                  <Play className="h-2.5 w-2.5" /> open
                </Button>
                {s.user && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 border-zinc-800 bg-zinc-950 px-1.5 text-[9px] text-zinc-500 hover:text-rose-300"
                    onClick={() => deleteUserScript(s.id)}
                    title="Delete saved script"
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </Button>
                )}
              </div>
            ))}
            {listing.length === 0 && (
              <p className="px-1 py-4 text-center text-[10px] text-zinc-600">
                nothing here yet — clear the search or pick another category
              </p>
            )}
          </div>
        )}
      </ScrollArea>

      <p className="mt-1.5 border-t border-zinc-800/60 pt-1.5 text-[8.5px] text-zinc-600">
        {BUILTIN_SCRIPTS.length} built-in VolScript templates · {userScripts.length} saved by you · Pine v5-style syntax
      </p>
    </div>
  );
}

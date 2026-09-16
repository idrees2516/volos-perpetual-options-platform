'use client';

// Intent wizard — the research blueprint's outcome-first UX:
// "Tell us the risk or payoff you want; we construct it."
// Deterministic compiler in Rust generates candidates; user chooses.

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import {
  Compass, Shield, Coins, Waves, Loader2, ArrowRight, Sparkles, Target,
} from 'lucide-react';
import type { Leg, UnderlyingId } from '@/lib/types';
import { engine, RustIntentResponse } from '@/lib/api';
import { useMarket } from '@/hooks/use-market';
import { useStrategy } from '@/stores/strategy-store';
import { TEMPLATES } from '@/lib/templates';
import { fmtUsd } from '@/lib/format';

type Goal = 'direction' | 'protect' | 'income' | 'volatility';
type Dir = 'bullish' | 'bearish' | 'neutral';

const GOALS: { id: Goal; label: string; desc: string; icon: React.ReactNode }[] = [
  { id: 'direction', label: 'Trade a View', desc: '“I think BTC goes to $120k”', icon: <Compass className="h-5 w-5" /> },
  { id: 'protect', label: 'Protect', desc: '“Insure my holdings below $80k”', icon: <Shield className="h-5 w-5" /> },
  { id: 'income', label: 'Earn', desc: '“I’d happily sell ETH at $6k”', icon: <Coins className="h-5 w-5" /> },
  { id: 'volatility', label: 'Trade Volatility', desc: '“BTC vol will explode”', icon: <Waves className="h-5 w-5" /> },
];

export function WizardView({ onOpenBuilder }: { onOpenBuilder: () => void }) {
  const { smooth, market } = useMarket();
  const { underlying, setLegs, setStrategyName } = useStrategy();
  const asset = smooth[underlying] ?? market.assets[underlying];

  const [goal, setGoal] = useState<Goal>('direction');
  const [direction, setDirection] = useState<Dir>('bullish');
  const [horizon, setHorizon] = useState(30);
  const [targetPct, setTargetPct] = useState(25);
  const [maxLoss, setMaxLoss] = useState(2000);
  const [allowPerp, setAllowPerp] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RustIntentResponse | null>(null);

  const compile = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await engine.intent({
        underlying,
        goal,
        direction,
        horizon_days: horizon,
        target_move_pct: goal === 'income' ? targetPct : targetPct,
        max_loss_usd: maxLoss,
        allow_perpetual: allowPerp,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'engine unreachable');
      // Fallback: compile locally from templates.
      setResult(localCompile());
    } finally {
      setLoading(false);
    }
  };

  const localCompile = (): RustIntentResponse => {
    const map: Record<string, string[]> = {
      'direction|bullish': ['long-call', 'bull-call-spread', 'everlasting-call', 'perp-put'],
      'direction|bearish': ['long-put', 'bear-put-spread', 'everlasting-put'],
      protect: ['protective-put', 'collar', 'everlasting-put'],
      income: ['covered-call', 'cash-secured-put', 'short-strangle-wings'],
      volatility: ['long-straddle', 'long-strangle', 'iron-butterfly', 'everlasting-straddle'],
    };
    const key = goal === 'direction' ? `direction|${direction}` : goal;
    const ids = map[key] ?? ['long-call'];
    return {
      underlying,
      spot: asset.spot,
      compileUs: 0,
      notes: ['Compiled locally (client mirror) — Rust engine offline.'],
      candidates: ids
        .map((id) => TEMPLATES.find((t) => t.id === id))
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
        .map((t) => ({
          name: t.name,
          thesis: t.description,
          legs: t.build(asset.spot, underlying),
          category: t.category,
          maxLossClass: 'see builder',
          upsideClass: 'see builder',
          carryClass: '—',
          ivExposure: '—',
          liquidityClass: '—',
          suggested: false,
        })),
    };
  };

  const openInBuilder = (name: string, legs: Leg[]) => {
    setLegs(legs);
    setStrategyName(name);
    onOpenBuilder();
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[400px_minmax(0,1fr)]">
      {/* Intent form */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <Target className="h-3.5 w-3.5 text-teal-400" /> What do you want to achieve?
        </h2>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {GOALS.map((g) => (
            <button
              key={g.id}
              onClick={() => { setGoal(g.id); setResult(null); if (g.id === 'protect') setDirection('bearish'); }}
              className={`rounded-lg border p-3 text-left transition ${
                goal === g.id
                  ? 'border-teal-500/50 bg-teal-950/25'
                  : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/60'
              }`}
            >
              <span className={goal === g.id ? 'text-teal-300' : 'text-zinc-400'}>{g.icon}</span>
              <p className={`mt-1.5 text-xs font-semibold ${goal === g.id ? 'text-teal-200' : 'text-zinc-200'}`}>{g.label}</p>
              <p className="mt-0.5 text-[9px] leading-tight text-zinc-500">{g.desc}</p>
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-4">
          {(goal === 'direction' || goal === 'protect') && (
            <div>
              <Label className="text-[10px] uppercase tracking-wider text-zinc-500">Direction</Label>
              <div className="mt-1.5 grid grid-cols-3 gap-1">
                {(['bullish', 'bearish', 'neutral'] as Dir[]).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDirection(d)}
                    className={`rounded-md py-1.5 text-[11px] font-medium capitalize transition ${
                      direction === d
                        ? d === 'bullish'
                          ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40'
                          : d === 'bearish'
                            ? 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/40'
                            : 'bg-zinc-700/30 text-zinc-300 ring-1 ring-zinc-600'
                        : 'bg-zinc-900/50 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between">
              <Label className="text-[10px] uppercase tracking-wider text-zinc-500">Horizon</Label>
              <span className="font-mono text-xs text-zinc-300">{horizon} days</span>
            </div>
            <Slider value={[horizon]} min={7} max={180} step={1} onValueChange={(v) => setHorizon(v[0])} className="mt-2" />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label className="text-[10px] uppercase tracking-wider text-zinc-500">
                {goal === 'income' ? 'Exit premium target' : 'Target move'}
              </Label>
              <span className="font-mono text-xs text-zinc-300">{goal === 'direction' && direction === 'bearish' ? '−' : '+'}{targetPct}%</span>
            </div>
            <Slider value={[targetPct]} min={5} max={100} step={5} onValueChange={(v) => setTargetPct(v[0])} className="mt-2" />
          </div>

          <div>
            <Label className="text-[10px] uppercase tracking-wider text-zinc-500">Maximum loss budget (USD)</Label>
            <Input
              type="number"
              value={maxLoss}
              min={100}
              step={100}
              onChange={(e) => setMaxLoss(Math.max(parseFloat(e.target.value) || 100, 100))}
              className="mt-1.5 border-zinc-800 bg-zinc-900/50 font-mono text-sm"
            />
          </div>

          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2.5">
            <div>
              <p className="text-xs font-medium text-zinc-200">Allow perpetual structures</p>
              <p className="text-[9px] text-zinc-500">Everlasting options &amp; auto-rolled exposures</p>
            </div>
            <input
              type="checkbox"
              checked={allowPerp}
              onChange={(e) => setAllowPerp(e.target.checked)}
              className="h-4 w-4 accent-teal-500"
            />
          </label>

          <Button
            onClick={compile}
            disabled={loading}
            className="w-full gap-2 bg-teal-600 font-semibold text-zinc-950 hover:bg-teal-500"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Compile candidate strategies
          </Button>
          {error && (
            <p className="text-[10px] leading-relaxed text-amber-500/80">
              Rust compiler unreachable — using the local mirror. {error}
            </p>
          )}
        </div>
      </section>

      {/* Candidates */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            <Sparkles className="h-3.5 w-3.5 text-teal-400" /> Candidate Structures
          </h2>
          {result && (
            <Badge variant="outline" className="border-teal-500/30 bg-teal-950/30 text-[9px] font-normal text-teal-300">
              compiled in {result.compileUs}µs · deterministic
            </Badge>
          )}
        </div>

        {!result && (
          <div className="flex min-h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 p-8 text-center">
            <Target className="h-6 w-6 text-zinc-700" />
            <p className="max-w-sm text-xs leading-relaxed text-zinc-500">
              Express an economic outcome — the compiler generates multiple defined structures that satisfy it,
              then you choose. You never have to think in strikes first.
            </p>
          </div>
        )}

        {result && (
          <div className="space-y-2">
            {result.notes?.map((n, i) => (
              <p key={i} className="rounded-md bg-zinc-900/50 px-3 py-1.5 text-[10px] leading-relaxed text-zinc-500">{n}</p>
            ))}
            {result.candidates.map((c, i) => (
              <div
                key={i}
                className={`group rounded-lg border p-3 transition ${
                  c.suggested
                    ? 'border-teal-500/40 bg-teal-950/15'
                    : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-zinc-100">{c.name}</p>
                  {c.suggested && <Badge className="bg-teal-600/20 text-[8px] text-teal-300 hover:bg-teal-600/20">RECOMMENDED</Badge>}
                  <Badge variant="outline" className="border-zinc-700 bg-zinc-950 text-[8px] font-normal text-zinc-500">
                    {c.legs.length} leg{c.legs.length > 1 ? 's' : ''}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openInBuilder(c.name, c.legs)}
                    className="ml-auto h-6 gap-1 border-teal-500/40 bg-teal-950/30 px-2 text-[10px] font-medium text-teal-300 hover:bg-teal-900/40"
                  >
                    Open in Builder <ArrowRight className="h-3 w-3" />
                  </Button>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{c.thesis}</p>
                <div className="mt-2 grid grid-cols-2 gap-1.5 text-[9px] sm:grid-cols-4">
                  <MiniProp label="Max loss" value={c.maxLossClass} />
                  <MiniProp label="Upside" value={c.upsideClass} />
                  <MiniProp label="Carry" value={c.carryClass} />
                  <MiniProp label="IV exposure" value={c.ivExposure} />
                </div>
              </div>
            ))}
            <p className="pt-1 text-[9px] leading-relaxed text-zinc-600">
              Pareto comparison, not a single &ldquo;AI score&rdquo;: the research blueprint insists candidates are
              shown with their consequences — you keep the agency. Spot reference {fmtUsd(result.spot)}.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function MiniProp({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1">
      <p className="text-[8px] uppercase tracking-wide text-zinc-600">{label}</p>
      <p className="truncate text-[10px] text-zinc-300" title={value}>{value}</p>
    </div>
  );
}

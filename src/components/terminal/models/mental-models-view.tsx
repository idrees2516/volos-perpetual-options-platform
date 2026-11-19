'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MENTAL MODELS — the options-market mental-model lab. A course-map of the
// "Quant, Built" 43-part series (7 acts + finale) rendered as INTERACTIVE
// IN-DEPTH MODELS: every lecture's signature picture — the payoff melting,
// the Greeks atlas, the SVI surface with its arbitrage valley, the gamma
// scalper's live ledger, the exotics zoo, the book as queues — built from
// the deterministic, unit-tested engines in src/lib/models.
//
// Layout: left = the course map (acts, collapsible; every model cites its
// lecture parts); right = the active model's workspace, where every panel is
// a DockPanel — draggable, resizable, expandable, collapsible, persisted.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react';
import { Brain, ChevronDown, ChevronRight, GraduationCap } from 'lucide-react';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { RandomWalkModel, BookQueuesModel, LiquidationModel } from './panels-randomwalk';
import {
  BsmSurfaceModel, GreeksAtlasModel, TreePdeModel, AmericanPutModel, McEngineModel, GramCharlierModel,
} from './panels-pricing';
import { SviSurfaceModel, DupireModel, VarSwapModel, SurfacePcaModel } from './panels-volatility';
import {
  GammaScalpModel, PnlExplainModel, WwBandModel, PinningModel, MmInventoryModel, StrategyShapesModel,
} from './panels-trading';
import { ExoticsZooModel } from './panels-exotics';

type ModelId =
  | 'random-walk' | 'book-queues' | 'liquidation'
  | 'bsm-surface' | 'greeks-atlas' | 'tree-pde' | 'american-put' | 'mc-engine' | 'gram-charlier'
  | 'svi-surface' | 'dupire' | 'varswap' | 'surface-pca'
  | 'gamma-scalp' | 'pnl-explain' | 'ww-band' | 'pinning' | 'mm-inventory' | 'strategy-shapes'
  | 'exotics-zoo';

interface ModelDef {
  id: ModelId;
  title: string;
  /** the one-line mental model */
  idea: string;
}

interface Act {
  /** act number in the course */
  n: string;
  title: string;
  /** which course parts this act spans */
  parts: string;
  models: ModelDef[];
}

const ACTS: Act[] = [
  {
    n: 'I',
    title: 'Markets & Money',
    parts: 'Parts 1–3',
    models: [
      { id: 'random-walk', title: 'The fair game', idea: 'the random walk, the √t law, P vs Q — two worlds, one market' },
      { id: 'book-queues', title: 'The book as queues', idea: 'resting depth over price × time — walls, sweeps, the tape' },
      { id: 'liquidation', title: 'Margin & liquidation', idea: 'the reflection principle prices P(touch) — leverage as a barrier short' },
    ],
  },
  {
    n: 'II',
    title: 'Mathematical Toolkit',
    parts: 'Parts 4–8',
    models: [
      { id: 'mc-engine', title: 'Monte Carlo engine', idea: 'the price as an expectation — path cloud, 1/√n convergence' },
    ],
  },
  {
    n: 'III',
    title: 'Derivatives (Q)',
    parts: 'Parts 9–22 — the options core',
    models: [
      { id: 'bsm-surface', title: 'V(S, τ) — the payoff melting', idea: 'the hockey-stick ridge convolved by the heat kernel' },
      { id: 'greeks-atlas', title: 'Greeks atlas', idea: 'Δ Γ Θ 𝒱 ρ vanna volga charm speed — the risk report as terrain' },
      { id: 'tree-pde', title: 'The tree → the PDE', idea: 'CRR sawtooth onto the closed form; the lattice as a surface' },
      { id: 'american-put', title: 'The American put', idea: 'the free boundary S*(t) — when patience stops paying' },
      { id: 'gram-charlier', title: 'The smile from moments', idea: 'skewness tilts it, kurtosis curls it — density ⟺ surface' },
      { id: 'svi-surface', title: 'The volatility surface', idea: 'SVI slices on a term structure — with the arbitrage valley glowing' },
      { id: 'dupire', title: 'Local volatility', idea: 'the diffusion the surface implies — and its forward-smile flaw' },
      { id: 'varswap', title: 'The variance swap strip', idea: '1/K² weights — the log contract, the VIX recipe' },
      { id: 'surface-pca', title: 'How the surface moves', idea: 'level breathing, term twist, skew tilt — three eigen-surfaces' },
      { id: 'gamma-scalp', title: 'The gamma scalper', idea: 'the ledger ½ΓS²[(ΔS/S)² − σᵢ²Δt], live, on the ridge' },
      { id: 'pnl-explain', title: 'The P&L explain', idea: 'the morning waterfall — delta…vanna, unexplained' },
      { id: 'ww-band', title: 'The no-trade corridor', idea: 'Whalley–Wilmott — the cube root of cost; Leland measured' },
      { id: 'strategy-shapes', title: 'Strategy shapes', idea: 'every structure as a P&L surface over (spot, vol)' },
      { id: 'exotics-zoo', title: 'The exotics zoo', idea: 'every kind of option — barriers, asians, lookbacks, autocalls, perpetuals' },
    ],
  },
  {
    n: 'VI',
    title: 'Market Microstructure',
    parts: 'Parts 35–39',
    models: [
      { id: 'pinning', title: 'Pinning at expiry', idea: 'dealer gamma pulls spot to the strike — the 0DTE force' },
      { id: 'mm-inventory', title: 'The market maker', idea: 'inventory skew vs adverse selection — 64 → 9' },
    ],
  },
];

const MODEL_COMPONENTS: Record<ModelId, React.ComponentType> = {
  'random-walk': RandomWalkModel,
  'book-queues': BookQueuesModel,
  'liquidation': LiquidationModel,
  'bsm-surface': BsmSurfaceModel,
  'greeks-atlas': GreeksAtlasModel,
  'tree-pde': TreePdeModel,
  'american-put': AmericanPutModel,
  'mc-engine': McEngineModel,
  'gram-charlier': GramCharlierModel,
  'svi-surface': SviSurfaceModel,
  'dupire': DupireModel,
  'varswap': VarSwapModel,
  'surface-pca': SurfacePcaModel,
  'gamma-scalp': GammaScalpModel,
  'pnl-explain': PnlExplainModel,
  'ww-band': WwBandModel,
  'pinning': PinningModel,
  'mm-inventory': MmInventoryModel,
  'strategy-shapes': StrategyShapesModel,
  'exotics-zoo': ExoticsZooModel,
};

const ALL_MODEL_IDS = ACTS.flatMap((a) => a.models.map((m) => m.id));

export function MentalModelsView() {
  const [modelId, setModelId] = usePersistedState<ModelId>('volos-models-view', 'bsm-surface');
  const [openActs, setOpenActs] = usePersistedState<Record<string, boolean>>('volos-models-acts', { III: true });

  // guard persisted ids against catalog changes
  useEffect(() => {
    if (!ALL_MODEL_IDS.includes(modelId)) setModelId('bsm-surface');
  }, [modelId, setModelId]);

  const Active = useMemo(() => MODEL_COMPONENTS[modelId] ?? BsmSurfaceModel, [modelId]);
  const activeDef = ACTS.flatMap((a) => a.models).find((m) => m.id === modelId);

  const total = ALL_MODEL_IDS.length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-bold tracking-tight text-zinc-100">
            <Brain className="h-4 w-4 text-teal-400" />
            Mental Models Lab
          </h2>
          <p className="text-[9px] uppercase tracking-[0.16em] text-zinc-500">
            the options market, one in-depth interactive model per lecture · 3D surfaces · deterministic engines · {total} models
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1 rounded-md border border-teal-800/40 bg-teal-950/30 px-2 py-1 text-[8.5px] font-semibold uppercase tracking-[0.12em] text-teal-300">
            <GraduationCap className="h-3 w-3" />
            quant, built · 43 parts
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-2">
        {/* ── course map ─────────────────────────────────────────────────── */}
        <aside className="w-[46px] shrink-0 overflow-y-auto overflow-x-hidden rounded-lg border border-zinc-800 bg-zinc-950/50 transition-[width] duration-200 md:w-[218px]" aria-label="Mental model catalog">
          <div className="px-2 py-2">
            <p className="hidden px-1 text-[8px] font-bold uppercase tracking-[0.18em] text-zinc-500 md:block">course map · 7 acts</p>
          </div>
          {ACTS.map((act) => {
            const open = openActs[act.n] ?? false;
            return (
              <div key={act.n} className="mb-1">
                <button
                  onClick={() => setOpenActs((s: Record<string, boolean>) => ({ ...s, [act.n]: !open }))}
                  className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-[9px] font-bold uppercase tracking-[0.12em] text-zinc-500 transition hover:text-zinc-300"
                  aria-expanded={open}
                >
                  {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <span className="hidden truncate md:inline">
                    act {act.n} · {act.title}
                  </span>
                  <span className="hidden shrink-0 text-zinc-700 md:inline">{act.parts}</span>
                </button>
                {open && (
                  <div className="space-y-0.5 px-1">
                    {act.models.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setModelId(m.id)}
                        title={m.idea}
                        className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left transition md:flex-row md:items-baseline md:gap-2 ${
                          modelId === m.id ? 'bg-teal-950/60 text-teal-300 ring-1 ring-teal-500/30' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                        }`}
                      >
                        <span className="hidden w-4 shrink-0 font-mono text-[8px] text-zinc-600 md:inline">{act.n}</span>
                        <span className="text-[10px] font-medium leading-tight">{m.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="mt-1 px-2 pb-2">
            <p className="hidden text-[8px] leading-relaxed text-zinc-600 md:block">
              acts IV–V (P-measure premia, portfolios) and VII (the system) live in the Quant, Forecast and Order Flow labs — this lab is the Q-world&apos;s mental models.
            </p>
          </div>
        </aside>

        {/* ── active model workspace ────────────────────────────────────── */}
        <section className="min-w-0 flex-1 overflow-y-auto">
          {activeDef && (
            <p className="mb-2 truncate text-[9.5px] text-zinc-600">
              <span className="font-semibold text-zinc-400">{activeDef.title}</span>
              <span className="mx-1.5 text-zinc-700">—</span>
              {activeDef.idea}
            </p>
          )}
          <Active />
        </section>
      </div>
    </div>
  );
}

'use client';

// Market research view — the competitive gap analysis distilled from the
// deep research: what Derive / Paradex / Paradigm / Aevo / Panoptic / Rysk
// have built, what's still missing, and how VolOS fills the white space.

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Telescope, AlertTriangle, Lightbulb, Route, Layers, Database,
  CheckCircle2, XCircle, MinusCircle, ArrowRight,
} from 'lucide-react';

// ----------------------------------------------------------------------

const LANDSCAPE = [
  { name: 'Deribit', tag: 'CEX benchmark', stat: '$64.5B', label: 'options turnover, Aug 2026', note: 'The liquidity gravity well. Coinbase is integrating it into a unified derivatives platform.' },
  { name: 'Derive', tag: 'onchain CLOB', stat: '$3.05B', label: 'trailing 30d onchain options notional', note: 'Offchain matching + onchain settlement, portfolio margin recognizing multi-leg offsets.' },
  { name: 'Paradex', tag: 'perp + perpetual options', stat: '~$66M', label: '30d options notional', note: 'Launched crypto-native perpetual options; 24-scenario portfolio margin (beta); <50ms P95 targets; 25-leg RFQs.' },
  { name: 'Paradigm', tag: 'institutional RFQ network', stat: '25+ legs', label: 'atomic multi-leg RFQ support', note: 'Strategy-level block trades that settle atomically or reject entirely. The institutional liquidity discovery layer.' },
  { name: 'Aevo', tag: 'offchain matching', stat: '<10ms', label: 'advertised exchange latency', note: 'Offchain matching with onchain positions; OTC-style altcoin options.' },
  { name: 'Panoptic', tag: 'AMM-native perpetuals', stat: 'V1 → V2', label: 'rebuilt after vulnerability', note: 'Perpetual options from Uniswap liquidity; streaming premia. Novel but complex — V1 was disabled after a discovered bug.' },
  { name: 'Rysk', tag: 'outcome UX', stat: '2 products', label: 'covered calls & CSPs', note: '“Get paid to sell higher / buy lower” — excellent abstraction, but positions can’t close before expiry yet.' },
];

const GAPS = [
  {
    title: 'Strike-first UX instead of outcome-first',
    detail: 'Every platform still makes users think in “BTC-27NOV26-95000-C, IV 57.2, Δ 0.34” before they can express “I think BTC goes to $120k, willing to risk $2k”. The intent layer is missing everywhere.',
    severity: 'critical',
  },
  {
    title: 'Perpetual options hide their true cost',
    detail: 'Removing expiry doesn’t remove complexity — it converts it into an ongoing, path-dependent funding process. No platform shows Carry-at-Risk, funding stress scenarios, or budget-based order types.',
    severity: 'critical',
  },
  {
    title: 'No strategy-level liquidity',
    detail: 'An iron condor is one economic position, not four unrelated orders. Only Paradigm RFQ treats it that way institutionally; retail-facing platforms still assemble legs one by one, paying spreads on each.',
    severity: 'high',
  },
  {
    title: 'Positions die at expiry',
    detail: 'No auto-roll, no persistent hedges. Users wanting continuous protection must manually manage rolls — exactly the failure mode everlasting options were invented to solve, yet dated options still dominate UX.',
    severity: 'high',
  },
  {
    title: 'Exit liquidity is invisible',
    detail: 'Platforms advertise entry prices. But options become illiquid when spot moves away from strikes. No liquidity score, no unwind-cost estimate after ±20% moves.',
    severity: 'medium',
  },
  {
    title: 'Risk engines don’t explain themselves',
    detail: 'Margin numbers appear as black boxes. No P&L attribution (delta vs gamma vs vega vs theta vs funding), no scenario walkthrough before committing capital.',
    severity: 'medium',
  },
  {
    title: 'Fragmented liquidity, no routing',
    detail: 'Derive, Paradex, Deribit, Aevo each hold pieces. No cross-venue strategy router exists; no solver competition for packages; liquidity fragments across thousands of empty strike × expiry books.',
    severity: 'high',
  },
  {
    title: 'Automation without guardrails',
    detail: '“AI trading agents” with wallet keys are the wrong architecture. The safe pattern — AI proposes, deterministic policy engine approves, smart account enforces — is unbuilt.',
    severity: 'medium',
  },
];

const FEATURES = [
  { name: 'Intent-based strategy compiler', who: 'nobody', desc: 'Economic goal → deterministic candidate structures with Pareto comparison. LLM only parses language; math is deterministic.' },
  { name: 'Universal options liquidity router', who: 'nobody', desc: 'Jupiter-meets-Paradigm for volatility: normalize instruments across venues, route at the strategy level, never per-leg.' },
  { name: 'Atomic strategy markets', who: 'Paradigm (institutional only)', desc: 'StrategyOrder as the first-class object: 4-leg condors quoted as one package price, fill-or-kill settlement.' },
  { name: 'Carry Budget & Carry-at-Risk', who: 'nobody', desc: 'Turn perpetual funding into a budget users understand — with p90 stress scenarios and hard/soft auto-close limits.' },
  { name: 'Persistent Strategy Intents', who: 'nobody', desc: '“Keep BTC protected 20% below spot, spend ≤$1k/month” as a signed policy; the engine rolls, hedges and rebalances inside guardrails.' },
  { name: 'Max-Carry order type', who: 'nobody', desc: 'Maintain exposure only while 7-day carry stays under budget; auto-convert between perpetual and dated structures.' },
  { name: 'Composite vol indices (BTCVOL30)', who: 'Block Scholes (data only)', desc: 'Settlement-grade, multi-venue SVI surfaces with confidence scores — the canonical onchain volatility reference.' },
  { name: 'Exit-liquidity scoring', who: 'nobody', desc: 'Every instrument and strategy carries an unwind score: maker count, depth, historical RFQ response, post-move liquidity.' },
  { name: 'Market-Maker OS', who: 'partial (per-venue tools)', desc: 'One integration, many venues: mass quoting, inventory, automated hedging, kill switches, flow-toxicity classification.' },
  { name: 'Embedded options APIs', who: 'nobody', desc: 'GET /protect — outcome APIs that let wallets, lending apps and treasuries embed protection, yield and convexity natively.' },
  { name: 'P&L attribution', who: 'nobody (retail-facing)', desc: '“+$14,822 — here’s why”: delta, gamma, vega, theta, funding, fees, slippage, each decomposed deterministically.' },
  { name: 'Strategy Quote Protocol (open standard)', who: 'nobody', desc: 'An ERC-7683-style intent format for volatility: users sign the strategy, not each leg; solvers compete to fill it.' },
];

const PLATFORMS = [
  { name: 'Derive', outcomes: false, strategyRFQ: 'partial', perps: false, carry: false, routing: false, automation: false, chain: 'onchain' },
  { name: 'Paradex', outcomes: false, strategyRFQ: 'yes (25 legs)', perps: 'launched', carry: false, routing: false, automation: false, chain: 'appchain' },
  { name: 'Paradigm', outcomes: false, strategyRFQ: 'yes (institutional)', perps: false, carry: false, routing: 'partial', automation: false, chain: ' venue-level' },
  { name: 'Aevo', outcomes: false, strategyRFQ: 'OTC', perps: false, carry: false, routing: false, automation: false, chain: 'offchain match' },
  { name: 'Panoptic', outcomes: false, strategyRFQ: false, perps: 'AMM-native', carry: 'streaming premia', routing: false, automation: false, chain: 'Uniswap-native' },
  { name: 'Rysk', outcomes: 'partial (2 products)', strategyRFQ: 'RFQ backed', perps: false, carry: false, routing: false, automation: false, chain: 'onchain' },
  { name: 'VolOS (this platform)', outcomes: true, strategyRFQ: 'simulated', perps: 'first-class', carry: true, routing: 'roadmap', automation: 'roadmap', chain: 'engine + venues' },
];

const ROADMAP = [
  { phase: '0', name: 'Volatility data + strategy simulator', status: 'built', note: 'Pricing/risk correctness — this app (Rust engine + interactive builder).' },
  { phase: '1', name: 'Intent UX + 1–2 venue execution', status: 'prototyped', note: 'Wizard validates demand without liquidity cold-start.' },
  { phase: '2', name: 'Strategy RFQ + multi-venue router', status: 'next', note: 'The execution moat: strategy-level quoting across Derive/Paradex/Paradigm.' },
  { phase: '3', name: 'Auto-roll + persistent hedges', status: 'planned', note: 'Recurring behavior: protection subscriptions, convexity subscriptions.' },
  { phase: '4', name: 'Embedded SDK / outcome APIs', status: 'planned', note: 'Distribution: wallets, treasuries, lending apps.' },
  { phase: '5', name: 'MM operating system', status: 'planned', note: 'Supply-side: one integration, many venues.' },
  { phase: '6–10', name: 'Vol indices → long-tail → solvers → own venue → prime', status: 'later', note: 'Build downward into infrastructure only after owning order flow.' },
];

// ----------------------------------------------------------------------

export function ResearchView() {
  return (
    <div className="space-y-3">
      {/* Header */}
      <section className="rounded-xl border border-zinc-800 bg-gradient-to-br from-zinc-950 to-teal-950/10 p-5">
        <div className="flex items-start gap-3">
          <Telescope className="mt-1 h-6 w-6 shrink-0 text-teal-400" />
          <div>
            <h1 className="text-lg font-bold text-zinc-50">The Deepest Market Gap in Onchain Options</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-400">
              Crypto has increasingly good <em>venues</em> for trading options — but it still lacks the layer that converts
              user outcomes into executable, automated, cross-venue volatility positions. Derive solves exchange/risk
              infrastructure. Paradigm solves institutional liquidity discovery. Paradex solves unified derivatives infra.
              Panoptic experiments with AMM-native perpetuals. Rysk turns option-selling into understandable outcomes.
              <span className="text-teal-300"> Nobody combines the layers.</span> That is the white space VolOS targets.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant="outline" className="border-teal-500/30 bg-teal-950/30 text-[10px] text-teal-300">Block Scholes 2026 options research</Badge>
              <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-[10px] text-zinc-400">Paradigm everlasting-options paper</Badge>
              <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-[10px] text-zinc-400">Paradex SCAN margin docs</Badge>
              <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-[10px] text-zinc-400">Derive portfolio-margin design</Badge>
            </div>
          </div>
        </div>
      </section>

      {/* Landscape */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <Database className="h-3.5 w-3.5 text-teal-400" /> Market Landscape — September 2026
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {LANDSCAPE.map((p) => (
            <div key={p.name} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-semibold text-zinc-100">{p.name}</p>
                <span className="text-[8px] uppercase tracking-wide text-zinc-500">{p.tag}</span>
              </div>
              <p className="mt-1 font-mono text-xl font-bold text-teal-300">{p.stat}</p>
              <p className="text-[9px] text-zinc-500">{p.label}</p>
              <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400">{p.note}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Gaps */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> What These Platforms Lack
        </h2>
        <div className="grid gap-2 md:grid-cols-2">
          {GAPS.map((g, i) => (
            <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold text-zinc-100">{i + 1}. {g.title}</p>
                <Badge
                  variant="outline"
                  className={`shrink-0 text-[8px] ${
                    g.severity === 'critical'
                      ? 'border-rose-500/40 bg-rose-950/30 text-rose-300'
                      : g.severity === 'high'
                        ? 'border-amber-500/40 bg-amber-950/30 text-amber-300'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                  }`}
                >
                  {g.severity}
                </Badge>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">{g.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Competitive matrix */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <Layers className="h-3.5 w-3.5 text-teal-400" /> Capability Matrix
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[10px]">
            <thead>
              <tr className="border-b border-zinc-800 text-[8px] uppercase tracking-wider text-zinc-500">
                <th className="py-2 pr-3 text-left">Platform</th>
                <th className="py-2 px-2">Outcome UX</th>
                <th className="py-2 px-2">Strategy RFQ</th>
                <th className="py-2 px-2">Perpetual options</th>
                <th className="py-2 px-2">Carry-at-Risk</th>
                <th className="py-2 px-2">Cross-venue routing</th>
                <th className="py-2 px-2">Automation</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {PLATFORMS.map((p) => (
                <tr key={p.name} className={`border-b border-zinc-800/40 ${p.name.startsWith('VolOS') ? 'bg-teal-950/15' : ''}`}>
                  <td className={`py-2 pr-3 text-left font-sans font-semibold ${p.name.startsWith('VolOS') ? 'text-teal-300' : 'text-zinc-200'}`}>{p.name}</td>
                  <td className="py-2 px-2 text-center"><Bool v={p.outcomes} /></td>
                  <td className="py-2 px-2 text-center"><Cell v={p.strategyRFQ} /></td>
                  <td className="py-2 px-2 text-center"><Cell v={p.perps} /></td>
                  <td className="py-2 px-2 text-center"><Bool v={p.carry} /></td>
                  <td className="py-2 px-2 text-center"><Cell v={p.routing} /></td>
                  <td className="py-2 px-2 text-center"><Bool v={p.automation} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex gap-4 text-[8px] text-zinc-500">
          <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-400" /> shipped</span>
          <span className="flex items-center gap-1"><MinusCircle className="h-3 w-3 text-amber-400" /> partial / roadmap</span>
          <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-zinc-600" /> absent</span>
        </div>
      </section>

      {/* Feature innovations */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <Lightbulb className="h-3.5 w-3.5 text-amber-400" /> Twelve Innovations That Drive Adoption
        </h2>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div key={i} className="group rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 transition hover:border-teal-500/30">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold text-zinc-100">{f.name}</p>
                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[8px] text-zinc-500">{f.who}</span>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Roadmap */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <Route className="h-3.5 w-3.5 text-teal-400" /> Product Sequencing — Demand Before Primitives
        </h2>
        <div className="space-y-1.5">
          {ROADMAP.map((r) => (
            <div key={r.phase} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-800 font-mono text-[10px] font-bold text-zinc-400">
                {r.phase}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-zinc-200">{r.name}</p>
                <p className="truncate text-[9px] text-zinc-500">{r.note}</p>
              </div>
              <Badge
                variant="outline"
                className={`shrink-0 text-[8px] ${
                  r.status === 'built'
                    ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                    : r.status === 'prototyped' || r.status === 'next'
                      ? 'border-teal-500/40 bg-teal-950/30 text-teal-300'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-500'
                }`}
              >
                {r.status}
              </Badge>
            </div>
          ))}
        </div>
        <p className="mt-3 rounded-md bg-zinc-900/50 px-3 py-2 text-[10px] leading-relaxed text-zinc-500">
          <span className="font-semibold text-zinc-300">Why this order:</span> launching another empty exchange means
          manufacturing users and market makers simultaneously — the hardest problem in derivatives. Owning intent,
          routing and risk first means that when a proprietary primitive (a true perpetual option, a vol index, a
          strategy book) eventually launches, it starts with real order flow instead of a liquidity cold-start.
        </p>
      </section>

      {/* Architecture */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <Layers className="h-3.5 w-3.5 text-teal-400" /> This Platform&apos;s Architecture
        </h2>
        <div className="grid gap-2 md:grid-cols-3">
          <ArchCard
            title="Rust analytics engine"
            points={['Axum + Tokio, zero unsafe code', 'Black-Scholes + Black-76 Greeks in <120µs', 'SVI surface w/ term structure & skew', 'Everlasting options via Paradigm basket (2⁻ⁿ weights)', 'SCAN-style scenario margin (9×6 grid)', 'Rate-limited, strict input validation, security headers']}
          />
          <ArchCard
            title="Interactive frontend"
            points={['Next.js 16.3.4 + TypeScript strict', 'Canvas payoff engine @ 60fps', 'Client mirror of Rust math for drag/slider interaction', 'SSE live market stream with local-sim fallback', 'Drag-to-adjust strikes, time-travel slider', 'Zustand state, shadcn/ui component system']}
          />
          <ArchCard
            title="Domain innovations shipped"
            points={['Carry Budget + Carry-at-Risk panels', 'Strategy-level RFQ simulation (5 makers)', 'Intent compiler: goal → candidate structures', 'Exit-liquidity scoring per leg & strategy', 'Everlasting options as first-class legs', 'Probability cone & POP under lognormal']}
          />
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-md border border-teal-500/20 bg-teal-950/10 px-3 py-2">
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-teal-400" />
          <p className="text-[10px] leading-relaxed text-zinc-400">
            The correct trust boundary per the research: latency-sensitive pricing/risk offchain in Rust; custody,
            permissions and settlement invariants onchain; AI (when added) strictly outside the trusted computing base —
            it proposes, deterministic policy approves, smart accounts enforce.
          </p>
        </div>
      </section>
    </div>
  );
}

function Bool({ v }: { v: boolean | string }) {
  if (v === true) return <CheckCircle2 className="mx-auto h-3.5 w-3.5 text-emerald-400" />;
  if (typeof v === 'string') return <span className="text-[9px] text-amber-400">{v}</span>;
  return <XCircle className="mx-auto h-3.5 w-3.5 text-zinc-600" />;
}

function Cell({ v }: { v: string | boolean }) {
  if (v === true) return <CheckCircle2 className="mx-auto h-3.5 w-3.5 text-emerald-400" />;
  if (v === false) return <XCircle className="mx-auto h-3.5 w-3.5 text-zinc-600" />;
  return <span className="text-[9px] text-amber-400">{v}</span>;
}

function ArchCard({ title, points }: { title: string; points: string[] }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
      <p className="text-xs font-semibold text-zinc-100">{title}</p>
      <ul className="mt-2 space-y-1">
        {points.map((p, i) => (
          <li key={i} className="flex items-start gap-1.5 text-[10px] leading-relaxed text-zinc-400">
            <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-teal-400" />
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

export { Progress };

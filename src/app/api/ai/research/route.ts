// POST /api/ai/research — the Deep Research pipeline.
//
// Runs the full agentic research desk over one asset, grounded in LIVE
// exchange data (Deribit / Bybit / OKX / Aevo / Paradex):
//   Stage 1: Trend Scout (technical) + Pattern Hawk (chart) +
//            Macro Owl (fundamental) + Vol Oracle (volatility)
//   Stage 2: Risk Quant (likelihood, given stage-1 context)
//   Stage 2x (extended desks, on by default):
//            Ledger Hound (backtest on real exchange history) +
//            Gamma Ray (0DTE) + Legs Weaver (multileg/multihop)
//   Stage 3: Strategy Smith (architect, given all reports)
//   Stage 4: Streaming final dossier synthesis
//
// Resilience contract (the pipeline can never look dead):
//   • heartbeat events every 4s with elapsed time + current stage
//   • every stage hard-capped by a wall-clock budget (runSpecialistAgent)
//   • failed stages are reported and SKIPPED — the pipeline continues
//   • the dossier falls back to the architect/quant reports on synthesis errors
//
// Progress is streamed to the browser as NDJSON events:
//   {type:'start'|'stage'|'agent-report'|'heartbeat'|'strategies'|
//    'dossier-delta'|'done'|'error', ...}

import { streamText, convertToCoreMessages } from 'ai';
import {
  zaiModel,
  runSpecialistAgent,
  AGENTS,
  type AgentId,
  type SpecialistRun,
} from '@/lib/ai/agents';
import {
  ASSET_IDS,
  type AssetId,
  liveMarketState,
  primeLiveMarket,
  primeLiveCandles,
} from '@/lib/ai/market-intel';
import { resolveStrategyLegs } from '@/lib/strategies';
import { STRATEGIES } from '@/lib/strategies';

export const runtime = 'nodejs';
export const maxDuration = 600;

interface ResearchRequest {
  asset?: string;
  focus?: string;
  horizonDays?: number;
  riskAppetite?: string;
  /** 'core' = 6 classic agents, 'full' = + backtest/0DTE/multileg desks */
  desks?: 'core' | 'full';
}

const STAGE1: AgentId[] = ['technical', 'chart', 'fundamental', 'volatility'];
const EXTENDED: AgentId[] = ['backtest', 'zerodte', 'tactician'];

/** Wall-clock budget per specialist stage. */
const STAGE_BUDGET_MS = 115_000;
/** One retry for a failed stage before it is skipped. */
const STAGE_RETRIES = 1;

function withBudget<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s budget`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function POST(req: Request) {
  let request: ResearchRequest = {};
  try {
    request = (await req.json()) as ResearchRequest;
  } catch {
    request = {};
  }

  const assetRaw = String(request.asset ?? 'BTC').toUpperCase();
  const asset: AssetId = (ASSET_IDS as readonly string[]).includes(assetRaw) ? (assetRaw as AssetId) : 'BTC';
  const focus = String(request.focus ?? '').slice(0, 400);
  const horizon = Math.min(Math.max(Number(request.horizonDays) || 30, 1), 180);
  const risk = ['conservative', 'balanced', 'aggressive'].includes(String(request.riskAppetite))
    ? String(request.riskAppetite)
    : 'balanced';
  const desks = request.desks === 'core' ? 'core' : 'full';

  // anchor the whole pipeline to REAL live exchange data (best-effort, cached)
  const liveSource = await Promise.all([primeLiveMarket(), primeLiveCandles(asset)]).then(
    ([m]) => (m ? 'live' : 'simulated'),
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          closed = true;
        }
      };

      // --- heartbeat: the pipeline is never silent for more than 4s ----------
      const heartbeat = setInterval(() => {
        send({ type: 'heartbeat', elapsedS: Math.round((Date.now() - startedAt) / 1000) });
      }, 4000);

      const finish = () => {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        send({
          type: 'start',
          asset,
          spot: liveMarketState()[asset].spot,
          focus,
          horizonDays: horizon,
          riskAppetite: risk,
          desks,
          dataSource: liveSource,
        });

        const spot = liveMarketState()[asset].spot;

        const constraints = `Asset: ${asset} (spot ~${spot.toFixed(0)} USD, ${liveSource} exchange data). Horizon: ${horizon} days. User risk appetite: ${risk}.${
          focus ? ` User focus/question: ${focus}` : ''
        }`;

        const tasks: Record<AgentId, string> = {
          technical: `${constraints}\n\nFull technical read: trend structure, momentum, volume and the levels that matter. Use the 4h and 1d timeframes.`,
          chart: `${constraints}\n\nFull chart read: candlesticks, support/resistance map, trendlines, any classical pattern, fib confluence. Timeframe 4h with 1d structure.`,
          fundamental: `${constraints}\n\nFull environment read: regime classification, positioning/funding/OI, cross-asset correlation and the probability-weighted scenario map.`,
          volatility: `${constraints}\n\nFull volatility read: IV term structure, realized vs implied, skew, percentile, and what it means for premium buyers vs sellers.`,
          profitability: '',
          architect: '',
          backtest: `${constraints}\n\nBacktest the leading expressions for this asset on real exchange history: run backtest_strategy on 2-3 candidates that fit the desk's research consensus below (e.g. an iron condor for range, a credit spread for direction, a calendar for vol). Report the numbers honestly — including when history does NOT support the trade.\n\nDesk research so far:\n{STAGE1_DIGEST}`,
          zerodte: `${constraints}\n\nFull 0DTE read: scan_0dte for the same-day/near-dated expiry, the expected move, the gamma map and pin risk. Then judge whether TODAY is a 0DTE day at all (state it plainly if the setup is poor). If it is, give the one best structure with strikes and size guidance.`,
          tactician: `${constraints}\n\nMultileg & multihop desk: given the desk's research consensus below, build_multileg for the desk's view, then plan_multihop on the best candidate (3 hops) and compare_venues for cross-venue routing of its legs. Deliver the structure, the hop schedule and the routing table.\n\nDesk research so far:\n{STAGE1_DIGEST}`,
        };

        /** Run one specialist with budget + retry; never throws. */
        const runStage = async (id: AgentId, task: string): Promise<SpecialistRun> => {
          send({ type: 'stage', stage: 0, agent: id, name: AGENTS[id].name, title: AGENTS[id].title, status: 'running' });
          for (let attempt = 0; attempt <= STAGE_RETRIES; attempt++) {
            try {
              const run = await withBudget(runSpecialistAgent(id, task), STAGE_BUDGET_MS, `${AGENTS[id].name} stage`);
              if (run.ok || attempt === STAGE_RETRIES) return run;
              // one soft retry for transient model errors
            } catch (err) {
              if (attempt === STAGE_RETRIES) {
                return {
                  agent: id,
                  name: AGENTS[id].name,
                  title: AGENTS[id].title,
                  task,
                  report: '',
                  toolTrace: [],
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            }
          }
          return {
            agent: id,
            name: AGENTS[id].name,
            title: AGENTS[id].title,
            task,
            report: '',
            toolTrace: [],
            ok: false,
            error: 'unreachable',
          };
        };

        const emitReport = (run: SpecialistRun, stage: number) => {
          send({
            type: 'stage',
            stage,
            agent: run.agent,
            name: run.name,
            title: run.title,
            status: run.ok ? 'done' : 'error',
            error: run.error,
          });
          send({
            type: 'agent-report',
            agent: run.agent,
            name: run.name,
            title: run.title,
            report: run.report,
            toolTrace: run.toolTrace.map((t) => ({ toolName: t.toolName, args: t.args })),
          });
        };

        // --- Stage 1: four specialists, sequential to respect rate limits ---
        const stage1: SpecialistRun[] = [];
        for (const a of STAGE1) {
          const run = await runStage(a, tasks[a]);
          stage1.push(run);
          emitReport(run, 1);
          if (run !== stage1[stage1.length - 1]) continue;
          await new Promise((r) => setTimeout(r, 1200));
        }

        const reports: Partial<Record<AgentId, SpecialistRun>> = {};
        for (const run of stage1) reports[run.agent] = run;

        const stage1Digest = STAGE1.map((a) => {
          const r = reports[a];
          return r?.ok ? `### ${r.name} (${r.title})\n${r.report}` : `### ${AGENTS[a].name}\n(unavailable)`;
        }).join('\n\n');

        // --- Stage 2: Risk Quant with stage-1 context ---------------------------
        send({ type: 'stage', stage: 2, agent: 'profitability', name: AGENTS.profitability.name, title: AGENTS.profitability.title, status: 'running' });
        const quant = await runStage(
          'profitability',
          `${constraints}\n\nQuantify likelihood and profitability: run a ${horizon}-day Monte Carlo, then evaluate 2-4 candidate strategies that fit the desk's research consensus below (search the catalog, analyze, compare). Report POP, EV, breakevens, scenario stress and a ranking with confidence.\n\nDesk research so far:\n${stage1Digest.slice(0, 6000)}`,
        );
        reports.profitability = quant;
        emitReport(quant, 2);
        await new Promise((r) => setTimeout(r, 1200));

        // --- Stage 2x: extended desks (backtest · 0DTE · multileg/multihop) -----
        if (desks === 'full') {
          for (const a of EXTENDED) {
            const task = tasks[a].replace('{STAGE1_DIGEST}', stage1Digest.slice(0, 3500));
            const run = await runStage(a, task);
            reports[a] = run;
            emitReport(run, 2);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }

        const extendedDigest = desks === 'full'
          ? EXTENDED.filter((a) => reports[a]?.ok)
              .map((a) => `### ${reports[a]!.name} (${reports[a]!.title})\n${reports[a]!.report.slice(0, 2600)}`)
              .join('\n\n')
          : '';

        // --- Stage 3: Strategy Architect with everything ------------------------
        send({ type: 'stage', stage: 3, agent: 'architect', name: AGENTS.architect.name, title: AGENTS.architect.title, status: 'running' });
        const architect = await runStage(
          'architect',
          `${constraints}\n\nDesign the final strategy recommendation. Synthesize the desk research below into a tradable thesis, shortlist 2-4 catalog strategies (the 131-strategy catalog includes 0DTE and multihop roll-ladder structures — consider them when the extended desks favor them), verify economics at live market, and deliver the final ranking with a primary recommendation (id + legs + management plan) and an alternative.\n\nDesk research:\n${stage1Digest.slice(0, 4500)}\n\n### ${quant.name} (Risk Quant)\n${quant.report.slice(0, 3000)}${extendedDigest ? `\n\n${extendedDigest.slice(0, 4500)}` : ''}`,
        );
        reports.architect = architect;
        emitReport(architect, 3);

        // Extract any catalog strategy ids mentioned by the architect for the
        // frontend's "load to builder" affordances.
        const mentionedIds = new Set<string>();
        const architectText = `${architect.report} ${quant.report} ${extendedDigest}`;
        for (const s of STRATEGIES) {
          if (architectText.includes(s.id) || architectText.toLowerCase().includes(s.name.toLowerCase())) {
            mentionedIds.add(s.id);
          }
        }
        const strategyPayloads = [...mentionedIds].slice(0, 4).map((id) => {
          const spec = STRATEGIES.find((s) => s.id === id)!;
          return {
            strategyId: spec.id,
            name: spec.name,
            category: spec.category,
            view: spec.view,
            complexity: spec.complexity,
            description: spec.description,
            legCount: spec.legs.length,
            resolvedLegs: resolveStrategyLegs(spec, spot).map((l) => ({
              kind: l.kind,
              side: l.side,
              qty: l.qty,
              strike: l.strike != null ? +l.strike.toFixed(2) : undefined,
              expiryDays: l.expiryDays,
              fundingPeriodDays: l.fundingPeriodDays,
            })),
          };
        });
        if (strategyPayloads.length > 0) {
          send({ type: 'strategies', strategies: strategyPayloads, underlying: asset, spot });
        }

        // --- Stage 4: streaming final dossier ------------------------------------
        send({ type: 'stage', stage: 4, agent: 'director', name: 'Research Director', title: 'Synthesis', status: 'running' });

        const dossierPrompt = `Write the final VolOS Deep Research dossier for ${asset} at spot $${spot.toFixed(0)} (${liveSource} exchange data).

User parameters: horizon ${horizon} days, risk appetite ${risk}${focus ? `, focus: ${focus}` : ''}.

You have the full desk research below. Structure the dossier EXACTLY as:

# ${asset} Deep Research Dossier
## Executive Summary
3-5 bullets: regime, bias, vol environment, the trade.
## Technical & Chart Picture
Merge Trend Scout + Pattern Hawk: trend, momentum, the decision levels.
## Macro & Volatility Environment
Merge Macro Owl + Vol Oracle: regime, positioning, IV read.
## Likelihood & Profitability
Risk Quant's numbers: MC percentiles, POP/EV of the finalists, environment stress.
${desks === 'full' ? `## Backtest Evidence
Ledger Hound's verdict: win rates, profit factors, drawdowns on real exchange history — and the honest read when history disagrees.
## 0DTE & Structure Desk
Gamma Ray's same-day read (if relevant today) + Legs Weaver's multileg/multihop construction and cross-venue routing.
` : ''}## Desk Recommendation
The primary strategy (id, legs, POP, EV, R:R, margin, management triggers, invalidation) + one alternative. Be concrete.
## Risk Notes
What breaks the thesis; tail scenarios; sizing guidance for a ${risk} book.

Keep it under 800 words. Numbers everywhere. No disclaimers.

DESK RESEARCH:
${stage1Digest.slice(0, 6500)}

### Risk Quant
${quant.report.slice(0, 3000)}${extendedDigest ? `\n\n${extendedDigest.slice(0, 4500)}` : ''}

### Strategy Architect
${architect.report.slice(0, 3000)}`;

        try {
          const result = streamText({
            model: zaiModel,
            messages: convertToCoreMessages([{ role: 'user', content: dossierPrompt }]),
            temperature: 0.35,
          });
          for await (const delta of result.textStream) {
            send({ type: 'dossier-delta', text: delta });
          }
          send({ type: 'stage', stage: 4, agent: 'director', name: 'Research Director', title: 'Synthesis', status: 'done' });
        } catch (err) {
          send({
            type: 'stage',
            stage: 4,
            agent: 'director',
            name: 'Research Director',
            title: 'Synthesis',
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
          // fall back to architect report as the dossier body
          send({ type: 'dossier-delta', text: architect.report });
        }

        send({ type: 'done', asset, spot, elapsedS: Math.round((Date.now() - startedAt) / 1000) });
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          elapsedS: Math.round((Date.now() - startedAt) / 1000),
        });
      } finally {
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Volos-Pipeline': 'deep-research',
    },
  });
}

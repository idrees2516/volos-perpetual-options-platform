// POST /api/ai/research — the Deep Research pipeline.
//
// Runs the full agentic research desk over one asset:
//   Stage 1 (parallel): Trend Scout (technical) + Pattern Hawk (chart) +
//                       Macro Owl (fundamental) + Vol Oracle (volatility)
//   Stage 2:           Risk Quant (likelihood, given stage-1 context)
//   Stage 3:           Strategy Smith (architect, given all reports)
//   Stage 4:           Streaming final dossier synthesis
//
// Progress is streamed to the browser as NDJSON events:
//   {type:'stage', stage, agent, status:'running'|'done'|'error', ...}
//   {type:'agent-report', agent, name, title, report, toolTrace}
//   {type:'dossier-delta', text}
//   {type:'done'} | {type:'error', message}

import { streamText, convertToCoreMessages } from 'ai';
import {
  zaiModel,
  runSpecialistAgent,
  AGENTS,
  type AgentId,
  type SpecialistRun,
} from '@/lib/ai/agents';
import { ASSET_IDS, type AssetId, liveMarketState } from '@/lib/ai/market-intel';
import { resolveStrategyLegs } from '@/lib/strategies';
import { STRATEGIES } from '@/lib/strategies';

export const runtime = 'nodejs';
export const maxDuration = 600;

interface ResearchRequest {
  asset?: string;
  focus?: string;
  horizonDays?: number;
  riskAppetite?: string;
}

const STAGE1: AgentId[] = ['technical', 'chart', 'fundamental', 'volatility'];

export async function POST(req: Request) {
  let request: ResearchRequest = {};
  try {
    request = (await req.json()) as ResearchRequest;
  } catch {
    request = {};
  }

  const assetRaw = String(request.asset ?? 'BTC').toUpperCase();
  const asset: AssetId = (ASSET_IDS as string[]).includes(assetRaw) ? (assetRaw as AssetId) : 'BTC';
  const focus = String(request.focus ?? '').slice(0, 400);
  const horizon = Math.min(Math.max(Number(request.horizonDays) || 30, 1), 180);
  const risk = ['conservative', 'balanced', 'aggressive'].includes(String(request.riskAppetite))
    ? String(request.riskAppetite)
    : 'balanced';

  const live = liveMarketState()[asset];
  const spot = live.spot;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          /* client gone */
        }
      };

      send({ type: 'start', asset, spot, focus, horizonDays: horizon, riskAppetite: risk });

      const constraints = `Asset: ${asset} (spot ~${spot.toFixed(0)} USD). Horizon: ${horizon} days. User risk appetite: ${risk}.${
        focus ? ` User focus/question: ${focus}` : ''
      }`;

      const tasks: Record<AgentId, string> = {
        technical: `${constraints}\n\nFull technical read: trend structure, momentum, volume and the levels that matter. Use the 4h and 1d timeframes.`,
        chart: `${constraints}\n\nFull chart read: candlesticks, support/resistance map, trendlines, any classical pattern, fib confluence. Timeframe 4h with 1d structure.`,
        fundamental: `${constraints}\n\nFull environment read: regime classification, positioning/funding/OI, cross-asset correlation and the probability-weighted scenario map.`,
        volatility: `${constraints}\n\nFull volatility read: IV term structure, realized vs implied, skew, percentile, and what it means for premium buyers vs sellers.`,
        profitability: '',
        architect: '',
      };

      // --- Stage 1: four specialists, sequential to respect backend rate limits
      const stage1: SpecialistRun[] = [];
      for (const a of STAGE1) {
        send({ type: 'stage', stage: 1, agent: a, name: AGENTS[a].name, title: AGENTS[a].title, status: 'running' });
        const run = await runSpecialistAgent(a, tasks[a]);
        stage1.push(run);
        send({
          type: 'stage',
          stage: 1,
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
        // small breather between agents to stay under the rate limit
        await new Promise((r) => setTimeout(r, 2500));
      }

      const reports: Partial<Record<AgentId, SpecialistRun>> = {};
      for (const run of stage1) reports[run.agent] = run;

      const stage1Digest = STAGE1.map((a) => {
        const r = reports[a];
        return r?.ok ? `### ${r.name} (${r.title})\n${r.report}` : `### ${AGENTS[a].name}\n(unavailable)`;
      }).join('\n\n');

      // --- Stage 2: Risk Quant with stage-1 context ---------------------------
      send({ type: 'stage', stage: 2, agent: 'profitability', name: AGENTS.profitability.name, title: AGENTS.profitability.title, status: 'running' });
      const quant = await runSpecialistAgent(
        'profitability',
        `${constraints}\n\nQuantify likelihood and profitability: run a ${horizon}-day Monte Carlo, then evaluate 2-4 candidate strategies that fit the desk's research consensus below (search the catalog, analyze, compare). Report POP, EV, breakevens, scenario stress and a ranking with confidence.\n\nDesk research so far:\n${stage1Digest.slice(0, 6000)}`,
      );
      reports.profitability = quant;
      send({
        type: 'stage',
        stage: 2,
        agent: 'profitability',
        name: quant.name,
        title: quant.title,
        status: quant.ok ? 'done' : 'error',
        error: quant.error,
      });
      send({
        type: 'agent-report',
        agent: 'profitability',
        name: quant.name,
        title: quant.title,
        report: quant.report,
        toolTrace: quant.toolTrace.map((t) => ({ toolName: t.toolName, args: t.args })),
      });

      // --- Stage 3: Strategy Architect with everything ------------------------
      send({ type: 'stage', stage: 3, agent: 'architect', name: AGENTS.architect.name, title: AGENTS.architect.title, status: 'running' });
      const architect = await runSpecialistAgent(
        'architect',
        `${constraints}\n\nDesign the final strategy recommendation. Synthesize the desk research below into a tradable thesis, shortlist 2-4 catalog strategies, verify economics at live market, and deliver the final ranking with a primary recommendation (id + legs + management plan) and an alternative.\n\nDesk research:\n${stage1Digest.slice(0, 5000)}\n\n### ${quant.name} (Risk Quant)\n${quant.report.slice(0, 3500)}`,
      );
      reports.architect = architect;
      send({
        type: 'stage',
        stage: 3,
        agent: 'architect',
        name: architect.name,
        title: architect.title,
        status: architect.ok ? 'done' : 'error',
        error: architect.error,
      });
      send({
        type: 'agent-report',
        agent: 'architect',
        name: architect.name,
        title: architect.title,
        report: architect.report,
        toolTrace: architect.toolTrace.map((t) => ({ toolName: t.toolName, args: t.args })),
      });

      // Extract any catalog strategy ids mentioned by the architect for the
      // frontend's "load to builder" affordances.
      const mentionedIds = new Set<string>();
      const architectText = `${architect.report} ${quant.report}`;
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

      const dossierPrompt = `Write the final VolOS Deep Research dossier for ${asset} at spot $${spot.toFixed(0)}.

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
## Desk Recommendation
The primary strategy (id, legs, POP, EV, R:R, margin, management triggers, invalidation) + one alternative. Be concrete.
## Risk Notes
What breaks the thesis; tail scenarios; sizing guidance for a ${risk} book.

Keep it under 700 words. Numbers everywhere. No disclaimers.

DESK RESEARCH:
${stage1Digest.slice(0, 7000)}

### Risk Quant
${quant.report.slice(0, 3500)}

### Strategy Architect
${architect.report.slice(0, 3500)}`;

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

      send({ type: 'done', asset, spot });
      controller.close();
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

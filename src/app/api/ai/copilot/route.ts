// POST /api/ai/copilot — the interactive Research Director chat endpoint.
// Vercel AI SDK streamText with the full desk toolbelt (market tools +
// agent dispatch + strategy loading), multi-step agentic loop, streamed to
// the frontend as an AI SDK data stream consumed by useChat().
//
// CONTEXT-GROUNDED: the frontend ships a live terminal context snapshot
// (active workspace, selected strategy + legs, live exchange prices) with
// every request; it is injected into the system prompt so every copilot
// answer is based on the data the platform is actually pulling.

import { streamText, convertToCoreMessages } from 'ai';
import { zaiModel, ORCHESTRATOR_SYSTEM, dispatchAgentTool, loadStrategyTool } from '@/lib/ai/agents';
import { marketTools } from '@/lib/ai/agent-tools';
import { formatCopilotContext, type CopilotContextSnapshot } from '@/lib/copilot-context';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      messages?: Array<{ role: string; content: string; parts?: unknown[] }>;
      context?: CopilotContextSnapshot | null;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // Ground the orchestrator in the user's live terminal context.
    const contextBlock = body.context ? formatCopilotContext(body.context) : '';
    const system = contextBlock
      ? `${ORCHESTRATOR_SYSTEM}\n\n${contextBlock}`
      : ORCHESTRATOR_SYSTEM;

    const result = streamText({
      model: zaiModel,
      system,
      messages: convertToCoreMessages(messages as never),
      tools: {
        ...marketTools,
        dispatch_agent: dispatchAgentTool,
        load_strategy: loadStrategyTool,
      },
      maxSteps: 10,
      temperature: 0.4,
      onFinish: ({ usage }) => {
        console.log(
          `[copilot] finished · promptTokens=${usage.promptTokens} completionTokens=${usage.completionTokens}${
            body.context ? ` · ctx=${body.context.viewLabel}/${body.context.strategy.name}` : ''
          }`,
        );
      },
    });

    return result.toDataStreamResponse({
      headers: {
        'X-Agentic-Desk': 'volos-research',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    console.error('[copilot] error:', err);
    return new Response(JSON.stringify({ error: 'copilot unavailable' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

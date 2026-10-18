// POST /api/ai/copilot — the interactive Research Director chat endpoint.
// Vercel AI SDK streamText with the full desk toolbelt (market tools +
// agent dispatch + strategy loading), multi-step agentic loop, streamed to
// the frontend as an AI SDK data stream consumed by useChat().

import { streamText, convertToCoreMessages } from 'ai';
import { zaiModel, ORCHESTRATOR_SYSTEM, dispatchAgentTool, loadStrategyTool } from '@/lib/ai/agents';
import { marketTools } from '@/lib/ai/agent-tools';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      messages?: Array<{ role: string; content: string; parts?: unknown[] }>;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const result = streamText({
      model: zaiModel,
      system: ORCHESTRATOR_SYSTEM,
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
          `[copilot] finished · promptTokens=${usage.promptTokens} completionTokens=${usage.completionTokens}`,
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

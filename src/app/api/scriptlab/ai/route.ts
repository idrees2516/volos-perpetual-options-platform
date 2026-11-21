// POST /api/scriptlab/ai — the Script Lab AI desk. Modes:
//   generate  — write a new VolScript from a natural-language description
//   explain   — explain the current script
//   improve   — improve/robustify the current script
//   translate — translate pasted Pine Script to VolScript
//   fix       — repair the compile/runtime error in the current script
// Grounded with the live dataset (symbol, timeframe, bars, orderflow natives).
import { generateText } from 'ai';
import { createZaiModel } from '@/lib/ai/zai-provider';
import { VOLSCRIPT_REFERENCE } from '@/lib/scriptlang/ai-reference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PROMPT_CHARS = 6000;

function extractCode(reply: string): string | undefined {
  const fence = reply.match(/```(?:volscript|pine|v5|javascript)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  // degenerate: whole reply looks like a script (no fences)
  if (/^\/\/@version|^(indicator|strategy)\(/m.test(reply.trim()) && reply.includes('plot(')) {
    return reply.trim();
  }
  return undefined;
}

function stripCode(reply: string): string {
  return reply
    .replace(/```(?:volscript|pine|v5|javascript)?\s*\n[\s\S]*?```/gi, '')
    .replace(/```/g, '')
    .trim();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      mode?: 'generate' | 'explain' | 'improve' | 'translate' | 'fix';
      prompt?: string;
      code?: string;
      symbol?: string;
      tf?: string;
      bars?: number;
      error?: { line?: number; message?: string };
    };
    const mode = body.mode ?? 'generate';
    const prompt = (body.prompt ?? '').slice(0, MAX_PROMPT_CHARS);
    const currentCode = (body.code ?? '').slice(0, MAX_PROMPT_CHARS);
    if (!prompt && mode !== 'explain' && mode !== 'improve' && mode !== 'fix') {
      return Response.json({ ok: false, error: { message: 'empty prompt' } }, { status: 400 });
    }
    if (['explain', 'improve', 'fix'].includes(mode) && !currentCode) {
      return Response.json({ ok: false, error: { message: 'no current script to work on' } }, { status: 400 });
    }

    const grounding = `Live dataset: ${body.symbol ?? 'BTC'} perp on the ${body.tf ?? '1h'} timeframe, ${body.bars ?? 0} OHLCV bars with taker-flow (buyvol/sellvol/delta/cvd) available.`;

    const compileErr =
      mode === 'fix' && body.error
        ? `\nThe script FAILED to compile — error at line ${body.error.line ?? '?'}: "${body.error.message ?? 'unknown error'}". Repair that line (and any related lines), keep everything else intact, and output the FULL corrected script.`
        : '';

    const modeBrief: Record<string, string> = {
      generate: 'Write a NEW VolScript for the trader. Prefer strategies that include protective stops via strategy.exit. Use inputs for tunable parameters.',
      explain: 'Explain the CURRENT script below concisely: what it plots/signals, its parameters, and any pitfalls. Output the FULL script back unchanged in the code block plus your explanation before it.',
      improve: 'Improve the CURRENT script below: robustness (nz guards, warmup awareness), clearer comments, better defaults, and if it is a strategy ensure a protective stop. Output the FULL improved script.',
      translate: 'The prompt contains Pine Script code (possibly v4/v5). Translate it to VolScript: keep the same intent; replace unsupported features with the nearest supported equivalent (no loops → ta.cum, no request.security → single timeframe, no drawings → plot/plotshape/hline). Note every substitution briefly.',
      fix: 'Fix the CURRENT script below so it compiles and runs. Output the FULL corrected script with a one-line note of what was wrong.',
    };

    const userMsg = [
      grounding,
      modeBrief[mode],
      compileErr,
      prompt ? `REQUEST: ${prompt}` : '',
      currentCode ? `CURRENT SCRIPT:\n${currentCode}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const { text } = await generateText({
      model: createZaiModel('glm-4-plus'),
      system: VOLSCRIPT_REFERENCE,
      prompt: userMsg,
      temperature: 0.3,
      maxTokens: 4096,
    });

    const code = extractCode(text);
    const reply = stripCode(text) || (code ? 'script ready — open it in the editor and run.' : text);

    return Response.json({ ok: true, reply, code });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'AI request failed';
    const friendly = /429|too many requests/i.test(msg)
      ? 'The AI desk is rate-limited right now — try again in a few seconds.'
      : msg.slice(0, 300);
    return Response.json({ ok: false, error: { message: friendly } }, { status: 502 });
  }
}

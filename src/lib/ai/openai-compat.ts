// ---------------------------------------------------------------------------
// openai-compat — a Vercel AI SDK (ai v4) LanguageModelV1 provider for ANY
// OpenAI-compatible HTTP endpoint. Built for OmniRoute (the free AI gateway
// that aggregates 375+ providers behind one /v1 endpoint with quota-aware
// auto-fallback), but works unchanged against OpenRouter / LiteLLM / vLLM /
// Ollama / a raw OpenAI key — anything speaking POST {base}/chat/completions.
//
// Differences from the in-sandbox zai provider (zai-provider.ts):
//   • transport is plain fetch with `Authorization: Bearer <key>`
//   • the HTTP call happens BEFORE the ReadableStream is returned, so a
//     dead/misconfigured gateway REJECTS from doGenerate/doStream itself —
//     which is what lets the model-router fail over to the GLM backend
//     cleanly, before a single token has been streamed to the browser.
//   • no `thinking` flag (OmniRoute routes to many backends; some reject
//     unknown params — unknown fields would also be forwarded verbatim).
//
// Shared prompt conversion / SSE parsing / tool-arg repair live in
// zai-provider.ts (exported there) and are reused verbatim.
// ---------------------------------------------------------------------------

import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1FinishReason,
  LanguageModelV1Prompt,
  LanguageModelV1StreamPart,
} from '@ai-sdk/provider';
import {
  estimateTokens,
  mapFinishReason,
  mapToolChoice,
  sanitizeToolArgs,
  sseEvents,
  toOpenAIMessages,
  type OpenAIChatResponse,
} from './zai-provider';

export interface OpenAICompatConfig {
  /** Provider id used in AI SDK metadata + logs (e.g. 'omniroute'). */
  id: string;
  /** Base URL WITHOUT trailing slash, e.g. `https://omniroute.online/v1`. */
  baseUrl: string;
  apiKey: string;
  /** OmniRoute model id — `auto`, `auto/cheap`, `openai/gpt-5.4`, `glm/glm-5.2`… */
  model: string;
  /** Extra headers (rare). */
  headers?: Record<string, string>;
  /** Per-attempt timeout (default 75 s, matching the zai provider). */
  timeoutMs?: number;
  /** Max attempts on 429/5xx/network (default 3). */
  maxAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 75_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
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

/** POST the chat completions endpoint with 429/5xx retry + capped backoff. */
async function callChat(
  cfg: OpenAICompatConfig,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const maxAttempts = cfg.maxAttempts ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
            ...(cfg.headers ?? {}),
          },
          body: JSON.stringify(body),
        }),
        cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        `${cfg.id} request`,
      );
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      const err = new Error(`${cfg.id} HTTP ${res.status}: ${text.slice(0, 300)}`);
      if (!retryable || attempt === maxAttempts) throw err;
      lastErr = err;
    } catch (err) {
      const retryableNetwork = err instanceof TypeError; // fetch network failure
      if (!retryableNetwork || attempt === maxAttempts) throw err;
      lastErr = err;
    }
    const waitMs = Math.min(Math.round(1200 * Math.pow(2.2, attempt - 1)) + Math.random() * 600, 12_000);
    console.warn(`[openai-compat:${cfg.id}] retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw lastErr;
}

/** Build the OpenAI-format request body shared by doGenerate/doStream. */
function buildBody(
  cfg: OpenAICompatConfig,
  options: LanguageModelV1CallOptions,
  stream: boolean,
): Record<string, unknown> {
  const tools = options.mode?.type === 'regular' ? options.mode.tools : undefined;
  const toolChoice = options.mode?.type === 'regular' ? options.mode.toolChoice : undefined;
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: toOpenAIMessages(options.prompt as LanguageModelV1Prompt),
  };
  if (stream) body.stream = true;
  if (options.maxTokens != null) body.max_tokens = options.maxTokens;
  if (options.temperature != null && options.temperature > 0) body.temperature = options.temperature;
  if (options.topP != null) body.top_p = options.topP;
  if (tools && tools.length > 0) {
    body.tools = tools
      .filter((t) => t.type === 'function')
      .map((t) => {
        const ft = t as unknown as { name: string; description?: string; parameters: Record<string, unknown> };
        return {
          type: 'function',
          function: { name: ft.name, description: ft.description ?? '', parameters: ft.parameters },
        };
      });
    const tc = mapToolChoice(toolChoice);
    if (tc != null) body.tool_choice = tc;
  }
  return body;
}

export function createOpenAICompatModel(cfg: OpenAICompatConfig): LanguageModelV1 {
  const provider: LanguageModelV1 = {
    specificationVersion: 'v1',
    provider: cfg.id,
    modelId: cfg.model,
    defaultObjectGenerationMode: 'tool',
    supportsImageUrls: false,

    async doGenerate(options: LanguageModelV1CallOptions) {
      const body = buildBody(cfg, options, false);
      const res = await callChat(cfg, body);
      const json = (await res.json()) as OpenAIChatResponse;
      const choice = json.choices?.[0];
      const msg = choice?.message;
      const toolCalls = (msg?.tool_calls ?? []).map((tc, i) => ({
        toolCallType: 'function' as const,
        toolCallId: tc.id ?? `${cfg.id}-${Date.now()}-${i}`,
        toolName: tc.function.name,
        args: sanitizeToolArgs(tc.function.arguments ?? '{}'),
      }));
      return {
        text: msg?.content ?? undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: mapFinishReason(choice?.finish_reason),
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? estimateTokens(body.messages as never),
          completionTokens: json.usage?.completion_tokens ?? 0,
        },
        rawCall: { rawPrompt: body, rawSettings: {} },
      };
    },

    async doStream(options: LanguageModelV1CallOptions) {
      const body = buildBody(cfg, options, true);
      // Fetch FIRST: a dead gateway or bad key rejects here (before any token
      // reaches the browser) so the router can fail over transparently.
      const res = await callChat(cfg, body);

      // Non-SSE reply (some gateways ignore `stream`) → emit as one delta.
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.body || !contentType.includes('event-stream')) {
        const json = (await res.json()) as OpenAIChatResponse;
        const choice = json.choices?.[0];
        const msg = choice?.message;
        const parts: LanguageModelV1StreamPart[] = [];
        if (msg?.content) parts.push({ type: 'text-delta', textDelta: msg.content });
        for (const [i, tc] of (msg?.tool_calls ?? []).entries()) {
          parts.push({
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: tc.id ?? `${cfg.id}-${Date.now()}-${i}`,
            toolName: tc.function.name,
            args: sanitizeToolArgs(tc.function.arguments ?? '{}'),
          });
        }
        parts.push({
          type: 'finish',
          finishReason: mapFinishReason(choice?.finish_reason),
          usage: {
            promptTokens: json.usage?.prompt_tokens ?? estimateTokens(body.messages as never),
            completionTokens: json.usage?.completion_tokens ?? 0,
          },
        });
        const oneShot = new ReadableStream<LanguageModelV1StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        });
        return { stream: oneShot, rawCall: { rawPrompt: body, rawSettings: {} } };
      }

      // Real SSE streaming — same accumulation semantics as the zai provider.
      const stream = new ReadableStream<LanguageModelV1StreamPart>({
        async start(controller) {
          const accToolCalls = new Map<number, { id?: string; name: string; args: string }>();
          let finishReason: LanguageModelV1FinishReason = 'stop';
          let completionTokens = 0;
          let promptTokens = 0;
          try {
            for await (const chunk of sseEvents(res.body!.getReader())) {
              const choice = chunk.choices?.[0];
              if (choice?.delta?.content) {
                controller.enqueue({ type: 'text-delta', textDelta: choice.delta.content });
                completionTokens += Math.max(1, Math.ceil(choice.delta.content.length / 3.6));
              }
              for (const dtc of choice?.delta?.tool_calls ?? []) {
                const idx = dtc.index ?? 0;
                const cur = accToolCalls.get(idx) ?? { id: undefined, name: '', args: '' };
                if (dtc.id) cur.id = dtc.id;
                if (dtc.function?.name) cur.name = dtc.function.name;
                if (dtc.function?.arguments) cur.args += dtc.function.arguments;
                accToolCalls.set(idx, cur);
              }
              if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
              if (chunk.usage) {
                promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
                completionTokens = chunk.usage.completion_tokens ?? completionTokens;
              }
            }
            for (const [idx, tc] of [...accToolCalls.entries()].sort((a, b) => a[0] - b[0])) {
              if (!tc.name) continue;
              controller.enqueue({
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: tc.id ?? `${cfg.id}-${Date.now()}-${idx}`,
                toolName: tc.name,
                args: sanitizeToolArgs(tc.args),
              });
              if (finishReason === 'stop') finishReason = 'tool-calls';
            }
            controller.enqueue({
              type: 'finish',
              finishReason,
              usage: {
                promptTokens: promptTokens || estimateTokens(body.messages as never),
                completionTokens,
              },
            });
            controller.close();
          } catch (err) {
            controller.enqueue({ type: 'error', error: err });
            controller.close();
          }
        },
      });
      return { stream, rawCall: { rawPrompt: body, rawSettings: {} } };
    },
  };

  return provider;
}

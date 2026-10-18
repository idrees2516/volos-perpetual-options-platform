// ---------------------------------------------------------------------------
// zai-provider — a Vercel AI SDK (ai v4) LanguageModelV1 provider that
// bridges to the z-ai-web-dev-sdk backend (GLM). Supports native OpenAI-style
// tool calling, streaming SSE, and non-streaming generation.
//
// This makes the full Vercel AI SDK toolkit (streamText, generateText,
// stepCountIs multi-step agent loops, toDataStreamResponse, useChat) work
// against the in-sandbox GLM endpoint.
// ---------------------------------------------------------------------------

import ZAI from 'z-ai-web-dev-sdk';
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1FinishReason,
  LanguageModelV1Prompt,
  LanguageModelV1StreamPart,
} from '@ai-sdk/provider';

// --- singleton SDK instance -------------------------------------------------

let zaiPromise: Promise<Awaited<ReturnType<typeof ZAI.create>>> | null = null;

async function getZai() {
  if (!zaiPromise) {
    zaiPromise = ZAI.create();
  }
  return zaiPromise;
}

/** Call chat completions with 429-aware retry + patient exponential backoff. */
async function createWithRetry(body: Record<string, unknown>, maxAttempts = 5): Promise<unknown> {
  const zai = await getZai();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return (await zai.chat.completions.create(body as never)) as unknown;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const rateLimited = msg.includes('429') || /too many requests/i.test(msg);
      if (!rateLimited || attempt === maxAttempts) throw err;
      // patient backoff: 3s, 9s, 20s, 45s (+ jitter)
      const waitMs = Math.round(3000 * Math.pow(2.4, attempt - 1)) + Math.random() * 1500;
      console.warn(`[zai-provider] 429 rate limited — retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// --- types -------------------------------------------------------------------

interface OpenAIToolCall {
  id?: string;
  index?: number;
  type: string;
  function: { name: string; arguments?: string };
}

interface OpenAIChatResponse {
  choices?: {
    finish_reason?: string;
    message?: {
      role: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// --- prompt conversion (AI SDK CoreMessages → OpenAI format) -----------------

function contentToText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((p) => p.type === 'text' && typeof (p as { text?: string }).text === 'string')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}

function toOpenAIMessages(prompt: LanguageModelV1Prompt): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const msg of prompt) {
    switch (msg.role) {
      case 'system': {
        messages.push({ role: 'system', content: msg.content });
        break;
      }
      case 'user': {
        messages.push({ role: 'user', content: contentToText(msg.content as never) });
        break;
      }
      case 'assistant': {
        const text = contentToText(msg.content as never);
        const toolCalls = (msg.content as Array<{ type: string }>)
          .filter((p) => p.type === 'tool-call')
          .map((p) => {
            const tc = p as { toolCallId: string; toolName: string; args: unknown };
            return {
              id: tc.toolCallId,
              type: 'function',
              function: { name: tc.toolName, arguments: JSON.stringify(tc.args ?? {}) },
            };
          });
        const m: Record<string, unknown> = {
          role: 'assistant',
          content: text.length > 0 ? text : null,
        };
        if (toolCalls.length > 0) m.tool_calls = toolCalls;
        messages.push(m);
        break;
      }
      case 'tool': {
        for (const part of msg.content as Array<{
          type: string;
          toolCallId: string;
          toolName: string;
          result: unknown;
        }>) {
          if (part.type !== 'tool-result') continue;
          const result =
            typeof part.result === 'string'
              ? part.result
              : JSON.stringify(part.result ?? {});
          messages.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            name: part.toolName,
            content: result,
          });
        }
        break;
      }
    }
  }
  return messages;
}

// --- helpers -------------------------------------------------------------------

function mapToolChoice(choice: LanguageModelV1CallOptions['toolChoice']): string | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'required':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: choice.toolName } };
    default:
      return undefined;
  }
}

function mapFinishReason(reason: string | undefined): LanguageModelV1FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'unknown';
  }
}

function estimateTokens(messages: Array<Record<string, unknown>>): number {
  const text = JSON.stringify(messages);
  return Math.ceil(text.length / 3.6);
}

interface ChatChunkDeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: ChatChunkDeltaToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Parse an SSE byte stream into parsed `data:` payload objects. */
async function* sseEvents(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0 || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload) as StreamChunk;
        } catch {
          // tolerate malformed keep-alive lines
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

// --- provider -----------------------------------------------------------------

export function createZaiModel(modelId = 'glm-4-plus'): LanguageModelV1 {
  const provider: LanguageModelV1 = {
    specificationVersion: 'v1',
    provider: 'zai',
    modelId,
    defaultObjectGenerationMode: 'tool',
    supportsImageUrls: false,

    async doGenerate(options: LanguageModelV1CallOptions) {
      const tools = options.mode?.type === 'regular' ? options.mode.tools : undefined;
      const toolChoice = options.mode?.type === 'regular' ? options.mode.toolChoice : undefined;
      const body: Record<string, unknown> = {
        model: modelId,
        messages: toOpenAIMessages(options.prompt),
        thinking: { type: 'disabled' },
      };
      if (options.maxTokens != null) body.max_tokens = options.maxTokens;
      if (options.temperature != null && options.temperature > 0) body.temperature = options.temperature;
      if (options.topP != null) body.top_p = options.topP;
      if (tools && tools.length > 0) {
        body.tools = tools
          .filter((t) => t.type === 'function')
          .map((t) => {
            const ft = t as { name: string; description?: string; parameters: Record<string, unknown> };
            return {
              type: 'function',
              function: {
                name: ft.name,
                description: ft.description ?? '',
                parameters: ft.parameters,
              },
            };
          });
        const tc = mapToolChoice(toolChoice);
        if (tc != null) body.tool_choice = tc;
      }

      const res = (await createWithRetry(body)) as OpenAIChatResponse;
      const choice = res.choices?.[0];
      const msg = choice?.message;
      const toolCalls = (msg?.tool_calls ?? []).map((tc, i) => ({
        toolCallType: 'function' as const,
        toolCallId: tc.id ?? `call-${Date.now()}-${i}`,
        toolName: tc.function.name,
        args: tc.function.arguments ?? '{}',
      }));

      return {
        text: msg?.content ?? undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: mapFinishReason(choice?.finish_reason),
        usage: {
          promptTokens: res.usage?.prompt_tokens ?? estimateTokens(body.messages as never),
          completionTokens: res.usage?.completion_tokens ?? 0,
        },
        rawCall: { rawPrompt: body, rawSettings: {} },
      };
    },

    async doStream(options: LanguageModelV1CallOptions) {
      const tools = options.mode?.type === 'regular' ? options.mode.tools : undefined;
      const toolChoice = options.mode?.type === 'regular' ? options.mode.toolChoice : undefined;
      const body: Record<string, unknown> = {
        model: modelId,
        messages: toOpenAIMessages(options.prompt),
        stream: true,
        thinking: { type: 'disabled' },
      };
      if (options.maxTokens != null) body.max_tokens = options.maxTokens;
      if (options.temperature != null && options.temperature > 0) body.temperature = options.temperature;
      if (options.topP != null) body.top_p = options.topP;
      if (tools && tools.length > 0) {
        body.tools = tools
          .filter((t) => t.type === 'function')
          .map((t) => {
            const ft = t as { name: string; description?: string; parameters: Record<string, unknown> };
            return {
              type: 'function',
              function: {
                name: ft.name,
                description: ft.description ?? '',
                parameters: ft.parameters,
              },
            };
          });
        const tc = mapToolChoice(toolChoice);
        if (tc != null) body.tool_choice = tc;
      }

      const stream = new ReadableStream<LanguageModelV1StreamPart>({
        async start(controller) {
          const emitTextDelta = (delta: string) => {
            if (delta && delta.length > 0) {
              controller.enqueue({ type: 'text-delta', textDelta: delta });
            }
          };

          try {
            const res = await createWithRetry(body);

            // Non-stream JSON fallback (backend replied without SSE).
            if (!(res instanceof ReadableStream)) {
              const json = res as OpenAIChatResponse;
              const choice = json.choices?.[0];
              const msg = choice?.message;
              if (msg?.content) emitTextDelta(msg.content);
              for (const [i, tc] of (msg?.tool_calls ?? []).entries()) {
                controller.enqueue({
                  type: 'tool-call',
                  toolCallType: 'function',
                  toolCallId: tc.id ?? `call-${Date.now()}-${i}`,
                  toolName: tc.function.name,
                  args: tc.function.arguments ?? '{}',
                });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: mapFinishReason(choice?.finish_reason),
                usage: {
                  promptTokens: json.usage?.prompt_tokens ?? estimateTokens(body.messages as never),
                  completionTokens: json.usage?.completion_tokens ?? 0,
                },
              });
              controller.close();
              return;
            }

            // Real SSE streaming.
            const accToolCalls = new Map<number, { id?: string; name: string; args: string }>();
            let finishReason: LanguageModelV1FinishReason = 'stop';
            let completionTokens = 0;
            let promptTokens = 0;

            for await (const chunk of sseEvents(res.getReader())) {
              const choice = chunk.choices?.[0];
              if (choice?.delta?.content) {
                emitTextDelta(choice.delta.content);
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
                toolCallId: tc.id ?? `call-${Date.now()}-${idx}`,
                toolName: tc.name,
                args: tc.args.length > 0 ? tc.args : '{}',
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

      return { stream };
    },
  };

  return provider;
}

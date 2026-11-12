// Unit tests — the AI model router: env-driven provider selection (OmniRoute /
// generic OpenAI-compatible / GLM), and the failover wrapper with its circuit
// breaker (primary errors rerun on the fallback; after N consecutive failures
// the primary is skipped entirely until the cooldown expires).

import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelV1, LanguageModelV1CallOptions } from '@ai-sdk/provider';
import { createFailoverModel, resolveProviderConfig } from './model-router';

// --- selection -----------------------------------------------------------------

describe('resolveProviderConfig', () => {
  it('defaults to the GLM backend with no gateway credentials', () => {
    const r = resolveProviderConfig({});
    expect(r.primary).toBeNull();
    expect(r.label).toBe('zai');
  });

  it('activates OmniRoute from OMNIROUTE_API_KEY with defaults', () => {
    const r = resolveProviderConfig({ OMNIROUTE_API_KEY: 'k' });
    expect(r.label).toBe('omniroute');
    expect(r.primary?.baseUrl).toBe('https://omniroute.online/v1');
    expect(r.primary?.model).toBe('auto');
    expect(r.primary?.apiKey).toBe('k');
  });

  it('honours custom OmniRoute base URL and model', () => {
    const r = resolveProviderConfig({
      OMNIROUTE_API_KEY: 'k',
      OMNIROUTE_BASE_URL: 'http://localhost:20128/v1',
      OMNIROUTE_MODEL: 'auto/cheap',
    });
    expect(r.primary?.baseUrl).toBe('http://localhost:20128/v1');
    expect(r.primary?.model).toBe('auto/cheap');
  });

  it('AI_PROVIDER=zai forces the GLM backend even with a gateway key', () => {
    const r = resolveProviderConfig({ OMNIROUTE_API_KEY: 'k', AI_PROVIDER: 'zai' });
    expect(r.primary).toBeNull();
    expect(r.label).toBe('zai');
  });

  it('falls back to the generic OpenAI-compatible escape hatch without OmniRoute', () => {
    const r = resolveProviderConfig({
      OPENAI_COMPAT_API_KEY: 'k2',
      OPENAI_COMPAT_BASE_URL: 'https://relay.example/v1',
      OPENAI_COMPAT_MODEL: 'llama-3.3-70b',
    });
    expect(r.label).toBe('openai-compat');
    expect(r.primary?.model).toBe('llama-3.3-70b');
  });

  it('generic gateway requires a base URL', () => {
    const r = resolveProviderConfig({ OPENAI_COMPAT_API_KEY: 'k2' });
    expect(r.primary).toBeNull();
    expect(r.label).toBe('zai');
  });

  it('warns (not throws) when a remote is forced but unconfigured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = resolveProviderConfig({ AI_PROVIDER: 'omniroute' });
    expect(r.primary).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// --- failover model -------------------------------------------------------------

interface FakeHandle {
  model: LanguageModelV1;
  getCalls: () => number;
}

function fakeModel(id: string, opts: { fail?: number } = {}): FakeHandle {
  let calls = 0;
  const model: LanguageModelV1 = {
    specificationVersion: 'v1',
    provider: id,
    modelId: `${id}-model`,
    defaultObjectGenerationMode: 'tool' as const,
    supportsImageUrls: false,
    async doGenerate(_options: LanguageModelV1CallOptions) {
      calls += 1;
      if (opts.fail !== undefined && calls <= opts.fail) throw new Error(`${id} down`);
      return {
        text: `from-${id}`,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        rawCall: { rawPrompt: {}, rawSettings: {} },
      };
    },
    async doStream(_options: LanguageModelV1CallOptions) {
      calls += 1;
      if (opts.fail !== undefined && calls <= opts.fail) throw new Error(`${id} down`);
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: 'text-delta', textDelta: `from-${id}` });
          c.enqueue({ type: 'finish', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } });
          c.close();
        },
      });
      return { stream, rawCall: { rawPrompt: {}, rawSettings: {} } };
    },
  };
  return { model, getCalls: () => calls };
}

async function readText(stream: ReadableStream<unknown>): Promise<string> {
  const reader = stream.getReader();
  let text = '';
  while (true) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: { type?: string; textDelta?: string } };
    if (done) break;
    if (value?.type === 'text-delta' && typeof value.textDelta === 'string') text += value.textDelta;
  }
  return text;
}

describe('createFailoverModel', () => {
  it('passes through on success and never touches the fallback', async () => {
    const primary = fakeModel('primary');
    const fallback = fakeModel('fallback');
    const model = createFailoverModel(primary.model, fallback.model, 'test-ok');
    const res = await model.doGenerate({} as LanguageModelV1CallOptions);
    expect((res as { text?: string }).text).toBe('from-primary');
    expect(fallback.getCalls()).toBe(0);
  });

  it('reruns on the fallback when the primary throws', async () => {
    const primary = fakeModel('primary', { fail: Number.POSITIVE_INFINITY });
    const fallback = fakeModel('fallback');
    const model = createFailoverModel(primary.model, fallback.model, 'test-fail');
    const res = await model.doGenerate({} as LanguageModelV1CallOptions);
    expect((res as { text?: string }).text).toBe('from-fallback');
    expect(fallback.getCalls()).toBe(1);
  });

  it('opens the circuit after 3 consecutive failures and skips the primary entirely', async () => {
    vi.useFakeTimers();
    try {
      const primary = fakeModel('primary', { fail: Number.POSITIVE_INFINITY });
      const fallback = fakeModel('fallback');
      const model = createFailoverModel(primary.model, fallback.model, 'test-circuit');
      // three failing calls → circuit opens
      for (let i = 0; i < 3; i++) await model.doGenerate({} as LanguageModelV1CallOptions);
      const callsAfter3 = primary.getCalls();
      expect(callsAfter3).toBe(3);
      // fourth call: primary must NOT be contacted — fallback answers directly
      const res = await model.doGenerate({} as LanguageModelV1CallOptions);
      expect((res as { text?: string }).text).toBe('from-fallback');
      expect(primary.getCalls()).toBe(callsAfter3);
      // after the 5-minute cooldown the primary gets another chance (half-open)
      vi.advanceTimersByTime(5 * 60_000 + 1000);
      await model.doGenerate({} as LanguageModelV1CallOptions);
      expect(primary.getCalls()).toBe(callsAfter3 + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stream failures also fail over before any token is emitted', async () => {
    const primary = fakeModel('primary', { fail: 1 });
    const fallback = fakeModel('fallback');
    const model = createFailoverModel(primary.model, fallback.model, 'test-stream');
    const { stream } = await model.doStream({} as LanguageModelV1CallOptions);
    expect(await readText(stream as ReadableStream<unknown>)).toBe('from-fallback');
  });
});

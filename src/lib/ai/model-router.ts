// ---------------------------------------------------------------------------
// model-router — the desk's AI backend selection layer.
//
// The copilot/deep-research/agent pipelines all consume ONE LanguageModelV1
// (`deskModel`). Which backend that is depends on configuration:
//
//   AI_PROVIDER=auto (default)  OmniRoute when OMNIROUTE_API_KEY is set,
//                                otherwise the in-sandbox GLM (zai) backend.
//   AI_PROVIDER=omniroute        force the OmniRoute gateway (must be
//                                configured or we log + fall back to zai).
//   AI_PROVIDER=zai | glml       force the in-sandbox GLM backend.
//
// OmniRoute (https://github.com/cheaper-inference/OmniRoute) is a free AI
// gateway aggregating 375+ providers (150+ with free tiers) behind a single
// OpenAI-compatible /v1 endpoint with quota-aware auto-fallback across its
// own provider pool. A generic OPENAI_COMPAT_* escape hatch covers any other
// OpenAI-compatible gateway (OpenRouter, LiteLLM, vLLM, Ollama…).
//
// RESILIENCE: `createFailoverModel` wraps the remote primary with the zai GLM
// backend as a hard fallback — the HTTP call happens before any token is
// streamed (see openai-compat.ts), so a dead key / dead gateway / exhausted
// quota transparently reruns on GLM instead of showing the user an error.
// A circuit breaker (3 consecutive hard failures → open 5 min) stops us from
// paying the timeout on every request while a gateway is down.
// ---------------------------------------------------------------------------

import type { LanguageModelV1 } from '@ai-sdk/provider';
import { createZaiModel } from './zai-provider';
import { createOpenAICompatModel, type OpenAICompatConfig } from './openai-compat';

// --- selection config (pure — unit tested) -----------------------------------

export interface ResolvedProviderConfig {
  /** null → no remote primary configured; run on the GLM backend directly. */
  primary: OpenAICompatConfig | null;
  label: string; // 'omniroute' | 'openai-compat' | 'zai' — the ACTIVE backend
}

const DEFAULT_OMNIROUTE_BASE = 'https://omniroute.online/v1';
const DEFAULT_OMNIROUTE_MODEL = 'auto';

export function resolveProviderConfig(env: Record<string, string | undefined>): ResolvedProviderConfig {
  const preference = (env.AI_PROVIDER ?? 'auto').toLowerCase();
  const forceZai = preference === 'zai' || preference === 'glml';

  // 1 — OmniRoute gateway (dedicated envs, checked first).
  const omniKey = env.OMNIROUTE_API_KEY?.trim();
  if (omniKey && !forceZai) {
    const cfg: OpenAICompatConfig = {
      id: 'omniroute',
      baseUrl: env.OMNIROUTE_BASE_URL?.trim() || DEFAULT_OMNIROUTE_BASE,
      apiKey: omniKey,
      model: env.OMNIROUTE_MODEL?.trim() || DEFAULT_OMNIROUTE_MODEL,
    };
    return { primary: cfg, label: 'omniroute' };
  }

  // 2 — generic OpenAI-compatible gateway escape hatch.
  const compatKey = env.OPENAI_COMPAT_API_KEY?.trim();
  const compatBase = env.OPENAI_COMPAT_BASE_URL?.trim();
  if (compatKey && compatBase && !forceZai) {
    const cfg: OpenAICompatConfig = {
      id: 'openai-compat',
      baseUrl: compatBase,
      apiKey: compatKey,
      model: env.OPENAI_COMPAT_MODEL?.trim() || 'gpt-4o-mini',
    };
    return { primary: cfg, label: 'openai-compat' };
  }

  // 3 — forced remote without credentials → warn + run on GLM.
  if (!forceZai && (preference === 'omniroute' || preference === 'openai-compat')) {
    console.warn(`[model-router] AI_PROVIDER=${preference} but no gateway credentials found — running on the GLM backend`);
  }
  return { primary: null, label: 'zai' };
}

// --- circuit breaker ------------------------------------------------------------

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;

interface BreakerState {
  failures: number;
  openedAt: number;
}

const breakers = new Map<string, BreakerState>();

export function breakerSnapshot(now = Date.now()): Record<string, { open: boolean; failures: number; cooldownRemainingMs: number }> {
  const out: Record<string, { open: boolean; failures: number; cooldownRemainingMs: number }> = {};
  for (const [id, st] of breakers) {
    out[id] = {
      open: isCircuitOpen(id, now),
      failures: st.failures,
      cooldownRemainingMs: Math.max(0, st.openedAt + BREAKER_COOLDOWN_MS - now),
    };
  }
  return out;
}

function isCircuitOpen(id: string, now: number): boolean {
  const st = breakers.get(id);
  if (!st) return false;
  if (now - st.openedAt >= BREAKER_COOLDOWN_MS) return false; // half-open: try again
  return true;
}

function recordFailure(id: string, now: number): void {
  const st = breakers.get(id) ?? { failures: 0, openedAt: 0 };
  st.failures += 1;
  if (st.failures >= BREAKER_THRESHOLD) {
    if (!isCircuitOpen(id, now)) {
      console.warn(`[model-router] ${id} circuit OPEN for ${BREAKER_COOLDOWN_MS / 1000}s after ${st.failures} consecutive failures — requests rerun on the GLM backend`);
    }
    st.openedAt = now;
  }
  breakers.set(id, st);
}

function recordSuccess(id: string): void {
  breakers.set(id, { failures: 0, openedAt: 0 });
}

// --- failover model ------------------------------------------------------------

/**
 * Wrap a remote primary with a local fallback. Errors thrown BEFORE any
 * stream part was emitted are retried on the fallback — the user just sees
 * the answer arrive (from GLM), plus a one-line console trace.
 */
export function createFailoverModel(
  primary: LanguageModelV1,
  fallback: LanguageModelV1,
  primaryId: string,
): LanguageModelV1 {
  const wrapper: LanguageModelV1 = {
    specificationVersion: 'v1',
    provider: `${primaryId}+fallback`,
    modelId: `${primary.modelId}→${fallback.modelId}`,
    defaultObjectGenerationMode: primary.defaultObjectGenerationMode,
    supportsImageUrls: primary.supportsImageUrls,

    async doGenerate(options) {
      if (isCircuitOpen(primaryId, Date.now())) return fallback.doGenerate(options);
      try {
        const r = await primary.doGenerate(options);
        recordSuccess(primaryId);
        return r;
      } catch (err) {
        recordFailure(primaryId, Date.now());
        console.warn(`[model-router] ${primaryId} doGenerate failed (${err instanceof Error ? err.message : String(err)}) — failing over to ${fallback.provider}`);
        return fallback.doGenerate(options);
      }
    },

    async doStream(options) {
      if (isCircuitOpen(primaryId, Date.now())) return fallback.doStream(options);
      try {
        const r = await primary.doStream(options);
        recordSuccess(primaryId);
        return r;
      } catch (err) {
        recordFailure(primaryId, Date.now());
        console.warn(`[model-router] ${primaryId} doStream failed (${err instanceof Error ? err.message : String(err)}) — failing over to ${fallback.provider}`);
        return fallback.doStream(options);
      }
    },
  };
  return wrapper;
}

// --- the desk model --------------------------------------------------------------

/**
 * The model every AI pipeline on the desk consumes:
 * OmniRoute (or any OpenAI-compatible gateway) when configured, with the
 * in-sandbox GLM backend as automatic fallback; GLM directly otherwise.
 */
export function getDeskModel(): LanguageModelV1 {
  const { primary } = resolveProviderConfig(process.env as Record<string, string | undefined>);
  const zai = createZaiModel('glm-4-plus');
  if (!primary) return zai;
  return createFailoverModel(createOpenAICompatModel(primary), zai, primary.id);
}

/** Human-facing status for /api/ai/providers (never leaks the key). */
export function providerStatus() {
  const { primary, label } = resolveProviderConfig(process.env as Record<string, string | undefined>);
  return {
    active: primary ? label : 'zai',
    model: primary ? primary.model : 'glm-4-plus',
    fallback: primary ? { provider: 'zai', model: 'glm-4-plus' } : null,
    gateway: primary ? { id: primary.id, baseUrl: primary.baseUrl } : null,
    breaker: breakerSnapshot(),
    preference: process.env.AI_PROVIDER ?? 'auto',
  };
}

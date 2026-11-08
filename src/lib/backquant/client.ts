// ---------------------------------------------------------------------------
// backquant/client — the live BackQuant v2 REST client + unified dispatcher.
//
//   bqMode()       — 'live' when BACKQUANT_API_KEY is set, else 'demo'
//   bqGet(path, params)
//                    → live: cached, single-flighted fetch against
//                      BACKQUANT_BASE_URL (default https://api.backquant.com/v2)
//                      with X-API-Key auth + rate-limit-header capture
//                    → demo: the deterministic demo engine
//
// Every layer (HTTP proxy, MCP server, Copilot tools) goes through bqGet so
// caching, error mapping and live/demo switching live in exactly one place.
// ---------------------------------------------------------------------------

import type { BqEnvelope, BqMode } from './types';
import { matchBqEndpoint } from './endpoints';
import { generateDemo } from './demo';

export const BQ_BASE_URL = (process.env.BACKQUANT_BASE_URL ?? 'https://api.backquant.com/v2').replace(/\/+$/, '');
export const BQ_MCP_URL = process.env.BACKQUANT_MCP_URL ?? 'https://mcp.backquant.com/mcp';
const BQ_API_KEY = process.env.BACKQUANT_API_KEY ?? '';

export function bqApiKey(): string {
  return BQ_API_KEY;
}

export function bqMode(): BqMode {
  return BQ_API_KEY ? 'live' : 'demo';
}

export function isBackQuantConfigured(): boolean {
  return Boolean(BQ_API_KEY);
}

// ── in-process cache + single-flight ────────────────────────────────────────

interface CacheEntry {
  at: number;
  ttl: number;
  promise: Promise<BqEnvelope>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(path: string, params: Record<string, string>): string {
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return `${path}?${qs}`;
}

function pruneCache() {
  if (cache.size < 200) return;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > v.ttl) cache.delete(k);
}

// ── error mapping ───────────────────────────────────────────────────────────

class BqError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// ── the dispatcher ──────────────────────────────────────────────────────────

/** Coerce param values into the string form BackQuant expects. */
function toParamStrings(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'boolean' ? String(v) : String(v);
  }
  return out;
}

async function liveFetch(path: string, params: Record<string, string>, ttl: number): Promise<BqEnvelope> {
  const url = new URL(BQ_BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'X-API-Key': BQ_API_KEY, Accept: 'application/json' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => null)) as BqEnvelope | null;
    if (!res.ok || !body) {
      const err = body?.error;
      throw new BqError(
        err?.code ?? `HTTP_${res.status}`,
        err?.message ?? `BackQuant ${path} failed with HTTP ${res.status}`,
        res.status,
        err?.details,
      );
    }
    // capture rate-limit info into meta when present
    const rl = res.headers.get('x-ratelimit-limit');
    const rem = res.headers.get('x-ratelimit-remaining');
    if (rl || rem) {
      body.meta = { ...(body.meta ?? { version: '2.14', timestamp: new Date().toISOString() }) };
      body.meta.rate_limit = { limit: rl ?? undefined, remaining: rem ? Number(rem) : undefined };
    }
    return body;
  } catch (e) {
    if (e instanceof BqError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new BqError('TIMEOUT', `BackQuant ${path} timed out after 15s`, 504);
    }
    throw new BqError('NETWORK', `BackQuant ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

export interface BqGetResult {
  envelope: BqEnvelope;
  mode: BqMode;
  endpointId: string;
}

/**
 * Unified BackQuant request: live REST when configured, demo engine otherwise.
 * Accepts a concrete path (with :greek resolved) — matched against the
 * registry for validation, TTL and demo dispatch.
 */
export async function bqGet(path: string, rawParams: Record<string, unknown> = {}): Promise<BqGetResult> {
  const match = matchBqEndpoint(path);
  if (!match) {
    throw new BqError('NOT_FOUND', `Unknown BackQuant endpoint: ${path}`, 404);
  }
  const { endpoint, pathParams } = match;
  const params = toParamStrings({ ...rawParams, ...pathParams });

  if (bqMode() === 'demo') {
    const envelope = await generateDemo(endpoint, params);
    return { envelope, mode: 'demo', endpointId: endpoint.id };
  }

  const key = cacheKey(endpoint.path, params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) {
    return { envelope: await hit.promise, mode: 'live', endpointId: endpoint.id };
  }
  pruneCache();

  const promise = liveFetch(endpoint.path, params, endpoint.cacheTtlMs).catch((err: BqError) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), ttl: endpoint.cacheTtlMs, promise });
  return { envelope: await promise, mode: 'live', endpointId: endpoint.id };
}

/** Like bqGet but never throws — returns an error envelope. */
export async function bqGetSafe(path: string, params: Record<string, unknown> = {}): Promise<BqGetResult> {
  try {
    return await bqGet(path, params);
  } catch (e) {
    const err = e instanceof BqError ? e : new BqError('INTERNAL', String(e), 500);
    return {
      envelope: {
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
        meta: { version: '2.14', timestamp: new Date().toISOString() },
      },
      mode: bqMode(),
      endpointId: 'error',
    };
  }
}

export { BqError };

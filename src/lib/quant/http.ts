// ─────────────────────────────────────────────────────────────────────────────
// VolQuant · http — shared envelope helpers for every /api/quant route.
// ─────────────────────────────────────────────────────────────────────────────

import type { QuantEnvelope } from './types';

export function qOk<T>(data: T, meta: Partial<QuantEnvelope<never>['meta']>): Response {
  const body: QuantEnvelope<T> = {
    success: true,
    data,
    meta: {
      asOf: Date.now(),
      computeMs: 0,
      engine: 'volquant-native',
      ...meta,
    },
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-VolQuant-Engine': 'native',
    },
  });
}

export function qErr(message: string, status = 500, meta: Partial<QuantEnvelope<never>['meta']> = {}): Response {
  const body: QuantEnvelope<null> = {
    success: false,
    data: null,
    error: { message },
    meta: { asOf: Date.now(), computeMs: 0, engine: 'volquant-native', ...meta },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function searchParams(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

export async function guard<T>(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[volquant/api]', msg);
    return qErr(msg, 502);
  }
}

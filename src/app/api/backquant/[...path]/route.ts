// GET /api/backquant/[...path] — the universal BackQuant v2 proxy.
//
// Matches ANY of the 70 registered endpoints (including dynamic segments like
// /options/greeks/gamma) against the registry, forwards query params, and
// serves:
//   • LIVE  — cached, single-flighted request to api.backquant.com/v2 with
//             X-API-Key auth (BACKQUANT_API_KEY) when configured
//   • DEMO  — the deterministic BackQuant-compatible demo engine otherwise
//
// Response headers carry X-BackQuant-Mode: live|demo so the UI can label
// every panel honestly. This is the same data plane the Copilot tools and
// the local MCP server use.

import { bqGetSafe } from '@/lib/backquant/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Next.js strips the /api/backquant prefix; catch-all segments remain.
  const segments = url.pathname.split('/').filter(Boolean);
  // Defensive: strip leading api/backquant if present (e.g. direct invocation)
  while (segments.length && (segments[0] === 'api' || segments[0] === 'backquant')) segments.shift();
  const path = '/' + segments.join('/');

  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    params[k] = v;
  });

  const { envelope, mode } = await bqGetSafe(path, params);
  const status = envelope.success ? 200 : envelope.error?.code === 'NOT_FOUND' ? 404 : 502;

  return Response.json(envelope, {
    status,
    headers: {
      'X-BackQuant-Mode': mode,
      'X-BackQuant-Path': path,
      'Cache-Control': mode === 'demo' ? 'no-store' : 'public, max-age=15, stale-while-revalidate=30',
    },
  });
}

export const GET = proxy;
export const POST = proxy;

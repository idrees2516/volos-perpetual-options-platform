// Server-side proxy to the Rust analytics engine.
// Makes the app work when served directly from Next.js (:3000) — when
// accessed through the gateway (:81), Caddy routes XTransformPort requests
// straight to the Rust engine and this handler is bypassed entirely.

const RUST_ORIGIN = process.env.VOLOS_ENGINE_URL ?? 'http://localhost:3031';

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `${RUST_ORIGIN}${url.pathname}${url.search}`;

  const init: RequestInit = {
    method: req.method,
    headers: {
      'Content-Type': req.headers.get('content-type') ?? 'application/json',
      Accept: req.headers.get('accept') ?? '*/*',
    },
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text();
  }

  try {
    const res = await fetch(target, init);
    const headers = new Headers();
    const ct = res.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    headers.set('cache-control', 'no-store');
    headers.set('x-engine', 'volos-rust-via-next');
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return Response.json(
      { error: 'engine_unreachable', message: 'Rust engine is not running on port 3031' },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const dynamic = 'force-dynamic';

// GET /api/backquant/tape/stream — the LIVE OPTIONS TAPE stream (SSE).
//
// Server-Sent-Events relay of the multi-venue options tape:
//   • LIVE  — polls BackQuant /tape/recent upstream every few seconds and
//             emits only NEW prints (deduped), so the browser never sees the
//             API key and we stay inside burst limits. Swap-in point for the
//             raw WebSocket (wss://api.backquant.com/v2/ws/options) — the
//             event payload shape matches the tape channel.
//   • DEMO  — generates realistic prints on the fly (Deribit-dominant venue
//             mix, underlying-quoted premiums, whale/block/sweep tags).
//
// Events:
//   event: trade  { ...BqTradePrint }
//   event: ping   { ts }            (heartbeat every 15s)
//   event: hello  { symbol, mode }  (first event on connect)

import { bqGet, bqMode } from '@/lib/backquant/client';
import { normalizeSymbol, demoTrades } from '@/lib/backquant/demo';
import type { BqTradePrint } from '@/lib/backquant/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIFETIME_MS = 10 * 60_000; // client EventSource auto-reconnects

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const symbol = normalizeSymbol(url.searchParams.get('symbol') ?? 'BTCUSDT');
  const mode = bqMode();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          closed = true;
        }
      };

      send('hello', { symbol, mode, note: mode === 'live' ? 'BackQuant live tape relay' : 'demo tape simulator — set BACKQUANT_API_KEY for the live relay' });

      const seen = new Set<string>();
      const started = Date.now();
      const heartbeat = setInterval(() => send('ping', { ts: new Date().toISOString() }), 15_000);

      const stop = () => {
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', stop);

      // ── live relay: poll /tape/recent and forward new prints ──────────────
      if (mode === 'live') {
        while (!closed && Date.now() - started < MAX_LIFETIME_MS) {
          try {
            const r = await bqGet('/tape/recent', { symbol, limit: 25 });
            const trades = ((r.envelope.data as { trades?: BqTradePrint[] })?.trades ?? []).slice().reverse();
            for (const t of trades) {
              const key = `${t.ts}|${t.instrument}|${t.qty}|${t.price}|${t.venue}`;
              if (seen.has(key)) continue;
              seen.add(key);
              if (seen.size > 2000) seen.clear();
              send('trade', t);
            }
          } catch {
            /* transient upstream error — next poll retries */
          }
          await sleep(4000);
        }
        stop();
        return;
      }

      // ── demo simulator: fresh prints every 1.5–3.5s ──────────────────────
      while (!closed && Date.now() - started < MAX_LIFETIME_MS) {
        const n = 1 + Math.floor(Math.random() * 3);
        const fresh = await demoTrades(symbol, n, 0.01, `sim-${Date.now()}`);
        for (const t of fresh) {
          send('trade', { ...t, demo: true });
        }
        await sleep(1500 + Math.random() * 2000);
      }
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-BackQuant-Mode': mode,
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

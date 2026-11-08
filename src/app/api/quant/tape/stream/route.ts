// GET /api/quant/tape/stream?symbol=BTC — LIVE SSE tape: prints are pushed the
// moment the server-side Deribit poller (5s) sees them. Event frames:
//   event: print   data: [prints...]   — new prints (newest first)
//   event: hello   data: {symbol}      — connection ack
// The browser EventSource reconnects automatically if the stream drops.
import { ensureTape, subscribeTape, tapePrints } from '@/lib/quant/tape';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get('symbol') ?? 'BTC').toUpperCase().replace(/USDT?$/, '');

  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* closed */
        }
      };
      send('hello', { symbol, engine: 'volquant-native', ts: Date.now() });
      // seed with the 50 most recent prints so the UI renders instantly
      send('print', tapePrints(symbol, { hours: 6, limit: 50 }));
      unsub = subscribeTape(symbol, (prints) => send('print', prints));
      heartbeat = setInterval(() => send('ping', { ts: Date.now() }), 15000);
      req.signal.addEventListener('abort', () => {
        unsub?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsub?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// GET /api/orderflow/stream?asset=BTC&topics=...&minutes=15&minNotional=0
//
// Server-sent events for one asset:
//   init    full snapshot (session, book, derivatives, venues, micro, candles)
//   levels  prior-session levels (async right after init)
//   heatmap resting-liquidity backfill columns, then one column per second
//   trade   batched prints (≥ minNotional) every 250 ms
//   liq     liquidation batches
//   micro   absorption / iceberg markers as they confirm
//   book    merged + per-venue book every second
//   stats   session stats + analytics every second
//   deriv   OI / funding / basis + regime every second
//   venues  cross-venue comparison every 5 s
//   alert   alert events (rules parsed from the URL — per browser)
//   status  per-venue connection statuses
//   ping    keepalive every 15 s

import { getOrderFlowManager } from '@/lib/orderflow/manager';
import { getLevels } from '@/lib/orderflow/levels';
import { heatmapColumns, parseAlertSettings, parseAsset, parseTimeframe, wireCandles } from '@/lib/orderflow/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALL_TOPICS = 'trade,heatmap,book,stats,deriv,liq,venues,micro,alerts,status';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = parseAsset(url.searchParams.get('asset'));
  const topics = new Set(
    (url.searchParams.get('topics') ?? ALL_TOPICS)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const tf = parseTimeframe(url.searchParams.get('tf'));
  const minNotionalRaw = Number(url.searchParams.get('minNotional'));
  const minNotional = Number.isFinite(minNotionalRaw) && minNotionalRaw > 0 ? minNotionalRaw : 0;
  const minutes = Math.min(30, Math.max(2, Number(url.searchParams.get('minutes')) || 15));

  const manager = getOrderFlowManager();
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const state = manager.ensureAsset(asset, 15 * 60_000);
      const sub = manager.addSubscriber({
        asset,
        topics,
        minNotional,
        send,
        close: () => undefined,
        alertSettings: parseAlertSettings(url),
      });

      // initial snapshot (without candles — sent as their own event)
      const snap = manager.snapshot(asset, { tf });
      send('init', { ...snap, candles: wireCandles(state.engine, tf, 80) });
      if (topics.has('heatmap')) {
        send('heatmap-init', { asset, ...heatmapColumns(state.engine, { minutes }) });
      }

      // levels arrive from Binance klines asynchronously
      void getLevels(asset)
        .then((levels) => send('levels', levels))
        .catch(() => undefined);

      const keepalive = setInterval(() => send('ping', { t: Date.now() }), 15_000);
      (keepalive as unknown as { unref?: () => void }).unref?.();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        manager.removeSubscriber(sub.id);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

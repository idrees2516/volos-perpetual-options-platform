// GET /api/quant/brief?symbol=BTC — one-call market brief (native engine).
import { brief, normalizeSymbol } from '@/lib/quant/quant';
import { guard, qOk, searchParams } from '@/lib/quant/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return guard(async () => {
    const t0 = Date.now();
    const symbol = normalizeSymbol(searchParams(req).get('symbol'));
    const data = await brief(symbol);
    return qOk(data, { symbol, computeMs: Date.now() - t0, sources: data.sources as string[] });
  });
}
